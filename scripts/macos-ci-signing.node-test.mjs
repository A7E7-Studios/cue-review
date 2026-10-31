import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupSigningIdentity, importSigningIdentity, isTrustedSigningContext, validateSigningInputs } from './macos-ci-signing.mjs';

const identity = 'Developer ID Application: Andreas Eichert (2RZUB2TKD6)';
const trusted = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'A7E7-Studios/cue-review', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cuereview-ci-signing-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...trusted, RUNNER_TEMP: directory, GITHUB_ENV: join(directory, 'job-env'), APPLE_CERTIFICATE: Buffer.from('mock pkcs12').toString('base64'), APPLE_CERTIFICATE_PASSWORD: 'test-password' };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-keychains' && !args.includes('-s')) return '    "/tmp/previous login.keychain-db"\n';
    if (args[0] === 'find-identity') return `1) ${'A'.repeat(40)} "${identity}"\n 1 valid identities found`;
    return '';
  };
  return { directory, env, calls, run };
}

test('only upstream main and release events can import signing material', () => {
  assert.equal(isTrustedSigningContext(trusted), true);
  assert.equal(isTrustedSigningContext({ ...trusted, GITHUB_REF: 'refs/tags/v0.3.0' }), true);
  assert.equal(isTrustedSigningContext({ ...trusted, GITHUB_EVENT_NAME: 'workflow_dispatch' }), true);
  for (const change of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/v0.3.0' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/unsigned' },
    { GITHUB_REPOSITORY: 'someone/cue-review' }, { GITHUB_ACTIONS: 'false' },
  ]) assert.equal(isTrustedSigningContext({ ...trusted, ...change }), false);
});

test('missing or malformed signing credentials fail without revealing values', (t) => {
  const { env } = fixture(t);
  assert.doesNotThrow(() => validateSigningInputs(env));
  for (const change of [ { APPLE_CERTIFICATE: '' }, { APPLE_CERTIFICATE_PASSWORD: '' }, { APPLE_CERTIFICATE: 'do-not-print-this-invalid-certificate' }, { RUNNER_TEMP: 'relative' }, { GITHUB_ENV: '' } ]) {
    assert.throws(() => validateSigningInputs({ ...env, ...change }), error => !error.message.includes('do-not-print-this'));
  }
});

test('import exports only the selected identity and keychain, then cleanup restores the prior search list', (t) => {
  const { directory, env, calls, run } = fixture(t);
  importSigningIdentity(env, { run, platform: 'darwin' });
  const exported = readFileSync(env.GITHUB_ENV, 'utf8');
  assert.match(exported, /APPLE_SIGNING_IDENTITY=Developer ID Application:/);
  assert.match(exported, /APPLE_KEYCHAIN=/);
  assert.ok(!exported.includes(env.APPLE_CERTIFICATE_PASSWORD));
  assert.ok(!exported.includes(env.APPLE_CERTIFICATE));
  const imported = calls.find(args => args[0] === 'import');
  assert.ok(imported);
  assert.equal(existsSync(imported[1]), false, 'PKCS12 file is removed immediately after import');
  assert.deepEqual(calls.find(args => args[0] === 'list-keychains' && args.includes('-s')).slice(-1), ['/tmp/previous login.keychain-db']);
  cleanupSigningIdentity(env, { run });
  assert.deepEqual(calls.filter(args => args[0] === 'list-keychains' && args.includes('-s')).at(-1), ['list-keychains', '-d', 'user', '-s', '/tmp/previous login.keychain-db']);
  assert.ok(calls.some(args => args[0] === 'delete-keychain'));
  assert.deepEqual(readdirSync(directory), ['job-env']);
  cleanupSigningIdentity(env, { run }); // Safe after setup failed before creating state.
});

test('failed import cleans its certificate and keychain without exporting identity', (t) => {
  const { directory, env, calls, run } = fixture(t);
  assert.throws(() => importSigningIdentity(env, { platform: 'darwin', run: args => {
    if (args[0] === 'import') { calls.push(args); throw new Error('mock import failure'); }
    return run(args);
  } }), /mock import failure/);
  assert.ok(calls.some(args => args[0] === 'delete-keychain'));
  assert.equal(existsSync(env.GITHUB_ENV), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('cleanup rejects a state pointing outside the owned temporary directory', (t) => {
  const { env, calls, run } = fixture(t);
  writeFileSync(join(env.RUNNER_TEMP, 'cuereview-signing-state.json'), JSON.stringify({ directory: '/tmp/unrelated', keychain: '/tmp/unrelated/keychain', searchList: [] }));
  assert.throws(() => cleanupSigningIdentity(env, { run }), /Invalid signing cleanup state/);
  assert.equal(calls.length, 0);
});

test('an unexpected imported identity cleans the keychain and never reaches packaging exports', (t) => {
  const { directory, env, calls, run } = fixture(t);
  assert.throws(() => importSigningIdentity(env, { platform: 'darwin', run: args => {
    if (args[0] === 'find-identity') return `1) ${'B'.repeat(40)} "Developer ID Application: Wrong Team (OTHERTEAM1)"`;
    return run(args);
  } }));
  assert.ok(calls.some(args => args[0] === 'delete-keychain'));
  assert.equal(existsSync(env.GITHUB_ENV), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('cleanup removes owned key material even when a keychain command fails', (t) => {
  const { directory, env, run } = fixture(t);
  importSigningIdentity(env, { run, platform: 'darwin' });
  assert.throws(() => cleanupSigningIdentity(env, { run: args => {
    if (args[0] === 'delete-keychain') throw new Error('mock keychain cleanup failure');
    return run(args);
  } }), /mock keychain cleanup failure/);
  assert.deepEqual(readdirSync(directory), ['job-env']);
});
