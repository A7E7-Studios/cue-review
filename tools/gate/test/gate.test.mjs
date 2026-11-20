// The checks end to end on small throwaway repositories, and the CLI's exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGate, Repo, formatSummary } from '../lib/index.mjs';
import { BOM } from '../lib/git.mjs';
import { readSystems } from '../lib/checks.mjs';
import { GATE_DIR, makeRepo, testConfig, templateConfig, check, fails, failText, infos, specText, proposalText, boardText, baseFiles, git, lockText } from './helpers.mjs';

const GATE = path.join(GATE_DIR, 'gate.mjs');
const SPEC = 'specs/collaboration/shared-cursors/spec.md';
const PROPOSAL = 'changes/shared-cursors/proposal.md';

function gate(r, opts = {}) {
  return runGate({ repo: new Repo(r.dir), base: 'main', head: 'HEAD', main: 'origin/main', config: testConfig(opts.config), ...opts });
}

function setup(t, files = baseFiles()) {
  const r = makeRepo(files);
  t.after(() => r.cleanup());
  return r;
}

const allPass = (rep) => rep.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${failText(rep, c.id)}`).join('\n');

test('an empty PR and a docs-only PR pass every check', (t) => {
  const r = setup(t);
  r.branch('x');
  let rep = gate(r);
  assert.equal(rep.conclusion, 'pass', allPass(rep));
  r.write({ 'README.md': '# Root\n\nThe root, said better.\n' });
  r.commit('docs: say it better');
  rep = gate(r);
  assert.equal(rep.conclusion, 'pass', allPass(rep));
  assert.equal(check(rep, 'pr').status, 'skip');
});

// --- specs -----------------------------------------------------------------------------------

test('specs: a new valid capability with its change folder passes', (t) => {
  const r = setup(t, { ...baseFiles(), [SPEC]: null });
  r.branch('add').write({ [SPEC]: specText(), [PROPOSAL]: proposalText() });
  r.commit('feat: shared cursors');
  const rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
  assert.match(check(rep, 'specs').summary, /^1 capabilities, 1 scenarios \(0 untested\), 1 feature\(s\) new or changed in this PR$/);
});

test('specs: format, path, domain and missing paths fail on the spec that has them', (t) => {
  const r = setup(t);
  r.branch('bad').write({
    [SPEC]: specText({
      code: ['src/cursors/', 'src/gone.js', 'src/cursors/cursors.js/', 'src'],
      proofs: ['test: src/missing.test.js', 'test: src/cursors/cursors.test.js/', 'test: src/cursors', 'test: src/cursors/', 'desk: open'],
    }),
    'specs/no-such-domain/thing/spec.md': specText({ title: 'Thing' }),
    'specs/collaboration/Bad_Id/spec.md': specText({ title: 'Bad' }),
    'specs/collaboration/no-spec/looks/board.html': boardText(),
    'specs/collaboration/shared-cursors/notes.txt': 'x',
    'specs/collaboration/shared-cursors/looks/sub/board.html': boardText(),
    'specs/loose.md': '# loose\n',
    [PROPOSAL]: proposalText(),
  });
  r.commit('feat: broken specs');
  const msgs = failText(gate(r), 'specs');
  assert.match(msgs, /code: no file src\/gone\.js/);
  assert.match(msgs, /code: src\/cursors\/cursors\.js\/ is a file; drop the trailing \//);
  assert.match(msgs, /code: src is a folder; end it with \//);
  assert.match(msgs, /test path no file src\/missing\.test\.js/);
  assert.match(msgs, /test path src\/cursors\/cursors\.test\.js\/ is a file; drop the trailing \//);
  assert.match(msgs, /test path src\/cursors is a folder; end it with \//);
  assert.doesNotMatch(msgs, /test path src\/cursors\/ /, 'a folder written with / is fine');
  assert.match(msgs, /"desk:": a scenario is proven by tests only/);
  assert.match(msgs, /domain "no-such-domain" is not in specs\/domains\.json/);
  assert.match(msgs, /capability "Bad_Id" is not kebab-case/);
  assert.match(msgs, /specs\/collaboration\/no-spec\/ has no spec\.md/);
  assert.match(msgs, /notes\.txt: stray file: a capability folder holds spec\.md and the boards its Looks name/);
  assert.match(msgs, /looks\/sub\/board\.html: stray file/);
  assert.match(msgs, /specs\/loose\.md: stray file: specs\/ holds README\.md, domains\.json, systems\.json/);
});

test('specs and changes: no image or video file is committed anywhere under specs/ or changes/', (t) => {
  const r = setup(t, baseFiles({ [PROPOSAL]: proposalText() }));
  const media = [
    'specs/collaboration/shared-cursors/look/a-collaborator-edits-the-same-note.png',
    'specs/collaboration/shared-cursors/looks/cursor.svg',
    'specs/collaboration/no-spec/frame.jpg',
    'specs/cover.webp',
    'changes/shared-cursors/frame-0012.png',
    'changes/shared-cursors/evidence/clip.mp4',
    'changes/still.gif',
  ];
  r.branch('x').write(Object.fromEntries(media.map((p) => [p, 'binary'])));
  r.commit('docs: pictures');
  const rep = gate(r);
  const all = [...fails(rep, 'specs'), ...fails(rep, 'changes')];
  for (const p of media) {
    assert.ok(all.some((f) => f.file === p && /an image or video file: none is committed under specs\/ or changes\/ \(a look is an HTML board beside its spec, feedback is text\)/.test(f.message)), p);
  }
  assert.doesNotMatch(failText(rep, 'specs'), /stray file/, 'a picture gets the picture message');
});

const BOARD = 'specs/collaboration/shared-cursors/looks/cursor.html';
const SYSTEMS = JSON.stringify([
  { id: 'editor', title: 'Editor', purpose: 'The app people write notes in.', paths: ['src/'] },
  { id: 'docs', title: 'Docs', purpose: 'The guide.', paths: ['README.md'] },
]);


test('specs: a board a Looks line names exists, holds the id and loads nothing from the network; page lines are not checked', (t) => {
  const r = setup(t, { ...baseFiles(), [SPEC]: null });
  const looks = ['looks/cursor.html#idle — The cursor at rest', 'looks/cursor.html#typing — The cursor while typing', 'page: /notes/<id> — Open a note with a second window'];
  r.branch('ok').write({ [SPEC]: specText({ looks }), [BOARD]: boardText(['idle', 'typing']), [PROPOSAL]: proposalText(), 'specs/systems.json': SYSTEMS });
  r.commit('feat: cursors with looks');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'budgets').status, 'pass', failText(rep, 'budgets'));
  r.branch('bad', 'main').write({
    [SPEC]: specText({ looks: [...looks, 'looks/missing.html#main — Gone'] }),
    [BOARD]: boardText(['idle'], { extra: '<link rel="stylesheet" href="https://fonts.example.invalid/x.css">\n<div style="background: url(http://example.invalid/a.png)"></div>' }),
    'specs/collaboration/shared-cursors/looks/unused.html': boardText(),
    [PROPOSAL]: proposalText(),
  });
  r.commit('feat: broken looks');
  rep = gate(r);
  const msgs = failText(rep, 'specs');
  assert.match(msgs, /spec\.md:\d+ Looks: looks\/cursor\.html holds no element with id "typing"/);
  assert.match(msgs, /spec\.md:\d+ Looks: no board specs\/collaboration\/shared-cursors\/looks\/missing\.html/);
  assert.match(msgs, /looks\/cursor\.html:\d+ loads https:\/\/fonts\.example\.invalid\/x\.css from outside the board: a board is self-contained/);
  assert.match(msgs, /looks\/cursor\.html:\d+ loads http:\/\/example\.invalid\/a\.png from outside the board/);
  assert.match(msgs, /looks\/unused\.html: board looks\/unused\.html is named by no Looks line of specs\/collaboration\/shared-cursors\/spec\.md/);
  assert.equal(fails(rep, 'specs').length, 5, msgs);
  // a board over its budget, like a spec
  r.branch('big', 'main').write({ [SPEC]: specText({ looks }), [BOARD]: boardText(['idle', 'typing'], { extra: `<p>${'x'.repeat(31000)}</p>` }), [PROPOSAL]: proposalText() });
  r.commit('feat: a big board');
  assert.match(failText(gate(r), 'budgets'), /looks\/cursor\.html: new file of \d+ bytes, over its budget of 30720/);
});

test('specs: domains.json must read; a PR writing under specs/ answers for it', (t) => {
  const r = setup(t, { ...baseFiles(), 'specs/domains.json': null });
  r.branch('x').write({ [SPEC]: specText({ summary: 'A better summary.' }), [PROPOSAL]: proposalText() });
  r.commit('feat: edit a spec');
  assert.match(failText(gate(r), 'specs'), /specs\/domains\.json is missing/);
  r.write({ 'specs/domains.json': '[{"id":"collaboration","title":"","purpose":"x"},{"id":"collaboration","title":"t","purpose":"p"}]' });
  r.commit('feat: domains');
  const msgs = failText(gate(r), 'specs');
  assert.match(msgs, /"title" is a non-empty string/);
  assert.match(msgs, /domain "collaboration" appears twice/);
  r.write({ 'specs/domains.json': '{not json' });
  r.commit('feat: domains');
  assert.match(failText(gate(r), 'specs'), /not JSON/);
});

test('specs: systems.json is optional; when present, each system has an id, a title, a purpose and paths present at the commit, no path twice', (t) => {
  const r = setup(t);
  r.branch('ok').write({ 'specs/systems.json': SYSTEMS });
  r.commit('docs: systems');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  const repo = new Repo(r.dir);
  assert.deepEqual(readSystems(repo, 'HEAD'), { present: true, systems: JSON.parse(SYSTEMS), problems: [] });
  assert.deepEqual(readSystems(repo, 'main'), { present: false, systems: [], problems: [] }, 'absent is fine');
  r.branch('bad', 'main').write({
    'specs/systems.json': JSON.stringify([
      { id: 'editor', title: 'Editor', purpose: 'The app.', paths: ['src/', 'src/cursors', 'src/gone/', '../x'] },
      { id: 'editor', title: '', purpose: 'Again.', paths: [] },
      { id: 'Sync_Service', title: 'Sync', purpose: ' ', paths: ['src/', 7] },
      'not an object',
    ]),
  });
  r.commit('docs: bad systems');
  rep = gate(r);
  const msgs = failText(rep, 'specs');
  for (const m of [
    /system "editor": paths: src\/cursors is a folder; end it with \//,
    /system "editor": paths: no folder src\/gone\//,
    /system "editor": paths: "\.\.\/x" has an empty, "\." or "\.\." segment/,
    /system "editor" appears twice/,
    /system "editor": "title" is a non-empty string/,
    /system "editor": "paths" is a non-empty list of repository paths/,
    /entry 2: id "Sync_Service" is not kebab-case/,
    /entry 2: "purpose" is a non-empty string/,
    /entry 2: paths: src\/ is declared by system "editor" too; a path belongs to one system/,
    /entry 2: paths: 7 is not a string/,
    /entry 3 is not an object/,
  ]) {
    assert.match(msgs, m);
  }
  assert.ok(fails(rep, 'specs').every((f) => f.file === 'specs/systems.json'), msgs);
  r.write({ 'specs/systems.json': '{"id": "editor"}' });
  r.commit('docs: systems as an object');
  assert.match(failText(gate(r), 'specs'), /specs\/systems\.json: a list of \{ "id", "title", "purpose", "paths" \}/);
  r.write({ 'specs/systems.json': '[' });
  r.commit('docs: systems cut short');
  assert.match(failText(gate(r), 'specs'), /specs\/systems\.json: not JSON/);
  assert.equal(readSystems(new Repo(r.dir), 'HEAD').systems, null, 'unreadable');
});

test('specs: systems.json is judged as one unit: a path this PR deletes fails it, an older problem is information', (t) => {
  const r = setup(t, baseFiles({ 'specs/systems.json': JSON.stringify([{ id: 'editor', title: 'Editor', purpose: 'The app.', paths: ['src/cursors/cursors.js', 'src/long-gone.js'] }]) }));
  r.branch('x').write({ 'README.md': '# Root\n\nOther words.\n' });
  r.commit('docs: unrelated');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.match(infos(rep, 'specs').map((f) => f.message).join('\n'), /already at the merge base: system "editor": paths: no file src\/long-gone\.js/);
  r.write({ 'src/cursors/cursors.js': null, 'src/README.md': '# Source\n\nNo cursors.\n' });
  r.commit('refactor: drop the cursors code');
  rep = gate(r);
  assert.match(failText(rep, 'specs'), /specs\/systems\.json: system "editor": paths: no file src\/cursors\/cursors\.js/);
  assert.doesNotMatch(failText(rep, 'specs'), /long-gone/);
});

test('specs: a problem already on main in an untouched spec is information; one this PR causes fails', (t) => {
  const r = setup(t, baseFiles({ [SPEC]: specText({ code: ['src/cursors/', 'src/long-gone.js'] }) }));
  r.branch('x').write({ 'README.md': '# Root\n\nOther words.\n' });
  r.commit('docs: unrelated');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.match(infos(rep, 'specs').map((f) => f.message).join('\n'), /already at the merge base: code: no file src\/long-gone\.js/);
  // deleting a test the untouched spec names fails this PR
  r.write({ 'src/cursors/cursors.test.js': null });
  r.commit('chore: delete a test');
  rep = gate(r);
  assert.match(failText(rep, 'specs'), /test path no file src\/cursors\/cursors\.test\.js/);
});

test('specs: a domains.json or spec saved with a byte-order mark reads like any other', (t) => {
  const bom = (s) => `${BOM}${s}`;
  const r = setup(t, { ...baseFiles(), 'specs/domains.json': bom(baseFiles()['specs/domains.json']) });
  r.branch('x').write({ [SPEC]: bom(specText({ summary: 'A better summary.' }).replace(/\n/g, '\r\n')), [PROPOSAL]: proposalText() });
  r.commit('feat: summary');
  const rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
});

// --- the review on the feature -----------------------------------------------------------------

const APPROVED = baseFiles({ [SPEC]: specText({ review: 'approved' }) });

test('review: a new spec is unreviewed', (t) => {
  const r = setup(t, { ...baseFiles(), [SPEC]: null });
  for (const review of ['approved', 'changes-requested']) {
    r.branch(review, 'main').write({ [SPEC]: specText({ review }), [PROPOSAL]: proposalText() });
    r.commit('feat: shared cursors');
    const msgs = failText(gate(r), 'specs');
    assert.match(msgs, new RegExp(`spec\\.md:1 collaboration/shared-cursors: review is "${review}", but it is new; this PR carries change folder shared-cursors, which names it: a new or changed feature goes back to review: unreviewed`), review);
  }
});

test('review: a PR that changes a spec\'s text or its boards sets it back to unreviewed', (t) => {
  const r = setup(t, APPROVED);
  r.branch('text').write({ [SPEC]: specText({ review: 'approved', then: 'it glows' }), 'changes/glow/proposal.md': proposalText({ title: 'Glow' }) });
  r.commit('feat: glow');
  assert.match(failText(gate(r), 'specs'), /collaboration\/shared-cursors: review is "approved", but its spec text changed; this PR carries change folder glow, which names it: a new or changed feature goes back to review: unreviewed/);
  r.write({ [SPEC]: specText({ then: 'it glows' }) });
  r.commit('feat: glow, unreviewed');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(infos(rep, 'specs').filter((f) => f.notice).length, 0, 'a reset that the PR must make is no notice');
  // a board only: spec.md untouched, the feature still changed
  const withBoard = baseFiles({ [SPEC]: specText({ review: 'approved', looks: ['looks/cursor.html#idle — At rest'] }), [BOARD]: boardText(['idle']) });
  const b = setup(t, withBoard);
  b.branch('board').write({ [BOARD]: boardText(['idle'], { extra: '<p>Brighter.</p>' }), 'changes/brighter/proposal.md': proposalText({ title: 'Brighter' }) });
  b.commit('feat: a brighter cursor');
  assert.match(failText(gate(b), 'specs'), /collaboration\/shared-cursors: review is "approved", but its boards changed; this PR carries change folder brighter/);
  // a change folder alone names it: the feature goes back to unreviewed (ship's code-only fix)
  r.branch('fix', 'main').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n', 'src/README.md': '# Source\n\nFixed.\n', 'changes/fix-cursor/proposal.md': proposalText({ title: 'Fix the cursor' }) });
  r.commit('fix: the cursor');
  assert.match(failText(gate(r), 'specs'), /^specs\/collaboration\/shared-cursors\/spec\.md:1 collaboration\/shared-cursors: review is "approved", but this PR carries change folder fix-cursor, which names it: a new or changed feature goes back to review: unreviewed$/);
  r.write({ [SPEC]: specText() });
  r.commit('fix: the cursor, unreviewed');
  rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(infos(rep, 'specs').filter((f) => f.notice).length, 0);
});

test('review: a triage PR sets review alone, shown as a notice; PROOF, code and re-wrapping change no review', (t) => {
  const r = setup(t, baseFiles({ [SPEC]: specText(), [PROPOSAL]: proposalText() }));
  // triage: the verdict, and the change folder deleted
  r.branch('triage').write({ [SPEC]: specText({ review: 'approved' }), [PROPOSAL]: null });
  r.commit('docs: triage');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
  const notice = infos(rep, 'specs').find((f) => f.notice);
  assert.deepEqual([notice.message, notice.file], ['collaboration/shared-cursors: sets review: approved', SPEC]);
  assert.match(formatSummary(rep), /### Information\n- specs: `specs\/collaboration\/shared-cursors\/spec\.md:1` collaboration\/shared-cursors: sets review: approved\n/);
  r.branch('requested', 'main').write({ [SPEC]: specText({ review: 'changes-requested' }) });
  r.commit('docs: triage');
  assert.equal(infos(gate(r), 'specs').find((f) => f.notice).message, 'collaboration/shared-cursors: sets review: changes-requested');
  // on an approved feature, PROOF lines, code paths and a re-wrapped step change no review
  const a = setup(t, APPROVED);
  for (const [name, text] of [
    ['proof', specText({ review: 'approved', proofs: ['test: src/cursors/cursors.test.js::Cursors.others', 'test: src/cursors/'] })],
    ['code', specText({ review: 'approved', code: ['src/cursors/', 'src/README.md'] })],
    ['wrap', specText({ review: 'approved' }).replace('- **WHEN** one user types in a paragraph', '- **WHEN** one user types\n  in a paragraph')],
  ]) {
    a.branch(name, 'main').write({ [SPEC]: text });
    a.commit(`docs: ${name}`);
    rep = gate(a);
    assert.equal(check(rep, 'specs').status, 'pass', `${name}: ${failText(rep, 'specs')}`);
    assert.equal(check(rep, 'changes').status, 'pass', `${name}: ${failText(rep, 'changes')}`);
    assert.equal(infos(rep, 'specs').filter((f) => f.notice).length, 0, name);
  }
});

// --- changes ---------------------------------------------------------------------------------

test('changes: a folder without proposal.md, a bad id, bad front matter, a missing capability, a stray file, a directions page that loads from outside', (t) => {
  const r = setup(t);
  r.branch('x').write({
    'changes/no-proposal/look.md': '# Look\n',
    'changes/Bad_Id/proposal.md': proposalText(),
    'changes/bad-front/proposal.md': proposalText().replace('title: Cursors for collaborators\n', 'review: unreviewed\n'),
    'changes/gone-cap/proposal.md': proposalText({ capabilities: ['collaboration/shared-cursors', 'layout/pages'] }),
    'changes/full/proposal.md': proposalText(),
    'changes/full/look.md': '# Look\n',
    'changes/full/looks.html': '<!doctype html><style>:root { --ink: #222; }</style><section id="now"><svg viewBox="0 0 8 8"><rect width="8" height="8" fill="var(--ink)"/></svg></section>\n',
    'changes/full/design.md': '# Design\n',
    'changes/full/tasks.md': '- [ ] 1.1 x; test: y\n',
    'changes/full/notes.txt': 'x\n',
    'changes/full/evidence/notes.md': 'x\n',
    'changes/loose.md': 'x\n',
    'changes/net/proposal.md': proposalText(),
    'changes/net/looks.html': '<!doctype html>\n<link rel="stylesheet" href="https://cdn.example/x.css">\n',
  });
  r.commit('docs: changes');
  const rep = gate(r);
  const msgs = failText(rep, 'changes');
  assert.match(msgs, /changes\/no-proposal\/ has no proposal\.md/);
  assert.match(msgs, /change id "Bad_Id" is not kebab-case/);
  assert.match(msgs, /front matter lacks "title"/);
  assert.match(msgs, /unknown front matter key "review"/);
  assert.match(msgs, /capability layout\/pages has no specs\/layout\/pages\/spec\.md/);
  assert.match(msgs, /changes\/loose\.md: stray file: a change is a folder/);
  assert.match(msgs, /changes\/full\/notes\.txt: stray file: a change folder holds only proposal\.md, looks\.html, look\.md, design\.md, tasks\.md/);
  assert.match(msgs, /changes\/full\/evidence\/notes\.md: stray file: a change folder holds only/);
  assert.equal(fails(rep, 'changes').filter((f) => f.file?.startsWith('changes/full/')).length, 2, `a self-contained looks.html is no stray file:\n${msgs}`);
  assert.match(msgs, /changes\/net\/looks\.html:2 loads https:\/\/cdn\.example\/x\.css from outside the page: the directions page is self-contained/);
});

test('changes: deleting a capability a pending change names fails; the change\'s own older problems are information', (t) => {
  const r = setup(t, baseFiles({ [PROPOSAL]: proposalText(), 'changes/old/proposal.md': proposalText().replace('capabilities:', 'follow-ups:\n  - later\ncapabilities:') }));
  r.branch('x').write({ [SPEC]: null, [PROPOSAL]: null, 'changes/other/proposal.md': proposalText({ title: 'Other' }) });
  r.commit('feat: remove shared cursors');
  const rep = gate(r);
  assert.match(failText(rep, 'changes'), /changes\/other\/proposal\.md.*capability collaboration\/shared-cursors has no/);
  assert.doesNotMatch(failText(rep, 'changes'), /follow-ups/);
  assert.match(infos(rep, 'changes').map((f) => f.message).join('\n'), /already at the merge base: unknown front matter key "follow-ups"/);
  // the old change also names the deleted capability: that is new, so it fails
  assert.match(failText(rep, 'changes'), /changes\/old\/proposal\.md.*capability collaboration\/shared-cursors has no/);
});

test('changes: spec text changed without a change folder that names it fails; PROOF-only, code-only, review-only and deletion-only PRs need none', (t) => {
  const r = setup(t, baseFiles({ [PROPOSAL]: proposalText(), 'specs/layout/pages/spec.md': specText({ title: 'Pages' }) }));
  r.branch('text').write({ [SPEC]: specText({ then: 'it glows' }) });
  r.commit('feat: glow');
  assert.match(failText(gate(r), 'changes'), /changes the spec text of collaboration\/shared-cursors, which needs a change folder whose "capabilities" names collaboration\/shared-cursors; this PR adds or modifies no change folder/);
  r.write({ [PROPOSAL]: proposalText({ title: 'Cursors that glow' }) });
  r.commit('docs: the change');
  assert.equal(check(gate(r), 'changes').status, 'pass', failText(gate(r), 'changes'));
  // a written change folder that does not name the capability does not count
  r.branch('other', 'main').write({
    [SPEC]: specText({ then: 'it glows' }),
    'changes/glow/proposal.md': proposalText({ capabilities: ['collaboration/shared-cursors'] }),
    'specs/layout/pages/spec.md': specText({ title: 'Pages', then: 'x' }),
  });
  r.commit('feat: glow and pages');
  let rep = gate(r);
  assert.equal(fails(rep, 'changes').length, 1, failText(rep, 'changes'));
  assert.match(failText(rep, 'changes'), /spec text of layout\/pages, .*; the change folder\(s\) written \(glow\) do not name it/);
  // deleting the only change folder is not writing one
  r.branch('deleted-folder', 'main').write({ [SPEC]: specText({ then: 'it glows' }), [PROPOSAL]: null });
  r.commit('feat: glow, folder gone');
  assert.match(failText(gate(r), 'changes'), /spec text of collaboration\/shared-cursors, .*this PR adds or modifies no change folder/);
  for (const [name, files] of [
    ['proof-only', { [SPEC]: specText({ proofs: ['test: src/cursors/cursors.test.js', 'test: src/cursors/'] }) }],
    ['code-only', { [SPEC]: specText({ code: ['src/cursors/', 'src/README.md'] }) }],
    ['review-only', { [SPEC]: specText({ review: 'approved' }), [PROPOSAL]: null }],
    ['systems-only', { 'specs/systems.json': JSON.stringify([{ id: 'editor', title: 'Editor', purpose: 'The app.', paths: ['src/'] }]) }],
    ['deletion-only', { [PROPOSAL]: null }],
  ]) {
    r.branch(name, 'main').write(files);
    r.commit(`docs: ${name}`);
    rep = gate(r);
    assert.equal(check(rep, 'changes').status, 'pass', `${name}: ${failText(rep, 'changes')}`);
    assert.equal(check(rep, 'specs').status, 'pass', `${name}: ${failText(rep, 'specs')}`);
  }
});

test('changes: a board added, edited or deleted is a change to its spec\'s text, which needs a change folder naming it', (t) => {
  const looks = ['looks/cursor.html#idle — At rest'];
  const r = setup(t, baseFiles({ [SPEC]: specText({ looks }), [BOARD]: boardText(['idle']) }));
  for (const [name, files, what] of [
    ['edit', { [BOARD]: boardText(['idle'], { extra: '<p>Brighter.</p>' }) }, 'boards'],
    ['add', { [SPEC]: specText({ looks: [...looks, 'looks/typing.html#typing — Typing'] }), 'specs/collaboration/shared-cursors/looks/typing.html': boardText(['typing']) }, 'spec text and the boards'],
    ['delete', { [SPEC]: specText(), [BOARD]: null }, 'spec text and the boards'],
  ]) {
    r.branch(name, 'main').write(files);
    r.commit(`feat: ${name} a board`);
    let rep = gate(r);
    assert.equal(fails(rep, 'changes').length, 1, failText(rep, 'changes'));
    assert.equal(failText(rep, 'changes'), `${SPEC}: changes the ${what} of collaboration/shared-cursors, which needs a change folder whose "capabilities" names collaboration/shared-cursors; this PR adds or modifies no change folder`, name);
    r.write({ [PROPOSAL]: proposalText() });
    r.commit('docs: the change');
    rep = gate(r);
    assert.equal(check(rep, 'changes').status, 'pass', `${name}: ${failText(rep, 'changes')}`);
    assert.equal(check(rep, 'specs').status, 'pass', `${name}: ${failText(rep, 'specs')}`);
  }
});

// --- design ----------------------------------------------------------------------------------

test('design: skipped without a design block; with the starter\'s, its tokens file and brief are present at head', (t) => {
  const { design } = templateConfig();
  const r = setup(t);
  r.branch('x').write({ 'README.md': '# Root\n\nFine.\n' });
  r.commit('docs: fine');
  let rep = gate(r);
  assert.deepEqual([check(rep, 'design').status, check(rep, 'design').summary], ['skip', 'no design block in config.json']);
  rep = gate(r, { config: testConfig({ design }) });
  assert.equal(failText(rep, 'design'), [`${design.tokens}: design.tokens: no file ${design.tokens} at head`, `${design.brief}: design.brief: no file ${design.brief} at head`].join('\n'));
  r.write({ [design.tokens]: ':root { --accent: #2a6; }\n', [design.brief]: '# Brief\n\nCalm and plain.\n', 'tools/design/README.md': '# Design\n\nThe house style.\n' });
  r.commit('feat: the house style');
  rep = gate(r, { config: testConfig({ design: { ...design, catalogues: [{ name: 'icons', open: 'https://example.invalid/icons/{entry}' }] } }) });
  assert.equal(check(rep, 'design').status, 'pass', failText(rep, 'design'));
  assert.equal(check(rep, 'design').summary, `tokens ${design.tokens}, brief ${design.brief}, 1 catalogue(s)`);
  r.write({ [design.brief]: null });
  r.commit('chore: drop the brief');
  assert.match(failText(gate(r, { config: testConfig({ design }) }), 'design'), /design\.brief: no file tools\/design\/house-style\/brief\.md at head/);
});

// --- history ---------------------------------------------------------------------------------

test('history: each rule fails on an added living-doc line; code, PROOF dates, change folders and vendored docs pass', (t) => {
  const r = setup(t, baseFiles({ 'Packages/com.unity.x/README.md': '# Vendor\n', [PROPOSAL]: proposalText() }));
  r.branch('x').write({
    'README.md': [
      '# Root',
      '',
      'Fixed in #245.',
      'See other-repo#46 too.',
      'Landed on 2026-10-29.',
      'It used to crash.',
      'Kept (ruled by the owner).',
      'A follow-up PR handles it.',
      'German will be added later.',
      'A follow-up change carries the fix; follow-ups lists them.',
      'TODO: finish',
      'In code: `#245`, `2026-10-29`, `TODO`.',
      '```',
      'git log --since 2026-10-01 # TODO',
      '```',
      'Anchors are fine: [x](README.md#root).',
      'The key is used to sign the APK; written in C#10; the accent is `#333`.',
      '',
    ].join('\n'),
    'docs/a b/README.md': '# Spaced\n\nFixed in #77.\n',
    [SPEC]: specText({ proofs: ['test: src/cursors/cursors.test.js::keeps the 2026-10-30 draft'] }),
    [PROPOSAL]: `${proposalText()}\nDecided 2026-10-29 in #245; a follow-up, TODO.\n`,
    'Packages/com.unity.x/README.md': '# Vendor\n\nChanged in #12 on 2026-10-01, TODO.\n',
  });
  r.commit('docs: history');
  const rep = gate(r);
  const msgs = failText(rep, 'history');
  for (const m of [
    /PR or issue reference "#245"/,
    /cross-repo reference "other-repo#46"/,
    /ISO date outside a PROOF line "2026-10-29"/,
    /"used to"/,
    /"\(ruled"/,
    /work promised for later "follow-up PR"/,
    /work promised for later "will be added later"/,
    /TODO/,
  ]) {
    assert.match(msgs, m);
  }
  assert.equal(fails(rep, 'history').filter((f) => f.file === 'README.md').length, 8, msgs);
  assert.doesNotMatch(msgs, /follow-up change|sign the APK|C#10|#333/);
  // a path with a space: git ends its diff header with a TAB, and the added line still counts
  assert.deepEqual(
    fails(rep, 'history').filter((f) => f.file !== 'README.md').map((f) => [f.file, f.line]),
    [['docs/a b/README.md', 3]],
  );
});

// --- budgets ---------------------------------------------------------------------------------

test('budgets: a new or grown over-budget file fails; an over-budget file that did not grow is information', (t) => {
  const big = (n) => `# Big\n\n${'x'.repeat(n)}\n`;
  const r = setup(t, baseFiles({ 'docs/README.md': big(41000), 'AGENTS.md': big(40000) }));
  r.branch('x').write({
    'docs/README.md': big(40990),
    'AGENTS.md': big(40010),
    'tools/new/README.md': big(41000),
    'specs/collaboration/shared-cursors/spec.md': specText({ summary: 'y'.repeat(31000) }),
    'changes/huge/proposal.md': `${proposalText()}${'z'.repeat(31000)}\n`,
    'Packages/com.vendor.big/README.md': big(50000),
  });
  r.commit('docs: sizes');
  const rep = gate(r);
  const msgs = failText(rep, 'budgets');
  assert.match(msgs, /AGENTS\.md:.*over its budget of 32768 and grown/);
  assert.match(msgs, /tools\/new\/README\.md:.*new file of \d+ bytes, over its budget of 40960/);
  assert.match(msgs, /spec\.md:.*over its budget of 30720/);
  assert.match(msgs, /changes\/huge\/proposal\.md:.*over its budget of 30720/);
  assert.doesNotMatch(msgs, /docs\/README\.md|Packages/);
  assert.match(infos(rep, 'budgets').map((f) => `${f.file} ${f.message}`).join('\n'), /docs\/README\.md .*not grown/);
});

test('budgets: an entry with "bytes": null, matched first, leaves its files unbudgeted', (t) => {
  const big = (n) => `# Big\n\n${'x'.repeat(n)}\n`;
  const r = setup(t);
  r.branch('x').write({ 'docs/api/README.md': big(50000), 'tools/new/README.md': big(50000) });
  r.commit('docs: big');
  const budgets = [{ pattern: 'docs/**', bytes: null }, ...testConfig().budgets];
  const rep = gate(r, { config: testConfig({ budgets }) });
  const msgs = failText(rep, 'budgets');
  assert.doesNotMatch(msgs, /docs\/api/);
  assert.match(msgs, /tools\/new\/README\.md:.*new file of \d+ bytes, over its budget of 40960/);
  assert.match(check(rep, 'budgets').summary, /^1 budgeted file/);
  // the same entry after the README budget changes nothing: first match wins
  const late = gate(r, { config: testConfig({ budgets: [...testConfig().budgets, { pattern: 'docs/**', bytes: null }] }) });
  assert.match(failText(late, 'budgets'), /docs\/api\/README\.md/);
});

test('budgets: sizes are git blob sizes, so CRLF in the working tree does not count', (t) => {
  const r = setup(t);
  git(r.dir, ['config', 'core.autocrlf', 'true']);
  const text = `# T\n\n${'line\n'.repeat(8000)}`; // 40005 bytes as LF, 48005 as CRLF
  r.branch('x').write({ 'tools/crlf/README.md': text.replace(/\n/g, '\r\n') });
  r.commit('docs: crlf');
  const rep = gate(r);
  assert.equal(check(rep, 'budgets').status, 'pass', failText(rep, 'budgets'));
});

// --- links -----------------------------------------------------------------------------------

test('links: a broken relative link or anchor on an added line fails; an old broken one is information', (t) => {
  const r = setup(t, baseFiles({ 'docs/guide.md': '# Guide\n\n## Setup\n\n[old](missing-old.md)\n' }));
  r.branch('x').write({
    'docs/guide.md': [
      '# Guide',
      '',
      '## Setup',
      '',
      '[old](missing-old.md)',
      '[ok](../README.md) [ok2](#setup) [ok3](../src/) [ok4](../README.md#root) [web](https://example.com/x.md) [out](../../outside/repo.md) [abs](/README.md)',
      '[bad](nope.md) [badanchor](#nowhere) [badother](../README.md#nowhere)',
      '`[code](not-checked.md)`',
      '',
    ].join('\n'),
  });
  r.commit('docs: links');
  const rep = gate(r);
  const msgs = failText(rep, 'links');
  assert.match(msgs, /no such file or folder docs\/nope\.md/);
  assert.match(msgs, /no heading or id "nowhere" in this file/);
  assert.match(msgs, /no heading or id "nowhere" in README\.md/);
  assert.equal(fails(rep, 'links').length, 3, msgs);
  assert.doesNotMatch(msgs, /outside|abs/, 'a link leaving the repository is not judged; a leading / is the repository root');
  assert.match(infos(rep, 'links')[0].message, /1 broken link\(s\) on lines this PR did not add, already broken at the merge base/);
});

test('links: reference definitions resolve; code spanning lines and mid-paragraph brackets are not links', (t) => {
  const r = setup(t);
  r.branch('x').write({
    'docs/api.md': [
      '# API',
      '',
      'Each control is `{ [control]: {',
      '[stop]: { fact } } }` keyed by name.',
      '',
      'Use `a',
      '[x](missing.md) b` here.',
      '',
      '[readme]: ../README.md',
      '[gone]: nowhere.md',
      '',
      'See [the readme][readme].',
      '',
    ].join('\n'),
  });
  r.commit('docs: api');
  const rep = gate(r);
  const msgs = failText(rep, 'links');
  assert.equal(fails(rep, 'links').length, 1, msgs);
  assert.match(msgs, /docs\/api\.md:10 no such file or folder docs\/nowhere\.md: nowhere\.md/);
});

test('links: deleting or renaming a doc, or changing its headings, fails the links elsewhere it breaks', (t) => {
  const files = baseFiles({
    'docs/guide.md': '# Guide\n\n## Setup\n\n## Run\n',
    'docs/README.md': '# Docs\n\n[g](guide.md) [s](guide.md#setup) [r](guide.md#run)\n\n[already](gone-long-ago.md)\n',
    'docs/self.md': '# Self\n\n## Part one\n\nSee [one](#part-one).\n',
  });
  const r = setup(t, files);
  // a heading renamed: the untouched README's anchor link breaks, the doc's own link too
  r.branch('heading').write({ 'docs/guide.md': '# Guide\n\n## Install\n\n## Run\n', 'docs/self.md': '# Self\n\n## Part 1\n\nSee [one](#part-one).\n' });
  r.commit('docs: rename headings');
  let rep = gate(r);
  let msgs = failText(rep, 'links');
  assert.match(msgs, /docs\/README\.md:3 no heading or id "setup" in docs\/guide\.md: guide\.md#setup \(it resolved at the merge base; this PR changed the headings of docs\/guide\.md\)/);
  assert.match(msgs, /docs\/self\.md:5 no heading or id "part-one" in this file: #part-one \(it resolved at the merge base/);
  assert.equal(fails(rep, 'links').length, 2, msgs);
  // the doc deleted (or renamed): every link to it breaks; the link broken before is not this PR's
  r.branch('gone', 'main').write({ 'docs/guide.md': null, 'docs/howto.md': '# Guide\n\n## Setup\n\n## Run\n' });
  r.commit('docs: rename the guide');
  rep = gate(r);
  msgs = failText(rep, 'links');
  assert.equal(fails(rep, 'links').length, 3, msgs);
  assert.ok(fails(rep, 'links').every((f) => f.file === 'docs/README.md' && /no such file or folder docs\/guide\.md/.test(f.message)), msgs);
  assert.doesNotMatch(msgs, /gone-long-ago/);
});

test('links: deleting code or a whole folder fails the untouched docs that link to it', (t) => {
  const r = setup(t, baseFiles({ 'docs/README.md': '# Docs\n\nSee [cursors](../src/cursors/cursors.js) and [the folder](../src/cursors/) and [src](../src/).\n' }));
  r.branch('x').write({
    'src/cursors/cursors.js': null,
    'src/cursors/cursors.test.js': null,
    'src/README.md': '# Source\n\nNo cursors.\n',
    [SPEC]: specText({ code: ['src/README.md'], proofs: [] }),
  });
  r.commit('refactor: drop the cursors code');
  const rep = gate(r);
  const msgs = failText(rep, 'links');
  assert.match(msgs, /docs\/README\.md:3 no such file or folder src\/cursors\/cursors\.js: \.\.\/src\/cursors\/cursors\.js \(it resolved at the merge base; this PR deleted or renamed src\/cursors\/cursors\.js\)/);
  assert.match(msgs, /docs\/README\.md:3 no such file or folder src\/cursors: \.\.\/src\/cursors\/ \(it resolved at the merge base; this PR deleted or renamed src\/cursors\)/);
  assert.equal(fails(rep, 'links').length, 2, msgs);
});

// --- readme ----------------------------------------------------------------------------------

test('readme: code without its nearest README fails; the README, a Doc-Impact trailer or the root README settle it', (t) => {
  const r = setup(t, baseFiles({ 'Packages/com.unity.x/README.md': '# Vendor\n', 'Packages/com.unity.x/a.cs': 'a\n', 'top.js': '1\n' }));
  r.branch('x').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n', 'Packages/com.unity.x/a.cs': 'b\n', 'top.js': '2\n', 'src/notes.md': 'notes\n' });
  r.commit('feat: cursors two');
  let rep = gate(r);
  const msgs = failText(rep, 'readme');
  assert.match(msgs, /1 code path\(s\) under src\/ \(e\.g\. src\/cursors\/cursors\.js\) changed and src\/README\.md did not/);
  assert.equal(fails(rep, 'readme').length, 1, msgs);
  assert.match(infos(rep, 'readme').map((f) => f.message).join('\n'), /nearest README of 1 code path\(s\), e\.g\. top\.js is the root README\.md/);
  r.write({ 'src/README.md': '# Source\n\nThe code, with cursors two.\n' });
  r.commit('docs: src');
  rep = gate(r);
  assert.equal(check(rep, 'readme').status, 'pass', failText(rep, 'readme'));
  r.branch('trailer', 'main').write({ 'src/cursors/cursors.js': 'export const cursors = 3;\n' });
  r.commit('refactor: rename\n\nDoc-Impact: none; a rename inside one function');
  rep = gate(r);
  assert.equal(check(rep, 'readme').status, 'pass', failText(rep, 'readme'));
  assert.equal(rep.docImpact[0].reason, 'a rename inside one function');
  r.branch('malformed', 'main').write({ 'src/README.md': '# Source\n\nMore.\n', 'src/cursors/cursors.js': 'export const cursors = 4;\n' });
  r.commit('refactor: x\n\nDoc-Impact: maybe');
  assert.match(failText(gate(r), 'readme'), /Doc-Impact reads "Doc-Impact: none; <reason>"/);
  // a deleted folder's README counts from the merge base
  r.branch('delete', 'main').write({ 'src/cursors/cursors.js': null });
  r.commit('chore: delete');
  assert.match(failText(gate(r), 'readme'), /src\/README\.md did not/);
});

// --- pr --------------------------------------------------------------------------------------

test('pr: with --pr, code needs non-empty ## Tests and ## Review; docs need neither', (t) => {
  const r = setup(t);
  r.branch('x').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n', 'src/README.md': '# Source\n\nTwo.\n' });
  r.commit('feat: two');
  let rep = gate(r, { pr: 7, prBody: '## What and why\nTwo.\n## Change\nnone: a constant\n## Tests\n<!-- each command -->\n' });
  const msgs = failText(rep, 'pr');
  assert.match(msgs, /"## Tests" is empty/);
  assert.match(msgs, /no "## Review" section/);
  assert.match(infos(rep, 'pr')[0].message, /## Change: none: a constant/);
  rep = gate(r, { pr: 7, prBody: '## Tests\n`node --test`: 3 pass\n## Review\nRound 1: clean.\n' });
  assert.equal(check(rep, 'pr').status, 'pass', failText(rep, 'pr'));
  assert.equal(check(rep, 'pr').title, 'PR #7 description');
  r.branch('docs', 'main').write({ 'README.md': '# Root\n\nDocs only.\n' });
  r.commit('docs: only');
  rep = gate(r, { pr: 8, prBody: '' });
  assert.equal(check(rep, 'pr').status, 'pass');
});

test('pr and readme: a Unity .meta of a Markdown file or of a folder is not code', (t) => {
  const r = setup(t, baseFiles({ 'Assets/README.md': '# Assets\n', 'Assets/Old.meta': 'guid: 0\n', 'Assets/Old/notes.md': 'x\n' }));
  r.branch('x').write({
    'Assets/Guide/README.md': '# Guide\n\nHow.\n',
    'Assets/Guide/README.md.meta': 'guid: 1\n',
    'Assets/Guide.meta': 'guid: 2\n',
    'Assets/Old.meta': null, // a folder's .meta, the folder gone at head
    'Assets/Old/notes.md': null,
  });
  r.commit('docs: a guide');
  let rep = gate(r, { pr: 1, prBody: '## Change\nnone: docs\n' });
  assert.equal(check(rep, 'pr').status, 'pass', failText(rep, 'pr'));
  assert.match(check(rep, 'pr').summary, /no code changed/);
  assert.match(check(rep, 'readme').summary, /^0 README/);
  // a .meta of a file is code
  r.branch('code', 'main').write({ 'Assets/Thing.cs': 'class T {}\n', 'Assets/Thing.cs.meta': 'guid: 3\n' });
  r.commit('feat: thing');
  rep = gate(r, { pr: 2, prBody: '' });
  assert.match(failText(rep, 'pr'), /changes code \(e\.g\. Assets\/Thing\.cs\)/);
});

// --- protected -------------------------------------------------------------------------------

test('protected: a PR that touches the gate, the overview, a workflow, a skill or the agent rules fails, nested ones too', (t) => {
  const r = setup(
    t,
    baseFiles({
      'tools/gate/config.json': '{}\n',
      'tools/gate/README.md': '# Gate\n',
      '.agents/skills/ship/SKILL.md': '# Ship\n',
      'AGENTS.md': '# Agents\n',
      'CLAUDE.md': '# Claude\n',
      '.claude/settings.json': '{}\n',
    }),
  );
  r.branch('other').write({
    'tools/other/x.js': '1\n',
    'tools/other/README.md': '# Other\n',
    'docs/github.md': '# Not .github\n',
    '.githubx/README.md': '# Not .github\n',
    'tools/x/.github/notes.md': '# GitHub reads only the root .github\n',
    'docs/CODEOWNERS.md': '# About code owners\n',
    'tools/x/CODEOWNERS': '* @nobody\n',
    'CODEOWNERS.bak': '* @nobody\n',
    '.agents/README.md': '# Agents\n',
    'docs/agents-guide.md': '# Not the rules\n',
    'docs/CLAUDE.md.bak': 'old\n',
    'tools/gatekeeper/README.md': '# Not the gate\n',
    'tools/overviewer/README.md': '# Not the overview\n',
    'tools/setup-agents-old/x.js': '1\n',
    'tools/x/my.mcp.json': '{}\n',
  });
  r.commit('feat: unprotected');
  let rep = gate(r);
  assert.equal(check(rep, 'protected').status, 'pass', failText(rep, 'protected'));
  for (const [name, p, glob] of [
    ['gate-config', 'tools/gate/config.json', 'tools/gate/**'],
    ['overview', 'tools/overview/overview.mjs', 'tools/overview/**'],
    ['workflow', '.github/workflows/gate.yml', '.github/**'],
    ['codeowners', '.github/CODEOWNERS', '.github/**'],
    ['github-other', '.github/pull_request_template.md', '.github/**'],
    ['root-codeowners', 'CODEOWNERS', 'CODEOWNERS'],
    ['docs-codeowners', 'docs/CODEOWNERS', 'docs/CODEOWNERS'],
    ['case-codeowners', 'docs/CodeOwners', 'docs/CODEOWNERS'],
    ['skill', '.agents/skills/ship/SKILL.md', '**/.agents/skills/**'],
    ['nested-skill', 'tools/cad-export/.agents/skills/cad/SKILL.md', '**/.agents/skills/**'],
    ['agents', 'AGENTS.md', '**/AGENTS.md'],
    ['nested-agents', 'tools/cad-export/AGENTS.md', '**/AGENTS.md'],
    ['claude', 'CLAUDE.md', '**/CLAUDE.md'],
    ['settings', '.claude/settings.json', '**/.claude/**'],
    ['nested-claude', 'tools/cad-export/.claude/skills/cad-test/SKILL.md', '**/.claude/**'],
    ['setup-agents', 'tools/setup-agents/setup.mjs', 'tools/setup-agents/**'],
    ['claude-local', 'CLAUDE.local.md', '**/CLAUDE.local.md'],
    ['mcp', '.mcp.json', '**/.mcp.json'],
    ['nested-mcp', 'tools/cad-export/.mcp.json', '**/.mcp.json'],
    // a Windows checkout loads these as the protected names
    ['case-claude', 'tools/x/claude.md', '**/CLAUDE.md'],
    ['case-agents', 'tools/x/Agents.md', '**/AGENTS.md'],
    ['case-local', 'tools/x/claude.LOCAL.md', '**/CLAUDE.local.md'],
    ['case-settings', 'tools/x/.Claude/settings.json', '**/.claude/**'],
    ['case-skills', 'tools/x/.AGENTS/Skills/a/SKILL.md', '**/.agents/skills/**'],
    ['case-mcp', 'tools/y/.MCP.json', '**/.mcp.json'],
    ['case-overview', 'tools/Overview/x.mjs', 'tools/overview/**'],
  ]) {
    r.branch(name, 'main').write({ [p]: p === '.agents/skills/ship/SKILL.md' ? null : 'changed\n' });
    r.commit(`chore: ${name}\n\nDoc-Impact: none; a test`);
    rep = gate(r);
    assert.deepEqual(rep.wouldFail, ['protected'], `${name}: ${allPass(rep)}`);
    assert.equal(failText(rep, 'protected'), `: the owner merges this PR; agents never do: it touches 1 path(s) under ${glob} (${p})`, name);
  }
  assert.ok(!rep.checks.some((c) => c.id === 'workflows'), 'the workflows check is folded into protected');
});

test('protected: report-only never covers it; the run fails on it while the rest only reports', (t) => {
  const r = setup(t, baseFiles({ 'AGENTS.md': '# Agents\n' }));
  r.branch('x').write({ 'AGENTS.md': '# Agents\n\nAgents may merge anything.\n', [SPEC]: specText({ then: 'it glows' }) });
  r.commit('chore: relax');
  let rep = gate(r, { reportOnly: true });
  assert.deepEqual([rep.wouldFail, rep.blocking], [['changes', 'protected'], ['protected']]);
  assert.match(formatSummary(rep), /^## gate: FAIL \(protected\) · would also fail \(changes\), report-only\n/);
  assert.match(formatSummary(rep), /\*\*changes\*\* \(1\) · report-only/);
  // in Actions with config.json's reportOnly, the CLI exits 1 on protected and 0 without it
  const env = { GITHUB_ACTIONS: 'true' };
  let res = cli(r, ['--base', 'main', '--head', 'HEAD'], env);
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.out, /^## gate: FAIL \(protected\)/);
  r.branch('y', 'main').write({ [SPEC]: specText({ then: 'it glows' }) });
  r.commit('feat: glow');
  res = cli(r, ['--base', 'main', '--head', 'HEAD'], env);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^## gate: WOULD FAIL \(changes\) · report-only, exits 0/);
  rep = gate(r, { reportOnly: true });
  assert.deepEqual(rep.blocking, []);
});

test('prefetch reads many blobs in one batch, each the same as its own read', (t) => {
  const r = setup(t, baseFiles({ 'docs/a.md': '# A\n', 'docs/b.md': `${BOM}# B ü\n`, 'docs/empty.md': '' }));
  const paths = ['docs/a.md', 'docs/b.md', 'docs/empty.md', 'README.md', 'docs/missing.md'];
  const one = new Repo(r.dir);
  const batch = new Repo(r.dir);
  batch.prefetch('main', paths);
  for (const p of paths) assert.deepEqual(batch.blob('main', p), one.blob('main', p), p);
  assert.equal(batch.text('main', 'docs/b.md'), '# B ü\n');
});

// --- kit ---------------------------------------------------------------------------------------

const KIT = { 'tools/gate/x.mjs': 'x\n', 'tools/kit/sync.mjs': 'sync\n', 'specs/README.md': '# Specs\n' };
const LOCK = 'tools/kit/lock.json';

test('kit: a repository with no lock is skipped', (t) => {
  const r = setup(t);
  r.branch('x').write({ 'tools/gate/x.mjs': 'mine\n' });
  r.commit('chore: x\n\nDoc-Impact: none; a test');
  assert.equal(check(gate(r), 'kit').status, 'skip');
});

test('kit: a copy as its lock says passes; an edited, missing or extra kit file fails; the project\'s own files are free', (t) => {
  const r = setup(t, baseFiles({ ...KIT, 'tools/gate/config.json': '{}\n', [LOCK]: lockText(KIT) }));
  r.branch('ok').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n', 'tools/gate/config.json': '{ "mine": true }\n' });
  r.commit('feat: two\n\nDoc-Impact: none; a test');
  let rep = gate(r);
  assert.equal(check(rep, 'kit').status, 'pass', failText(rep, 'kit'));
  assert.match(check(rep, 'kit').summary, /^3 file\(s\) of the kit at c{9}; 0 not as the lock says$/);
  for (const [name, change, want] of [
    ['edited', { 'tools/gate/x.mjs': 'x, improved\n' }, /^tools\/gate\/x\.mjs: differs from the kit at c{9}, which tools\/kit\/lock\.json records/],
    ['missing', { 'specs/README.md': null }, /^specs\/README\.md: missing: the kit at c{9} has it/],
    ['extra', { 'tools/kit/extra.mjs': 'more\n' }, /^tools\/kit\/extra\.mjs: not in the kit at c{9}: a path the kit owns holds only the kit's files and the project's own \(tools\/gate\/config\.json, tools\/kit\/lock\.json\)/],
    ['deleted-lock', { [LOCK]: null }, /^tools\/kit\/lock\.json: deletes tools\/kit\/lock\.json/],
    ['broken-lock', { [LOCK]: '{' }, /^tools\/kit\/lock\.json: not JSON/],
    ['bad-lock', { [LOCK]: lockText(KIT).replace('"version": 1', '"version": 2') }, /"version" is 1, not 2/],
  ]) {
    r.branch(name, 'main').write(change);
    r.commit(`chore: ${name}\n\nDoc-Impact: none; a test`);
    rep = gate(r);
    assert.equal(check(rep, 'kit').status, 'fail', name);
    assert.match(failText(rep, 'kit').replace(/^:/, '').trim(), want, name);
  }
  // a sync: the files and the lock change together
  const next = { ...KIT, 'tools/gate/x.mjs': 'x 2\n' };
  r.branch('sync', 'main').write({ 'tools/gate/x.mjs': 'x 2\n', [LOCK]: lockText(next, { commit: 'd'.repeat(40) }) });
  r.commit('chore: sync the kit\n\nDoc-Impact: none; a test');
  rep = gate(r);
  assert.equal(check(rep, 'kit').status, 'pass', failText(rep, 'kit'));
});

test('kit: a drift already on main is information for a PR that does not touch the kit', (t) => {
  const r = setup(t, baseFiles({ ...KIT, 'tools/gate/x.mjs': 'drifted\n', [LOCK]: lockText(KIT) }));
  r.branch('x').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n' });
  r.commit('feat: two\n\nDoc-Impact: none; a test');
  let rep = gate(r);
  assert.equal(check(rep, 'kit').status, 'pass', failText(rep, 'kit'));
  assert.match(infos(rep, 'kit')[0].message, /^already at the merge base: differs from the kit/);
  r.branch('y', 'main').write({ 'specs/README.md': '# Specs, edited\n' });
  r.commit('docs: edit');
  rep = gate(r);
  assert.equal(fails(rep, 'kit').length, 2, 'a PR that touches the kit answers for all of it');
  // the project's own config sits inside tools/gate/ but is no part of the copy
  r.branch('z', 'main').write({ 'tools/gate/config.json': '{ "mine": true }\n' });
  r.commit('chore: config\n\nDoc-Impact: none; a test');
  rep = gate(r);
  assert.equal(check(rep, 'kit').status, 'pass', failText(rep, 'kit'));
  assert.match(infos(rep, 'kit')[0].message, /^already at the merge base: differs from the kit/);
});

// --- the head is data --------------------------------------------------------------------------

test('the head is read as git objects: the working tree and the checked-out branch do not matter', (t) => {
  const r = setup(t);
  r.branch('x').write({ [SPEC]: specText({ then: 'it glows' }) });
  const head = r.commit('feat: glow');
  r.branch('main', 'main').write({ [SPEC]: 'garbage in the working tree\n', 'stray.md': '[x](nope.md)\n' });
  const rep = runGate({ repo: new Repo(r.dir), base: 'main', head, config: testConfig() });
  assert.match(failText(rep, 'changes'), /adds or modifies no change folder/);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'links').status, 'pass');
});

// --- the CLI -----------------------------------------------------------------------------------

/** Runs gate.mjs in the repo with the test config, report-only as a project starts (`config: null`: the gate's own config.json). */
function cli(r, args, env = {}, { config = testConfig({ reportOnly: true }) } = {}) {
  const extra = [];
  if (config) {
    const file = path.join(r.dir, '.git', 'gate-test-config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    extra.push('--config', file);
  }
  const res = spawnSync(process.execPath, [GATE, ...args, ...extra], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: '', ...env }, windowsHide: true });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test('CLI: --local is strict; CI honours reportOnly; --report-only; exit 2 on usage and setup errors; --json-out', (t) => {
  const r = setup(t);
  r.branch('x').write({ [SPEC]: specText({ then: 'it glows' }) });
  r.commit('feat: glow');
  let res = cli(r, ['--local']);
  assert.equal(res.code, 1, res.err);
  assert.match(res.out, /^## gate: FAIL \(changes\)/);
  assert.match(res.out, /\| changes \| FAIL \|/);
  assert.match(res.out, /### What fails/);
  res = cli(r, ['--local', '--report-only']);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /^## gate: WOULD FAIL \(changes\) · report-only, exits 0/);
  const base = r.rev('main');
  const head = r.rev('HEAD');
  const out = path.join(r.dir, '..', `${path.basename(r.dir)}-gate.json`);
  t.after(() => fs.rmSync(out, { force: true }));
  // outside Actions, --base/--head is as strict as --local (the ship skill's fallback form)
  res = cli(r, ['--base', base, '--head', head, '--main', 'main'], { GITHUB_ACTIONS: '' });
  assert.equal(res.code, 1, res.out + res.err);
  assert.match(res.out, /^## gate: FAIL \(changes\)/);
  // in Actions, config.json's reportOnly makes it exit 0
  res = cli(r, ['--base', base, '--head', head, '--main', 'main', '--json-out', out], { GITHUB_ACTIONS: 'true' });
  assert.equal(res.code, 0, `config.json says reportOnly: ${res.err}`);
  assert.match(res.out, /WOULD FAIL/);
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(json.conclusion, 'fail');
  assert.deepEqual(json.wouldFail, ['changes']);
  assert.equal(json.head, head);
  assert.equal(json.reportOnly, true);
  res = cli(r, ['--base', base, '--head', head, '--json']);
  assert.equal(JSON.parse(res.out).mergeBase, base);
  assert.equal(cli(r, ['--bogus']).code, 2);
  assert.equal(cli(r, ['--base', base]).code, 2);
  assert.equal(cli(r, ['--base', base, '--head', 'no-such-ref']).code, 2);
  assert.equal(cli(r, ['--local', '--pr', 'x']).code, 2);
  res = cli(r, ['--local', '--main', 'refs/remotes/nowhere/main']);
  assert.equal(res.code, 2);
  assert.match(res.err, /does not resolve/);
  // a passing branch exits 0 under --local
  r.branch('ok', 'main').write({ 'README.md': '# Root\n\nFine.\n' });
  r.commit('docs: fine');
  res = cli(r, ['--local']);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /^## gate: PASS/);
  // without --config, the config.json beside the gate
  res = cli(r, ['--local'], {}, { config: null });
  assert.notEqual(res.code, 2, res.err);
  assert.match(res.out, /^## gate: /);
});

test('CLI: --pr reads the description from --pr-body, else from the Actions event of the same PR', (t) => {
  const r = setup(t);
  r.branch('x').write({ 'src/cursors/cursors.js': 'export const cursors = 2;\n', 'src/README.md': '# Source\n\nTwo.\n' });
  r.commit('feat: two');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-pr-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const body = path.join(tmp, 'body.md');
  fs.writeFileSync(body, '## Tests\nnode --test: pass\n## Review\nclean\n');
  let res = cli(r, ['--local', '--pr', '5', '--pr-body', body]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /PR #5 · /);
  const event = path.join(tmp, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 5, body: '## Tests\n\n## Review\nclean\n' } }));
  res = cli(r, ['--local', '--pr', '5'], { GITHUB_EVENT_PATH: event });
  assert.equal(res.code, 1);
  assert.match(res.out, /"## Tests" is empty/);
});
