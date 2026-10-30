# Look: Choose playback speed from a list, and focus the video by hiding both sidebars

## Pick

**A fixed-width speed button with a list above it, and one Focus toggle for both sidebars**: the
speed button keeps one width for every speed and opens a list of speeds with a check on the current
one, as YouTube's player does, which the owner named as the reference. Focus video hides the sidebar
and the transcript together and shows pressed with the same icon, instead of hiding only the
transcript and turning into a sidebar icon.

## Directions rejected

The owner settled the direction in Q5–Q7 before anything was drawn, so no other direction was
rendered.

- **A settings gear with a Playback speed entry** (Q6): one more step to reach the only setting the
  player has.
- **Real fullscreen, alone or beside the in-window focus** (Q5): needs a window permission, and the
  owner preferred one in-window toggle.
- **Keeping 0.75, 1, 1.5 and 2** (Q7): fewer steps than the list people know from YouTube.

## States drawn

| Screen | State | Image |
|---|---|---|
| Playback controls | speed list open, light | `look/speed-list-light.png` |
| Playback controls | speed list open, dark | `look/speed-list-dark.png` |
| Playback controls | at 1× | `look/speed-1.png` |
| Playback controls | at 1.75×, same width | `look/speed-175.png` |
| Review | Focus video pressed, light | `look/focus-video-light.png` |
| Review | Focus video pressed, dark | `look/focus-video-dark.png` |

Playback controls, speed list open, light:

![Speed list, light](look/speed-list-light.png)

Playback controls, speed list open, dark:

![Speed list, dark](look/speed-list-dark.png)

Playback controls at 1×:

![At 1×](look/speed-1.png)

Playback controls at 1.75×:

![At 1.75×](look/speed-175.png)

Review, Focus video pressed, light:

![Focus video, light](look/focus-video-light.png)

Review, Focus video pressed, dark:

![Focus video, dark](look/focus-video-dark.png)

## Components

- **From the library:** the pill and round buttons (`.cr-btn`, `.cr-speed`, `.cr-round-button`), the
  menu surface's tokens (`--shadow`, `--radius-panel`, `--color-row-hover`), `Icon` (`check`,
  `expand`), the motion tokens.
- **New:** `SpeedControl`, the speed list (`role="menu"` with `menuitemradio` items); no list
  anchored to a playback control existed. `--size-speed-button` (56px).

## Research

- YouTube's player: speed is chosen from a list, 0.25× to 2× in quarters with "Normal" at 1×, and the
  control does not change size (https://support.google.com/youtube/answer/7509567).
- WAI-ARIA menu button pattern: Enter, Space or ↓ opens the menu with focus on an item, Escape closes
  it and returns focus to the button, `menuitemradio` with `aria-checked` marks the choice
  (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).
- WAI-ARIA toggle button: a button whose state changes keeps its name and carries `aria-pressed`
  (https://www.w3.org/WAI/ARIA/apg/patterns/button/).
