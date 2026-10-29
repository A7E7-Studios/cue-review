// sync.mjs end to end: a throwaway kit repository synced into a throwaway project, then updated,
// refused, forced, dry-run and checked; the gate's kit check agreeing with --check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, git, testConfig, check } from '../../gate/test/helpers.mjs';
import { runGate, Repo } from '../../gate/lib/index.mjs';
import { blobId } from '../../gate/lib/kit.mjs';
import { parseManifest, publicUrl, lockUnprotected, assertInside, inside } from '../sync.mjs';

const SYNC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync.mjs');
const LOCK = 'tools/kit/lock.json';

const MANIFEST = {
  paths: ['.agents/skills/spec/', 'specs/README.md', 'tools/gate/', 'tools/kit/'],
  projectOwned: ['tools/gate/config.json', 'tools/kit/lock.json'],
  starters: { 'tools/gate/config.json': 'tools/gate/config.template.json' },
};

function kitRepo(t) {
  const k = makeRepo(
    {
      'kit.json': JSON.stringify(MANIFEST),
      'README.md': '# Kit\n',
      'LICENSE': 'MIT\n',
      '.agents/skills/spec/SKILL.md': 'skill 1\n',
      'specs/README.md': '# Specs\n',
      'tools/gate/gate.mjs': 'gate 1\n',
      'tools/gate/lib/a.mjs': 'a 1\n',
      'tools/gate/config.json': '{ "the kit": "its own" }\n',
      'tools/gate/config.template.json': '{ "starter": true }\n',
      'tools/kit/sync.mjs': 'sync 1\n',
    },
    { prefix: 'kit-' },
  );
  git(k.dir, ['config', 'remote.origin.url', 'https://someone:secret@example.invalid/org/kit.git']);
  t.after(() => k.cleanup());
  return k;
}

function project(t, files = { 'README.md': '# App\n', 'src/app.js': '1\n' }) {
  const p = makeRepo(files, { prefix: 'kit-project-' });
  t.after(() => p.cleanup());
  return p;
}

function sync(args, cwd) {
  const r = spawnSync(process.execPath, [SYNC, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (r, p) => fs.readFileSync(path.join(r.dir, ...p.split('/')), 'utf8');
const exists = (r, p) => fs.existsSync(path.join(r.dir, ...p.split('/')));
const lockOf = (r) => JSON.parse(read(r, LOCK));
const into = (k, p, ...more) => sync(['--kit', k.dir, '--ref', 'main', '--project', p.dir, ...more], p.dir);

test('sync: the first sync writes the kit, a starter config and the lock; --check and the gate agree', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  const res = into(k, p);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^add \.agents\/skills\/spec\/SKILL\.md$/m);
  assert.match(res.out, /^start tools\/gate\/config\.json from tools\/gate\/config\.template\.json: the project's own from now on$/m);
  assert.match(res.out, /synced the kit at [0-9a-f]{9} \(main, https:\/\/example\.invalid\/org\/kit\.git\): 6 added, 0 updated, 0 deleted, 0 unchanged/);
  assert.equal(read(p, 'tools/gate/gate.mjs'), 'gate 1\n');
  assert.equal(read(p, 'tools/gate/config.json'), '{ "starter": true }\n', 'from the starter, never the kit\'s own config');
  assert.ok(!exists(p, 'kit.json') && !exists(p, 'LICENSE') && !exists(p, 'README.md.kit'), 'only the kit\'s paths');
  const lock = lockOf(p);
  assert.deepEqual(lock.kit, { repository: 'https://example.invalid/org/kit.git', commit: k.main });
  assert.deepEqual(lock.paths, MANIFEST.paths);
  assert.deepEqual(lock.projectOwned, MANIFEST.projectOwned);
  assert.deepEqual(Object.keys(lock.files), ['.agents/skills/spec/SKILL.md', 'specs/README.md', 'tools/gate/config.template.json', 'tools/gate/gate.mjs', 'tools/gate/lib/a.mjs', 'tools/kit/sync.mjs']);
  assert.equal(lock.files['tools/gate/gate.mjs'], blobId(Buffer.from('gate 1\n')));

  let c = sync(['--check'], p.dir);
  assert.equal(c.code, 1, 'nothing committed yet');
  assert.match(c.err, /no tools\/kit\/lock\.json at HEAD/);
  p.commit('chore: take the kit');
  c = sync(['--check'], p.dir);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /the kit copy at HEAD is as tools\/kit\/lock\.json says: 6 file\(s\)/);
  const rep = runGate({ repo: new Repo(p.dir), base: 'main~1', head: 'HEAD', main: null, config: testConfig() });
  assert.equal(check(rep, 'kit').status, 'pass');

  // an edit the project commits: --check and the gate both see it
  p.write({ 'tools/gate/lib/a.mjs': 'a, mine\n' });
  p.commit('chore: mine');
  c = sync(['--check', '--project', p.dir], k.dir);
  assert.equal(c.code, 1);
  assert.match(c.out, /^tools\/gate\/lib\/a\.mjs: differs from the kit at/m);
});

test('sync: a kit update adds, updates and deletes; the project\'s own config stays; a second run changes nothing', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  assert.equal(into(k, p).code, 0);
  p.write({ 'tools/gate/config.json': '{ "mine": true }\n' });
  p.commit('chore: take the kit');
  k.write({ 'tools/gate/gate.mjs': 'gate 2\n', 'tools/gate/lib/a.mjs': null, 'tools/gate/lib/b.mjs': 'b 1\n' });
  const next = k.commit('feat: gate 2');
  let res = into(k, p);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^update tools\/gate\/gate\.mjs$/m);
  assert.match(res.out, /^delete tools\/gate\/lib\/a\.mjs$/m);
  assert.match(res.out, /^add tools\/gate\/lib\/b\.mjs$/m);
  assert.match(res.out, /1 added, 1 updated, 1 deleted, 4 unchanged/);
  assert.ok(!exists(p, 'tools/gate/lib/a.mjs'));
  assert.equal(read(p, 'tools/gate/config.json'), '{ "mine": true }\n');
  assert.equal(lockOf(p).kit.commit, next);
  res = into(k, p);
  assert.match(res.out, /0 added, 0 updated, 0 deleted, 6 unchanged/);
  // the kit drops a whole folder: it goes, and so does the emptied folder
  k.write({ 'tools/gate/lib/b.mjs': null });
  k.commit('feat: no lib');
  p.commit('chore: sync');
  res = into(k, p);
  assert.equal(res.code, 0, res.out + res.err);
  assert.ok(!exists(p, 'tools/gate/lib'));
});

test('sync: a kit file the project changed stops the sync, unless --force; --dry-run writes nothing', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  assert.equal(into(k, p).code, 0);
  p.commit('chore: take the kit');
  k.write({ 'tools/gate/gate.mjs': 'gate 2\n' });
  k.commit('feat: gate 2');
  const lockBefore = read(p, LOCK);

  p.write({ 'tools/gate/lib/a.mjs': 'a, mine\n' });
  p.commit('chore: mine');
  let res = into(k, p);
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /^sync: tools\/gate\/lib\/a\.mjs changed in the project since the last sync$/m);
  assert.match(res.err, /nothing written: 1 file\(s\) the project changed/);
  assert.equal(read(p, 'tools/gate/gate.mjs'), 'gate 1\n');
  assert.equal(read(p, LOCK), lockBefore);

  p.write({ 'specs/README.md': '# Specs, uncommitted\n' });
  res = into(k, p);
  assert.match(res.err, /^sync: specs\/README\.md changed in the project since the last sync$/m);

  res = into(k, p, '--dry-run', '--force');
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /^would update tools\/gate\/gate\.mjs$/m);
  assert.match(res.out, /nothing written/);
  assert.equal(read(p, 'tools/gate/gate.mjs'), 'gate 1\n');

  res = into(k, p, '--force');
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(read(p, 'tools/gate/lib/a.mjs'), 'a 1\n');
  assert.equal(read(p, 'specs/README.md'), '# Specs\n');
  assert.equal(read(p, 'tools/gate/gate.mjs'), 'gate 2\n');
});

test('sync: the first sync replaces a hand copy it finds committed, refuses one with uncommitted changes, and reports a file the kit lacks', (t) => {
  const k = kitRepo(t);
  const p = project(t, { 'README.md': '# App\n', 'tools/gate/gate.mjs': 'a hand copy\n', 'tools/gate/notes.mjs': 'mine\n', 'tools/gate/config.json': '{ "mine": true }\n' });
  p.write({ 'specs/README.md': '# Specs, mine\n' });
  let res = into(k, p);
  assert.equal(res.code, 1);
  assert.match(res.err, /^sync: specs\/README\.md has uncommitted changes$/m);
  p.commit('docs: mine');
  res = into(k, p);
  assert.equal(res.code, 1, 'a file the kit lacks under its paths');
  assert.match(res.out, /^replace tools\/gate\/gate\.mjs$/m);
  assert.match(res.out, /^replace specs\/README\.md$/m);
  assert.doesNotMatch(res.out, /start tools\/gate\/config\.json/, 'a project\'s config is never replaced');
  assert.match(res.err, /^sync: tools\/gate\/notes\.mjs is not in the kit; the gate's kit check fails on it/m);
  assert.equal(read(p, 'tools/gate/gate.mjs'), 'gate 1\n');
  assert.equal(read(p, 'tools/gate/notes.mjs'), 'mine\n', 'left alone');
  assert.equal(read(p, 'tools/gate/config.json'), '{ "mine": true }\n');
  assert.ok(exists(p, LOCK));
});

test('sync: a checkout with CRLF line endings holds the same content', (t) => {
  const k = kitRepo(t);
  const p = project(t, { 'README.md': '# App\n', '.gitattributes': '* text eol=crlf\n' });
  assert.equal(into(k, p).code, 0);
  p.commit('chore: take the kit');
  fs.writeFileSync(path.join(p.dir, 'tools', 'gate', 'gate.mjs'), 'gate 1\r\n'); // as a checkout writes it
  assert.equal(git(p.dir, ['diff', '--name-only', 'HEAD']), '', 'git sees no change');
  const res = into(k, p);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /0 added, 0 updated, 0 deleted, 6 unchanged/);
  assert.equal(sync(['--check'], p.dir).code, 0);
});

test('sync: the kit takes back a file the project owned, and drops a folder', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  assert.equal(into(k, p).code, 0);
  p.write({ 'tools/gate/config.json': '{ "mine": true }\n' });
  p.commit('chore: take the kit');
  // the kit now ships tools/gate/config.json itself
  k.write({ 'kit.json': JSON.stringify({ ...MANIFEST, projectOwned: ['tools/kit/lock.json'], starters: {} }) });
  k.commit('feat: the kit owns the config');
  let res = into(k, p);
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /^sync: tools\/gate\/config\.json is the project's own file$/m);
  assert.equal(read(p, 'tools/gate/config.json'), '{ "mine": true }\n', 'nothing written');
  res = into(k, p, '--force');
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(read(p, 'tools/gate/config.json'), '{ "the kit": "its own" }\n');
  p.commit('chore: sync');
  assert.equal(sync(['--check'], p.dir).code, 0, 'the lock and the copy agree');

  // the kit drops tools/kit/ from its paths: its files go, the project's own file there stays and is no stray
  p.write({ 'tools/kit/notes.md': 'mine\n' });
  p.commit('docs: mine');
  k.write({ 'kit.json': JSON.stringify({ ...MANIFEST, paths: ['.agents/skills/spec/', 'specs/README.md', 'tools/gate/'], projectOwned: [], starters: {} }) });
  k.commit('feat: no tools/kit');
  res = into(k, p, '--force');
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^delete tools\/kit\/sync\.mjs$/m);
  assert.doesNotMatch(res.err, /notes\.md/);
  assert.equal(read(p, 'tools/kit/notes.md'), 'mine\n');
});

test('sync: an ignored file where the kit writes stops the sync; a link out of the project is never followed', (t) => {
  const k = kitRepo(t);
  const p = project(t, { 'README.md': '# App\n', '.gitignore': 'specs/README.md\n' });
  p.write({ 'specs/README.md': '# Mine, ignored\n' });
  let res = into(k, p, '--force');
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /^sync: specs\/README\.md is ignored by git, so the committed copy would lack it/m);
  assert.match(res.err, /with or without --force/);
  assert.equal(read(p, 'specs/README.md'), '# Mine, ignored\n');
  p.write({ 'specs/README.md': '# Specs\n' }); // as the kit has it: still never committed
  assert.equal(into(k, p).code, 1);
  p.write({ 'specs/README.md': null });
  assert.equal(into(k, p).code, 1, 'ignored whether or not it is there yet');
  assert.ok(!exists(p, LOCK));
  const l = project(t, { 'README.md': '# App\n', '.gitignore': 'tools/kit/lock.json\ntools/gate/config.json\n' });
  res = into(k, l);
  assert.equal(res.code, 1, 'the lock and a starter too');
  assert.match(res.err, /^sync: tools\/kit\/lock\.json is ignored by git/m);
  assert.match(res.err, /^sync: tools\/gate\/config\.json is ignored by git/m);

  const q = project(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(q.dir, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(q.dir, '.agents', 'skills', 'spec'), 'junction');
  res = into(k, q, '--dry-run');
  assert.equal(res.code, 1, 'a dry run says so too');
  assert.match(res.err, /^sync: \.agents\/skills\/spec\/SKILL\.md lies through a link outside the project/m);
  res = into(k, q, '--force');
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /lies through a link outside the project/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside');
  assert.ok(!exists(q, LOCK), 'nothing written inside either');

  // a delete through a link: the kit drops a file whose folder is now a junction elsewhere
  const r = project(t);
  assert.equal(into(k, r).code, 0);
  r.commit('chore: take the kit');
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-away-'));
  t.after(() => fs.rmSync(away, { recursive: true, force: true }));
  fs.writeFileSync(path.join(away, 'a.mjs'), 'a 1\n');
  fs.rmSync(path.join(r.dir, 'tools', 'gate', 'lib'), { recursive: true });
  fs.symlinkSync(away, path.join(r.dir, 'tools', 'gate', 'lib'), 'junction');
  k.write({ 'tools/gate/lib/a.mjs': null });
  k.commit('feat: no a');
  res = into(k, r, '--force');
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /^sync: tools\/gate\/lib\/a\.mjs lies through a link outside the project/m);
  assert.equal(fs.readFileSync(path.join(away, 'a.mjs'), 'utf8'), 'a 1\n', 'never deleted');
});

test('sync: a kit file that is itself a link is refused', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  const target = path.join(p.dir, 'elsewhere.md');
  fs.writeFileSync(target, 'mine\n');
  fs.mkdirSync(path.join(p.dir, 'specs'));
  try {
    fs.symlinkSync(target, path.join(p.dir, 'specs', 'README.md'), 'file');
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('this account may not create file links');
    throw e;
  }
  const res = into(k, p, '--force');
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.err, /^sync: specs\/README\.md is a link: sync writes and deletes only real files inside the project$/m);
  assert.equal(fs.readFileSync(target, 'utf8'), 'mine\n');
});

test('sync: a folder named like ..cache is inside the project', (t) => {
  const p = project(t);
  fs.mkdirSync(path.join(p.dir, '..cache'));
  assert.doesNotThrow(() => assertInside(p.dir, path.join(p.dir, '..cache', 'x.md')));
  assert.ok(inside(path.join(p.dir, '..cache'), p.dir));
  assert.ok(!inside(path.join(p.dir, '..'), p.dir) && !inside(path.join(p.dir, '..', 'sibling'), p.dir));
});

test('sync: a project that stores SHA-256 objects is refused', (t) => {
  const k = kitRepo(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-sha256-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (spawnSync('git', ['init', '-q', '--object-format=sha256', dir], { windowsHide: true }).status !== 0) return t.skip('this git makes no SHA-256 repositories');
  const res = sync(['--kit', k.dir, '--ref', 'main', '--project', dir], dir);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /stores SHA-256 objects/);
});

test('sync: usage and setup errors exit 2', (t) => {
  const k = kitRepo(t);
  const p = project(t);
  assert.equal(sync(['--bogus'], p.dir).code, 2);
  assert.equal(sync(['--check', '--force'], p.dir).code, 2);
  assert.equal(sync(['--rev', 'HEAD'], p.dir).code, 2);
  let res = into(k, p, '--ref', 'no-such-ref');
  assert.equal(res.code, 2);
  assert.match(res.err, /no-such-ref does not resolve/);
  res = sync(['--kit', k.dir, '--ref', 'main', '--project', k.dir], p.dir);
  assert.equal(res.code, 2);
  assert.match(res.err, /the project is the kit itself/);
  res = sync(['--kit', p.dir, '--ref', 'main', '--project', k.dir], p.dir);
  assert.equal(res.code, 2);
  assert.match(res.err, /no kit\.json at/);
  fs.mkdirSync(path.join(p.dir, 'tools', 'kit'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, LOCK), '{');
  res = into(k, p);
  assert.equal(res.code, 2);
  assert.match(res.err, /tools\/kit\/lock\.json does not read/);
});

test('sync: kit.json and the repository URL', () => {
  assert.deepEqual(parseManifest(JSON.stringify(MANIFEST)), MANIFEST);
  assert.deepEqual(parseManifest(JSON.stringify({ ...MANIFEST, starters: undefined })).starters, {});
  assert.throws(() => parseManifest('{'), /not JSON/);
  assert.throws(() => parseManifest(JSON.stringify({ ...MANIFEST, paths: [] })), /"paths" is a non-empty list/);
  assert.throws(() => parseManifest(JSON.stringify({ ...MANIFEST, starters: { 'x.json': 'y.json' } })), /starters: x\.json is not in "projectOwned"/);
  assert.equal(publicUrl('https://user:token@github.com/org/kit.git'), 'https://github.com/org/kit.git');
  assert.equal(publicUrl('git@github.com:org/kit.git'), 'git@github.com:org/kit.git');
  assert.equal(publicUrl(null), null);
  assert.equal(publicUrl('ssh://git:secret@example.invalid/org/kit.git'), 'ssh://example.invalid/org/kit.git');
  for (const local of ['C:/Users/someone/kit', 'C:\\Users\\someone\\kit', '/home/someone/kit', '../kit', 'file:///C:/kit']) assert.equal(publicUrl(local), null, local);
  assert.equal(publicUrl('github.com:org/kit.git'), 'github.com:org/kit.git', 'scp-like with no user');
  assert.equal(publicUrl('git@example.invalid:/srv/kit.git'), 'git@example.invalid:/srv/kit.git', 'scp-like with an absolute path');
  assert.equal(publicUrl('https://example.invalid/org/kit.git?token=x#y'), 'https://example.invalid/org/kit.git');
});

test('sync: a config that leaves the lock unprotected is reported', (t) => {
  const p = project(t, { 'tools/gate/config.json': JSON.stringify({ protectedPaths: ['tools/gate/**'] }) });
  assert.match(lockUnprotected(p.dir), /add "tools\/kit\/\*\*" to "protectedPaths"/);
  p.write({ 'tools/gate/config.json': JSON.stringify({ protectedPaths: ['tools/kit/**'] }) });
  assert.equal(lockUnprotected(p.dir), null);
  p.write({ 'tools/gate/config.json': null });
  assert.equal(lockUnprotected(p.dir), null, 'no config: the gate says so itself');
});
