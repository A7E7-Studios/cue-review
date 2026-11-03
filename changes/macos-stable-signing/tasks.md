# Tasks: Preserve macOS capture permission across signed updates

## 1. Stable package signing

- [x] 1.1 Test identity selection and refusal of missing, ambiguous or wrong-team credentials; test: scripts/macos-signing.node-test.mjs
- [x] 1.2 Sign all shipped executables and app consistently while retaining hardened runtime and entitlements; test: scripts/verify-bundle.mjs
- [x] 1.3 Update the root README and architecture for stable signing; test: node tools/gate/gate.mjs --local

## 2. Trusted release CI (independent of 1)

- [x] 2.1 Isolate trusted signing jobs from PR code and use temporary keychains; test: scripts/macos-ci-signing.node-test.mjs
- [x] 2.2 Document exact protected environment and credential setup without exporting keys; test: node tools/gate/gate.mjs --local
- [x] 2.3 Record the owner's decision to keep credentials local and defer CI provisioning; test: read-only GitHub environment and secret-name checks confirm no setup or upload

## 3. Verification and delivery (after 1 and 2)

- [x] 3.1 Verify two different signed artifacts satisfy each other's designated requirement; test: codesign --verify --strict -R
- [x] 3.2 Install successive Developer ID builds and record without resetting permission on update; check: Screen recording remains available after an update
- [x] 3.3 Run required suites, strict gate and independent review; test: docs/VERIFICATION.md
- [x] 3.4 Hand over the protected workflow PR for owner merge and leave owner proof open; check: Screen recording remains available after an update
