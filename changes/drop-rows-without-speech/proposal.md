---
title: Leave out transcript rows made up over silence
capabilities:
  - transcription/speech-detection
review: unreviewed
---
# Leave out transcript rows made up over silence

## Why

The owner re-transcribed a 2.5-hour German review ("IKA Explorer Review Marcel") with the larger
model on the graphics card. The words got far better, but the microphone track, silenced wherever
it only heard the call from the loudspeakers, filled its silent stretches with 159 made-up rows,
many 30 s long: "Vertraue und glaube, es hilft, es heilt die göttliche Kraft!" 65 times,
"Untertitelung im Auftrag des ZDF, 2020", "Vielen Dank." The small model does the same, less often
("Das ist eine neue Entdeckung." 17 times in the earlier transcript). Such rows read as things
someone said, to the reviewer and to the agent the review is handed to.

The speech detector already marks where the audio holds speech. On that review, 156 of the 159
made-up microphone rows overlapped detected speech by less than a tenth, against 15 of the 367
other microphone rows.

## What changes

- A whole-take transcription (after Stop, the refining pass, Retry, `cue transcribe`) leaves out
  each row of which less than a tenth lies within one second of detected speech, for every model
  and both tracks: scenarios "Text made up over silence is left out" and "Both tracks are cleaned
  alike".
- A short reply next to detected speech stays: "A short reply beside speech is kept".
- The raw Whisper output is left as it is: "The speech model's own output keeps every row".

Measured on the IKA review (161 made-up rows across both tracks, 21,745 words): the rule leaves out
152 of the 161, and 26 other rows (32 words, mostly a lone "Ja." or "Okay." that the detector did
not hear, some of them likely made up too).

## Settled questions

- **Q1 Rule**: a row is left out when less than a tenth of it lies within one second of detected
  speech. Rejected: only a row with no detected speech at all within a second (147 of 161, 29
  other rows); word by word (147 of 161, but 224 words cut out of real rows, because Whisper's word
  times drift).
- **Q2 Scope**: every whole-take transcription, every model, both tracks. Rejected: the larger
  model only.
- **Q3 Where the left-out rows stay**: in the raw Whisper output only (`whisper.json`,
  `whisper-system.json`), as every row is now. Rejected: also listing them in the take's log.
- **Q4 Human check**: unit tests, and a desk check of the IKA review transcribed again with a build
  of this change. Rejected: tests only.
- **Summary**: confirmed by the owner before writing.

## Calls for the owner

- **A new capability, `transcription/speech-detection`**, rather than a requirement in
  `speech-runtime` or `transcribed-tracks`: the rule is about what the detector's result does to
  the transcript, which neither of those covers, and the detector's other uses (a take without
  speech gets an empty transcript) can join it later. Moving the requirement costs a spec edit.
- **A row of no length** (its first word starts where its last ends) is kept when it lies within
  one second of detected speech, and left out otherwise; a tenth of nothing would keep every one.
- **Stretches transcribed while recording are not filtered**: they are cut where the detector
  found speech, and the refining pass after Stop replaces them with a whole-take pass, which is.

## Out of scope

- Why the larger model is judged too slow on the owner's RTX 5090, so the app does not use it
  although it is chosen: the measurement is fixed in its own change.
- Live words while recording.
- Cutting silence out of the audio before Whisper: the pinned runtime's own detector does not map
  its times back to the recording, so the audio stays whole.
