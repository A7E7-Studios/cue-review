// The repositories the map reads: which ones, fetching them, and what state each is in.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Runs git in a folder; resolves `{ ok, out, err }`, never rejects. */
export function git(dir, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (e, out, err) => {
      resolve({ ok: !e, out, err: String(err || (e && e.message) || '') });
    });
  });
}

/**
 * The repositories to read: every `--repo <id>=<folder>`, else the config's `solutionMap.repos`
 * (`[{ id, path }]`, paths relative to `root`). Throws on a bad or repeated id.
 */
export function resolveRepos({ args = [], config = null, root = process.cwd() } = {}) {
  let list;
  if (args.length) {
    list = args.map((a) => {
      const eq = a.indexOf('=');
      if (eq <= 0 || eq === a.length - 1) throw new Error(`--repo takes <id>=<folder>, not "${a}"`);
      return { id: a.slice(0, eq), dir: path.resolve(a.slice(eq + 1)) };
    });
  } else {
    const named = config?.solutionMap?.repos;
    if (!Array.isArray(named) || !named.length) throw new Error('name the repositories: --repo <id>=<folder>, or solutionMap.repos in tools/gate/config.json');
    list = named.map((r) => {
      if (!r || typeof r.id !== 'string' || typeof r.path !== 'string') throw new Error('solutionMap.repos holds { "id", "path" } entries');
      return { id: r.id, dir: path.resolve(root, r.path) };
    });
  }
  const seen = new Set();
  for (const r of list) {
    if (!REPO_ID.test(r.id)) throw new Error(`repo id "${r.id}" is lowercase letters, digits and -`);
    if (seen.has(r.id)) throw new Error(`repo id "${r.id}" given twice`);
    seen.add(r.id);
  }
  return list;
}

/** `tools/gate/config.json` under a folder, or null. */
export function readConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'tools', 'gate', 'config.json'), 'utf8')); } catch { return null; }
}

/** Whether a folder is a git repository with an `origin/main` (or the ref given). */
export async function hasRef(dir, ref = 'origin/main') {
  if (!fs.existsSync(dir)) return false;
  return (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
}

/** The time of the last good fetch: `FETCH_HEAD`'s modification time, or null. */
export async function lastFetch(dir) {
  const r = await git(dir, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (!r.ok) return null;
  const p = path.resolve(dir, String(r.out).trim());
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

/**
 * Fetches one repository and says what state it is in: `current` (fetched now), `stale` (the fetch
 * failed; its existing `origin/main` stays), or `missing` (no repository with `origin/main` there).
 */
export async function fetchRepo(dir, { ref = 'origin/main', fetch = (d) => git(d, ['fetch', '--quiet', 'origin']) } = {}) {
  if (!(await hasRef(dir, ref))) return { state: 'missing', fetchedAt: null, dir };
  const f = await fetch(dir);
  if (f.ok) return { state: 'current', fetchedAt: new Date().toISOString(), dir };
  return { state: 'stale', fetchedAt: await lastFetch(dir), dir, error: f.err.trim().split('\n').pop() || 'fetch failed' };
}

/** The GitHub web base of a repository's origin, or null. */
export async function remoteUrl(dir) {
  const r = await git(dir, ['remote', 'get-url', 'origin']);
  return r.ok ? String(r.out).trim() : null;
}

/** A file at a commit, or null. */
export async function readAt(dir, commit, p) {
  const r = await git(dir, ['show', `${commit}:${p}`]);
  return r.ok ? r.out : null;
}
