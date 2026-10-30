---
title: Transcribe with the small model of the chosen language
capabilities:
  - transcription/speech-models
review: unreviewed
---
# Transcribe with the small model of the chosen language

## Why

The base model mishears too much for a review an agent works from: "take free" for Take 3,
"fun size" for font size, "claw depth" for the Claude app. Normalising the audio did not change
take 3's text, so the model is the cause. The app also detects the language anew for every
recording and every live snapshot, and offers no way to transcribe German.

- Evidence: `evidence/settings-and-misheard-words.png`, the Settings dialog at 4:02 beside the live
  transcript reading "the fun size" (font size, 1:24) and "take free" (Take 3, 2:34), and the
  owner's words: "the vocabulary, I mean … not sure how helpful it is to have to enter this
  manually. But yeah, I'm not sure what the best way it would be for this."

Measured on take 3 of the review (314 s of the owner's English), with the AVX2 runtime and 8
threads, against a hand-corrected reference:

| Model | Size | Time | Word errors |
|---|---|---|---|
| base, language detected (today) | 148 MB | 8.9 s | 14.6 % |
| base.en | 148 MB | 8.7 s | 10.5 % |
| small, held to English | 488 MB | 22.8 s | 9.9 % |
| small.en | 488 MB | 23.4 s | 5.8 % |
| large-v3-turbo (CPU) | 1.6 GB | 87.6 s | 6.9 % |

## What changes

- English transcripts come from small.en and German ones from the multilingual small model held to
  German: "English is the default", "Choosing German transcribes German speech".
- The chosen language's model downloads by itself, hash-checked, while base keeps transcribing:
  "An upgraded app fetches the English model by itself", "Choosing German fetches the German model",
  "A damaged download is never used".
- Settings gets a Language choice and the model's state: "The model is ready".

## Settled questions

- **Q1 / Q6 Model and language**: "we prepare it to support different models. So you can switch to
  German and download the German model. For a start English and German are sufficient. 488MB is
  fine if we get better quality out of it." small.en for English. Rejected: base.en; keeping base
  with the language detected; large-v3-turbo on CPU.
- **Q4 Vocabulary**: leave the manual vocabulary as it is. Rejected: adding the recorded app's and
  section's names automatically; context terms only; removing it. A prompt of "CueReview, Claude,
  take" fixed "Claude app" but changed other words, with no gain overall.
- **Q9 Download**: in the background after the upgrade, hash-checked, base until it is ready, the
  progress in Settings. Rejected: a button in Settings; bundling the model in the installer.
- **Q10 Language choice**: in Settings, for the whole app; choosing German downloads the German
  model; new recordings and Retry use it. Rejected: a choice per recording in the dock.
- **Q12 German model**: the multilingual small model held to German. Rejected: multilingual medium
  (1.5 GB, about three times slower).
- **Q14 Look**: a Transcription section above Vocabulary (`look.md`). Rejected: the language inline
  in Recording tools.
- **Q15 Technical design**: approved as in `design.md`.
- **Q13 The three changes**: `speech-runtime-simd`, then this one, then `one-pass-transcription`.

## Calls for the owner

- Base stays installed and transcribes the live words while recording, held to the chosen language,
  because small takes about twice as long per update; `one-pass-transcription` decides the live
  model anew. Removing base would save 148 MB.
- The models come from the same pinned Hugging Face revision as base, each with its size and
  SHA-256 in the code; the download resumes from nothing after a failure (no partial resume).
- The download starts at app start and when German is chosen, one model at a time; a running
  recording does not pause it.
- Transcripts that already exist are not transcribed again on their own; Retry or `cue transcribe`
  does it with the new model.
- `CUEREVIEW_MODEL` and `CUEREVIEW_DTW_MODEL` still override the model for tests and experiments.

## Out of scope

- GPU builds and larger models: after `one-pass-transcription` is measured (Q7).
- Languages other than English and German.
- The vocabulary field, which stays as it is.
