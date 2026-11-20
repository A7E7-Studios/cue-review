// The page's views: pure functions from the view model and the page's state to HTML strings.
// The page (app.mjs) and the tests both import this module; it touches no DOM.

/** @typedef {{ tab: 'waiting'|'explore'|'search', group: 'domain'|'system', sel: string|null, q: string }} Ui */

const ICON = {
  unreviewed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
  approved: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="M4.8 8.3l2.2 2.2 4.2-4.6" stroke="var(--sheet)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'changes-requested': '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .8l7.2 13.4H.8z" fill="currentColor"/><path d="M8 5.6v4" stroke="var(--sheet)" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="var(--sheet)"/></svg>',
};
const WORD = { unreviewed: 'Unreviewed', approved: 'Approved', 'changes-requested': 'Changes requested' };
const WORST = ['changes-requested', 'unreviewed', 'approved'];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Inline Markdown a spec keeps (`code`, **bold**, *emphasis*), escaped. */
export const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
const stt = (s) => `<span class="stt ${s}">${ICON[s]}${WORD[s]}</span>`;
const ic = (s) => `<span class="ic ${s}" title="${WORD[s]}">${ICON[s]}</span>`;
const repoChip = (r) => `<span class="repo">${esc(r)}</span>`;
const sysChip = (s) => `<span class="sys">${esc(s.title)}</span>`;
const link = (href, text, cls = 's-link') => href ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${text}</a>` : `<span>${text}</span>`;
const cov = ([t, n], word = 'tested') => n ? `<span class="cov"><span class="bar"><i style="width:${Math.round(t / n * 100)}%"></i></span>${t} of ${n} ${word}</span>` : '<span class="cov">no scenarios yet</span>';
const date = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const when = (iso) => { if (!iso) return 'never'; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const short = (c) => c ? esc(String(c).slice(0, 7)) : '';
const pr = (n) => n ? `#${esc(n)}` : '';

/* ---------- addresses ---------- */

/**
 * The page's state from an address. A feature id is `<domain>/<capability>`, so it reads as two
 * path segments: `/waiting/<id>`, `/explore/<id>`, `/explore/by-system/<system>/<id>`,
 * `/search/<id>?q=`.
 */
export function parseLocation(pathname, search = '') {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(search).get('q') || '';
  const id = (from) => parts.slice(from).join('/') || null;
  if (parts[0] === 'search') return { tab: q ? 'search' : 'waiting', group: 'domain', sel: id(1), q };
  if (parts[0] === 'explore') {
    if (parts[1] === 'by-system') return { tab: 'explore', group: 'system', sel: id(3), q: '' };
    return { tab: 'explore', group: 'domain', sel: id(1), q: '' };
  }
  return { tab: 'waiting', group: 'domain', sel: parts[0] === 'waiting' ? id(1) : null, q: '' };
}

/** The address of a state; `parseLocation(pathFor(ui))` gives the state back. */
export function pathFor(ui, vm) {
  const f = ui.sel && vm?.features[ui.sel];
  const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  if (ui.tab === 'search') return `/search${f ? '/' + enc(ui.sel) : ''}?q=${encodeURIComponent(ui.q)}`;
  if (ui.tab === 'explore') {
    if (ui.group === 'system') return f ? `/explore/by-system/${enc(f.systems[0]?.id || 'none')}/${enc(ui.sel)}` : '/explore/by-system';
    return f ? `/explore/${enc(ui.sel)}` : '/explore';
  }
  return f ? `/waiting/${enc(ui.sel)}` : '/waiting';
}

/* ---------- search and triage ---------- */

/** Features matching `q`: `[id, where, text]`, the first place each matches. */
export function searchFeatures(vm, q) {
  const ql = String(q || '').trim().toLowerCase();
  if (!ql) return [];
  const hit = (s) => String(s || '').toLowerCase().includes(ql);
  return Object.values(vm.features).map((f) => {
    if (hit(f.title)) return [f.id, 'Title', f.title];
    if (hit(f.summary)) return [f.id, 'Summary', f.summary];
    for (const r of f.requirements) {
      if (hit(r.name)) return [f.id, 'Requirement', r.name];
      if (hit(r.text)) return [f.id, 'Requirement', r.text];
      for (const s of r.scenarios) if (hit(s.name)) return [f.id, 'Scenario', s.name];
    }
    const sys = f.systems.find((s) => hit(s.title));
    if (sys) return [f.id, 'Ships in', sys.title];
    return null;
  }).filter(Boolean);
}

/** What the page says once Start review has opened CueReview for a feature. */
export function reviewStarted(vm, id) {
  const f = vm.features[id];
  return `<div class="box started" role="status"><div class="bh">▶ CueReview is opening</div>`
    + `<div>Start the take by saying “${esc(f.title)}”, so triage knows which feature your remarks are about. One take per feature; a review at the desk and one on a device are separate sessions.</div>`
    + '<div class="s-faint">When you are done, press Copy for agent in CueReview and give it to a triage session.</div></div>';
}

/* ---------- pieces ---------- */

function topBar(vm, ui, st) {
  const chip = (r) => {
    if (r.state === 'missing') return `<span class="s-chip gone">${repoChip(r.id)} not on this computer</span>`;
    if (r.state === 'stale') return `<span class="s-chip stale">${repoChip(r.id)}<span class="mono">${esc(r.name)}</span>·<b class="mono">${short(r.commit)}</b>· fetched ${when(r.fetchedAt)}</span>`;
    return `<span class="s-chip">${repoChip(r.id)}<span class="mono">${esc(r.name)}</span>·<b class="mono">${short(r.commit)}</b></span>`;
  };
  return `<header class="s-top"><span class="s-brand"><i></i>Solution map</span><span class="s-repos">${vm.repos.map(chip).join('')}</span><span class="s-sp"></span>`
    + `<span class="s-faint">${st.refreshing ? 'fetching…' : vm.generatedAt ? 'built ' + when(vm.generatedAt) : ''}</span>`
    + `<button class="s-btn" data-act="refresh" ${st.refreshing ? 'disabled' : ''}>↻ Refresh</button>`
    + `<input class="s-search" id="q" type="search" placeholder="Search features   /" aria-label="Search features" value="${esc(ui.q)}">`
    + `<button class="s-btn icon" data-act="theme" title="Light or dark">◐</button></header>`;
}

/** One line per banner: what is missing, what still shows, what to do. */
export function banners(vm) {
  return vm.banners.map((b) => {
    let text, act = '', tone = '';
    if (b.kind === 'stale') {
      text = `Couldn’t fetch <b>${esc(b.name)}</b>. It shows its main as last fetched, ${when(b.fetchedAt)}${b.commit ? ` (<span class="mono">${short(b.commit)}</span>)` : ''}.`;
      act = '<button class="s-btn" data-act="refresh">Try again</button>';
    } else if (b.kind === 'missing') {
      text = `Repository <b>${esc(b.repo)}</b> isn’t on this computer${b.dir ? `: nothing at <span class="mono">${esc(b.dir)}</span>` : ''}. The map shows the others. Clone it there, or start the map with <span class="mono">--repo ${esc(b.repo)}=&lt;folder&gt;</span>.`;
    } else if (b.kind === 'pages') {
      text = `The live pages don’t open: nothing answers at ${b.origins.map((o) => `<span class="mono">${esc(o)}</span>`).join(', ')}. The designs still show. Start the project’s dev server, then press Refresh.`;
      act = '<button class="s-btn" data-act="refresh">Refresh</button>';
    } else if (b.kind === 'pages-address') {
      text = `The address for the project’s pages, <span class="mono">${esc(b.value)}</span>, isn’t a web address (<span class="mono">http://…</span> or <span class="mono">https://…</span>), so no live page shows. The designs still show. Correct <span class="mono">solutionMap.pages</span> or <span class="mono">--pages</span>.`;
    } else if (b.kind === 'format') {
      tone = 'req';
      text = `<b>${b.features.length} ${b.features.length === 1 ? 'spec breaks' : 'specs break'}</b> the format: ${b.features.map((f) => esc(f.title)).join(', ')}. Each still shows, with its problems listed on its page.`;
      act = `<button class="s-btn" data-open="${esc(b.features[0].id)}">Open it</button>`;
    } else if (b.kind === 'version') {
      tone = 'req';
      text = `The overview here writes version <b>${esc(b.found ?? 'unknown')}</b>; the Solution map reads version <b>${esc(b.reads)}</b>. Take the kit’s matching version (<span class="mono">node tools/kit/sync.mjs</span>).`;
    } else if (b.kind === 'overview-error') {
      tone = 'req';
      text = `The overview couldn’t be built: <span class="mono">${esc(b.message)}</span>`;
    } else return '';
    return `<div class="banner ${tone}" role="status"><span class="bt">${text}</span>${act}</div>`;
  }).join('');
}

function filters(vm, ui) {
  const t = vm.totals;
  return `<div class="s-filters"><span class="fchip ${ui.tab === 'waiting' ? 'on' : ''}">${ic('unreviewed')}<b>${vm.waiting.length}</b> waiting for you</span>`
    + `<span class="fchip">${ic('changes-requested')}<b>${t.changesRequested}</b> changes requested</span>`
    + `<span class="fchip">${ic('approved')}<b>${t.approved}</b> approved</span><span class="s-sep"></span>${cov([t.tested, t.scenarios], 'scenarios tested')}</div>`;
}

function tabs(vm, ui, found) {
  const tab = (id, label, n) => `<button class="s-tab ${ui.tab === id ? 'on' : ''}" data-tab="${id}">${label} <span class="n">${n}</span></button>`;
  return `<nav class="s-tabs">${tab('waiting', 'Waiting for you', vm.waiting.length)}${tab('explore', 'Explore', vm.totals.features)}${ui.q ? tab('search', `Results for “${esc(ui.q)}”`, found.length) : ''}</nav>`;
}

function looksBlock(f, inReview) {
  if (!f.looks.length) return '<p class="s-faint">This feature has no looks: it has no screens.</p>';
  const figs = f.looks.map((l) => {
    if (l.kind === 'board') {
      const body = l.unserved ? '<div class="notyet"><div><b>The board isn’t served</b>This map runs from a saved overview, so it reads no repository. Start it with the repositories to see the design.</div></div>'
        : l.exists ? `<iframe class="frame" sandbox src="${esc(l.src)}" title="${esc(l.caption)}" loading="lazy"></iframe>` : `<div class="notyet"><div><b>The board isn’t in the repository</b>${esc(l.path)} has no section “${esc(l.id)}”.</div></div>`;
      return `<figure class="look"><div class="lt">Design</div>${body}<figcaption>${esc(l.path.replace(/^.*\/looks\//, 'looks/'))}#${esc(l.id)} — ${esc(l.caption)}</figcaption></figure>`;
    }
    if (!l.url || !l.answers) {
      return `<figure class="look"><div class="lt">Live page</div><div class="notyet"><div><b>The page won’t open</b>${l.url ? `Nothing answers at <span class="mono">${esc(l.url)}</span>. Start the project’s dev server and press Refresh.` : `It names <span class="mono">${esc(l.target)}</span>, and the project names no address for its pages (<span class="mono">solutionMap.pages</span>).`}</div></div><figcaption>page: ${esc(l.target)} — ${esc(l.caption)}</figcaption></figure>`;
    }
    return `<figure class="look"><div class="lt">Live page <span class="live">live</span></div><iframe class="frame" sandbox="allow-scripts allow-forms allow-same-origin" src="${esc(l.url)}" title="${esc(l.caption)}" loading="lazy"></iframe><figcaption>page: ${esc(l.url)} — ${esc(l.caption)}</figcaption></figure>`;
  });
  if (inReview && !f.looks.some((l) => l.kind === 'page')) figs.push('<figure class="look"><div class="lt">Built</div><div class="notyet"><div><b>No image of the built feature</b>See it where the review note says.</div></div><figcaption>&nbsp;</figcaption></figure>');
  return `<div class="pair ${figs.length === 1 ? 'one' : ''}">${figs.join('')}</div>`;
}

function meta(f) {
  return `<span>${esc(f.domainTitle)}</span>${f.systems.length ? `<span class="s-faint">ships in</span>${f.systems.map(sysChip).join('')}` : ''}${cov(f.tested)}`;
}

function sinceBox(f) {
  let h = '';
  if (f.review === 'changes-requested') {
    h += `<div class="box"><div class="bh">${ic('changes-requested')}You asked for changes${f.reviewed?.date ? `, ${date(f.reviewed.date)}` : ''}${f.reviewed?.pr ? ` in ${pr(f.reviewed.pr)}` : ''}</div><div class="s-faint">No change that answers it has landed on main yet. When one does, this feature waits for you again.</div></div>`;
  }
  const rows = f.changes.filter((c) => c.date).map((c) => `<div class="chg">${link(c.href, pr(c.pr) || esc(c.id), 'mono s-link')}<span>${esc(c.title)}</span><span class="s-faint">${date(c.date)} · <span class="mono">${short(c.commit)}</span></span></div>`).join('');
  h += `<div class="box"><div class="bh">${f.changes.length ? 'Since your last approval' : 'First review'}</div>${rows || '<div class="s-muted">No change names this feature: its spec was written from the code.</div>'}</div>`;
  return h;
}

function reviewNote(f) {
  if (f.reviewNote) return `<div class="box"><div class="bh">What to look at</div><div class="pre">${md(f.reviewNote.text)}</div><div class="src">From the Review section of changes/${esc(f.reviewNote.change)}/proposal.md</div></div>`;
  const why = f.changes.length ? `The change that names it, ${esc(f.changes[0].id)}, has no Review section in its proposal.` : 'No change names this feature, so there is no review note.';
  return `<div class="box"><div class="bh">What to look at</div><div class="s-muted">${why} Judge it against its Summary and Looks; open it in Explore for its behaviour.</div></div>`;
}

function problemsBox(f) {
  if (!f.problems.length) return '';
  return `<div class="box prob"><div class="bh">${ic('changes-requested')}${f.problems.length} format ${f.problems.length === 1 ? 'problem' : 'problems'} in this spec</div>${f.problems.map((p) => `<div class="chg"><span class="mono">${p.line ? 'line ' + p.line : esc(p.spec)}</span><span>${md(p.message)}</span>${link(p.href, `${esc(p.spec.replace(/^.*\//, ''))}${p.line ? ':' + p.line : ''} ↗`, 'mono s-link')}</div>`).join('')}<div class="s-faint">The rest of the spec shows as written.</div></div>`;
}

function behaviour(f) {
  const n = f.requirements.length;
  return `<details class="beh"><summary>Behaviour <span class="s-faint">${n} ${n === 1 ? 'requirement' : 'requirements'} · ${f.tested[1]} scenarios · ${f.tested[0]} tested</span></summary><div class="bi">`
    + f.requirements.map((r) => `<div class="reqr"><div class="rn">${esc(r.name)}</div><div class="rt">${md(r.text)}</div>${r.scenarios.map((s) => `<div class="scn"><span>${esc(s.name)}</span>${s.proofs.length ? s.proofs.map((p) => link(p.href, `✓ test: ${esc(p.path)}${p.selector ? '::' + esc(p.selector) : ''}`, 'tp')).join('') : '<span class="tp none">untested</span>'}</div>`).join('')}</div>`).join('')
    + '</div></details>';
}

function codeBlock(f) {
  const rows = [...f.spec.map((s) => ({ ...s, kind: 'spec' })), ...f.code];
  if (!rows.length) return '';
  return `<h3 class="s-h2">Spec and code</h3><div class="codel">${rows.map((c) => `<div>${repoChip(c.repo)}<span class="mono">${esc(c.path)}</span>${link(c.href, 'GitHub ↗')}</div>`).join('')}</div>`;
}

function reviewBtn(id) { return `<button class="s-btn primary" data-review="${esc(id)}" title="Opens CueReview to record your review">▶ Start review</button>`; }

/** A feature waiting for the owner. */
export function reviewBody(vm, id, ui) {
  const f = vm.features[id];
  return `<div class="d-head"><div class="d-title"><div class="row"><h2 class="s-h1">${esc(f.title)}</h2>${stt(f.review)}</div><div class="s-meta">${meta(f)}</div></div>`
    + `<div class="s-actions">${reviewBtn(id)}${ui.tab === 'waiting' ? '<span class="s-faint"><kbd>j</kbd> <kbd>k</kbd></span>' : ''}</div></div>`
    + (ui.started === id ? reviewStarted(vm, id) : '')
    + problemsBox(f)
    + `<p class="s-sum">${md(f.summary)}</p><h3 class="s-h2">Looks</h3>${looksBlock(f, true)}`
    + `<div class="a-two">${reviewNote(f)}<div>${sinceBox(f)}</div></div>`;
}

/** Any feature: an approved one shows what it does, a waiting one its review. */
export function featurePage(vm, id, ui) {
  const f = vm.features[id];
  if (f.review !== 'approved') return reviewBody(vm, id, ui) + behaviour(f) + codeBlock(f);
  return `<div class="d-head"><div class="d-title"><div class="row"><h2 class="s-h1">${esc(f.title)}</h2>${stt(f.review)}</div>`
    + `<div class="s-meta">${meta(f)}${f.reviewed?.date ? `<span>Approved ${date(f.reviewed.date)}${f.reviewed.pr ? ' in ' + pr(f.reviewed.pr) : ''}</span>` : ''}</div></div></div>`
    + problemsBox(f)
    + `<h3 class="s-h2">Summary</h3><p class="s-sum">${md(f.summary)}</p><h3 class="s-h2">Looks</h3>${looksBlock(f, false)}`
    + behaviour(f) + codeBlock(f);
}

function itemLine(vm, id, ui) {
  const f = vm.features[id];
  const c = f.changes.find((x) => x.date);
  const line = f.review === 'changes-requested' ? `Changes requested${f.reviewed?.date ? ' ' + date(f.reviewed.date) : ''}` : c ? `${pr(c.pr) || esc(c.id)} · ${date(c.date)}` : 'First review · spec from the code';
  return `<button class="a-item ${ui.sel === id ? 'sel' : ''}" data-sel="${esc(id)}"><span class="t">${ic(f.review)}${esc(f.title)}<span class="s-faint">${esc(f.domainTitle)}</span></span><span class="s">${f.systems.map(sysChip).join('')}</span><span class="s">${line}</span></button>`;
}

function emptyProject(vm) {
  return `<div class="zero"><h2 class="s-h1">No features yet</h2><p>${vm.repos.length ? 'No repository has a spec under <span class="mono">specs/</span> yet' : 'No repository could be read'}, so there is nothing to review.</p>`
    + '<ol><li>Ask an agent to run the <b>spec</b> skill on one system or area. It writes that feature’s spec from the code, marked unreviewed.</li><li>Press <b>Refresh</b>. The feature shows up here, waiting for you.</li></ol>'
    + (vm.systems.length ? '<button class="s-btn primary" data-group="system">See the systems</button>' : '') + '</div>';
}

function zeroBody(vm) {
  const t = vm.totals;
  const untested = Object.values(vm.features).flatMap((f) => f.requirements.flatMap((r) => r.scenarios.filter((s) => !s.tested).map((s) => ({ f, s }))));
  const SHOWN = 8;
  const items = untested.slice(0, SHOWN).map(({ f, s }) => `<li><button class="s-link plain" data-open="${esc(f.id)}">${esc(s.name)}</button> <span class="s-faint">${esc(f.title)}</span></li>`).join('');
  const more = untested.length > SHOWN ? `<p class="s-faint">and ${untested.length - SHOWN} more, each marked untested in its feature’s Behaviour.</p>` : '';
  return `<div class="zero"><span class="zic">${ICON.approved}</span><h2 class="s-h1">Nothing waits for you</h2><p>All ${t.features} features are approved.</p>`
    + (untested.length ? `<div class="box"><div class="bh">Next worth a look: scenarios without a test</div><div>${t.scenarios - t.tested} of ${t.scenarios} scenarios have no test yet. They don’t need your verdict, but a regression there would go unnoticed.</div><ul class="untested">${items}</ul>${more}</div>` : '<p>Every scenario has a test.</p>')
    + '</div>';
}

function waitingTab(vm, ui) {
  if (!vm.totals.features) return `<div class="a-ld"><aside class="a-list"><div class="a-none">No features yet.</div></aside><section class="a-detail">${emptyProject(vm)}</section></div>`;
  if (!vm.waiting.length) return `<div class="a-ld"><aside class="a-list"><div class="a-none">Nothing waits. A feature shows up here when a change to it lands on main.</div></aside><section class="a-detail">${zeroBody(vm)}</section></div>`;
  return `<div class="a-ld"><aside class="a-list"><div class="s-sect"><span>Newest change first</span><span>${vm.waiting.length}</span></div>${vm.waiting.map((k) => itemLine(vm, k, ui)).join('')}</aside><section class="a-detail">${reviewBody(vm, ui.sel, ui)}</section></div>`;
}

function capBtn(vm, id, ui) {
  const f = vm.features[id];
  return `<button class="a-cap ${ui.sel === id ? 'sel' : ''}" data-sel="${esc(id)}">${ic(f.review)}<span class="nm">${esc(f.title)}</span>${f.problems.length ? `<span class="ic changes-requested" title="Format problems">${ICON['changes-requested']}</span>` : ''}${f.waiting ? '<span class="wbadge">waiting</span>' : ''}<span class="cnt">${f.tested[0]}/${f.tested[1]} tested</span></button>`;
}

function exploreTab(vm, ui) {
  const toggle = `<div class="a-grp"><span class="lbl">Group by</span><span class="seg"><button data-group="domain" aria-pressed="${ui.group === 'domain'}">Domain</button><button data-group="system" aria-pressed="${ui.group === 'system'}">System</button></span></div>`;
  let list;
  if (ui.group === 'system') {
    list = vm.systems.map((s) => `<div class="a-sys"><span class="h">${esc(s.title)}${s.repos.map(repoChip).join('')}</span><span class="p">${md(s.purpose)}</span></div>`
      + (s.features.length ? s.features.map((k) => capBtn(vm, k, ui)).join('') : '<div class="a-none sm">No feature yet: no spec covers this system.</div>')
      + (s.uncovered.length ? `<div class="a-unc"><span class="s-faint">Code no spec names:</span>${s.uncovered.map((u) => link(u.href, esc(u.path), 'mono s-link')).join('')}</div>` : '')).join('')
      || '<div class="a-none">The project declares no systems (<span class="mono">specs/systems.json</span>).</div>';
  } else {
    list = vm.byDomain.map((d) => {
      const worst = WORST.find((s) => d.features.some((k) => vm.features[k].review === s));
      return `<div class="a-dom"><span>${esc(d.title)}</span>${ic(worst)}</div>` + d.features.map((k) => capBtn(vm, k, ui)).join('');
    }).join('') || '<div class="a-none">No features yet.</div>';
  }
  const noSystem = `<div class="zero"><h2 class="s-h1">No feature ships in a system yet</h2><p>${vm.systems.length ? 'The systems’ paths cover none of the features’ code' : 'The project declares no systems in <span class="mono">specs/systems.json</span>'}, so there is nothing to group by system.</p><button class="s-btn primary" data-group="domain">Group by domain</button></div>`;
  const detail = ui.sel && vm.features[ui.sel] ? featurePage(vm, ui.sel, ui) : vm.totals.features ? noSystem : emptyProject(vm);
  return `<div class="a-ld"><aside class="a-list">${toggle}${list}</aside><section class="a-detail">${detail}</section></div>`;
}

const markQ = (s, q) => {
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return esc(s);
  const from = Math.max(0, i - 50);
  return esc((from ? '…' : '') + s.slice(from, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
};

function searchTab(vm, ui, found) {
  const q = ui.q.trim();
  if (!found.length) return `<div class="a-ld"><aside class="a-list"><div class="a-none">No feature matches “${esc(q)}” in its title, summary, requirements, scenarios or systems.</div></aside><section class="a-detail"></section></div>`;
  const items = found.map(([k, where, text]) => `<button class="a-res ${ui.sel === k ? 'sel' : ''}" data-sel="${esc(k)}"><span class="t">${ic(vm.features[k].review)}${where === 'Title' ? markQ(vm.features[k].title, q) : esc(vm.features[k].title)}<span class="s-faint">${esc(vm.features[k].domainTitle)}</span></span>${where === 'Title' ? '' : `<span class="x"><span class="s-faint">${where}: </span>${markQ(text, q)}</span>`}</button>`).join('');
  return `<div class="a-ld"><aside class="a-list"><div class="s-sect"><span>Features</span><span>${found.length}</span></div>${items}</aside><section class="a-detail">${featurePage(vm, ui.sel, ui)}</section></div>`;
}

/**
 * Settles the selection for a state: the selected feature if it is in view, else the first one.
 * Returns a new state.
 */
export function settle(vm, ui) {
  const u = { ...ui };
  if (u.tab === 'search' && !u.q.trim()) u.tab = 'waiting';
  const pool = u.tab === 'waiting' ? vm.waiting
    : u.tab === 'search' ? searchFeatures(vm, u.q).map((x) => x[0])
    : u.group === 'system' ? vm.systems.flatMap((s) => s.features) : vm.byDomain.flatMap((d) => d.features);
  if (!pool.includes(u.sel)) u.sel = pool[0] || null;
  return u;
}

/** The whole page for a view model and a state. `st` holds `{ refreshing }`. */
export function renderPage(vm, ui, st = {}) {
  const u = settle(vm, ui);
  const found = u.q ? searchFeatures(vm, u.q) : [];
  const body = u.tab === 'explore' ? exploreTab(vm, u) : u.tab === 'search' ? searchTab(vm, u, found) : waitingTab(vm, u);
  return topBar(vm, u, st) + banners(vm) + filters(vm, u) + tabs(vm, u, found) + body;
}
