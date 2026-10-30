# Tasks: Prefer displays and make macOS camera capture usable

## 1. Source priority

- [x] 1.1 Add failing tests for all source-selection scenarios in `src/App.test.tsx`; test: npm test -- src/App.test.tsx
- [x] 1.2 Stably order a copy of the discovery list by kind and use it for initial selection without replacing an explicit choice; test: npm test -- src/App.test.tsx
- [x] 1.3 Update the root README's source selection guidance; test: node tools/gate/gate.mjs --local

## 2. Preview process and transport errors (independent of 1)

- [x] 2.1 Add synthetic decoder failure, bounded-stderr, no-viewer timeout and teardown tests; test: src-tauri/src/preview.rs
- [x] 2.2 Drain bounded decoder diagnostics concurrently and report actionable startup/stream errors, including no-viewer timeout; preserve AVFoundation recording-start causes with access/retry guidance; test: src-tauri/src/preview.rs; src-tauri/src/capture.rs::tests::avfoundation_startup_failures_keep_the_cause_and_offer_recovery
- [x] 2.3 Document preview failure and retry in the root README and retain detailed verification at its documented home; test: node tools/gate/gate.mjs --local

## 3. First-frame recovery (independent of 1 and 2)

- [x] 3.1 Add tests for an image that never becomes drawable, a successful first frame, Retry and source changes; test: src/workspace/MediaStage.test.tsx
- [x] 3.2 Route the existing dimension polling's timeout into the preview hook's recoverable error state, cancel obsolete work, and preserve reconnect behaviour; test: src/app/usePreviewStream.test.tsx
- [x] 3.3 Document recovery behaviour in the root README; test: node tools/gate/gate.mjs --local

## 4. macOS integration and delivery (after 1, 2 and 3)

- [ ] 4.1 Verify packaged rendering, failures and retry with synthetic moving frames in isolated data; test: the packaged synthetic-preview probe
- [x] 4.2 Keep the existing macOS access coordination, cover preview-to-recording orchestration with the App acceptance test, and leave physical camera transition/playback open for an agreed attended run; test: src/App.test.tsx::starts a macos camera recording from its preview; check: A recording starts while the camera preview is active
- [x] 4.3 Keep camera preview, blocked-access and retry scenarios open for the owner's real-device review; check: The built-in camera is explicitly selected; Camera access is blocked; The person resolves the camera block and retries
- [x] 4.4 Refresh the picker and error looks with repository components, align spec code paths and acceptance selectors with the implementation, and update docs/VERIFICATION.md; test: node tools/gate/gate.mjs --local
- [ ] 4.5 Run all frontend and Rust checks required by AGENTS.md, commit, and run the strict gate; test: docs/VERIFICATION.md unattended set
- [ ] 4.6 Open the implementation pull request and obtain an independent review through ship, resolving every finding; test: .agents/skills/ship/review-checklist.md
