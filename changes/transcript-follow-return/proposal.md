---
title: Offer the way back in the transcript only where it leads somewhere
capabilities:
  - workspace/transcript-following
review: unreviewed
---
# Offer the way back in the transcript only where it leads somewhere

## Why

The owner scrolled the transcript while recording and met a "Return to playback" button: there is
no playback while recording, and pressing it jumped to the live words. In review, with nothing
playing, the same button appeared after a scroll and did nothing, because the transcript only knew
where to go while the playhead sat on a word.

- Evidence: `evidence/return-to-playback-while-recording.png`, "I don't get this return, I kind of
  show it while recording, but there's a return to playback button … it basically does nothing up
  here and it's weird" at 6:07–6:15; "Okay, it jumps down" at 6:27.
- Evidence: `evidence/return-to-playback-take-5.png`, "if there is no playback or no recording it
  still appears this button but it basically does nothing so that's of course not a good thing" at
  8:07.

## What changes

- While recording the button reads "Back to live" and goes to the newest words (scenario: The
  reader scrolls up while recording).
- In review the transcript follows the sentence the playhead last reached, so "Return to playback"
  always scrolls somewhere, also in the pauses between words (scenario: The reader scrolls away
  during playback).
- Before the playhead reaches the first sentence there is no button (scenario: Nothing has played
  yet).
- Scrolling the followed place back into view resumes following and hides the button (scenario:
  The reader scrolls back to the playing sentence).

## Settled questions

- **Q1 The button while recording**: keep it, named "Back to live"; in review it stays "Return to
  playback". Rejected: hide it while recording; keep "Return to playback" in both modes.
- **Q2 Scrolling back yourself**: resumes following and hides the button, as chat apps do.
  Rejected: only the button, a word click or a seek resume following.
- **Q9 Nothing has played yet**: no button. Rejected: a button that scrolls to the first sentence.

## Calls for the owner

- "Back to live" keeps the play triangle the button has in review. The alternative is a down arrow
  for the live end; changing it is one icon name in `TranscriptPane.tsx`.
- The sentence the playhead "last reached" is the last one whose seek point lies at or before the
  playhead. The alternative, the last one whose start lies before it, misplaces sentences whose
  aligned seek point lies well after their coarse start.

## Out of scope

- Find in transcript and its search bar (6:36), which the layout and controls batch carries.
