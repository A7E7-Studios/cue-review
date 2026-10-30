---
title: Show one recording bar with the source and microphone, before and during a take
capabilities:
  - workspace/recording-dock
review: unreviewed
---
# Show one recording bar with the source and microphone, before and during a take

## Why

When nothing records, the Record button "feels a bit lost", though it is the call to action: a
small black pill at the right edge of a new recording, and a "Record more" pill at the end of the
playback row. Record more could not pick a microphone or a source, and when the session's window
had closed it ended in "The original window/display for this recording is no longer available.
Start a new recording to capture another source." The owner wants one recording bar, always shown,
with the display and microphone in it, for a new recording, for Record more and while recording.

- Evidence: `evidence/record-button-lost.png`, "if you're not recording the record button feels a
  bit lost … and it's the call to action" at 7:53–8:01 (said while recording, so the frame shows
  the dock it was compared with).
- Evidence: `evidence/record-more-no-options.png`, "for the record more, I don't have any options
  for the audio device and so on" at 0:36.

## What changes

- A new recording shows the dark bar centred under the preview: display, microphone, and a red
  Record (scenario: Starting a new recording from the bar).
- Review shows the same bar in its own row under the playback controls, with Record more; the
  playback row loses its Record more pill (scenario: Recording more from the bar).
- In review the bar's microphone picker sets the next take's microphone; its display picker shows
  the session's source, locked, until separate take videos let a take come from another source
  (scenario: Recording more from the bar).
- A gone source is refused under the bar, with New recording (scenario: The session's display is
  gone).
- The locked picker never names the session's window or display by a listed source that may only
  share its id (scenario: The session's window handle now names another window).
- While a take records the bar becomes the dock it is today, Stop where Record was, the pickers
  locked (scenario: Recording a later take, unchanged).

## Settled questions

- **Q3 The record button** (7:53): unify it with the recording bar, always shown, with display and
  microphone selection integrated, for both states (Record and Record more); an agent draws the
  directions. Rejected: a bigger Record in place.
- **Q7 Switching mid-take**: between takes only; the pickers lock while a take records. Rejected:
  switching continues the take on the new source.
- **Q12 The direction**: A, the dock always (`look/directions/dock/`). Rejected: B, one merged row
  (`look/directions/merged-row/`); C, a bar pinned to the bottom (`look/directions/pinned-bar/`).
- **Q14 Record's colour**: the recording red. Rejected: the accent purple.
- **Q15 A microphone level before recording**: left out; the meter shows once a take records.
  Rejected: a backend microphone monitor in this change.
- **Q16 Order**: the owner chose to wait for the backend that lets a take come from any source. That
  backend became its own change (separate take videos), because the owner keeps each take's video
  apart; see Calls for the owner.

## Calls for the owner

- Shipped without waiting for separate take videos, the source picker locked in review: Q16 assumed
  a backend that was being built, and it is now a change of its own not yet started. Waiting would
  hold back the call to action and the microphone choice for Record more. Unlocking is one prop.
- The `SOURCE_GONE` refusal stays, under the bar, until separate take videos remove it.
- The bar keeps the accessible names Record and Record more and the `.source-trigger` /
  `.mic-trigger` hooks, so the scripts keep working. The bar itself is a group named "Recording
  bar"; the dock keeps "Recording controls", which the scripts use to find the dock.
- Record is drawn in Stop's red (`#D7333A`), not the record dot's `#E5484D`: white text on
  `#E5484D` is 3.9:1, under the 4.5:1 that 14px text needs; on Stop's red it is 4.7:1.
- When the session's source is no longer listed (a closed window), the locked picker reads
  "Original source". A listed `window:` or `monitor:` id may name another window or display after a
  restart, and the listing cannot tell, so the picker names a window by the title the session
  stored and a display "Original source": in the Windows app a session recorded from a display
  reads "Original source" in review, even while that display is attached. Naming displays needs the
  listing to carry the display device, a backend change.
- In review the bar has no live preview of the source it will record: the video area keeps
  playback. The picker names the source; a preview would replace the video being reviewed.

## Out of scope

- Recording a take from another source, and the refusal when the session's source is gone: the
  separate take videos change.
- The dock's level meter, mute and microphone name while recording (the audio capture batch).
- Compact recording mode, which stays as it is.
