import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adapt, webBase, pathHref, parseProblem } from '../lib/adapt.mjs';
import { validate, SCHEMA } from '../../overview/test/schema.mjs';

const sample = () => JSON.parse(fs.readFileSync(new URL('./fixtures/overview-v3.json', import.meta.url), 'utf8'));
const webs = { app: 'https://github.com/example/notes-app', api: null };

test('the sample holds to the overview schema the kit publishes', () => {
  assert.equal(SCHEMA.properties.version.const, 3);
  assert.deepEqual(validate(sample()), []);
});

test('the queue holds every feature not approved, newest change first', () => {
  const vm = adapt(sample());
  assert.deepEqual(vm.waiting, ['editing/offline-edits', 'sharing/share-links', 'accounts/sign-in', 'editing/tables']);
  assert.ok(vm.waiting.every((k) => vm.features[k].review !== 'approved'));
  assert.equal(vm.totals.features, 8);
  assert.equal(vm.totals.approved, 4);
  assert.equal(vm.totals.changesRequested, 1);
});

test('a feature in review carries its looks, review note and changes since approval', () => {
  const f = adapt(sample(), { webs, pages: 'http://localhost:5173' }).features['editing/offline-edits'];
  assert.equal(f.summary.startsWith('You can keep writing'), true);
  assert.deepEqual(f.looks.map((l) => l.kind), ['board', 'page']);
  assert.equal(f.looks[0].path, 'specs/editing/offline-edits/looks/offline-banner.html');
  assert.equal(f.looks[0].src, '/board/app/specs/editing/offline-edits/looks/offline-banner.html?section=banner');
  assert.equal(f.looks[1].url, 'http://localhost:5173/notes/demo');
  assert.deepEqual(f.reviewNote, { text: 'At the desk: open a note, turn off the network and count to five; the banner shows.', change: 'offline-banner-delay' });
  assert.deepEqual(f.changes.map((c) => [c.id, c.pr]), [['offline-banner-delay', 41]]);
  assert.equal(f.changes[0].href, 'https://github.com/example/notes-app/blob/a91c3e0f00000000000000000000000000000000/changes/offline-banner-delay/proposal.md');
  assert.deepEqual(f.tested, [1, 2]);
  const seeded = adapt(sample()).features['accounts/sign-in'];
  assert.equal(seeded.reviewNote, null);
  assert.deepEqual(seeded.changes, []);
});

test('features group by domain and by system', () => {
  const vm = adapt(sample());
  assert.deepEqual(vm.byDomain.map((d) => [d.id, d.features.length]), [['editing', 2], ['sharing', 1], ['importing', 2], ['accounts', 2], ['operations', 1]]);
  const sys = Object.fromEntries(vm.systems.map((s) => [s.id, s.features]));
  assert.deepEqual(sys.importer, ['importing/markdown-import', 'importing/import-report']);
  assert.ok(sys.editor.includes('accounts/sign-in') && sys.api.includes('accounts/sign-in') && sys.web.includes('accounts/sign-in'));
  assert.deepEqual(vm.features['accounts/sign-in'].systems.map((s) => s.title), ['Editor', 'API', 'Web app']);
  assert.deepEqual(vm.systems.find((s) => s.id === 'release').repos, ['app', 'api']);
});

test('a system no feature ships in is listed as a gap', () => {
  const vm = adapt(sample(), { webs });
  const telemetry = vm.systems.find((s) => s.id === 'telemetry');
  assert.deepEqual(telemetry.features, []);
  const editor = vm.systems.find((s) => s.id === 'editor');
  assert.deepEqual(editor.uncovered, [{ repo: 'app', path: 'src/spellcheck/', href: 'https://github.com/example/notes-app/tree/3f2a9c1d0e4b5a6978c1d2e3f4a5b6c7d8e9f0a1/src/spellcheck' }]);
});

test("a feature's code links point at the commit read", () => {
  const f = adapt(sample(), { webs }).features['editing/offline-edits'];
  const app = '3f2a9c1d0e4b5a6978c1d2e3f4a5b6c7d8e9f0a1';
  assert.deepEqual(f.code.map((c) => [c.repo, c.href]), [
    ['app', `https://github.com/example/notes-app/tree/${app}/src/sync`],
    ['app', `https://github.com/example/notes-app/blob/${app}/src/editor/OfflineBanner.ts`],
    ['api', null],
  ]);
  assert.equal(f.spec[0].href, `https://github.com/example/notes-app/blob/${app}/specs/editing/offline-edits/spec.md`);
  assert.equal(webBase('git@github.com:example/notes-app.git'), 'https://github.com/example/notes-app');
  assert.equal(webBase('https://github.com/example/notes-app'), 'https://github.com/example/notes-app');
  assert.equal(webBase('https://git.example.com/notes-app.git'), null);
  assert.equal(pathHref(null, 'abc', 'src/'), null);
});

test("a spec's format problems reach its feature and a banner", () => {
  const ov = sample();
  ov.capabilities.find((c) => c.id === 'accounts/audit-log').sides[0].problems = [{ line: 31, message: 'The requirement "Entries are kept" has no scenario.' }, '44: a test that is not in the repository'];
  const vm = adapt(ov, { webs: { api: 'https://github.com/example/notes-api' } });
  const f = vm.features['accounts/audit-log'];
  assert.deepEqual(f.problems.map((p) => p.line), [31, 44]);
  assert.match(f.problems[0].href, /spec\.md#L31$/);
  assert.deepEqual(vm.banners.filter((b) => b.kind === 'format'), [{ kind: 'format', features: [{ id: 'accounts/audit-log', title: 'Audit log' }] }]);
  assert.deepEqual(parseProblem('7: no Summary'), { line: 7, message: 'no Summary' });
});

test('an empty project has no features and lists its systems', () => {
  const ov = sample();
  ov.capabilities = [];
  ov.changes = [];
  for (const s of ov.systems) s.capabilities = [];
  const vm = adapt(ov);
  assert.equal(vm.totals.features, 0);
  assert.deepEqual(vm.waiting, []);
  assert.deepEqual(vm.byDomain, []);
  assert.equal(vm.systems.length, 6);
  assert.ok(vm.systems.every((s) => s.features.length === 0));
});
