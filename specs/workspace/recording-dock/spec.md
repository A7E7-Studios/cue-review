---
title: Recording dock
code:
  - src/workspace/RecordingDock.tsx
  - src/workspace/CaptureControls.tsx
  - src/workspace/PlaybackBar.tsx
  - src/workspace/types.ts
  - src/workspace/workspace.css
  - src/App.tsx
  - src-tauri/src/capture.rs
---
# Recording dock

## Purpose

The dark bar under the video. Before a take it holds the display, the microphone and Record (Record
more in review); while a take records it shows how long it has run, the locked source, the
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

### Requirement: The bar is always under the video
The app SHALL show one dark recording bar under the video whenever nothing records, holding the
display picker, the microphone picker and a red Record, centred under the preview of a new
recording, because Record is the workspace's call to action and the reviewer chooses what to
record right beside it.

#### Scenario: Starting a new recording from the bar
- **GIVEN** a new recording with a display and a microphone available
- **WHEN** the reviewer chooses a display and a microphone in the bar and selects Record
- **THEN** the recording starts with that display and that microphone
- **AND** the bar keeps to one row as the window narrows, showing the pickers as icons and then
  Record as an icon, each still named for screen readers
- **PROOF** test: src/workspace/CaptureControls.test.tsx::CaptureControls as the recording bar is one named bar holding the pickers and Record in a draft
- **PROOF** test: src/App.test.tsx::recording and processing starts a new recording with the display and microphone chosen in the recording bar
- **PROOF** desk: open

### Requirement: Record more uses the bar
The app SHALL show the recording bar in review in its own row under the playback controls, with
Record more, a microphone picker that sets the next take's microphone, and the session's own
display locked, because the reviewer chooses the microphone for each take while a take still
records the session's own source.

#### Scenario: Recording more from the bar
- **GIVEN** a ready session recorded from Display 1
- **WHEN** the reviewer chooses another microphone in the bar under the playback controls and
  selects Record more
- **THEN** a new take of the session starts with that microphone and the session's display
- **AND** the bar shows the session's source locked, titled and described "Record more records
  this session's own source", reachable with Tab but opening no picker, and the playback row
  holds no Record more
- **PROOF** test: src/App.test.tsx::record more records more from the bar under the playback controls, with its microphone and the session's locked source
- **PROOF** test: src/workspace/CaptureControls.test.tsx::CaptureControls as the recording bar offers Record more in review, with the source locked and its reason, and the microphone still to choose
- **PROOF** test: src/workspace/CaptureControls.test.tsx::CaptureControls as the recording bar keeps the locked source focusable while Record more is busy
- **PROOF** test: src/workspace/PlaybackBar.test.tsx::PlaybackBar leaves Record more and its refusal to the recording bar under it
- **PROOF** desk: open

### Requirement: The locked source names only the session's own source
The app SHALL name the session's source in the review bar by its listed name only when its id
cannot have passed to another source; a window or display (a `window:` or `monitor:` id) is
named by what the session stored for it, its window's title or its display's device number
("Display 2"), or "Original source" when it stored neither, because such an id can name another
window or display after a restart and the listing cannot tell them apart.

#### Scenario: The session's window handle now names another window
- **GIVEN** a ready session recorded from a window, whose handle now names another listed window
- **WHEN** the reviewer opens it
- **THEN** the bar names its source by the window title the session stored, not by the listed
  window
- **AND** a session recorded from a display is named by the display device it stored, and one
  that stored none shows "Original source"
- **PROOF** test: src/App.test.tsx::record more never names the session's source after a listed window or display that may only share its id
- **PROOF** desk: open

### Requirement: A gone display is refused under the bar
The app SHALL show why Record more was refused right under the recording bar, with New recording
and Dismiss, and name a display that is no longer listed "Original source", because the reviewer
needs the reason and the way forward where they selected Record more.

#### Scenario: The session's display is gone
- **GIVEN** a ready session whose window has closed
- **WHEN** the reviewer selects Record more
- **THEN** the bar shows "The original window/display for this recording is no longer
  available. Start a new recording to capture another source." under it, with New recording and
  Dismiss, and the video stays playable
- **AND** New recording opens a new recording where another display can be chosen
- **PROOF** test: src/App.test.tsx::record more shows a source that is gone under the recording bar, with New recording as the way forward
- **PROOF** test: src/App.test.tsx::record more names the session's source in the bar as the original source once it is no longer listed
- **PROOF** test: src/workspace/CaptureControls.test.tsx::CaptureControls as the recording bar shows why Record more failed under the bar, with New recording and Dismiss
- **PROOF** desk: open

### Requirement: The meter reads the microphone in decibels
The dock's level meter SHALL light one of its 10 bars for each 6 dB step above −60 dBFS that the
loudest level since its last update reaches into, the top two bars (above −12 dBFS) in the high colour, because quiet
speech left a linear meter dark and the reviewer took the microphone for dead.

#### Scenario: Quiet speech lights the meter
- **GIVEN** a microphone picking up speech at −38 dBFS
- **WHEN** the dock updates
- **THEN** four bars of the meter are lit, in the low colour
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
