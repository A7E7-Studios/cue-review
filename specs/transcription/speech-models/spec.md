---
title: Speech models
code:
  - src-tauri/src/deps.rs
  - src-tauri/src/settings.rs
  - src-tauri/src/models.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/transcribe.rs
  - src-tauri/src/stretches.rs
  - src-tauri/src/agent.rs
  - src-tauri/src/bin/cue.rs
  - src/backend.ts
  - src/dialogs/SettingsDialog.tsx
  - src/workspace/TranscriptPane.tsx
---
# Speech models

## Purpose

Which speech model turns a recording into words, in which language, and how the app gets that
model onto the computer without the person waiting for it.

## Requirements

### Requirement: Each take is transcribed in its own language with that language's model
The app SHALL, while the language in Settings is Auto, which it is until a person chooses another,
detect each take's language from its first speech, hold the take to it once a guess is confident,
and transcribe it with that language's model: small.en for English and the multilingual small
model for every other language, because a recording in another language than the one assumed comes
out as nonsense, the small models make far fewer mistakes than base (5.8 % against 14.6 % of the
words of a five-minute review), and a take held to one language never switches language mid-way on
short or noisy audio. A language chosen in Settings is used for every take without detecting.

#### Scenario: A German take is transcribed as German without a setting
- **GIVEN** no language has been chosen and both small models are installed
- **WHEN** a take with German speech is recorded and transcribed
- **THEN** the multilingual small model transcribes it, held to German, while it records and after
  Stop
- **PROOF** test: src-tauri/src/settings.rs::tests::a_take_is_held_to_its_detected_language
- **PROOF** test: src-tauri/src/transcribe.rs::tests::actual_german_speech_is_detected_and_transcribed_as_german
- **PROOF** desk: open

#### Scenario: An English take stays on small.en
- **GIVEN** no language has been chosen and both small models are installed
- **WHEN** a take with English speech is transcribed
- **THEN** small.en transcribes it, held to English
- **PROOF** test: src-tauri/src/deps.rs::tests::english_uses_small_en_and_every_other_language_the_multilingual_model
- **PROOF** test: src-tauri/src/settings.rs::tests::a_take_is_held_to_its_detected_language

#### Scenario: A take keeps the language it started in
- **GIVEN** a take whose language has been detected
- **WHEN** later speech in it is short, noisy or in another language
- **THEN** the take is still transcribed in the detected language
- **PROOF** test: src-tauri/src/stretches.rs::tests::a_detected_language_is_kept_for_the_rest_of_the_take

#### Scenario: An unclear start does not decide the language
- **GIVEN** a take that starts with noise or a few unclear words, which no guess is confident about
- **WHEN** clear German speech follows
- **THEN** the whole take is transcribed as German, the words before the clear speech included
- **AND** a take that ends before any guess is confident is transcribed in the likeliest language
  heard
- **PROOF** test: src-tauri/src/stretches.rs::tests::an_unconfident_guess_waits_for_more_speech
- **PROOF** test: src-tauri/src/stretches.rs::tests::a_take_without_a_confident_guess_uses_the_likeliest_language

#### Scenario: Each take has its own language
- **GIVEN** a session whose first take is in German
- **WHEN** the person records more, speaking English
- **THEN** the first take stays German and the new take is transcribed as English
- **PROOF** test: src-tauri/src/transcribe.rs::tests::each_take_is_detected_on_its_own
- **PROOF** desk: open

#### Scenario: A chosen language is used without detecting
- **GIVEN** a language other than Auto is chosen in Settings and its model is installed
- **WHEN** a recording is transcribed, or an earlier one is transcribed again with Retry
- **THEN** that language's model transcribes every take, held to the chosen language, whatever is
  spoken
- **PROOF** test: src-tauri/src/settings.rs::tests::a_chosen_language_is_used_without_detecting
- **PROOF** test: src-tauri/src/deps.rs::tests::english_uses_small_en_and_every_other_language_the_multilingual_model
- **PROOF** desk: open

#### Scenario: Transcribing again detects the language again
- **GIVEN** the language is Auto and a take whose transcript was made in another language than it
  is spoken in
- **WHEN** the person chooses Retry, or `cue transcribe` runs
- **THEN** the take's language is detected from its audio again and its transcript is made in that
  language
- **PROOF** test: src-tauri/src/agent.rs::tests::transcribing_again_detects_the_language_again
- **PROOF** test: src-tauri/src/transcribe.rs::tests::a_whole_take_pass_detects_under_auto_and_never_under_a_chosen_language
- **PROOF** desk: open

### Requirement: The models the language needs arrive in the background
The app SHALL download the models its language needs by itself whenever one is missing, both small
models for Auto and otherwise the chosen language's model, check each one's SHA-256 before using
it, and transcribe with the installed base model held to the take's language until its model is
ready, because the person should never have to wait for or start a download before recording.

#### Scenario: An upgraded app fetches the models by itself
- **GIVEN** an installation that lacks a model its language needs
- **WHEN** the app starts
- **THEN** it downloads each missing model in the background, the English one first, while
  recordings and transcription keep working with base
- **AND** the next transcription after a model's download finishes uses that model
- **PROOF** test: src-tauri/src/deps.rs::tests::a_missing_language_model_falls_back_to_base
- **PROOF** test: src-tauri/src/deps.rs::tests::auto_fetches_both_small_models_english_first
- **PROOF** desk: open

#### Scenario: Choosing German fetches the German model
- **GIVEN** the German model is not installed
- **WHEN** the person chooses German in Settings
- **THEN** the German model downloads in the background, and Settings shows its progress
- **AND** a download of the English model still running stops and the German one follows
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::shows the language model's download progress
- **PROOF** test: src-tauri/src/deps.rs::tests::a_language_chosen_during_a_download_gets_its_model
- **PROOF** desk: open

#### Scenario: A damaged download is never used
- **WHEN** a model download ends with the wrong size or SHA-256, or is cut off
- **THEN** the partial file is removed, transcription stays on base, and Settings says in a plain
  sentence that the download failed and offers to try again
- **PROOF** test: src-tauri/src/deps.rs::tests::a_damaged_model_download_is_discarded
- **PROOF** test: src-tauri/src/deps.rs::tests::the_download_state_follows_the_fetch
- **PROOF** test: src-tauri/src/deps.rs::tests::download_failures_are_said_plainly_and_partial_files_swept
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::offers to retry a failed model download

### Requirement: Settings shows the language and its models
Settings SHALL let the person choose Auto or any language the speech model knows, and show whether
the models that choice needs are ready, downloading with their progress, or failed, because the
quality of the transcript depends on them, the person otherwise cannot tell why a transcript came
out worse, and a fixed language is the remedy when Auto guesses wrong.

#### Scenario: The models are ready
- **GIVEN** every model the chosen language needs is installed
- **WHEN** the person opens Settings
- **THEN** Settings shows the language and that its models are ready
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::shows the chosen language and its ready models
- **PROOF** desk: open

#### Scenario: Settings offers Auto and every language
- **WHEN** the person opens the language list in Settings
- **THEN** it offers Auto first, then English and German, then every other language the speech
  model knows by its English name in alphabetical order
- **AND** Auto is the one shown as chosen until the person chooses another
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::offers Auto first and every language the speech model knows
- **PROOF** test: src-tauri/src/settings.rs::tests::every_language_of_the_speech_model_can_be_chosen
- **PROOF** desk: open

### Requirement: The transcript says which language each take is in
The app SHALL show each take's language with its transcript, marked as detected when Auto found
it, and `cue transcript` SHALL report it, because a transcript made in the wrong language otherwise
reads like bad hearing and neither the person nor the agent can tell what to change.

#### Scenario: The transcript names a detected language
- **GIVEN** a take that Auto transcribed as German
- **WHEN** its transcript is shown
- **THEN** the take's transcript is marked "German, detected"
- **AND** a take transcribed in a language chosen in Settings is marked with that language alone
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::names each take's language and whether it was detected
- **PROOF** desk: open

#### Scenario: An agent reads each take's language
- **GIVEN** a session with a German take and an English take
- **WHEN** an agent runs `cue transcript` for it as JSON
- **THEN** each take carries its language code and whether it was detected
- **PROOF** test: src-tauri/src/agent.rs::tests::the_transcript_reports_each_take_s_language

### Requirement: The CLI installs and reports the language's models
`cue setup --install` SHALL also download every model the chosen language needs, and `cue setup`
SHALL report them as `languageModels`, because an agent setting up a computer without the app needs
the same transcripts the app makes.

#### Scenario: An agent installs transcription from the CLI
- **GIVEN** a computer without the speech tools and models, and the app closed
- **WHEN** an agent runs `cue setup --install`
- **THEN** the tools, base and every model the chosen language needs are installed, and `cue setup`
  reports each of them under `languageModels` with `state` `ready`
- **PROOF** test: src-tauri/src/models.rs::tests::the_language_models_are_reported_in_camel_case
- **PROOF** desk: open
