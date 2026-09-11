'use strict';
const id = new URL(location.href).searchParams.get('ws');
const nameEl = document.getElementById('ws-name');

async function refreshName() {
  const data = await chrome.storage.local.get('workspace01');
  const ws = ((data.workspace01 && data.workspace01.workspaces) || []).find((w) => w.id === id);
  nameEl.textContent = ws ? ws.name : 'unknown';
  document.title = ws ? `Parked: ${ws.name}` : 'Workspace01 – parked workspace';
}
refreshName();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.workspace01) refreshName();
});
document.getElementById('switch').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'switch', id });
  await chrome.runtime.sendMessage({ type: 'focusMain' });
});
