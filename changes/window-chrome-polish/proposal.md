---
title: Give the title bar room, legible icons and a sliding sidebar
capabilities:
  - workspace/window-chrome
review: unreviewed
---
# Give the title bar room, legible icons and a sliding sidebar

## Why

On Windows the title bar felt cramped, its window controls were tiny and soft beside other apps,
and the sidebar vanished in one frame when its toggle was pressed. The owner met all three while
reviewing the app itself, comparing it with the Claude desktop app.

- Evidence: `evidence/title-bar-cramped-5m14.png`, "maybe we made the top bar a bit thicker, like
  the distance here, it feels a bit cramped" at 5:14.
- Evidence: `evidence/window-controls-tiny-5m28.png` (the pointer on Close), "those icons are way
  too tiny. If I compare them with other apps, they are usually much bigger, and that's why I also
  they look a bit weird. The bar itself does not necessarily need to be much bigger, comparing with
  the Claude desktop app it's actually basically the same" at 5:26–5:56.
- Evidence: `evidence/sidebar-toggle-no-motion-1m51.png` (the pointer on the sidebar toggle,
  pressed at 1:51), "is missing somehow an animation" at 1:44–1:52.

## What changes

- The Windows title bar and the Linux toolbar are 44px tall, the window controls 46×44: scenario
  "A person looks at the title bar on Windows".
- Minimize, Maximize, Restore and Close draw 10×10px glyphs with crisp 1px lines, as Windows does;
  the sidebar toggle and Settings draw 20px icons in 36×32 buttons: scenario "A person compares the
  window controls with another Windows app".
- The sidebar slides out and in over 200ms and the workspace follows it: scenario "A person hides
  and shows the sidebar". In a narrow window it slides over the sheet: scenario "The sidebar slides
  over the sheet in a narrow window". It changes at once beside live video and under reduced
  motion: scenarios "The sidebar changes at once beside live video" and "The sidebar changes at
  once under reduced motion".

## Settled questions

- **Q1 Title bar height**: 44px, window controls 46×44. Rejected: keep 40px and change only the
  icons; 48px.
- **Q2 Icons**: window-control glyphs at Windows' native 10px with crisp 1px lines; sidebar toggle
  and Settings at 20px in 36×32 buttons. Rejected: glyphs at 12px, larger than native; also
  enlarging the other small icon buttons in the app.
- **Q3 Sidebar motion**: the sidebar's width eases from 232px to 0 over 200ms while its content
  slides out, and the workspace widens with it, as in the Claude app; instant under reduced motion
  and while recording, so live video is never resized by an animation. Rejected: sliding over the
  sheet with the workspace jumping; a fade.
- **Q9 Summary**: confirmed as written here.

## Calls for the owner

- The macOS toolbar keeps its 52px height and its own icon sizes: the owner's remarks were about
  Windows, and the macOS toolbar already matches its mock. Reversing it is a token change.
- Compact recording mode's drag strip grows with the title bar to 44px, since both use the same
  token. Keeping it at 40px would need a token of its own.
- Below 1000px the sidebar shows over the sheet instead of beside it; there it slides in over the
  sheet the same way, and the sheet does not move.
- "Instant while recording" (Q3) also covers a new recording's live preview, which is live video
  too: the reason the owner accepted, no animated resize of live video, applies to both. Sliding
  beside the preview would only need `liveVideo` in `src/App.tsx` narrowed back to recording.

## Out of scope

- Search in the title bar: the `search` change, after the owner picks a direction.
- The other small icon buttons in the app (Q2's rejected option).
- The Settings dialog's close X: the webview polish batch (`workspace/look-and-feel`).
