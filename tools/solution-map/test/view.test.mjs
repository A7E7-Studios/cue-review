import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adapt } from '../lib/adapt.mjs';
import { renderPage, parseLocation, pathFor, searchFeatures, featurePage, settle } from '../page/view.mjs';

const sample = () => JSON.parse(fs.readFileSync(new URL('./fixtures/overview-v3.json', import.meta.url), 'utf8'));
const ui = (o = {}) => ({ tab: 'waiting', group: 'domain', sel: null, q: '', ...o });

test('start review says what to say at the start of the take', () => {
  const vm = adapt(sample());
  const before = renderPage(vm, ui({ sel: 'editing/offline-edits' }));
  assert.match(before, /<button class="s-btn primary" data-review="editing\/offline-edits"[^>]*>▶ Start review<\/button>/);
  assert.doesNotMatch(before, /CueReview is opening/);
  assert.doesNotMatch(before, /Copy for triage/);
  const after = renderPage(vm, ui({ sel: 'editing/offline-edits', started: 'editing/offline-edits' }));
  assert.match(after, /CueReview is opening/);
  assert.match(after, /Start the take by saying “Offline edits”/);
  assert.match(after, /press Copy for agent in CueReview and give it to a triage session/);
  assert.doesNotMatch(renderPage(vm, ui({ sel: 'sharing/share-links', started: 'editing/offline-edits' })), /CueReview is opening/);
  assert.match(renderPage(vm, ui({ sel: 'sharing/share-links' })), /The change that names it, share-links-expiry, has no Review section/);
  assert.match(renderPage(vm, ui({ sel: 'accounts/sign-in' })), /No change names this feature, so there is no review note/);
});

test('nothing waiting says so and points at untested scenarios', () => {
  const ov = sample();
  for (const c of ov.capabilities) c.review = 'approved';
  const vm = adapt(ov);
  assert.deepEqual(vm.waiting, []);
  const html = renderPage(vm, ui());
  assert.match(html, /Nothing waits for you/);
  assert.match(html, /2 of 11 scenarios have no test yet\./);
  assert.match(html, /data-open="editing\/offline-edits">The banner shows after five seconds<\/button> <span class="s-faint">Offline edits<\/span>/);
  assert.match(html, /data-open="importing\/markdown-import">A picture travels with its note<\/button> <span class="s-faint">Markdown import<\/span>/);
});

test('an approved feature folds its behaviour away', () => {
  const vm = adapt(sample(), { webs: { app: 'https://github.com/example/notes-app' } });
  const html = featurePage(vm, 'importing/markdown-import', ui({ tab: 'explore' }));
  assert.match(html, /<h3 class="s-h2">Summary<\/h3>/);
  assert.match(html, /<details class="beh"><summary>Behaviour <span class="s-faint">1 requirement · 3 scenarios · 2 tested/);
  assert.doesNotMatch(html, /<details class="beh" open/);
  assert.match(html, /✓ test: tools\/importer\/markdown\/headings\.test\.ts/);
  assert.match(html, /untested/);
  assert.match(html, /ships in<\/span><span class="sys">Importer<\/span>/);
  assert.match(html, /tools\/importer\/markdown\//);
  assert.match(html, /Approved 12 Oct in #30/);
});

test('explore by system without systems says so, and keeps the features', () => {
  const ov = sample();
  ov.systems = [];
  for (const c of ov.capabilities) c.systems = [];
  const html = renderPage(adapt(ov), ui({ tab: 'explore', group: 'system' }));
  assert.match(html, /<h2 class="s-h1">No feature ships in a system yet<\/h2><p>The project declares no systems in <span class="mono">specs\/systems\.json<\/span>, so there is nothing to group by system\.<\/p>/);
  assert.doesNotMatch(html, /No features yet/);
  // Systems declared, but none of the features' code in any of them.
  const off = sample();
  for (const c of off.capabilities) c.systems = [];
  for (const s of off.systems) s.capabilities = [];
  assert.match(renderPage(adapt(off), ui({ tab: 'explore', group: 'system' })), /<p>The systems’ paths cover none of the features’ code, so there is nothing to group by system\.<\/p>/);
  const none = renderPage(adapt({ ...sample(), capabilities: [] }), ui({ tab: 'explore', group: 'system' }));
  assert.match(none, /No features yet/);
});

test('a system no feature ships in, and a project with no spec, say so in words', () => {
  const html = renderPage(adapt(sample()), ui({ tab: 'explore', group: 'system' }));
  assert.match(html, /<span class="h">Telemetry<span class="repo">api<\/span><\/span><span class="p">Crash and usage reports\.<\/span><\/div><div class="a-none sm">No feature yet: no spec covers this system\.<\/div>/);
  assert.match(html, /Code no spec names:<\/span><span>src\/spellcheck\/<\/span>/);
  const empty = renderPage(adapt({ ...sample(), capabilities: [], changes: [] }), ui());
  assert.match(empty, /<h2 class="s-h1">No features yet<\/h2>/);
  assert.match(empty, /Ask an agent to run the <b>spec<\/b> skill on one system or area/);
  assert.match(empty, /data-group="system">See the systems<\/button>/);
});

test('a page line that does not answer becomes a placeholder', () => {
  const ov = sample();
  const down = adapt(ov, { pages: 'http://localhost:5173', pageAnswers: { 'http://localhost:5173/notes/demo': false } });
  const html = renderPage(down, ui({ sel: 'editing/offline-edits' }));
  assert.match(html, /The page won’t open<\/b>Nothing answers at <span class="mono">http:\/\/localhost:5173\/notes\/demo/);
  assert.match(html, /The live pages don’t open: nothing answers at <span class="mono">http:\/\/localhost:5173<\/span>/);
  const up = renderPage(adapt(ov, { pages: 'http://localhost:5173', pageAnswers: { 'http://localhost:5173/notes/demo': true } }), ui({ sel: 'editing/offline-edits' }));
  assert.match(up, /<iframe class="frame" sandbox="allow-scripts allow-forms allow-same-origin" src="http:\/\/localhost:5173\/notes\/demo"/);
  assert.match(up, /<iframe class="frame" sandbox src="\/board\/app\/specs\/editing\/offline-edits\/looks\/offline-banner\.html\?section=banner"/);
  const nobase = renderPage(adapt(ov), ui({ sel: 'editing/offline-edits' }));
  assert.match(nobase, /the project names no address for its pages/);
  // A pages address that is no web address: a banner, never a failed build.
  for (const pages of ['localhost:5173/x', 'not an address']) {
    const vm = adapt(ov, { pages });
    assert.deepEqual(vm.banners.filter((b) => b.kind === 'pages-address'), [{ kind: 'pages-address', value: pages }]);
    assert.match(renderPage(vm, ui({ sel: 'editing/offline-edits' })), /isn’t a web address/);
  }
});

test('search finds features by title, summary, requirement, scenario and system', () => {
  const vm = adapt(sample());
  const where = (q) => Object.fromEntries(searchFeatures(vm, q).map(([k, w]) => [k, w]));
  assert.deepEqual(where('tables'), { 'editing/tables': 'Title' });
  assert.equal(where('30 days')['accounts/sign-in'], 'Summary');
  assert.equal(where('headings and links')['importing/markdown-import'], 'Requirement');
  assert.equal(where('expired link')['sharing/share-links'], 'Scenario');
  assert.equal(where('folder of markdown')['importing/markdown-import'], 'Summary');
  assert.deepEqual(where('importer'), { 'importing/markdown-import': 'Requirement', 'importing/import-report': 'Requirement' });
  assert.equal(where('web app')['accounts/audit-log'], 'Ships in');
  const html = renderPage(vm, ui({ tab: 'search', q: 'tables' }));
  assert.match(html, /Results for “tables” <span class="n">1/);
  assert.match(html, /<mark>Tables<\/mark>/);
  assert.match(renderPage(vm, ui({ tab: 'search', q: 'zebra' })), /No feature matches “zebra”/);
});

test('every view has its own address', () => {
  const vm = adapt(sample());
  const states = [
    ui({ sel: 'sharing/share-links' }),
    ui({ tab: 'explore', sel: 'importing/import-report' }),
    ui({ tab: 'explore', group: 'system', sel: 'importing/import-report' }),
    ui({ tab: 'search', q: 'link', sel: 'sharing/share-links' }),
  ];
  const paths = states.map((s) => pathFor(s, vm));
  assert.deepEqual(paths, [
    '/waiting/sharing/share-links',
    '/explore/importing/import-report',
    '/explore/by-system/importer/importing/import-report',
    '/search/sharing/share-links?q=link',
  ]);
  for (let i = 0; i < states.length; i++) {
    const [p, s] = paths[i].split('?');
    assert.deepEqual(settle(vm, parseLocation(p, s ? '?' + s : '')), settle(vm, states[i]));
  }
  assert.deepEqual(parseLocation('/'), ui());
});
