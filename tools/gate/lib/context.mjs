// What every check reads: the revisions, the PR's changed paths, its Markdown diff, its commits'
// Doc-Impact trailers and, with --pr, its description.
import path from 'node:path';
import { parseUnifiedDiff } from './diff.mjs';
import { readDocImpact } from './trailers.mjs';
import { matches } from './glob.mjs';

/** Builds the context. Throws on revisions that do not resolve. */
export function buildContext({ repo, base, head, main = 'origin/main', pr = null, prBody = null, config }) {
  const baseSha = repo.resolve(base);
  if (!baseSha) throw new Error(`--base ${base} does not resolve to a commit`);
  const headSha = repo.resolve(head);
  if (!headSha) throw new Error(`--head ${head} does not resolve to a commit (fetch it first)`);
  const mainSha = main ? repo.resolve(main) : null;
  const mergeBase = repo.mergeBase(baseSha, headSha);
  if (!mergeBase) throw new Error(`no merge base between ${baseSha.slice(0, 9)} and ${headSha.slice(0, 9)}: fetch more history`);
  const changes = repo.changes(mergeBase, headSha);
  const changed = new Map(changes.map((c) => [c.path, c.status]));
  const mdDiff = parseUnifiedDiff(changes.some((c) => /\.md$/i.test(c.path)) ? repo.diffU0(mergeBase, headSha, ['*.md', '*.MD']) : '');
  const commits = repo.commits(mergeBase, headSha);
  const notes = [];
  if (main && !mainSha) notes.push(`${main} does not resolve`);
  return {
    repo,
    config,
    base: baseSha,
    head: headSha,
    main: mainSha,
    mergeBase,
    pr: pr === null || pr === undefined ? null : Number(pr),
    prBody,
    changes,
    changed,
    mdDiff,
    commits,
    trailers: readDocImpact(commits),
    notes,
  };
}

/** A path no check reads: vendored code and samples (config.json `ignore`). */
export function isIgnored(ctx, p) {
  return matches(p, ctx.config.ignore ?? []);
}

/**
 * Code, for the readme and pr checks: anything outside `*.md`, `specs/` and `changes/`, and not a
 * `.meta` sidecar (as Unity writes) of a Markdown file or of a folder (at head or at the merge base).
 */
export function isCode(ctx, p) {
  if (/\.md(\.meta)?$/i.test(p) || p.startsWith('specs/') || p.startsWith('changes/')) return false;
  if (p.endsWith('.meta')) {
    const stem = p.slice(0, -'.meta'.length);
    if (ctx.repo.tree(ctx.head).dirs.has(stem) || ctx.repo.tree(ctx.mergeBase).dirs.has(stem)) return false;
  }
  return true;
}

/** The added-line numbers of one file in this PR. */
export function addedLines(ctx, p) {
  return new Set((ctx.mdDiff.get(p)?.added ?? []).map((a) => a.n));
}

/** The nearest README.md up a path's tree, at head or (for removed folders) at the merge base. */
export function nearestReadme(ctx, p) {
  const head = ctx.repo.tree(ctx.head).files;
  const before = ctx.repo.tree(ctx.mergeBase).files;
  let d = path.posix.dirname(p);
  for (;;) {
    const cand = d === '.' || d === '' ? 'README.md' : `${d}/README.md`;
    if (head.has(cand) || before.has(cand)) return cand;
    if (d === '.' || d === '') return 'README.md';
    d = path.posix.dirname(d);
  }
}
