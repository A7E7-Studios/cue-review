# Tasks: Release macOS previews before recording and fix picker toggles

## 1. FFmpeg recording startup

- [x] 1.1 Reproduce buffered startup with real static and moving synthetic FFmpeg sources, sharing production output arguments and readiness; test: src-tauri/src/capture.rs::tests::actual_ffmpeg_recording_startup_flushes_static_and_moving_video
- [x] 1.2 Flush recording output without changing scrcpy, and verify shutdown, decoded frames and failed-start cleanup; test: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
- [x] 1.3 Assess the nearest README and document startup flushing in architecture; test: node tools/gate/gate.mjs --local

## 2. Source and microphone picker toggles

- [x] 2.1 Reproduce WebKit's blur/click ordering and make both triggers focusable in draft and review; test: scripts/verify-picker-toggle.cjs
- [x] 2.2 Verify repeated clicks, switching, Escape, Tab and outside dismissal in WebKit and Chromium without capture; test: scripts/verify-picker-toggle.cjs
- [x] 2.3 Assess the nearest README and document the browser regression script; test: node tools/gate/gate.mjs --local

## 3. Verification and handoff

- [x] 3.1 Run the frontend, Rust and relevant integration suites and strict gate; test: docs/VERIFICATION.md
- [x] 3.2 Complete independent review, resolve findings and run final checks; test: node tools/gate/gate.mjs --local --pr <n>
- [x] 3.3 Leave real recording and picker checks open for the owner; check: Starting a recording of static content, Starting a recording of moving content, Dismissing a picker in a new recording, Dismissing a picker in review

## 4. Exclusive macOS source access

- [x] 4.1 Release AVFoundation preview before capture, prevent reopening during startup or recording, and restore it after failed startup; test: src/App.test.tsx
- [x] 4.2 Show the source-neutral paused state and render display/camera looks; test: src/stories/Workspace.stories.tsx
- [x] 4.3 Verify installed display recording, normal Stop and playback with isolated data; check: Starting a macOS display recording from its preview
- [x] 4.4 Update architecture and nearest README as appropriate; test: node tools/gate/gate.mjs --local

## 5. Packaged camera access

- [x] 5.1 Include the camera entitlement in the hardened macOS bundle and inspect the packaged signature; test: codesign --display --entitlements - /Applications/CueReview.app
- [x] 5.2 Verify camera preview, normal recording stop and playback in the installed app; check: A recording starts while the camera preview is active
- [x] 5.3 Document the signing requirement in architecture and keep the owner merge requirement explicit; test: node tools/gate/gate.mjs --local --pr 25
