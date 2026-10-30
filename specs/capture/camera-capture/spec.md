---
title: Camera capture
code:
  - src-tauri/src/capture.rs
  - src-tauri/src/preview.rs
  - src/App.tsx
  - src/app/usePreviewStream.ts
---
# Camera capture

## Purpose

A person can deliberately select a camera to show physical work in a review. On macOS the
built-in camera supplies a live preview and a recording that can be played back.

## Requirements

### Requirement: A selected macOS camera shows a live preview
The app SHALL show updating camera frames when a person selects an accessible macOS camera,
because listing a camera as a source is useful only when the person can see what it will record.

#### Scenario: The built-in camera is explicitly selected
- **GIVEN** the app runs on macOS and camera access is allowed
- **WHEN** the person selects FaceTime HD Camera from the source picker
- **THEN** its live view appears in the existing preview area
- **AND** it continues updating while that source is selected in the draft
- **PROOF** test: src-tauri/src/preview.rs::tests::macos_camera_preview_frames_reach_the_viewer
- **PROOF** desk: open

### Requirement: Recording can start from a macOS camera preview
The app SHALL record the selected macOS camera when Record is pressed from its live preview,
because the preview and recording must cooperate over access to the same camera.

#### Scenario: A recording starts while the camera preview is active
- **GIVEN** the built-in camera's live preview is visible on macOS
- **WHEN** the person records a short take and stops it
- **THEN** the recording finishes with a playable video of that camera
- **AND** playing it in the app shows the recorded camera view
- **PROOF** test: src/App.test.tsx::starts a macos camera recording from its preview
- **PROOF** desk: open

### Requirement: A blocked camera has a recoverable error
The app SHALL explain a blocked macOS camera preview or recording and let the person retry after
resolving the block, because an indefinitely loading view gives no way to recover.

#### Scenario: Camera access is blocked
- **GIVEN** the selected macOS camera cannot be opened
- **WHEN** its preview or recording starts
- **THEN** the app shows an error with an action that can resolve the block
- **AND** preview startup does not remain indefinitely in its loading state
- **AND** the person can select another source
- **PROOF** test: src/App.test.tsx::shows actionable macos camera startup errors
- **PROOF** desk: open

#### Scenario: The person resolves the camera block and retries
- **GIVEN** the selected camera's preview shows an error
- **AND** the person has allowed camera access or otherwise resolved the reported block
- **WHEN** the person retries the preview
- **THEN** the camera view appears and updates
- **AND** recording can start without restarting the app
- **PROOF** test: src/App.test.tsx::retries a blocked camera preview after access is restored
- **PROOF** desk: open
