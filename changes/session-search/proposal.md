---
title: Search recordings and transcripts from the sidebar, and slide in Find
capabilities:
  - workspace/search
  - workspace/sidebar
  - workspace/window-chrome
  - workspace/playback-controls
review: unreviewed
---
# Search recordings and transcripts from the sidebar, and slide in Find

## Why

Search felt off in two places. The title bar's field filtered only recording names and made the
sidebar pop open, and the transcript's Find bar appeared in one frame, pushing the transcript down.
The owner wants search to work like the Claude app's: a Search entry in the sidebar that finds
recordings by name and by what was said, while keeping a find inside one transcript.

- "there was this search bar here at the top … how it appears, is a bit weird, I'm not sure what
  we could do better. But definitely, this needs to change" at 6:36–6:49. The owner could not show it
  while recording; reproduced, the bar in question is the transcript's Find bar, which "just
  instantly appearing below feels weird" (the owner's answer to Q4).

## What changes

- A Search row at the top of the sidebar and Ctrl+K (⌘K) open a search window; the title bar has no
  search field: scenarios "A person opens search" and "The title bar has no search field".
- The window lists recent recordings before anything is typed, then recordings whose names match
  and transcript lines that match, each with its time: scenarios "A person searches for a word" and
  "Nothing matches".
- Choosing a line opens its recording at that time: scenario "A person opens a result".
- Search waits while recording: scenario "Search waits while recording".
- Ctrl+F (⌘F) or the transcript's Find button slides the find bar in over 180ms: scenario "A person
  finds a word in the open transcript".
- The sidebar no longer filters by name, so its spec drops the scenario "The + is hidden while
  searching", the window chrome's purpose no longer names search, and the playback controls' spec
  drops the case of a search showing the sidebar during focus.

## Settled questions

- **Q4 What felt weird**: the Find bar appearing at once below the transcript header; also remove
  the New section button and consider the Claude app's search instead of the title bar field and the
  transcript's field, while keeping search within one transcript. The owner asked for two or three
  options with a recommendation.
- **Q10 Direction**: A, like the Claude app: Search in the sidebar and Ctrl+K open a window over
  names and transcript lines, and Ctrl+F slides a find bar into the transcript. Rejected: B, the
  title bar field with results dropping down under it; C, one window scoped to the open recording
  from the transcript, with no find bar.
- **Q15 Matching**: every typed word must appear in the name or line, in any order, ignoring case
  and accents. Rejected: the exact phrase.
- **Q16 Plan**: approved: the window built on the app's dialog; 6 recent recordings, up to 8 names
  and 30 lines, newest recordings first; a line opens at its time, paused; transcripts loaded by the
  app when search opens; Find slides in over 180ms; search unavailable while recording.

## Calls for the owner

- The sidebar no longer filters as you type: search lives in its window. Reversing it would bring
  back the name filter beside the window.
- The New section button is removed by the recording-flow batch's `sidebar-new-session` change, as
  Q4 asked; this change adds the Search row under that change's New session row.
- Transcripts are searched by the app, read again each time the window opens; a backend search
  command waits until a library grows large enough to need it.
- Ctrl+K and Ctrl+F also work from a text field, as search shortcuts do in other apps; the other
  shortcuts still never fire in one. Ctrl+F in Focus video brings the transcript back first.
- Escape in Find returns focus to the Find button, as before, rather than to wherever Ctrl+F was
  pressed.

## Out of scope

- The New session row and the New section button: `sidebar-new-session` (recording-flow batch).
- Searching inside the video's picture or the agent CLI's search: no change.
