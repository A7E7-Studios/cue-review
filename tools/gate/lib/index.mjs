// The gate as a library: runGate() for the CLI, CI and the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from './git.mjs';
import { buildContext } from './context.mjs';
import { CHECKS, ALWAYS_BLOCKING } from './checks.mjs';
import { ID, pathProblem } from './spec.mjs';

export { Repo } from './git.mjs';
export { formatSummary } from './report.mjs';

export const DEFAULT_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

/** Reads and checks config.json. Throws on a missing or mistyped key. */
export function loadConfig(file = DEFAULT_CONFIG) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const need = (ok, what) => {
    if (!ok) throw new Error(`${file}: ${what}`);
  };
  need(typeof c.reportOnly === 'boolean', '"reportOnly" is true or false');
  need(Array.isArray(c.ignore) && c.ignore.every((g) => typeof g === 'string'), '"ignore" is a list of globs');
  need(c.livingDocs && Array.isArray(c.livingDocs.include) && Array.isArray(c.livingDocs.exclude ?? []), '"livingDocs" is { "include": [globs], "exclude": [globs] }');
  need(
    Array.isArray(c.budgets) && c.budgets.every((b) => typeof b.pattern === 'string' && (b.bytes === null || (Number.isInteger(b.bytes) && b.bytes > 0))),
    '"budgets" is a list of { "pattern", "bytes" }, bytes a positive integer or null (no budget)',
  );
  need(Array.isArray(c.history) && c.history.every((r) => r.id && r.message && typeof r.pattern === 'string'), '"history" is a list of { "id", "message", "pattern", "flags"?, "skipProofLines"? }');
  for (const r of c.history) new RegExp(r.pattern, r.flags ?? '');
  need(Array.isArray(c.protectedPaths) && c.protectedPaths.every((g) => typeof g === 'string'), '"protectedPaths" is a list of globs');
  for (const [old, now] of RENAMED) need(c.overview?.[old] === undefined, `"overview.${old}" is named "overview.${now}"`);
  const ex = c.overview?.excludeComponents;
  need(ex === undefined || (Array.isArray(ex) && ex.every((g) => typeof g === 'string')), '"overview.excludeComponents" is a list of globs');
  const cm = c.overview?.componentMarkers;
  need(cm === undefined || (Array.isArray(cm) && cm.every((g) => typeof g === 'string' && g !== '' && !g.includes('/'))), '"overview.componentMarkers" is a list of file-name globs, without /');
  if (c.design !== undefined) designProblems(c.design).forEach((p) => need(false, p));
  return c;
}

const RENAMED = [
  ['moduleMarkers', 'componentMarkers'],
  ['excludeModules', 'excludeComponents'],
];

/** What is wrong with config.json `design`: { tokens, brief, catalogues?, render? }. */
export function designProblems(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['"design" is { "tokens", "brief", "catalogues"?, "render"? }'];
  const out = [];
  for (const k of Object.keys(d)) if (!['tokens', 'brief', 'catalogues', 'render'].includes(k)) out.push(`unknown key "design.${k}" (one of tokens, brief, catalogues, render)`);
  for (const k of ['tokens', 'brief']) {
    const bad = pathProblem(d[k]);
    if (typeof d[k] !== 'string' || bad || d[k].endsWith('/')) out.push(`"design.${k}" is a repository path to a file${typeof d[k] === 'string' && bad ? `: ${bad}` : ''}`);
  }
  if (d.catalogues !== undefined) {
    if (!Array.isArray(d.catalogues)) out.push('"design.catalogues" is a list of { "name", "open" }');
    else {
      const names = new Set();
      d.catalogues.forEach((cat, i) => {
        const name = cat?.name;
        if (typeof name !== 'string' || !ID.test(name)) out.push(`"design.catalogues" entry ${i}: "name" ${JSON.stringify(name)} is not kebab-case`);
        else if (names.has(name)) out.push(`"design.catalogues": "${name}" appears twice`);
        else names.add(name);
        if (typeof cat?.open !== 'string' || !cat.open.includes('{entry}')) out.push(`"design.catalogues" entry ${i}: "open" is a URL template holding {entry}`);
      });
    }
  }
  if (d.render !== undefined && (typeof d.render !== 'string' || !d.render.trim())) out.push('"design.render" is a command, a non-empty string');
  return out;
}

/**
 * Runs every check. Options: repo (Repo or dir), base, head, main, pr, prBody, config, reportOnly.
 * Returns the JSON report: { conclusion: pass|fail, wouldFail: [ids], blocking: [ids], checks, ... }
 * where `blocking` is what fails the run: every failing check, or under reportOnly only the
 * always-blocking ones (`protected`).
 */
export function runGate(opts) {
  const repo = opts.repo instanceof Repo ? opts.repo : Repo.open(opts.repo ?? process.cwd());
  const config = opts.config ?? loadConfig();
  const ctx = buildContext({ ...opts, repo, config });
  const checks = CHECKS.map((fn) => {
    try {
      return fn(ctx);
    } catch (e) {
      const id = fn.name.replace(/^check/, '').toLowerCase();
      return { id, title: id, status: 'fail', summary: 'the check crashed', findings: [{ level: 'fail', message: `internal error: ${e.stack ?? e}` }] };
    }
  });
  const wouldFail = checks.filter((c) => c.status === 'fail').map((c) => c.id);
  const reportOnly = Boolean(opts.reportOnly ?? config.reportOnly);
  // A safety boundary fails the run even when the rest only reports.
  const blocking = wouldFail.filter((id) => !reportOnly || ALWAYS_BLOCKING.includes(id));
  return {
    version: 1,
    reportOnly,
    conclusion: wouldFail.length ? 'fail' : 'pass',
    wouldFail,
    blocking,
    pr: ctx.pr,
    base: ctx.base,
    head: ctx.head,
    main: ctx.main,
    mergeBase: ctx.mergeBase,
    changedFiles: ctx.changes.length,
    docImpact: ctx.trailers.docImpact,
    notes: ctx.notes,
    checks,
  };
}
