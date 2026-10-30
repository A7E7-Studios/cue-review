---
title: Prefer displays and make macOS camera capture usable
capabilities:
  - capture/source-selection
  - capture/camera-capture
review: unreviewed
---
# Prefer displays and make macOS camera capture usable

## Why

On the installed Apple Silicon build 0.2.0, the owner found FaceTime HD Camera first in the
source picker and reported that it did not work. The built-in webcam is a useful capture source,
but a review should start with a display when one is available. Listing a camera first and opening
an unusable preview makes the initial recording experience confusing.

The owner said: "it is not working" and "it should probably not be the initial selection."
Camera-only diagnostics produced frames with FFmpeg and a decodable recording with the installed
CLI, so the reported app failure still needs reproduction in the app's preview path. The CLI's
five-second hold produced a twelve-second file with startup padding; it opened no microphone or
system-audio track. Diagnostic evidence is local in the main checkout's ignored
`test-results/macos-camera/verification.json`; camera images are not committed.

## What changes

- Order the existing source picker as displays, windows, Android/Quest devices, then cameras.
  The initial selection is the first available source in that order; a camera remains a fallback
  when higher-priority sources are unavailable.
- Preserve a person's explicit selection when sources refresh, including an unavailable placeholder
  when the chosen source disappears.
- Make an explicitly selected macOS camera show a live preview and produce a playable recording,
  including starting a recording while that camera's preview is active.
- Explain a blocked camera capture and allow the person to retry after resolving it.
- Keep the picker design, accessible control names and existing stored recordings unchanged.

## Settled questions

- **Q1 Fix scope**: Fix both source ordering and camera preview/recording. Rejected: change the
  order now and investigate camera capture separately. The owner accepted keeping cameras below
  displays, windows and devices rather than filtering the built-in camera out.
- **Q2 Camera diagnostics**: The owner authorized up to three five-second camera-only captures,
  without microphone capture, stored locally in isolated test data. Rejected: code analysis only.
  Two diagnostic captures were run; the CLI's startup padding extended its output timeline.
  This authorization does not cover microphone or desktop recording.
- **Q3 Requirements summary**: The owner confirmed the source order, first-available initial
  selection, preservation of an explicit choice on refresh, working macOS camera preview and
  recording, and useful errors and retry when blocked. The existing picker design and stored
  recordings stay unchanged.

## Calls for the owner

- Within a source category, retain the platform's discovery order. An alternative alphabetical
  order would change the relationship between listed displays and their platform indices.
- Use the new capabilities `capture/source-selection` and `capture/camera-capture`; the existing
  capture capabilities cover audio tracks and Record more rather than these behaviours.
- Automated tests named in the new specs are acceptance targets for implementation. Real camera
  preview, recording and permission recovery also require the owner's `desk` check; the CLI
  diagnostics alone do not approve them.

## Out of scope

- Removing or hiding cameras, changing the picker's layout, or adding source categories.
- Adding macOS per-window capture, desktop system audio, or desktop pointer tracking.
- Changing recording storage, migrating existing sessions, or changing transcription.
- A general change to capture startup timing; retain the diagnostic finding for the camera repair
  to assess without silently extending this scope.
- Changing the Android/Quest recording implementation or testing physical USB disconnection.
