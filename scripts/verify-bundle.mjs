import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_APP_IDENTIFIER, assertCaptureEntitlements, assertDeveloperIdSignature, developerIdRequirement, needsCaptureEntitlements } from './macos-signing.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32' && process.env.CI !== 'true') throw new Error('The Windows installer smoke check is restricted to disposable CI runners because installation changes the per-user app registration.');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--target' || !/^[a-z0-9_-]+$/.test(args[1])) throw new Error('Usage: node scripts/verify-bundle.mjs --target TARGET');
const bundleDir = join(root, 'src-tauri/target', args[1], 'release/bundle');
const fixture = join(root, '.local/verify-installed');
const env = { ...process.env, CUEREVIEW_DATA_DIR: join(root, '.local/verify-bundle-data') };
function run(command, argv, capture = false, input) {
  const result = spawnSync(command, argv, { cwd: root, env, input, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true, timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ''}`);
  return capture === 'stderr' ? result.stderr : result.stdout;
}
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function verifyCaptureEntitlements(binary) {
  assertCaptureEntitlements(JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], true,
    run('codesign', ['--display', '--entitlements', '-', '--xml', binary], true))));
}
let mountedDmg;
try {
  let cli;
  let resourceDir;
  if (process.platform === 'win32') {
    const installers = filesIn(bundleDir).filter(path => path.endsWith('-setup.exe'));
    if (installers.length !== 1) throw new Error('Expected one NSIS installer.');
    run(installers[0], ['/S', `/D=${fixture}`]);
    resourceDir = fixture;
    cli = join(resourceDir, 'cue.exe');
  } else if (process.platform === 'linux') {
    const installers = filesIn(bundleDir).filter(path => path.endsWith('.deb'));
    if (installers.length !== 1) throw new Error('Expected one Debian installer.');
    mkdirSync(fixture, { recursive: true });
    run('dpkg-deb', ['--extract', installers[0], fixture]);
    const binaries = filesIn(join(fixture, 'usr/lib')).filter(path => basename(path) === 'cue');
    if (binaries.length !== 1) throw new Error('Expected one packaged cue executable.');
    cli = binaries[0];
    resourceDir = dirname(cli);
  } else if (process.platform === 'darwin') {
    const installers = filesIn(bundleDir).filter(path => path.endsWith('.dmg'));
    if (installers.length !== 1) throw new Error('Expected one DMG installer.');
    mkdirSync(join(root, '.local'), { recursive: true });
    const mountpoint = mkdtempSync(join(root, '.local/verify-dmg-'));
    run('hdiutil', ['attach', installers[0], '-nobrowse', '-readonly', '-mountpoint', mountpoint]);
    mountedDmg = mountpoint;
    const app = join(mountpoint, 'CueReview.app');
    run('codesign', ['--verify', '--deep', '--strict', app]);
    run('codesign', ['--verify', '--strict', '-R', developerIdRequirement(MACOS_APP_IDENTIFIER), app]);
    assertDeveloperIdSignature(run('codesign', ['--display', '--verbose=4', app], 'stderr'), MACOS_APP_IDENTIFIER);
    verifyCaptureEntitlements(app);
    resourceDir = join(app, 'Contents/Resources');
    cli = join(resourceDir, 'cue');
    for (const binary of [join(app, 'Contents/MacOS/cuereview'), join(app, 'Contents/MacOS/cue'), cli, ...['whisper-cli', 'whisper-vad-speech-segments'].map(name => join(resourceDir, 'tools/whisper-b5454', name))]) {
      const identifier = basename(binary) === 'cuereview' ? MACOS_APP_IDENTIFIER : basename(binary);
      run('codesign', ['--verify', '--strict', '-R', developerIdRequirement(identifier), binary]);
      assertDeveloperIdSignature(run('codesign', ['--display', '--verbose=4', binary], 'stderr'), identifier);
      if (needsCaptureEntitlements(binary)) verifyCaptureEntitlements(binary);
    }
  } else throw new Error(`Unsupported host: ${process.platform}`);
  if (!existsSync(cli)) throw new Error(`Bundled CLI is missing: ${cli}`);
  run(cli, ['--help']);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  // Windows and Linux x64 also ship the AVX2 build (scripts/build-speech-runtime.mjs).
  const builds = ['tools/whisper-b5454', ...(process.arch === 'x64' && process.platform !== 'darwin' ? ['tools/whisper-b5454/avx2'] : [])];
  for (const build of builds) {
    for (const name of ['whisper-cli', 'whisper-vad-speech-segments']) {
      run(join(resourceDir, build, name + suffix), ['-h']);
    }
  }
  const setup = JSON.parse(run(cli, ['setup'], true));
  for (const name of ['whisper-cli', 'whisper-vad-speech-segments']) {
    if (!setup.dependencies.some(dependency => dependency.name === name && dependency.available)) throw new Error(`Installed cue cannot discover bundled ${name}.`);
  }
  console.log('Packaged CLI and both bundled speech executables passed smoke checks.');
} finally {
  if (mountedDmg) {
    run('hdiutil', ['detach', mountedDmg]);
    // Only remove the empty mountpoint created by this invocation, after detaching.
    if (existsSync(mountedDmg)) rmdirSync(mountedDmg);
  }
}
