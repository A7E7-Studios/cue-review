# Tasks: Detect each take's language instead of assuming English

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. The language choice

- [ ] 1.1 The table of the speech model's 100 languages, and `language` as Auto or one of them, stored and read back; test: src-tauri/src/settings.rs::tests::every_language_of_the_speech_model_can_be_chosen
- [ ] 1.2 Decoding arguments take the language of the run instead of reading the settings; test: src-tauri/src/settings.rs::tests::a_chosen_language_is_used_without_detecting
- [ ] 1.3 A `get_languages` command for the app; test: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked

## 2. Models and downloads (after 1)

- [ ] 2.1 Any code but `en` maps to the multilingual small model; test: src-tauri/src/deps.rs::tests::english_uses_small_en_and_every_other_language_the_multilingual_model
- [ ] 2.2 The download loop fetches every model the choice needs, English first; test: src-tauri/src/deps.rs::tests::auto_fetches_both_small_models_english_first
- [ ] 2.3 `languageModels` in the setup status, the light poll and `cue setup`; test: src-tauri/src/models.rs::tests::the_language_models_are_reported_in_camel_case
- [ ] 2.4 Update README.md (`cue setup`) to state what the code does; test: node tools/gate/gate.mjs --local

## 3. Detecting and holding (after 1)

- [ ] 3.1 Run detection on a speech file and read the language and its probability from the log; test: src-tauri/src/transcribe.rs::tests::the_detected_language_is_read_from_the_log
- [ ] 3.2 The decision rule, provisional stretches and the likeliest-language fallback in `stretches.json` version 2; test: src-tauri/src/stretches.rs::tests::an_unconfident_guess_waits_for_more_speech
- [ ] 3.3 The live worker detects per stretch until decided, redoes provisional stretches in another language, and holds the take; test: src-tauri/src/stretches.rs::tests::a_detected_language_is_kept_for_the_rest_of_the_take
- [ ] 3.4 Whole-take passes detect from speech-only windows; the refine pass keeps the stretches' language; test: src-tauri/src/transcribe.rs::tests::each_take_is_detected_on_its_own
- [ ] 3.5 The ignored German test with a recorded sample; test: src-tauri/src/transcribe.rs::tests::actual_german_speech_is_detected_and_transcribed_as_german
- [ ] 3.6 Update docs/ARCHITECTURE.md (Local transcription) and docs/VERIFICATION.md to state what the code does; test: node tools/gate/gate.mjs --local

## 4. The language of a transcript (after 3)

- [ ] 4.1 `languageDetected` on the transcript and `language`, `languageDetected` on each take mark, through `takes.rs`; test: src-tauri/src/agent.rs::tests::the_transcript_reports_each_take_s_language
- [ ] 4.2 `cue transcribe` detects again under Auto; test: src-tauri/src/agent.rs::tests::transcribing_again_detects_the_language_again

## 5. The app (after 2 and 4, to the picked look)

- [ ] 5.1 Settings: Auto first, every language, the state of each needed model; test: src/dialogs/SettingsDialog.test.tsx
- [ ] 5.2 The transcript names each take's language; test: src/workspace/TranscriptPane.test.tsx::names each take's language and whether it was detected
- [ ] 5.3 Stories and fixtures for the new states, and the spec's looks rendered again; check: The transcript names a detected language
- [ ] 5.4 Update docs/DESIGN.md (Settings dialog, transcript) to state what the code does; test: npm test
