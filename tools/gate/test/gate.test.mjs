// The checks end to end on small throwaway repositories, and the CLI's exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGate, Repo, formatSummary } from '../lib/index.mjs';
import { BOM } from '../lib/git.mjs';
import { GATE_DIR, makeRepo, testConfig, check, fails, failText, infos, specText, proposalText, baseFiles, git, lockText } from './helpers.mjs';

const GATE = path.join(GATE_DIR, 'gate.mjs');
const SPEC = 'specs/collaboration/peer-arrows/spec.md';
const PROPOSAL = 'changes/peer-arrows/proposal.md';

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
  r.commit('feat: peer arrows');
  const rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
  assert.match(check(rep, 'specs').summary, /1 capabilities, 1 scenarios, 1 new or changed/);
});

test('specs: format, path, domain and missing paths fail on the spec that has them', (t) => {
  const r = setup(t);
  r.branch('bad').write({
    [SPEC]: specText({
      code: ['src/arrows/', 'src/gone.js', 'src/arrows/arrows.js/', 'src'],
      proofs: ['test: src/missing.test.js', 'test: src/arrows/arrows.test.js/', 'test: src/arrows', 'test: src/arrows/', 'headset: maybe'],
    }),
    'specs/no-such-domain/thing/spec.md': specText({ title: 'Thing' }),
    'specs/collaboration/Bad_Id/spec.md': specText({ title: 'Bad' }),
    'specs/collaboration/no-spec/look/x.png': 'png',
    'specs/collaboration/peer-arrows/look/a-peer-walks-behind-the-user.png': 'png',
    'specs/collaboration/peer-arrows/look/nobody.png': 'png',
    'specs/collaboration/peer-arrows/notes.txt': 'x',
    'specs/loose.md': '# loose\n',
    [PROPOSAL]: proposalText(),
  });
  r.commit('feat: broken specs');
  const msgs = failText(gate(r), 'specs');
  assert.match(msgs, /code: no file src\/gone\.js/);
  assert.match(msgs, /code: src\/arrows\/arrows\.js\/ is a file; drop the trailing \//);
  assert.match(msgs, /code: src is a folder; end it with \//);
  assert.match(msgs, /test path no file src\/missing\.test\.js/);
  assert.match(msgs, /test path src\/arrows\/arrows\.test\.js\/ is a file; drop the trailing \//);
  assert.match(msgs, /test path src\/arrows is a folder; end it with \//);
  assert.doesNotMatch(msgs, /test path src\/arrows\/ /, 'a folder written with / is fine');
  assert.match(msgs, /takes "open"/);
  assert.match(msgs, /domain "no-such-domain" is not in specs\/domains\.json/);
  assert.match(msgs, /capability "Bad_Id" is not kebab-case/);
  assert.match(msgs, /specs\/collaboration\/no-spec\/ has no spec\.md/);
  assert.match(msgs, /look nobody\.png names no scenario/);
  assert.doesNotMatch(msgs, /look a-peer-walks-behind-the-user\.png/);
  assert.match(msgs, /notes\.txt.*stray file: a capability folder holds/);
  assert.match(msgs, /specs\/loose\.md.*stray file: specs\/ holds/);
});

test('specs: domains.json must read; a PR writing under specs/ answers for it', (t) => {
  const r = setup(t, { ...baseFiles(), 'specs/domains.json': null });
  r.branch('x').write({ [SPEC]: specText({ purpose: 'A better purpose.' }), [PROPOSAL]: proposalText() });
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

test('specs: a problem already on main in an untouched spec is information; one this PR causes fails', (t) => {
  const r = setup(t, baseFiles({ [SPEC]: specText({ code: ['src/arrows/', 'src/long-gone.js'] }) }));
  r.branch('x').write({ 'README.md': '# Root\n\nOther words.\n' });
  r.commit('docs: unrelated');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.match(infos(rep, 'specs').map((f) => f.message).join('\n'), /already at the merge base: code: no file src\/long-gone\.js/);
  // deleting a test the untouched spec names fails this PR
  r.write({ 'src/arrows/arrows.test.js': null });
  r.commit('chore: delete a test');
  rep = gate(r);
  assert.match(failText(rep, 'specs'), /test path no file src\/arrows\/arrows\.test\.js/);
});

test('specs: a domains.json or spec saved with a byte-order mark reads like any other', (t) => {
  const bom = (s) => `${BOM}${s}`;
  const r = setup(t, { ...baseFiles(), 'specs/domains.json': bom(baseFiles()['specs/domains.json']) });
  r.branch('x').write({ [SPEC]: bom(specText({ purpose: 'A better purpose.' }).replace(/\n/g, '\r\n')), [PROPOSAL]: proposalText() });
  r.commit('feat: purpose');
  const rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
});

test('specs: a changed or new scenario carries no pass or fail; an unchanged one keeps its owner\'s word', (t) => {
  const PASS = 'two-headsets: pass 2026-10-30, build 1.4.2, by owner';
  const r = setup(t, baseFiles({ [SPEC]: specText({ proofs: ['test: src/arrows/arrows.test.js', PASS] }) }));
  // triage: PROOF lines only, on an unchanged scenario
  r.branch('triage').write({ [SPEC]: specText({ proofs: ['test: src/arrows/arrows.test.js', 'two-headsets: fail 2026-10-31, build 1.4.3, by owner; arrow lags'] }) });
  r.commit('docs: triage');
  let rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
  // the verdict written is a notice: scenario, check and value, first in the information
  const notice = infos(rep, 'specs').find((f) => f.notice);
  assert.equal(notice.message, 'Arrows point at peers out of view / A peer walks behind the user: writes "two-headsets: fail 2026-10-31, build 1.4.3, by owner; arrow lags"');
  assert.match(formatSummary(rep), /### Information\n- specs: `specs\/collaboration\/peer-arrows\/spec\.md:\d+` Arrows point at peers out of view \/ A peer walks behind the user: writes "two-headsets: fail/);
  // a changed scenario keeps no fail either
  r.branch('keeps-fail', 'triage').write({ [SPEC]: specText({ then: 'it glows', proofs: ['test: src/arrows/arrows.test.js', 'two-headsets: fail 2026-10-31, build 1.4.3, by owner; arrow lags'] }), [PROPOSAL]: proposalText() });
  r.commit('feat: glow');
  assert.match(failText(gate(r, { base: 'triage' }), 'specs'), /"two-headsets: fail" on a scenario whose text changed/);
  // a changed scenario keeps every human check it had, as open; dropping one fails
  r.branch('drops', 'main').write({ [SPEC]: specText({ then: 'it glows', proofs: ['test: src/arrows/arrows.test.js'] }), [PROPOSAL]: proposalText() });
  r.commit('feat: glow, no check');
  assert.match(failText(gate(r), 'specs'), /drops its "two-headsets" check; a changed scenario keeps every human check it had at the merge base, as "two-headsets: open"/);
  // the scenario's text changes and keeps its pass
  r.branch('edit', 'main').write({ [SPEC]: specText({ then: 'the other sees a pulsing arrow', proofs: ['test: src/arrows/arrows.test.js', PASS] }), [PROPOSAL]: proposalText() });
  r.commit('feat: pulse');
  rep = gate(r);
  assert.match(failText(rep, 'specs'), /"two-headsets: pass" on a scenario whose text changed since the merge base/);
  // reset to open: fine
  r.write({ [SPEC]: specText({ then: 'the other sees a pulsing arrow', proofs: ['test: src/arrows/arrows.test.js', 'two-headsets: open'] }) });
  r.commit('feat: pulse, reset');
  rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  // re-wrapping a step is not a text change
  r.branch('wrap', 'main').write({
    [SPEC]: specText({ proofs: ['test: src/arrows/arrows.test.js', PASS] }).replace('- **WHEN** one user walks behind the other', '- **WHEN** one user walks\n  behind the other'),
  });
  r.commit('docs: wrap');
  rep = gate(r);
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  // a new scenario cannot arrive approved
  const scenarios = [
    { name: 'A peer walks behind the user', steps: ['WHEN one user walks behind the other', 'THEN the other sees an arrow'], proofs: ['test: src/arrows/arrows.test.js', PASS] },
    { name: 'A peer leaves', steps: ['WHEN a peer leaves', 'THEN the arrow goes'], proofs: ['desk: pass 2026-10-30, build 1.4.2, by owner'] },
  ];
  r.branch('new', 'main').write({ [SPEC]: specText({ scenarios }), [PROPOSAL]: proposalText() });
  r.commit('feat: leave');
  assert.match(failText(gate(r), 'specs'), /A peer leaves: "desk: pass" on a scenario new in this PR/);
});

// --- changes ---------------------------------------------------------------------------------

test('changes: a folder without proposal.md, a bad id, bad front matter, a missing capability, a stray file', (t) => {
  const r = setup(t);
  r.branch('x').write({
    'changes/no-proposal/look.md': '# Look\n',
    'changes/Bad_Id/proposal.md': proposalText(),
    'changes/bad-front/proposal.md': proposalText({ review: 'approved' }).replace('title: Arrows for peers\n', ''),
    'changes/gone-cap/proposal.md': proposalText({ capabilities: ['collaboration/peer-arrows', 'layout/halls'] }),
    'changes/loose.md': 'x\n',
  });
  r.commit('docs: changes');
  const msgs = failText(gate(r), 'changes');
  assert.match(msgs, /changes\/no-proposal\/ has no proposal\.md/);
  assert.match(msgs, /change id "Bad_Id" is not kebab-case/);
  assert.match(msgs, /front matter lacks "title"/);
  assert.match(msgs, /review "approved"/);
  assert.match(msgs, /capability layout\/halls has no specs\/layout\/halls\/spec\.md/);
  assert.match(msgs, /changes\/loose\.md.*a change is a folder/);
});

test('changes: deleting a capability a pending change names fails; the change\'s own older problems are information', (t) => {
  const r = setup(t, baseFiles({ [PROPOSAL]: proposalText(), 'changes/old/proposal.md': proposalText({ review: 'stale' }) }));
  r.branch('x').write({ [SPEC]: null, [PROPOSAL]: null, 'changes/other/proposal.md': proposalText({ title: 'Other' }) });
  r.commit('feat: remove peer arrows');
  const rep = gate(r);
  assert.match(failText(rep, 'changes'), /changes\/other\/proposal\.md.*capability collaboration\/peer-arrows has no/);
  assert.doesNotMatch(failText(rep, 'changes'), /review "stale"/);
  assert.match(infos(rep, 'changes').map((f) => f.message).join('\n'), /already at the merge base: review "stale"/);
  // the old change also names the deleted capability: that is new, so it fails
  assert.match(failText(rep, 'changes'), /changes\/old\/proposal\.md.*capability collaboration\/peer-arrows has no/);
});

test('changes: requirement text changed without a change folder that names it fails; PROOF-only, code-only and deletion-only PRs need none', (t) => {
  const r = setup(t, baseFiles({ [PROPOSAL]: proposalText(), 'specs/layout/halls/spec.md': specText({ title: 'Halls' }) }));
  r.branch('text').write({ [SPEC]: specText({ then: 'it glows' }) });
  r.commit('feat: glow');
  assert.match(failText(gate(r), 'changes'), /changes the requirement text of collaboration\/peer-arrows, which needs a change folder whose "capabilities" names collaboration\/peer-arrows; this PR adds or modifies no change folder/);
  r.write({ [PROPOSAL]: proposalText({ title: 'Arrows that glow' }) });
  r.commit('docs: the change');
  assert.equal(check(gate(r), 'changes').status, 'pass', failText(gate(r), 'changes'));
  // a written change folder that does not name the capability does not count
  r.branch('other', 'main').write({
    [SPEC]: specText({ then: 'it glows' }),
    'changes/glow/proposal.md': proposalText({ capabilities: ['collaboration/peer-arrows'] }),
    'specs/layout/halls/spec.md': specText({ title: 'Halls', then: 'x' }),
  });
  r.commit('feat: glow and halls');
  let rep = gate(r);
  assert.equal(fails(rep, 'changes').length, 1, failText(rep, 'changes'));
  assert.match(failText(rep, 'changes'), /requirement text of layout\/halls, .*; the change folder\(s\) written \(glow\) do not name it/);
  // deleting the only change folder is not writing one
  r.branch('deleted-folder', 'main').write({ [SPEC]: specText({ then: 'it glows' }), [PROPOSAL]: null });
  r.commit('feat: glow, folder gone');
  assert.match(failText(gate(r), 'changes'), /requirement text of collaboration\/peer-arrows, .*this PR adds or modifies no change folder/);
  for (const [name, files] of [
    ['proof-only', { [SPEC]: specText({ proofs: ['test: src/arrows/arrows.test.js', 'two-headsets: pass 2026-10-30, build 1, by owner'] }) }],
    ['code-only', { [SPEC]: specText({ code: ['src/arrows/', 'src/README.md'] }) }],
    ['deletion-only', { [PROPOSAL]: null }],
  ]) {
    r.branch(name, 'main').write(files);
    r.commit(`docs: ${name}`);
    rep = gate(r);
    assert.equal(check(rep, 'changes').status, 'pass', `${name}: ${failText(rep, 'changes')}`);
    assert.equal(check(rep, 'specs').status, 'pass', `${name}: ${failText(rep, 'specs')}`);
  }
});

test('changes: a deleted spec needs a change folder whose removes names it; a removed id had a spec at the merge base', (t) => {
  const r = setup(t);
  r.branch('no-removes').write({ [SPEC]: null, 'changes/drop-arrows/proposal.md': proposalText({ capabilities: ['collaboration/peer-arrows'] }) });
  r.commit('feat: drop arrows');
  let msgs = failText(gate(r), 'changes');
  assert.match(msgs, /deletes collaboration\/peer-arrows, which needs a change folder whose "removes" names collaboration\/peer-arrows; the change folder\(s\) written \(drop-arrows\) do not name it/);
  r.branch('removes', 'main').write({ [SPEC]: null, 'changes/drop-arrows/proposal.md': proposalText({ capabilities: [], removes: ['collaboration/peer-arrows'] }) });
  const removal = r.commit('feat: drop arrows (#9)');
  let rep = gate(r);
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
  assert.equal(check(rep, 'specs').status, 'pass', failText(rep, 'specs'));
  // removes answers only for a spec the PR deletes: one still here is a problem, and its text edit
  // still needs a folder whose capabilities names it
  r.branch('still-here', 'main').write({
    [SPEC]: specText({ then: 'it glows' }),
    'changes/glow/proposal.md': proposalText({ capabilities: [], removes: ['collaboration/peer-arrows'] }),
  });
  r.commit('feat: glow');
  msgs = failText(gate(r), 'changes');
  assert.match(msgs, /removes collaboration\/peer-arrows, but specs\/collaboration\/peer-arrows\/spec\.md is still here/);
  assert.match(msgs, /changes the requirement text of collaboration\/peer-arrows, which needs a change folder whose "capabilities" names collaboration\/peer-arrows; the change folder\(s\) written \(glow\) do not name it/);
  // a removed id that never had a spec
  r.branch('phantom', 'main').write({ 'changes/phantom/proposal.md': proposalText({ removes: ['layout/never-was'] }) });
  r.commit('docs: phantom');
  assert.match(failText(gate(r), 'changes'), /removes layout\/never-was, which had no specs\/layout\/never-was\/spec\.md at the merge base/);
  // once the removal is on main, its folder stays valid, and a later folder may name the id again
  git(r.dir, ['branch', '-f', 'main', removal]);
  r.branch('later', 'main').write({ 'changes/after/proposal.md': proposalText({ capabilities: [], removes: ['collaboration/peer-arrows'] }), 'changes/drop-arrows/tasks.md': '- [ ] 1.1 x; test: y\n' });
  r.commit('docs: after');
  rep = gate(r);
  assert.equal(check(rep, 'changes').status, 'pass', failText(rep, 'changes'));
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
    [SPEC]: specText({ proofs: ['test: src/arrows/arrows.test.js', 'two-headsets: pass 2026-10-30, build 1.4.2, by owner'] }),
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
    'specs/collaboration/peer-arrows/spec.md': specText({ purpose: 'y'.repeat(31000) }),
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
  const r = setup(t, baseFiles({ 'docs/README.md': '# Docs\n\nSee [arrows](../src/arrows/arrows.js) and [the folder](../src/arrows/) and [src](../src/).\n' }));
  r.branch('x').write({
    'src/arrows/arrows.js': null,
    'src/arrows/arrows.test.js': null,
    'src/README.md': '# Source\n\nNo arrows.\n',
    [SPEC]: specText({ code: ['src/README.md'], proofs: ['two-headsets: open'] }),
  });
  r.commit('refactor: drop the arrows code');
  const rep = gate(r);
  const msgs = failText(rep, 'links');
  assert.match(msgs, /docs\/README\.md:3 no such file or folder src\/arrows\/arrows\.js: \.\.\/src\/arrows\/arrows\.js \(it resolved at the merge base; this PR deleted or renamed src\/arrows\/arrows\.js\)/);
  assert.match(msgs, /docs\/README\.md:3 no such file or folder src\/arrows: \.\.\/src\/arrows\/ \(it resolved at the merge base; this PR deleted or renamed src\/arrows\)/);
  assert.equal(fails(rep, 'links').length, 2, msgs);
});

// --- readme ----------------------------------------------------------------------------------

test('readme: code without its nearest README fails; the README, a Doc-Impact trailer or the root README settle it', (t) => {
  const r = setup(t, baseFiles({ 'Packages/com.unity.x/README.md': '# Vendor\n', 'Packages/com.unity.x/a.cs': 'a\n', 'top.js': '1\n' }));
  r.branch('x').write({ 'src/arrows/arrows.js': 'export const arrows = 2;\n', 'Packages/com.unity.x/a.cs': 'b\n', 'top.js': '2\n', 'src/notes.md': 'notes\n' });
  r.commit('feat: arrows two');
  let rep = gate(r);
  const msgs = failText(rep, 'readme');
  assert.match(msgs, /1 code path\(s\) under src\/ \(e\.g\. src\/arrows\/arrows\.js\) changed and src\/README\.md did not/);
  assert.equal(fails(rep, 'readme').length, 1, msgs);
  assert.match(infos(rep, 'readme').map((f) => f.message).join('\n'), /nearest README of 1 code path\(s\), e\.g\. top\.js is the root README\.md/);
  r.write({ 'src/README.md': '# Source\n\nThe code, with arrows two.\n' });
  r.commit('docs: src');
  rep = gate(r);
  assert.equal(check(rep, 'readme').status, 'pass', failText(rep, 'readme'));
  r.branch('trailer', 'main').write({ 'src/arrows/arrows.js': 'export const arrows = 3;\n' });
  r.commit('refactor: rename\n\nDoc-Impact: none; a rename inside one function');
  rep = gate(r);
  assert.equal(check(rep, 'readme').status, 'pass', failText(rep, 'readme'));
  assert.equal(rep.docImpact[0].reason, 'a rename inside one function');
  r.branch('malformed', 'main').write({ 'src/README.md': '# Source\n\nMore.\n', 'src/arrows/arrows.js': 'export const arrows = 4;\n' });
  r.commit('refactor: x\n\nDoc-Impact: maybe');
  assert.match(failText(gate(r), 'readme'), /Doc-Impact reads "Doc-Impact: none; <reason>"/);
  // a deleted folder's README counts from the merge base
  r.branch('delete', 'main').write({ 'src/arrows/arrows.js': null });
  r.commit('chore: delete');
  assert.match(failText(gate(r), 'readme'), /src\/README\.md did not/);
});

// --- pr --------------------------------------------------------------------------------------

test('pr: with --pr, code needs non-empty ## Tests and ## Review; docs need neither', (t) => {
  const r = setup(t);
  r.branch('x').write({ 'src/arrows/arrows.js': 'export const arrows = 2;\n', 'src/README.md': '# Source\n\nTwo.\n' });
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
  r.branch('ok').write({ 'src/arrows/arrows.js': 'export const arrows = 2;\n', 'tools/gate/config.json': '{ "mine": true }\n' });
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
  r.branch('x').write({ 'src/arrows/arrows.js': 'export const arrows = 2;\n' });
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
  r.branch('x').write({ 'src/arrows/arrows.js': 'export const arrows = 2;\n', 'src/README.md': '# Source\n\nTwo.\n' });
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
