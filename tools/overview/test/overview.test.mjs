// The overview end to end on two throwaway repositories of a notes app: features in both, their
// review across sides and the commit that set it, Looks (a board present and missing, a page),
// tables, tested and untested scenarios, systems (nested, across repositories, a feature in
// several, a system no feature ships in, code outside every system), change folders, components
// and their system, the --assets copy of boards, the --summary text and the schema's shape.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildOverview, copyAssets, formatSummary, parseRepoArg, isTestAssembly, systemOf, sectionText, OVERVIEW_DIR } from '../overview.mjs';
import { makeRepo, git, specText, proposalText, DOMAINS } from '../../gate/test/helpers.mjs';
import { BOM } from '../../gate/lib/git.mjs';
import { SCHEMA, validate } from './schema.mjs';

const CLI = path.join(OVERVIEW_DIR, 'overview.mjs');

const plain = (o) => JSON.parse(JSON.stringify(o));
const sc = (name, steps, proofs, table) => ({ name, steps, proofs, ...(table ? { table } : {}) });

/** Runs `fn` with git's author and committer dates at `iso`, so commit dates are known. */
function on(iso, fn) {
  const keep = [process.env.GIT_AUTHOR_DATE, process.env.GIT_COMMITTER_DATE];
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = iso;
  try {
    return fn();
  } finally {
    for (const [k, v] of [
      ['GIT_AUTHOR_DATE', keep[0]],
      ['GIT_COMMITTER_DATE', keep[1]],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BOARD = '<!doctype html><style>.c{color:teal}</style><section id="cursors">Two cursors</section>\n';
const PAGES = (review, summary = 'A page holds its notes.') =>
  specText({ title: 'Pages', review, code: ['src/pages.js'], summary, scenarios: [sc('A page opens', ['WHEN a page is chosen', 'THEN it shows'], ['test: src/pages.test.js'])] });

function fixtures() {
  const app = on('2026-10-01T09:00:00Z', () =>
    makeRepo(
      {
        'README.md': '# Notes app\n\nShared notes for **small teams**.\n',
        'specs/README.md': '# Specs\n',
        'specs/domains.json': DOMAINS,
        'specs/systems.json': JSON.stringify([
          { id: 'editor', title: 'Editor', purpose: 'The app people write notes in.', paths: ['src/'] },
          { id: 'sync-engine', title: 'Sync engine', purpose: 'Sends edits between devices.', paths: ['src/sync/'] },
          { id: 'importer', title: 'Importer', purpose: 'Turns text files into notes.', paths: ['tools/importer/'] },
        ]),
        // the old key names are not read: the defaults apply
        'tools/gate/config.json': JSON.stringify({ ignore: ['vendor/**'], overview: { excludeModules: ['src/**'], moduleMarkers: ['go.mod'] } }),
        'vendor/lib/README.md': '# Vendor lib\n',
        'vendor/lib/Vendor.asmdef': '{ "name": "Vendor" }\n',
        '.github/README.md': '# GitHub\n',
        'docs/README.md': '# Docs\n\nPlanning documents.\n',
        'dev/mock/README.md': '# A mockup\n',
        'fixtures/x/package.json': '{ "name": "fixture" }\n',
        'src/README.md': '# Source\n\nThe app code, one folder per component.\n',
        'src/cursors/cursors.js': '1\n',
        'src/cursors/cursors.test.js': '1\n',
        'src/pages.js': '1\n',
        'src/pages.test.js': '1\n',
        'src/editor/Banner.ts': '1\n',
        'src/sync/README.md': '# Sync\n\nKeeps edits made offline.\n',
        'src/sync/offline.js': '1\n',
        'src/sync/offline.test.js': '1\n',
        'src/quick/README.md': '# Quick menu\n\nThe menu that opens at the cursor.\n',
        'src/quick/Quick.asmdef': `${BOM}{ "name": "Notes.Quick" }\n`,
        'src/quick/menu.js': '1\n',
        'src/quick/menu.test.js': '1\n',
        'src/quick/Tests/Notes.Quick.Tests.asmdef': '{ "name": "Notes.Quick.Tests" }\n',
        'src/collab/Notes.Collaboration.asmdef': '{ "name": "Notes.Collaboration", "references": [] }\n',
        'src/collab/Collab.cs': '1\n',
        'src/collab/PlayTests/Play.asmdef': '{ "name": "Notes.Collaboration.PlayModeTests" }\n',
        'src/collab/Checks/Odd.asmdef': '{ "name": "Notes.Collaboration.Tests.Odd" }\n',
        'src/collab/Editor/Notes.Collaboration.Editor.asmdef': '{ "name": "Notes.Collaboration.Editor" }\n',
        'src/collab/Editor/Tool.cs': '1\n',
        'tools/importer/package.json': JSON.stringify({ name: '@notes/importer', description: 'Imports text files.' }),
        'tools/voice/package.json': JSON.stringify({ name: '@notes/voice', description: 'The **reader** speaks, in `natural` voices.' }),
        'tools/voice/voice.py': '1\n',
        'tools/voice/node_modules/dep/package.json': '{ "name": "dep" }\n',
        'tools/voice/test/fixtures/pkg/package.json': '{ "name": "pkg" }\n',
      },
      { prefix: 'overview-app-' },
    ),
  );
  const backend = on('2026-10-01T09:00:00Z', () =>
    makeRepo(
      {
        'README.md': '# Notes backend\n\nThe API and the site.\n',
        'specs/domains.json': DOMAINS,
        'specs/systems.json': JSON.stringify([
          { id: 'sync-engine', title: 'Sync service', purpose: 'Not the purpose: the app gives one.', paths: ['server/sync/'] },
          { id: 'site', title: 'Site', purpose: 'The web app people sign in to.', paths: ['site/'] },
        ]),
        'site/README.md': '# Site\n\nThe web app people sign in to.\n',
        'site/package.json': JSON.stringify({ name: 'site', description: 'Not the summary: the README has one.' }),
        'site/cursors.ts': '1\n',
        'site/cursors.test.ts': '1\n',
        'site/legacy/README.md': '# Legacy pages\n\nThe old sign-in pages.\n',
        'server/sync/README.md': '# Relay\n\nPasses edits on.\n',
        'server/sync/relay.ts': '1\n',
        'docs/design/README.md': '# A design proposal\n',
        'packages/viewer/package.json': JSON.stringify({ name: '@notes/viewer', description: 'The note viewer.' }),
        'packages/viewer/proof/hotspots/README.md': '# Hotspots proof\n',
      },
      { prefix: 'overview-backend-' },
    ),
  );
  git(app.dir, ['config', 'remote.origin.url', 'https://github.com/example-org/notes.git']);

  app.write({
    'specs/collaboration/shared-cursors/spec.md': specText({
      review: 'approved',
      code: ['src/cursors/'],
      looks: ['looks/cursors.html#cursors — Two cursors in one note', 'page: /notes/<id> — Open a note in two windows'],
      scenarios: [
        sc('A collaborator edits the same note', ['GIVEN two users', 'WHEN one types', 'THEN the other sees a cursor'], ['test: src/cursors/cursors.test.js::Cursors.Others']),
        sc('A collaborator leaves', ['WHEN a collaborator leaves', 'THEN its cursor goes'], ['test: src/cursors/gone.test.js']),
        sc('A cursor fades when idle', ['WHEN a collaborator stops typing', 'THEN the cursor fades'], []),
      ],
    }),
    'specs/collaboration/shared-cursors/looks/cursors.html': BOARD,
    'specs/collaboration/quick-menu/spec.md': specText({
      title: 'Quick menu',
      code: ['src/quick/menu.js', 'src/collab/Editor/Tool.cs'],
      summary: 'The menu opens on a long press.',
      looks: ['looks/menu.html#menu — The menu at the cursor'],
      scenarios: [
        sc('A long press shows the menu', ['WHEN the user presses long', 'THEN the menu shows'], ['test: src/quick/menu.test.js']),
        sc('The menu comes back', ['WHEN the user presses again', 'THEN the menu comes back'], ['desk: pass 2026-10-30, build 1.4.2, by owner']),
      ],
    }),
    'specs/library/offline-edits/spec.md': specText({
      title: 'Offline edits',
      code: ['src/sync/', 'src/editor/Banner.ts'],
      summary: 'You can keep writing when the connection drops.',
      requirements: [
        {
          name: 'Edits made offline are kept',
          text: 'When the connection drops, the app SHALL keep every edit, because a user otherwise loses work.',
          scenarios: [
            sc('An edit made offline reaches the others', ['WHEN a user edits offline and the connection returns', 'THEN the edit reaches the others'], ['test: src/sync/offline.test.js::keeps edits']),
            sc('Edits wait as long as the connection is gone', [], ['test: src/sync/offline.test.js::keeps edits for days'], [['Offline for', 'The edits are sent'], ['5 seconds', 'when it returns'], ['3 days', 'when it returns']]),
          ],
        },
      ],
    }),
    'specs/layout/pages/spec.md': PAGES('unreviewed'),
    'specs/layout/sections/spec.md': specText({
      title: 'Sections',
      review: 'maybe',
      code: ['src/pages.js'],
      summary: 'Sections stay where they are placed.',
      scenarios: [sc('A section stays', ['WHEN a section is placed', 'THEN it shows'], ['test: src/pages.test.js'])],
    }),
    'specs/reading/voice/spec.md': specText({
      title: 'Voice',
      review: 'approved',
      code: ['tools/voice/'],
      summary: 'The reader speaks.',
      scenarios: [
        sc('It speaks', ['WHEN it answers', 'THEN it speaks'], ['test: tools/voice/voice.py']),
        sc('It pauses when asked', ['WHEN the user says stop', 'THEN it pauses'], []),
      ],
    }),
  });
  const specs = on('2026-10-02T09:00:00Z', () => app.commit('feat: specs (#10)'));
  app.write({ 'specs/layout/pages/spec.md': PAGES('approved') });
  const approved = on('2026-10-03T09:00:00Z', () => app.commit('docs: approve pages (#11)'));
  app.write({ 'specs/layout/pages/spec.md': PAGES('approved', 'A page holds its notes, in order.') });
  on('2026-10-04T09:00:00Z', () => app.commit('docs: reword pages'));
  app.write({
    'changes/notes-sync/proposal.md': proposalText({
      title: 'Offline edits reach everyone',
      capabilities: ['library/offline-edits', 'collaboration/quick-menu'],
      removes: ['library/old-sync'],
    }).replace('At a desk, with a second browser window.\n', 'At a **desk**, with a second\nbrowser window.\n\nThen on a phone, offline.\n\n```\n## not a heading\n```\n\n## Settled questions\n\nNone.\n'),
    'changes/notes-sync/look.md': '# Look\n',
  });
  const landed = on('2026-10-05T09:00:00Z', () => app.commit('feat: notes sync (#12)'));
  app.write({ 'changes/notes-sync/design.md': '# Design\n' });
  on('2026-10-06T09:00:00Z', () => app.commit('docs: notes sync design'));

  backend.write({
    'specs/collaboration/shared-cursors/spec.md': specText({
      title: 'Shared cursors on the site',
      review: 'changes-requested',
      code: ['site/cursors.ts'],
      summary: 'The site lists collaborators.',
      looks: ['page: https://example.invalid/site — The collaborator list'],
      scenarios: [sc('The site lists collaborators', ['WHEN a session runs', 'THEN the site lists its collaborators'], ['test: site/cursors.test.ts'])],
    }),
    'specs/library/offline-edits/spec.md': specText({
      title: 'Offline edits on the server',
      review: 'approved',
      code: ['server/sync/'],
      summary: 'The server keeps edits in order.',
      scenarios: [sc('Edits arrive in order', ['WHEN two edits arrive', 'THEN they apply in order'], [])],
    }),
    'changes/notes-sync/proposal.md': proposalText({ title: 'Backend side', capabilities: ['library/offline-edits'] }),
    'changes/no-proposal/tasks.md': '# Tasks\n',
  });
  const backendSpecs = on('2026-10-07T09:00:00Z', () => backend.commit('feat: backend specs (#3)'));

  // The checkouts move on; the overview reads main.
  app.branch('elsewhere').write({ 'specs/collaboration/shared-cursors/spec.md': 'garbage\n', 'changes/other/proposal.md': proposalText() });
  app.commit('wip: elsewhere');
  app.write({ 'src/README.md': '# Dirty\n' });
  return { app, backend, specs, approved, landed, backendSpecs };
}

/** The two repositories, built once for every test that only reads them. */
let built = null;
const shared = () => (built ??= fixtures());
after(() => {
  built?.app.cleanup();
  built?.backend.cleanup();
});

const both = (f) => [parseRepoArg(`app=${f.app.dir}@main`), parseRepoArg(`backend=${f.backend.dir}@main`)];

test('overview: two repositories merge into one index whose shape the schema describes', (t) => {
  const f = shared();
  const o = buildOverview(both(f), { now: new Date('2026-10-29T12:00:00Z') });
  assert.deepEqual(validate(plain(o), SCHEMA), []);
  assert.notDeepEqual(validate({ ...plain(o), extra: 1 }, SCHEMA), [], 'the check rejects an unknown key');
  for (const k of SCHEMA.required) assert.ok(k in o, k);
  assert.equal(o.version, 3);
  assert.equal(o.generatedAt, '2026-10-29T12:00:00.000Z');
  assert.deepEqual(
    o.repos.map((r) => [r.id, r.ref, r.commit]),
    [
      ['app', 'main', f.app.rev('main')],
      ['backend', 'main', f.backend.rev('main')],
    ],
  );
  assert.equal(o.repos[0].name, 'example-org/notes');
  assert.equal(o.repos[1].name, path.basename(f.backend.dir));
  assert.equal(o.domains.length, 7);

  // features in domain order, then id; the review across sides
  assert.deepEqual(
    o.capabilities.map((c) => [c.id, c.review, c.sides.map((s) => s.review)]),
    [
      ['collaboration/quick-menu', 'unreviewed', ['unreviewed']],
      ['collaboration/shared-cursors', 'changes-requested', ['approved', 'changes-requested']],
      ['library/offline-edits', 'unreviewed', ['unreviewed', 'approved']],
      ['layout/pages', 'approved', ['approved']],
      ['layout/sections', 'unreviewed', [null]],
      ['reading/voice', 'approved', ['approved']],
    ],
  );
  const cap = (id) => o.capabilities.find((c) => c.id === id);
  const cursors = cap('collaboration/shared-cursors');
  assert.equal(cursors.title, 'Shared cursors', 'the first repository given names it');
  assert.equal(cursors.summary, 'A cursor shows where each collaborator is typing.');
  assert.deepEqual(
    cursors.sides.map((s) => [s.repo, s.spec, s.code, s.systems, s.components, s.problems]),
    [
      ['app', 'specs/collaboration/shared-cursors/spec.md', ['src/cursors/'], ['editor'], ['src'], []],
      ['backend', 'specs/collaboration/shared-cursors/spec.md', ['site/cursors.ts'], ['site'], ['site'], []],
    ],
  );
  assert.deepEqual(cursors.systems, ['editor', 'site']);
  assert.deepEqual(cursors.requirements.map((r) => r.repo), ['app', 'backend']);
  assert.deepEqual(cursors.pendingChanges, []);

  // the commit that last set review, per side and the newest of them
  assert.deepEqual(cursors.sides[0].reviewed, { commit: f.specs, date: cursors.sides[0].reviewed.date, pr: 10 });
  assert.deepEqual([cursors.sides[1].reviewed.commit, cursors.sides[1].reviewed.pr], [f.backendSpecs, 3]);
  assert.deepEqual(cursors.reviewed, cursors.sides[1].reviewed);
  assert.equal(Date.parse(cursors.reviewed.date), Date.parse('2026-10-07T09:00:00Z'));
  assert.deepEqual([cap('layout/pages').reviewed.commit, cap('layout/pages').reviewed.pr], [f.approved, 11], 'not the later reword');
  assert.equal(cap('layout/pages').summary, 'A page holds its notes, in order.');

  // Looks: a board present, a board missing, pages
  assert.deepEqual(cursors.looks, [
    { repo: 'app', kind: 'board', path: 'specs/collaboration/shared-cursors/looks/cursors.html', id: 'cursors', caption: 'Two cursors in one note', exists: true, asset: null },
    { repo: 'app', kind: 'page', target: '/notes/<id>', caption: 'Open a note in two windows' },
    { repo: 'backend', kind: 'page', target: 'https://example.invalid/site', caption: 'The collaborator list' },
  ]);
  assert.deepEqual(cap('collaboration/quick-menu').looks, [
    { repo: 'app', kind: 'board', path: 'specs/collaboration/quick-menu/looks/menu.html', id: 'menu', caption: 'The menu at the cursor', exists: false, asset: null },
  ]);
  assert.deepEqual(cap('layout/pages').looks, []);

  // scenarios: tested, a test path missing at the ref, untested, an invalid PROOF line, a table
  const scenarios = cursors.requirements.flatMap((r) => r.scenarios);
  assert.deepEqual(
    scenarios.map((s) => [s.slug, s.tested, s.table]),
    [
      ['a-collaborator-edits-the-same-note', true, null],
      ['a-collaborator-leaves', true, null],
      ['a-cursor-fades-when-idle', false, null],
      ['the-site-lists-collaborators', true, null],
    ],
  );
  assert.equal(scenarios[0].text, 'GIVEN two users\nWHEN one types\nTHEN the other sees a cursor');
  assert.deepEqual(scenarios[0].proofs, [{ check: 'test', state: 'test', path: 'src/cursors/cursors.test.js', selector: 'Cursors.Others', exists: true }]);
  assert.deepEqual(scenarios[1].proofs, [{ check: 'test', state: 'test', path: 'src/cursors/gone.test.js', exists: false }]);
  assert.deepEqual(scenarios[2].proofs, []);
  const quick = cap('collaboration/quick-menu').requirements[0].scenarios;
  assert.deepEqual(quick.map((s) => s.tested), [true, false]);
  assert.deepEqual(Object.keys(quick[1].proofs[0]), ['check', 'state', 'error']);
  assert.deepEqual([quick[1].proofs[0].check, quick[1].proofs[0].state], ['desk', 'invalid']);
  assert.match(quick[1].proofs[0].error, /proven by tests only/);
  const offline = cap('library/offline-edits');
  const table = offline.requirements[0].scenarios[1];
  assert.deepEqual(table.table, { header: ['Offline for', 'The edits are sent'], rows: [['5 seconds', 'when it returns'], ['3 days', 'when it returns']] });
  assert.equal(table.text, '| Offline for | The edits are sent |\n| 5 seconds | when it returns |\n| 3 days | when it returns |');
  assert.equal(offline.requirements[1].scenarios[0].tested, false);

  // a side whose review does not read: unreviewed, its problem kept with its line
  const sections = cap('layout/sections');
  assert.deepEqual(sections.sides[0].problems, [{ line: 1, message: 'review "maybe" is not unreviewed, approved, changes-requested' }]);

  // systems: nested (nearest wins), across repositories, a feature in several, one with no feature
  assert.deepEqual(offline.sides.map((s) => s.systems), [['editor', 'sync-engine'], ['sync-engine']]);
  assert.deepEqual(offline.systems, ['editor', 'sync-engine']);
  assert.deepEqual(offline.sides[0].components, ['src/sync', 'src']);
  assert.deepEqual(cap('reading/voice').systems, []);
  assert.deepEqual(
    o.systems.map((s) => [s.id, s.title, s.sides, s.capabilities, s.components.map((c) => `${c.repo}:${c.path}`)]),
    [
      ['editor', 'Editor', [{ repo: 'app', paths: ['src/'] }], ['collaboration/quick-menu', 'collaboration/shared-cursors', 'layout/pages', 'layout/sections', 'library/offline-edits'], ['app:src', 'app:src/collab', 'app:src/collab/Editor', 'app:src/quick']],
      ['sync-engine', 'Sync engine', [{ repo: 'app', paths: ['src/sync/'] }, { repo: 'backend', paths: ['server/sync/'] }], ['library/offline-edits'], ['app:src/sync', 'backend:server/sync']],
      ['importer', 'Importer', [{ repo: 'app', paths: ['tools/importer/'] }], [], ['app:tools/importer']],
      ['site', 'Site', [{ repo: 'backend', paths: ['site/'] }], ['collaboration/shared-cursors'], ['backend:site', 'backend:site/legacy']],
    ],
  );
  assert.equal(o.systems[1].purpose, 'Sends edits between devices.', 'the first repository given');

  // code outside every system, and components in a system that no spec names
  assert.deepEqual(o.outside, {
    components: [
      { repo: 'app', path: 'tools/voice' },
      { repo: 'backend', path: 'packages/viewer' },
    ],
    code: [{ repo: 'app', capability: 'reading/voice', path: 'tools/voice/' }],
  });
  assert.deepEqual(o.uncovered, [
    { repo: 'app', system: 'importer', path: 'tools/importer' },
    { repo: 'backend', system: 'site', path: 'site/legacy' },
  ]);

  // the change folders, across both repositories
  assert.deepEqual(o.changes.map((c) => [c.id, c.title]), [
    ['no-proposal', 'no-proposal'],
    ['notes-sync', 'Offline edits reach everyone'],
  ], 'the checkout\'s other branch is not read');
  const [bare, ch] = o.changes;
  assert.deepEqual(bare.sides, [{ repo: 'backend', path: 'changes/no-proposal', capabilities: [], removes: [], review: null, files: ['changes/no-proposal/tasks.md'], landed: null }]);
  const [appSide, backSide] = ch.sides;
  assert.deepEqual(appSide.capabilities, ['library/offline-edits', 'collaboration/quick-menu']);
  assert.deepEqual(appSide.removes, ['library/old-sync']);
  assert.deepEqual(backSide.removes, []);
  assert.equal(appSide.review, 'At a desk, with a second browser window.\n\nThen on a phone, offline.\n\n## not a heading');
  assert.equal(backSide.review, 'At a desk, with a second browser window.');
  assert.deepEqual(appSide.files, ['changes/notes-sync/design.md', 'changes/notes-sync/look.md', 'changes/notes-sync/proposal.md']);
  assert.deepEqual([appSide.landed.commit, appSide.landed.pr], [f.landed, 12], 'the commit that added proposal.md, not a later one');
  assert.equal(Date.parse(appSide.landed.date), Date.parse('2026-10-05T09:00:00Z'));
  assert.equal(backSide.landed.pr, 3);
  assert.deepEqual(offline.pendingChanges, ['notes-sync']);
  assert.deepEqual(cap('collaboration/quick-menu').pendingChanges, ['notes-sync']);

  // components: folders with a README.md, a non-test asmdef or a package.json, minus specs/,
  // changes/, .agents/, .github/, node_modules, the repo's ignore and the default excludes (the
  // old excludeModules and moduleMarkers keys are not read); each with its system
  assert.deepEqual(
    o.components.map((m) => [m.repo, m.path, m.system, m.readme, m.assembly, m.package, m.title, m.summary, m.capabilities]),
    [
      ['app', '.', null, 'README.md', null, null, 'Notes app', 'Shared notes for small teams.', []],
      ['app', 'src', 'editor', 'src/README.md', null, null, 'Source', 'The app code, one folder per component.', ['collaboration/shared-cursors', 'layout/pages', 'layout/sections', 'library/offline-edits']],
      ['app', 'src/collab', 'editor', null, 'Notes.Collaboration', null, 'Notes.Collaboration', '', []],
      ['app', 'src/collab/Editor', 'editor', null, 'Notes.Collaboration.Editor', null, 'Notes.Collaboration.Editor', '', ['collaboration/quick-menu']],
      ['app', 'src/quick', 'editor', 'src/quick/README.md', 'Notes.Quick', null, 'Quick menu', 'The menu that opens at the cursor.', ['collaboration/quick-menu']],
      ['app', 'src/sync', 'sync-engine', 'src/sync/README.md', null, null, 'Sync', 'Keeps edits made offline.', ['library/offline-edits']],
      ['app', 'tools/importer', 'importer', null, null, '@notes/importer', '@notes/importer', 'Imports text files.', []],
      ['app', 'tools/voice', null, null, null, '@notes/voice', '@notes/voice', 'The reader speaks, in natural voices.', ['reading/voice']],
      ['backend', '.', null, 'README.md', null, null, 'Notes backend', 'The API and the site.', []],
      ['backend', 'packages/viewer', null, null, null, '@notes/viewer', '@notes/viewer', 'The note viewer.', []],
      ['backend', 'server/sync', 'sync-engine', 'server/sync/README.md', null, null, 'Relay', 'Passes edits on.', ['library/offline-edits']],
      ['backend', 'site', 'site', 'site/README.md', null, 'site', 'Site', 'The web app people sign in to.', ['collaboration/shared-cursors']],
      ['backend', 'site/legacy', 'site', 'site/legacy/README.md', null, null, 'Legacy pages', 'The old sign-in pages.', []],
    ],
  );
  assert.deepEqual(cap('collaboration/quick-menu').sides[0].components, ['src/quick', 'src/collab/Editor'], 'each code path to its deepest component');

  assert.deepEqual(o.totals, {
    repos: 2,
    domains: 7,
    systems: 4,
    components: 13,
    capabilities: { total: 6, unreviewed: 3, approved: 2, changesRequested: 1 },
    scenarios: { total: 13, tested: 9, untested: 4 },
    changes: { total: 2 },
  });
});

test('overview: one side asks for changes: the feature is changes-requested', () => {
  const o = buildOverview(both(shared()));
  const cursors = o.capabilities.find((c) => c.id === 'collaboration/shared-cursors');
  assert.deepEqual(
    cursors.sides.map((s) => [s.repo, s.review]),
    [
      ['app', 'approved'],
      ['backend', 'changes-requested'],
    ],
  );
  assert.equal(cursors.review, 'changes-requested');
});

test('overview: an untested scenario is a gap, not a review item', () => {
  const o = buildOverview(both(shared()));
  const voice = o.capabilities.find((c) => c.id === 'reading/voice');
  assert.deepEqual(
    voice.requirements[0].scenarios.map((s) => [s.slug, s.tested]),
    [
      ['it-speaks', true],
      ['it-pauses-when-asked', false],
    ],
  );
  assert.equal(voice.review, 'approved', 'the review state is the spec\'s');
  assert.equal(o.totals.scenarios.untested, 4);
  const toReview = formatSummary(o).split('\nTo review')[1].split('\nChange folders')[0];
  assert.ok(!toReview.includes('reading/voice'), toReview);
});

test('overview: a feature in two systems: both list it, and it lists both', () => {
  const o = buildOverview(both(shared()));
  const offline = o.capabilities.find((c) => c.id === 'library/offline-edits');
  assert.deepEqual(offline.systems, ['editor', 'sync-engine']);
  for (const id of ['editor', 'sync-engine']) assert.ok(o.systems.find((s) => s.id === id).capabilities.includes('library/offline-edits'), id);
});

test('overview: a path belongs to the nearest system declaring it or a folder above it', () => {
  const systems = [
    { id: 'editor', paths: ['src/'] },
    { id: 'sync', paths: ['src/sync/', 'lib/sync.js'] },
    { id: 'bare', paths: ['tools'] },
  ];
  assert.equal(systemOf(systems, 'src/a.js'), 'editor');
  assert.equal(systemOf(systems, 'src/'), 'editor');
  assert.equal(systemOf(systems, 'src/sync/'), 'sync');
  assert.equal(systemOf(systems, 'src/sync/deep/x.ts'), 'sync');
  assert.equal(systemOf(systems, 'src/syncer.js'), 'editor', 'a folder name is no prefix of a sibling');
  assert.equal(systemOf(systems, 'lib/sync.js'), 'sync');
  assert.equal(systemOf(systems, 'lib/sync.json'), null);
  assert.equal(systemOf(systems, 'tools/x/'), 'bare', 'a folder declared without its /');
  assert.equal(systemOf(systems, 'README.md'), null);
  assert.equal(systemOf([], 'src/a.js'), null);
});

test('overview: a proposal\'s section as plain text', () => {
  const text = '---\ntitle: X\ncapabilities:\n  - a/b\n---\n# X\n\n## Why\n\nBecause.\n\n## Review\nOn a `phone`,\nwith [the app](https://example.invalid).\n\n\nThen at a desk.\n### A detail\nKept.\n## Out of scope\n\nNothing.\n';
  assert.equal(sectionText(text, 'Review'), 'On a phone, with the app.\n\nThen at a desk.\n\nA detail\n\nKept.');
  assert.equal(sectionText(text, 'Why'), 'Because.');
  assert.equal(sectionText(text, 'Calls for the owner'), null);
  assert.equal(sectionText('---\ntitle: X\n---\n## Review\n', 'Review'), '');
  // a fence's body is text, one paragraph, without its delimiters; an empty paragraph drops out
  const fenced = '---\ntitle: X\n---\n## Review\n\n<br>\n\n```js\n### not a heading\n\nstill code\n```\n\nafter\n';
  assert.equal(sectionText(fenced, 'Review'), '### not a heading still code\n\nafter');
  const touching = '---\ntitle: X\n---\n## Review\nBefore.\n```\n<section id="a">*Card*</section>\n```\n~~~\n```js\n~~~\nAfter.\n';
  assert.equal(sectionText(touching, 'Review'), 'Before.\n\n<section id="a">*Card*</section>\n\n```js\n\nAfter.');
});

test('overview: --assets copies every board that exists into its folder', (t) => {
  const f = shared();
  const o = buildOverview(both(f));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(copyAssets(o, dir), { copied: 1 });
  assert.deepEqual(validate(plain(o), SCHEMA), []);
  assert.equal(o.assetsDir, dir.replace(/\\/g, '/'));
  const [board] = o.capabilities.find((c) => c.id === 'collaboration/shared-cursors').looks;
  assert.equal(board.asset, 'app/specs/collaboration/shared-cursors/looks/cursors.html');
  assert.equal(fs.readFileSync(path.join(dir, ...board.asset.split('/')), 'utf8'), BOARD);
  const [missing] = o.capabilities.find((c) => c.id === 'collaboration/quick-menu').looks;
  assert.equal(missing.asset, null, 'a board missing at the ref is not copied');
  assert.ok(!fs.existsSync(path.join(dir, 'app', 'specs', 'collaboration', 'quick-menu')));
});

test('overview: --assets refuses a path that would leave its folder', (t) => {
  const f = shared();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const bad of ['../../escaped.html', 'specs/c:evil.html', 'specs\\x\\y.html', 'specs//x.html']) {
    const o = buildOverview([parseRepoArg(`app=${f.app.dir}@main`)]);
    o.capabilities.find((c) => c.id === 'collaboration/shared-cursors').looks[0].path = bad;
    assert.throws(() => copyAssets(o, path.join(dir, 'assets')), /refusing to copy/, bad);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'escaped.html')) && !fs.existsSync(path.join(path.dirname(dir), 'escaped.html')));
});

test('overview: landed is the first-parent commit that added proposal.md, renames counted as adds', (t) => {
  const r = makeRepo({ 'README.md': '# Root\n\nThe root.\n', 'specs/domains.json': DOMAINS }, { prefix: 'overview-landed-' });
  t.after(() => r.cleanup());
  // a change added on a side branch and merged with a merge commit: landed is the merge
  r.branch('feature').write({ 'changes/side/proposal.md': proposalText({ capabilities: [], removes: ['collaboration/x'] }) });
  const onBranch = r.commit('docs: side');
  git(r.dir, ['checkout', '-q', 'main']);
  r.write({ 'other.txt': '1\n' });
  r.commit('chore: other');
  git(r.dir, ['merge', '-q', '--no-ff', '-m', 'Merge the side change (#33)', 'feature']);
  const merge = r.rev('HEAD');
  let side = buildOverview([{ id: 'app', dir: r.dir, ref: 'main' }]).changes[0].sides[0];
  assert.notEqual(side.landed.commit, onBranch);
  assert.deepEqual([side.landed.commit, side.landed.pr], [merge, 33]);
  // a renamed change folder landed with the rename, whatever diff.renames or log.follow say
  git(r.dir, ['config', 'diff.renames', 'true']);
  git(r.dir, ['config', 'log.follow', 'true']);
  git(r.dir, ['mv', 'changes/side', 'changes/moved']);
  git(r.dir, ['commit', '-q', '-m', 'chore: rename (#77)']);
  side = buildOverview([{ id: 'app', dir: r.dir, ref: 'main' }]).changes[0].sides[0];
  assert.deepEqual([side.path, side.landed.commit, side.landed.pr], ['changes/moved', r.rev('HEAD'), 77]);
});

test('overview: reviewed is the first-parent commit that last set review, a merged verdict its merge', (t) => {
  const r = makeRepo({ 'README.md': '# Root\n\nThe root.\n', 'specs/domains.json': DOMAINS, 'src/cursors/x.js': '1\n', 'specs/collaboration/shared-cursors/spec.md': specText() }, { prefix: 'overview-reviewed-' });
  t.after(() => r.cleanup());
  const first = buildOverview([{ id: 'app', dir: r.dir, ref: 'main' }]).capabilities[0];
  assert.deepEqual([first.reviewed.commit, first.reviewed.pr], [r.main, null], 'the commit that added the spec set it');
  r.branch('triage').write({ 'specs/collaboration/shared-cursors/spec.md': specText({ review: 'approved' }) });
  r.commit('docs: approve');
  git(r.dir, ['checkout', '-q', 'main']);
  git(r.dir, ['merge', '-q', '--no-ff', '-m', 'Review results (#41)', 'triage']);
  const cap = buildOverview([{ id: 'app', dir: r.dir, ref: 'main' }]).capabilities[0];
  assert.deepEqual([cap.review, cap.reviewed.commit, cap.reviewed.pr], ['approved', r.rev('HEAD'), 41]);
});

test('overview: --summary prints the features by domain, those to review, the change folders and the systems', (t) => {
  const f = shared();
  const text = formatSummary(buildOverview(both(f)));
  assert.match(text, /^Overview of app \(example-org\/notes main [0-9a-f]{9}\), backend/);
  assert.match(text, /\n6 features \(3 unreviewed, 2 approved, 1 changes requested\) · 13 scenarios \(9 tested, 4 untested\) · 2 change folders · 4 systems · 13 components\n/);
  assert.match(text, /\nCollaboration \(collaboration\)\n {2}feature\s+review\s+tested {2}systems\s+repos\n/);
  assert.match(text, /\n {2}collaboration\/quick-menu\s+unreviewed\s+1\/2 {2}editor\s+app\n/);
  assert.match(text, /\n {2}collaboration\/shared-cursors\s+changes-requested\s+3\/4 {2}editor, site\s+app, backend\n/);
  assert.match(text, /\n {2}library\/offline-edits\s+unreviewed\s+2\/3 {2}editor, sync-engine\s+app, backend\n/);
  assert.match(text, /\n {2}reading\/voice\s+approved\s+1\/2\s{2}-\s+app\n/);
  assert.match(text, /\nSearch \(search\)\n {2}\(no features\)\n/);
  assert.match(
    text,
    /\nTo review \(4\)\n {2}collaboration\/quick-menu\s+unreviewed\s+notes-sync\n {2}collaboration\/shared-cursors\s+changes-requested\s+\(no change folder\)\n {2}library\/offline-edits\s+unreviewed\s+notes-sync\n {2}layout\/sections\s+unreviewed\s+\(no change folder\)\n/,
  );
  assert.match(text, /\nChange folders \(2\)\n {2}no-proposal\s+backend\s+no-proposal\n {2}notes-sync\s+app #12, backend #3\s+Offline edits reach everyone\n/);
  assert.match(text, /\nSystems \(4\)\n {2}editor\s+5 features\s+app\s+Editor\n {2}sync-engine\s+1 feature\s+app, backend\s+Sync engine\n {2}importer\s+0 features\s+app\s+Importer {2}\(no feature ships in it\)\n/);
  assert.match(text, /\n {2}No feature ships in: importer\n {2}Outside every system: 2 components, 1 code paths\n$/);
});

test('overview: the command line writes the JSON, the summary and the assets; usage and setup errors exit 2', (t) => {
  const f = shared();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  const out = path.join(dir, 'overview.json');
  let r = run('--repo', `app=${f.app.dir}`, '--repo', `backend=${f.backend.dir}`, '--ref', 'main', '--out', out, '--summary', '--assets', path.join(dir, 'assets'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^Overview of app/);
  const o = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(validate(o, SCHEMA), []);
  assert.equal(o.repos[0].ref, 'main');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'app', 'specs', 'collaboration', 'shared-cursors', 'looks', 'cursors.html')));
  r = run('--repo', `app=${f.app.dir}@main`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).repos.length, 1, 'JSON on stdout without --out or --summary');
  assert.equal(run().status, 2);
  assert.equal(run('--repo', 'App=x').status, 2);
  assert.equal(run('--repo', `app=${f.app.dir}`, '--repo', `app=${f.backend.dir}`, '--ref', 'main').status, 2);
  r = run('--repo', `app=${f.app.dir}@no-such-ref`);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no-such-ref does not resolve/);
  assert.equal(run('--repo', `app=${dir}`).status, 2, 'not a git repository');
});

test('overview: a repository with no specs and no systems still lists its components, none outside', (t) => {
  const r = makeRepo({ 'README.md': '# Root\n\nThe root.\n', 'a/README.md': '## A\n\n- a list\n\nThe a component.\n', 'a/x.js': '1\n' }, { prefix: 'overview-empty-' });
  t.after(() => r.cleanup());
  const o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(validate(plain(o), SCHEMA), []);
  assert.deepEqual([o.capabilities, o.changes, o.domains, o.systems, o.uncovered], [[], [], [], [], []]);
  assert.deepEqual(o.outside, { components: [], code: [] }, 'a repository that declares no system has nothing outside one');
  assert.deepEqual(
    o.components.map((m) => [m.path, m.system, m.title, m.summary]),
    [
      ['.', null, 'Root', 'The root.'],
      ['a', null, 'A', 'The a component.'],
    ],
  );
  assert.equal(formatSummary(o).includes('\nSystems (0)\n  (none declared)\n'), true);
});

test('overview: Python and Gradle folders are components; a config\'s own markers replace the defaults', (t) => {
  const r = makeRepo(
    {
      'README.md': '# Root\n\nThe root.\n',
      'py/pyproject.toml': '[build-system]\nname = "not-this"\n\n[project]\nname = "notes-sync"\ndescription = "Keeps **notes** in step." # inline\n\n[[project.authors]]\nname = "Someone"\n',
      'poetry/pyproject.toml': "[tool.poetry]\nname = 'old-style'\ndescription = 'Poetry metadata.'\n",
      'android/app/build.gradle.kts': 'plugins { }\n',
      'android/lib/build.gradle': 'apply plugin: "java"\n',
      'android/lib/README.md': '# Lib\n\nThe shared library.\n',
      'web/package.json': JSON.stringify({ name: 'web', description: 'The web app.' }),
      'web/pyproject.toml': '[project]\nname = "web-py"\n',
      'go/go.mod': 'module example\n',
    },
    { prefix: 'overview-markers-' },
  );
  t.after(() => r.cleanup());
  const rows = (o) => o.components.map((m) => [m.path, m.package, m.manifest, m.title, m.summary]);
  let o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(validate(plain(o), SCHEMA), []);
  assert.deepEqual(rows(o), [
    ['.', null, null, 'Root', 'The root.'],
    ['android/app', null, 'android/app/build.gradle.kts', 'app', ''],
    ['android/lib', null, 'android/lib/build.gradle', 'Lib', 'The shared library.'],
    ['poetry', 'old-style', 'poetry/pyproject.toml', 'old-style', 'Poetry metadata.'],
    ['py', 'notes-sync', 'py/pyproject.toml', 'notes-sync', 'Keeps notes in step.'],
    ['web', 'web', 'web/package.json', 'web', 'The web app.'],
  ]);
  r.write({ 'tools/gate/config.json': JSON.stringify({ overview: { componentMarkers: ['go.mod', 'pyproject.toml'], excludeComponents: ['poetry/**'] } }) });
  r.commit('chore: markers');
  o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(rows(o), [
    ['go', null, 'go/go.mod', 'go', ''],
    ['py', 'notes-sync', 'py/pyproject.toml', 'notes-sync', 'Keeps notes in step.'],
    ['web', 'web-py', 'web/pyproject.toml', 'web-py', ''],
  ]);
});

test('overview: test assemblies are not components', () => {
  for (const [name, folder] of [
    ['Notes.Collaboration.Tests', 'Assets/Scripts/Collaboration/Tests'],
    ['Notes.Ui.PlayTests', 'Assets/Scripts/UI/Play'],
    ['X.EditModeTests', 'a'],
    ['X.PlayModeTests', 'a'],
    ['X', 'Assets/Scripts/X/PlayModeTests'],
    ['Notes.Tests.Shared', 'Assets/Scripts/Shared'],
  ]) {
    assert.ok(isTestAssembly(name, folder), `${name} in ${folder}`);
  }
  for (const [name, folder] of [
    ['Notes.Collaboration', 'Assets/Scripts/Collaboration'],
    ['Notes.EditorTools', 'Assets/Scripts/EditorTools'],
    ['Notes.Testing', 'Assets/Scripts/Testing'],
  ]) {
    assert.ok(!isTestAssembly(name, folder), `${name} in ${folder}`);
  }
});

test('overview: --repo parsing', () => {
  assert.deepEqual(parseRepoArg('app=C:/src/app@origin/main'), { id: 'app', dir: 'C:/src/app', ref: 'origin/main' });
  assert.deepEqual(parseRepoArg('app=C:/src/app', 'main'), { id: 'app', dir: 'C:/src/app', ref: 'main' });
  assert.throws(() => parseRepoArg('D:/x'), /<id>=<git dir>/);
  assert.throws(() => parseRepoArg('App=D:/x'), /lowercase/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo@overview-'));
  try {
    assert.deepEqual(parseRepoArg(`x=${dir}`), { id: 'x', dir, ref: 'origin/main' }, 'an existing folder with @ in its name is a folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
