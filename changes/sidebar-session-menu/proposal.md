---
title: Move to section as a submenu, and new sessions straight into a section
capabilities:
  - workspace/sidebar
review: unreviewed
---
# Move to section as a submenu, and new sessions straight into a section

## Why

Moving a recording to a section felt broken: Move to section did not open as you reached it, and
clicking it swapped the whole menu for a list of sections. The owner asked for the Claude app's
behaviour, copied one to one. With the New section button leaving the sidebar (as in the Claude
app), sections are made from the menus, and a section heading offers a new session filed straight
into it, as the Claude app's section headings do.

- "There is this move to section, the move to section doesn't automatically extend, clicking on
  move to section opens a weird thing, so I would really like you can look at how the Claude app
  does it and copy this basically one to one" at 6:57–7:10. The menu could not be shown in the
  recording: window capture misses popups, so this change cites no frame.

## What changes

- Move to section opens a submenu beside the session's menu, on hover, a click, ArrowRight or
  Enter, and the session's menu stays open: scenario "A person points at Move to section".
- The submenu lists Recents and every section, the current one checked and unavailable, and ends in
  New section…; ArrowLeft and Escape close it back to Move to section: scenarios "A person moves a
  recording with the keyboard" and "A person moves a recording into a new section".
- The submenu opens to the left when there is no room on the right, and shifts up to stay in the
  window: scenario "The submenu stays inside the window".
- Each section's … menu offers New section…: scenario "A person adds a section from a section's
  menu".
- A + appears at the right of a section heading on hover or keyboard focus and starts a new session
  that is filed in that section once it records, opening the section if it was collapsed: scenario
  "A person starts a session in a section". It is hidden while recording and while searching:
  scenarios "The + is hidden while recording" and "The + is hidden while searching".

## Settled questions

- **Move to section (the owner's item)**: the Claude app's submenu, copied one to one, as the owner said at
  6:57–7:10. Not asked again.
- **Q8 Creating sections**: from the menus: New section… at the end of the Move to submenu (creates
  the section and moves the session into it) and in each section's … menu; and a + on hover at the
  right of each section heading that starts a new session in that section, as in the Claude app.
  Rejected: a + beside the Recents heading.
- **Q9 Summary**: confirmed, with the New section button going.

## Calls for the owner

- The New section button leaves the sidebar in the recording-flow batch's `sidebar-new-session`
  change, which also adds New section to a right-click on empty sidebar space; this change does not
  remove the button, so the two do not collide. An empty library makes its first section there.
- The submenu opens after the pointer rests 100ms on Move to section and stays open while the
  pointer travels toward it across another item, as Radix menus (which the Claude app uses) do.
  Without that grace a diagonal move would close it.
- The + on a section heading is hidden while a recording is in progress, like the sidebar's other
  controls, and while a search filters the sidebar.

## Out of scope

- Removing the New section button and the right-click on empty space: `sidebar-new-session`
  (recording-flow batch).
- The browser's own right-click menu elsewhere in the window: the webview polish batch
  (`workspace/look-and-feel`).
- Search: the `search` change.
