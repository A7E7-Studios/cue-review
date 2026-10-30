---
title: Recording dock
code:
  - src/workspace/RecordingDock.tsx
  - src/workspace/workspace.css
---
# Recording dock

## Purpose

The dark bar under the preview while a take records: how long it has run, the locked source, the
microphone it records with its level and mute, compact mode and Stop.

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

### Requirement: The meter reads the microphone in decibels
The dock's level meter SHALL light one of its 10 bars for every 6 dB above −60 dBFS of the loudest
level since its last update, the top two bars (above −12 dBFS) in the high colour, because quiet
speech left a linear meter dark and the reviewer took the microphone for dead.

#### Scenario: Quiet speech lights the meter
- **GIVEN** a microphone picking up speech at −38 dBFS
- **WHEN** the dock updates
- **THEN** three bars of the meter are lit, in the low colour
- **AND** a word spoken between two updates still lights the meter
- **PROOF** test: src/workspace/RecordingDock.test.tsx::RecordingDock lights one bar per 6 dB above −60 dBFS
- **PROOF** test: src-tauri/src/capture.rs::tests::the_level_is_the_loudest_since_it_was_read
- **PROOF** desk: open

### Requirement: The dock names the microphone
The dock SHALL show the name of the microphone it records on a microphone chip that holds the
meter and mutes the microphone, because the reviewer could not tell which microphone was in use.

#### Scenario: The dock names the microphone
- **GIVEN** a take recording from "Microphone (HD Pro Webcam C920)"
- **WHEN** the dock shows
- **THEN** the microphone chip reads "HD Pro Webcam C920" beside the meter
- **AND** its tooltip names the whole device
- **PROOF** test: src/workspace/RecordingDock.test.tsx::RecordingDock names the microphone on its chip
- **PROOF** test: src/App.test.tsx::a mute from the dock ends with its take
- **PROOF** desk: open

### Requirement: Muting is plain and keeps the dock's shape
While the microphone is muted, the dock SHALL show the microphone chip in the live colour reading
"Muted", with its meter in place and flat, and SHALL keep its width, because a reviewer muted and
unmuted eleven times without noticing, and the dock changed width under the pointer.

#### Scenario: Muting the microphone while recording
- **GIVEN** a take recording with a microphone
- **WHEN** the reviewer presses the microphone chip
- **THEN** the chip turns the live colour and reads "Muted" over a flat meter
- **AND** the dock is as wide as before
- **AND** pressing the chip again shows the microphone's name and level
- **PROOF** test: src/workspace/RecordingDock.test.tsx::RecordingDock keeps the chip and a flat meter while muted, and says Muted
- **PROOF** desk: open

### Requirement: A mute from the dock lasts for its take
The app SHALL start every take with the microphone unmuted unless Mute was ticked in the
microphone picker before it started, because a mute from the dock otherwise carried silently into
the next take.

#### Scenario: The next take starts unmuted
- **GIVEN** the reviewer muted the microphone from the dock during a take
- **WHEN** the take stops and the reviewer records more
- **THEN** the new take records the microphone unmuted
- **PROOF** test: src/App.test.tsx::a mute from the dock ends with its take
