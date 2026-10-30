# Tasks: Record audio tracks without holes

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. AudioWriter (src-tauri/src/capture.rs)

- [x] 1.1 Write each packet back to back and split packets into runs at pauses over 50 ms; test: src-tauri/src/capture.rs::tests::drifting_jittering_audio_has_no_holes
- [x] 1.2 Streaming windowed-sinc resampler; test: src-tauri/src/capture.rs::tests::resampling_a_sine_keeps_its_amplitude_and_scales_its_frequency
- [x] 1.3 At stop, resample each run by the measured ratio and place it at its wall-clock start, exactly the take's length; test: src-tauri/src/capture.rs::tests::drifting_audio_is_resampled_to_the_take_length
- [x] 1.4 Keep real gaps as silence, an early gap and a long gap after a short run included; test: src-tauri/src/capture.rs::tests::a_gap_over_50_ms_stays_silence
- [x] 1.5 Mute writes silence of the same length; test: src-tauri/src/capture.rs::tests::muted_audio_is_silent_and_keeps_its_length
- [x] 1.6 A recording of speech on the owner's microphone sounds as clean as Ableton; check: A microphone whose clock drifts and jitters is recorded
- [x] 1.7 Update docs/ARCHITECTURE.md (how tracks are written) and docs/VERIFICATION.md (the unit tests); test: node tools/gate/gate.mjs --local
