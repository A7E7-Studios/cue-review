---
title: Take playback
code:
  - src/App.tsx
  - src/app/media.ts
  - src/backend.ts
---
# Take playback

## Purpose

A session of several takes plays as one recording: the scrubber, the time and the transcript run
over every take, and the player shows the video of whichever take the time falls in.

## Requirements

### Requirement: The player plays the take the time falls in
The app SHALL play a session's takes one after another on the session timeline, loading the video
of the take the time falls in, because each take keeps its own video and the reviewer reviews the
session as one recording.

#### Scenario: Playing across a take boundary
- **GIVEN** a session with take 1 from a display and take 2 from a window
- **WHEN** playback reaches the end of take 1
- **THEN** take 2's video plays on from its start
- **AND** the time and the scrubber keep counting on the session timeline
- **PROOF** test: src/App.test.tsx::take playback plays on from one take's video into the next
- **PROOF** desk: open

#### Scenario: Seeking into another take
- **GIVEN** a session with two takes, playing take 1
- **WHEN** the reviewer selects a word of take 2 in the transcript, or a point of take 2 on the
  scrubber
- **THEN** take 2's video shows that moment, and playback goes on if it was playing
- **AND** seeking back into take 1 shows take 1's video again
- **PROOF** test: src/App.test.tsx::take playback seeks into another take's video from the scrubber and the transcript
- **PROOF** test: src/app/media.test.ts::videoAt picks the take video by session time
- **PROOF** desk: open

#### Scenario: Opening a search result in a later take
- **GIVEN** a session with two takes
- **WHEN** the reviewer opens a search result on a line of take 2
- **THEN** the session opens paused at that moment of take 2's video
- **PROOF** test: src/App.test.tsx::take playback opens a search result in the take video its line falls in
- **PROOF** desk: open
