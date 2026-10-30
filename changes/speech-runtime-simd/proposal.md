---
title: Run the speech runtime built for the processor's vector instructions
capabilities:
  - transcription/speech-runtime
review: unreviewed
---
# Run the speech runtime built for the processor's vector instructions

## Why

Transcription is slow: the live words lag far behind and a five-minute take waits about a minute
and a half after Stop. The bundled whisper.cpp is built with AVX, AVX2, FMA and F16C turned off and
runs with 4 of the processor's threads, so on the owner's Ryzen 9 9950X (32 threads) one 30-second
window took 5 s to encode.

- Evidence: `evidence/transcribing-is-super-slow.png`, "transcribing is super slow … when I look at
  other software like [another dictation app] it's way faster, and then the post processing is …
  also fairly slow, takes quite some time especially for a longer session. We should really look
  into how we can do about the performance." at 0:52–1:15.

Measured on take 3 of that review (314 s of speech, `base` model, the app's decoding options,
alignment on), wall time:

| Build | Threads | Time |
|---|---|---|
| Bundled today (no AVX) | 4 | 101.8 s |
| AVX2, FMA, F16C | 4 | 13.1 s |
| AVX2, FMA, F16C | 8 | 8.9 s |
| AVX2, FMA, F16C | 16 | 8.3 s |

The live worker, replayed on take 4's audio with today's build and 2 threads, needed 22–35 s per
update; with the AVX2 build and 4 threads, 1.5–2.6 s.

## What changes

- The runtime folder holds a second build, for AVX2, FMA, F16C and BMI2, in its `avx2` subfolder on
  Windows and Linux x64, and the app runs it where the processor supports it: "A processor with
  AVX2 runs the fast build", "A processor without AVX2 runs the plain build".
- A recording with about five minutes of speech is transcribed in seconds: "Five minutes of speech
  is transcribed in seconds".
- Final transcription uses half the logical threads (at most 8, at least 4 where there are that
  many), live transcription a quarter (at most 4, at least 2): "Thread counts follow the
  processor".

## Settled questions

- **Q1 Model and language**: settled in later rounds and carried by the `speech-models` change;
  this change keeps the `base` model.
- **Q2 GPU**: no GPU in this change; "If we still have 5+ seconds post processing time or so, I
  would investigate GPU usage" (Q7), measured after `one-pass-transcription`. Rejected for now: a
  Vulkan build; a CUDA build (its runtime is too large to ship).
- **Q13 The three changes**: this one first, then `speech-models`, then `one-pass-transcription`.

## Calls for the owner

- Two builds side by side instead of one build that loads a processor-specific library at start
  (ggml's `GGML_CPU_ALL_VARIANTS`): the installer grows by about 4.4 MB on Windows and Linux;
  switching later changes only the build script and `deps.rs`.
- No `avx2` build on macOS: Apple Silicon has no AVX, and adding a signed nested build for Intel
  Macs is left alone; Intel Macs keep the plain build.
- Beam search stays at whisper-cli's default (5 beams): greedy decoding saved 10 % of the time on
  small.en but raised its word errors from 5.8 % to 7.1 %.
- The speech detector (`whisper-vad-speech-segments`) also runs from the `avx2` build where
  supported; its thread count stays at its default.

## Out of scope

- The model and the language: `speech-models`.
- Transcribing while recording, the live latency and the live loop: `one-pass-transcription`.
- GPU builds (Vulkan, CUDA, Metal) and other engines such as Parakeet.
