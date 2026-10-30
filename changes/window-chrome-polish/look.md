# Look: Give the title bar room, legible icons and a sliding sidebar

## Pick

**A 44px bar with native-size window glyphs and a sliding sidebar**: the bar gains 4px of air
without becoming heavy, as the owner asked ("does not necessarily need to be much bigger"). The
window-control glyphs move from about 6px with sub-pixel strokes to Windows' own 10×10px with
crisp 1px lines, and the toolbar icons from 16px to 20px, so they read like other Windows apps
and the Claude desktop app. The sidebar slides with the sheet following, as the Claude app's does.

## Directions rejected

The owner settled the direction in questions Q1–Q3 before anything was drawn, so no other
direction was rendered.

- **Keep the bar at 40px** (Q1): leaves the cramped feel the owner named.
- **A 48px bar** (Q1): heavier than the Claude app's bar, which the owner called "basically the
  same" as ours.
- **12px window glyphs** (Q2): larger than Windows' own, so they would look foreign beside them.
- **Slide over the sheet, or fade** (Q3): the sheet would still jump at the end.

## States drawn

| Screen | State | Image |
|---|---|---|
| Review | default, light | `look/review-default.png` |
| Review | default, dark | `look/review-dark.png` |
| Title bar | window controls, Close hovered | `look/window-controls-close-hover.png` |
| Title bar | brand and sidebar toggle, dark | `look/brand-and-toggle-dark.png` |
| Review | sidebar sliding out (90ms in) | `look/sidebar-sliding-out.png` |
| Review | sidebar hidden | `look/sidebar-hidden.png` |

Review, default, light:

![Review, default, light](look/review-default.png)

Review, default, dark:

![Review, default, dark](look/review-dark.png)

Title bar, window controls, Close hovered:

![Window controls, Close hovered](look/window-controls-close-hover.png)

Title bar, brand and sidebar toggle, dark:

![Brand and sidebar toggle, dark](look/brand-and-toggle-dark.png)

Review, sidebar sliding out:

![Sidebar sliding out](look/sidebar-sliding-out.png)

Review, sidebar hidden:

![Sidebar hidden](look/sidebar-hidden.png)

## Components

- **From the library:** the title bar (`src/chrome/TitleBar.tsx`), `Icon`, the motion tokens and
  `--ease-out`, the sizing tokens.
- **New:** `WindowGlyph`, the window-control glyphs on a 10×10 grid; the `Icon` set draws on a
  24×24 grid, which cannot put 1px lines on whole pixels at 10px. `--motion-sidebar` (200ms), the
  sidebar's slide.

## Research

- Windows draws its caption glyphs 10×10 epx with 1px strokes inside 46px-wide buttons (Segoe
  Fluent Icons' ChromeMinimize, ChromeMaximize, ChromeRestore and ChromeClose)
  (https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design).
- Fluent motion: 167–250ms with a decelerating curve for elements that enter or leave
  (https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing).
- Material 3: short transitions 150–200ms, decelerating on entry
  (https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md).
- The design system's motion contract: no animated resize of live video (`docs/DESIGN.md`), hence
  the instant change while recording.
