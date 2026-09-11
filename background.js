'use strict';

// Workspace01 — background service worker
//
// Chrome has no tabs.hide(). Inactive workspaces are "parked": their tabs live
// in a dedicated minimized window whose first tab is park.html?ws=<id>. That
// marker tab is the workspace's identity (it survives session restore), keeps
// the window alive when the workspace has no real tabs, and stays active so
// every other tab can be discarded (hibernate).
//
// Ownership is structural, never tracked per tab:
//   active workspace  = non-pinned tabs of the main window
//   parked workspace  = non-marker tabs of its parked window
// A URL snapshot of each workspace is kept in storage so a workspace whose
// window is gone (Chrome quit without session restore, window closed by hand)
// can be re-opened from URLs.

const STORAGE_KEY = 'workspace01';
const SCHEMA_VERSION = 1;
const PARK_URL = chrome.runtime.getURL('park.html');
const PARK_PATTERN = PARK_URL + '*';
const NAME_MAX = 40;
const STARTUP_DELAY_MS = 3000;
const SNAPSHOT_DEBOUNCE_MS = 800;
const FRESH_URLS = new Set([
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome://new-tab-page-third-party/',
  'about:blank',
  ''
]);

const emptyState = () => ({
  schemaVersion: SCHEMA_VERSION,
  workspaces: [],
  activeId: null,
  mainWindowId: null,
  startupPending: false
});

// ---------- serialization: one mutation at a time ----------

let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- state ----------

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const state = Object.assign(emptyState(), raw);
  // Future schema bumps go here: if (state.schemaVersion < 2) { ... }
  state.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(state.workspaces)) state.workspaces = [];
  state.workspaces = state.workspaces.filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string');
  for (const w of state.workspaces) {
    if (!Array.isArray(w.tabs)) w.tabs = [];
    if (!Number.isInteger(w.activeTabId)) w.activeTabId = null;
  }
  if (state.activeId && !state.workspaces.some((w) => w.id === state.activeId)) {
    state.activeId = state.workspaces[0] ? state.workspaces[0].id : null;
  }
  return state;
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return migrate(data[STORAGE_KEY]);
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// ---------- helpers ----------

const asArray = (x) => (Array.isArray(x) ? x : [x]);
const tabUrl = (t) => t.url || t.pendingUrl || '';
const isParkTab = (t) => tabUrl(t).startsWith(PARK_URL);
const parkUrlFor = (id) => `${PARK_URL}?ws=${encodeURIComponent(id)}`;
const findWorkspace = (state, id) => state.workspaces.find((w) => w.id === id) || null;

function wsIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('ws');
  } catch {
    return null;
  }
}

function normalizeName(state, raw, ignoreId = null) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a workspace name.');
  if (name.length > NAME_MAX) throw new Error(`Keep the name under ${NAME_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('The name contains invalid characters.');
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error('Use at least one letter or number.');
  const clash = state.workspaces.find((w) => w.id !== ignoreId && w.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`"${clash.name}" already exists.`);
  return name;
}

async function queryTabs(q) {
  try {
    return await chrome.tabs.query(q);
  } catch {
    return [];
  }
}

// Map workspaceId -> { windowId, markerTabId } for every live parked window.
// Also self-heals: session restore can duplicate a parked window or its marker
// tab. Extra markers in the same window are closed; a second window claiming
// the same workspace has its real tabs merged into the first and is removed.
async function getParkMap() {
  const markers = await queryTabs({ url: PARK_PATTERN });
  const map = new Map();
  for (const t of markers) {
    const id = wsIdFromUrl(tabUrl(t));
    if (!id) continue;
    const seen = map.get(id);
    if (!seen) {
      map.set(id, { windowId: t.windowId, markerTabId: t.id });
    } else if (seen.windowId === t.windowId) {
      await chrome.tabs.remove(t.id).catch(() => {});
    } else {
      const extra = (await queryTabs({ windowId: t.windowId })).filter((x) => !isParkTab(x));
      if (extra.length) {
        await chrome.tabs.move(extra.map((x) => x.id), { windowId: seen.windowId, index: -1 }).catch(() => {});
      }
      await chrome.windows.remove(t.windowId).catch(() => {});
    }
  }
  return map;
}

const parkedWindowIds = (parkMap) => new Set([...parkMap.values()].map((v) => v.windowId));

async function isUsableMain(id, parkedIds) {
  if (id == null || parkedIds.has(id)) return false;
  try {
    const w = await chrome.windows.get(id);
    return w.type === 'normal' && !w.incognito;
  } catch {
    return false;
  }
}

async function resolveMainWindow(state, preferredId, parkMap) {
  const parkedIds = parkedWindowIds(parkMap);
  if (await isUsableMain(preferredId, parkedIds)) return preferredId;
  if (await isUsableMain(state.mainWindowId, parkedIds)) return state.mainWindowId;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const candidates = wins.filter((w) => !parkedIds.has(w.id) && !w.incognito);
  const w = candidates.find((c) => c.focused) || candidates[0];
  return w ? w.id : null;
}

// Live tabs of a workspace, or null when it has no live window.
async function workspaceTabs(state, ws, mainWindowId, parkMap) {
  if (ws.id === state.activeId) {
    if (mainWindowId == null) return null;
    return (await queryTabs({ windowId: mainWindowId, pinned: false })).filter((t) => !isParkTab(t));
  }
  const p = parkMap.get(ws.id);
  if (!p) return null;
  return (await queryTabs({ windowId: p.windowId })).filter((t) => !isParkTab(t));
}

async function createTabsFromSnapshot(windowId, snapshot) {
  const ids = [];
  for (const s of snapshot || []) {
    if (!s || !s.url) continue;
    try {
      const t = await chrome.tabs.create({ windowId, url: s.url, active: false });
      ids.push(t.id);
    } catch (e) {
      console.warn('Workspace01: could not re-open', s.url, e);
    }
  }
  return ids;
}

// Move tabs into a fresh window seeded with the marker tab. Created already
// minimized so macOS does not play the dock animation.
async function parkTabs(wsId, tabs) {
  const win = await chrome.windows.create({ url: parkUrlFor(wsId), type: 'normal', focused: false, state: 'minimized' });
  const ids = tabs.map((t) => t.id);
  if (ids.length) await chrome.tabs.move(ids, { windowId: win.id, index: -1 });
  const marker = (await queryTabs({ windowId: win.id })).find(isParkTab);
  if (marker) await chrome.tabs.update(marker.id, { active: true }).catch(() => {});
  const current = await chrome.windows.get(win.id).catch(() => null);
  if (current && current.state !== 'minimized') await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
  return win.id;
}

// ---------- toolbar icon ----------
// The action icon is a two-letter monogram of the current workspace, drawn in
// Chrome's neutral action-icon grey with no background. No workspace: half-disc.

const ICON_GREY = '#8e8e93';
const ICON_SIZES = [16, 32, 48];

function monogramImage(text, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = ICON_GREY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const px = Math.round(size * (text.length > 1 ? 0.6 : 0.78));
  ctx.font = `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillText(text, size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}

async function updateBadge(state) {
  const ws = findWorkspace(state, state.activeId);
  await chrome.action.setBadgeText({ text: '' }).catch(() => {});
  await chrome.action.setTitle({ title: ws ? `Workspace01 – ${ws.name}` : 'Workspace01' }).catch(() => {});
  if (!ws) {
    await chrome.action.setIcon({ path: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' } }).catch(() => {});
    return;
  }
  const text = ws.name.replace(/\s+/g, '').slice(0, 2).toUpperCase() || ws.name.slice(0, 1);
  try {
    const imageData = {};
    for (const size of ICON_SIZES) imageData[size] = monogramImage(text, size);
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn('Workspace01: monogram icon failed, falling back to badge', e);
    await chrome.action.setBadgeText({ text }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: ICON_GREY }).catch(() => {});
  }
}

// ---------- snapshots ----------

async function refreshSnapshots(state, preferredMain) {
  const parkMap = await getParkMap();
  const main = await resolveMainWindow(state, preferredMain, parkMap);
  for (const ws of state.workspaces) {
    if (state.startupPending && ws.id === state.activeId) continue;
    const live = await workspaceTabs(state, ws, main, parkMap);
    if (live === null) continue;
    ws.tabs = live
      .map((t) => ({ url: tabUrl(t), title: t.title || '' }))
      .filter((s) => s.url && !s.url.startsWith(PARK_URL));
  }
  if (main != null) state.mainWindowId = main;
  await saveState(state);
  await updateBadge(state);
}

let snapTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    serialized(async () => {
      const state = await loadState();
      if (!state.workspaces.length) return;
      await refreshSnapshots(state, null);
    });
  }, SNAPSHOT_DEBOUNCE_MS);
}

// ---------- view for the popup ----------

async function buildView(state, windowId) {
  const parkMap = await getParkMap();
  const main = await resolveMainWindow(state, windowId, parkMap);
  const workspaces = [];
  for (const ws of state.workspaces) {
    const live = await workspaceTabs(state, ws, main, parkMap);
    const active = ws.id === state.activeId;
    workspaces.push({
      id: ws.id,
      name: ws.name,
      active,
      live: live !== null,
      count: live ? live.length : ws.tabs.length,
      hibernated: !active && live !== null && live.length > 0 && live.every((t) => t.discarded)
    });
  }
  return { workspaces, activeId: state.activeId };
}

// ---------- operations ----------

async function switchTo(state, targetId, preferredMain) {
  const target = findWorkspace(state, targetId);
  if (!target) throw new Error('That workspace no longer exists.');
  if (targetId === state.activeId) return;

  const parkMap = await getParkMap();
  const main = await resolveMainWindow(state, preferredMain, parkMap);
  if (main == null) throw new Error('No browser window to switch in.');

  const oldWs = findWorkspace(state, state.activeId);
  const oldTabs = (await queryTabs({ windowId: main, pinned: false })).filter((t) => !isParkTab(t));
  const oldActive = oldTabs.find((t) => t.active);

  // 1. Bring the target in first so the main window never empties.
  let newIds = [];
  const parked = parkMap.get(targetId);
  if (parked) {
    const tabs = await queryTabs({ windowId: parked.windowId });
    const real = tabs.filter((t) => !isParkTab(t));
    const markers = tabs.filter(isParkTab);
    if (real.length) {
      const moved = await chrome.tabs.move(real.map((t) => t.id), { windowId: main, index: -1 });
      newIds = asArray(moved).map((t) => t.id);
    }
    if (markers.length) await chrome.tabs.remove(markers.map((t) => t.id)).catch(() => {});
  } else {
    newIds = await createTabsFromSnapshot(main, target.tabs);
  }
  if (!newIds.length) {
    const t = await chrome.tabs.create({ windowId: main, active: false });
    newIds.push(t.id);
  }
  const focusId = newIds.includes(target.activeTabId) ? target.activeTabId : newIds[0];
  await chrome.tabs.update(focusId, { active: true }).catch(() => {});

  // 2. Park the outgoing workspace.
  if (oldWs) {
    oldWs.activeTabId = oldActive ? oldActive.id : null;
    if (oldTabs.length) await parkTabs(oldWs.id, oldTabs);
  }

  state.activeId = targetId;
  state.mainWindowId = main;
  await saveState(state);
  await refreshSnapshots(state, main);
}

async function createWorkspace(state, rawName, preferredMain) {
  const name = normalizeName(state, rawName);
  const ws = { id: crypto.randomUUID(), name, createdAt: Date.now(), tabs: [], activeTabId: null };
  state.workspaces.push(ws);
  if (state.workspaces.length === 1) {
    // First workspace adopts whatever is open in the window.
    state.activeId = ws.id;
    await saveState(state);
    await refreshSnapshots(state, preferredMain);
    return;
  }
  await saveState(state);
  await switchTo(state, ws.id, preferredMain);
}

async function renameWorkspace(state, id, rawName) {
  const ws = findWorkspace(state, id);
  if (!ws) throw new Error('That workspace no longer exists.');
  ws.name = normalizeName(state, rawName, id);
  ws.updatedAt = Date.now();
  await saveState(state);
  await updateBadge(state);
}

async function reorderWorkspaces(state, ids) {
  const byId = new Map(state.workspaces.map((w) => [w.id, w]));
  const ordered = [];
  for (const id of ids) {
    const w = byId.get(id);
    if (w) {
      ordered.push(w);
      byId.delete(id);
    }
  }
  state.workspaces = [...ordered, ...byId.values()];
  await saveState(state);
}

// Delete closes the workspace's tabs (same as the Firefox version).
async function deleteWorkspace(state, id, preferredMain) {
  const ws = findWorkspace(state, id);
  if (!ws) throw new Error('That workspace no longer exists.');

  if (id === state.activeId) {
    const next = state.workspaces.find((w) => w.id !== id);
    if (next) {
      await switchTo(state, next.id, preferredMain);
    } else {
      // Last workspace: close its tabs but keep the window alive.
      const parkMap = await getParkMap();
      const main = await resolveMainWindow(state, preferredMain, parkMap);
      if (main != null) {
        const tabs = (await queryTabs({ windowId: main, pinned: false })).filter((t) => !isParkTab(t));
        await chrome.tabs.create({ windowId: main, active: true }).catch(() => {});
        if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
      }
      state.workspaces = [];
      state.activeId = null;
      await saveState(state);
      await updateBadge(state);
      return;
    }
  }

  const parkMap = await getParkMap();
  const parked = parkMap.get(id);
  if (parked) await chrome.windows.remove(parked.windowId).catch(() => {});
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  await saveState(state);
  await updateBadge(state);
}

async function hibernateWorkspace(state, id) {
  if (id === state.activeId) throw new Error('Switch away before hibernating this workspace.');
  const parkMap = await getParkMap();
  const parked = parkMap.get(id);
  if (!parked) throw new Error('This workspace has no live tabs to hibernate.');
  await chrome.tabs.update(parked.markerTabId, { active: true }).catch(() => {});
  const tabs = (await queryTabs({ windowId: parked.windowId })).filter((t) => !isParkTab(t) && !t.discarded);
  let failed = 0;
  for (const t of tabs) {
    try {
      await chrome.tabs.discard(t.id);
    } catch {
      failed += 1;
    }
  }
  if (failed === tabs.length && tabs.length) throw new Error('Chrome refused to unload these tabs.');
}

// Reset moves every parked tab back into the main window and clears all workspaces.
async function resetAll(state, preferredMain) {
  const parkMap = await getParkMap();
  const main = await resolveMainWindow(state, preferredMain, parkMap);
  for (const [, parked] of parkMap) {
    const real = (await queryTabs({ windowId: parked.windowId })).filter((t) => !isParkTab(t));
    if (real.length && main != null) {
      await chrome.tabs.move(real.map((t) => t.id), { windowId: main, index: -1 }).catch(() => {});
    }
    await chrome.windows.remove(parked.windowId).catch(() => {});
  }
  const fresh = emptyState();
  await saveState(fresh);
  await updateBadge(fresh);
}

// ---------- startup ----------

async function startupRestore() {
  const state = await loadState();
  state.startupPending = false;
  const parkMap = await getParkMap();
  const main = await resolveMainWindow(state, null, parkMap);
  const active = findWorkspace(state, state.activeId);
  if (active && main != null && active.tabs.length) {
    const tabs = await queryTabs({ windowId: main, pinned: false });
    const fresh = tabs.every((t) => FRESH_URLS.has(tabUrl(t)));
    if (fresh) {
      const created = await createTabsFromSnapshot(main, active.tabs);
      if (created.length) {
        await chrome.tabs.update(created[0], { active: true }).catch(() => {});
        await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
      }
    }
  }
  if (main != null) state.mainWindowId = main;
  await saveState(state);
  await refreshSnapshots(state, main);
}

chrome.runtime.onStartup.addListener(() => {
  serialized(async () => {
    const state = await loadState();
    await updateBadge(state);
    if (!state.workspaces.length) return;
    state.startupPending = true;
    await saveState(state);
  });
  setTimeout(() => serialized(startupRestore), STARTUP_DELAY_MS);
});

chrome.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    const state = await loadState();
    state.startupPending = false;
    await saveState(state);
    await updateBadge(state);
    if (state.workspaces.length) await refreshSnapshots(state, null);
  });
});

// ---------- listeners: keep snapshots and badge current ----------

chrome.tabs.onCreated.addListener(scheduleSnapshot);
chrome.tabs.onRemoved.addListener(scheduleSnapshot);
chrome.tabs.onMoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabs.onReplaced.addListener(scheduleSnapshot);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.title || info.pinned !== undefined) scheduleSnapshot();
});
chrome.windows.onRemoved.addListener((windowId) => {
  serialized(async () => {
    const state = await loadState();
    if (state.mainWindowId === windowId) {
      state.mainWindowId = null;
      await saveState(state);
    }
  });
});

// ---------- messages ----------

async function handle(msg) {
  const state = await loadState();
  const win = Number.isInteger(msg.windowId) ? msg.windowId : null;
  if (state.startupPending) {
    state.startupPending = false;
    await saveState(state);
  }
  switch (msg.type) {
    case 'getView':
      await updateBadge(state);
      break;
    case 'create':
      await createWorkspace(state, msg.name, win);
      break;
    case 'switch':
      await switchTo(state, msg.id, win);
      break;
    case 'rename':
      await renameWorkspace(state, msg.id, msg.name);
      break;
    case 'reorder':
      await reorderWorkspaces(state, msg.ids || []);
      break;
    case 'delete':
      await deleteWorkspace(state, msg.id, win);
      break;
    case 'hibernate':
      await hibernateWorkspace(state, msg.id);
      break;
    case 'resetAll':
      await resetAll(state, win);
      break;
    case 'focusMain': {
      const parkMap = await getParkMap();
      const main = await resolveMainWindow(state, null, parkMap);
      if (main != null) await chrome.windows.update(main, { focused: true }).catch(() => {});
      break;
    }
    default:
      throw new Error(`Unknown request: ${msg.type}`);
  }
  return buildView(await loadState(), win);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serialized(() => handle(msg || {})).then(
    (view) => sendResponse({ ok: true, view }),
    (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
  );
  return true;
});
