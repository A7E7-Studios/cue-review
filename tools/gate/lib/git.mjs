// Git access for the gate and the overview. Every read of a revision goes through git objects,
// never the working tree: in CI the working tree is main's checkout and the PR head is data, and
// the overview reads a repository at a ref whatever its checkout holds.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_BUFFER = 1 << 30;

/** The byte-order mark, U+FEFF, as an editor on Windows may save at a file's start. */
export const BOM = String.fromCharCode(0xfeff);

/** `s` without a leading byte-order mark. */
export function stripBom(s) {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

/** Runs git in `cwd`. Returns stdout (string, or Buffer with `raw`). Throws on a non-zero exit unless `allowFail`. */
export function runGit(cwd, args, { input, raw = false, allowFail = false, env } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    input,
    encoding: raw ? undefined : 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.error) throw r.error;
  if (allowFail) return { status: r.status, stdout: r.stdout, stderr: String(r.stderr ?? '') };
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr ?? '').trim()}`);
  }
  return r.stdout;
}

/**
 * Splits `git cat-file --batch` output into the bodies of `shas`, in order. Each record must be
 * `<sha> blob <size>\n<body>\n` for the sha asked for; a `missing` record, another sha or type, a
 * bad size or a short read throws, so one bad record can never shift the rest onto wrong paths.
 */
export function parseCatFileBatch(out, shas) {
  const bodies = [];
  let off = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) throw new Error(`git cat-file --batch: no record for ${sha}`);
    const header = out.subarray(off, nl).toString('utf8');
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+) (\d+)$/.exec(header);
    if (!m) throw new Error(`git cat-file --batch: "${header}" for ${sha}`);
    if (m[1] !== sha) throw new Error(`git cat-file --batch: answered ${m[1]} for ${sha}`);
    if (m[2] !== 'blob') throw new Error(`git cat-file --batch: ${sha} is a ${m[2]}, not a blob`);
    const size = Number(m[3]);
    const end = nl + 1 + size;
    if (end >= out.length || out[end] !== 0x0a) throw new Error(`git cat-file --batch: ${sha} is cut short`);
    bodies.push(Buffer.from(out.subarray(nl + 1, end)));
    off = end + 1;
  }
  return bodies;
}

/** A repository read at fixed revisions, with caches for trees and blobs. */
export class Repo {
  constructor(dir) {
    this.dir = dir;
    this._trees = new Map();
    this._blobs = new Map();
  }

  /** The repository holding `cwd`: its top level, or `cwd` itself for a bare repository. */
  static open(cwd = process.cwd()) {
    const r = runGit(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (r.status === 0 && String(r.stdout).trim()) return new Repo(String(r.stdout).trim());
    runGit(cwd, ['rev-parse', '--git-dir']);
    return new Repo(cwd);
  }

  git(args, opts) {
    return runGit(this.dir, args, opts);
  }

  /** Full commit SHA for a ref, or null when it does not resolve. */
  resolve(ref) {
    const r = this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    return r.status === 0 ? String(r.stdout).trim() : null;
  }

  mergeBase(a, b) {
    const r = this.git(['merge-base', a, b], { allowFail: true });
    return r.status === 0 ? String(r.stdout).trim() : null;
  }

  /** A git config value, or null. */
  config(key) {
    const r = this.git(['config', '--get', key], { allowFail: true });
    return r.status === 0 ? String(r.stdout).trim() : null;
  }

  /** Every file at `rev`: { files: Map path -> { mode, sha, size }, dirs: Set of every directory ('' is the root) }. */
  tree(rev) {
    if (this._trees.has(rev)) return this._trees.get(rev);
    const out = this.git(['ls-tree', '-r', '-z', '-l', '--full-tree', rev]);
    const files = new Map();
    const dirs = new Set(['']);
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;
      const p = rec.slice(tab + 1);
      files.set(p, { mode, sha, size: size === '-' ? 0 : Number(size) });
      let d = path.posix.dirname(p);
      while (d && d !== '.' && !dirs.has(d)) {
        dirs.add(d);
        d = path.posix.dirname(d);
      }
    }
    const t = { files, dirs };
    this._trees.set(rev, t);
    return t;
  }

  has(rev, p) {
    return this.tree(rev).files.has(p);
  }

  hasDir(rev, p) {
    return this.tree(rev).dirs.has(p.replace(/\/+$/, ''));
  }

  /** Blob bytes at rev:path, or null when the path is absent. */
  blob(rev, p) {
    const key = `${rev}:${p}`;
    if (this._blobs.has(key)) return this._blobs.get(key);
    let buf = null;
    const e = this.tree(rev).files.get(p);
    if (e && e.mode !== '160000') buf = this.git(['cat-file', 'blob', e.sha], { raw: true });
    this._blobs.set(key, buf);
    return buf;
  }

  /**
   * Reads the blobs of many paths at `rev` in one `git cat-file --batch`, into the cache that
   * blob() and text() answer from: hundreds of docs cost one process, not hundreds.
   */
  prefetch(rev, paths) {
    const files = this.tree(rev).files;
    const want = [...new Set(paths)].filter((p) => !this._blobs.has(`${rev}:${p}`) && files.has(p) && files.get(p).mode !== '160000');
    if (want.length === 0) return;
    const shas = want.map((p) => files.get(p).sha);
    const out = this.git(['cat-file', '--batch'], { input: shas.join('\n') + '\n', raw: true });
    parseCatFileBatch(out, shas).forEach((body, i) => this._blobs.set(`${rev}:${want[i]}`, body));
  }

  /** Blob text (UTF-8, BOM dropped) at rev:path, or null. */
  text(rev, p) {
    const b = this.blob(rev, p);
    return b === null ? null : stripBom(b.toString('utf8'));
  }

  /** Name-status between two commits, renames off: [{ status: 'A'|'M'|'D'|'T', path }]. */
  changes(from, to) {
    const out = this.git(['diff', '--name-status', '-z', '--no-renames', from, to]);
    const parts = out.split('\0').filter((x) => x !== '');
    const list = [];
    for (let i = 0; i + 1 < parts.length; i += 2) list.push({ status: parts[i][0], path: parts[i + 1] });
    return list;
  }

  /** Unified diff with no context, limited to pathspecs. */
  diffU0(from, to, pathspecs = []) {
    return this.git(['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--', ...pathspecs]);
  }

  /** Commits in from..to, oldest first: [{ sha, message }]. */
  commits(from, to) {
    const out = this.git(['log', '--reverse', '--format=%H%x00%B%x1e', `${from}..${to}`]);
    return out
      .split('\x1e')
      .map((s) => s.replace(/^\s+/, ''))
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('\0');
        return { sha: s.slice(0, i), message: s.slice(i + 1).trim() };
      });
  }

  /**
   * The newest commit on `rev`'s first-parent line that added `p`: { commit, date, subject }, or
   * null. On a squash-merged main that is the merge of the PR that brought the file.
   */
  addedBy(rev, p) {
    // log.follow would chase a renamed folder back to its first name; a rename lands it anew. (A
    // diff limited to one path never pairs a rename, so diff.renames cannot.)
    const out = this.git(['-c', 'log.follow=false', 'log', '--first-parent', '--diff-filter=A', '-n', '1', '--format=%H%x00%cI%x00%s', rev, '--', p]);
    const line = out.trim();
    if (!line) return null;
    const [commit, date, subject] = line.split('\0');
    return { commit, date, subject };
  }
}
