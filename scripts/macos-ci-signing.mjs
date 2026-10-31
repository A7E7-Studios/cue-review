import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectSigningIdentity } from './macos-signing.mjs';

// Defense in depth: the macos-signing environment must also restrict deployment
// branches/tags and require approval for signing deployments. Keep its secrets out of
// repository/organization secret scopes, where same-repository PRs can read them.
export function isTrustedSigningContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'A7E7-Studios/cue-review') return false;
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return env.GITHUB_REF === 'refs/heads/main';
  return env.GITHUB_EVENT_NAME === 'push' && (env.GITHUB_REF === 'refs/heads/main'
    || /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(env.GITHUB_REF ?? ''));
}

export function validateSigningInputs(env) {
  if (!isTrustedSigningContext(env)) throw new Error('Signing credentials are restricted to trusted main and release workflows.');
  if (!env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP) || !env.GITHUB_ENV || !isAbsolute(env.GITHUB_ENV)) throw new Error('Signing requires an absolute runner temporary directory and GitHub environment file.');
  if (!env.APPLE_CERTIFICATE || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(env.APPLE_CERTIFICATE)
      || Buffer.from(env.APPLE_CERTIFICATE, 'base64').length === 0) throw new Error('Set APPLE_CERTIFICATE to the base64 PKCS12 in the protected macos-signing environment.');
  if (!env.APPLE_CERTIFICATE_PASSWORD) throw new Error('Set APPLE_CERTIFICATE_PASSWORD in the protected macos-signing environment.');
}

function security(args) {
  // Never log arguments or child output: import/create commands carry passwords.
  const childEnv = { ...process.env };
  delete childEnv.APPLE_CERTIFICATE;
  delete childEnv.APPLE_CERTIFICATE_PASSWORD;
  const result = spawnSync('/usr/bin/security', args, { env: childEnv, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`Keychain operation ${args[0]} failed; signing stopped.`);
  return result.stdout;
}
function statePath(env) {
  if (!env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP)) throw new Error('Signing cleanup requires an absolute runner temporary directory.');
  return join(env.RUNNER_TEMP, 'cuereview-signing-state.json');
}
function readSearchList(output) {
  return output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Invalid keychain search list.');
    return value;
  });
}

export function cleanupSigningIdentity(env, { run = security } = {}) {
  const path = statePath(env);
  if (!existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (dirname(state.directory ?? '') !== resolve(env.RUNNER_TEMP)
      || !/^cuereview-signing-[A-Za-z0-9]+$/.test(basename(state.directory ?? ''))
      || state.keychain !== join(state.directory, 'signing.keychain-db')
      || !Array.isArray(state.searchList) || state.searchList.some(value => typeof value !== 'string' || !isAbsolute(value))) {
    throw new Error('Invalid signing cleanup state.');
  }
  let failure;
  try { run(['list-keychains', '-d', 'user', '-s', ...state.searchList]); } catch (error) { failure = error; }
  try { if (state.created) run(['delete-keychain', state.keychain]); } catch (error) { failure ??= error; }
  // The owned directory can contain the private keychain if security deletion
  // failed. Remove it as well; never leave imported key material in artifacts.
  rmSync(state.directory, { recursive: true, force: true });
  rmSync(path);
  if (failure) throw failure;
}

export function importSigningIdentity(env, { run = security, platform = process.platform } = {}) {
  validateSigningInputs(env);
  if (platform !== 'darwin') throw new Error('Signing identity import requires macOS.');
  const path = statePath(env);
  if (existsSync(path)) throw new Error('A signing keychain already exists for this job; clean it up before importing again.');
  const searchList = readSearchList(run(['list-keychains', '-d', 'user']));
  const directory = mkdtempSync(join(resolve(env.RUNNER_TEMP), 'cuereview-signing-'));
  const keychain = join(directory, 'signing.keychain-db');
  const certificate = join(directory, 'identity.p12');
  const password = randomBytes(32).toString('base64url');
  const state = { directory, keychain, searchList, created: false };
  writeFileSync(path, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  try {
    run(['create-keychain', '-p', password, keychain]);
    state.created = true;
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    run(['set-keychain-settings', '-lut', '21600', keychain]);
    run(['unlock-keychain', '-p', password, keychain]);
    writeFileSync(certificate, Buffer.from(env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600 });
    try {
      run(['import', certificate, '-k', keychain, '-P', env.APPLE_CERTIFICATE_PASSWORD,
        '-t', 'cert', '-f', 'pkcs12', '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
    } finally { rmSync(certificate, { force: true }); }
    run(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    const identity = selectSigningIdentity(run(['find-identity', '-v', '-p', 'codesigning', keychain]), env.APPLE_SIGNING_IDENTITY ?? '');
    run(['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
    if (/[\r\n]/.test(identity.name) || /[\r\n]/.test(keychain)) throw new Error('Invalid signing identity environment value.');
    appendFileSync(env.GITHUB_ENV, `APPLE_SIGNING_IDENTITY=${identity.name}\nAPPLE_KEYCHAIN=${keychain}\n`);
  } catch (error) {
    cleanupSigningIdentity(env, { run });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'check') validateSigningInputs(process.env);
    else if (process.argv[2] === 'import') importSigningIdentity(process.env);
    else if (process.argv[2] === 'cleanup') cleanupSigningIdentity(process.env);
    else throw new Error('Usage: node scripts/macos-ci-signing.mjs check|import|cleanup');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
