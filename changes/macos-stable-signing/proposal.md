---
title: Preserve macOS capture permission across signed updates
capabilities:
  - capture/macos-permissions
review: unreviewed
---
# Preserve macOS capture permission across signed updates

## Why

The owner asks, "Can we also fix the permission issue so I don't have to re-enable screen recording
after every update?" The installed ad-hoc app's designated requirement is its current code hash,
so replacing the binary invalidates the existing privacy grant. A valid Developer ID Application
identity for team 2RZUB2TKD6 is already available on the owner's Mac.

## What changes

- Package local and released macOS apps under the existing Developer ID and unchanged app identifier.
- Require the expected signing identity, entitlements and hardened runtime in signed installers.
- Restrict CI signing to trusted main/release jobs with isolated, temporary signing material.
- Verify an update between different signed artifacts retains Screen Recording access without
  resetting the grant after the first Developer ID build has been authorized.

## Settled questions

- **Q5 Scope and design**: The owner approved "Local builds + releases (Recommended)" for the
  linked design: existing Developer ID, unchanged app identifier and privacy protections, an actual
  update test without resetting permission, and separate review before any CI credential transfer.
- **Credential decision**: After reviewing the concrete transfer and access policy, the owner
  chose "Keep release credentials local for now". Deliver the verified local fix and prepared CI
  implementation without exporting the key or configuring GitHub access. CI credential provisioning
  and a trusted signed release run are deferred; macOS CI packaging fails closed until configured.
- The transition from ad-hoc signing may need one final permission refresh. Capture permissions
  remain controlled by macOS; the fix does not bypass consent or promise to override revocation.

## Calls for the owner

- Use the existing team 2RZUB2TKD6 consistently. Refuse missing or ambiguous identity selection
  instead of generating an ad-hoc distribution artifact.
- Store CI signing material in a protected macos-signing environment rather than repository-wide
  secrets. Restrict deployments to main and release tags; do not expose it to PR code.
- Workflow paths are protected under AGENTS.md, so the owner merges the finished PR.
- No private signing key is exported or uploaded. Credential transfer and environment setup are
  deferred by the owner; a later transfer needs fresh explicit approval.

## Out of scope

- Notarization, automatic in-app updating, a different signing team or bundle identifier.
- Changes to capture codecs, recordings, transcription, or macOS's own reauthorization policy.
