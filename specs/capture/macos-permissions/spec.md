---
title: macOS capture permissions
code:
  - scripts/package.mjs
  - scripts/macos-signing.mjs
  - scripts/macos-ci-signing.mjs
  - scripts/verify-bundle.mjs
  - .github/workflows/build.yml
  - .github/workflows/installers.yml
  - .github/workflows/release.yml
---
# macOS capture permissions

## Purpose

Capture permission remains associated with the same macOS app across updates signed by its
approved developer, without weakening the operating system's consent controls.

## Requirements

### Requirement: Distributed updates preserve the app's signing identity
The macOS packager SHALL use the approved Developer ID team and unchanged bundle identifier,
because macOS identifies authorized apps by their designated code requirement across updates.

#### Scenario: Screen recording remains available after an update
- **GIVEN** a Developer ID signed CueReview app has Screen Recording permission
- **WHEN** the person installs a different build signed with the same approved identity
- **THEN** screen preview and recording work without removing or re-enabling the existing grant
- **AND** the app still requires normal macOS consent if permission has been revoked
- **PROOF** desk: open

#### Scenario: The required identity is unavailable
- **GIVEN** the packager cannot resolve one available Developer ID for the approved team
- **WHEN** a macOS distribution package is requested
- **THEN** packaging fails with actionable signing guidance
- **AND** it does not silently substitute an ad-hoc signature
- **PROOF** test: scripts/macos-signing.test.mjs

### Requirement: Signed releases retain the approved identity
The installer verification SHALL require the approved signing identity, hardened runtime and
capture entitlements, because a valid but incompatible signature can discard existing permission.

#### Scenario: A signed release artifact is checked
- **WHEN** the macOS installer smoke check inspects the final app and bundled executables
- **THEN** it rejects ad-hoc signatures or an unexpected signing team or app identifier
- **AND** it requires hardened runtime and the app's camera and audio-input entitlements
- **PROOF** test: scripts/verify-bundle.mjs

### Requirement: Pull requests cannot use release signing credentials
The CI signing path SHALL restrict credentials to trusted main and release jobs and remove
temporary signing material after use, because untrusted changes must not sign as the developer.

#### Scenario: An ordinary pull request builds installers
- **WHEN** an ordinary pull request runs installer checks
- **THEN** its code receives no release signing credentials
- **AND** it does not publish an ad-hoc macOS release as a substitute
- **PROOF** test: scripts/macos-ci-signing.test.mjs
