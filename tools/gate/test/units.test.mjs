// Pure functions: globs, diff parsing, Markdown, front matter, PROOF lines, specs, changes,
// derived states, Doc-Impact, PR sections and the history rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { globToRegExp, matches } from '../lib/glob.mjs';
import { parseUnifiedDiff } from '../lib/diff.mjs';
import { slugify, anchors, links, fenceMask, stripInlineCode, splitLines, firstHeading, firstParagraph, plainText } from '../lib/markdown.mjs';
import {
  parseFrontMatter,
  parseProof,
  parseSpec,
  parseChange,
  scenarioSlug,
  humanState,
  capabilityState,
  requirementText,
  pathProblem,
} from '../lib/spec.mjs';
import { readDocImpact } from '../lib/trailers.mjs';
import { prSections } from '../lib/pr.mjs';
import { blobSize } from '../lib/checks.mjs';
import { loadConfig } from '../lib/index.mjs';
import { parseCatFileBatch } from '../lib/git.mjs';
import { blobId, parseLock, owns } from '../lib/kit.mjs';
import { specText, proposalText, P, GATE_DIR } from './helpers.mjs';

const REPO_ROOT = path.resolve(GATE_DIR, '..', '..');

const problems = (text) => parseSpec(text).problems.map((p) => p.message).join('\n');

test('globs: ** spans folders, * stays in one', () => {
  assert.ok(matches('README.md', '**/README.md'));
  assert.ok(matches('tools/gate/README.md', '**/README.md'));
  assert.ok(!matches('tools/gate/README.md', 'README.md'));
  assert.ok(matches('specs/a/b/spec.md', 'specs/**/spec.md'));
  assert.ok(matches('specs/a/b/spec.md', 'specs/**/*.md'));
  assert.ok(matches('changes/x/look.md', 'changes/**'));
  assert.ok(matches('Packages/com.unity.xr.openxr/README.md', 'Packages/com.unity.*/**'));
  assert.ok(!matches('Packages/com.example.web/README.md', 'Packages/com.unity.*/**'));
  assert.ok(globToRegExp('Assets/TextMesh Pro/**').test('Assets/TextMesh Pro/a/b.cs'));
});

test('diff: added and removed lines carry their own side line numbers; content that looks like a header stays content', () => {
  const d = parseUnifiedDiff(
    [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -2,1 +2,2 @@',
      '-old',
      '+new',
      '+more',
      '@@ -9 +10 @@',
      '--- a removed rule',
      '+++ an added line',
      'diff --git a/gone.md b/gone.md',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/sp ace.md b/sp ace.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/sp ace.md',
      '@@ -0,0 +1 @@',
      '+hi\r',
      // git ends a ---/+++ name that holds a space with a TAB
      'diff --git a/a b/README.md b/a b/README.md',
      '--- a/a b/README.md\t',
      '+++ b/a b/README.md\t',
      '@@ -1 +1 @@',
      '-was',
      '+is',
    ].join('\n'),
  );
  assert.deepEqual(d.get('a b/README.md'), { added: [{ n: 1, text: 'is' }], removed: [{ n: 1, text: 'was' }] });
  assert.deepEqual(d.get('a.md').added, [
    { n: 2, text: 'new' },
    { n: 3, text: 'more' },
    { n: 10, text: '++ an added line' },
  ]);
  assert.deepEqual(d.get('a.md').removed, [
    { n: 2, text: 'old' },
    { n: 9, text: '-- a removed rule' },
  ]);
  assert.deepEqual(d.get('gone.md').removed, [{ n: 1, text: 'bye' }]);
  assert.deepEqual(d.get('sp ace.md').added, [{ n: 1, text: 'hi' }]);
});

test('markdown: GitHub slugs, repeats and HTML ids', () => {
  assert.equal(slugify('5.10 Cloud library sync (`App.Products.Sync`)'), '510-cloud-library-sync-appproductssync');
  assert.equal(slugify('Per-checkout isolation — four variables, all editor-only'), 'per-checkout-isolation--four-variables-all-editor-only');
  const a = anchors('# Top\n## Same\n## Same\n```\n# not a heading\n```\nSetext\n---\n<a id="custom"></a>\n');
  for (const s of ['top', 'same', 'same-1', 'setext', 'custom']) assert.ok(a.has(s), s);
  assert.ok(!a.has('not-a-heading'));
});

test('markdown: links outside code, reference definitions, titles', () => {
  const l = links('See [a](a.md#x "t") and `[b](b.md)`.\n```\n[c](c.md)\n```\n[ref]: <d e.md>\n![img](i.png)\n');
  assert.deepEqual(
    l.map((x) => x.target),
    ['a.md#x', 'd e.md', 'i.png'],
  );
  assert.deepEqual(fenceMask(splitLines('a\n```js\nb\n```\nc')), [false, true, true, true, false]);
  assert.equal(stripInlineCode('x `#123` y').includes('#123'), false);
});

test('markdown links: a code span runs across the lines of a paragraph; a reference definition only opens one', () => {
  // a code span over two lines hides the link-like text on both
  assert.deepEqual(links('Use `a\n[x](missing.md) b` here.\n'), []);
  // the docs/api.md shape: a bracketed key at a line start inside a code span is no definition
  assert.deepEqual(links('Each control is `{ [control]: {\n[stop]: { fact } } }` keyed by name.\n'), []);
  assert.deepEqual(links('`{ [control]: {\n[stop]: { fact } } }`\n'), []);
  // mid-paragraph, [x]: y is text, not a definition
  assert.deepEqual(links('A paragraph that goes on\n[x]: not-a-definition.md\nand on.\n'), []);
  // a real definition opens its paragraph, several may follow one another, a heading ends a block
  const real = 'Intro.\n\n[guide]: docs/guide.md\n[api]: <docs/api.md> "API"\nSee [the guide][guide] and [x](x.md).\n\n# T\n[t]: t.md\n';
  assert.deepEqual(
    links(real).map((l) => [l.n, l.target]),
    [
      [3, 'docs/guide.md'],
      [4, 'docs/api.md'],
      [5, 'x.md'],
      [8, 't.md'],
    ],
  );
  // list items, table rows, block quotes, thematic breaks and HTML blocks start blocks of their
  // own: an unpaired backtick does not reach across them
  assert.deepEqual(links('- one ` tick\n- [two](two.md) `\n').map((l) => l.target), ['two.md']);
  assert.deepEqual(links('| a ` | b |\n| [c](c.md) ` | d |\n').map((l) => l.target), ['c.md']);
  assert.deepEqual(links('a ` tick\n> [x](x.md) ` end\n').map((l) => l.target), ['x.md']);
  assert.deepEqual(links('a ` tick\n   > [x](x.md) ` end\n').map((l) => l.target), ['x.md']);
  for (const rule of ['***', '- - -', '___', ' * * *']) {
    assert.deepEqual(links(`a \` tick\n${rule}\n[r](r.md) \` end\n`).map((l) => l.target), ['r.md'], rule);
  }
  for (const tag of ['<div>', '</details>', '<!-- note -->', '<custom-element x="1">']) {
    assert.deepEqual(links(`a \` tick\n${tag}\n[h](h.md) \` end\n`).map((l) => l.target), ['h.md'], tag);
  }
  // an inline tag mid-paragraph starts nothing: the span still pairs the backticks across lines
  assert.deepEqual(links('a ` tick <span>x</span>\n[s](s.md) ` end\n'), []);
  // after a blank line, a definition opens the next block, whatever the last one left open
  assert.deepEqual(links('text ` x\n\n[d]: d.md\n').map((l) => l.target), ['d.md']);
  // the line numbers stay the document's
  assert.deepEqual(links('# T\n\ntext\nmore [a](a.md)\n').map((l) => l.n), [4]);
});

test('markdown: code spans pair runs of equal length; one pass, so 20,000 backticks take no time', () => {
  assert.equal(stripInlineCode('a `b` c'), 'a     c');
  assert.equal(stripInlineCode('a ``b ` c`` d'), `a ${' '.repeat(9)} d`);
  assert.equal(stripInlineCode('a ` b'), 'a ` b', 'an unpaired run is text');
  assert.equal(stripInlineCode('x ``` y ` z `'), `x \`\`\` y ${' '.repeat(5)}`, 'a run with no partner of its length stays; later runs still pair');
  assert.equal(stripInlineCode('`a``b`'), '      ');
  for (const line of ['`'.repeat(20000), '`a``b'.repeat(4000), `${'`'.repeat(10000)}x${'``'.repeat(5000)}`, '` '.repeat(10000)]) {
    const t = Date.now();
    const out = stripInlineCode(line);
    assert.equal(out.length, line.length);
    assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
  }
});

test('markdown: a document\'s first heading and first paragraph, plain and clipped', () => {
  const doc = '---\ntitle: x\n---\n<!-- c -->\n# The `gate` [tool](x.md)\n\n> a quote\n\n| a | b |\n\n- a list\n\nFirst **paragraph** with [a link](y.md)\nand a second line.\n\nSecond.\n';
  assert.equal(firstHeading(doc), 'The gate tool');
  assert.equal(firstParagraph(doc), 'First paragraph with a link and a second line.');
  assert.equal(firstHeading('no heading\n'), null);
  assert.equal(firstParagraph('# Only a heading\n'), '');
  const long = firstParagraph(`# T\n\n${'word '.repeat(100)}\n`);
  assert.ok(long.length <= 300 && long.endsWith('…'), long);
  assert.equal(plainText('a *b* _c_ `d` <br> [e](f)'), 'a b c d e');
});

test('front matter: scalars, lists, quotes; malformed lines, duplicates, no closing line', () => {
  const ok = parseFrontMatter('---\ntitle: "Peer arrows"\ncode:\n  - a/\n  - \'b.cs\'\nreview: unreviewed\n---\n# Body\n');
  assert.deepEqual(ok.data, { title: 'Peer arrows', code: ['a/', 'b.cs'], review: 'unreviewed' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.bodyStart, 7);
  const crlf = parseFrontMatter('---\r\ntitle: x\r\n---\r\n');
  assert.deepEqual(crlf.data, { title: 'x' });
  const bad = parseFrontMatter('---\ntitle: a\ntitle: b\n- stray\njust words\ncode:\n  -\n');
  const msgs = bad.problems.map((p) => p.message).join('\n');
  assert.match(msgs, /appears twice/);
  assert.match(msgs, /outside a list key/);
  assert.match(msgs, /is not "key: value"/);
  assert.match(msgs, /an empty item in "code"/);
  assert.match(msgs, /no closing "---"/);
  assert.equal(parseFrontMatter('# no front matter\n').present, false);
});

test('PROOF lines: every contract form parses', () => {
  assert.deepEqual(parseProof(P('test: Assets/Scripts/Colocation/Tests/PeerArrowTests.cs::PeerArrowTests.PointsBehind')), {
    check: 'test',
    state: 'test',
    path: 'Assets/Scripts/Colocation/Tests/PeerArrowTests.cs',
    selector: 'PeerArrowTests.PointsBehind',
  });
  assert.deepEqual(parseProof(P('test: tools/x.sh')), { check: 'test', state: 'test', path: 'tools/x.sh' });
  assert.deepEqual(parseProof(P('test: Assets/TextMesh Pro/T.cs')).path, 'Assets/TextMesh Pro/T.cs');
  for (const c of ['desk', 'headset', 'two-headsets', 'printed-card', 'live-tenant']) assert.deepEqual(parseProof(P(`${c}: open`)), { check: c, state: 'open' });
  assert.deepEqual(parseProof(P('headset: pass 2026-10-30, build 1.4.2, by owner')), { check: 'headset', state: 'pass', date: '2026-10-30', build: '1.4.2', by: 'owner' });
  assert.deepEqual(parseProof(P('desk: pass 2026-10-30, build 1.4.2, by owner; looked fine')).note, 'looked fine');
  assert.deepEqual(parseProof(P('headset: fail 2026-10-30, build 1.4.2 (stg), by owner; ring flickers')), {
    check: 'headset',
    state: 'fail',
    date: '2026-10-30',
    build: '1.4.2 (stg)',
    by: 'owner',
    note: 'ring flickers',
  });
});

test('PROOF lines: broken forms are errors', () => {
  const err = (v) => parseProof(P(v)).error;
  assert.match(err('headset: done'), /takes "open"/);
  assert.match(err('device: open'), /unknown check "device"/);
  assert.match(err('headset: fail 2026-10-30, build 1.4.2, by owner'), /says what failed/);
  assert.match(err('headset: pass 2026-02-30, build 1.4.2, by owner'), /not a calendar date/);
  assert.match(err('headset: pass 2026-10-30, build 1,4, by owner'), /takes "open"/);
  assert.match(err('headset: pass 2026-10-30, build 1.4, by a, b'), /takes "open"/);
  assert.match(err('test: `tools/x.sh`'), /without backticks/);
  assert.match(err('test: /abs/x.sh'), /absolute/);
  assert.match(err('test: tools\\x.sh'), /backslash/);
  assert.match(err('test: tools/../x.sh'), /"\.\."/);
  assert.match(err('test: tools/x.sh::'), /empty ::selector/);
  assert.match(err('test:'), /takes a repository path/);
  assert.match(parseProof('- **PROOF** just words').error, /<check>: <value>/);
});

test('paths: relative, forward slashes, no dot segments', () => {
  assert.equal(pathProblem('Assets/Scripts/Colocation/'), null);
  assert.equal(pathProblem('a.cs'), null);
  assert.match(pathProblem(''), /empty/);
  assert.match(pathProblem('C:/x'), /absolute/);
  assert.match(pathProblem('a//b'), /empty/);
  assert.match(pathProblem(' a'), /spaces/);
});

test('scenario slugs: lower-cased, runs of other characters one -, trimmed', () => {
  assert.equal(scenarioSlug('A peer walks behind the user'), 'a-peer-walks-behind-the-user');
  assert.equal(scenarioSlug('  Über -- 2 headsets! '), 'ber-2-headsets');
  assert.equal(scenarioSlug('!!!'), '');
});

test('spec: the contract example parses with no problems', () => {
  const text = [
    '---',
    'title: Peer arrows',
    'code:',
    '  - Assets/Scripts/Colocation/',
    '  - Assets/Scripts/Workspace/PeerArrows.cs',
    '---',
    '# Peer arrows',
    '',
    '## Purpose',
    '',
    'Plain language a non-developer understands,',
    'over two lines.',
    '',
    '## Requirements',
    '',
    '### Requirement: Arrows point at peers out of view',
    'The app SHALL show an arrow toward each peer outside the user\'s view, because a user otherwise',
    'loses track of who is where.',
    '',
    '#### Scenario: A peer walks behind the user',
    '- **GIVEN** two devices in one session',
    '- **WHEN** one user walks behind the other',
    '- **AND** keeps walking',
    '  slowly',
    '- **THEN** the other sees an arrow at the edge of view pointing at them',
    '- **PROOF** test: Assets/Scripts/Colocation/Tests/PeerArrowTests.cs::PeerArrowTests.PointsBehind',
    '- **PROOF** two-headsets: open',
    '',
  ].join('\n');
  const s = parseSpec(text);
  assert.deepEqual(s.problems, []);
  assert.equal(s.title, 'Peer arrows');
  assert.deepEqual(s.code, ['Assets/Scripts/Colocation/', 'Assets/Scripts/Workspace/PeerArrows.cs']);
  assert.equal(s.purpose, 'Plain language a non-developer understands, over two lines.');
  const [r] = s.requirements;
  assert.equal(r.name, 'Arrows point at peers out of view');
  assert.match(r.text, /^The app SHALL .* loses track of who is where\.$/);
  const [sc] = r.scenarios;
  assert.equal(sc.slug, 'a-peer-walks-behind-the-user');
  assert.equal(sc.text, 'GIVEN two devices in one session\nWHEN one user walks behind the other\nAND keeps walking slowly\nTHEN the other sees an arrow at the edge of view pointing at them');
  assert.deepEqual(
    sc.proofs.map((p) => [p.check, p.state]),
    [
      ['test', 'test'],
      ['two-headsets', 'open'],
    ],
  );
  assert.deepEqual(parseSpec(text.replace(/\n/g, '\r\n')).problems, [], 'CRLF reads the same');
  assert.deepEqual(parseSpec(specText()).problems, []);
});

test('spec: front matter breaks', () => {
  assert.match(problems(specText().replace(/^---\n/, '')), /no front matter/);
  assert.match(problems(specText().replace('title: Peer arrows\n', '')), /lacks "title"/);
  assert.match(problems(specText({ code: [] })), /"code" needs at least one item/);
  assert.match(problems(specText().replace('code:\n  - src/arrows/', 'code: src/arrows/')), /"code" must be a list/);
  assert.match(problems(specText({ code: ['../x'] })), /code: .*"\.\."/);
  assert.match(problems(specText().replace('title: Peer arrows', 'title: Peer arrows\nowner: me')), /unknown front matter key "owner"/);
});

test('spec: structure breaks', () => {
  assert.match(problems(specText().replace('# Peer arrows', '# Other title')), /differs from the front matter title/);
  assert.match(problems(specText().replace('# Peer arrows\n', '')), /one "# <title>" heading, not 0/);
  assert.match(problems(specText().replace('An arrow shows where each peer stands when they are out of view.', '')), /## Purpose is empty/);
  assert.match(problems(specText().replace('## Purpose', '## Why')), /"## Why": a spec has two sections/);
  assert.match(problems(specText().replace('## Purpose', '## Why')), /one "## Purpose", not 0/);
  const swapped = specText().replace(/## Purpose\n\n([^\n]*)\n\n## Requirements\n/, '## Requirements\n\n### Requirement: Placeholder\nX.\n\n#### Scenario: P\n- **WHEN** a\n- **THEN** b\n- **PROOF** desk: open\n\n## Purpose\n\n$1\n\n');
  assert.match(problems(swapped), /## Purpose comes before ## Requirements/);
  assert.match(problems(specText({ requirements: [] })), /holds no ### Requirement:/);
  assert.match(problems(specText().replace('### Requirement: Arrows', '### Arrows')), /is not "### Requirement: <name>"/);
  assert.match(problems(specText().replace('#### Scenario: A peer', '#### A peer')), /is not "#### Scenario: <name>"/);
  assert.match(problems(specText().replace('## Requirements\n', '## Requirements\nSome loose text.\n')), /before its first ### Requirement:/);
  assert.match(problems(specText().replace('# Peer arrows\n', '# Peer arrows\nIntro text.\n')), /text outside ## Purpose and ## Requirements/);
  assert.match(problems(specText().replace('The app SHALL show', '##### Deep\nThe app SHALL show')), /headings stop at #### Scenario:/);
  assert.match(
    problems(specText().replace(/The app SHALL show[^\n]*\n/, '')),
    /opens with its statement/,
  );
  const twoReqs = specText({
    requirements: [
      { name: 'Same', text: 'It SHALL.', scenarios: [{ name: 'One', steps: ['WHEN a', 'THEN b'], proofs: ['desk: open'] }] },
      { name: 'Same', text: 'It SHALL.', scenarios: [{ name: 'one!', steps: ['WHEN a', 'THEN b'], proofs: ['desk: open'] }] },
    ],
  });
  assert.match(problems(twoReqs), /requirement "Same" appears twice/);
  assert.match(problems(twoReqs), /has the slug "one" of the scenario at line/);
  assert.match(problems(specText({ requirements: [{ name: 'R', text: 'It SHALL.', scenarios: [] }] })), /at least one #### Scenario:/);
});

test('spec: scenario and PROOF breaks', () => {
  const one = (steps, proofs) => specText({ scenarios: [{ name: 'S', steps, proofs }] });
  assert.match(problems(one(['GIVEN a', 'THEN b'], ['desk: open'])), /a scenario has a \*\*WHEN\*\* bullet/);
  assert.match(problems(one(['WHEN a'], ['desk: open'])), /a scenario has a \*\*THEN\*\* bullet/);
  assert.match(problems(one(['WHEN a', 'THEN b'], [])), /ends in at least one - \*\*PROOF\*\* line/);
  assert.match(problems(one(['WHEN a', 'THEN b', 'BUT c'], ['desk: open'])), /"\*\*BUT\*\*" is not GIVEN/);
  assert.match(problems(one(['WHEN a', 'THEN b'], ['desk: open', 'desk: pass 2026-10-30, build 1, by o'])), /a second "desk:" line/);
  assert.match(problems(one(['WHEN a', 'THEN b'], ['desk: maybe'])), /takes "open"/);
  assert.deepEqual(parseSpec(one(['WHEN a', 'THEN b'], ['test: a.sh', 'test: b.sh', 'desk: open'])).problems, [], 'test: may repeat');
  const late = specText().replace('- **PROOF** two-headsets: open', '- **PROOF** two-headsets: open\n- **AND** a late step');
  assert.match(problems(late), /PROOF lines are the scenario's last bullets/);
  const prose = specText().replace('- **WHEN** one user', 'Some prose.\n- **WHEN** one user');
  assert.match(problems(prose), /a scenario holds only/);
  const outside = specText().replace('The app SHALL show', '- **PROOF** desk: open\nThe app SHALL show');
  assert.match(problems(outside), /a PROOF line outside any #### Scenario/);
  const fenced = specText().replace('- **WHEN** one user', '```\n- **PROOF** desk: open\n```\n- **WHEN** one user');
  assert.match(problems(fenced), /a scenario holds only/);
});

test('spec: requirement text ignores PROOF lines and code, and sees every other word', () => {
  const base = requirementText(parseSpec(specText()));
  assert.equal(requirementText(parseSpec(specText({ proofs: ['test: other.sh', 'headset: pass 2026-10-30, build 1, by o'] }))), base);
  assert.equal(requirementText(parseSpec(specText({ code: ['elsewhere/'] }))), base);
  assert.equal(requirementText(parseSpec(specText().replace('An arrow shows', 'An  arrow\nshows'))), base, 'whitespace is not text');
  assert.notEqual(requirementText(parseSpec(specText({ then: 'something else' }))), base);
  assert.notEqual(requirementText(parseSpec(specText({ purpose: 'Another purpose.' }))), base);
  assert.notEqual(requirementText(parseSpec(specText({ title: 'Other' }))), base);
});

test('change: the contract example parses; every front matter break is a problem', () => {
  const ok = parseChange(proposalText({ followUps: ['palm-menu-cone-angle'] }));
  assert.deepEqual(ok, {
    title: 'Arrows for peers',
    capabilities: ['collaboration/peer-arrows'],
    removes: [],
    review: 'unreviewed',
    followUps: ['palm-menu-cone-angle'],
    problems: [],
  });
  assert.equal(parseChange(proposalText({ review: 'changes-requested' })).review, 'changes-requested');
  const msgs = (t) => parseChange(t).problems.map((p) => p.message).join('\n');
  assert.match(msgs(proposalText({ review: 'approved' })), /review "approved" is not unreviewed or changes-requested/);
  assert.match(msgs(proposalText({ capabilities: [] })), /"capabilities" or "removes" needs at least one item/);
  const removal = parseChange(proposalText({ capabilities: [], removes: ['collaboration/old-arrows'] }));
  assert.deepEqual([removal.capabilities, removal.removes, removal.problems], [[], ['collaboration/old-arrows'], []], 'a removal names no living capability');
  assert.match(msgs(proposalText({ removes: ['Old/Arrows'] })), /removed capability "Old\/Arrows" is not/);
  assert.match(msgs(proposalText({ capabilities: [], removes: ['a/b'] }).replace('capabilities:\n', '')), /lacks "capabilities"/);
  assert.match(msgs(proposalText({ capabilities: ['peer-arrows'] })), /is not "<domain>\/<capability>"/);
  assert.match(msgs(proposalText({ capabilities: ['Working/Peer'] })), /kebab-case/);
  assert.match(msgs(proposalText({ followUps: ['Not An Id'] })), /follow-up "Not An Id"/);
  assert.match(msgs(proposalText().replace('title: Arrows for peers\n', '')), /lacks "title"/);
  assert.match(msgs(proposalText().replace('review: unreviewed\n', '')), /lacks "review"/);
  assert.match(msgs(proposalText().replace('review: unreviewed', 'review: unreviewed\ntier: small')), /unknown front matter key "tier"/);
  assert.match(msgs('# no front matter\n'), /no front matter/);
});

/** A skill template with its <placeholders> filled the way an agent fills them. */
function filled(file, fills) {
  const p = path.join(REPO_ROOT, ...file.split('/'));
  if (!fs.existsSync(p)) return null;
  let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of fills) t = t.replace(from, to);
  return t.replace(/<[^>]+>/g, 'Filled in');
}

test('the skills\' templates, filled in, parse with no problems', (t) => {
  const proposal = filled('.agents/skills/spec/templates/proposal.md', [
    [/<domain>\/<capability>\n/, 'collaboration/peer-arrows\n'],
    [/<domain>\/<capability this change deletes[^>]*>/, 'collaboration/old-arrows'],
  ]);
  const spec = filled('.agents/skills/spec/templates/spec.md', [
    [/<repo-relative folder ending in \/>/, 'src/arrows/'],
    [/<repo-relative file>/, 'src/arrows/arrows.js'],
    [/test: <[^>]+>::<[^>]+>/, 'test: src/arrows/arrows.test.js::Arrows.Behind'],
    [/<desk \| headset[^>]*>: open/, 'headset: open'],
  ]);
  if (proposal === null || spec === null) return t.skip('the skills are not in this checkout');
  const c = parseChange(proposal);
  assert.deepEqual(c.problems, []);
  assert.deepEqual([c.capabilities, c.removes, c.review], [['collaboration/peer-arrows'], ['collaboration/old-arrows'], 'unreviewed']);
  assert.deepEqual(parseSpec(spec).problems, []);
});

test('derived states: a scenario from its PROOF lines, a capability from its scenarios', () => {
  const p = (v) => parseProof(P(v));
  assert.equal(humanState([p('test: a.sh')]), 'automated');
  assert.equal(humanState([]), 'automated');
  assert.equal(humanState([p('test: a.sh'), p('headset: pass 2026-10-30, build 1, by o')]), 'approved');
  assert.equal(humanState([p('headset: pass 2026-10-30, build 1, by o'), p('desk: open')]), 'open');
  assert.equal(humanState([p('headset: fail 2026-10-30, build 1, by o; x'), p('desk: open')]), 'failing');
  // a malformed human line counts as open: never approved, never automated
  for (const bad of ['headset: maybe', 'Headset: open', 'headset: open.', 'headset: pass 2026-02-30, build 1, by o', 'desk: fail 2026-10-30, build 1, by o']) {
    assert.ok(p(bad).error, bad);
    assert.equal(humanState([p('test: a.sh'), p(bad)]), 'open', bad);
    assert.equal(humanState([p('headset: pass 2026-10-30, build 1, by o'), p(bad)]), 'open', bad);
  }
  assert.equal(humanState([p('test: `a.sh`')]), 'automated', 'a broken test: line is not a human check');
  assert.equal(humanState([p('headset: fail 2026-10-30, build 1, by o; x'), p('desk: maybe')]), 'failing');
  assert.equal(capabilityState(['approved'], false, true), 'unreviewed', 'a spec that breaks the format is never approved');
  assert.equal(capabilityState(['automated'], false, true), 'unreviewed', 'nor automated');
  assert.equal(capabilityState(['failing'], false, true), 'failing');
  assert.equal(capabilityState(['approved', 'failing'], false), 'failing');
  assert.equal(capabilityState(['approved', 'open'], false), 'unreviewed');
  assert.equal(capabilityState(['approved', 'automated'], true), 'unreviewed');
  assert.equal(capabilityState(['approved', 'automated'], false), 'approved');
  assert.equal(capabilityState(['automated'], false), 'automated');
  assert.equal(capabilityState([], false), 'automated');
});

test('Doc-Impact: the trailer anywhere in a message; other forms are malformed', () => {
  const t = readDocImpact([
    { sha: '1'.repeat(40), message: 'fix: x\n\nbody\n\nDoc-Impact: none; a refactor that moves nothing' },
    { sha: '2'.repeat(40), message: 'chore: z\n\nDoc-Impact: none — dashes too\r\nOther: x' },
    { sha: '3'.repeat(40), message: 'chore: w\n\nDoc-Impact: some' },
    { sha: '4'.repeat(40), message: 'chore: v\n\nno trailer' },
  ]);
  assert.deepEqual(
    t.docImpact.map((d) => d.reason),
    ['a refactor that moves nothing', 'dashes too'],
  );
  assert.deepEqual(
    t.malformed.map((m) => m.line),
    ['Doc-Impact: some'],
  );
});

test('PR body: ## sections, HTML comments and fenced code ignored', () => {
  const s = prSections('Intro\n## What and why\nBecause.\n## Tests\n<!-- list each command -->\n\n## Review\n```\n## not a heading\n```\nround 1: clean\n### Sub\nkept\n## Change\nnone: tooling\n');
  assert.deepEqual([...s.keys()], ['What and why', 'Tests', 'Review', 'Change']);
  assert.equal(s.get('Tests'), '');
  assert.match(s.get('Review'), /## not a heading[\s\S]*round 1: clean[\s\S]*kept/);
  assert.equal(s.get('Change'), 'none: tooling');
  assert.equal(prSections('## Tests\r\nnode --test: 12 pass\r\n').get('Tests'), 'node --test: 12 pass');
});

test('cat-file batch: each record must be the blob asked for; a missing or mismatched one throws, never shifts', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const rec = (sha, type, body) => `${sha} ${type} ${Buffer.byteLength(body)}\n${body}\n`;
  const ok = parseCatFileBatch(Buffer.from(rec(A, 'blob', 'one\n') + rec(B, 'blob', 'twö')), [A, B]);
  assert.deepEqual(ok.map((b) => b.toString('utf8')), ['one\n', 'twö']);
  assert.throws(() => parseCatFileBatch(Buffer.from(`${A} missing\n${rec(B, 'blob', 'x')}`), [A, B]), /"a+ missing" for a+/);
  assert.throws(() => parseCatFileBatch(Buffer.from(rec(B, 'blob', 'x') + rec(A, 'blob', 'y')), [A, B]), /answered b+ for a+/);
  assert.throws(() => parseCatFileBatch(Buffer.from(rec(A, 'tree', 'x')), [A]), /is a tree, not a blob/);
  assert.throws(() => parseCatFileBatch(Buffer.from(`${A} blob 10\nshort\n`), [A]), /cut short/);
  assert.throws(() => parseCatFileBatch(Buffer.from(rec(A, 'blob', 'x')), [A, B]), /no record for b+/);
});

test('budgets measure the git blob, the same on every OS', () => {
  const tree = { files: new Map([['README.md', { size: 4 }]]) };
  const repo = { tree: () => tree };
  assert.equal(blobSize(repo, 'h', 'README.md'), 4);
  assert.equal(blobSize(repo, 'h', 'missing.md'), null);
});

const TEMPLATE = path.join(GATE_DIR, 'config.template.json');
/** Every repository protects these; it may add its own owner paths. */
const PROTECTED = ['tools/gate/**', 'tools/overview/**', 'tools/setup-agents/**', 'tools/kit/**', '.github/**', 'CODEOWNERS', 'docs/CODEOWNERS', '**/.agents/skills/**', '**/AGENTS.md', '**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/**', '**/.mcp.json'];

test('config: this repository\'s config loads and protects what every repository protects', () => {
  const cfg = loadConfig();
  for (const g of PROTECTED) assert.ok(cfg.protectedPaths.includes(g), g);
  assert.deepEqual(loadConfig(TEMPLATE).protectedPaths, PROTECTED, 'the starter protects exactly these');
});

test('config: the starter config loads and is report-only; history rules match what they name and not anchors', () => {
  const cfg = loadConfig(TEMPLATE);
  assert.equal(cfg.reportOnly, true);
  const rx = (id) => {
    const r = cfg.history.find((x) => x.id === id);
    return new RegExp(r.pattern, r.flags ?? '');
  };
  const pr = rx('pr-ref');
  const repo = rx('repo-ref');
  assert.ok(pr.test('fixed in #245.') && pr.test('(#12)'));
  assert.ok(repo.test('see other-repo#46') && repo.test('example-org/other-repo#46') && repo.test('app-repo#1234.'));
  for (const s of ['[x](ARCHITECTURE.md#57-products)', '[x](#510-cloud-sync)', 'docs/a.md#12-x', 'colour #0000ff', '#12345']) {
    assert.ok(!pr.test(s) && !repo.test(s), s);
  }
  assert.ok(!repo.test('Written in C#10.') && !repo.test('F#12 and C#11'), 'one name character before # is a language, not a repo');
  assert.ok(pr.test('the accent is #333'), 'a bare hex colour reads as a PR reference: write it as inline code');
  assert.ok(!pr.test(stripInlineCode('the accent is `#333`')));
  assert.ok(rx('iso-date').test('on 2026-10-29 we'));
  assert.ok(rx('used-to').test('It Used to work') && rx('used-to').test('the menu used to open here'));
  for (const s of ['The key is used to sign the APK', 'they are used to it', 'it was used to', 'can be used to read', 'has been used to', 'is being used to', 'you get used to it', 'it gets used to', 'we got used to']) {
    assert.ok(!rx('used-to').test(s), s);
  }
  assert.ok(!cfg.budgets.some((b) => /ARCHITECTURE/.test(b.pattern)), 'ARCHITECTURE.md has no budget');
  assert.ok(rx('ruled').test('kept (ruled by the owner)'));
  for (const s of ['a follow-up PR fixes it', 'see the Follow-up pull request', 'a follow-up issue', 'follow-up tickets', 'a follow-up task', 'follow-up work remains']) {
    assert.ok(rx('follow-up-work').test(s), s);
  }
  for (const s of ['a follow-up change carries the fix', 'follow-ups: lists the change ids', 'the follow-ups of a review']) assert.ok(!rx('follow-up-work').test(s), s);
  for (const s of ['the rest is to be done later', 'German will be added later', 'a cache is planned later']) assert.ok(rx('later').test(s), s);
  assert.ok(!rx('later').test('a later change adds it') && !rx('later').test('it is added later by the build'));
  assert.ok(!cfg.history.some((r) => new RegExp(r.pattern, r.flags ?? '').test('a follow-up change')), 'the workflow\'s own wording is legitimate');
  assert.ok(rx('todo').test('TODO: x') && !rx('todo').test('todo list'));
  for (const g of ['docs/**', '**/proof/**', '**/test/fixtures/**']) assert.ok(cfg.overview.excludeModules.includes(g), g);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-config-'));
  try {
    const write = (c) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c));
    write({ ...cfg, budgets: 'x' });
    assert.throws(() => loadConfig(path.join(dir, 'config.json')), /"budgets"/);
    write({ ...cfg, budgets: [{ pattern: 'docs/**', bytes: null }, ...cfg.budgets] });
    assert.equal(loadConfig(path.join(dir, 'config.json')).budgets[0].bytes, null, 'null is no budget');
    for (const bytes of [undefined, 0, -5, 1.5, '40960']) {
      write({ ...cfg, budgets: [{ pattern: 'docs/**', bytes }] });
      assert.throws(() => loadConfig(path.join(dir, 'config.json')), /positive integer or null/, String(bytes));
    }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, overview: { excludeModules: 'dev/**' } }));
    assert.throws(() => loadConfig(path.join(dir, 'config.json')), /"overview\.excludeModules"/);
    assert.deepEqual(cfg.overview.moduleMarkers, ['README.md', 'package.json', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', '*.asmdef']);
    for (const bad of ['go.mod', ['src/go.mod'], ['']]) {
      write({ ...cfg, overview: { moduleMarkers: bad } });
      assert.throws(() => loadConfig(path.join(dir, 'config.json')), /"overview\.moduleMarkers"/, JSON.stringify(bad));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kit: a blob id is what git hash-object prints; a lock reads only in its format', () => {
  for (const s of ['', 'x\n', 'line\r\nends\n', 'ü\u0000bin']) {
    const r = spawnSync('git', ['hash-object', '--no-filters', '--stdin'], { input: Buffer.from(s), encoding: 'utf8', windowsHide: true });
    assert.equal(blobId(Buffer.from(s)), r.stdout.trim(), JSON.stringify(s));
  }
  const ok = { version: 1, kit: { repository: null, commit: 'a'.repeat(40) }, paths: ['tools/gate/', 'specs/README.md'], projectOwned: ['tools/gate/config.json'], files: { 'tools/gate/x.mjs': 'b'.repeat(40) } };
  assert.deepEqual(parseLock(JSON.stringify(ok)), { lock: ok, problems: [] });
  const bad = (o) => parseLock(JSON.stringify({ ...ok, ...o })).problems.join('\n');
  assert.match(parseLock('{').problems[0], /not JSON/);
  assert.match(bad({ version: 2 }), /"version" is 1/);
  assert.match(bad({ kit: { commit: 'main' } }), /"kit" is/);
  assert.match(bad({ paths: [] }), /"paths" is a non-empty list/);
  assert.match(bad({ paths: ['../x/'] }), /paths: .*"\.\."/);
  assert.match(bad({ projectOwned: ['elsewhere.json'] }), /projectOwned: elsewhere\.json is not inside/);
  assert.match(bad({ files: { 'src/x.js': 'b'.repeat(40) } }), /files: src\/x\.js is not inside/);
  assert.match(bad({ files: { 'tools/gate/x.mjs': 'nope' } }), /has no git blob id/);
  assert.match(bad({ files: { 'tools/gate/x.mjs': ['b'.repeat(40)] } }), /has no git blob id/, 'a string, not a list holding one');
  assert.match(bad({ files: { 'tools/gate/x.mjs': 'b'.repeat(64) } }), /has no git blob id \(40 hex\)/, 'blobId gives SHA-1 ids only');
  assert.match(bad({ kit: { repository: null, commit: ['a'.repeat(40)] } }), /"kit" is/);
  assert.ok(owns(['tools/gate/', 'specs/README.md'], 'tools/gate/lib/a.mjs') && owns(['specs/README.md'], 'specs/README.md'));
  assert.ok(!owns(['tools/gate/'], 'tools/gates/a.mjs') && !owns(['specs/README.md'], 'specs/README.md.bak'));
});
