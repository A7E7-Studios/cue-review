# Design: Preserve macOS capture permission across signed updates

## Context

The packager signs helper binaries ad hoc before Tauri bundles the app. The app's designated
requirement therefore changes with its code hash. Tauri already accepts a signing identity, but
its certificate import occurs after the packager's helper-signing stage. The existing Developer
ID Application certificate belongs to team 2RZUB2TKD6. The owner approved local and release signing.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Persistent identity | Existing Developer ID, expected team and unchanged studio.a7e7.cuereview identifier; normal Apple designated requirement | Ad-hoc signing changes identity with binary content; a permissive custom requirement weakens identity | [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) |
| Local selection | Configured APPLE_SIGNING_IDENTITY or one matching locally available Developer ID; fail if absent, wrong or ambiguous | Silent fallback recreates the reported failure | [Tauri signing](https://v2.tauri.app/distribute/sign/macos/) |
| Inside-out signing | Sign helpers and outer bundle consistently with hardened runtime and secure timestamps; retain existing entitlements and no-binary-patching | Signing only the outer app leaves resource executables ad hoc; changing signed content breaks validity | [Apple TN2206](https://developer.apple.com/library/archive/technotes/tn2206/) |
| CI isolation | Import the approved certificate into a temporary keychain before packaging, then clean up; signing environment only for trusted main/release jobs | Tauri's later import cannot satisfy earlier helper signing; PR access would expose the private key | [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [Tauri signing](https://v2.tauri.app/distribute/sign/macos/) |
| Artifact verification | Check identity, team, hardened runtime and entitlements; cross-verify designated requirements between two different artifacts | A valid signature alone does not establish stable identity across updates | [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | Packaging, bundle verification, CI import/cleanup, reusable build callers, root README and architecture |
| State on the network | Protected GitHub macos-signing environment; its credentials are provisioned only after explicit owner approval |
| Storage | Private key stays in local Keychain; CI uses ephemeral keychain/certificate files and removes them after use; existing recording data stays unchanged |

## Test plan

| Scenario or logic | Test |
|---|---|
| Identity selection and rejected signing configurations | scripts/macos-signing.test.mjs |
| CI trust and credential handling | scripts/macos-ci-signing.test.mjs |
| Final signed bundle | scripts/verify-bundle.mjs |
| Identity compatibility across updates | Compare different code hashes, matching team/identifier and designated requirements, then cross-verify both signatures |
| Native update | Authorize Developer ID build A once, install build B, and preview/record a screen without editing privacy settings |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| Screen recording remains available after an update | desk | Update a previously authorized Developer ID app, then record without re-enabling Screen Recording |

## Risks

- The ad-hoc-to-Developer-ID transition can require one final consent refresh.
- Missing CI credentials block macOS release packaging; they do not silently produce incompatible updates.
- Environment deployment restrictions are required configuration; YAML conditions alone are not a secret boundary.
- Developer ID signing alone does not establish notarization or override macOS privacy policy.
