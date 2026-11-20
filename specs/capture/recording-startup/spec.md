---
title: Recording startup
review: unreviewed
code:
  - src-tauri/src/capture.rs
  - src-tauri/src/preview.rs
  - src-tauri/src/lib.rs
  - src/App.tsx
  - src/workspace/MediaStage.tsx
---
# Recording startup

## Summary

When you press Record, recording starts promptly once the chosen source supplies video; on a Mac the
preview first lets go of the source so the recording can open it. When the capture cannot supply
usable output, you are told that it failed.

## Requirements

### Requirement: macOS recording owns its capture source
The app SHALL release the macOS source's preview before opening it for recording and keep the
preview paused during startup and recording, because concurrent access can prevent the recorder
from receiving its first frame.

#### Scenario: Starting a macOS display recording from its preview
- **GIVEN** the selected macOS display has a live preview
- **WHEN** the reviewer starts recording
- **THEN** the preview releases the source before recording opens it
- **AND** the video area says Preview paused while recording and Stop remains available
- **AND** stopping normally produces a playable video of the display
- **PROOF** test: src/stories/Workspace.stories.tsx::MacDisplayRecordingFromPreview
- **PROOF** test: src-tauri/src/preview.rs::tests::exclusive_source_start_waits_for_preview_worker_to_release_source

#### Scenario: Returning to preview after a refused macOS recording
- **GIVEN** the selected macOS source has a live preview
- **WHEN** recording startup fails after the preview is released
- **THEN** the app shows the recording error and resumes preview in the draft
- **PROOF** test: src/App.test.tsx::pauses Capture screen 0 preview during startup and recording, then restores it after a failed start

### Requirement: Healthy FFmpeg video reaches recording readiness
The app SHALL make healthy FFmpeg recording output visible to its startup check promptly,
because buffered output must not make a working source appear to produce no frames.

#### Scenario: Starting a recording of static content
- **GIVEN** an accessible source supplies unchanged video frames
- **WHEN** the reviewer starts a recording
- **THEN** recording starts within the startup deadline instead of reporting no frames
- **AND** stopping produces a decodable video with frames
- **PROOF** test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video

#### Scenario: Starting a recording of moving content
- **GIVEN** an accessible source supplies changing video frames
- **WHEN** the reviewer starts a recording
- **THEN** recording starts within the startup deadline instead of reporting no frames
- **AND** stopping produces a decodable video with frames
- **PROOF** test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video
