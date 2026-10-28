import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const tag = process.env.RELEASE_TAG;
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) throw new Error('RELEASE_TAG must be a version tag, for example v0.1.0.');
const version = tag.slice(1);
function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} failed: ${result.stderr}`);
  return result;
}
const versions = [JSON.parse(readFileSync('package.json', 'utf8')).version, JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version, readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1]];
if (versions.some(value => value !== version)) throw new Error(`Tag ${tag} does not match every application version: ${versions.join(', ')}`);
const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
if (process.argv[2] === 'validate') {
  const tagged = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]).stdout.trim();
  if (sha !== tagged) throw new Error('The checked-out revision does not match the requested tag.');
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\ntag=${tag}\n`);
  console.log(`Validated ${tag} at ${sha}, contained in main.`);
} else if (process.argv[2] === 'publish') {
  if (process.env.RELEASE_SHA !== sha) throw new Error('Publish checkout does not match the validated revision.');
  const assetDir = join(root, '.local/release-assets');
  const expected = [
    `CueReview_${version}_windows-x64_setup.exe`,
    `CueReview_${version}_linux-x64.deb`,
    `CueReview_${version}_linux-x64.AppImage`,
    `CueReview_${version}_macos-arm64.dmg`,
    `CueReview_${version}_macos-x64.dmg`,
  ].sort();
  const actual = readdirSync(assetDir).filter(name => name !== 'SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Incomplete or unexpected release assets: ${actual.join(', ')}`);
  const checksums = expected.map(name => {
    const bytes = readFileSync(join(assetDir, name));
    if (!bytes.length) throw new Error(`Empty installer: ${name}`);
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
  }).join('\n') + '\n';
  writeFileSync(join(assetDir, 'SHA256SUMS'), checksums);
  const existing = run('gh', ['release', 'view', tag, '--json', 'isDraft,targetCommitish'], true);
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout);
    if (!release.isDraft) throw new Error('This release is already published; refusing to replace its assets.');
    if (release.targetCommitish !== sha) throw new Error('Existing draft release points at a different revision.');
  } else {
    const args = ['release', 'create', tag, '--verify-tag', '--draft', '--target', sha, '--title', `CueReview ${tag}`, '--notes-file', '.github/RELEASE_NOTES.md'];
    if (version.includes('-')) args.push('--prerelease');
    run('gh', args);
  }
  const names = [...expected, 'SHA256SUMS'];
  run('gh', ['release', 'upload', tag, ...names.map(name => join(assetDir, name)), '--clobber']);
  const uploaded = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets']).stdout).assets.map(asset => asset.name).sort();
  if (JSON.stringify(uploaded) !== JSON.stringify(names.sort())) throw new Error('Draft release assets do not exactly match the completed build.');
  run('gh', ['release', 'edit', tag, '--draft=false']);
  console.log(`Published ${tag} with all five installers and SHA256SUMS.`);
} else throw new Error('Usage: node scripts/release.mjs validate|publish');
