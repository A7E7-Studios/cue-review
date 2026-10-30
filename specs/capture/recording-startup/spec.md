---
title: Recording startup
code:
  - src-tauri/src/capture.rs
---
# Recording startup

## Purpose

A selected source starts recording promptly when it supplies video. The reviewer receives a
failure when the capture process cannot supply usable output.

## Requirements

### Requirement: Healthy FFmpeg video reaches recording readiness
The app SHALL make healthy FFmpeg recording output visible to its startup check promptly,
because buffered output must not make a working source appear to produce no frames.

#### Scenario: Starting a recording of static content
- **GIVEN** an accessible source supplies unchanged video frames
- **WHEN** the reviewer starts a recording
- **THEN** recording starts within the startup deadline instead of reporting no frames
- **AND** stopping produces a decodable video with frames
- **PROOF** test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video
- **PROOF** desk: open

#### Scenario: Starting a recording of moving content
- **GIVEN** an accessible source supplies changing video frames
- **WHEN** the reviewer starts a recording
- **THEN** recording starts within the startup deadline instead of reporting no frames
- **AND** stopping produces a decodable video with frames
- **PROOF** test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video
- **PROOF** desk: open
