// A project's copy of the kit, as tools/kit/lock.json records it: the kit commit it was synced
// from, the paths the kit owns there, and each file's git blob id. Read by the gate's `kit` check
// (does the copy at a revision still match its lock?) and written by tools/kit/sync.mjs.
import crypto from 'node:crypto';
import { pathProblem } from './spec.mjs';

/** Where a project keeps its lock. */
export const LOCK_FILE = 'tools/kit/lock.json';
export const LOCK_VERSION = 1;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** blobId gives SHA-1 ids, so a lock's file ids are 40 hex. */
const BLOB = /^[0-9a-f]{40}$/;
const isId = (re, v) => typeof v === 'string' && re.test(v);

/** The git blob id of `bytes` (SHA-1), what `git hash-object` prints for the same content. */
export function blobId(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** Whether the kit owns `p`: a listed folder (ending `/`) holds it, or a listed file is it. */
export function owns(paths, p) {
  return paths.some((k) => (k.endsWith('/') ? p.startsWith(k) : p === k));
}

/**
 * Reads the kit's owned paths (`paths`, `projectOwned`), shared by kit.json in the kit and the
 * lock in a project. Returns problems as strings.
 */
export function ownedPathProblems(o) {
  const out = [];
  if (!Array.isArray(o.paths) || o.paths.length === 0 || !o.paths.every((p) => typeof p === 'string')) {
    out.push('"paths" is a non-empty list of the folders (ending /) and files the kit owns');
  } else {
    for (const p of o.paths) if (pathProblem(p)) out.push(`paths: ${pathProblem(p)}`);
  }
  if (!Array.isArray(o.projectOwned) || !o.projectOwned.every((p) => typeof p === 'string')) {
    out.push('"projectOwned" is a list of the files inside the kit\'s paths that each project keeps as its own');
  } else if (Array.isArray(o.paths)) {
    for (const p of o.projectOwned) {
      if (pathProblem(p) || p.endsWith('/')) out.push(`projectOwned: "${p}" is a file path`);
      else if (!owns(o.paths, p)) out.push(`projectOwned: ${p} is not inside the kit's paths`);
    }
  }
  return out;
}

/** Parses a lock's text. Returns { lock, problems }, lock null when it cannot be read at all. */
export function parseLock(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return { lock: null, problems: [`not JSON: ${e.message}`] };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { lock: null, problems: ['a JSON object: { version, kit, paths, projectOwned, files }'] };
  const problems = [];
  if (o.version !== LOCK_VERSION) problems.push(`"version" is ${LOCK_VERSION}, not ${JSON.stringify(o.version)}`);
  const kit = o.kit;
  if (!kit || typeof kit !== 'object' || !isId(COMMIT, kit.commit) || !(kit.repository === null || typeof kit.repository === 'string')) {
    problems.push('"kit" is { "repository": <url or null>, "commit": <the kit commit, full sha> }');
  }
  problems.push(...ownedPathProblems(o));
  const files = o.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) problems.push('"files" is { <path>: <git blob id> }');
  else {
    for (const [p, id] of Object.entries(files)) {
      if (!isId(BLOB, id)) problems.push(`files: ${p} has no git blob id (40 hex)`);
      if (pathProblem(p) || p.endsWith('/')) problems.push(`files: "${p}" is not a file path`);
      else if (Array.isArray(o.paths) && !owns(o.paths, p)) problems.push(`files: ${p} is not inside the kit's paths`);
    }
  }
  if (problems.length) return { lock: null, problems };
  return { lock: o, problems: [] };
}

/**
 * What differs between a project's kit copy at `rev` and its lock, as
 * { lock, problems: [{ file, message }] }; null when there is no lock at `rev`. A file the lock
 * lists is missing or holds other bytes; a file under a path the kit owns is neither in the lock
 * nor one the project owns.
 */
export function kitProblems(repo, rev) {
  const text = repo.text(rev, LOCK_FILE);
  if (text === null) return null;
  const { lock, problems } = parseLock(text);
  if (!lock) return { lock: null, problems: problems.map((message) => ({ file: LOCK_FILE, message })) };
  const at = `the kit at ${lock.kit.commit.slice(0, 9)}`;
  const files = Object.keys(lock.files).sort();
  repo.prefetch(rev, files);
  const out = [];
  for (const p of files) {
    const bytes = repo.blob(rev, p);
    if (bytes === null) out.push({ file: p, message: `missing: ${at} has it; put it back with node tools/kit/sync.mjs` });
    else if (blobId(bytes) !== lock.files[p]) {
      out.push({ file: p, message: `differs from ${at}, which ${LOCK_FILE} records: put it back with node tools/kit/sync.mjs, or change it in the kit and sync` });
    }
  }
  for (const p of [...repo.tree(rev).files.keys()].sort()) {
    if (!owns(lock.paths, p) || Object.hasOwn(lock.files, p) || lock.projectOwned.includes(p)) continue;
    out.push({ file: p, message: `not in ${at}: a path the kit owns holds only the kit's files and the project's own (${lock.projectOwned.join(', ') || 'none'}); move it, or add it to the kit and sync` });
  }
  return { lock, problems: out };
}
