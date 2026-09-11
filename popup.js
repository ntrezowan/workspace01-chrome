'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  currentName: $('current-name'),
  addBtn: $('add-workspace'),
  createPanel: $('create-panel'),
  nameInput: $('workspace-name'),
  createGo: $('create-go'),
  hint: $('input-hint'),
  list: $('workspace-list'),
  resetLink: $('reset-link'),
  overlay: $('confirm-overlay'),
  confirmMsg: $('confirm-message'),
  confirmBtns: $('confirm-buttons')
};

const ICONS = {
  sleep: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5z"/></svg>',
  rename: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

let windowId = null;
let view = { workspaces: [], activeId: null };
let highlightIndex = -1;
let busy = false;
let renamingId = null;
let dragId = null;

// ----- messaging -----

async function send(msg) {
  const res = await chrome.runtime.sendMessage({ ...msg, windowId });
  if (!res) throw new Error('No response from the extension. Reload it from chrome://extensions.');
  if (!res.ok) throw new Error(res.error || 'Something went wrong.');
  return res.view;
}

// closeAfter: close the popup on success (switch/create/reset), like the Firefox version.
async function run(msg, { closeAfter = false } = {}) {
  if (busy) return false;
  busy = true;
  try {
    view = await send(msg);
    hideHint();
    if (closeAfter) {
      window.close();
      return true;
    }
    render();
    return true;
  } catch (e) {
    showHint(e.message, true);
    render();
    return false;
  } finally {
    busy = false;
  }
}

// ----- hints -----

function showHint(text, isError) {
  els.hint.textContent = text;
  els.hint.classList.add('visible');
  els.hint.classList.toggle('input-error', !!isError);
}
function hideHint() {
  els.hint.classList.remove('visible', 'input-error');
  els.hint.textContent = '';
}

// ----- create panel -----

function openCreate() {
  els.createPanel.classList.add('visible');
  els.addBtn.classList.add('open');
  showHint('Press Enter to create', false);
  els.nameInput.focus();
}
function closeCreate() {
  els.createPanel.classList.remove('visible');
  els.addBtn.classList.remove('open');
  els.nameInput.value = '';
  hideHint();
}

// ----- render -----

function render() {
  const active = view.workspaces.find((w) => w.active);
  els.currentName.textContent = active ? active.name : 'None';
  els.currentName.title = active ? active.name : 'None';
  els.list.replaceChildren();

  if (!view.workspaces.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = 'No workspaces yet. Click + to create your first workspace. It adopts the tabs open in this window.';
    els.list.appendChild(empty);
    highlightIndex = -1;
    return;
  }

  view.workspaces.forEach((ws) => els.list.appendChild(buildRow(ws)));
  if (highlightIndex >= view.workspaces.length) highlightIndex = view.workspaces.length - 1;
  applyHighlight();
}

function buildRow(ws) {
  const row = document.createElement('div');
  row.className = 'workspace-row' + (ws.active ? ' active' : '');
  row.dataset.id = ws.id;
  row.draggable = renamingId !== ws.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', ws.active ? 'true' : 'false');
  row.tabIndex = 0;
  row.title = ws.active ? 'Current workspace' : 'Switch to this workspace';

  const name = document.createElement('span');
  name.className = 'workspace-name';
  if (renamingId === ws.id) {
    name.appendChild(buildRenameInput(ws));
  } else {
    name.textContent = ws.name;
    name.title = ws.name;
  }

  const count = document.createElement('span');
  count.className = 'workspace-count';
  count.textContent = String(ws.count);
  const plural = ws.count === 1 ? '' : 's';
  if (ws.hibernated) {
    count.classList.add('hibernated');
    count.title = `${ws.count} tab${plural}, hibernated (unloaded from memory)`;
  } else if (!ws.live && !ws.active) {
    count.classList.add('saved');
    count.title = `${ws.count} saved tab${plural}. No live window; switching re-opens them.`;
  } else {
    count.title = `${ws.count} tab${plural}`;
  }

  const actions = document.createElement('span');
  actions.className = 'row-actions';

  const sleepBtn = iconButton('row-btn sleep-btn', ICONS.sleep, 'Hibernate: unload tabs to free memory');
  if (ws.active || !ws.live || ws.count === 0 || ws.hibernated) sleepBtn.classList.add('gone');
  sleepBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    run({ type: 'hibernate', id: ws.id });
  });

  const renameBtn = iconButton('row-btn rename-btn', ICONS.rename, 'Rename');
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renamingId = ws.id;
    render();
  });

  const delBtn = iconButton('row-btn delete-btn', ICONS.remove, 'Delete');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    askDelete(ws);
  });

  actions.append(sleepBtn, renameBtn, delBtn);
  row.append(name, count, actions);

  row.addEventListener('click', () => {
    if (renamingId) return;
    if (ws.active) {
      window.close();
      return;
    }
    run({ type: 'switch', id: ws.id }, { closeAfter: true });
  });
  attachDrag(row);
  return row;
}

function iconButton(cls, svg, title) {
  const b = document.createElement('button');
  b.className = cls;
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  return b;
}

// ----- rename -----

function buildRenameInput(ws) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = ws.name;
  input.maxLength = 40;
  input.spellcheck = false;
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    renamingId = null;
    const next = input.value.trim();
    if (!next || next === ws.name) {
      render();
      return;
    }
    await run({ type: 'rename', id: ws.id, name: next });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      done = true;
      renamingId = null;
      render();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

// ----- drag reorder -----

function attachDrag(row) {
  row.addEventListener('dragstart', (e) => {
    dragId = row.dataset.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  row.addEventListener('dragend', () => {
    dragId = null;
    clearDropMarks();
    row.classList.remove('dragging');
  });
  row.addEventListener('dragover', (e) => {
    if (!dragId || dragId === row.dataset.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const rect = row.getBoundingClientRect();
    row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === row.dataset.id) return;
    const before = row.classList.contains('drop-before');
    clearDropMarks();
    const ids = view.workspaces.map((w) => w.id).filter((id) => id !== dragId);
    let at = ids.indexOf(row.dataset.id);
    if (!before) at += 1;
    ids.splice(at, 0, dragId);
    dragId = null;
    run({ type: 'reorder', ids });
  });
}
function clearDropMarks() {
  for (const r of els.list.querySelectorAll('.workspace-row')) r.classList.remove('drop-before', 'drop-after');
}

// ----- confirm dialog -----

function confirmDialog(message, okLabel, onOk) {
  els.confirmMsg.textContent = message;
  els.confirmBtns.replaceChildren();
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => els.overlay.classList.remove('visible'));
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn-danger';
  ok.textContent = okLabel;
  ok.addEventListener('click', () => {
    els.overlay.classList.remove('visible');
    onOk();
  });
  els.confirmBtns.append(cancel, ok);
  els.overlay.classList.add('visible');
  cancel.focus();
}

function askDelete(ws) {
  const tabs = ws.count === 1 ? '1 tab' : `${ws.count} tabs`;
  const isLast = view.workspaces.length === 1;
  const message = isLast
    ? `Delete "${ws.name}"? This closes its ${tabs} and leaves an empty window. It cannot be undone.`
    : `Delete "${ws.name}"? This closes its ${tabs} and cannot be undone.`;
  confirmDialog(message, 'Delete', () => run({ type: 'delete', id: ws.id }, { closeAfter: ws.active }));
}

function askReset() {
  if (!view.workspaces.length) return;
  confirmDialog(
    'Reset all workspaces? Every parked tab moves back into this window and the workspace list is cleared. Tabs are kept. This cannot be undone.',
    'Reset',
    () => run({ type: 'resetAll' }, { closeAfter: true })
  );
}

// ----- keyboard (inside the popup only) -----

function applyHighlight() {
  const rows = els.list.querySelectorAll('.workspace-row');
  rows.forEach((r, i) => r.classList.toggle('highlight', i === highlightIndex));
  if (highlightIndex >= 0 && rows[highlightIndex]) rows[highlightIndex].scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (els.overlay.classList.contains('visible')) {
    if (e.key === 'Escape') els.overlay.classList.remove('visible');
    return;
  }
  if (renamingId) return;
  const inInput = document.activeElement === els.nameInput;
  if (inInput) return;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && view.workspaces.length) {
    e.preventDefault();
    const n = view.workspaces.length;
    highlightIndex = e.key === 'ArrowDown' ? (highlightIndex + 1) % n : (highlightIndex - 1 + n) % n;
    applyHighlight();
  } else if (e.key === 'Enter') {
    const focusedRow = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.workspace-row') : null;
    const ws = highlightIndex >= 0 ? view.workspaces[highlightIndex] : focusedRow ? view.workspaces.find((w) => w.id === focusedRow.dataset.id) : null;
    if (!ws) return;
    e.preventDefault();
    if (ws.active) window.close();
    else run({ type: 'switch', id: ws.id }, { closeAfter: true });
  } else if (e.key === 'Escape' && els.createPanel.classList.contains('visible')) {
    closeCreate();
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    openCreate();
  }
});

// ----- create -----

els.addBtn.addEventListener('click', () => {
  if (els.createPanel.classList.contains('visible')) closeCreate();
  else openCreate();
});
els.createGo.addEventListener('click', submitCreate);
els.nameInput.addEventListener('input', () => showHint('Press Enter to create', false));
els.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitCreate();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCreate();
  }
});
async function submitCreate() {
  const name = els.nameInput.value.trim();
  if (!name) {
    showHint('Enter a workspace name.', true);
    return;
  }
  await run({ type: 'create', name }, { closeAfter: true });
}

els.resetLink.addEventListener('click', (e) => {
  e.preventDefault();
  askReset();
});

// Re-render when the background updates state (tab counts, badge source) while open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.workspace01 || busy || renamingId) return;
  send({ type: 'getView' })
    .then((v) => {
      view = v;
      render();
    })
    .catch(() => {});
});

// ----- init -----

(async () => {
  try {
    const win = await chrome.windows.getCurrent();
    windowId = win.id;
    view = await send({ type: 'getView' });
    render();
    if (!view.workspaces.length) openCreate();
  } catch (e) {
    showHint(e.message, true);
  }
})();
