---
title: Speech runtime
code:
  - scripts/build-speech-runtime.mjs
  - scripts/verify-bundle.mjs
  - src-tauri/src/deps.rs
  - src-tauri/src/transcribe.rs
---
# Speech runtime

## Purpose

The local speech engine that turns a recording's audio into words on the person's own computer:
which build of it runs and how much of the processor it may use.

## Requirements

### Requirement: The runtime uses the processor's vector instructions
The app SHALL run the speech runtime built for AVX2, FMA and F16C on a processor that has all
three, and the build without them on any other, because the build without them transcribes about
eight times slower, and the build with them cannot start on a processor that lacks them.

#### Scenario: A processor with AVX2 runs the fast build
- **GIVEN** a runtime folder holding both builds
- **WHEN** the app looks up the speech runtime on a processor with AVX2, FMA and F16C
- **THEN** it runs the build from the folder's `avx2` subfolder
- **PROOF** test: src-tauri/src/deps.rs::tests::the_vector_build_runs_where_the_processor_supports_it

#### Scenario: A processor without AVX2 runs the plain build
- **GIVEN** a runtime folder holding both builds
- **WHEN** the app looks up the speech runtime on a processor without AVX2, FMA or F16C
- **THEN** it runs the plain build
- **AND** a runtime folder without an `avx2` subfolder is used as it is
- **PROOF** test: src-tauri/src/deps.rs::tests::the_plain_build_runs_where_the_vector_build_cannot

#### Scenario: Five minutes of speech is transcribed in seconds
- **GIVEN** an installed build on a computer with a processor that has AVX2
- **WHEN** a recording with about five minutes of speech finishes and is transcribed
- **THEN** its transcript is ready in well under a minute, not the minute and a half it took with
  the plain build
- **PROOF** test: src-tauri/src/transcribe.rs::tests::actual_vector_build_is_faster_than_the_plain_build
- **PROOF** desk: open

### Requirement: Transcription uses a share of the processor that fits the job
The app SHALL give a final transcription half the processor's logical threads, from one to eight,
and the transcription it does while recording a quarter of them, from one to four, because more
than eight threads barely speed it up, and work done while recording runs beside the capture and
its encoder.

#### Scenario: Thread counts follow the processor
- **WHEN** a final or a live transcription starts on a processor with 2, 8 or 32 logical threads
- **THEN** a final transcription uses 1, 4 or 8 threads
- **AND** a live transcription uses 1, 2 or 4 threads
- **PROOF** test: src-tauri/src/transcribe.rs::tests::thread_counts_follow_the_processor
