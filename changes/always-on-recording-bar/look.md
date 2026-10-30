# Look: Show one recording bar with the source and microphone, before and during a take

## Pick

**Dock (A): the recording dock's dark capsule, always under the video**: Record becomes the one
red, filled button in the workspace, so the call to action the owner found "a bit lost" is the
first thing under the video, and the display and microphone sit beside it before every take,
Record more included ("I don't have any options for the audio device"). The bar keeps the shape,
place and size of the dock that replaces it while recording, so starting and stopping a take
changes what the bar holds, not where it is.

## Directions rejected

Each direction is shown in every state; `workspace-review-idle.png` tells them apart.

- **Merged row (B)** (`look/directions/merged-row/`): the pickers and Record more join the playback
  row as light pills, where the microphone name already truncates at 1280px; not picked (Q12).
- **Pinned bar (C)** (`look/directions/pinned-bar/`): a "Next take" bar pinned to the bottom of the
  sheet, away from the video and the controls it belongs with; not picked (Q12).

## States drawn

The pick as built, rendered from Storybook (`Workspace/Scenarios`, Windows) at 1280×800.

| Screen | State | Image |
|---|---|---|
| Workspace | new recording, idle | `look/workspace-new-idle.png` |
| Workspace | review, idle | `look/workspace-review-idle.png` |
| Workspace | review, idle, dark | `look/workspace-review-idle-dark.png` |
| Workspace | recording take 2 | `look/workspace-recording.png` |
| Workspace | review, the session's source gone | `look/workspace-source-gone.png` |

Workspace, new recording, idle:

![New recording, idle](look/workspace-new-idle.png)

Workspace, review, idle:

![Review, idle](look/workspace-review-idle.png)

Workspace, review, idle, dark:

![Review, idle, dark](look/workspace-review-idle-dark.png)

Workspace, recording take 2:

![Recording take 2](look/workspace-recording.png)

Workspace, review, the session's source gone:

![Review, source gone](look/workspace-source-gone.png)

### Where the build differs from the board

- **The source is locked in review.** The board draws the review source picker open; the build
  shows the session's own source, dimmed and locked, titled "Record more records this session's own
  source", because a take still records the session's source until the separate take videos
  change lands.
- **A gone source is refused under the bar.** The board's source-gone state shows a warning in the
  picker ("Choose a source") with the source list open; the build shows the refusal under the bar,
  with New recording and Dismiss, until separate take videos let a take choose another source.
- **No microphone level in the idle bar.** The board draws a small meter beside the microphone;
  the owner deferred it (Q15), so the meter appears only in the dock while a take records.
- **Record's red is Stop's** (`#D7333A`), slightly deeper than the board's, so white text on it
  reaches 4.7:1.

### Narrowing

Measured in Storybook with "Display 1" and "Studio microphone": the review bar needs 476.2px and
a draft's 439.4px. Below 476.5px the picker labels drop to icons (their names stay as visually
hidden text) and the chevrons go; below 249px Record's label goes too, leaving a 150px bar. Longer
names truncate before the first step. The bar fits without overflow at 1280×800, 1000×700 (sidebar
docked), 900×650 (sidebar hidden or shown over the sheet), 760×560 and the 640×480 window minimum.

## Components

- **From the library:** `CaptureControls` (its popovers, option lists and focus handling), the
  dock's capsule tokens (`--color-dock`, `--shadow-dock`, `--size-dock-control`), Stop's red and
  its disabled mix, `Icon`, the Record more refusal alert from `PlaybackBar`.
- **New:** none. `CaptureControls` takes the dock's shape and gains `sourceLocked`, `review` and the
  refusal; `RecordingDock` is unchanged.

## Research

- Loom's desktop recorder puts the screen and microphone choices and the start button in one
  control panel, chosen right before each recording
  (https://support.atlassian.com/loom/docs/get-started-with-the-loom-desktop-app/).
- The macOS Screenshot toolbar holds what to capture, Options (microphone included) and Record in
  one floating bar (https://support.apple.com/102618).
- The Windows Snipping Tool's recorder: one bar with the area, the audio toggles and Start, the same
  bar that then shows the timer and Stop.
- OBS keeps Start Recording in one controls dock beside the audio mixer
  (https://obsproject.com/kb/Quick-Start-Guide).
- Fluent: one primary (filled) button per view, so the user knows what to do next; here it is
  Record (https://learn.microsoft.com/en-us/windows/apps/design/controls/buttons).
