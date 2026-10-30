---
title: Stop the webview's page menu on right-click
capabilities:
  - workspace/look-and-feel
review: unreviewed
---
# Stop the webview's page menu on right-click

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
- The sidebar's own menus are unchanged. Its menu for empty space (New session, New section) is
  the sidebar capability's, built by the sidebar-new-session change.

## Settled questions

- **Q1 Right-click**: the right side (workspace, transcript) shows nothing, like the Claude app; the
  left panel shows New session and New section. Select all and Collapse all / Expand all are not
  important enough to add. Rejected: nothing anywhere except text fields; nothing anywhere; the
  native menu over selected text too.
- **Q5 Text fields**: keep the system's Cut / Copy / Paste menu in text fields. Rejected: no menu
  there either.
- **Q6 While recording**: the left panel's menu opens with both items disabled, as their buttons
  are. Rejected: no menu while recording.
- **Q7 Summary**: confirmed as written here.

## Calls for the owner

- **The left panel's menu moved to the sidebar-new-session change.** Both changes built it; the
  recording-flow batch's version lands first, together with the New session row it belongs to, so
  this change keeps only the guard. Q1 (anywhere in the sidebar outside rows and headings) and Q6
  (open with both items disabled while recording) were passed to that change to build.
- The fix is in app code (a document-level `contextmenu` handler), not in the Tauri configuration
  or the WebView2 settings, so it needs no protected path. Turning WebView2's default menus off in
  Rust would also drop the editing menu in text fields, which Q5 keeps.
- The title bar shows no menu, not the Windows system menu (Restore, Move, Size, Minimize,
  Maximize, Close) that a native title bar shows. Adding it means asking Windows for the system
  menu at the pointer from Rust.

## Out of scope

- Select all, Collapse all and Expand all in the sidebar's menu (Q1).
- The sidebar's menus themselves: the sidebar capability.
