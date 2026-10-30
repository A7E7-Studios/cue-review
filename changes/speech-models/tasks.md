# Tasks: Transcribe with the small model of the chosen language

## 1. Models and language in the backend

- [ ] 1.1 `language` in `Settings`, read as English when absent; test: src-tauri/src/settings.rs::tests::decoding_is_held_to_the_chosen_language
- [ ] 1.2 The model table and the model per language; test: src-tauri/src/deps.rs::tests::english_uses_small_en_by_default
- [ ] 1.3 German uses the multilingual small model; test: src-tauri/src/deps.rs::tests::german_uses_the_multilingual_small_model
- [ ] 1.4 Base until the language's model is installed; test: src-tauri/src/deps.rs::tests::a_missing_language_model_falls_back_to_base
- [ ] 1.5 Final and live runs held to the language with the model's alignment preset; test: cargo test --lib transcribe::
- [ ] 1.6 Update docs/ARCHITECTURE.md (Local transcription); test: node tools/gate/gate.mjs --local

## 2. The background download (after 1)

- [ ] 2.1 Download to `.download`, check size and SHA-256, rename; discard otherwise; test: src-tauri/src/deps.rs::tests::a_damaged_model_download_is_discarded
- [ ] 2.2 Start at app start and on a language change; `languageModel` in setup status; `download_language_model`; check: An upgraded app fetches the English model by itself
- [ ] 2.3 `cue setup --install` fetches the language model; test: cargo test --lib cli::
- [ ] 2.4 Update README.md (Install transcription); test: node tools/gate/gate.mjs --local

## 3. Settings (after 2)

- [ ] 3.1 The Transcription section: Language and the model's state; test: src/dialogs/SettingsDialog.test.tsx::shows the chosen language and its ready model
- [ ] 3.2 Progress while downloading, polled each second; test: src/dialogs/SettingsDialog.test.tsx::shows the language model's download progress
- [ ] 3.3 Failure with Try again; test: src/dialogs/SettingsDialog.test.tsx::offers to retry a failed model download
- [ ] 3.4 Stories for ready, downloading and failed; test: npm run build-storybook
- [ ] 3.5 German in Settings and a German recording; check: Choosing German transcribes German speech
- [ ] 3.6 Update README.md (Settings) and docs/DESIGN.md (Settings dialog); test: node tools/gate/gate.mjs --local
