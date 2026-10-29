#!/usr/bin/env node
// Agent setup for one checkout or worktree: `node tools/setup-agents/setup.mjs`, run once in each.
// Idempotent; Node >= 20, no dependencies.
//
// Links every `.agents/skills` folder in the tree into its sibling `.claude/skills`, so Claude Code
// (which reads only `.claude/skills`) sees the same skills Codex reads from `.agents/skills`. A
// junction on Windows (no admin or Developer Mode needed), a relative symlink elsewhere. A link that
// already points at its sibling is left as it is; a link pointing anywhere else is replaced (a
// worktree must use its own branch's skills). A real `.claude/skills` folder is never deleted unless
// it is empty: one with content is reported, and the run exits 1.
//
// `--unlink` removes every `.claude/skills` link it made, and does nothing else.
//
// Folders are found through git (tracked and untracked-but-not-ignored files), so build output,
// node_modules and nested worktrees are never walked.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems = [];

const log = (msg) => console.log(`setup: ${msg}`);
const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const gitTry = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const same = (a, b) => {
  const norm = (p) => path.resolve(p.replace(/^\\\\\?\\/, ''));
  return isWindows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function skillFolders() {
  const files = git(
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.agents/skills/**',
  ).split('\0');
  const folders = new Set();
  for (const file of files) {
    const m = /^(?:(.*)\/)?\.agents\/skills\//.exec(file);
    if (m && !file.includes('.claude/worktrees/')) folders.add(m[1] ?? '');
  }
  return [...folders].sort().map((dir) => path.join(root, dir));
}

function makeLink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (isWindows) fs.symlinkSync(target, link, 'junction');
  else fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir');
}

function removeLink(link) {
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // a junction some Node builds will not unlink; removes the link, never the target
  }
}

function linkSkills() {
  const folders = skillFolders();
  if (folders.length === 0) log('no .agents/skills folders yet; nothing to link');
  for (const dir of folders) {
    const target = path.join(dir, '.agents', 'skills');
    const link = path.join(dir, '.claude', 'skills');
    const stat = lstat(link);
    if (stat === null) {
      makeLink(target, link);
      log(`linked ${rel(link)} -> ${rel(target)}`);
    } else if (stat.isSymbolicLink()) {
      const current = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (same(current, target)) {
        log(`ok ${rel(link)}`);
      } else {
        removeLink(link);
        makeLink(target, link);
        log(`relinked ${rel(link)} -> ${rel(target)} (it pointed at ${current})`);
      }
    } else if (stat.isDirectory() && fs.readdirSync(link).length === 0) {
      fs.rmdirSync(link);
      makeLink(target, link);
      log(`linked ${rel(link)} -> ${rel(target)} (replaced an empty folder)`);
    } else {
      problems.push(
        `${rel(link)} is a real ${stat.isDirectory() ? 'folder' : 'file'}, left alone: move what it holds ` +
          `into ${rel(target)} or delete it, then run setup again`,
      );
      continue;
    }
    if (gitTry('check-ignore', '-q', rel(link)) === null) {
      problems.push(`${rel(link)} is not ignored by git: add an anchored /${rel(link)} entry to .gitignore`);
    }
  }
}

function unlinkSkills() {
  // Siblings of this branch's skill folders, and any ignored `.claude/skills` an older layout left.
  const links = new Set(skillFolders().map((dir) => path.join(dir, '.claude', 'skills')));
  const ignored = git(
    'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--',
    ':(glob)**/.claude/skills',
  ).split('\0');
  for (const p of ignored) {
    const link = p.replace(/\/$/, '');
    // Only a `.claude/skills` itself; never nested worktrees, which git lists as one ignored folder.
    if (/(^|\/)\.claude\/skills$/.test(link) && !link.includes('.claude/worktrees/')) {
      links.add(path.join(root, link));
    }
  }
  let removed = 0;
  for (const link of [...links].sort()) {
    const stat = lstat(link);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      removeLink(link);
      removed++;
      log(`unlinked ${rel(link)}`);
    } else {
      log(`left ${rel(link)} alone: a real ${stat.isDirectory() ? 'folder' : 'file'}, not a link`);
    }
  }
  if (removed === 0) log('no links to remove');
}

const args = process.argv.slice(2);
if (args.some((a) => a !== '--unlink')) {
  console.error('usage: node tools/setup-agents/setup.mjs [--unlink]');
  process.exit(2);
}
const top = gitTry('rev-parse', '--show-toplevel')?.trim();
if (!top) {
  console.error(`setup: ${root} is not a git checkout, or git is not on PATH; run setup inside a clone or worktree`);
  process.exit(1);
}
if (!same(top, root)) {
  console.error(`setup: this script belongs at tools/setup-agents/ of a checkout's root, but git's root is ${top}`);
  process.exit(1);
}

if (args.includes('--unlink')) {
  unlinkSkills();
} else {
  linkSkills();
}

if (problems.length > 0) {
  for (const p of problems) console.error(`setup: PROBLEM ${p}`);
  process.exit(1);
}
log('done');
