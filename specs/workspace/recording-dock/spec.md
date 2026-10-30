---
title: Recording dock
code:
  - src/workspace/RecordingDock.tsx
  - src/workspace/workspace.css
---
# Recording dock

## Purpose

The dark bar under the preview while a take records: how long it has run, the microphone level, the
locked source, mute, compact mode and Stop.

## Requirements

### Requirement: The dock does not repeat which take is recording
The app SHALL show no "Take N" label in the dock and no caption under it, because the transcript's
"Take N · recording" divider already says which take is recording, and a label that appears from
the second take on changes the dock's width.

#### Scenario: Recording a later take
- **GIVEN** a session with one take
- **WHEN** the reviewer records another take with Record more
- **THEN** the dock shows the timer, the level meter, the locked source, mute, compact and Stop,
  with no "Take 2" label and no caption under it
- **AND** the transcript shows "Take 2 · recording"
- **PROOF** test: src/workspace/RecordingDock.test.tsx::RecordingDock shows the take timer, level and locked source for take 2, with no take label or caption
- **PROOF** test: src/App.test.tsx::record more unloads the video before recording a take, shows it live, and reloads the video with a cache-buster once processing ends
- **PROOF** desk: open
