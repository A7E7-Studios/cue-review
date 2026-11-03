import assert from 'node:assert/strict';
import test from 'node:test';
import { MACOS_TEAM_ID, MACOS_APP_IDENTIFIER, selectSigningIdentity, developerIdRequirement, assertDeveloperIdSignature, assertKeychainInSearchList, assertCaptureEntitlements, needsCaptureEntitlements } from './macos-signing.mjs';

test('requires the selected keychain in the user search list and handles spaces and normalized paths', () => {
  const output = '    "/Users/Example/Library/Keychains/login.keychain-db"\n    "/private/tmp/CueReview signing.keychain-db"\n';
  assertKeychainInSearchList(output, '/private/tmp/unused/../CueReview signing.keychain-db');
  assert.throws(() => assertKeychainInSearchList(output, '/private/tmp/other signing.keychain-db'), /APPLE_KEYCHAIN.*user keychain search list/);
  assert.throws(() => assertKeychainInSearchList('', '/private/tmp/CueReview signing.keychain-db'), /before packaging/);
});
test('compares canonical keychain paths and decodes escaped path characters', () => {
  const aliases = new Map([['/tmp/signing.keychain-db', '/private/tmp/signing.keychain-db']]);
  assertKeychainInSearchList('    "/private/tmp/signing.keychain-db"', '/tmp/signing.keychain-db', path => aliases.get(path) ?? path);
  assertKeychainInSearchList('    "/private/tmp/CueReview \\"test\\".keychain-db"', '/private/tmp/CueReview "test".keychain-db');
});
test('GUI and both packaged CLI locations require camera and microphone entitlements', () => {
  for (const binary of ['Contents/MacOS/cuereview', 'Contents/MacOS/cue', 'Contents/Resources/cue']) {
    assert.equal(needsCaptureEntitlements(binary), true);
  }
  for (const binary of ['tools/whisper-b5454/whisper-cli', 'tools/whisper-b5454/whisper-vad-speech-segments']) {
    assert.equal(needsCaptureEntitlements(binary), false);
  }
  const enabled = { 'com.apple.security.device.camera': true, 'com.apple.security.device.audio-input': true };
  assertCaptureEntitlements(enabled);
  for (const entitlement of Object.keys(enabled)) {
    for (const value of [undefined, false, 'true']) {
      assert.throws(() => assertCaptureEntitlements({ ...enabled, [entitlement]: value }), /missing enabled entitlement/);
    }
  }
});

const first = { hash: 'A'.repeat(40), name: `Developer ID Application: Example (${MACOS_TEAM_ID})` };
const second = { hash: 'B'.repeat(40), name: `Developer ID Application: Renewed (${MACOS_TEAM_ID})` };
const line = (identity, n = 1) => `  ${n}) ${identity.hash} "${identity.name}"`;
const listing = (...identities) => identities.map((id, i) => line(id, i + 1)).join('\n') + `\n     ${identities.length} valid identities found`;

test('selects the unique Developer ID for the approved team and ignores other identity kinds', () => {
  assert.deepEqual(selectSigningIdentity(listing(first, { hash: 'C'.repeat(40), name: `Apple Development: Developer (${MACOS_TEAM_ID})` })), first);
});
test('requires an explicit choice for multiple matching identities', () => {
  assert.throws(() => selectSigningIdentity(listing(first, second)), /multiple.*APPLE_SIGNING_IDENTITY/i);
  assert.deepEqual(selectSigningIdentity(listing(first, second), second.name), second);
  assert.deepEqual(selectSigningIdentity(listing(first, second), second.hash.toLowerCase()), second);
});
test('rejects ad-hoc, unavailable, wrong-team and development identities', () => {
  const other = { hash: 'D'.repeat(40), name: 'Developer ID Application: Other (OTHER12345)' };
  const development = { hash: 'E'.repeat(40), name: `Apple Development: Developer (${MACOS_TEAM_ID})` };
  assert.throws(() => selectSigningIdentity(listing(first), '-'), /ad-hoc/i);
  assert.throws(() => selectSigningIdentity(listing(first), 'Unavailable'), /not available/i);
  assert.throws(() => selectSigningIdentity(listing(other), other.name), /Developer ID.*2RZUB2TKD6/);
  assert.throws(() => selectSigningIdentity(listing(development), development.name), /Developer ID.*2RZUB2TKD6/);
  assert.throws(() => selectSigningIdentity('0 valid identities found'), /No.*Developer ID/);
});
test('deduplicates the same identity in multiple keychains but rejects duplicate names', () => {
  assert.deepEqual(selectSigningIdentity(listing(first, first)), first);
  const renewed = { hash: 'F'.repeat(40), name: first.name };
  assert.throws(() => selectSigningIdentity(listing(first, renewed), first.name), /multiple identities/);
  assert.deepEqual(selectSigningIdentity(listing(first, renewed), renewed.hash), renewed);
});
test('does not accept partial identity names or expired identities', () => {
  assert.throws(() => selectSigningIdentity(listing(first), 'Example'), /not available/i);
  assert.throws(() => selectSigningIdentity(`${line(first)} (CSSMERR_TP_CERT_EXPIRED)`), /No.*Developer ID/);
});

const signature = (identifier = MACOS_APP_IDENTIFIER) => `Identifier=${identifier}\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1+7\nAuthority=${first.name}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=Oct 31, 2026 at 12:00:00\nTeamIdentifier=${MACOS_TEAM_ID}\n`;
test('accepts distribution signatures for the expected app and helper identifiers', () => {
  assertDeveloperIdSignature(signature(), MACOS_APP_IDENTIFIER);
  assertDeveloperIdSignature(signature('whisper-cli'), 'whisper-cli');
});
test('rejects ad-hoc, wrong-team, wrong-identifier and incomplete distribution signatures', () => {
  for (const [actual, reason] of [
    [signature().replace('flags=0x10000(runtime)', 'flags=0x10002(adhoc,runtime)'), /ad-hoc/],
    [signature().replace(`TeamIdentifier=${MACOS_TEAM_ID}`, 'TeamIdentifier=OTHER12345'), /team/],
    [signature('another.app'), /identifier/],
    [signature().replace('flags=0x10000(runtime)', 'flags=0x0(none)'), /hardened runtime/],
    [signature().replace(/^Authority=Developer ID Application:.*\n/m, ''), /Developer ID/],
    [signature().replace(/^Timestamp=.*\n/m, ''), /timestamp/],
  ]) assert.throws(() => assertDeveloperIdSignature(actual, MACOS_APP_IDENTIFIER), reason);
});
test('verifies the Apple Developer ID chain, app identifier and team without fixing a build hash', () => {
  const requirement = developerIdRequirement(MACOS_APP_IDENTIFIER);
  assert.match(requirement, /^=identifier "studio\.a7e7\.cuereview" and anchor apple generic/);
  assert.match(requirement, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/);
  assert.match(requirement, /certificate leaf\[subject\.OU\] = "2RZUB2TKD6"/);
  assert.doesNotMatch(requirement, /cdhash/);
});
