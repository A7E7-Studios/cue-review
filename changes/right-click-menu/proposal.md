---
title: Replace the webview's right-click menu with menus that matter
capabilities:
  - workspace/look-and-feel
review: unreviewed
---
# Replace the webview's right-click menu with menus that matter

## Why

Right-clicking anywhere outside the sidebar's row and section menus shows WebView2's own page menu:
Refresh, Save as, Print, More tools. None of it does anything useful in CueReview, and it makes the
app feel like a web page. The owner wants a right-click to offer only what matters there, or
nothing.

- Evidence: `evidence/workspace-right-click-7m36s.png`, "like right click there's a bit of weird
  stuff happening, refresh, save as, print, more tools, like there should be things that either
  matter or they should not exist" at 7:24–7:41. The window recording does not capture the popup
  menu itself; the frame shows the workspace the owner right-clicked.

## What changes

- The webview's page menu never appears; the workspace, the transcript, the video and the title bar
  show no menu ("Right-clicking the workspace shows no menu").
- Text fields keep the system's editing menu ("Right-clicking a text field keeps its editing
  menu").
- The left panel, outside a row or a section heading, opens the app's own menu with New recording
  and New section ("Right-clicking the left panel offers New recording and New section"), disabled
  while recording or processing ("The left panel's menu is disabled while recording").
- Rows and section headings keep their own menus ("Rows and section headings keep their own
  menus").

## Settled questions

- **Q1 Right-click**: the right side (workspace, transcript) shows nothing, like the Claude app; the
  left panel shows New session (here New recording) and New section. Select all and Collapse all /
  Expand all are not important enough to add. Rejected: nothing anywhere except text fields;
  nothing anywhere; the native menu over selected text too.
- **Q5 Text fields**: keep the system's Cut / Copy / Paste menu in text fields. Rejected: no menu
  there either.
- **Q6 While recording**: the left panel's menu opens with both items disabled, as their buttons
  are. Rejected: no menu while recording.
- **Q7 Summary**: confirmed as written here.

## Calls for the owner

- **Q11 The menu's look**: the left panel's menu reuses the sidebar's row menu, shown to the owner on
  the directions page. The owner was away when it was asked and delegated open picks to the
  agent's recommendation, so the agent took it. Changing it later is a CSS change in
  `src/Sidebar.css`.
- The menu's items use the app's names, **New recording** and **New section**, not "New session":
  the button it mirrors is New recording. Renaming both is one string in `NAMES`.
- The fix is in app code (a document-level `contextmenu` handler), not in the Tauri configuration
  or the WebView2 settings, so it needs no protected path. Turning WebView2's default menus off in
  Rust would also drop the editing menu in text fields, which Q5 keeps.
- The title bar shows no menu, not the Windows system menu (Restore, Move, Size, Minimize,
  Maximize, Close) that a native title bar shows. Adding it means asking Windows for the system
  menu at the pointer from Rust.

## Out of scope

- Select all, Collapse all and Expand all in the left panel's menu (Q1).
- The sidebar's row menu and its Move to section submenu: the layout batch reworks those.
