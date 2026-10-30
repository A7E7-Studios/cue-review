---
title: Speech models
code:
  - src-tauri/src/deps.rs
  - src-tauri/src/settings.rs
  - src-tauri/src/models.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/transcribe.rs
  - src/backend.ts
  - src/dialogs/SettingsDialog.tsx
---
# Speech models

## Purpose

Which speech model turns a recording into words, in which language, and how the app gets that
model onto the computer without the person waiting for it.

## Requirements

### Requirement: The transcript is made in the chosen language with its model
The app SHALL transcribe in the language chosen in Settings, English by default or German, with
that language's model: small.en for English and the multilingual small model held to German for
German, because the small models make far fewer mistakes than base (5.8 % against 14.6 % of the
words of a five-minute review) and a model held to one language never switches language mid-way.

#### Scenario: English is the default
- **GIVEN** no language has been chosen
- **WHEN** a recording is transcribed and its English model is installed
- **THEN** small.en transcribes it, held to English
- **PROOF** test: src-tauri/src/deps.rs::tests::english_uses_small_en_by_default
- **PROOF** test: src-tauri/src/settings.rs::tests::decoding_is_held_to_the_chosen_language

#### Scenario: Choosing German transcribes German speech
- **GIVEN** German is chosen in Settings and the German model is installed
- **WHEN** a recording is transcribed, or an earlier one is transcribed again with Retry
- **THEN** the multilingual small model transcribes it, held to German
- **PROOF** test: src-tauri/src/deps.rs::tests::german_uses_the_multilingual_small_model
- **PROOF** desk: open

### Requirement: The chosen language's model arrives in the background
The app SHALL download the chosen language's model by itself whenever it is missing, check its
SHA-256 before using it, and transcribe with the installed base model held to the chosen language
until it is ready, because the person should never have to wait for or start a download before
recording.

#### Scenario: An upgraded app fetches the English model by itself
- **GIVEN** an installation that has only the base model
- **WHEN** the app starts
- **THEN** it downloads small.en in the background while recordings and transcription keep working
  with base
- **AND** the next transcription after the download finishes uses small.en
- **PROOF** test: src-tauri/src/deps.rs::tests::a_missing_language_model_falls_back_to_base
- **PROOF** desk: open

#### Scenario: Choosing German fetches the German model
- **GIVEN** the German model is not installed
- **WHEN** the person chooses German in Settings
- **THEN** the German model downloads in the background, and Settings shows its progress
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::shows the language model's download progress
- **PROOF** desk: open

#### Scenario: A damaged download is never used
- **WHEN** a model download ends with the wrong size or SHA-256, or is cut off
- **THEN** the partial file is removed, transcription stays on base, and Settings says the download
  failed and offers to try again
- **PROOF** test: src-tauri/src/deps.rs::tests::a_damaged_model_download_is_discarded
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::offers to retry a failed model download

### Requirement: Settings shows the language and its model
Settings SHALL let the person choose English or German and show whether that language's model is
ready, downloading with its progress, or failed, because the quality of the transcript depends on
it and the person otherwise cannot tell why a transcript came out worse.

#### Scenario: The model is ready
- **GIVEN** the chosen language's model is installed
- **WHEN** the person opens Settings
- **THEN** Settings shows the language and that its model is ready
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::shows the chosen language and its ready model
- **PROOF** desk: open
