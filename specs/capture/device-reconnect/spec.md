---
title: Device reconnect
code:
  - src-tauri/src/capture.rs
  - src-tauri/src/device_link.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/models.rs
  - src-tauri/src/store.rs
  - src/backend.ts
  - src/App.tsx
  - src/app/
  - src/workspace/
---
# Device reconnect

## Purpose

An Android phone or a Quest that drops off USB in the middle of a recording does not end the
recording. The take keeps the microphone, picks the device up again as soon as it is back, and
shows the missing seconds as black. The reviewer hears when the device goes and when it returns,
and the finished session says how much device video is missing.

## Requirements

### Requirement: A device that drops is recorded again when it returns
The app SHALL keep a device take recording when its device drops off USB, and record the device
again into the same take as soon as ADB sees it, for as long as the take runs, because a reviewer
in a headset cannot see that the PC lost the device and would otherwise lose the rest of a long
review.

#### Scenario: A Quest drops and comes back in the middle of a take
- **GIVEN** a take records a Quest with a microphone
- **WHEN** the Quest drops off USB and is back a few seconds later
- **THEN** device video resumes in the same take, at its place on the take's timeline
- **AND** the microphone track has no gap
- **PROOF** test: src-tauri/src/device_link.rs::tests::device_recorder_records_again_after_the_device_returns
- **PROOF** test: scripts/verify-device-reconnect.cjs
- **PROOF** headset: open

#### Scenario: The device is not back before Stop
- **GIVEN** a take records a device that dropped off USB
- **WHEN** the reviewer stops the take before the device is back
- **THEN** the take is ready, with device video up to the drop and the microphone to the end
- **PROOF** test: src-tauri/src/device_link.rs::tests::actual_device_segments_black_out_the_gaps

### Requirement: The missing seconds are black
The app SHALL show black frames for the time the device was gone, with each recorded stretch of
device video at its own time, because a frozen frame looks like a screen where nothing happened,
and an agent taking a frame there would treat it as what the device showed.

#### Scenario: Watching a take across a gap
- **GIVEN** a device take whose device was gone for a while in the middle
- **WHEN** the reviewer plays across that time
- **THEN** the video is black from the drop until the device's first frame after it returns
- **AND** the device's audio, when the take records it, stays in step with its video on both sides
- **PROOF** test: src-tauri/src/device_link.rs::tests::actual_device_segments_black_out_the_gaps
- **PROOF** desk: open

### Requirement: The reviewer hears the device go and come back
The app SHALL play a sound when a recording's device drops and another when it is recorded again,
and show in the recording dock that it is reconnecting, because a reviewer in a headset does not
look at the PC.

#### Scenario: The device drops and returns while recording
- **GIVEN** a take records a device
- **WHEN** the device drops off USB, then returns
- **THEN** the PC plays the connection-lost sound and the dock says it is reconnecting to the device
- **AND** when device video resumes, the PC plays the reconnected sound, the dock is as before and the live preview starts again
- **PROOF** test: src/workspace/RecordingDock.test.tsx::RecordingDock says it is reconnecting while the device is gone
- **PROOF** test: src/app/deviceLinkSounds.test.ts::device link sounds play once for each drop and each return
- **PROOF** test: src/App.test.tsx::local setup recovery and request races starts the preview again once a dropped device is recorded again
- **PROOF** test: scripts/verify-device-reconnect.cjs
- **PROOF** desk: open
- **PROOF** headset: open

### Requirement: The session says how much device video is missing
The app SHALL keep a device take with gaps ready, not failed, and say in the session how many
seconds of device video are missing, because the review is usable and the reviewer needs to know
why part of it is black.

#### Scenario: Opening a session with a gap
- **GIVEN** a device take was recorded with the device gone for 12 seconds
- **WHEN** the reviewer opens the session
- **THEN** the session is ready and notes that 12 s of device video are missing
- **PROOF** test: src/workspace/SessionHeader.test.tsx::SessionHeader notes the device video a take is missing
- **PROOF** desk: open
