---
title: Keep recording a device that drops off USB
capabilities:
  - capture/device-reconnect
review: unreviewed
---
# Keep recording a device that drops off USB

## Why

The owner reviewed in a Quest 3 for three and a half minutes, and the take kept only the first
30 seconds of video. The headset had dropped off USB for half a second: scrcpy ended with it and
nothing started it again. The rest of the take was microphone only, with the last frame frozen,
and the session ended as an error. A reviewer in a headset cannot see the PC, so they only find
out at the end. This Quest dropped 35 times that day behind a dock, so drops are not rare.

## What changes

- A device take that loses its device keeps recording the microphone and records the device again
  into the same take as soon as ADB sees it, until Stop. Scenarios: A Quest drops and comes back
  in the middle of a take; The device is not back before Stop.
- The time without the device is black, and each stretch of device video and its audio sits at
  its own time. Scenario: Watching a take across a gap.
- The PC plays a falling two-tone sound when the device drops and a rising one when it is
  recorded again, and the dock says "Reconnecting to Quest 3…" meanwhile. Scenario: The device
  drops and returns while recording.
- The session stays ready and says how many seconds of device video are missing. Scenario:
  Opening a session with a gap.

## Settled questions

- **Q1 What happens at a drop**: keep the microphone, reconnect and continue the same take.
  Rejected: stop the recording; pause the microphone until the device is back.
- **Q2 What the gap shows**: black frames. Rejected: hold the last frame.
- **Q3 How long to keep trying**: until Stop. Rejected: give up after 2 minutes.
- **Q4 How the take ends and what tells the reviewer**: ready with a note of the missing time,
  plus a sound on the PC when the device drops and another when it is back, and the dock's
  reconnecting state. Rejected: mark the take as an error.

## Calls for the owner

- ADB is asked about once a second, and scrcpy is watched every 200 ms; a drop is heard within a
  quarter second and a returning device is recorded within about a second of ADB seeing it, plus
  scrcpy's start. Slower polling saves nothing that matters.
- A take with a gap is re-encoded once more at Stop (each segment onto the first segment's frame
  size, CRF 15) before the usual finalize, so Stop takes longer for those takes only. Takes without
  a gap are finalized exactly as before.
- The sounds are synthesized in the app (falling E5 to A4 for lost, rising C5 to G5 for back),
  about 150 ms per tone, played on the PC's default output. They are not configurable.
- The gap note sits under the session title ("12 s of device video missing"), summed over the
  session's takes; the scrubber does not mark where the gaps are.
- On an Android phone the touch track ends at the first drop, as before: its `getevent` ends with
  the device and is not restarted.

## Out of scope

- Why the device drops: here a dock's USB 2 branch and adb servers restarted by another tool; that
  is the owner's setup, not CueReview's.
- Restarting the Android touch reader after a drop, and marking gaps on the scrubber or in the
  `cue` CLI's output.
