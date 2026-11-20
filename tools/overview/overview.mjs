#!/usr/bin/env node
// The overview index: each repository's features (capabilities) with their review state, Looks,
// scenarios and tests, the systems they ship in, the change folders, and the components, as one
// JSON document a viewer renders. Every repository is read at a ref through git objects; its
// checkout's state never matters.
//
//   node tools/overview/overview.mjs --repo app=../app --repo backend=../backend \
//     [--ref origin/main] [--out overview.json] [--assets <dir>] [--summary]
//
// Exit: 0 written, 2 usage or setup error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Repo } from '../gate/lib/git.mjs';
import { parseSpec, parseChange, parseFrontMatter, isTested, reviewState, REVIEW_STATES, SPEC_FILE, ID } from '../gate/lib/spec.mjs';
import { readSystems as readSystemsFile } from '../gate/lib/checks.mjs';
import { prSections } from '../gate/lib/pr.mjs';
import { firstHeading, firstParagraph, plainText, clip, splitLines, fenceMask } from '../gate/lib/markdown.mjs';
import { matches } from '../gate/lib/glob.mjs';

export const VERSION = 3;
/** Folders that never hold a component, in every repository. */
export const COMPONENT_EXCLUDES = ['specs', 'changes', '.agents', '.github'];
/** Component globs left out when a repository's tools/gate/config.json names no `overview.excludeComponents`. */
export const DEFAULT_EXCLUDE_COMPONENTS = ['dev/**', 'docs/**', '**/proof/**', 'fixtures/**', '**/test/fixtures/**'];
/** The file names that make a folder a component when a repository's tools/gate/config.json names no `overview.componentMarkers`. */
export const DEFAULT_COMPONENT_MARKERS = ['README.md', 'package.json', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', '*.asmdef'];
const REPO_ID = /^[a-z0-9][a-z0-9-]*$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
/** A path without its trailing `/`. */
const bare = (p) => p.replace(/\/+$/, '');
/** Whether `p` is `decl` or lies inside it (a declared folder, with or without its `/`). */
const within = (p, decl) => {
  const q = bare(p);
  const d = bare(decl);
  return q === d || q.startsWith(`${d}/`);
};

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
 * The components of a repository at `commit`: every folder holding a file a component marker
 * matches (tools/gate/config.json `overview.componentMarkers`, file-name globs;
 * DEFAULT_COMPONENT_MARKERS when it names none), a `*.asmdef` counting only when it is not a test
 * assembly, never under node_modules, outside COMPONENT_EXCLUDES and the repository's own `ignore`
 * and `overview.excludeComponents` globs (DEFAULT_EXCLUDE_COMPONENTS when it names none). Returns
 * Map folder -> component.
 */
export function findComponents(repo, commit, repoId, config = readConfig(repo, commit)) {
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const exclude = Array.isArray(config.overview?.excludeComponents) ? config.overview.excludeComponents : DEFAULT_EXCLUDE_COMPONENTS;
  const markers = Array.isArray(config.overview?.componentMarkers) ? config.overview.componentMarkers : DEFAULT_COMPONENT_MARKERS;
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
    if (COMPONENT_EXCLUDES.some((e) => folder === e || folder.startsWith(`${e}/`))) continue;
    if (p.split('/').includes('node_modules') || matches(p, ignore) || matches(p, exclude)) continue;
    const f = at(folder);
    if (name === 'README.md') {
      // A component's README gives its title and summary even where README.md is no marker.
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
  const components = new Map();
  for (const [folder, f] of found) {
    if (!f.marked) continue;
    const text = f.readme ? repo.text(commit, f.readme) ?? '' : '';
    const manifests = f.manifests.sort((a, b) => rank(path.posix.basename(a)) - rank(path.posix.basename(b)) || cmp(a, b));
    const infos = manifests.map((m) => manifestInfo(repo, commit, m));
    const pkgName = infos.find((i) => i.name)?.name ?? null;
    const description = infos.find((i) => i.description)?.description ?? null;
    const assembly = f.asmdefs[0] ?? null;
    components.set(folder, {
      repo: repoId,
      path: folder,
      system: null,
      readme: f.readme,
      assembly,
      package: pkgName,
      manifest: manifests[0] ?? null,
      title: (f.readme && firstHeading(text)) || assembly || pkgName || (folder === '.' ? repoId : path.posix.basename(folder)),
      summary: (f.readme && firstParagraph(text, 300)) || (description ? clip(plainText(description), 300) : ''),
      capabilities: [],
    });
  }
  return components;
}

/**
 * A repository's specs/systems.json at `commit`, read by the gate's reader: [{ id, title,
 * purpose, paths }] for the entries with a valid id, their string paths only (the gate judges the
 * rest); [] when it has none or it does not parse.
 */
export function readSystems(repo, commit) {
  const { systems } = readSystemsFile(repo, commit);
  return (systems ?? [])
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : s.id,
      purpose: typeof s.purpose === 'string' ? s.purpose : '',
      paths: Array.isArray(s.paths) ? s.paths.filter((p) => typeof p === 'string' && p.trim() !== '') : [],
    }))
    .filter((s) => s.paths.length);
}

/** The id of the nearest system declaring `p` or a folder above it (the deepest declared path), or null. */
export function systemOf(systems, p) {
  let best = null;
  for (const s of systems) {
    for (const d of s.paths) {
      if (within(p, d) && (!best || bare(d).length > best.depth)) best = { id: s.id, depth: bare(d).length };
    }
  }
  return best?.id ?? null;
}

/**
 * The newest commit on `rev`'s first-parent line whose diff adds or removes a `review:` line of
 * `p`: { commit, date, subject }, or null. The commit that last set the spec's verdict.
 */
function reviewedBy(repo, rev, p) {
  const out = repo.git(['-c', 'log.follow=false', 'log', '--first-parent', '-G', '^review:', '-n', '1', '--format=%H%x00%cI%x00%s', rev, '--', p]);
  const line = String(out).trim();
  if (!line) return null;
  const [commit, date, subject] = line.split('\0');
  return { commit, date, subject };
}

const stamp = (c) => (c ? { commit: c.commit, date: c.date, pr: prNumber(c.subject) } : null);

function prNumber(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The plain text of a proposal's `## <name>` section (read as the gate reads a PR body's
 * sections): its paragraphs, each paragraph's lines joined by one space and its inline Markdown
 * dropped, a sub-heading a paragraph of its own, a fenced block one paragraph of its text as
 * written (whitespace collapsed, its fences dropped), paragraphs joined by a blank line; null when
 * the section is absent.
 */
export function sectionText(text, name) {
  const body = splitLines(text).slice(parseFrontMatter(text).bodyStart).join('\n');
  const section = prSections(body).get(name);
  if (section === undefined) return null;
  const lines = splitLines(section);
  const mask = fenceMask(lines);
  const closing = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/;
  const out = [];
  let cur = [];
  const flush = () => {
    const p = plainText(cur.join(' '));
    if (p) out.push(p);
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) {
      flush();
      // lines[i] opens a fence, closed by a run of its own character at least as long (as fenceMask reads it)
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])[1];
      let j = i + 1;
      while (j < lines.length && mask[j] && !(closing.test(lines[j]) && lines[j].trim()[0] === open[0] && lines[j].trim().length >= open.length)) j++;
      const code = lines.slice(i + 1, j).join(' ').replace(/\s+/g, ' ').trim();
      if (code) out.push(code);
      i = j < lines.length && mask[j] ? j : j - 1;
      continue;
    }
    const h = /^ {0,3}#{3,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
    if (h) {
      flush();
      cur.push(h[1]);
      flush();
    } else if (lines[i].trim() === '') flush();
    else cur.push(lines[i].trim());
  }
  flush();
  return out.join('\n\n');
}

function proofOut(p, tree) {
  if (p.error) return { check: p.check ?? 'unknown', state: 'invalid', ...(p.path ? { path: p.path } : {}), error: p.error };
  const t = bare(p.path);
  return { check: 'test', state: 'test', path: p.path, ...(p.selector ? { selector: p.selector } : {}), exists: tree.files.has(t) || tree.dirs.has(t) };
}

/**
 * Builds the overview from repositories [{ id, dir, ref }] (the first given wins a shared
 * feature's title and summary, and a shared system's title and purpose). Returns the overview
 * object; every board's `asset` stays null until copyAssets.
 */
export function buildOverview(repos, { now = new Date() } = {}) {
  const out = {
    version: VERSION,
    generatedAt: now.toISOString(),
    assetsDir: null,
    repos: [],
    domains: [],
    systems: [],
    capabilities: [],
    changes: [],
    components: [],
    outside: { components: [], code: [] },
    uncovered: [],
    totals: null,
  };
  const domains = new Map();
  const systems = new Map();
  const caps = new Map();
  const changes = new Map();
  const handles = new Map();
  const outsideCode = [];
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

    // Systems: this repository's own, merged by id with the others'.
    const own = readSystems(repo, commit);
    for (const s of own) {
      if (!systems.has(s.id)) systems.set(s.id, { id: s.id, title: s.title, purpose: s.purpose, sides: [], capabilities: [], components: [] });
      const sys = systems.get(s.id);
      const side = sys.sides.find((x) => x.repo === r.id);
      if (side) side.paths.push(...s.paths.filter((p) => !side.paths.includes(p)));
      else sys.sides.push({ repo: r.id, paths: [...s.paths] });
    }
    const declares = own.length > 0;
    const sysOf = (p) => systemOf(own, p);

    // A code path belongs to the nearest (deepest) component up its tree.
    const components = findComponents(repo, commit, r.id, config);
    for (const c of components.values()) c.system = c.path === '.' ? null : sysOf(`${c.path}/`);
    const componentOf = (codePath) => {
      let d = codePath.endsWith('/') ? bare(codePath) : path.posix.dirname(codePath);
      for (;;) {
        if (d === '' || d === '.') return components.get('.') ?? null;
        if (components.has(d)) return components.get(d);
        d = path.posix.dirname(d);
      }
    };

    // Features.
    const codeHere = [];
    for (const p of [...tree.files.keys()].sort(cmp)) {
      const m = SPEC_FILE.exec(p);
      if (!m) continue;
      const id = `${m[1]}/${m[2]}`;
      const spec = parseSpec(repo.text(commit, p));
      const comps = [];
      const syss = [];
      for (const c of spec.code) {
        codeHere.push(c);
        const comp = componentOf(c);
        if (comp) {
          if (!comps.includes(comp.path)) comps.push(comp.path);
          if (!comp.capabilities.includes(id)) comp.capabilities.push(id);
        }
        const sys = sysOf(c);
        if (sys) {
          if (!syss.includes(sys)) syss.push(sys);
        } else if (declares) outsideCode.push({ repo: r.id, capability: id, path: c });
      }
      if (!caps.has(id)) caps.set(id, { id, domain: m[1], title: spec.title ?? m[2], summary: spec.summary, review: null, reviewed: null, systems: [], sides: [], looks: [], requirements: [], pendingChanges: [] });
      const cap = caps.get(id);
      cap.sides.push({
        repo: r.id,
        spec: p,
        review: REVIEW_STATES.includes(spec.review) ? spec.review : null,
        reviewed: stamp(reviewedBy(repo, commit, p)),
        code: spec.code,
        systems: syss.sort(),
        components: comps,
        problems: spec.problems.map((x) => ({ line: x.line, message: x.message })),
      });
      for (const lk of spec.looks) {
        if (lk.error) continue;
        if (lk.kind === 'board') {
          const bp = `specs/${id}/${lk.board}`;
          cap.looks.push({ repo: r.id, kind: 'board', path: bp, id: lk.id, caption: lk.caption, exists: tree.files.has(bp), asset: null });
        } else cap.looks.push({ repo: r.id, kind: 'page', target: lk.target, caption: lk.caption });
      }
      for (const req of spec.requirements) {
        cap.requirements.push({
          repo: r.id,
          name: req.name,
          text: req.text,
          scenarios: req.scenarios.map((s) => ({
            name: s.name,
            slug: s.slug,
            text: s.text,
            table: s.table ? { header: s.table.header, rows: s.table.rows } : null,
            proofs: s.proofs.map((pr) => proofOut(pr, tree)),
            tested: isTested(s),
          })),
        });
      }
    }

    // Components: their system, those outside every system, those in a system no spec names.
    const sorted = [...components.values()].sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : cmp(a.path, b.path)));
    const declared = own.flatMap((s) => s.paths);
    for (const c of sorted) {
      const folder = c.path === '.' ? '' : c.path;
      if (c.system) {
        const sys = systems.get(c.system);
        sys.components.push({ repo: r.id, path: c.path });
        const named = codeHere.some((p) => within(p, folder) || (p.endsWith('/') && within(folder, p)));
        if (!named) out.uncovered.push({ repo: r.id, system: c.system, path: c.path });
      } else if (declares && !declared.some((d) => folder === '' || within(d, folder))) {
        out.outside.components.push({ repo: r.id, path: c.path });
      }
    }
    out.components.push(...sorted);

    // Change folders.
    const folders = new Map();
    for (const p of tree.files.keys()) {
      const m = /^changes\/([^/]+)\/(.+)$/.exec(p);
      if (!m) continue;
      if (!folders.has(m[1])) folders.set(m[1], []);
      folders.get(m[1]).push(p);
    }
    for (const [id, files] of [...folders].sort((a, b) => cmp(a[0], b[0]))) {
      const dir = `changes/${id}`;
      const proposal = `${dir}/proposal.md`;
      const text = repo.text(commit, proposal);
      const parsed = text === null ? { title: null, capabilities: [], removes: [] } : parseChange(text);
      const added = text === null ? null : repo.addedBy(commit, proposal);
      if (!changes.has(id)) changes.set(id, { id, title: null, sides: [] });
      const ch = changes.get(id);
      ch.title ??= parsed.title;
      ch.sides.push({
        repo: r.id,
        path: dir,
        capabilities: parsed.capabilities,
        removes: parsed.removes,
        review: text === null ? null : sectionText(text, 'Review'),
        files: [...files].sort(),
        landed: stamp(added),
      });
    }
  }

  out.domains = [...domains.values()];
  out.systems = [...systems.values()];
  const domainOrder = new Map(out.domains.map((d, i) => [d.id, i]));
  out.changes = [...changes.values()].sort((a, b) => cmp(a.id, b.id)).map((c) => ({ ...c, title: c.title ?? c.id }));
  out.capabilities = [...caps.values()].sort((a, b) => (domainOrder.get(a.domain) ?? 1e9) - (domainOrder.get(b.domain) ?? 1e9) || cmp(a.id, b.id));
  for (const cap of out.capabilities) {
    cap.review = reviewState(cap.sides.map((s) => s.review));
    cap.systems = [...new Set(cap.sides.flatMap((s) => s.systems))].sort();
    cap.reviewed = cap.sides.map((s) => s.reviewed).filter(Boolean).reduce((a, b) => (!a || Date.parse(b.date) > Date.parse(a.date) ? b : a), null);
    cap.pendingChanges = out.changes.filter((c) => c.sides.some((s) => s.capabilities.includes(cap.id))).map((c) => c.id);
    for (const s of cap.systems) systems.get(s).capabilities.push(cap.id);
  }
  for (const s of out.systems) s.capabilities.sort();
  for (const c of out.components) c.capabilities.sort();
  const repoOrder = new Map(out.repos.map((r, i) => [r.id, i]));
  out.outside.code = outsideCode.sort((a, b) => repoOrder.get(a.repo) - repoOrder.get(b.repo) || cmp(a.capability, b.capability) || cmp(a.path, b.path));
  out.totals = totals(out);
  Object.defineProperty(out, '_handles', { value: handles, enumerable: false });
  return out;
}

function totals(o) {
  const scenarios = o.capabilities.flatMap((c) => c.requirements.flatMap((r) => r.scenarios));
  const tested = scenarios.filter((s) => s.tested).length;
  const review = (v) => o.capabilities.filter((c) => c.review === v).length;
  return {
    repos: o.repos.length,
    domains: o.domains.length,
    systems: o.systems.length,
    components: o.components.length,
    capabilities: { total: o.capabilities.length, unreviewed: review('unreviewed'), approved: review('approved'), changesRequested: review('changes-requested') },
    scenarios: { total: scenarios.length, tested, untested: scenarios.length - tested },
    changes: { total: o.changes.length },
  };
}

/**
 * Copies every board the overview references that exists at its ref into
 * `<dir>/<repo-id>/<path>` and sets its `asset` to that path relative to `dir`.
 */
export function copyAssets(o, dir) {
  const root = path.resolve(dir);
  const handles = o._handles;
  o.assetsDir = dir.replace(/\\/g, '/');
  let copied = 0;
  for (const cap of o.capabilities) {
    for (const look of cap.looks) {
      if (look.kind !== 'board' || !look.exists) continue;
      const { repo, commit } = handles.get(look.repo);
      const segs = [look.repo, ...look.path.split('/')];
      const dest = path.resolve(root, ...segs);
      if (segs.some((s) => s === '' || s === '.' || s === '..' || /[\\:]/.test(s)) || !dest.startsWith(root + path.sep)) {
        throw new Error(`refusing to copy ${JSON.stringify(look.path)} from ${look.repo}: the path leaves ${dir}`);
      }
      const bytes = repo.blob(commit, look.path);
      if (!bytes) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      look.asset = segs.join('/');
      copied++;
    }
  }
  return { copied };
}

/**
 * The plain-text summary: per domain its features with their review state and tested scenarios;
 * then the features to review; then the change folders; then the systems.
 */
export function formatSummary(o) {
  const lines = [];
  const pad = (s, n) => (String(s).length >= n ? `${s}  ` : String(s).padEnd(n));
  const lpad = (s, n) => String(s).padStart(n);
  lines.push(`Overview of ${o.repos.map((r) => `${r.id} (${r.name} ${r.ref} ${r.commit.slice(0, 9)})`).join(', ')}`);
  const t = o.totals;
  lines.push(
    `${t.capabilities.total} features (${t.capabilities.unreviewed} unreviewed, ${t.capabilities.approved} approved, ${t.capabilities.changesRequested} changes requested) · ` +
      `${t.scenarios.total} scenarios (${t.scenarios.tested} tested, ${t.scenarios.untested} untested) · ${t.changes.total} change folders · ${t.systems} systems · ${t.components} components`,
  );
  const width = Math.max(28, ...o.capabilities.map((c) => c.id.length + 2), ...o.changes.map((c) => c.id.length + 2), ...o.systems.map((s) => s.id.length + 2));
  const sysWidth = Math.max(20, ...o.capabilities.map((c) => c.systems.join(', ').length + 2), ...o.systems.map((s) => s.sides.map((x) => x.repo).join(', ').length + 2));
  const domainIds = [...o.domains.map((d) => d.id), ...new Set(o.capabilities.map((c) => c.domain).filter((d) => !o.domains.some((x) => x.id === d)))];
  for (const d of domainIds) {
    const caps = o.capabilities.filter((c) => c.domain === d);
    const title = o.domains.find((x) => x.id === d)?.title ?? d;
    lines.push('', `${title} (${d})`);
    if (!caps.length) {
      lines.push('  (no features)');
      continue;
    }
    lines.push(`  ${pad('feature', width)}${pad('review', 19)}${lpad('tested', 7)}  ${pad('systems', sysWidth)}repos`);
    for (const c of caps) {
      const sc = c.requirements.flatMap((r) => r.scenarios);
      const tested = `${sc.filter((s) => s.tested).length}/${sc.length}`;
      lines.push(`  ${pad(c.id, width)}${pad(c.review, 19)}${lpad(tested, 7)}  ${pad(c.systems.join(', ') || '-', sysWidth)}${c.sides.map((s) => s.repo).join(', ')}`);
    }
  }
  const toReview = o.capabilities.filter((c) => c.review !== 'approved');
  lines.push('', `To review (${toReview.length})`);
  if (!toReview.length) lines.push('  (none)');
  for (const c of toReview) lines.push(`  ${pad(c.id, width)}${pad(c.review, 19)}${c.pendingChanges.join(', ') || '(no change folder)'}`);
  lines.push('', `Change folders (${o.changes.length})`);
  if (!o.changes.length) lines.push('  (none)');
  for (const ch of o.changes) {
    const landed = ch.sides.map((s) => `${s.repo}${s.landed?.pr ? ` #${s.landed.pr}` : ''}`).join(', ');
    lines.push(`  ${pad(ch.id, width)}${pad(landed, 19)}${ch.title}`);
  }
  lines.push('', `Systems (${o.systems.length})`);
  if (!o.systems.length) lines.push('  (none declared)');
  for (const s of o.systems) {
    const n = s.capabilities.length;
    lines.push(`  ${pad(s.id, width)}${pad(`${n} feature${n === 1 ? '' : 's'}`, 19)}${pad(s.sides.map((x) => x.repo).join(', '), sysWidth)}${s.title}${n ? '' : '  (no feature ships in it)'}`);
  }
  const idle = o.systems.filter((s) => !s.capabilities.length).map((s) => s.id);
  if (idle.length) lines.push(`  No feature ships in: ${idle.join(', ')}`);
  if (o.outside.components.length || o.outside.code.length) {
    lines.push(`  Outside every system: ${o.outside.components.length} components, ${o.outside.code.length} code paths`);
  }
  return lines.join('\n') + '\n';
}

const USAGE = `usage: node tools/overview/overview.mjs --repo <id>=<git dir>[@<ref>] [--repo ...] [--ref <ref>] [--out <file>] [--assets <dir>] [--summary]
  --ref <ref>      the ref of every repo given without @<ref> (default origin/main)
  --out <file>     write the JSON there (default: stdout, unless --summary)
  --assets <dir>   copy every referenced board into <dir>/<repo-id>/<path>
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
    if (o.assets) copyAssets(ov, o.assets);
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
