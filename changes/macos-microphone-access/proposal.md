---
title: Permit microphone capture in the hardened macOS app
capabilities:
  - capture/audio-tracks
review: unreviewed
---
# Permit microphone capture in the hardened macOS app

## Why

The owner reports, "audio is not working as well. Didn't pick up anything" after merging the
macOS recording fixes. The latest recording selects the default microphone, but its microphone
track contains only zero samples. The installed hardened app lacks the audio-input entitlement;
macOS logs explicitly report that missing entitlement when microphone access is attempted.

## What changes

- Include the audio-input entitlement in the existing macOS entitlement file so the operating
  system can request and honor microphone permission.
- Verify microphone and camera entitlements in the signed app during the installer smoke check.
- Verify actual microphone samples and finalized playback using isolated local test data.

## Settled questions

- The owner asks to fix audio capture and has authorized all tests needed to verify the recording
  functionality. This is a one-key packaging correction with a plain outcome, so the spec skill's
  small-fix exception applies.
- The recorded session selects the default microphone and disables system audio; its microphone
  track is silent. This is microphone capture, not a transcription or system-audio feature request.

## Calls for the owner

- Preserve the existing capture implementation and privacy prompts. Add the required entitlement
  without disabling hardened runtime or bypassing the person's microphone permission.
- Keep human proof open; no approval of previous scenarios is inferred from "Merged".

## Out of scope

- macOS system-audio capture, ScreenCaptureKit migration, transcription changes and stored data.
- Stable signing identity for development builds.
