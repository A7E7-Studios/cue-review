#!/usr/bin/env node
// The overview index: each repository's capabilities, scenarios and their human review state,
// the changes waiting for review, and the modules, as one JSON document a viewer renders.
// Every repository is read at a ref through git objects; its checkout's state never matters.
//
//   node tools/overview/overview.mjs --repo app=../app --repo backend=../backend \
//     [--ref origin/main] [--out overview.json] [--assets <dir>] [--summary]
//
// Exit: 0 written, 2 usage or setup error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Repo, runGit } from '../gate/lib/git.mjs';
import { parseSpec, parseChange, SPEC_FILE, humanState, capabilityState } from '../gate/lib/spec.mjs';
import { firstHeading, firstParagraph, plainText, clip } from '../gate/lib/markdown.mjs';
import { matches } from '../gate/lib/glob.mjs';

/** Folders that never hold a module, in every repository. */
export const MODULE_EXCLUDES = ['specs', 'changes', '.agents', '.github'];
/** Module globs left out when a repository's tools/gate/config.json names no `overview.excludeModules`. */
export const DEFAULT_EXCLUDE_MODULES = ['dev/**', 'docs/**', '**/proof/**', 'fixtures/**', '**/test/fixtures/**'];
/** The file names that make a folder a module when a repository's tools/gate/config.json names no `overview.moduleMarkers`. */
export const DEFAULT_MODULE_MARKERS = ['README.md', 'package.json', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', '*.asmdef'];
const REPO_ID = /^[a-z0-9][a-z0-9-]*$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize (\d+)\r?\n/;

/** `<id>=<dir>[@<ref>]` -> { id, dir, ref }. */
export function parseRepoArg(arg, defaultRef = 'origin/main') {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new Error(`--repo takes <id>=<git dir>[@<ref>], not "${arg}"`);
  const id = arg.slice(0, eq);
  if (!REPO_ID.test(id)) throw new Error(`repo id "${id}" is lowercase letters, digits and -`);
  let dir = arg.slice(eq + 1);
  let ref = defaultRef;
  const at = dir.lastIndexOf('@');
  if (at > 0 && !fs.existsSync(dir)) {
    ref = dir.slice(at + 1);
    dir = dir.slice(0, at);
  }
  if (!dir || !ref) throw new Error(`--repo takes <id>=<git dir>[@<ref>], not "${arg}"`);
  return { id, dir, ref };
}

/** `owner/name` from the origin URL, else the folder's name. */
function repoName(repo, dir) {
  const url = repo.config('remote.origin.url');
  const m = url && /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : path.basename(path.resolve(dir));
}

function readJson(repo, rev, p) {
  const t = repo.text(rev, p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** A repository's tools/gate/config.json at `commit`, or {} when it has none or it does not parse. */
function readConfig(repo, commit) {
  const c = readJson(repo, commit, 'tools/gate/config.json');
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

/** The folder a file stands in: '.' for the root. */
const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/** A test assembly: its name or folder ends with Tests (PlayTests, EditModeTests, PlayModeTests too) or its name holds `.Tests`. */
export function isTestAssembly(name, folder) {
  const base = path.posix.basename(folder);
  return /Tests$/.test(name) || /Tests$/.test(base) || name.includes('.Tests');
}

/**
 * A pyproject.toml's `name` and `description`: from its [project] table, else its [tool.poetry]
 * table; each null when absent. Reads one-line strings only, which is what these two keys hold.
 */
export function pyprojectInfo(text) {
  const tables = { project: {}, 'tool.poetry': {} };
  let table = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    const h = /^\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(l);
    if (h) {
      table = h[1].replace(/\s*\.\s*/g, '.').replace(/"/g, '');
      continue;
    }
    const kv = /^(name|description)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(l);
    if (!kv || !(table in tables)) continue;
    let v = kv[2].slice(1, -1);
    if (kv[2][0] === '"') {
      try {
        v = JSON.parse(kv[2]);
      } catch {
        // a TOML escape JSON lacks: keep the text between the quotes
      }
    }
    tables[table][kv[1]] ??= v;
  }
  const pick = (k) => tables.project[k] ?? tables['tool.poetry'][k] ?? null;
  return { name: pick('name') || null, description: pick('description') || null };
}

/** A package manifest's `name` and `description`, for the manifests the overview can read; nulls otherwise. */
function manifestInfo(repo, commit, p) {
  const name = path.posix.basename(p);
  if (name === 'package.json') {
    const pkg = readJson(repo, commit, p) ?? {};
    const s = (v) => (typeof v === 'string' && v ? v : null);
    return { name: s(pkg.name), description: s(pkg.description) };
  }
  if (name === 'pyproject.toml') return pyprojectInfo(repo.text(commit, p));
  return { name: null, description: null };
}

/**
 * The modules of a repository at `commit`: every folder holding a file a module marker matches
 * (tools/gate/config.json `overview.moduleMarkers`, file-name globs; DEFAULT_MODULE_MARKERS when it
 * names none), a `*.asmdef` counting only when it is not a test assembly, never under node_modules,
 * outside MODULE_EXCLUDES and the repository's own `ignore` and `overview.excludeModules` globs
 * (DEFAULT_EXCLUDE_MODULES when it names none). Returns Map folder -> module.
 */
export function findModules(repo, commit, repoId, config = readConfig(repo, commit)) {
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const exclude = Array.isArray(config.overview?.excludeModules) ? config.overview.excludeModules : DEFAULT_EXCLUDE_MODULES;
  const markers = Array.isArray(config.overview?.moduleMarkers) ? config.overview.moduleMarkers : DEFAULT_MODULE_MARKERS;
  const rank = (name) => markers.findIndex((m) => matches(name, m));
  const found = new Map();
  const at = (folder) => {
    if (!found.has(folder)) found.set(folder, { readme: null, asmdefs: [], manifests: [], marked: false });
    return found.get(folder);
  };
  for (const p of [...repo.tree(commit).files.keys()].sort(cmp)) {
    const name = path.posix.basename(p);
    const marker = rank(name) >= 0;
    if (!marker && name !== 'README.md') continue;
    const folder = folderOf(p);
    if (MODULE_EXCLUDES.some((e) => folder === e || folder.startsWith(`${e}/`))) continue;
    if (p.split('/').includes('node_modules') || matches(p, ignore) || matches(p, exclude)) continue;
    const f = at(folder);
    if (name === 'README.md') {
      // A module's README gives its title and summary even where README.md is no marker.
      f.readme = p;
      f.marked ||= marker;
    } else if (name.endsWith('.asmdef')) {
      const asm = readJson(repo, commit, p);
      const asmName = typeof asm?.name === 'string' && asm.name ? asm.name : name.replace(/\.asmdef$/, '');
      if (isTestAssembly(asmName, folder)) continue;
      f.asmdefs.push(asmName);
      f.marked = true;
    } else {
      f.manifests.push(p);
      f.marked = true;
    }
  }
  const modules = new Map();
  for (const [folder, f] of found) {
    if (!f.marked) continue;
    const text = f.readme ? repo.text(commit, f.readme) ?? '' : '';
    const manifests = f.manifests.sort((a, b) => rank(path.posix.basename(a)) - rank(path.posix.basename(b)) || cmp(a, b));
    const infos = manifests.map((m) => manifestInfo(repo, commit, m));
    const pkgName = infos.find((i) => i.name)?.name ?? null;
    const description = infos.find((i) => i.description)?.description ?? null;
    const assembly = f.asmdefs[0] ?? null;
    modules.set(folder, {
      repo: repoId,
      path: folder,
      readme: f.readme,
      assembly,
      package: pkgName,
      manifest: manifests[0] ?? null,
      title: (f.readme && firstHeading(text)) || assembly || pkgName || (folder === '.' ? repoId : path.posix.basename(folder)),
      summary: (f.readme && firstParagraph(text, 300)) || (description ? clip(plainText(description), 300) : ''),
      capabilities: [],
    });
  }
  return modules;
}

/**
 * Builds the overview from repositories [{ id, dir, ref }] (the first given wins a shared
 * capability's title and purpose). Returns the overview object; assets stay null until copyAssets.
 */
export function buildOverview(repos, { now = new Date() } = {}) {
  const out = { version: 2, generatedAt: now.toISOString(), assetsDir: null, repos: [], domains: [], capabilities: [], changes: [], modules: [], totals: null };
  const domains = new Map();
  const caps = new Map();
  const changes = new Map();
  const handles = new Map();
  const ids = new Set();
  for (const r of repos) {
    if (ids.has(r.id)) throw new Error(`repo id "${r.id}" given twice`);
    ids.add(r.id);
    let repo;
    try {
      repo = Repo.open(r.dir);
    } catch (e) {
      throw new Error(`${r.id}: ${r.dir} is not a git repository (${e.message.split('\n')[0]})`);
    }
    const commit = repo.resolve(r.ref);
    if (!commit) throw new Error(`${r.id}: ${r.ref} does not resolve in ${r.dir} (git fetch first)`);
    handles.set(r.id, { repo, commit });
    const config = readConfig(repo, commit);
    out.repos.push({ id: r.id, name: repoName(repo, r.dir), ref: r.ref, commit });
    const tree = repo.tree(commit);

    for (const d of readJson(repo, commit, 'specs/domains.json') ?? []) {
      if (d && typeof d.id === 'string' && !domains.has(d.id)) domains.set(d.id, { id: d.id, title: String(d.title ?? d.id), purpose: String(d.purpose ?? '') });
    }

    // A code path belongs to the nearest (deepest) module up its tree.
    const modules = findModules(repo, commit, r.id, config);
    const moduleOf = (codePath) => {
      let d = codePath.endsWith('/') ? codePath.replace(/\/+$/, '') : path.posix.dirname(codePath);
      for (;;) {
        if (d === '' || d === '.') return modules.get('.') ?? null;
        if (modules.has(d)) return modules.get(d);
        d = path.posix.dirname(d);
      }
    };

    // Capabilities.
    for (const p of tree.files.keys()) {
      const m = SPEC_FILE.exec(p);
      if (!m) continue;
      const id = `${m[1]}/${m[2]}`;
      const spec = parseSpec(repo.text(commit, p));
      const mods = [];
      for (const c of spec.code) {
        const mod = moduleOf(c);
        if (!mod) continue;
        if (!mods.includes(mod.path)) mods.push(mod.path);
        if (!mod.capabilities.includes(id)) mod.capabilities.push(id);
      }
      if (!caps.has(id)) caps.set(id, { id, domain: m[1], title: spec.title ?? m[2], purpose: spec.purpose, sides: [], requirements: [], pendingChanges: [], state: null });
      const cap = caps.get(id);
      cap.sides.push({ repo: r.id, spec: p, code: spec.code, modules: mods, problems: spec.problems.map((x) => `${x.line}: ${x.message}`) });
      for (const req of spec.requirements) {
        cap.requirements.push({
          repo: r.id,
          name: req.name,
          text: req.text,
          scenarios: req.scenarios.map((s) => {
            const look = `specs/${id}/look/${s.slug}.png`;
            const proofs = s.proofs.map((pr) => proofOut(pr, tree));
            return {
              name: s.name,
              slug: s.slug,
              text: s.text,
              look: s.slug && tree.files.has(look) ? { repo: r.id, path: look, asset: null } : null,
              proofs,
              tested: s.proofs.some((pr) => pr.state === 'test' && !pr.error),
              human: humanState(s.proofs),
            };
          }),
        });
      }
    }

    // Changes: every changes/<id>/ folder is waiting for the owner's review.
    const folders = new Map();
    for (const p of tree.files.keys()) {
      const m = /^changes\/([^/]+)\/(.+)$/.exec(p);
      if (!m) continue;
      if (!folders.has(m[1])) folders.set(m[1], []);
      folders.get(m[1]).push(p);
    }
    for (const [id, files] of folders) {
      const dir = `changes/${id}`;
      const proposal = `${dir}/proposal.md`;
      const text = repo.text(commit, proposal);
      const parsed = text === null ? { title: null, capabilities: [], removes: [], review: null, followUps: [] } : parseChange(text);
      const under = (sub) => files.filter((f) => f.startsWith(`${dir}/${sub}`)).sort();
      const added = text === null ? null : repo.addedBy(commit, proposal);
      const side = {
        repo: r.id,
        path: dir,
        review: parsed.review === 'changes-requested' ? 'changes-requested' : 'unreviewed',
        capabilities: parsed.capabilities,
        removes: parsed.removes,
        files: [...files].sort(),
        looks: under('look/').filter((f) => !f.slice(`${dir}/look/`.length).includes('/')).map((f) => ({ path: f, asset: null })),
        directions: under('look/directions/').map((f) => ({ path: f, asset: null })),
        evidence: under('evidence/').map((f) => ({ path: f, asset: null })),
        landed: added ? { commit: added.commit, date: added.date, pr: prNumber(added.subject) } : null,
      };
      if (!changes.has(id)) changes.set(id, { id, title: parsed.title ?? id, review: side.review, followUps: [], sides: [] });
      const ch = changes.get(id);
      ch.sides.push(side);
      if (side.review === 'changes-requested') ch.review = 'changes-requested';
      for (const f of parsed.followUps) if (!ch.followUps.includes(f)) ch.followUps.push(f);
    }
    out.modules.push(...[...modules.values()].sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : cmp(a.path, b.path))));
  }

  out.domains = [...domains.values()];
  const domainOrder = new Map(out.domains.map((d, i) => [d.id, i]));
  out.changes = [...changes.values()].sort((a, b) => cmp(a.id, b.id));
  for (const cap of caps.values()) {
    cap.pendingChanges = out.changes.filter((c) => c.sides.some((s) => s.capabilities.includes(cap.id))).map((c) => c.id);
    const states = cap.requirements.flatMap((r) => r.scenarios.map((s) => s.human));
    cap.state = capabilityState(states, cap.pendingChanges.length > 0, cap.sides.some((s) => s.problems.length > 0));
  }
  for (const m of out.modules) m.capabilities.sort();
  out.capabilities = [...caps.values()].sort((a, b) => (domainOrder.get(a.domain) ?? 1e9) - (domainOrder.get(b.domain) ?? 1e9) || cmp(a.id, b.id));
  out.totals = totals(out);
  Object.defineProperty(out, '_handles', { value: handles, enumerable: false });
  return out;
}

function proofOut(p, tree) {
  if (p.error) return { check: p.check ?? 'unknown', state: 'invalid', error: p.error };
  const o = { check: p.check, state: p.state };
  if (p.state === 'test') {
    o.path = p.path;
    if (p.selector) o.selector = p.selector;
    const t = p.path.replace(/\/$/, '');
    o.exists = tree.files.has(t) || tree.dirs.has(t);
  }
  for (const k of ['date', 'build', 'by', 'note']) if (p[k] !== undefined) o[k] = p[k];
  return o;
}

function prNumber(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject ?? '');
  return m ? Number(m[1]) : null;
}

function totals(o) {
  const count = (list, key, values) => Object.fromEntries(values.map((v) => [v, list.filter((x) => x[key] === v).length]));
  const scenarios = o.capabilities.flatMap((c) => c.requirements.flatMap((r) => r.scenarios));
  return {
    repos: o.repos.length,
    domains: o.domains.length,
    modules: o.modules.length,
    capabilities: { total: o.capabilities.length, ...count(o.capabilities, 'state', ['failing', 'unreviewed', 'approved', 'automated']) },
    scenarios: { total: scenarios.length, ...count(scenarios, 'human', ['failing', 'open', 'approved', 'automated']), tested: scenarios.filter((s) => s.tested).length },
    changes: {
      total: o.changes.length,
      unreviewed: o.changes.filter((c) => c.review === 'unreviewed').length,
      changesRequested: o.changes.filter((c) => c.review === 'changes-requested').length,
    },
  };
}

/** Every image the overview references: scenario looks and change looks, directions, evidence. */
function referenced(o) {
  const list = [];
  for (const c of o.capabilities) for (const r of c.requirements) for (const s of r.scenarios) if (s.look) list.push({ repo: s.look.repo, ref: s.look });
  for (const ch of o.changes) for (const side of ch.sides) for (const k of ['looks', 'directions', 'evidence']) for (const a of side[k]) list.push({ repo: side.repo, ref: a });
  return list;
}

/**
 * Copies every referenced image into `<dir>/<repo-id>/<path>` and sets its `asset` to that path
 * relative to `dir`. An LFS pointer goes through `git lfs smudge`; one it cannot resolve keeps
 * `asset: null` and gets `missing: "lfs"`.
 */
export function copyAssets(o, dir) {
  const root = path.resolve(dir);
  const handles = o._handles;
  o.assetsDir = dir.replace(/\\/g, '/');
  let copied = 0;
  let missing = 0;
  for (const { repo: id, ref } of referenced(o)) {
    const { repo, commit } = handles.get(id);
    const segs = [id, ...ref.path.split('/')];
    const dest = path.resolve(root, ...segs);
    if (segs.some((s) => s === '' || s === '.' || s === '..' || /[\\:]/.test(s)) || !dest.startsWith(root + path.sep)) {
      throw new Error(`refusing to copy ${JSON.stringify(ref.path)} from ${id}: the path leaves ${dir}`);
    }
    let bytes = repo.blob(commit, ref.path);
    const pointer = bytes && bytes.length < 1024 ? LFS_POINTER.exec(bytes.toString('latin1')) : null;
    if (pointer) bytes = smudge(repo, ref.path, bytes, pointer[1]);
    if (!bytes) {
      ref.asset = null;
      ref.missing = 'lfs';
      missing++;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    ref.asset = segs.join('/');
    delete ref.missing;
    copied++;
  }
  return { copied, missing };
}

/** An LFS object's bytes through `git lfs smudge`, or null when it cannot be had or does not match its oid. */
function smudge(repo, p, pointer, oid) {
  let r;
  try {
    r = runGit(repo.dir, ['lfs', 'smudge', '--', p], { input: pointer, raw: true, allowFail: true, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  } catch {
    return null;
  }
  if (r.status !== 0 || !r.stdout) return null;
  const body = Buffer.from(r.stdout);
  return crypto.createHash('sha256').update(body).digest('hex') === oid ? body : null;
}

/** The plain-text summary: per domain its capabilities and scenario counts, then the changes to review. */
export function formatSummary(o) {
  const lines = [];
  const pad = (s, n) => (String(s).length >= n ? `${s}  ` : String(s).padEnd(n));
  const lpad = (s, n) => String(s).padStart(n);
  lines.push(`Overview of ${o.repos.map((r) => `${r.id} (${r.name} ${r.ref} ${r.commit.slice(0, 9)})`).join(', ')}`);
  const t = o.totals;
  lines.push(
    `${t.capabilities.total} capabilities (${t.capabilities.failing} failing, ${t.capabilities.unreviewed} unreviewed, ${t.capabilities.approved} approved, ${t.capabilities.automated} automated) · ` +
      `${t.scenarios.total} scenarios · ${t.changes.total} changes to review · ${t.modules} modules`,
  );
  const width = Math.max(28, ...o.capabilities.map((c) => c.id.length + 2));
  const domainIds = [...o.domains.map((d) => d.id), ...new Set(o.capabilities.map((c) => c.domain).filter((d) => !o.domains.some((x) => x.id === d)))];
  for (const d of domainIds) {
    const caps = o.capabilities.filter((c) => c.domain === d);
    const title = o.domains.find((x) => x.id === d)?.title ?? d;
    lines.push('', `${title} (${d})`);
    if (!caps.length) {
      lines.push('  (no capabilities)');
      continue;
    }
    lines.push(`  ${pad('capability', width)}${pad('state', 12)}${lpad('approved', 9)}${lpad('open', 6)}${lpad('failing', 9)}${lpad('automated', 11)}  repos`);
    for (const c of caps) {
      const sc = c.requirements.flatMap((r) => r.scenarios);
      const n = (h) => sc.filter((s) => s.human === h).length;
      lines.push(
        `  ${pad(c.id, width)}${pad(c.state, 12)}${lpad(n('approved'), 9)}${lpad(n('open'), 6)}${lpad(n('failing'), 9)}${lpad(n('automated'), 11)}  ${c.sides.map((s) => s.repo).join(', ')}`,
      );
    }
  }
  lines.push('', `To review (${o.changes.length})`);
  if (!o.changes.length) lines.push('  (none)');
  for (const ch of o.changes) {
    const landed = ch.sides.map((s) => `${s.repo}${s.landed?.pr ? ` #${s.landed.pr}` : ''}`).join(', ');
    lines.push(`  ${pad(ch.id, width)}${pad(ch.review, 19)}${landed}  ${ch.title}`);
  }
  const byRepo = o.repos.map((r) => `${r.id} ${o.modules.filter((m) => m.repo === r.id).length}`).join(', ');
  lines.push('', `Modules (${o.modules.length}: ${byRepo})`);
  for (const m of o.modules) lines.push(`  ${pad(`${m.repo}:${m.path}`, width + 12)}${m.title}${m.capabilities.length ? `  [${m.capabilities.join(', ')}]` : ''}`);
  return lines.join('\n') + '\n';
}

const USAGE = `usage: node tools/overview/overview.mjs --repo <id>=<git dir>[@<ref>] [--repo ...] [--ref <ref>] [--out <file>] [--assets <dir>] [--summary]
  --ref <ref>      the ref of every repo given without @<ref> (default origin/main)
  --out <file>     write the JSON there (default: stdout, unless --summary)
  --assets <dir>   copy every referenced image into <dir>/<repo-id>/<path>, smudging LFS pointers
  --summary        print a plain-text summary`;

export function main(argv) {
  const o = { repos: [], ref: 'origin/main', summary: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const val = () => {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === '--repo') o.repos.push(val());
      else if (a === '--ref') o.ref = val();
      else if (a === '--out') o.out = val();
      else if (a === '--assets') o.assets = val();
      else if (a === '--summary') o.summary = true;
      else if (a === '-h' || a === '--help') {
        console.log(USAGE);
        return 0;
      } else throw new Error(`unknown argument ${a}`);
    }
    if (!o.repos.length) throw new Error('give at least one --repo');
    o.repos = o.repos.map((r) => parseRepoArg(r, o.ref));
  } catch (e) {
    console.error(`overview: ${e.message}\n${USAGE}`);
    return 2;
  }
  let ov;
  try {
    ov = buildOverview(o.repos);
    if (o.assets) {
      const n = copyAssets(ov, o.assets);
      if (n.missing) console.error(`overview: ${n.missing} image(s) not resolved (an LFS object missing, or not matching its pointer); asset null, missing "lfs"`);
    }
  } catch (e) {
    console.error(`overview: ${e.message}`);
    return 2;
  }
  const json = JSON.stringify(ov, null, 2) + '\n';
  if (o.out) fs.writeFileSync(o.out, json);
  else if (!o.summary) process.stdout.write(json);
  if (o.summary) process.stdout.write(formatSummary(ov));
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}

export const OVERVIEW_DIR = path.dirname(fileURLToPath(import.meta.url));
