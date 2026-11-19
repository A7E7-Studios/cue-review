# Tasks: Transcribe on the graphics card where it is faster

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. The Vulkan build and the bundle

- [x] 1.1 The build script builds the `vulkan` variant with Ninja in a short directory when the SDK is present, copies `jfk.wav`, and fails with `--require-vulkan` without the SDK; test: node scripts/build-speech-runtime.mjs --require-vulkan
- [x] 1.2 The bundle carries and verifies the variant and the sample on Windows x64; test: node scripts/verify-bundle.mjs
- [ ] 1.3 The Windows job installs the pinned Vulkan SDK and passes `--require-vulkan`; test: the pull request's `check windows-x64` job
- [x] 1.4 Update README.md (building the runtime, installer size) to state what the code does; test: node tools/gate/gate.mjs --local

## 2. Measuring and choosing the device (after 1)

- [x] 2.1 Read the device lines and the backend line from a Vulkan log; test: src-tauri/src/deps.rs::tests
- [x] 2.2 Measure the sample on the processor and on each card, rank, and save `speech-device.json`; test: src-tauri/src/deps.rs::tests::the_fastest_measured_device_transcribes
- [x] 2.3 Measure again only when the app, the runtime or the display adapters and drivers changed, or on request; a recording cancels it; test: src-tauri/src/deps.rs::tests::devices_are_measured_again_only_when_the_computer_changed
- [x] 2.4 The switch and a computer without a usable card; test: src-tauri/src/deps.rs::tests::the_switch_keeps_transcription_on_the_processor
- [x] 2.5 `speechDevice` in the setup status, the light poll, `test_speech_devices` and `cue setup`; test: src-tauri/src/models.rs::tests::the_transcription_device_is_reported_in_camel_case

## 3. Running on the device (after 2)

- [x] 3.1 Stretches and whole-take passes run on the chosen device; detection, the guess, the token probe and the detector stay on the processor build; test: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
- [x] 3.2 A failed run is repeated on the processor and the card marked as stopped; a new measurement brings it back; test: src-tauri/src/transcribe.rs::tests::a_failed_graphics_card_run_is_repeated_on_the_processor
- [x] 3.3 The ignored test on a real graphics card; test: src-tauri/src/transcribe.rs::tests::actual_graphics_card_transcribes_and_keeps_word_timing
- [x] 3.4 Update docs/ARCHITECTURE.md (Local transcription) and docs/VERIFICATION.md to state what the code does; test: node tools/gate/gate.mjs --local

## 4. The large model (after 2)

- [x] 4.1 The model's entry, its download when Large is chosen, and `model` in the settings; test: src-tauri/src/deps.rs::tests::the_larger_model_transcribes_every_language_once_installed
- [x] 4.2 The two-thirds rule, the timing with Large after its download, and Large never on the processor; test: src-tauri/src/deps.rs::tests::the_larger_model_never_runs_on_the_processor
- [x] 4.3 Standard goes back to the small models; test: src-tauri/src/deps.rs::tests::standard_goes_back_to_the_small_models

## 5. Settings (after 2 and 4, to the picked look)

- [x] 5.1 A switch component in `src/ui/`; test: npm test
- [x] 5.2 The Model select, the model rows that follow it, and the folded "Runs on" line with the switch and "Test the graphics card again", in every drawn state; test: src/dialogs/SettingsDialog.test.tsx
- [x] 5.3 Stories and fixtures for the states, and the spec's looks rendered; check: Settings names the device
- [x] 5.4 Update docs/DESIGN.md (the switch, Settings) to state what the code does; test: npm test
