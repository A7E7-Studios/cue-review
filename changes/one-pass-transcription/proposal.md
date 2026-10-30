---
title: Transcribe a take once, while it is recorded
capabilities:
  - transcription/live-transcription
review: unreviewed
---
# Transcribe a take once, while it is recorded

## Why

Every take was transcribed twice. While recording, a preview re-transcribed the last 30 seconds every
8 seconds; after Stop, the whole take was transcribed again. So the live words came late, and Stop
always waited for the whole take. In the review, the live transcript repeated "there's a return to
playback" at 6:07 and stood still for about 40 seconds in take 6. Replaying the live worker on take
4's audio with the old runtime showed why: updates were 22–35 s apart, so the first words appeared
after 30 s, and the speech between two 30-second windows (38–51 s) was never shown live.

- Evidence: `evidence/live-transcript-repeats.png`: take 4 at 0:37, the live box repeating its first
  sentence.
- Evidence: `evidence/live-transcript-stalls.png`: take 6 at 0:30, only its first sentence shown.
- Evidence: `evidence/transcribing-is-super-slow.png`, "transcribing is super slow … somehow we have
  a live's … transcribing, when I look at other software … it's way faster, and then the post
  processing is … also fairly slow" at 0:52–1:15.

## What changes

- While recording, speech is cut at pauses into stretches and each one is transcribed once with the
  language's model; at Stop only the last stretch is left: "The transcript is ready seconds after
  Stop", "Every spoken word appears once".
- Retry and `cue transcribe` still transcribe the whole take; takes without live audio are
  transcribed after Stop: "Retry transcribes the whole take again", "A take without live audio is
  transcribed after Stop".
- The words being spoken are re-guessed about every two seconds and shown greyed in the live box,
  below finished rows: "Live words follow the speaker", "Words still being heard are greyed in the
  live box".

## Settled questions

- **Q3 / Q8 Live latency**: "whisperflow can be the benchmark here. Ideally, similarly"; then about
  2 s. Rejected: about 5 s; keeping the 8 s pause.
- **Q5 One pass**: transcribe once, during recording; Retry still redoes the whole take. Rejected:
  keeping two passes, only faster.
- **Q7 GPU**: "If it is fast enough that there is nearly no post-processing time, I'm fine. If we
  still have 5+ seconds post processing time or so, I would investigate GPU usage." The 5 s bound
  is the scenario "The transcript is ready seconds after Stop".
- **Q11 Provisional words**: they look different from final ones.
- **Q17 Look**: A, finished stretches as ordinary rows and only the words still being heard greyed in
  the live box. Rejected: B, one row with the unsettled words in grey italics.
- **Q18 Technical design**: approved as in `design.md`.

## Calls for the owner

- A stretch ends at a pause of at least 0.6 s found by the bundled Silero detector; without one it is
  cut at the longest gap of at least 0.2 s, else at 30 s. A shorter pause would cut mid-sentence more
  often; a longer one would leave more for Stop.
- The words still being heard are guessed with base, not the language's model, because base is about
  three times faster per guess; they are replaced by the final words when their stretch ends.
- The stretches and their raw Whisper output are kept in the take folder (`stretches/`), as the
  whole-take output was.
- The vocabulary prompt applies to stretches and guesses as it did to both passes.

## Out of scope

- GPU transcription: only if the 5 s bound is missed (Q7).
- Device-audio-only takes (Android, Quest without a PC microphone): no PCM is recorded live, so they
  keep the after-Stop transcription.
