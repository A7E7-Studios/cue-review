// One build of the map: fetch every repository, build the overview, ask each live page whether it
// answers, and adapt the result into the view model.
import { buildOverview } from '../../overview/overview.mjs';
import { adapt, emptyModel, webBase, OVERVIEW_VERSION } from './adapt.mjs';
import { fetchRepo as fetchOne, remoteUrl } from './sources.mjs';

/** Whether anything answers at an address within 2 s. */
export async function probeUrl(url) {
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} o
 * @param {{ id: string, dir: string }[]} o.repos
 * @param {string|null} [o.pages] the base address of the project's pages
 * @param {Function} [o.overview] `(repos) => overview JSON`; the kit's overview by default
 * @param {Function} [o.fetchRepo] `(dir) => { state, fetchedAt }`
 * @param {Function} [o.probe] `(url) => boolean`
 * @param {Function} [o.webOf] `(dir) => GitHub web base | null`
 * @returns {Promise<{ model: object, dirs: Record<string, string>, commits: Record<string, string> }>}
 */
export async function buildMap({ repos, pages = null, overview = buildOverview, fetchRepo = fetchOne, probe = probeUrl, webOf = async (dir) => webBase(await remoteUrl(dir)), fromFile = false }) {
  if (fromFile) {
    // A saved overview: no repository is fetched or read; its boards are not served.
    const ov = await overview([]);
    if (ov?.version !== OVERVIEW_VERSION) return { model: emptyModel([{ kind: 'version', found: ov?.version ?? null, reads: OVERVIEW_VERSION }]), dirs: {}, commits: {} };
    const model = adapt(ov, { pages });
    for (const f of Object.values(model.features)) for (const l of f.looks) if (l.kind === 'board') l.unserved = true;
    return { model, dirs: {}, commits: {} };
  }
  const fetched = await Promise.all(repos.map((r) => fetchRepo(r.dir)));
  const states = Object.fromEntries(repos.map((r, i) => [r.id, { ...fetched[i], dir: r.dir }]));
  const present = repos.filter((r) => states[r.id].state !== 'missing');
  const dirs = Object.fromEntries(present.map((r) => [r.id, r.dir]));
  // A map with no overview: each repository's state and banner, and the banners given.
  const plain = (banners) => ({ model: emptyModel(banners, repos.map((r) => ({ id: r.id, name: r.id, commit: null, state: states[r.id].state, fetchedAt: states[r.id].fetchedAt ?? null, web: null, dir: r.dir }))), dirs, commits: {} });
  if (!present.length) return plain([]);
  let ov;
  try {
    ov = await overview(present.map((r) => ({ id: r.id, dir: r.dir, ref: 'origin/main' })));
  } catch (e) {
    return plain([{ kind: 'overview-error', message: String(e.message || e) }]);
  }
  if (ov?.version !== OVERVIEW_VERSION) return plain([{ kind: 'version', found: ov?.version ?? null, reads: OVERVIEW_VERSION }]);
  const webs = Object.fromEntries(await Promise.all(present.map(async (r) => [r.id, await webOf(r.dir)])));
  const commits = Object.fromEntries((ov.repos || []).map((r) => [r.id, r.commit]));
  const ctx = { repoStates: states, webs, pages };
  const urls = [...new Set(Object.values(adapt(ov, ctx).features).flatMap((f) => f.looks).filter((l) => l.kind === 'page' && l.url).map((l) => l.url))];
  const answered = await Promise.all(urls.map((u) => probe(u)));
  const pageAnswers = Object.fromEntries(urls.map((u, i) => [u, answered[i]]));
  return { model: adapt(ov, { ...ctx, pageAnswers }), dirs, commits };
}
