# Workspace01 for Chrome

Single-window workspace manager for Chrome. Organize live tabs into named workspaces and switch between them without closing, recreating, or reloading tabs.

## Interface

- Native-looking popup using system colors, light and dark.
- Toolbar icon becomes a two-letter monogram of the current workspace; tooltip shows the full name.
- Rows show name and tab count. Hover a row for hibernate, rename, and delete.
- Drag rows to reorder.
- `+` reveals the create form. `Enter` creates, `Esc` hides it.
- Arrow keys highlight a workspace, `Enter` switches.
- Count pill styles: filled = live tabs, outlined = hibernated, dashed = saved list only (no live window).

## Behavior

- First workspace adopts the currently open non-pinned tabs.
- Later workspaces open one blank tab and do not steal tabs.
- Switching never closes, recreates, discards, or reloads a tab.
- Deleting a workspace closes its tabs.
- Hibernate unloads a parked workspace's tabs from memory (`tabs.discard`). They reload on first use after switching back.
- Reset moves every parked tab back into the current window and clears the workspace list.
- Pinned tabs are global. Chrome unpins a tab when it moves between windows, so they are never moved.

## How it works in Chrome

Chrome has no `tabs.hide()`. Inactive workspaces are **parked**: their tabs are moved into a dedicated minimized window and moved back on switch. Tab state (scroll, forms, logged-in sessions) survives because the tab itself is never recreated.

Each parked window's first tab is a small `park.html` page. That tab is the workspace's identity (it survives Chrome session restore), keeps the window alive when the workspace is empty, and stays active so all other tabs in the window can be hibernated.

Every workspace's URL list is also saved locally. If a parked window is gone (Chrome quit without session restore, or the window was closed by hand), switching re-opens the workspace from the saved URLs. On startup, if Chrome opens with only a new-tab page and the current workspace has saved tabs, they are re-opened automatically after a few seconds.

## Known limitations

- Parked windows appear in the OS window list (Alt-Tab, Mission Control, taskbar). Chrome offers no hidden windows.
- On macOS, creating a window with `focused: false` sometimes still raises it briefly. Chrome behavior, not fixable from an extension.
- Tabs in a Chrome tab group lose the group when moved between windows.
- Workspace state is global, not per window. The window you open the popup from is treated as the main window.
- Not available in Incognito.

## Local testing

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the puzzle icon in the toolbar and pin Workspace01.
5. After editing files, click the reload icon on the extension card. Popup and background changes need the reload; the badge updates on the next popup open.
6. Background errors: click **Service worker** on the card to open its DevTools console. Popup errors: right-click the popup and choose **Inspect**.

## Permissions

| Permission | Why |
| ---------- | --- |
| `tabs` | Read tab URLs and titles for the saved workspace list; move tabs between windows on switch. |
| `storage` | Store workspace names, order, and saved tab lists locally. |

No data leaves the browser. See [PRIVACY.md](PRIVACY.md).

## License

MIT
