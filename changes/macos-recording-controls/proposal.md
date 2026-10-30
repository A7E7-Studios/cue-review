---
title: Release macOS previews before recording and fix picker toggles
capabilities:
  - capture/recording-startup
  - capture/camera-capture
  - workspace/recording-dock
review: unreviewed
---
# Release macOS previews before recording and fix picker toggles

## Why

On build 2c4b9cb the owner can see the screen preview but Record reports no frames. FFmpeg can
encode healthy video while its Matroska output remains buffered beyond the startup deadline.
The owner also reports that clicking an open screen or microphone picker closes and immediately
reopens it on macOS, making the trigger behave inconsistently.

- Evidence: `evidence/recording-startup-failure.png`, "Recording is btw still not working."
- The owner says: "If you click the button again it doesn't close - it always reopens the dropdown."

## What changes

- Flush FFmpeg's recording output so a healthy capture reaches the existing readiness check
  promptly, for both static and moving content.
- Release an AVFoundation preview before recording opens the source; show Preview paused during
  startup and recording, and resume the draft preview if startup fails.
- Include the camera entitlement in the hardened macOS app signature so macOS can request and
  honor camera access when the person selects a camera.
- A second click on the source or microphone trigger closes that picker, in a new recording and
  in review. Keep keyboard, outside-click and trigger-switching behavior intact.
- Test production recording output arguments with real synthetic FFmpeg inputs, and picker
  clicks with actual WebKit pointer events rather than relying only on simulated DOM clicks.

## Settled questions

- **Q1 Scope**: The owner confirmed both narrow fixes for build 2c4b9cb, retaining the current
  capture backend, layout and saved recordings. ScreenCaptureKit migration is separate.
- **Q2 Recording implementation**: Enable output packet flushing in the shared production
  FFmpeg recording arguments. A longer startup deadline does not guarantee buffered output
  becomes visible. Synthetic static and moving captures reproduced the false timeout; output
  flushing exposed bytes within a fraction of a second.
- **Q3 Picker implementation**: Explicitly make both trigger buttons focusable. In macOS WebKit,
  clicking an implicitly focusable button inside the focusable workspace can focus the workspace
  first; the picker's blur handler closes it before the click handler toggles it open again.

## Calls for the owner

- Native camera verification exposed a separate packaging denial: macOS logs explicitly require
  `com.apple.security.device.camera` for CueReview's hardened-runtime signature. Include that
  single entitlement through the Tauri macOS configuration. This protected configuration path
  requires the owner to merge the completed pull request under AGENTS.md.

- The owner reported the installed buffering fix still failed. A native comparison reproduced
  the remaining cause: with preview active, the recording input never received its first frame;
  with preview released, the same input encoded 124 frames in about four seconds. Extend the
  existing V4L2 exclusive-access mechanism to AVFoundation, as the earlier approved camera design
  allows when contention is demonstrated. The owner authorized all tests needed to verify the fix.

- These are narrow repairs with the existing layout and interaction model. No new visual
  direction is introduced. Real display recording remains an open desk check until the owner
  checks it; the owner has authorized the attended tests needed to verify the repair.

## Out of scope

- Migrating screen capture to ScreenCaptureKit, adding macOS window capture or system audio.
- Changing scrcpy's readiness signal, the recording format, saved recordings or transcription.
- Establishing a stable signing identity. An ad-hoc rebuilt app can need its macOS privacy grant
  refreshed because the previous grant identifies the previous build's signature.
