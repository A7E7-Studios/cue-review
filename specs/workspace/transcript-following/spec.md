---
title: Transcript following
code:
  - src/workspace/TranscriptPane.tsx
  - src/review.ts
  - src/stories/Transcript.stories.tsx
---
# Transcript following

## Purpose

The transcript keeps the sentence being played, or the newest words while recording, in view. When
the reader scrolls elsewhere it stops following and offers one button back.

## Requirements

### Requirement: The way back goes where the transcript follows
The app SHALL offer a way back only when there is a place to go back to, and name it for that
place: "Return to playback" in review, "Back to live" while recording, because a button that does
nothing, or that names playback while recording, misleads the reader.

#### Scenario: The reader scrolls away during playback
- **GIVEN** a session in review whose playhead is in or after a sentence
- **WHEN** the reader scrolls that sentence out of view
- **THEN** "Return to playback" appears
- **AND** pressing it scrolls the sentence the playhead last reached into view, also while the
  playhead sits in a pause between words, and the transcript follows playback again
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::Following playback
- **PROOF** desk: open

#### Scenario: Nothing has played yet
- **GIVEN** a session in review whose playhead is before the first sentence
- **WHEN** the reader scrolls the transcript
- **THEN** no button appears
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::Following playback offers no return before the playhead reaches the first sentence
- **PROOF** desk: open

#### Scenario: The reader scrolls up while recording
- **GIVEN** a take being recorded, with its words arriving in the transcript
- **WHEN** the reader scrolls away from the newest words
- **THEN** "Back to live" appears, and no "Return to playback"
- **AND** pressing it scrolls to the newest words, and the transcript follows them again
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::Following playback offers Back to live while recording and scrolls to the newest words
- **PROOF** desk: open

### Requirement: Scrolling back resumes following
The app SHALL resume following when the reader scrolls the followed sentence or the newest words
back into view themselves, because they have come back to where the transcript follows and the
button would then have nothing left to do.

#### Scenario: The reader scrolls back to the playing sentence
- **GIVEN** the reader has scrolled away and the way-back button shows
- **WHEN** they scroll the playing sentence, or the newest words while recording, back into view
- **THEN** the button disappears and the transcript follows again
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::Following playback resumes following when the reader scrolls the playing row back into view
- **PROOF** desk: open
