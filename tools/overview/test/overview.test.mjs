// The overview end to end on two throwaway repositories: a capability in both, a pending change
// with a look, directions and evidence, every PROOF state and derived state, an LFS image with
// and without its object, the --assets copy, the --summary text and the schema's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildOverview, copyAssets, formatSummary, parseRepoArg, isTestAssembly, OVERVIEW_DIR } from '../overview.mjs';
import { makeRepo, git, specText, proposalText, DOMAINS } from '../../gate/test/helpers.mjs';
import { BOM } from '../../gate/lib/git.mjs';

const SCHEMA = JSON.parse(fs.readFileSync(path.join(OVERVIEW_DIR, 'overview.schema.json'), 'utf8'));
const CLI = path.join(OVERVIEW_DIR, 'overview.mjs');
const HAS_LFS = spawnSync('git', ['lfs', 'version'], { windowsHide: true }).status === 0;

/** A minimal JSON Schema check: type, const, enum, required, properties, additionalProperties: false, items, $ref, pattern, maxLength, minimum. */
function validate(value, schema, at = '$', root = schema) {
  const errs = [];
  if (schema.$ref) return validate(value, schema.$ref.replace('#/$defs/', '').split('/').reduce((s, k) => s[k], root.$defs), at, root);
  const types = schema.type ? [].concat(schema.type) : null;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types && !types.some((t) => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) return [`${at}: ${typeOf(value)} is not ${types.join('|')}`];
  if ('const' in schema && value !== schema.const) errs.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: "${value}" does not match ${schema.pattern}`);
  if (typeof value === 'string' && schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}: lacks "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(v, schema.properties[k], `${at}.${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`, root)));
  return errs;
}

/**
 * Stores `bytes` in the repo's local LFS store; returns the pointer text git commits instead.
 * `corrupt` stores other bytes of the same length under the oid (git lfs smudge hands them out
 * unchecked).
 */
function lfsObject(dir, bytes, { store = true, corrupt = false } = {}) {
  const oid = crypto.createHash('sha256').update(bytes).digest('hex');
  if (store) {
    const d = path.join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, oid), corrupt ? Buffer.alloc(bytes.length, 0x58) : bytes);
  }
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
}

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const sc = (name, steps, proofs) => ({ name, steps, proofs });
const PASS = (c) => `${c}: pass 2026-10-30, build 1.4.2, by owner`;

function fixtures(t) {
  const app = makeRepo(
    {
      'README.md': '# Sample App\n\nShared notes for **small teams**.\n',
      'specs/README.md': '# Specs\n',
      'specs/domains.json': DOMAINS,
      'tools/gate/config.json': JSON.stringify({ ignore: ['vendor/**'], overview: { excludeModules: ['docs/**', 'dev/**', 'fixtures/**', '**/test/fixtures/**'] } }),
      'vendor/lib/README.md': '# Vendor lib\n',
      'vendor/lib/Vendor.asmdef': '{ "name": "Vendor" }\n',
      '.github/README.md': '# GitHub\n',
      'docs/README.md': '# Docs\n\nPlanning documents.\n',
      'dev/mock/README.md': '# A mockup\n',
      'fixtures/x/package.json': '{ "name": "fixture" }\n',
      'src/README.md': '# Source\n\nThe app code, one folder per module.\n',
      'src/arrows/arrows.js': '1\n',
      'src/arrows/arrows.test.js': '1\n',
      'src/halls.js': '1\n',
      'src/palm/README.md': '# Palm menu\n\nThe menu worn on the palm.\n',
      'src/palm/Palm.asmdef': `${BOM}{ "name": "App.Palm" }\n`,
      'src/palm/menu.js': '1\n',
      'src/palm/menu.test.js': '1\n',
      'src/palm/Tests/App.Palm.Tests.asmdef': '{ "name": "App.Palm.Tests" }\n',
      'src/colo/App.Colocation.asmdef': '{ "name": "App.Colocation", "references": [] }\n',
      'src/colo/Colo.cs': '1\n',
      'src/colo/PlayTests/Play.asmdef': '{ "name": "App.Colocation.PlayModeTests" }\n',
      'src/colo/Checks/Odd.asmdef': '{ "name": "App.Colocation.Tests.Odd" }\n',
      'src/colo/Editor/App.Colocation.Editor.asmdef': '{ "name": "App.Colocation.Editor" }\n',
      'src/colo/Editor/Tool.cs': '1\n',
      'tools/voice/package.json': JSON.stringify({ name: '@app/voice', description: 'The **assistant** speaks, in `neural` voices.' }),
      'tools/voice/voice.py': '1\n',
      'tools/voice/node_modules/dep/package.json': '{ "name": "dep" }\n',
      'tools/voice/test/fixtures/pkg/package.json': '{ "name": "pkg" }\n',
    },
    { prefix: 'overview-app-' },
  );
  const backend = makeRepo(
    {
      'README.md': '# Sample backend\n\nThe API and the portal.\n',
      'specs/domains.json': DOMAINS,
      'portal/README.md': '# Portal\n\nThe web app people sign in to.\n',
      'portal/package.json': JSON.stringify({ name: 'portal', description: 'Not the summary: the README has one.' }),
      'portal/arrows.ts': '1\n',
      'portal/arrows.test.ts': '1\n',
      'docs/design/README.md': '# A design proposal\n',
      'packages/viewer/package.json': JSON.stringify({ name: '@app/viewer', description: 'The three.js product viewer.' }),
      'packages/viewer/proof/hotspots/README.md': '# Hotspots proof\n',
    },
    { prefix: 'overview-backend-' },
  );
  t.after(() => {
    app.cleanup();
    backend.cleanup();
  });
  git(app.dir, ['config', 'remote.origin.url', 'https://github.com/example-org/app.git']);

  const look = png();
  const pick = png();
  const evidence = png();
  app.write({
    'specs/collaboration/peer-arrows/spec.md': specText({
      code: ['src/arrows/'],
      scenarios: [
        sc('A peer walks behind the user', ['GIVEN two devices', 'WHEN one walks behind', 'THEN the other sees an arrow'], ['test: src/arrows/arrows.test.js::Arrows.Behind', PASS('two-headsets')]),
        sc('A peer leaves', ['WHEN a peer leaves', 'THEN its arrow goes'], ['test: src/arrows/arrows.test.js', 'test: src/arrows/gone.test.js']),
      ],
    }),
    'specs/collaboration/peer-arrows/look/a-peer-walks-behind-the-user.png': lfsObject(app.dir, look),
    'specs/collaboration/palm-menu/spec.md': specText({
      title: 'Palm menu',
      code: ['src/palm/menu.js', 'src/colo/Editor/Tool.cs'],
      purpose: 'The menu opens on an upturned palm.',
      scenarios: [
        sc('Palm up shows the menu', ['WHEN the palm turns up', 'THEN the menu shows'], ['test: src/palm/menu.test.js', 'headset: open']),
        sc('Palm recall', ['WHEN the user looks at the palm', 'THEN the menu comes back'], ['headset: fail 2026-10-30, build 1.4.2, by owner; it lags', PASS('desk')]),
      ],
    }),
    'specs/layout/halls/spec.md': specText({
      title: 'Halls',
      code: ['src/halls.js'],
      purpose: 'A hall stands around the machines.',
      scenarios: [sc('A hall stands', ['WHEN a hall is chosen', 'THEN it stands'], [PASS('headset'), 'desk: pass 2026-10-30, build 1.4.2, by owner; crisp'])],
    }),
    'specs/assistant/wake/spec.md': specText({
      title: 'Wake word',
      code: ['tools/voice/voice.py'],
      purpose: 'Saying the name wakes the assistant.',
      scenarios: [sc('The name wakes it', ['WHEN the user says the name', 'THEN it listens'], [PASS('headset')])],
    }),
    'specs/assistant/voice/spec.md': specText({
      title: 'Voice',
      code: ['tools/voice/'],
      purpose: 'The assistant speaks.',
      scenarios: [sc('It speaks', ['WHEN it answers', 'THEN it speaks'], ['test: tools/voice/voice.py', 'headset: maybe'])],
    }),
    'specs/assistant/transcript/spec.md': specText({
      title: 'Transcript',
      code: ['tools/voice/voice.py'],
      purpose: 'What was said is written down.',
      scenarios: [sc('It writes what it heard', ['WHEN the user speaks', 'THEN the words are written'], ['test: tools/voice/voice.py'])],
    }),
    // every scenario approved, but the spec breaks the format (an unknown key): never approved
    'specs/layout/walls/spec.md': specText({
      title: 'Walls',
      code: ['src/halls.js'],
      purpose: 'Walls stand where they are drawn.',
      scenarios: [sc('A wall stands', ['WHEN a wall is drawn', 'THEN it stands'], [PASS('headset')])],
    }).replace('title: Walls\n', 'title: Walls\nowner: me\n'),
  });
  app.commit('feat: specs (#10)');
  app.write({
    'changes/palm-cone/proposal.md': proposalText({
      title: 'A smaller palm cone',
      capabilities: ['collaboration/palm-menu', 'assistant/wake'],
      removes: ['collaboration/palm-cone-old'],
      followUps: ['palm-cone-angle'],
    }),
    'changes/palm-cone/evidence/frame-2.png': lfsObject(app.dir, png(), { corrupt: true }),
    'changes/palm-cone/look.md': '# Look\n',
    'changes/palm-cone/look/pick.png': lfsObject(app.dir, pick),
    'changes/palm-cone/look/directions/a.png': lfsObject(app.dir, png(), { store: false }),
    'changes/palm-cone/look/directions/b.html': '<p>b</p>\n',
    'changes/palm-cone/evidence/frame-1.png': evidence,
  });
  const landed = app.commit('feat: palm cone (#12)');
  app.write({ 'changes/palm-cone/design.md': '# Design\n' });
  app.commit('docs: palm cone design');

  backend.write({
    'specs/collaboration/peer-arrows/spec.md': specText({
      title: 'Peer arrows on the portal',
      code: ['portal/arrows.ts'],
      purpose: 'The portal lists peers.',
      scenarios: [sc('The portal lists peers', ['WHEN a session runs', 'THEN the portal lists its peers'], ['test: portal/arrows.test.ts', 'desk: open'])],
    }),
    'changes/palm-cone/proposal.md': proposalText({ title: 'Palm cone, backend side', capabilities: ['collaboration/peer-arrows'], review: 'changes-requested', followUps: ['palm-cone-angle', 'portal-peers'] }),
  });
  backend.commit('feat: backend side');

  // The checkouts move on; the overview reads main.
  app.branch('elsewhere').write({ 'specs/collaboration/peer-arrows/spec.md': 'garbage\n', 'changes/other/proposal.md': proposalText() });
  app.commit('wip: elsewhere');
  app.write({ 'src/README.md': '# Dirty\n' });
  return { app, backend, look, pick, evidence, landed };
}

test('overview: two repositories merge into one index whose shape the schema describes', (t) => {
  const f = fixtures(t);
  const o = buildOverview([parseRepoArg(`app=${f.app.dir}@main`), parseRepoArg(`backend=${f.backend.dir}@main`)], { now: new Date('2026-10-29T12:00:00Z') });
  assert.deepEqual(validate(JSON.parse(JSON.stringify(o)), SCHEMA), []);
  for (const k of SCHEMA.required) assert.ok(k in o, k);
  assert.equal(o.version, 2);
  assert.equal(o.generatedAt, '2026-10-29T12:00:00.000Z');

  assert.deepEqual(
    o.repos.map((r) => [r.id, r.ref, r.commit]),
    [
      ['app', 'main', f.app.rev('main')],
      ['backend', 'main', f.backend.rev('main')],
    ],
  );
  assert.equal(o.repos[0].name, 'example-org/app');
  assert.equal(o.repos[1].name, path.basename(f.backend.dir));
  assert.equal(o.domains.length, 7);

  // capabilities in domain order, then id; every derived state
  assert.deepEqual(
    o.capabilities.map((c) => [c.id, c.state]),
    [
      ['collaboration/palm-menu', 'failing'],
      ['collaboration/peer-arrows', 'unreviewed'],
      ['layout/halls', 'approved'],
      ['layout/walls', 'unreviewed'],
      ['assistant/transcript', 'automated'],
      ['assistant/voice', 'unreviewed'],
      ['assistant/wake', 'unreviewed'],
    ],
  );
  const cap = (id) => o.capabilities.find((c) => c.id === id);
  const arrows = cap('collaboration/peer-arrows');
  assert.equal(arrows.title, 'Peer arrows', 'the first repository given names it');
  assert.equal(arrows.purpose, 'An arrow shows where each peer stands when they are out of view.');
  assert.deepEqual(
    arrows.sides.map((s) => [s.repo, s.spec, s.code, s.modules, s.problems]),
    [
      ['app', 'specs/collaboration/peer-arrows/spec.md', ['src/arrows/'], ['src'], []],
      ['backend', 'specs/collaboration/peer-arrows/spec.md', ['portal/arrows.ts'], ['portal'], []],
    ],
  );
  assert.deepEqual(arrows.requirements.map((r) => r.repo), ['app', 'backend']);
  assert.deepEqual(arrows.pendingChanges, ['palm-cone']);
  const scenarios = arrows.requirements.flatMap((r) => r.scenarios);
  assert.deepEqual(
    scenarios.map((s) => [s.slug, s.human, s.tested]),
    [
      ['a-peer-walks-behind-the-user', 'approved', true],
      ['a-peer-leaves', 'automated', true],
      ['the-portal-lists-peers', 'open', true],
    ],
  );
  assert.equal(scenarios[0].text, 'GIVEN two devices\nWHEN one walks behind\nTHEN the other sees an arrow');
  assert.deepEqual(scenarios[0].look, { repo: 'app', path: 'specs/collaboration/peer-arrows/look/a-peer-walks-behind-the-user.png', asset: null });
  assert.equal(scenarios[1].look, null);
  assert.deepEqual(scenarios[0].proofs, [
    { check: 'test', state: 'test', path: 'src/arrows/arrows.test.js', selector: 'Arrows.Behind', exists: true },
    { check: 'two-headsets', state: 'pass', date: '2026-10-30', build: '1.4.2', by: 'owner' },
  ]);
  assert.equal(scenarios[1].proofs[1].exists, false, 'a test path missing at the ref');

  const palm = cap('collaboration/palm-menu').requirements[0].scenarios;
  assert.deepEqual(
    palm.map((s) => s.human),
    ['open', 'failing'],
  );
  assert.deepEqual(palm[1].proofs[0], { check: 'headset', state: 'fail', date: '2026-10-30', build: '1.4.2', by: 'owner', note: 'it lags' });
  assert.equal(palm[1].tested, false);
  assert.equal(cap('layout/halls').requirements[0].scenarios[0].proofs[1].note, 'crisp');
  // a malformed human line counts as open; a spec that breaks the format is never approved
  const voice = cap('assistant/voice');
  assert.deepEqual(voice.requirements[0].scenarios[0].proofs[1], { check: 'headset', state: 'invalid', error: voice.requirements[0].scenarios[0].proofs[1].error });
  assert.equal(voice.requirements[0].scenarios[0].human, 'open');
  assert.match(voice.sides[0].problems.join('\n'), /takes "open"/);
  const walls = cap('layout/walls');
  assert.deepEqual([walls.requirements[0].scenarios[0].human, walls.pendingChanges, walls.state], ['approved', [], 'unreviewed']);
  assert.match(walls.sides[0].problems.join('\n'), /unknown front matter key "owner"/);

  // the change, across both repositories
  assert.equal(o.changes.length, 1, 'the checkout\'s other branch is not read');
  const [ch] = o.changes;
  assert.equal(ch.id, 'palm-cone');
  assert.equal(ch.title, 'A smaller palm cone');
  assert.equal(ch.review, 'changes-requested', 'any side asking for changes');
  assert.deepEqual(ch.followUps, ['palm-cone-angle', 'portal-peers']);
  const [appSide, backSide] = ch.sides;
  assert.deepEqual(appSide.capabilities, ['collaboration/palm-menu', 'assistant/wake']);
  assert.deepEqual(appSide.removes, ['collaboration/palm-cone-old']);
  assert.deepEqual(backSide.removes, []);
  assert.equal(appSide.review, 'unreviewed');
  assert.deepEqual(appSide.files, [
    'changes/palm-cone/design.md',
    'changes/palm-cone/evidence/frame-1.png',
    'changes/palm-cone/evidence/frame-2.png',
    'changes/palm-cone/look.md',
    'changes/palm-cone/look/directions/a.png',
    'changes/palm-cone/look/directions/b.html',
    'changes/palm-cone/look/pick.png',
    'changes/palm-cone/proposal.md',
  ]);
  assert.deepEqual(appSide.looks, [{ path: 'changes/palm-cone/look/pick.png', asset: null }]);
  assert.deepEqual(appSide.directions.map((d) => d.path), ['changes/palm-cone/look/directions/a.png', 'changes/palm-cone/look/directions/b.html']);
  assert.deepEqual(appSide.evidence, [
    { path: 'changes/palm-cone/evidence/frame-1.png', asset: null },
    { path: 'changes/palm-cone/evidence/frame-2.png', asset: null },
  ]);
  assert.equal(appSide.landed.commit, f.landed, 'the commit that added proposal.md, not a later one');
  assert.equal(appSide.landed.pr, 12);
  assert.ok(!Number.isNaN(Date.parse(appSide.landed.date)));
  assert.equal(backSide.review, 'changes-requested');
  assert.equal(backSide.landed.pr, null);

  // modules: folders with a README.md, a non-test asmdef or a package.json; minus specs/, changes/,
  // .agents/, .github/, node_modules, the repo's ignore and excludeModules globs (defaults when it has none)
  assert.deepEqual(
    o.modules.map((m) => [m.repo, m.path, m.readme, m.assembly, m.package, m.title, m.summary, m.capabilities]),
    [
      ['app', '.', 'README.md', null, null, 'Sample App', 'Shared notes for small teams.', []],
      ['app', 'src', 'src/README.md', null, null, 'Source', 'The app code, one folder per module.', ['collaboration/peer-arrows', 'layout/halls', 'layout/walls']],
      ['app', 'src/colo', null, 'App.Colocation', null, 'App.Colocation', '', []],
      ['app', 'src/colo/Editor', null, 'App.Colocation.Editor', null, 'App.Colocation.Editor', '', ['collaboration/palm-menu']],
      ['app', 'src/palm', 'src/palm/README.md', 'App.Palm', null, 'Palm menu', 'The menu worn on the palm.', ['collaboration/palm-menu']],
      ['app', 'tools/voice', null, null, '@app/voice', '@app/voice', 'The assistant speaks, in neural voices.', ['assistant/transcript', 'assistant/voice', 'assistant/wake']],
      ['backend', '.', 'README.md', null, null, 'Sample backend', 'The API and the portal.', []],
      ['backend', 'packages/viewer', null, null, '@app/viewer', '@app/viewer', 'The three.js product viewer.', []],
      ['backend', 'portal', 'portal/README.md', null, 'portal', 'Portal', 'The web app people sign in to.', ['collaboration/peer-arrows']],
    ],
  );
  assert.deepEqual(cap('collaboration/palm-menu').sides[0].modules, ['src/palm', 'src/colo/Editor'], 'each code path to its deepest module');
  assert.deepEqual(cap('assistant/voice').sides[0].modules, ['tools/voice'], 'a folder path starts at that folder');

  assert.deepEqual(o.totals, {
    repos: 2,
    domains: 7,
    modules: 9,
    capabilities: { total: 7, failing: 1, unreviewed: 4, approved: 1, automated: 1 },
    scenarios: { total: 10, failing: 1, open: 3, approved: 4, automated: 2, tested: 6 },
    changes: { total: 1, unreviewed: 0, changesRequested: 1 },
  });
});

test('overview: --assets copies every referenced image, smudging LFS pointers; an object it cannot get is missing', { skip: HAS_LFS ? false : 'git lfs is not installed' }, (t) => {
  const f = fixtures(t);
  const o = buildOverview([parseRepoArg(`app=${f.app.dir}@main`), parseRepoArg(`backend=${f.backend.dir}@main`)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const n = copyAssets(o, dir);
  assert.deepEqual(n, { copied: 4, missing: 2 });
  assert.deepEqual(validate(JSON.parse(JSON.stringify(o)), SCHEMA), []);
  assert.equal(o.assetsDir, dir.replace(/\\/g, '/'));
  const look = o.capabilities.find((c) => c.id === 'collaboration/peer-arrows').requirements[0].scenarios[0].look;
  assert.equal(look.asset, 'app/specs/collaboration/peer-arrows/look/a-peer-walks-behind-the-user.png');
  assert.ok(fs.readFileSync(path.join(dir, ...look.asset.split('/'))).equals(f.look), 'the LFS object, not its pointer');
  const side = o.changes[0].sides[0];
  assert.ok(fs.readFileSync(path.join(dir, ...side.looks[0].asset.split('/'))).equals(f.pick));
  assert.ok(fs.readFileSync(path.join(dir, ...side.evidence[0].asset.split('/'))).equals(f.evidence), 'a plain blob is copied as it is');
  assert.deepEqual(side.directions[0], { path: 'changes/palm-cone/look/directions/a.png', asset: null, missing: 'lfs' });
  assert.equal(side.directions[1].asset, 'app/changes/palm-cone/look/directions/b.html');
  assert.ok(!fs.existsSync(path.join(dir, 'app', 'changes', 'palm-cone', 'look', 'directions', 'a.png')));
  // bytes that do not match the pointer's sha256 are not the object
  assert.deepEqual(side.evidence[1], { path: 'changes/palm-cone/evidence/frame-2.png', asset: null, missing: 'lfs' });
  assert.ok(!fs.existsSync(path.join(dir, 'app', 'changes', 'palm-cone', 'evidence', 'frame-2.png')));
});

test('overview: --assets refuses a path that would leave its folder', (t) => {
  const f = fixtures(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const bad of ['../../escaped.png', 'changes/palm-cone/c:evil.png', 'changes\\palm-cone\\x.png', 'changes//x.png']) {
    const o = buildOverview([parseRepoArg(`app=${f.app.dir}@main`)]);
    o.changes[0].sides[0].looks[0].path = bad;
    assert.throws(() => copyAssets(o, path.join(dir, 'assets')), /refusing to copy/, bad);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'escaped.png')) && !fs.existsSync(path.join(path.dirname(dir), 'escaped.png')));
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

test('overview: --summary prints each domain\'s capabilities and the changes to review', (t) => {
  const f = fixtures(t);
  const text = formatSummary(buildOverview([parseRepoArg(`app=${f.app.dir}@main`), parseRepoArg(`backend=${f.backend.dir}@main`)]));
  assert.match(text, /^Overview of app \(example-org\/app main [0-9a-f]{9}\), backend/);
  assert.match(text, /7 capabilities \(1 failing, 4 unreviewed, 1 approved, 1 automated\) · 10 scenarios · 1 changes to review · 9 modules/);
  assert.match(text, /\nCollaboration \(collaboration\)\n\s+capability\s+state\s+approved\s+open\s+failing\s+automated\s+repos\n/);
  assert.match(text, /collaboration\/palm-menu\s+failing\s+0\s+1\s+1\s+0\s+app\n/);
  assert.match(text, /collaboration\/peer-arrows\s+unreviewed\s+1\s+1\s+0\s+1\s+app, backend\n/);
  assert.match(text, /\nLibrary \(library\)\n {2}\(no capabilities\)\n/);
  assert.match(text, /\nTo review \(1\)\n\s+palm-cone\s+changes-requested\s+app #12, backend\s+A smaller palm cone\n/);
  assert.match(text, /\nModules \(9: app 6, backend 3\)\n/);
  assert.match(text, /\n {2}app:src\/colo\/Editor\s+App\.Colocation\.Editor {2}\[collaboration\/palm-menu\]\n/);
});

test('overview: the command line writes the JSON, the summary and the assets; usage and setup errors exit 2', (t) => {
  const f = fixtures(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  const out = path.join(dir, 'overview.json');
  let r = run('--repo', `app=${f.app.dir}`, '--repo', `backend=${f.backend.dir}`, '--ref', 'main', '--out', out, '--summary', ...(HAS_LFS ? ['--assets', path.join(dir, 'assets')] : []));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Overview of app/);
  const o = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(validate(o, SCHEMA), []);
  assert.equal(o.repos[0].ref, 'main');
  if (HAS_LFS) assert.match(r.stderr, /2 image\(s\) not resolved/);
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

test('overview: a repository with no specs yet still lists its modules', (t) => {
  const r = makeRepo({ 'README.md': '# Root\n\nThe root.\n', 'a/README.md': '## A\n\n- a list\n\nThe a module.\n' }, { prefix: 'overview-empty-' });
  t.after(() => r.cleanup());
  const o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(validate(JSON.parse(JSON.stringify(o)), SCHEMA), []);
  assert.deepEqual(o.capabilities, []);
  assert.deepEqual(o.changes, []);
  assert.deepEqual(o.domains, []);
  assert.deepEqual(
    o.modules.map((m) => [m.path, m.title, m.summary]),
    [
      ['.', 'Root', 'The root.'],
      ['a', 'A', 'The a module.'],
    ],
  );
});

test('overview: Python and Gradle folders are modules; a config\'s own markers replace the defaults', (t) => {
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
  const rows = (o) => o.modules.map((m) => [m.path, m.package, m.manifest, m.title, m.summary]);
  let o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(validate(JSON.parse(JSON.stringify(o)), SCHEMA), []);
  assert.deepEqual(rows(o), [
    ['.', null, null, 'Root', 'The root.'],
    ['android/app', null, 'android/app/build.gradle.kts', 'app', ''],
    ['android/lib', null, 'android/lib/build.gradle', 'Lib', 'The shared library.'],
    ['poetry', 'old-style', 'poetry/pyproject.toml', 'old-style', 'Poetry metadata.'],
    ['py', 'notes-sync', 'py/pyproject.toml', 'notes-sync', 'Keeps notes in step.'],
    ['web', 'web', 'web/package.json', 'web', 'The web app.'],
  ]);
  r.write({ 'tools/gate/config.json': JSON.stringify({ overview: { moduleMarkers: ['go.mod', 'pyproject.toml'] } }) });
  r.commit('chore: markers');
  o = buildOverview([{ id: 'only', dir: r.dir, ref: 'main' }]);
  assert.deepEqual(rows(o), [
    ['go', null, 'go/go.mod', 'go', ''],
    ['poetry', 'old-style', 'poetry/pyproject.toml', 'old-style', 'Poetry metadata.'],
    ['py', 'notes-sync', 'py/pyproject.toml', 'notes-sync', 'Keeps notes in step.'],
    ['web', 'web-py', 'web/pyproject.toml', 'web-py', ''],
  ]);
});

test('overview: test assemblies are not modules', () => {
  for (const [name, folder] of [
    ['App.Colocation.Tests', 'Assets/Scripts/Colocation/Tests'],
    ['App.Ui.PlayTests', 'Assets/Scripts/UI/Play'],
    ['X.EditModeTests', 'a'],
    ['X.PlayModeTests', 'a'],
    ['X', 'Assets/Scripts/X/PlayModeTests'],
    ['App.Tests.Shared', 'Assets/Scripts/Shared'],
  ]) {
    assert.ok(isTestAssembly(name, folder), `${name} in ${folder}`);
  }
  for (const [name, folder] of [
    ['App.Colocation', 'Assets/Scripts/Colocation'],
    ['App.EditorTools', 'Assets/Scripts/EditorTools'],
    ['App.Testing', 'Assets/Scripts/Testing'],
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
