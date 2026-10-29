// The gate's checks. Each takes the context and returns { id, title, status, summary, findings }.
// status: pass | fail | skip. A finding is { level: 'fail'|'info', file?, line?, message }.
import path from 'node:path';
import { matches } from './glob.mjs';
import { splitLines, fenceMask, stripInlineCode, anchors, links, PROOF_LINE } from './markdown.mjs';
import { ID, SPEC_FILE, parseSpec, parseChange, requirementText, scenarioKey, scenarioText, isCapabilityId } from './spec.mjs';
import { addedLines, isCode, isIgnored, nearestReadme } from './context.mjs';
import { prSections } from './pr.mjs';
import { LOCK_FILE, kitProblems, owns } from './kit.mjs';

function result(id, title, findings, summary, status) {
  const fails = findings.filter((f) => f.level === 'fail').length;
  return { id, title, status: status ?? (fails ? 'fail' : 'pass'), summary, findings };
}

const finding = (level) => (message, file, line) => ({ level, message, ...(file ? { file } : {}), ...(line ? { line } : {}) });
const fail = finding('fail');
const info = finding('info');

const live = (ctx) => ctx.changes.filter((c) => c.status !== 'D');

/**
 * Judges units (a capability folder, a change folder, specs/domains.json) by what they hold at
 * head. A unit this PR touched answers for every problem it has; an untouched unit fails only on
 * problems it did not have at the merge base (this PR deleted a path it names, say), and its older
 * ones are information.
 */
function judge(ctx, units) {
  const out = [];
  for (const u of units) {
    const now = u.at(ctx.head);
    if (u.changed) {
      for (const f of now) out.push(fail(f.message, f.file, f.line));
      continue;
    }
    const before = new Set(u.at(ctx.mergeBase).map((f) => `${f.file}\u0000${f.message}`));
    for (const f of now) {
      if (before.has(`${f.file}\u0000${f.message}`)) out.push(info(`already at the merge base: ${f.message}`, f.file, f.line));
      else out.push(fail(f.message, f.file, f.line));
    }
  }
  return out;
}

const touched = (ctx, prefix) => ctx.changes.some((c) => c.path === prefix || c.path.startsWith(`${prefix}/`));

// ---------------------------------------------------------------------------------------------

/** specs/domains.json at `rev`: { ids: Set | null, problems: [{ file, message }] }. null ids: unreadable. */
export function readDomains(repo, rev) {
  const file = 'specs/domains.json';
  const text = repo.text(rev, file);
  if (text === null) return { ids: null, problems: [{ file, message: 'specs/domains.json is missing; specs need their domains' }] };
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    return { ids: null, problems: [{ file, message: `not JSON: ${e.message}` }] };
  }
  if (!Array.isArray(list)) return { ids: null, problems: [{ file, message: 'a list of { "id", "title", "purpose" }' }] };
  const ids = new Set();
  const problems = [];
  list.forEach((d, i) => {
    if (!d || typeof d !== 'object') return problems.push({ file, message: `entry ${i} is not an object` });
    if (typeof d.id !== 'string' || !ID.test(d.id)) problems.push({ file, message: `entry ${i}: id ${JSON.stringify(d.id)} is not kebab-case` });
    else if (ids.has(d.id)) problems.push({ file, message: `domain "${d.id}" appears twice` });
    else ids.add(d.id);
    for (const k of ['title', 'purpose']) {
      if (typeof d[k] !== 'string' || !d[k].trim()) problems.push({ file, message: `entry ${i}: "${k}" is a non-empty string` });
    }
  });
  return { ids, problems };
}

/** The layout of specs/ at `rev`: capability folders with their files, and stray paths. */
export function specsLayout(repo, rev) {
  const capabilities = new Map();
  const stray = [];
  for (const p of repo.tree(rev).files.keys()) {
    if (!p.startsWith('specs/') || p === 'specs/README.md' || p === 'specs/domains.json') continue;
    const segs = p.split('/');
    if (segs.length < 4) {
      stray.push(p);
      continue;
    }
    const folder = segs.slice(0, 3).join('/');
    if (!capabilities.has(folder)) capabilities.set(folder, []);
    capabilities.get(folder).push(segs.slice(3).join('/'));
  }
  return { capabilities, stray };
}

/** What is wrong with a `code` or `test:` path in a tree, or null: a folder ends with `/`, a file does not. */
function pathAtRev(tree, p) {
  if (p.endsWith('/')) {
    if (tree.dirs.has(p.slice(0, -1))) return null;
    return tree.files.has(p.slice(0, -1)) ? `${p} is a file; drop the trailing /` : `no folder ${p}`;
  }
  if (tree.files.has(p)) return null;
  return tree.dirs.has(p) ? `${p} is a folder; end it with /` : `no file ${p}`;
}

/** Everything wrong with one capability folder at `rev`, as [{ file, line?, message }]. */
export function capabilityProblems(repo, rev, folder, domainIds) {
  const out = [];
  const [, domain, cap] = folder.split('/');
  const spec = `${folder}/spec.md`;
  if (!ID.test(domain)) out.push({ file: spec, message: `domain "${domain}" is not kebab-case` });
  else if (domainIds && !domainIds.has(domain)) out.push({ file: spec, message: `domain "${domain}" is not in specs/domains.json` });
  if (!ID.test(cap)) out.push({ file: spec, message: `capability "${cap}" is not kebab-case` });
  const text = repo.text(rev, spec);
  if (text === null) {
    out.push({ file: spec, message: `${folder}/ has no spec.md` });
    return out;
  }
  const parsed = parseSpec(text);
  for (const p of parsed.problems) out.push({ file: spec, line: p.line, message: p.message });
  const tree = repo.tree(rev);
  for (const c of parsed.code) {
    const bad = pathAtRev(tree, c);
    if (bad) out.push({ file: spec, line: 1, message: `code: ${bad}` });
  }
  const slugs = new Set();
  for (const r of parsed.requirements) {
    for (const s of r.scenarios) {
      slugs.add(s.slug);
      for (const p of s.proofs) {
        if (p.state !== 'test' || p.error) continue;
        const bad = pathAtRev(tree, p.path);
        if (bad) out.push({ file: spec, line: p.n, message: `${s.name}: test path ${bad}` });
      }
    }
  }
  for (const f of repo.tree(rev).files.keys()) {
    if (!f.startsWith(`${folder}/`) || f === spec) continue;
    const rest = f.slice(folder.length + 1);
    const look = /^look\/([^/]+)\.png$/.exec(rest);
    if (look && slugs.has(look[1])) continue;
    out.push({
      file: f,
      message: look
        ? `look ${look[1]}.png names no scenario of ${spec} (its slugs: ${[...slugs].join(', ') || 'none'})`
        : `stray file: a capability folder holds spec.md and look/<scenario-slug>.png`,
    });
  }
  return out;
}

export function checkSpecs(ctx) {
  const { repo, head } = ctx;
  const layout = specsLayout(repo, head);
  const hasSpecs = layout.capabilities.size > 0 || repo.has(head, 'specs/domains.json');
  if (!hasSpecs && layout.stray.length === 0) return result('specs', 'specs', [], 'no specs at head');
  const domainsAt = new Map();
  const domains = (rev) => {
    if (!domainsAt.has(rev)) domainsAt.set(rev, readDomains(repo, rev));
    return domainsAt.get(rev);
  };
  const units = [];
  if (hasSpecs) {
    // A PR that writes anything under specs/ answers for the domains its specs are judged against.
    units.push({ changed: touched(ctx, 'specs'), at: (rev) => domains(rev).problems });
  }
  for (const p of layout.stray) {
    units.push({
      changed: ctx.changed.has(p),
      at: (rev) => (repo.has(rev, p) ? [{ file: p, message: 'stray file: specs/ holds README.md, domains.json and specs/<domain>/<capability>/ folders' }] : []),
    });
  }
  for (const folder of layout.capabilities.keys()) {
    units.push({ changed: touched(ctx, folder), at: (rev) => capabilityProblems(repo, rev, folder, domains(rev).ids) });
  }
  const findings = judge(ctx, units);

  // A scenario whose text changed since the merge base carries no pass or fail, and keeps every
  // human check it had, as open. A pass or fail written on an unchanged scenario is shown.
  let changedScenarios = 0;
  for (const c of live(ctx)) {
    if (!SPEC_FILE.test(c.path)) continue;
    const now = parseSpec(repo.text(head, c.path));
    const before = new Map();
    for (const r of parseSpec(repo.text(ctx.mergeBase, c.path) ?? '').requirements) for (const s of r.scenarios) before.set(scenarioKey(r, s), s);
    for (const r of now.requirements) {
      for (const s of r.scenarios) {
        const key = scenarioKey(r, s);
        const was = before.get(key);
        const where = `${r.name} / ${s.name}`;
        const verdicts = s.proofs.filter((p) => p.state === 'pass' || p.state === 'fail');
        if (was && scenarioText(was) === scenarioText(s)) {
          const old = new Set(was.proofs.map((p) => p.raw));
          for (const p of verdicts) {
            if (old.has(p.raw)) continue;
            findings.push({ ...info(`${where}: writes "${p.raw.replace(/^[-*+]\s+\*\*PROOF\*\*\s*/, '')}"`, c.path, p.n), notice: true });
          }
          continue;
        }
        changedScenarios++;
        const why = was ? 'whose text changed since the merge base' : 'new in this PR';
        for (const p of verdicts) findings.push(fail(`${where}: "${p.check}: ${p.state}" on a scenario ${why}; every human check resets to open`, c.path, p.n));
        if (!was) continue;
        const kept = new Set(s.proofs.map((p) => p.check));
        for (const check of new Set(was.proofs.filter((p) => !p.error && p.check !== 'test').map((p) => p.check))) {
          if (!kept.has(check)) findings.push(fail(`${where}: drops its "${check}" check; a changed scenario keeps every human check it had at the merge base, as "${check}: open"`, c.path, s.n));
        }
      }
    }
  }
  const scenarios = [...layout.capabilities.keys()].reduce((n, f) => {
    const t = repo.text(head, `${f}/spec.md`);
    return n + (t ? parseSpec(t).requirements.reduce((m, r) => m + r.scenarios.length, 0) : 0);
  }, 0);
  return result('specs', 'specs', findings, `${layout.capabilities.size} capabilities, ${scenarios} scenarios, ${changedScenarios} new or changed in this PR`);
}

// ---------------------------------------------------------------------------------------------

/** The parsed proposal of every change folder at `rev`: Map id -> parseChange result. */
function proposalsAt(repo, rev) {
  const out = new Map();
  for (const p of repo.tree(rev).files.keys()) {
    const m = /^changes\/([^/]+)\/proposal\.md$/.exec(p);
    if (m) out.set(m[1], parseChange(repo.text(rev, p)));
  }
  return out;
}

/**
 * Everything wrong with one change folder at `rev`, as [{ file, line?, message }]. A capability it
 * names has a spec at `rev`; one it removes has none at `rev` and had one at the merge base, or is already removed by
 * a change folder on main (at the merge base).
 */
export function changeProblems(repo, rev, folder, mergeBase = rev) {
  const id = folder.slice('changes/'.length);
  const proposal = `${folder}/proposal.md`;
  const out = [];
  if (!ID.test(id)) out.push({ file: proposal, message: `change id "${id}" is not kebab-case` });
  const text = repo.text(rev, proposal);
  if (text === null) {
    out.push({ file: proposal, message: `${folder}/ has no proposal.md` });
    return out;
  }
  const parsed = parseChange(text);
  for (const p of parsed.problems) out.push({ file: proposal, line: p.line, message: p.message });
  for (const cap of parsed.capabilities) {
    if (isCapabilityId(cap) && !repo.has(rev, `specs/${cap}/spec.md`)) {
      out.push({ file: proposal, line: 1, message: `capability ${cap} has no specs/${cap}/spec.md in this repository` });
    }
  }
  for (const cap of parsed.removes) {
    if (!isCapabilityId(cap)) continue;
    if (repo.has(rev, `specs/${cap}/spec.md`)) {
      out.push({ file: proposal, line: 1, message: `removes ${cap}, but specs/${cap}/spec.md is still here: delete it, or name the capability under "capabilities"` });
      continue;
    }
    if (repo.has(mergeBase, `specs/${cap}/spec.md`)) continue;
    if ([...proposalsAt(repo, mergeBase).values()].some((c) => c.removes.includes(cap))) continue;
    out.push({ file: proposal, line: 1, message: `removes ${cap}, which had no specs/${cap}/spec.md at the merge base and no change folder on main removes` });
  }
  return out;
}

export function checkChanges(ctx) {
  const { repo, head } = ctx;
  const folders = new Set();
  const stray = [];
  for (const p of repo.tree(head).files.keys()) {
    if (!p.startsWith('changes/') || p === 'changes/README.md') continue;
    const segs = p.split('/');
    if (segs.length < 3) stray.push(p);
    else folders.add(`changes/${segs[1]}`);
  }
  const units = [];
  for (const p of stray) {
    units.push({ changed: ctx.changed.has(p), at: (rev) => (repo.has(rev, p) ? [{ file: p, message: 'stray file: a change is a folder, changes/<change-id>/' }] : []) });
  }
  for (const f of folders) units.push({ changed: touched(ctx, f), at: (rev) => changeProblems(repo, rev, f, ctx.mergeBase) });
  const findings = judge(ctx, units);

  // A PR that changes the requirement text of a spec adds or modifies a change folder that names
  // the capability; one that deletes a spec, a folder whose `removes` names it. A deleted folder
  // is not written.
  const written = new Set();
  for (const c of live(ctx)) {
    const m = /^changes\/([^/]+)\//.exec(c.path);
    if (m) written.add(m[1]);
  }
  const proposals = new Map([...written].map((id) => [id, parseChange(repo.text(head, `changes/${id}/proposal.md`) ?? '')]));
  const edits = ctx.changes.filter((c) => SPEC_FILE.test(c.path)).filter((c) => {
    const before = repo.text(ctx.mergeBase, c.path);
    const now = repo.text(head, c.path);
    return requirementText(parseSpec(before ?? '')) !== requirementText(parseSpec(now ?? ''));
  });
  for (const e of edits) {
    const cap = SPEC_FILE.exec(e.path).slice(1).join('/');
    const deleted = !repo.has(head, e.path);
    // `removes` answers only for a spec this PR deletes; a spec still here needs `capabilities`.
    const naming = [...proposals].filter(([, p]) => (deleted ? p.removes : p.capabilities).includes(cap)).map(([id]) => id);
    if (naming.length) continue;
    const need = `a change folder whose "${deleted ? 'removes' : 'capabilities'}" names ${cap}`;
    const have = written.size ? `the change folder(s) written (${[...written].join(', ')}) do not name it` : 'this PR adds or modifies no change folder';
    findings.push(fail(`${deleted ? 'deletes' : 'changes the requirement text of'} ${cap}, which needs ${need}; ${have}`, e.path));
  }
  const summary =
    `${folders.size} change folder(s) at head` +
    (written.size ? `; this PR writes ${[...written].join(', ')}` : '') +
    (edits.length ? `; ${edits.length} spec(s) with changed requirement text` : '');
  return result('changes', 'change folders', findings, summary);
}

// ---------------------------------------------------------------------------------------------

/** A living doc: config.livingDocs include and not exclude, and not ignored. */
export function isLivingDoc(ctx, p) {
  const ld = ctx.config.livingDocs;
  return matches(p, ld.include) && !matches(p, ld.exclude ?? []) && !isIgnored(ctx, p);
}

export function checkHistory(ctx) {
  const rules = ctx.config.history.map((r) => ({ ...r, rx: new RegExp(r.pattern, r.flags ?? '') }));
  const findings = [];
  let files = 0;
  for (const c of live(ctx)) {
    if (!isLivingDoc(ctx, c.path)) continue;
    const added = ctx.mdDiff.get(c.path)?.added ?? [];
    if (!added.length) continue;
    files++;
    const mask = fenceMask(splitLines(ctx.repo.text(ctx.head, c.path) ?? ''));
    for (const a of added) {
      if (mask[a.n - 1]) continue;
      const text = stripInlineCode(a.text);
      const proof = PROOF_LINE.test(text);
      for (const r of rules) {
        if (r.skipProofLines && proof) continue;
        const m = r.rx.exec(text);
        if (m) findings.push(fail(`${r.message} "${m[0].trim()}": ${a.text.trim().slice(0, 160)}`, c.path, a.n));
      }
    }
  }
  return result('history', 'history lint (added lines of living docs)', findings, `${files} living doc(s) with added lines, ${findings.length} hit(s)`);
}

// ---------------------------------------------------------------------------------------------

/** A file's size as git stores it (the blob), or null when absent: the same on every OS. */
export function blobSize(repo, rev, p) {
  return repo.tree(rev).files.get(p)?.size ?? null;
}

export function checkBudgets(ctx) {
  const findings = [];
  let checked = 0;
  for (const c of live(ctx)) {
    if (isIgnored(ctx, c.path)) continue;
    const b = ctx.config.budgets.find((f) => matches(c.path, f.pattern));
    // First match wins; "bytes": null exempts what it matches.
    if (!b || b.bytes === null) continue;
    checked++;
    const now = blobSize(ctx.repo, ctx.head, c.path);
    const was = blobSize(ctx.repo, ctx.mergeBase, c.path);
    if (now <= b.bytes) continue;
    if (was === null) findings.push(fail(`new file of ${now} bytes, over its budget of ${b.bytes}`, c.path));
    else if (now > was) findings.push(fail(`${now} bytes, over its budget of ${b.bytes} and grown from ${was}: an over-budget file may only stay equal or shrink`, c.path));
    else findings.push(info(`${now} bytes, over its budget of ${b.bytes} but not grown (${was} at the merge base)`, c.path));
  }
  return result('budgets', 'byte budgets (git blob bytes)', findings, `${checked} budgeted file(s) changed`);
}

// ---------------------------------------------------------------------------------------------

/**
 * Relative links of a doc in the repository at one revision. resolve(target, doc) ->
 * { path, anchor, problem } where path is the repository path the link points at (the doc itself
 * for `#anchor`), or undefined for a link this check does not judge (a scheme, a path leaving the
 * repository); problem is null when the link resolves.
 */
function linkResolver(repo, rev) {
  const tree = repo.tree(rev);
  const cache = new Map();
  const hasAnchor = (p, a) => {
    if (!cache.has(p)) cache.set(p, anchors(repo.text(rev, p) ?? ''));
    const set = cache.get(p);
    if (set.has(a)) return true;
    const low = a.toLowerCase();
    for (const s of set) if (s.toLowerCase() === low) return true;
    return false;
  };
  return (target, doc) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
    if (target.startsWith('#')) {
      const a = safeDecode(target.slice(1));
      return { path: doc, anchor: a, problem: a === '' || hasAnchor(doc, a) ? null : `no heading or id "${a}" in this file` };
    }
    const hash = target.indexOf('#');
    const anchor = hash >= 0 ? safeDecode(target.slice(hash + 1)) : '';
    const p = safeDecode((hash >= 0 ? target.slice(0, hash) : target).split('?')[0]);
    if (p === '') return { path: doc, anchor, problem: null };
    const dir = path.posix.dirname(doc);
    const rel = p.startsWith('/') ? path.posix.normalize(p.slice(1)) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, p));
    if (rel === '..' || rel.startsWith('../')) return undefined; // outside the repository: not ours to check
    const clean = rel.replace(/\/$/, '');
    const isFile = tree.files.has(clean);
    let problem = null;
    if (!isFile && !tree.dirs.has(clean) && clean !== '.') problem = `no such file or folder ${clean}`;
    else if (anchor && isFile && /\.(md|markdown)$/i.test(clean) && !hasAnchor(clean, anchor)) problem = `no heading or id "${anchor}" in ${clean}`;
    return { path: clean, anchor, problem };
  };
}

/**
 * Links on added lines must resolve at head. A link elsewhere — on an older line of a changed doc,
 * or in a doc this PR did not touch — fails when it resolved at the merge base and this PR broke
 * it, by deleting or renaming a doc or changing its headings.
 */
export function checkLinks(ctx) {
  const { repo, head } = ctx;
  const now = linkResolver(repo, head);
  const then = linkResolver(repo, ctx.mergeBase);
  const findings = [];
  let total = 0;
  let files = 0;
  let preexisting = 0;
  const broke = (l, doc) => {
    const was = repo.has(ctx.mergeBase, doc) ? then(l.target, doc) : undefined;
    return was !== undefined && !was.problem;
  };
  // Every path this PR deleted (a file of any kind, or a whole folder): a link to one may break.
  const gone = new Set(ctx.changes.filter((c) => c.status === 'D').map((c) => c.path));
  const headDirs = repo.tree(head).dirs;
  for (const d of repo.tree(ctx.mergeBase).dirs) if (d && !headDirs.has(d)) gone.add(d);
  const brokeMessage = (r, l) =>
    `${r.problem}: ${l.target} (it resolved at the merge base; this PR ${gone.has(r.path) ? `deleted or renamed ${r.path}` : `changed the headings of ${r.path}`})`;
  for (const c of live(ctx)) {
    if (!/\.md$/i.test(c.path) || isIgnored(ctx, c.path)) continue;
    files++;
    const added = addedLines(ctx, c.path);
    for (const l of links(repo.text(head, c.path) ?? '')) {
      const r = now(l.target, c.path);
      if (r === undefined) continue;
      total++;
      if (!r.problem) continue;
      if (added.has(l.n)) findings.push(fail(`${r.problem}: ${l.target}`, c.path, l.n));
      else if (broke(l, c.path)) findings.push(fail(brokeMessage(r, l), c.path, l.n));
      else preexisting++;
    }
  }
  // Docs this PR did not touch, when it deleted a path or dropped a heading some link may name.
  const reheaded = new Set(
    ctx.changes
      .filter((c) => c.status !== 'D' && /\.(md|markdown)$/i.test(c.path) && repo.has(ctx.mergeBase, c.path))
      .filter((c) => {
        const after = anchors(repo.text(head, c.path) ?? '');
        return [...anchors(repo.text(ctx.mergeBase, c.path) ?? '')].some((a) => !after.has(a));
      })
      .map((c) => c.path),
  );
  if (gone.size || reheaded.size) {
    const docs = [...repo.tree(head).files.keys()].filter((doc) => /\.md$/i.test(doc) && !ctx.changed.has(doc) && !isIgnored(ctx, doc));
    repo.prefetch(head, docs);
    for (const doc of docs) {
      for (const l of links(repo.text(head, doc) ?? '')) {
        const r = now(l.target, doc);
        if (!r?.problem || !(gone.has(r.path) || (r.anchor && reheaded.has(r.path)))) continue;
        if (broke(l, doc)) findings.push(fail(brokeMessage(r, l), doc, l.n));
      }
    }
  }
  if (preexisting) findings.push(info(`${preexisting} broken link(s) on lines this PR did not add, already broken at the merge base (not counted)`));
  return result('links', 'relative links and anchors', findings, `${total} relative link(s) in ${files} changed Markdown file(s)`);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------------------------

export function checkReadme(ctx) {
  const families = new Map();
  for (const c of ctx.changes) {
    if (!isCode(ctx, c.path) || isIgnored(ctx, c.path)) continue;
    const readme = nearestReadme(ctx, c.path);
    if (!families.has(readme)) families.set(readme, { readme, root: readme === 'README.md', changed: ctx.changed.has(readme), paths: [] });
    families.get(readme).paths.push(c.path);
  }
  const findings = [];
  const { docImpact, malformed } = ctx.trailers;
  for (const m of malformed) findings.push(fail(`${m.message} (commit ${m.sha.slice(0, 9)}): "${m.line}"`));
  for (const d of docImpact) findings.push(info(`Doc-Impact: none; ${d.reason} (commit ${d.sha.slice(0, 9)})`));
  const open = [];
  for (const f of families.values()) {
    const eg = `${f.paths.length} code path(s), e.g. ${f.paths[0]}`;
    if (f.changed) findings.push(info(`changed with ${eg}`, f.readme));
    else if (f.root) findings.push(info(`the nearest README of ${eg} is the root README.md (information only)`));
    else open.push(f);
  }
  for (const f of open) {
    const where = `${f.paths.length} code path(s) under ${path.posix.dirname(f.readme)}/ (e.g. ${f.paths[0]})`;
    if (docImpact.length) findings.push(info(`${where} changed and ${f.readme} did not; covered by Doc-Impact`, f.readme));
    else findings.push(fail(`${where} changed and ${f.readme} did not: update it, or add a "Doc-Impact: none; <reason>" trailer`, f.readme));
  }
  const n = [...families.values()];
  return result(
    'readme',
    'nearest README',
    findings,
    `${n.length} README(s) nearest to changed code` + (open.length ? `; ${open.length} unchanged${docImpact.length ? ', covered by Doc-Impact' : ''}` : ''),
  );
}

// ---------------------------------------------------------------------------------------------

export function checkPr(ctx) {
  if (ctx.pr === null) return result('pr', 'PR description', [], 'not read (no --pr)', 'skip');
  const code = ctx.changes.filter((c) => isCode(ctx, c.path));
  const sections = prSections(ctx.prBody ?? '');
  const findings = [];
  const change = sections.get('Change');
  if (change) findings.push(info(`## Change: ${change.split('\n')[0].slice(0, 160)}`));
  if (!code.length) return result('pr', `PR #${ctx.pr} description`, findings, 'no code changed: ## Tests and ## Review not required');
  for (const name of ['Tests', 'Review']) {
    if (!sections.has(name)) findings.push(fail(`the PR changes code (e.g. ${code[0].path}) and its description has no "## ${name}" section`));
    else if (!sections.get(name)) findings.push(fail(`"## ${name}" is empty; it says ${name === 'Tests' ? 'each command run and its result' : 'the independent review: rounds, findings and how each was resolved'}`));
  }
  return result('pr', `PR #${ctx.pr} description`, findings, `${code.length} code path(s) changed; sections: ${[...sections.keys()].join(', ') || 'none'}`);
}

// ---------------------------------------------------------------------------------------------

/**
 * A project that carries the kit keeps its copy as its lock records it (tools/kit/lock.json): every
 * file the lock lists, byte for byte, and nothing else under the paths the kit owns but the
 * project's own files. A repository with no lock (the kit itself, one that does not carry it) is
 * skipped; one whose lock this PR deletes fails.
 */
export function checkKit(ctx) {
  const { repo, head } = ctx;
  const now = kitProblems(repo, head);
  const was = kitProblems(repo, ctx.mergeBase);
  const title = 'kit copy (tools/kit/lock.json)';
  if (!now && !was) return result('kit', title, [], `no ${LOCK_FILE}: not a synced copy of the kit`, 'skip');
  if (!now) return result('kit', title, [fail(`deletes ${LOCK_FILE}: a project that carries the kit keeps its lock, so its copy stays checked`, LOCK_FILE)], 'the lock is deleted');
  const locks = [now.lock, was?.lock].filter(Boolean);
  // The project's own files (its config) sit inside the kit's paths but are no part of the copy.
  const changed = ctx.changes.some((c) => c.path === LOCK_FILE || locks.some((l) => owns(l.paths, c.path) && !l.projectOwned.includes(c.path)));
  const findings = judge(ctx, [{ changed, at: (rev) => (rev === head ? now.problems : was?.problems ?? []) }]);
  const summary = now.lock
    ? `${Object.keys(now.lock.files).length} file(s) of the kit at ${now.lock.kit.commit.slice(0, 9)}; ${now.problems.length} not as the lock says`
    : `${LOCK_FILE} does not read`;
  return result('kit', title, findings, summary);
}

// ---------------------------------------------------------------------------------------------

export const PROTECTED_MESSAGE = 'the owner merges this PR; agents never do';

/**
 * A PR that touches a protected path (config.json `protectedPaths`: the gate, the workflows, the
 * skills) can weaken the checks that let agents merge, so it fails here: the owner merges it.
 */
export function checkProtected(ctx) {
  const globs = ctx.config.protectedPaths ?? [];
  const findings = [];
  const all = new Set();
  for (const g of globs) {
    // Case-insensitive: a Windows checkout loads claude.md as CLAUDE.md.
    const hit = ctx.changes.filter((c) => matches(c.path, g, { ignoreCase: true }));
    if (!hit.length) continue;
    for (const c of hit) all.add(c.path);
    const eg = hit.slice(0, 3).map((c) => c.path).join(', ');
    findings.push(fail(`${PROTECTED_MESSAGE}: it touches ${hit.length} path(s) under ${g} (${eg}${hit.length > 3 ? ', …' : ''})`));
  }
  return result('protected', 'protected paths', findings, all.size ? `${all.size} protected path(s) touched` : `none touched (${globs.join(', ')})`);
}

/** Checks whose failure fails the run even when it is report-only: safety boundaries. */
export const ALWAYS_BLOCKING = ['protected'];

export const CHECKS = [checkSpecs, checkChanges, checkHistory, checkBudgets, checkLinks, checkReadme, checkPr, checkKit, checkProtected];
