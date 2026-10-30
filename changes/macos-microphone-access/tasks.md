# Tasks: Permit microphone capture in the hardened macOS app

## 1. Packaged microphone access

- [x] 1.1 Confirm the selected microphone produced silence and inspect the missing signed entitlement; test: installed build 88ac63a and macOS diagnostics
- [x] 1.2 Add audio-input access to the existing hardened-runtime entitlement file; test: signed bundle inspection
- [x] 1.3 Make installer verification reject missing microphone or camera entitlements; test: scripts/verify-bundle.mjs
- [x] 1.4 Update the audio-track specification and architecture; test: node tools/gate/gate.mjs --local

## 2. Verification and delivery

- [x] 2.1 Run required Rust suites and package verification; test: docs/VERIFICATION.md
- [x] 2.2 Verify real microphone samples, normal Stop and finalized audio playback using isolated data; check: An installed macOS app records the selected microphone
- [x] 2.3 Complete independent review, required gate and CI checks; test: node tools/gate/gate.mjs --local --pr <n>
- [x] 2.4 Install the verified build and deliver the change; check: An installed macOS app records the selected microphone
