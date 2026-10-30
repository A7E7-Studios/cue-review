# Look: Search recordings and transcripts from the sidebar, and slide in Find

## Pick

**A, like the Claude app**: Search sits under New session in the sidebar, and it and Ctrl+K open
one window over every recording's name and transcript, so the title bar loses its field and the
sidebar stops filtering. Find in the open transcript stays, on Ctrl+F, and slides open instead of
appearing in one frame. This is the Claude app's model the owner asked for, and it follows the split
that Notion, Slack and Linear use: Ctrl+K searches everything, Ctrl+F searches the item that is open.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **B, the title bar field with a dropdown** (`look/directions/b-title-bar-dropdown/`): keeps the
  field the owner wanted gone and two search surfaces that look different.
- **C, one window scoped to the open recording** (`look/directions/c-scoped-window/`): the window
  covers the video and transcript being read, and stepping through matches while watching is harder
  than with a find bar.

Direction A as proposed: `look/directions/a-claude-style/`.

## States drawn

| Screen | State | Image |
|---|---|---|
| Review | sidebar with New session and Search, no title bar field | `look/sidebar-default.png` |
| Search window | before typing: recent recordings | `look/search-recent.png` |
| Search window | results, light | `look/search-results-light.png` |
| Search window | results, dark | `look/search-results-dark.png` |
| Search window | no matches | `look/search-no-matches.png` |
| Transcript | Find sliding open (60ms in) | `look/find-sliding-open.png` |
| Transcript | Find open with a match | `look/find-open.png` |

Review, sidebar with New session and Search:

![Sidebar with Search](look/sidebar-default.png)

Search window, before typing:

![Recent recordings](look/search-recent.png)

Search window, results, light:

![Results, light](look/search-results-light.png)

Search window, results, dark:

![Results, dark](look/search-results-dark.png)

Search window, no matches:

![No matches](look/search-no-matches.png)

Transcript, Find sliding open:

![Find sliding open](look/find-sliding-open.png)

Transcript, Find open:

![Find open](look/find-open.png)

## Components

- **From the library:** the dialog (`src/ui/Dialog.tsx`, `--color-dialog`), the sidebar's row
  (`.new-session`), `Icon` (`search`, `monitor`), the motion tokens, the find bar.
- **New:** `SearchDialog`, the search window (a combobox field and a listbox of results); no library
  component lists results across recordings. The `text` icon for a transcript line.

## Research

- The Claude app: a sidebar Search entry opens a search window over chats that matches message text
  and shows each result with a snippet
  (https://www.ai-toolbox.co/claude-management-and-productivity/search-claude-history-full-text-guide-2026).
- Notion and Linear: search in the sidebar or on a shortcut, recent items before typing, Ctrl+F kept
  for the open page (https://www.notion.com/help/search, https://linear.app/docs/search).
- Apple HIG: make search a sidebar item when it is a place of its own; put a find field for one view
  above the content it searches (https://developer.apple.com/design/human-interface-guidelines/search-fields).
- Loom and Descript: a transcript match jumps playback to its time
  (https://support.atlassian.com/loom/docs/loom-video-transcription-and-closed-captions/,
  https://help.descript.com/script-editing/search-in-script-tool.md).
- Fluent motion: 167–250ms with deceleration for a surface that enters
  (https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing).
