---
title: Start buffered recordings and close pickers on a second click
capabilities:
  - capture/recording-startup
  - workspace/recording-dock
review: unreviewed
---
# Start buffered recordings and close pickers on a second click

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

- These are narrow repairs with the existing layout and interaction model. No new visual
  direction is introduced. Real display recording remains an open desk check until the owner
  authorizes and checks it; previous permission to preview did not authorize recording.

## Out of scope

- Migrating screen capture to ScreenCaptureKit, adding macOS window capture or system audio.
- Changing scrcpy's readiness signal, the recording format, saved recordings or transcription.
- Establishing a stable signing identity. An ad-hoc rebuilt app can need its macOS privacy grant
  refreshed because the previous grant identifies the previous build's signature.
