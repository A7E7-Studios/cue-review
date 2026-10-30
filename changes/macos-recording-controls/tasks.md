# Tasks: Start buffered recordings and close pickers on a second click

## 1. FFmpeg recording startup

- [x] 1.1 Reproduce buffered startup with real static and moving synthetic FFmpeg sources, sharing production output arguments and readiness; test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video
- [x] 1.2 Flush recording output without changing scrcpy, and verify shutdown, decoded frames and failed-start cleanup; test: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
- [x] 1.3 Assess the nearest README and document startup flushing in architecture; test: node tools/gate/gate.mjs --local

## 2. Source and microphone picker toggles

- [x] 2.1 Reproduce WebKit's blur/click ordering and make both triggers focusable in draft and review; test: scripts/verify-picker-toggle.cjs
- [x] 2.2 Verify repeated clicks, switching, Escape, Tab and outside dismissal in WebKit and Chromium without capture; test: scripts/verify-picker-toggle.cjs
- [x] 2.3 Assess the nearest README and document the browser regression script; test: node tools/gate/gate.mjs --local

## 3. Verification and handoff

- [ ] 3.1 Run the frontend, Rust and relevant integration suites and strict gate; test: docs/VERIFICATION.md
- [ ] 3.2 Complete independent review, resolve findings and run final checks; test: node tools/gate/gate.mjs --local --pr <n>
- [x] 3.3 Leave real recording and picker checks open for the owner; check: Starting a recording of static content, Starting a recording of moving content, Dismissing a picker in a new recording, Dismissing a picker in review
