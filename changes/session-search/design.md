# Design: Search recordings and transcripts from the sidebar, and slide in Find

## Context

Search today is a field centred in the title bar (`src/chrome/TitleBar.tsx`) that filters the
sidebar's rows by name (`src/Sidebar.tsx`, `filter`), with Ctrl+K focusing it. Find in transcript
(`src/workspace/TranscriptPane.tsx`) inserts a row under the transcript's header in one frame. The
app already loads one transcript at a time through `backend.transcript(id)` and restores playback
after a recording opens through `restorePlayback` in `src/App.tsx`. The app's dialog
(`src/ui/Dialog.tsx`) contains focus, makes the background inert and animates in 180ms.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where search opens | A Search row under New session in the sidebar, and Ctrl+K (⌘K) from anywhere outside dialogs and menus, a text field included, as other apps' search shortcuts work; the title bar has no field | A title-bar field with a dropdown (direction B): rejected by the owner (Q10) | Apple HIG, search as a sidebar item (https://developer.apple.com/design/human-interface-guidelines/search-fields); Notion search (https://www.notion.com/help/search) |
| The window | `Dialog` with a search class: no visible title (it names the dialog for screen readers), aligned near the top, a field and a listbox of results in labelled groups with `aria-activedescendant`, so focus stays in the field while ↑↓ move; the active result is kept by key and the first result is pinned once results show, so arriving lines never change what Enter opens | A custom popup: would repeat the dialog's focus containment and inert background | WAI-ARIA combobox with listbox popup (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) |
| What it shows | Before typing: the 6 most recent recordings. Typing: up to 8 recordings whose names match, then up to 30 transcript lines, newest recordings first, each with its recording's name, the words marked and its time | Ranking by relevance: needs scoring that a few hundred recordings do not; fuzzy matching: noisy in long transcripts | Superhuman, recent items before typing (https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/); Linear search (https://linear.app/docs/search) |
| Matching | Every typed word must occur in the name or line, any order, ignoring case and accents (Unicode NFD without combining marks) | The exact phrase: rejected by the owner (Q15) | MDN, `String.prototype.normalize` (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize) |
| Where transcripts come from | The app reads each settled recording's transcript with `backend.transcript` each time the window opens, four at a time, so a changed transcript is searched as it is; lines from the last opening stay until their new read arrives | A backend search command: faster for very large libraries, but a new Rust command and contract the current library sizes do not need | Tauri commands (https://v2.tauri.app/develop/calling-rust/) |
| Opening a result | A recording opens at its start; a line opens its recording with playback standing at the line's start, paused: through `restorePlayback` when the video loads, or, when the same video stays (the recording was still shown while another load ran), in a layout effect once the session commits, for the latest selection only | Starting playback: the person may want to read first | Loom and YouTube transcripts jump playback to a line (https://support.atlassian.com/loom/docs/loom-video-transcription-and-closed-captions/) |
| Find in transcript | Ctrl+F (⌘F) in review (from a text field too; in Focus video the transcript comes back first; swallowed in the capture phase, as reload is, so it never opens the webview's own find bar, a dialog's included), and the Find button, open the find bar, which slides open over 180ms by animating its grid row from 0fr to 1fr; instant under reduced motion | A fade only: the transcript would still jump down | Fluent motion, 167–250ms (https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing) |
| The sidebar's name filter | Removed with the title-bar field | Keeping it beside the window: two searches that disagree | — |
| While recording | The Search row is unavailable and Ctrl+K does nothing, like the sidebar's rows | Searching but refusing to open: a result that cannot be opened | — |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src/search/` (new: `searchIndex.ts`, `SearchDialog.tsx`, `search.css`), `src/chrome/TitleBar.tsx` and `chrome.css` (the field goes), `src/Sidebar.tsx` and `Sidebar.css` (the Search row; the filter goes), `src/workspace/TranscriptPane.tsx` and `transcript.css` (the slide, Ctrl+F), `src/app/useShortcuts.ts` (Ctrl+K, Ctrl+F), `src/App.tsx`; README.md's search sentence, `docs/DESIGN.md`, `scripts/verify-sidebar.cjs` |
| Storage | None: transcripts are read, nothing is written |

## Test plan

| Scenario or logic | Test |
|---|---|
| A person opens search | `src/search/SearchDialog.test.tsx::opens with recent recordings and closes on Escape`, new; `src/App.test.tsx::opens search from the sidebar and with Ctrl+K`, new |
| The title bar has no search field | `src/chrome/TitleBar.test.tsx::has no search field`, new |
| Search waits while recording | `src/App.test.tsx::does not open search while recording`, new |
| A person searches for a word | `src/search/searchIndex.test.ts::finds names and transcript lines ignoring case`, unit; `src/search/SearchDialog.test.tsx::lists recordings and transcript lines`, new |
| A person opens a result | `src/App.test.tsx::opens a transcript line at its time`, new |
| Nothing matches | `src/search/SearchDialog.test.tsx::says No matches`, new |
| Words match in any order | `src/search/searchIndex.test.ts::matches every word in any order` and `::folds case and accents one unit at a time`, unit |
| A line of the open recording, a narrow window's sidebar, results that move, loads that overlap or fail | `src/App.test.tsx::opens a line of the recording that is already open at its time`, `::closes the narrow window's sidebar when a line of the open recording is chosen`, `::opens a line of the shown recording at its time while another load runs`, `::applies only the latest of two lines chosen while loads run`, `::drops a search result's time when its load fails`, `::says when a recording opened from search cannot be played`; `src/search/SearchDialog.test.tsx::keeps the active result while transcripts arrive`, `::keeps the first result for Enter while a newer recording's lines arrive`, `::pins the first result again when the pinned one leaves`, new |
| A changed transcript | `src/App.test.tsx::searches each transcript as it is when search opens`, new |
| Ctrl+F in Focus video, and never the webview's find bar | `src/App.test.tsx::brings the transcript back for Ctrl+F in focus`; `src/app/useShortcuts.test.tsx::never lets Ctrl+F reach the webview, and finds only where a transcript can`, new |
| A person finds a word in the open transcript | `src/workspace/TranscriptPane.test.tsx::opens the find bar with Ctrl+F`, new; `src/App.test.tsx::finds in the transcript with Ctrl+F`, new |
| Matching, marking and limits | `src/search/searchIndex.test.ts`, unit |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| A person opens search | desk | Search in the sidebar and Ctrl+K open the window with recent recordings; Escape closes it |
| The title bar has no search field | desk | The bar holds the name, the sidebar toggle, Settings and the window controls |
| A person searches for a word | desk | Typing a word lists names and lines with the word marked and times |
| A person opens a result | desk | Enter on a line opens its recording standing at that time |
| A person finds a word in the open transcript | desk | Ctrl+F slides the find bar open; it finds as before |

The owner was away when this design was finished and asked for the recommended options; this design is treated as approved (the plan itself was approved in Q16).

## Risks

- A library with thousands of long transcripts makes the first search slow while transcripts load:
  the window shows names at once and lines as transcripts arrive; a backend command can replace the
  loader without changing the window.
- Removing the title-bar field changes `scripts/verify-sidebar.cjs`, which searched by name there:
  it searches through the window instead.
