---
title: Speech runtime
review: unreviewed
code:
  - scripts/build-speech-runtime.mjs
  - scripts/package.mjs
  - scripts/verify-bundle.mjs
  - src-tauri/src/deps.rs
  - src-tauri/src/transcribe.rs
  - src-tauri/src/settings.rs
  - src-tauri/src/models.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/bin/cue.rs
  - src/backend.ts
  - src/dialogs/SettingsDialog.tsx
---
# Speech runtime

## Summary

The local speech engine that turns a recording's audio into words on your own computer: which build
of it runs, whether on the processor or a graphics card, and how much of the processor it may use.
You meet it in how soon a transcript is ready, and in Settings, which names where transcription runs
and can keep it off the graphics card.

## Requirements

### Requirement: The runtime uses the processor's vector instructions
The app SHALL run the speech runtime built for AVX2, FMA, F16C and BMI2 on a processor that has
all four, and the build without them on any other, because the build without them transcribes
about eight times slower, and the build with them cannot run on a processor that lacks them.

#### Scenario: A processor with AVX2 runs the fast build
- **GIVEN** a runtime folder holding both builds
- **WHEN** the app looks up the speech runtime on a processor with AVX2, FMA, F16C and BMI2
- **THEN** it runs the build from the folder's `avx2` subfolder
- **PROOF** test: src-tauri/src/deps.rs::tests::the_vector_build_runs_where_the_processor_supports_it

#### Scenario: A processor without AVX2 runs the plain build
- **GIVEN** a runtime folder holding both builds
- **WHEN** the app looks up the speech runtime on a processor without AVX2, FMA, F16C or BMI2
- **THEN** it runs the plain build
- **AND** a runtime folder without an `avx2` subfolder is used as it is
- **PROOF** test: src-tauri/src/deps.rs::tests::the_plain_build_runs_where_the_vector_build_cannot

#### Scenario: Five minutes of speech is transcribed in seconds
- **GIVEN** an installed build on a computer with a processor that has AVX2
- **WHEN** a recording with about five minutes of speech finishes and is transcribed
- **THEN** its transcript is ready at least three times sooner than the plain build makes it
- **PROOF** test: src-tauri/src/transcribe.rs::tests::actual_vector_build_is_faster_than_the_plain_build

### Requirement: Transcription uses a share of the processor that fits the job
The app SHALL give a final transcription half the processor's logical threads, at most eight and at
least four where the processor has them, and the transcription it does while recording a quarter, at
most four and at least two where the processor has them, and SHALL transcribe the two tracks of a
take recorded with a microphone and system audio at the same time, each with a final transcription's
threads where the processor has eight or more and with half the processor's threads below that, each
keeping at least one, because more than eight threads barely speed it up, work done while recording
runs beside the capture and its encoder, a small processor must not get fewer threads than whisper's
own defaults, two tracks one after the other keep the person waiting after Stop, when nothing is
captured any more, and together they must not ask for more threads than a processor with two or more
has.

#### Scenario: Thread counts follow the processor
- **WHEN** a final or a live transcription starts on a processor with 2, 4, 8 or 32 logical threads
- **THEN** a final transcription uses 2, 4, 4 or 8 threads
- **AND** a live transcription uses 2, 2, 2 or 4 threads
- **AND** each of the two tracks of a take with both uses 1, 2, 4 or 8 threads in its final
  transcription
- **PROOF** test: src-tauri/src/transcribe.rs::tests::thread_counts_follow_the_processor

### Requirement: Transcription runs on the fastest device of the computer
The app SHALL, on Windows, time a short speech sample once on each graphics card and on the
processor, and transcribe on whichever was fastest, while recording and after Stop, because a fast
graphics card transcribes several times sooner than the processor (ten minutes of German in 15 s
against 57 s) while a weak integrated one is slower than it (148 s).

#### Scenario: A fast graphics card transcribes
- **GIVEN** a computer whose graphics card measured faster than its processor
- **WHEN** a take is transcribed, while it records or after Stop
- **THEN** the transcription runs on that graphics card
- **PROOF** test: src-tauri/src/deps.rs::tests::the_fastest_measured_device_transcribes
- **PROOF** test: src-tauri/src/transcribe.rs::tests::actual_graphics_card_transcribes_and_keeps_word_timing

#### Scenario: A slow graphics card is left alone
- **GIVEN** a computer whose only graphics card measured slower than its processor
- **WHEN** a take is transcribed
- **THEN** the transcription runs on the processor, as fast as it does today
- **PROOF** test: src-tauri/src/deps.rs::tests::the_fastest_measured_device_transcribes

#### Scenario: The devices are measured once, in the background
- **GIVEN** the first start after an install or update, or after the graphics card or its driver
  changed
- **WHEN** the app starts
- **THEN** it measures the devices in the background while recording and transcription keep working
  on the processor
- **AND** later starts use the saved result without measuring again
- **PROOF** test: src-tauri/src/deps.rs::tests::devices_are_measured_again_only_when_the_computer_changed

#### Scenario: A computer without a usable graphics card works as before
- **GIVEN** a computer without a graphics card the speech runtime can use, or without the graphics
  build of the runtime
- **WHEN** the app starts and a take is transcribed
- **THEN** the transcription runs on the processor with the build its processor supports, and
  nothing reports an error
- **PROOF** test: src-tauri/src/deps.rs::tests::no_usable_graphics_card_means_the_processor_build

### Requirement: A graphics-card failure never costs a transcript
The app SHALL transcribe the same audio again on the processor when a run on the graphics card
fails or turns out not to have used the card, and keep to the processor until the devices are
measured again, because graphics drivers crash in ways the app cannot foresee and a take must not
lose its transcript to one.

#### Scenario: A failed graphics-card run is repeated on the processor
- **GIVEN** a computer that transcribes on its graphics card
- **WHEN** a transcription on the graphics card crashes or ends with an error
- **THEN** the same audio is transcribed on the processor and the take gets its transcript
- **AND** the transcriptions after it run on the processor
- **PROOF** test: src-tauri/src/transcribe.rs::tests::a_failed_graphics_card_run_is_repeated_on_the_processor

### Requirement: The person sees where transcription runs and can keep it off the graphics card
Settings SHALL name the device transcription runs on and offer a switch that keeps it on the
processor, and `cue setup` SHALL report the device, because transcribing on the graphics card can
disturb a game or headset app under review, and the person needs to see and undo that.

#### Scenario: Settings names the device
- **GIVEN** a computer that transcribes on its graphics card
- **WHEN** the person opens Settings
- **THEN** Settings names that graphics card as the device transcription runs on
- **AND** on a computer that transcribes on the processor it names the processor
- **AND** after a run on the graphics card failed, it says that the card stopped and the processor
  transcribes
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::names the device transcription runs on

#### Scenario: The switch keeps transcription on the processor
- **GIVEN** a computer that transcribes on its graphics card
- **WHEN** the person turns the graphics card off for transcription in Settings
- **THEN** every transcription from then on runs on the processor, while recording too, and the
  choice is kept across restarts
- **PROOF** test: src-tauri/src/deps.rs::tests::the_switch_keeps_transcription_on_the_processor
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::turns the graphics card off for transcription

#### Scenario: The person has the graphics card tested again
- **GIVEN** a computer that keeps to the processor because a run on its graphics card failed
- **WHEN** the person chooses "Test the graphics card again" in Settings
- **THEN** the devices are measured again in the background, and transcription returns to the
  graphics card when it measures fastest
- **PROOF** test: src-tauri/src/deps.rs::tests::a_failed_graphics_card_is_used_again_after_a_new_measurement
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::asks for the graphics card to be tested again

#### Scenario: An agent reads the device
- **WHEN** an agent runs `cue setup`
- **THEN** the output names the device transcription runs on and whether it is a graphics card
- **PROOF** test: src-tauri/src/models.rs::tests::the_transcription_device_is_reported_in_camel_case
