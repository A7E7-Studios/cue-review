# Design: One recording bar, always shown, with source and microphone in it

## Context

Three components share the slot under the video today. `CaptureControls` (a draft: light source
and microphone pills, a small black Record at the right), `PlaybackBar` (review: scrubber, play,
speed, focus, and a black Record more pill with its refusal alert) and `RecordingDock` (a take
recording: the dark capsule). `App.tsx` picks one by `mode`. Record more takes no source: the
backend reuses the session's own and refuses when it is gone (`SOURCE_GONE`). Recording a take
from another source needs each take's video kept apart (the owner's answer in the audio batch),
which is its own change, separate take videos; until it lands, capture records Record more from
the session's source.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| One component or three | `CaptureControls` takes the dock's shape and serves a draft and review (`recordLabel` Record / Record more); `RecordingDock` stays for a take recording, in the same place and shape | One new `RecordingBar` with three modes: merges two tested components (picker focus, popovers, container steps) for no visible gain | — |
| Where it sits | Centred under the video in a draft; its own row under the playback row in review; the dock in that row's place while recording | In the playback row (direction B), pinned to the bottom (direction C): the owner picked A | `changes/always-on-recording-bar/look.md` |
| The source for Record more | The bar's source picker shows the session's source, locked (focusable but inert, `aria-disabled`, titled and described "Record more records this session's own source"); `CaptureControls` gets a `sourceLocked` prop so unlocking it is one prop | Normalising another source into the combined video: the owner keeps each take's video apart; an unlocked picker that capture would ignore | owner's answer in the audio batch (Q5) |
| Naming the locked source | The listed name only for ids that cannot pass to another source; a `window:` or `monitor:` id gets what `sourceIdentity` stored (the window title, or "Display N" from the display device), or "Original source" | The listed name for any listed id: after a restart it can be another window or display; comparing identities in the frontend: the listing carries no process id, window class or display device | `docs/ARCHITECTURE.md`, Source identity |
| A gone source | The `SOURCE_GONE` refusal shows under the bar as an alert with New recording and Dismiss, as it did beside the pill | A picker that asks for another source: lands with separate take videos | — |
| Record's colour | The recording red, the same as Stop (`--color-stop`, `#D7333A`): white text on it is 4.7:1, on `--color-record` (`#E5484D`) only 3.9:1 | Accent purple: Q14 settled red | owner, Q14 |
| A microphone level before recording | Not drawn: the meter appears once a take records | A level check in the picker needs a microphone monitor in the backend (the capture domain) | owner, Q15 |
| Narrowing | Container queries on the bar like the dock's: the picker labels drop to icons (names kept as visually hidden text), then Record's label | Wrapping, as the light pills do today: breaks the capsule | `workspace.css` dock steps |
| Accessible names | Keep `Record`, `Record more`, `.source-trigger`, `.mic-trigger`, and `Recording controls` on the dock; the bar is a group named `Recording bar` (added to `NAMES`) | New names: break `verify-*` and `NAMES` users; naming the bar `Recording controls` too would make the scripts' dock lookup match the bar | AGENTS.md |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src/workspace/CaptureControls.tsx`, `PlaybackBar.tsx` (the Record more pill and alert go), `workspace.css`, `types.ts`, `src/App.tsx` (the bar in review, the source passed to Record more, no `recordMoreError` alert), stories; README.md's Record more step and DESIGN.md's "One slot, two modes" |
| Formats and contracts | none: `backend.recordMore(id, microphoneId, systemAudio, muted)` as it is; the separate take videos change adds a source id and unlocks the picker |

## Test plan

| Scenario or logic | Test |
|---|---|
| Starting a new recording from the bar | `src/workspace/CaptureControls.test.tsx`, new; `src/App.test.tsx::recording and processing`, new |
| The locked source's name | `src/App.test.tsx::record more`, new |
| Recording more from the bar | `src/App.test.tsx::record more`, changed |
| The original source is gone | `src/App.test.tsx::record more`, changed: the alert sits under the bar |
| The bar while a take records | `src/App.test.tsx::record more`, existing |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| each | desk | the bar in a draft, in review, while recording, and with the session's window closed, light and dark, at 1280×800 and 900×650 |

## Risks

- Review grows a third row; at 900×650 the video shrinks. The bar's row is 56px plus a 12px gap; checked at that size and at the 640×480 minimum, where it fits as icons.
- The hand-off: another source for Record more lands with the separate take videos change, which
  unlocks the picker (`sourceLocked`) and passes its choice to `record_more`.

Approved by the lead on the owner's delegation (the owner is away and asked for the recommended
options); the owner reviews it with the change.
