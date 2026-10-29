// The gate as a library: runGate() for the CLI, CI and the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from './git.mjs';
import { buildContext } from './context.mjs';
import { CHECKS, ALWAYS_BLOCKING } from './checks.mjs';

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
  const ex = c.overview?.excludeModules;
  need(ex === undefined || (Array.isArray(ex) && ex.every((g) => typeof g === 'string')), '"overview.excludeModules" is a list of globs');
  const mm = c.overview?.moduleMarkers;
  need(mm === undefined || (Array.isArray(mm) && mm.every((g) => typeof g === 'string' && g !== '' && !g.includes('/'))), '"overview.moduleMarkers" is a list of file-name globs, without /');
  return c;
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
