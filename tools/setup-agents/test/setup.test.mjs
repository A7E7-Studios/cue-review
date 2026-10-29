// setup.mjs in a throwaway checkout: it links .agents/skills into .claude/skills, keeps a link that
// is right, reports what it must not touch, and --unlink removes only its links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../../gate/test/helpers.mjs';

const SETUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'setup.mjs');

function checkout(t, files = {}) {
  const r = makeRepo({ 'README.md': '# App\n', '.gitignore': '/.claude/skills\n', '.agents/skills/spec/SKILL.md': 'spec\n', ...files }, { prefix: 'setup-agents-' });
  fs.mkdirSync(path.join(r.dir, 'tools', 'setup-agents'), { recursive: true });
  fs.copyFileSync(SETUP, path.join(r.dir, 'tools', 'setup-agents', 'setup.mjs'));
  t.after(() => r.cleanup());
  return r;
}

function setup(r, ...args) {
  const res = spawnSync(process.execPath, [path.join(r.dir, 'tools', 'setup-agents', 'setup.mjs'), ...args], { cwd: r.dir, encoding: 'utf8', windowsHide: true });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const link = (r, dir = '') => path.join(r.dir, ...dir.split('/').filter(Boolean), '.claude', 'skills');

test('setup-agents: links each .agents/skills, keeps a right link, and --unlink removes only the links', (t) => {
  const r = checkout(t, { '.gitignore': '/.claude/skills\n/tools/x/.claude/skills\n', 'tools/x/.agents/skills/local/SKILL.md': 'local\n' });
  let res = setup(r);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^setup: linked \.claude\/skills -> \.agents\/skills$/m);
  assert.match(res.out, /^setup: linked tools\/x\/\.claude\/skills -> tools\/x\/\.agents\/skills$/m);
  assert.ok(fs.lstatSync(link(r)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(link(r), 'spec', 'SKILL.md'), 'utf8'), 'spec\n');
  assert.equal(fs.readFileSync(path.join(link(r, 'tools/x'), 'local', 'SKILL.md'), 'utf8'), 'local\n');
  res = setup(r);
  assert.equal(res.code, 0);
  assert.match(res.out, /^setup: ok \.claude\/skills$/m);
  res = setup(r, '--unlink');
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /^setup: unlinked \.claude\/skills$/m);
  assert.ok(!fs.existsSync(link(r)) && !fs.existsSync(link(r, 'tools/x')));
  assert.equal(fs.readFileSync(path.join(r.dir, '.agents', 'skills', 'spec', 'SKILL.md'), 'utf8'), 'spec\n', 'the skills stay');
});

test('setup-agents: a real .claude/skills with content and a link git does not ignore are reported; an empty folder is replaced', (t) => {
  const r = checkout(t, { '.gitignore': '' });
  let res = setup(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /PROBLEM \.claude\/skills is not ignored by git: add an anchored \/\.claude\/skills entry/);
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '/.claude/skills\n');
  fs.rmSync(link(r), { recursive: true, force: true });
  fs.mkdirSync(link(r), { recursive: true });
  res = setup(r);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /replaced an empty folder/);
  setup(r, '--unlink');
  fs.mkdirSync(path.join(link(r), 'mine'), { recursive: true });
  fs.writeFileSync(path.join(link(r), 'mine', 'SKILL.md'), 'mine\n');
  res = setup(r);
  assert.equal(res.code, 1);
  assert.match(res.err, /PROBLEM \.claude\/skills is a real folder, left alone/);
  assert.equal(fs.readFileSync(path.join(link(r), 'mine', 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(setup(r, '--bogus').code, 2);
});
