import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_APP_IDENTIFIER, assertKeychainInSearchList, needsCaptureEntitlements, selectSigningIdentity } from './macos-signing.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = process.argv.slice(2);
let target;
let requireSpeech = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target' && args[i + 1]) target = args[++i];
  else if (args[i] === '--require-speech-runtime') requireSpeech = true;
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result;
}
const host = run('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout.match(/^host: (.+)$/m)?.[1];
const triple = target ?? host;
const platforms = {
  'x86_64-pc-windows-msvc': { name: 'windows-x64', bundles: ['nsis'], suffix: '.exe', extensions: ['.exe'] },
  'x86_64-unknown-linux-gnu': { name: 'linux-x64', bundles: ['deb', 'appimage'], suffix: '', extensions: ['.deb', '.AppImage'] },
  'aarch64-apple-darwin': { name: 'macos-arm64', bundles: ['dmg'], suffix: '', extensions: ['.dmg'] },
  'x86_64-apple-darwin': { name: 'macos-x64', bundles: ['dmg'], suffix: '', extensions: ['.dmg'] },
};
const platform = platforms[triple];
if (!platform || triple !== host) throw new Error(`Build installers on a matching native host. Host: ${host}; target: ${triple}`);
if (process.env.CARGO_TARGET_DIR) throw new Error('Unset CARGO_TARGET_DIR before packaging so bundle paths are unambiguous.');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tauriConfig = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const configVersion = tauriConfig.version;
const cargoVersion = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (version !== configVersion || version !== cargoVersion) throw new Error('package.json, Cargo.toml and tauri.conf.json versions must match.');
let signingIdentity;
const signingKeychain = process.env.APPLE_KEYCHAIN;
if (process.platform === 'darwin') {
  if (tauriConfig.identifier !== MACOS_APP_IDENTIFIER) throw new Error(`macOS packages must retain bundle identifier ${MACOS_APP_IDENTIFIER}.`);
  if (signingKeychain) {
    const searchList = run('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8', stdio: 'pipe' }).stdout;
    assertKeychainInSearchList(searchList, signingKeychain, realpathSync);
  }
  const identityArgs = ['find-identity', '-v', '-p', 'codesigning'];
  if (signingKeychain) identityArgs.push(signingKeychain);
  const available = run('security', identityArgs, { encoding: 'utf8', stdio: 'pipe' }).stdout;
  signingIdentity = selectSigningIdentity(available, process.env.APPLE_SIGNING_IDENTITY ?? tauriConfig.bundle?.macOS?.signingIdentity);
  // Keep direct codesign calls and Tauri's bundler on the same selected identity.
  process.env.APPLE_SIGNING_IDENTITY = signingIdentity.hash;
}
const cargoArgs = ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--bin', 'cue', '--features', 'custom-protocol', '--locked'];
if (target) cargoArgs.push('--target', target);
// generate_context! needs the frontend present when the CLI builds the shared library.
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run('cargo', cargoArgs);
const releaseDir = join(root, 'src-tauri/target', ...(target ? [target] : []), 'release');
const cli = join(releaseDir, `cue${platform.suffix}`);
run(cli, ['--help']);
const resources = { [cli.replaceAll('\\', '/')]: `cue${platform.suffix}` };
const speechDir = join(root, '.local/bundle-tools/tools/whisper-b5454');
const speechReady = ['whisper-cli', 'whisper-vad-speech-segments'].every(name => existsSync(join(speechDir, name + platform.suffix)));
if (requireSpeech && !speechReady) throw new Error('Build the speech runtime first: node scripts/build-speech-runtime.mjs');
if (speechReady) {
  const manifest = JSON.parse(readFileSync(join(speechDir, 'runtime.json'), 'utf8'));
  if (manifest.target !== triple) throw new Error(`Speech runtime target ${manifest.target} does not match ${triple}.`);
  resources[speechDir.replaceAll('\\', '/') + '/'] = 'tools/whisper-b5454/';
}
const config = { bundle: { targets: platform.bundles, resources, ...(signingIdentity ? { macOS: { signingIdentity: signingIdentity.hash, hardenedRuntime: true } } : {}) } };
const configPath = join(root, '.local', `bundle-${triple}.json`);
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2));
const buildArgs = ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--config', configPath];
if (target) buildArgs.push('--target', target);
if (process.platform === 'darwin') buildArgs.push('--no-bundle');
run(process.execPath, buildArgs);
if (process.platform === 'darwin') {
  // Sign after the final compilation so both Cargo binaries and resource helpers
  // already have valid signatures when Tauri signs the enclosing app bundle.
  const binaries = [join(releaseDir, 'cuereview'), cli];
  if (speechReady) binaries.push(...['whisper-cli', 'whisper-vad-speech-segments'].map(name => join(speechDir, name)));
  for (const binary of binaries) {
    const identifier = basename(binary) === 'cuereview' ? MACOS_APP_IDENTIFIER : basename(binary);
    const signingArgs = ['--force', '--sign', signingIdentity.hash, '--identifier', identifier, '--options', 'runtime', '--timestamp'];
    if (signingKeychain) signingArgs.push('--keychain', signingKeychain);
    if (needsCaptureEntitlements(binary)) signingArgs.push('--entitlements', join(root, 'src-tauri/Entitlements.plist'));
    run('codesign', [...signingArgs, binary]);
    run('codesign', ['--verify', '--strict', binary]);
  }
  // Binary patching would invalidate the signatures above. This app ships only
  // DMG on macOS and does not need Tauri's per-bundle updater marker.
  const bundleArgs = ['node_modules/@tauri-apps/cli/tauri.js', 'bundle', '--config', configPath, '--no-binary-patching'];
  if (target) bundleArgs.push('--target', target);
  run(process.execPath, bundleArgs);
}
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const bundleFiles = filesIn(join(releaseDir, 'bundle'));
const output = join(root, '.local/release-assets');
mkdirSync(output, { recursive: true });
for (const extension of platform.extensions) {
  const matches = bundleFiles.filter(path => path.endsWith(extension));
  if (matches.length !== 1) throw new Error(`Expected one ${extension} installer, found ${matches.length}. Clean the bundle output before packaging.`);
  const name = `CueReview_${version}_${platform.name}${extension === '.exe' ? '_setup' : ''}${extension}`;
  copyFileSync(matches[0], join(output, name));
  console.log(`Release asset: ${join(output, name)}`);
}
