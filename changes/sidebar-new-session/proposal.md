---
title: Start a session from a plain New session row and create sections from the sidebar menu
capabilities:
  - workspace/sidebar
review: unreviewed
---
# Start a session from a plain New session row and create sections from the sidebar menu

## Why

At the top of the sidebar, a white "New recording" button with a red dot read as "start
recording", and the folder-plus icon beside it read as a new folder on disk, though it made a
sidebar section. The owner wants it as in the Claude desktop app: "+ New session", and the create
actions in a right-click menu.

- Evidence: `evidence/new-section-button.png`, the owner hovering the folder icon: "Now here when I
  click this for a new folder, okay, a new section" at 2:04.

## What changes

- A plain "+ New session" row replaces the red-dot "New recording" button; Ctrl+N (⌘N) stays
  (scenario: Starting a new session from the sidebar). The Settings shortcut list and the README
  call the command New session.
- The New section button goes. Right-clicking empty space anywhere in the sidebar, or the New
  session row, opens a menu with New session and New section (scenarios: Right-clicking empty space in the
  sidebar; Reaching the sidebar menu from the keyboard). Move to section > New section on a row
  stays.
- While recording the sidebar menu opens with both items disabled (scenario: The sidebar menu while
  recording).

## Settled questions

- **Q3 The red dot on New recording** (the owner's answer when asked which record button felt
  lost): it is misleading; simplify it to "+ New" like the Claude app.
- **Q4 The folder-plus button**: remove it; New section comes from right-click on empty space
  (New session | New section) and from Move to section. Rejected: keep it; give it a clearer icon.
- **Q5 The label**: "+ New session". Rejected: "+ New"; "+ New recording".
- **Q6 The red dot on a recording session's row**: keep it; it marks the session recording now.
  Rejected: drop it too.
- **Where the menu opens** (the owner's answer to the webview polish batch's Q1): the whole sidebar,
  "left panel: New session and New section", outside rows, section headings and their … buttons.
  Rejected: the list only.
- **While recording** (the owner's answer to the webview polish batch's Q6): the menu opens with both
  items disabled. Rejected: no menu.
- **Q13 The look**: a plain row with a plus, like the Claude app (`look/directions/row/`).
  Rejected: the white raised button with a plus (`look/directions/button/`).

## Calls for the owner

- The New session row's context menu is the sidebar's menu too, so keyboard users reach New
  section with Shift+F10 or the context menu key on it: with no session in the list there is
  nothing else to focus, and a keyboard user could not create a section in an empty sidebar.
- The draft's heading stays "New recording", and so does the action beside a refused Record more;
  only the sidebar's command is renamed. The always-shown recording bar removes that refusal.
- The accessible name changes from "New recording" to "New session", a breaking change for
  scripts: `verify-desktop`, `verify-installed`, `verify-native-ux` and `verify-recovery` now find
  the new name, and `verify-device-ui` makes its section from the sidebar's menu. `--size-new-recording` keeps its name; the unused `--shadow-new-recording` goes.

## Out of scope

- How the Move to section submenu opens and expands (6:57–7:10), and a new session started from a
  section heading, which the layout and controls batch carries.
- The browser's own right-click menu elsewhere in the window, which the webview polish batch
  carries.
