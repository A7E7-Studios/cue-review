---
title: Transcribe a take while it is recorded and refine it after Stop
capabilities:
  - transcription/live-transcription
review: unreviewed
---
# Transcribe a take while it is recorded and refine it after Stop

## Why

Every take was transcribed twice, and both passes kept the person waiting. While recording, a
preview re-transcribed the last 30 seconds every 8 seconds, so the live words came late. After
Stop, the whole take was transcribed again before its transcript showed. In the review, the live
transcript repeated "there's a return to playback" at 6:07 and stood still for about 40 seconds in
take 6.

Replaying the live worker on take 4's audio with the old runtime showed why. Updates were 22–35 s
apart, so the first words appeared after 30 s, and the speech between two 30-second windows
(38–51 s) was never shown live.

- Evidence: `evidence/live-transcript-repeats.png`: take 4 at 0:37, the live box repeating its first
  sentence.
- Evidence: `evidence/live-transcript-stalls.png`: take 6 at 0:30, only its first sentence shown.
- Evidence: `evidence/transcribing-is-super-slow.png`, "transcribing is super slow … somehow we have
  a live's … transcribing, when I look at other software … it's way faster, and then the post
  processing is … also fairly slow" at 0:52–1:15.

Measured by replaying take 3 of the review (314 s, small.en, AVX2 runtime) through the new worker in
real time (`stretches::tests::actual_replay_*`):

| | Before (two passes, base) | Now |
|---|---|---|
| Words shown live after they are said (median, 90th percentile) | about 30 s and more | 2.7–3.2 s, 8–13 s |
| Transcript ready after Stop | 102 s (old runtime), 23 s (small.en, AVX2) | 2.5–3.3 s |
| Word errors of the transcript at Stop | 5.8–12.0 % (whole-take pass) | 9.9–15.9 % (stretches) |
| Word errors once refined | — | as a whole-take pass, about 30 s after Stop for 5 minutes |

## What changes

- While recording, speech is cut at pauses into stretches of 10–30 s, and each one is transcribed
  once with the language's model. At Stop only the rest is left: "The transcript is ready seconds
  after Stop", "Every spoken word appears once".
- After Stop, a take made from stretches is transcribed whole in the background and its words are
  replaced: "The words improve shortly after Stop".
- Retry and `cue transcribe` still transcribe the whole take. Takes without live audio are
  transcribed after Stop: "Retry transcribes the whole take again", "A take without live audio is
  transcribed after Stop".
- The words being spoken are guessed about every second and shown greyed in the live box, below
  finished rows: "Live words follow the speaker", "Words still being heard are greyed in the live
  box".

## Settled questions

- **Q3 / Q8 Live latency**: "whisperflow can be the benchmark here. Ideally, similarly", then about
  2 s. Rejected: about 5 s; keeping the 8 s pause.
- **Q5 One pass**: transcribe during recording; Retry still redoes the whole take. Rejected: keeping
  two passes, only faster.
- **Q7 GPU**: "If it is fast enough that there is nearly no post-processing time, I'm fine. If we
  still have 5+ seconds post processing time or so, I would investigate GPU usage." Stop now takes
  about 3 s, so no GPU work follows.
- **Q11 Provisional words**: they look different from final ones.
- **Q17 Look**: A, finished stretches as ordinary rows and only the words still being heard greyed in
  the live box. Rejected: B, one row with the unsettled words in grey italics.
- **Q18 Technical design**: approved as first drawn. The refinement after Stop and the stretch
  lengths below were added while the owner was away, as calls.

## Calls for the owner

The owner was away for these; each was taken on the measurements above.

- **Refining after Stop.** Stretches cost accuracy. On take 3, the transcript at Stop missed 9.9–15.9 %
  of words over seven replays. A whole-take pass missed 5.8–12.0 % with its start moved by 0–500 ms,
  about 8 % on average. Whisper skips a phrase depending on where its windows fall, and stretches
  give it more such places. So a take made from stretches is transcribed whole once more in the
  background and its words are replaced. The person reads a transcript within about 3 s and the
  better one about 30 s later for 5 minutes. A new recording, Retry or a delete stops the
  refinement and keeps the transcript from Stop. Without it Stop is just as fast, but the words stay
  about 4 points worse.
- **Stretch length.** A stretch is cut only once 28 s wait, at the last pause between 10 and 30 s.
  Cutting at 20 s gave 8.6 % word errors offline, at 28 s 6.6 %. Stop then has at most about 30 s
  left, about 3 s on the reference PC.
- **Live words in about 3 s, not 2.** Every second the worker guesses with base (one beam, no
  alignment points, which a guess shown while recording never needs). The median delay is
  2.7–3.2 s, and it reaches 8–13 s right after a stretch is finished, which takes about 2.5 s
  with small.en on 4 threads. Getting closer to 2 s needs more threads while recording or a GPU.
- **Silence.** Audio without speech is skipped only once 28 s of it wait, keeping its last second:
  skipping 2 s of supposed silence cut off words the detector had not yet found at the very end of
  a copy.
- The stretches and their raw Whisper output are kept in the take folder (`stretches/`), as the
  whole-take output was. Refining forgets the stretches and keeps their raw output.
- The vocabulary prompt applies to stretches, guesses and refinement as it did to both passes.

## Out of scope

- GPU transcription.
- Device-audio-only takes (Android, Quest without a PC microphone): no PCM is recorded live, so they
  keep the after-Stop transcription.
