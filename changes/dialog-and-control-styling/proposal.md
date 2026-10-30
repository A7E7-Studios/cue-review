---
title: Style scrollbars, the Appearance dropdown and dialogs like the app
capabilities:
  - workspace/look-and-feel
review: unreviewed
---
# Style scrollbars, the Appearance dropdown and dialogs like the app

## Why

Settings showed four things that look unstyled or unfinished next to the rest of the app. Its
scrollbar was the wide Windows default with arrow buttons, and its square ends cut into the
dialog's rounded corner. The Appearance dropdown was the system's own control. The close cross
looked jagged. In the dark theme, the backdrop barely dimmed the app behind a dialog, so front and
back looked alike.

- Evidence: `evidence/settings-scrollbar-3m55s.png`, "scroll bar not styled … it looks a bit weird"
  at 3:40–3:59; the owner found the dialog's transition fine.
- Evidence: `evidence/appearance-select-and-close-4m23s.png`, "So now here drop down not styled.
  The X again looks a bit alias" at 4:23.
- Evidence: `evidence/dark-backdrop-4m53s.png`, "I think the background needs to be even made
  darker to have this difference" at 4:45–4:59.

## What changes

- Every scrollbar in the app is a slim rounded thumb on a clear track, without arrows, darker
  under the pointer ("A scrolling area shows the app's scrollbar"); a dialog's stays clear of its
  corners ("The Settings scrollbar clears the dialog's corners").
- The Appearance dropdown and its open list take the app's menu style, with a check on the current
  theme ("Opening the Appearance dropdown").
- A dialog's close cross is 16 px with 1.5 px strokes ("A dialog's close button is crisp").
- In the dark theme the backdrop is half black and the dialog one step lighter than the sheet
  ("A dialog in the dark theme stands out"); the light theme keeps its backdrop ("The light theme
  keeps its backdrop").

## Settled questions

- **Q3 Backdrop**: darker in the dark theme only. Rejected: darker in both themes.
- **Q4 Scrollbars**: every scroll area gets the app's scrollbar. Rejected: only dialogs.
- **Q7 Summary**: confirmed as written here.

## Calls for the owner

The owner was away when Q8–Q11 were asked and delegated open picks to the agent's recommendation.
All directions are on the directions page shown to the owner and in `look/directions/`.

- **Q8 Scrollbar: slim rail.** Always visible, so a dialog shows that it scrolls. Hover-reveal
  repainted late in WebView2 (its thumb stayed hidden under the pointer), and Chromium's thin
  scrollbar keeps its arrows. Changing it is the scrollbar rules in `src/styles.css`.
- **Q9 Appearance: styled dropdown.** It stays the dropdown the owner pointed at and fits a third
  option later. Rejected: a Light | Dark segmented control (one click, but no longer a dropdown); a
  styled field whose open list stays the system's (the open list is what looked unstyled).
- **Q10 Dark backdrop: darker and lifted.** 50% black behind (Fluent 2's dark overlay), the dialog
  `#222227` with a faint edge. Rejected: 60% black with the dialog unchanged.
- **Q11 Close cross: 16 px, 1.5 px strokes**, approved as shown.
- **Every dialog, not only Settings**, uses the dialog surface and the backdrop tokens. In the light
  theme the generic dialogs' edge moves from `#E2E5EB` to the sheet edge `#DFE2E7`, which Settings
  already used; nothing else changes there.
- **The open list needs Chromium's customizable select** (`appearance: base-select`, in WebView2's
  Chromium since 135). Without it the field falls back to the earlier styled field with the
  system's list, inside `@supports`.

## Out of scope

- Icon sizes elsewhere, the top bar and the sidebar layout: the layout batch.
- A "System" appearance option.
- The dialog's transition, which the owner found fine.
