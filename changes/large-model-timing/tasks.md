# Tasks: Judge the larger model by its transcribing time, not its loading

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. The larger model's timing

- [ ] 1.1 Read a run's time spent transcribing from the timings `whisper-cli` logs at its end, its whole time without them; test: src-tauri/src/deps.rs::tests::loading_the_larger_model_does_not_count_against_it
- [ ] 1.2 Save the processor's transcribing time and judge the larger model's against it; test: src-tauri/src/deps.rs::tests::loading_the_larger_model_does_not_count_against_it
- [ ] 1.3 Measure again a saved measurement without the processor's transcribing time; test: src-tauri/src/deps.rs::tests::a_measurement_without_transcribing_times_is_made_again
- [ ] 1.4 The ignored test on a real graphics card picks Large on this PC; test: src-tauri/src/transcribe.rs::tests::actual_graphics_card_transcribes_and_keeps_word_timing
- [ ] 1.5 On this PC with Large chosen, `cue setup` reports `largeInUse: true`; check: Loading the larger model does not count against it
- [ ] 1.6 Update docs/ARCHITECTURE.md (The device) and docs/VERIFICATION.md to state what the code does; test: node tools/gate/gate.mjs --local
