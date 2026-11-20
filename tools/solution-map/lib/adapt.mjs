// The one seam to the overview: turns its JSON (version 3) into the view model the page draws.
// Nothing else in the map reads the overview's fields.

/** The overview version this adapter reads. */
export const OVERVIEW_VERSION = 3;

/** `https://github.com/<owner>/<name>` from a git remote URL, or null for any other host. */
export function webBase(remoteUrl) {
  if (!remoteUrl) return null;
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** A link to a path at a commit, or null when the repository has no web page. */
export function pathHref(web, commit, p) {
  if (!web || !commit || !p) return null;
  return `${web}/${p.endsWith('/') ? 'tree' : 'blob'}/${commit}/${p.replace(/\/$/, '')}`;
}

/** `"<line>: <message>"` or `{ line, message }` -> `{ line, message }`. */
export function parseProblem(p) {
  if (p && typeof p === 'object') return { line: p.line ?? null, message: String(p.message ?? '') };
  const m = /^(\d+):\s*(.*)$/s.exec(String(p));
  return m ? { line: Number(m[1]), message: m[2] } : { line: null, message: String(p) };
}

const byDateDesc = (a, b) => (b || '').localeCompare(a || '');

/**
 * The view model.
 * @param {object} ov the overview's JSON, version 3
 * @param {object} [ctx]
 * @param {Record<string, {state?: string, fetchedAt?: string|null, dir?: string}>} [ctx.repoStates] per repo id: `current`, `stale` or `missing`
 * @param {Record<string, string|null>} [ctx.webs] per repo id: its GitHub web base
 * @param {string|null} [ctx.pages] the base address a page line's path is joined to
 * @param {Record<string, boolean>} [ctx.pageAnswers] per page address: whether it answered
 */
export function adapt(ov, ctx = {}) {
  const repoStates = ctx.repoStates || {};
  const webs = ctx.webs || {};
  const answers = ctx.pageAnswers || {};
  const repos = (ov.repos || []).map((r) => ({
    id: r.id, name: r.name, commit: r.commit,
    state: repoStates[r.id]?.state || 'current',
    fetchedAt: repoStates[r.id]?.fetchedAt ?? null,
    web: webs[r.id] ?? null,
  }));
  for (const [id, s] of Object.entries(repoStates)) {
    if (s.state === 'missing' && !repos.some((r) => r.id === id)) repos.push({ id, name: id, commit: null, state: 'missing', fetchedAt: null, web: null, dir: s.dir ?? null });
  }
  const repo = (id) => repos.find((r) => r.id === id) || { id, commit: null, web: null };
  const href = (repoId, p) => { const r = repo(repoId); return pathHref(r.web, r.commit, p); };

  const domains = (ov.domains || []).map((d) => ({ id: d.id, title: d.title, purpose: d.purpose }));
  const domainTitle = (id) => domains.find((d) => d.id === id)?.title || id;
  const systems = (ov.systems || []).map((s) => ({
    id: s.id, title: s.title, purpose: s.purpose,
    repos: [...new Set((s.sides || []).map((x) => x.repo))],
    features: [],
    uncovered: (ov.uncovered || []).filter((u) => u.system === s.id).map((u) => ({ repo: u.repo, path: u.path, href: href(u.repo, u.path) })),
  }));
  const systemTitle = (id) => systems.find((s) => s.id === id)?.title || id;

  const changesFor = (capId) => (ov.changes || []).flatMap((c) => (c.sides || [])
    .filter((s) => (s.capabilities || []).includes(capId))
    .map((s) => ({
      id: c.id, title: c.title, repo: s.repo, review: s.review || '',
      pr: s.landed?.pr ?? null, commit: s.landed?.commit ?? null, date: s.landed?.date ?? null,
      href: s.landed?.commit ? pathHref(repo(s.repo).web, s.landed.commit, `changes/${c.id}/proposal.md`) : null,
    })))
    .sort((a, b) => byDateDesc(a.date, b.date));

  // The pages' base address: null when none is named, undefined when what is named is no web address.
  const pagesBase = (() => {
    if (!ctx.pages) return null;
    try {
      const u = new URL(ctx.pages);
      return /^https?:$/.test(u.protocol) ? u.href.replace(/\/$/, '') : undefined;
    } catch { return undefined; }
  })();
  const pageUrl = (target) => {
    const u = /^https?:\/\//.test(target) ? target : pagesBase ? `${pagesBase}/${target.replace(/^\//, '')}` : null;
    try { return u ? new URL(u).href : null; } catch { return null; }
  };

  const features = {};
  for (const c of ov.capabilities || []) {
    const sides = c.sides || [];
    const scenarios = (c.requirements || []).flatMap((r) => r.scenarios || []);
    const changes = changesFor(c.id);
    const newest = changes.find((x) => x.review) || changes[0] || null;
    const looks = (c.looks || []).map((l) => {
      if (l.kind === 'board') {
        return { kind: 'board', repo: l.repo, path: l.path, id: l.id, caption: l.caption, exists: l.exists !== false, src: `/board/${l.repo}/${l.path}?section=${encodeURIComponent(l.id)}` };
      }
      const url = pageUrl(l.target);
      return { kind: 'page', repo: l.repo, target: l.target, caption: l.caption, url, answers: url ? answers[url] !== false : false };
    });
    features[c.id] = {
      id: c.id, domain: c.domain, domainTitle: domainTitle(c.domain), title: c.title, summary: c.summary || '',
      review: c.review || 'unreviewed',
      systems: (c.systems || []).map((id) => ({ id, title: systemTitle(id) })),
      repos: [...new Set(sides.map((s) => s.repo))],
      tested: [scenarios.filter((s) => s.tested).length, scenarios.length],
      looks,
      spec: sides.map((s) => ({ repo: s.repo, path: s.spec, href: href(s.repo, s.spec) })),
      code: sides.flatMap((s) => (s.code || []).map((p) => ({ repo: s.repo, path: p, href: href(s.repo, p) }))),
      problems: sides.flatMap((s) => (s.problems || []).map((p) => {
        const q = parseProblem(p);
        return { repo: s.repo, spec: s.spec, line: q.line, message: q.message, href: href(s.repo, s.spec) && q.line ? `${href(s.repo, s.spec)}#L${q.line}` : href(s.repo, s.spec) };
      })),
      requirements: (c.requirements || []).map((r) => ({
        name: r.name, text: r.text || '',
        scenarios: (r.scenarios || []).map((s) => ({
          name: s.name, tested: !!s.tested,
          proofs: (s.proofs || []).filter((p) => p.state === 'test').map((p) => ({ path: p.path, selector: p.selector || null, href: href(r.repo || sides[0]?.repo, p.path) })),
        })),
      })),
      changes,
      reviewNote: newest && newest.review ? { text: newest.review, change: newest.id } : null,
      reviewed: c.reviewed ? { pr: c.reviewed.pr ?? null, date: c.reviewed.date ?? null, commit: c.reviewed.commit ?? null } : null,
      waiting: (c.review || 'unreviewed') !== 'approved',
      lastLanded: changes[0]?.date ?? null,
    };
    for (const s of c.systems || []) systems.find((x) => x.id === s)?.features.push(c.id);
  }

  const ids = Object.keys(features);
  const waiting = ids.filter((k) => features[k].waiting)
    .sort((a, b) => byDateDesc(features[a].lastLanded, features[b].lastLanded) || features[a].title.localeCompare(features[b].title));
  const byDomain = domains.map((d) => ({ id: d.id, title: d.title, features: ids.filter((k) => features[k].domain === d.id) }))
    .filter((d) => d.features.length);
  for (const k of ids) if (!domains.some((d) => d.id === features[k].domain) && !byDomain.some((d) => d.id === features[k].domain)) {
    byDomain.push({ id: features[k].domain, title: features[k].domain, features: ids.filter((x) => features[x].domain === features[k].domain) });
  }

  const banners = repoBanners(repos);
  const broken = ids.filter((k) => features[k].problems.length);
  if (broken.length) banners.push({ kind: 'format', features: broken.map((k) => ({ id: k, title: features[k].title })) });
  if (pagesBase === undefined) banners.push({ kind: 'pages-address', value: ctx.pages });
  const down = [...new Set(Object.values(features).flatMap((f) => f.looks).filter((l) => l.kind === 'page' && l.url && !l.answers).map((l) => new URL(l.url).origin))];
  if (down.length) banners.push({ kind: 'pages', origins: down });

  return {
    generatedAt: ov.generatedAt || null,
    repos, domains, systems, features, waiting, byDomain, banners,
    totals: {
      features: ids.length,
      approved: ids.filter((k) => features[k].review === 'approved').length,
      changesRequested: ids.filter((k) => features[k].review === 'changes-requested').length,
      tested: ids.reduce((a, k) => a + features[k].tested[0], 0),
      scenarios: ids.reduce((a, k) => a + features[k].tested[1], 0),
    },
  };
}

/** A banner per repository that is `stale` or `missing`: the one place these banners are made. */
export function repoBanners(repos) {
  return repos.flatMap((r) => r.state === 'stale' ? [{ kind: 'stale', repo: r.id, name: r.name, commit: r.commit, fetchedAt: r.fetchedAt }]
    : r.state === 'missing' ? [{ kind: 'missing', repo: r.id, dir: r.dir ?? null }] : []);
}

/** The view model of a map that could not be read: no features, its repositories' banners and the others given. */
export function emptyModel(banners, repos = []) {
  return { generatedAt: null, repos, domains: [], systems: [], features: {}, waiting: [], byDomain: [], banners: [...repoBanners(repos), ...banners],
    totals: { features: 0, approved: 0, changesRequested: 0, tested: 0, scenarios: 0 } };
}
