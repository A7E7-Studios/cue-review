// Pure functions: globs, diff parsing, Markdown, front matter, PROOF lines, Looks lines, specs,
// changes, derived states, boards, Doc-Impact, PR sections, the config and the history rules.
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
  parseLook,
  scenarioSlug,
  requirementText,
  pathProblem,
  isTested,
  reviewState,
} from '../lib/spec.mjs';
import { readDocImpact } from '../lib/trailers.mjs';
import { prSections } from '../lib/pr.mjs';
import { blobSize, holdsId, networkLoads, MEDIA } from '../lib/checks.mjs';
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
  assert.ok(matches('Packages/com.unity.textmeshpro/README.md', 'Packages/com.unity.*/**'));
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
  const ok = parseFrontMatter('---\ntitle: "Shared cursors"\ncode:\n  - a/\n  - \'b.cs\'\nreview: unreviewed\n---\n# Body\n');
  assert.deepEqual(ok.data, { title: 'Shared cursors', code: ['a/', 'b.cs'], review: 'unreviewed' });
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

test('PROOF lines: a test path, optionally ::selector, and nothing else', () => {
  assert.deepEqual(parseProof(P('test: Assets/Scripts/Collaboration/Tests/SharedCursorTests.cs::SharedCursorTests.ShowsOthers')), {
    check: 'test',
    state: 'test',
    path: 'Assets/Scripts/Collaboration/Tests/SharedCursorTests.cs',
    selector: 'SharedCursorTests.ShowsOthers',
  });
  assert.deepEqual(parseProof(P('test: tools/x.sh')), { check: 'test', state: 'test', path: 'tools/x.sh' });
  assert.deepEqual(parseProof(P('test: src/sync/')), { check: 'test', state: 'test', path: 'src/sync/' });
  assert.equal(parseProof(P('test: Assets/TextMesh Pro/T.cs')).path, 'Assets/TextMesh Pro/T.cs');
});

test('PROOF lines: a human check is an error that points at the feature\'s review; broken test: forms are errors', () => {
  const err = (v) => parseProof(P(v)).error;
  for (const v of ['desk: open', 'headset: pass 2026-10-30, build 1.4.2, by owner', 'desk: fail 2026-10-30, build 1, by owner; x']) {
    assert.match(err(v), /a scenario is proven by tests only, "test: <path>\[::<selector>\]"; the owner reviews the feature, in its front matter/, v);
  }
  assert.equal(parseProof(P('desk: open')).check, 'desk');
  assert.match(err('test: `tools/x.sh`'), /without backticks/);
  assert.match(err('test: /abs/x.sh'), /absolute/);
  assert.match(err('test: tools\\x.sh'), /backslash/);
  assert.match(err('test: tools/../x.sh'), /"\.\."/);
  assert.match(err('test: tools/x.sh::'), /empty ::selector/);
  assert.match(err('test:'), /takes a repository path/);
  assert.match(parseProof('- **PROOF** just words').error, /reads "test: <path>\[::<selector>\]"/);
  assert.match(parseProof('- **WHEN** x').error, /not a PROOF line/);
});

test('paths: relative, forward slashes, no dot segments', () => {
  assert.equal(pathProblem('Assets/Scripts/Collaboration/'), null);
  assert.equal(pathProblem('a.cs'), null);
  assert.match(pathProblem(''), /empty/);
  assert.match(pathProblem('C:/x'), /absolute/);
  assert.match(pathProblem('a//b'), /empty/);
  assert.match(pathProblem(' a'), /spaces/);
});

test('scenario slugs: lower-cased, runs of other characters one -, trimmed', () => {
  assert.equal(scenarioSlug('An edit made offline reaches the others'), 'an-edit-made-offline-reaches-the-others');
  assert.equal(scenarioSlug('  Über -- 2 notes! '), 'ber-2-notes');
  assert.equal(scenarioSlug('!!!'), '');
});

/** The example of specs/README.md: front matter, Summary, Looks, a scenario with steps and one with a table. */
const EXAMPLE = [
  '---',
  'title: Offline edits',
  'review: unreviewed',
  'code:',
  '  - src/sync/',
  '  - src/editor/OfflineBanner.ts',
  '---',
  '# Offline edits',
  '',
  '## Summary',
  '',
  'You can keep writing when the connection drops: the app keeps every edit and sends it when the',
  'connection returns, and a banner says you are offline. You meet it on a train or in a lift.',
  '',
  '## Looks',
  '',
  '- looks/offline-banner.html#banner — The banner after five seconds offline',
  '- page: /notes/<id> — Open a note, then turn off the network',
  '',
  '## Requirements',
  '',
  '### Requirement: Edits made offline are kept',
  'When the connection drops, the app SHALL keep every edit and send it when the connection returns,',
  'because a user otherwise loses work they believe is saved.',
  '',
  '#### Scenario: An edit made offline reaches the others',
  '- **WHEN** a user edits a note offline and the connection returns',
  '- **THEN** the edit reaches the other users of the note',
  '- **PROOF** test: src/sync/offline.test.ts::keeps edits made offline',
  '',
  '#### Scenario: Edits wait as long as the connection is gone',
  '| Offline for | The edits are sent |',
  '|---|---|',
  '| 5 seconds | when it returns |',
  '| 3 days | when it returns |',
  '- **PROOF** test: src/sync/offline.test.ts::keeps edits for days',
  '',
].join('\n');

test('spec: the contract example parses with no problems, CRLF too', () => {
  const s = parseSpec(EXAMPLE);
  assert.deepEqual(s.problems, []);
  assert.equal(s.title, 'Offline edits');
  assert.equal(s.review, 'unreviewed');
  assert.deepEqual(s.code, ['src/sync/', 'src/editor/OfflineBanner.ts']);
  assert.match(s.summary, /^You can keep writing when the connection drops: .* or in a lift\.$/);
  assert.deepEqual(
    s.looks.map(({ n, ...l }) => l),
    [
      { kind: 'board', board: 'looks/offline-banner.html', id: 'banner', caption: 'The banner after five seconds offline' },
      { kind: 'page', target: '/notes/<id>', caption: 'Open a note, then turn off the network' },
    ],
  );
  const [r] = s.requirements;
  assert.equal(r.name, 'Edits made offline are kept');
  assert.match(r.text, /^When the connection drops, the app SHALL .*, because a user otherwise loses work they believe is saved\.$/);
  const [steps, table] = r.scenarios;
  assert.equal(steps.slug, 'an-edit-made-offline-reaches-the-others');
  assert.equal(steps.text, 'WHEN a user edits a note offline and the connection returns\nTHEN the edit reaches the other users of the note');
  assert.equal(steps.table, null);
  assert.deepEqual(steps.proofs.map((p) => [p.path, p.selector]), [['src/sync/offline.test.ts', 'keeps edits made offline']]);
  assert.deepEqual(table.steps, []);
  assert.deepEqual(table.table, { header: ['Offline for', 'The edits are sent'], rows: [['5 seconds', 'when it returns'], ['3 days', 'when it returns']] });
  assert.equal(table.text, '| Offline for | The edits are sent |\n| 5 seconds | when it returns |\n| 3 days | when it returns |');
  assert.deepEqual(parseSpec(EXAMPLE.replace(/\n/g, '\r\n')).problems, [], 'CRLF reads the same');
  assert.deepEqual(parseSpec(specText()).problems, []);
});

test('spec: front matter needs title, review (one of three verdicts) and code, and no other key', () => {
  assert.match(problems(specText().replace(/^---\n/, '')), /no front matter/);
  assert.match(problems(specText().replace('title: Shared cursors\n', '')), /lacks "title"/);
  assert.match(problems(specText().replace('review: unreviewed\n', '')), /lacks "review"/);
  for (const v of ['unreviewed', 'approved', 'changes-requested']) assert.deepEqual(parseSpec(specText({ review: v })).problems, [], v);
  assert.equal(parseSpec(specText({ review: 'approved' })).review, 'approved');
  for (const v of ['pass', 'open', 'Approved', 'reviewed']) assert.match(problems(specText({ review: v })), new RegExp(`review "${v}" is not unreviewed, approved, changes-requested`), v);
  assert.match(problems(specText({ code: [] })), /"code" needs at least one item/);
  assert.match(problems(specText().replace('code:\n  - src/cursors/', 'code: src/cursors/')), /"code" must be a list/);
  assert.match(problems(specText({ code: ['../x'] })), /code: .*"\.\."/);
  assert.match(problems(specText().replace('title: Shared cursors', 'title: Shared cursors\nowner: me')), /unknown front matter key "owner" \(one of title, review, code\)/);
});

test('spec: Summary, an optional Looks, then Requirements; the old Purpose section is no section', () => {
  assert.deepEqual(parseSpec(specText({ looks: null })).problems, [], 'Looks is optional');
  assert.deepEqual(parseSpec(specText({ looks: ['looks/board.html#main — The cursor', 'page: /notes/1 — Open a note'] })).problems, []);
  // the format before this one: ## Purpose
  const purpose = specText().replace('## Summary', '## Purpose');
  assert.match(problems(purpose), /"## Purpose": a spec's sections are ## Summary, ## Looks and ## Requirements/);
  assert.match(problems(purpose), /one "## Summary", not 0/);
  assert.match(problems(specText().replace('A cursor shows where each collaborator is typing.', '')), /## Summary is empty/);
  const looksLast = specText().replace(/\n## Requirements\n[\s\S]*$/, (req) => `${req}\n## Looks\n\n- page: /x — Late\n`);
  assert.match(problems(looksLast), /## Looks comes after ## Requirements: the order is Summary, Looks, Requirements/);
  const looksFirst = specText({ looks: ['page: /x — First'] }).replace(/## Summary\n\n([^\n]*)\n\n(## Looks\n\n[^\n]*\n)/, '$2\n## Summary\n\n$1\n');
  assert.match(problems(looksFirst), /## Summary comes after ## Looks/);
  const twoLooks = specText({ looks: ['page: /x — One'] }).replace('## Requirements', '## Looks\n\n- page: /y — Two\n\n## Requirements');
  assert.match(problems(twoLooks), /at most one "## Looks", not 2/);
  assert.match(problems(specText().replace('## Requirements', '## Looks\n\n## Requirements')), /## Looks lists nothing/);
  assert.match(problems(specText({ looks: ['page: /x — One'] }).replace('- page: /x — One', '- page: /x — One\nSome prose.')), /Looks: a Looks line is a "- " bullet/);
  assert.match(problems(specText({ looks: ['page: /x — One'] }).replace('- page: /x — One', '```\nx\n```')), /## Looks holds only its Looks lines/);
});

test('spec: structure breaks', () => {
  assert.match(problems(specText().replace('# Shared cursors', '# Other title')), /differs from the front matter title/);
  assert.match(problems(specText().replace('# Shared cursors\n', '')), /one "# <title>" heading, not 0/);
  assert.match(problems(specText().replace('## Summary', '## Why')), /"## Why": a spec's sections are/);
  assert.match(problems(specText({ requirements: [] })), /holds no ### Requirement:/);
  assert.match(problems(specText().replace('### Requirement: Cursors', '### Cursors')), /is not "### Requirement: <name>"/);
  assert.match(problems(specText().replace('#### Scenario: A collaborator', '#### A collaborator')), /is not "#### Scenario: <name>"/);
  assert.match(problems(specText().replace('## Requirements\n', '## Requirements\nSome loose text.\n')), /before its first ### Requirement:/);
  assert.match(problems(specText().replace('# Shared cursors\n', '# Shared cursors\nIntro text.\n')), /text outside ## Summary, ## Looks and ## Requirements/);
  assert.match(problems(specText().replace('When two users', '##### Deep\nWhen two users')), /headings stop at #### Scenario:/);
  assert.match(problems(specText().replace(/When two users edit[^\n]*\n/, '')), /opens with its statement/);
  const sc = [{ name: 'One', steps: ['WHEN a', 'THEN b'] }];
  const twoReqs = specText({
    requirements: [
      { name: 'Same', text: 'It SHALL work, because x.', scenarios: sc },
      { name: 'Same', text: 'It SHALL work, because x.', scenarios: [{ ...sc[0], name: 'one!' }] },
    ],
  });
  assert.match(problems(twoReqs), /requirement "Same" appears twice/);
  assert.match(problems(twoReqs), /has the slug "one" of the scenario at line/);
  assert.match(problems(specText({ requirements: [{ name: 'R', text: 'It SHALL work, because x.', scenarios: [] }] })), /at least one #### Scenario:/);
});

test('spec: a statement holds SHALL and its reason, because', () => {
  const statement = (text) => problems(specText({ requirements: [{ name: 'R', text, scenarios: [{ name: 'S', steps: ['WHEN a', 'THEN b'] }] }] }));
  assert.equal(statement('When a user types, the app SHALL show it, because they look.'), '');
  assert.equal(statement('The app SHALL keep a draft, because a crash otherwise loses it.'), '', 'a behaviour that holds always drops "When …,"');
  assert.match(statement('The app SHALL keep a draft.'), /R: the statement reads "When …, the app SHALL …, because …": it holds SHALL and its reason/);
  assert.match(statement('The app keeps a draft, because a crash loses it.'), /holds SHALL and its reason/);
  assert.match(statement('The app shall keep a draft, because x.'), /holds SHALL/, 'SHALL in capitals');
  assert.match(statement('The app SHALL keep a draft.\n\nThis is because a crash loses it.'), /R: the statement is one paragraph, its reason in the same sentence/);
});

test('spec: steps are optional; given any, one WHEN and one THEN, a GIVEN first, an AND after another step', () => {
  const one = (steps, extra = {}) => problems(specText({ scenarios: [{ name: 'S', steps, ...extra }] }));
  assert.equal(one([]), '', 'a scenario may be its name alone');
  assert.equal(one(['WHEN a', 'THEN b']), '');
  assert.equal(one(['GIVEN a', 'AND b', 'WHEN c', 'AND d', 'THEN e', 'AND f']), '');
  assert.match(one(['GIVEN a', 'THEN b']), /S: steps hold one \*\*WHEN\*\* and one \*\*THEN\*\* \(they have 0 and 1\)/);
  assert.match(one(['WHEN a']), /they have 1 and 0/);
  assert.match(one(['WHEN a', 'WHEN b', 'THEN c']), /they have 2 and 1/);
  assert.match(one(['WHEN a', 'THEN b', 'THEN c']), /they have 1 and 2/);
  assert.match(one(['GIVEN a', 'GIVEN b', 'WHEN c', 'THEN d']), /at most one \*\*GIVEN\*\*/);
  assert.match(one(['WHEN a', 'GIVEN b', 'THEN c']), /\*\*GIVEN\*\* comes first/);
  assert.match(one(['AND a', 'WHEN b', 'THEN c']), /\*\*AND\*\* follows another step/);
  assert.match(one(['THEN a', 'WHEN b']), /\*\*WHEN\*\* comes before \*\*THEN\*\*/);
  assert.match(one(['WHEN a', 'THEN b', 'BUT c']), /"\*\*BUT\*\*" is not GIVEN, WHEN, THEN, AND or PROOF/);
  const wrapped = parseSpec(specText().replace('- **WHEN** one user types in a paragraph', '- **WHEN** one user types\n  in a paragraph'));
  assert.deepEqual(wrapped.problems, []);
  assert.equal(wrapped.requirements[0].scenarios[0].steps[1].text, 'one user types in a paragraph', 'a bullet wraps onto lines indented by two spaces');
  const prose = specText().replace('- **WHEN** one user', 'Some prose.\n- **WHEN** one user');
  assert.match(problems(prose), /a scenario holds its "- \*\*GIVEN\/WHEN\/THEN\/AND\*\* \.\.\." steps, a table, then its "- \*\*PROOF\*\* \.\.\." lines/);
});

test('spec: a table has a header, a |---| row and one row per case, all of the header\'s width, after the steps', () => {
  const table = (rows, steps = []) => specText({ scenarios: [{ name: 'Cases', steps, table: rows }] });
  const ok = parseSpec(table([['Input', 'Output'], ['a', 'A'], ['b', 'B']], ['WHEN a user types', 'THEN the letter is upper case']));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.requirements[0].scenarios[0].table, { header: ['Input', 'Output'], rows: [['a', 'A'], ['b', 'B']] });
  assert.deepEqual(parseSpec(table([['Input', 'Output'], ['a', 'A']])).problems, [], 'a table alone');
  assert.match(problems(table([['Input', 'Output']])), /Cases: a table has a header row, a \|---\| row and one row per case/);
  assert.match(problems(table([['Input', 'Output'], ['a', 'A', 'extra']])), /Cases: a table row has 3 cells, the header 2/);
  const noSeparator = specText({ scenarios: [{ name: 'Cases', steps: [] }] }).replace('#### Scenario: Cases\n', '#### Scenario: Cases\n| a | b |\n| c | d |\n');
  assert.match(problems(noSeparator), /a table has a header row, a \|---\| row/);
  const stepsAfter = table([['Input', 'Output'], ['a', 'A']]).replace('| a | A |', '| a | A |\n- **WHEN** late');
  assert.match(problems(stepsAfter), /Cases: steps come before the table/);
});

test('spec: PROOF lines are test: lines that end the scenario; a scenario without one is untested and valid', () => {
  const one = (proofs) => specText({ scenarios: [{ name: 'S', steps: ['WHEN a', 'THEN b'], proofs }] });
  assert.deepEqual(parseSpec(one([])).problems, [], 'untested is valid');
  assert.deepEqual(parseSpec(one(['test: a.sh', 'test: b.sh::B.run'])).problems, [], 'test: may repeat');
  // the format before this one: human checks on scenarios
  assert.match(problems(one(['test: a.sh', 'desk: open'])), /S: "desk:": a scenario is proven by tests only/);
  assert.match(problems(one(['headset: pass 2026-10-30, build 1.4.2, by owner'])), /"headset:": a scenario is proven by tests only/);
  const late = one(['test: a.sh']).replace('- **PROOF** test: a.sh', '- **PROOF** test: a.sh\n- **AND** a late step');
  assert.match(problems(late), /S: PROOF lines are the scenario's last lines/);
  const outside = specText().replace('When two users', '- **PROOF** test: a.sh\nWhen two users');
  assert.match(problems(outside), /a PROOF line outside any #### Scenario/);
  const fenced = specText().replace('- **WHEN** one user', '```\n- **PROOF** test: a.sh\n```\n- **WHEN** one user');
  assert.match(problems(fenced), /a scenario holds its/);
});

test('Looks lines: a board with its id, or a page, each with a caption', () => {
  assert.deepEqual(parseLook('- looks/offline-banner.html#banner — The banner'), { kind: 'board', board: 'looks/offline-banner.html', id: 'banner', caption: 'The banner' });
  assert.deepEqual(parseLook('- page: /notes/<id> — Open a note'), { kind: 'page', target: '/notes/<id>', caption: 'Open a note' });
  assert.deepEqual(parseLook('- page: https://example.invalid/notes — The site'), { kind: 'page', target: 'https://example.invalid/notes', caption: 'The site' });
  assert.equal(parseLook('* looks/a.b-c_d.html#Main_1 — A — with a dash').caption, 'A — with a dash');
  assert.match(parseLook('looks/a.html#x — no bullet').error, /a Looks line is a "- " bullet/);
  assert.match(parseLook('- looks/a.html#x').error, /a Looks line reads "- looks\/<name>\.html#<id> — <caption>" or "- page: <path or URL> — <caption>"/);
  assert.match(parseLook('- looks/a.html#x - a hyphen').error, /a Looks line reads/, 'the caption follows an em dash');
  assert.match(parseLook('- looks/a.html — no id').error, /not "looks\/a\.html"/);
  assert.match(parseLook('- a.html#x — no folder').error, /not "a\.html#x"/);
  assert.match(parseLook('- looks/sub/a.html#x — nested').error, /looks\/sub\/a\.html is not looks\/<name>\.html/);
  assert.match(parseLook('- looks/a.png#x — a picture').error, /looks\/a\.png is not looks\/<name>\.html/);
  assert.match(parseLook('- looks/a.html#x y — a space').error, /a Looks line reads/);
  assert.match(problems(specText({ looks: ['looks/a.png#x — a picture'] })), /Looks: looks\/a\.png is not looks\/<name>\.html/);
});

test('spec text: title, Summary, Looks, statements, scenario names, steps and tables; not code, review or PROOF lines', () => {
  const base = requirementText(parseSpec(specText({ looks: ['looks/board.html#main — The cursor'] })));
  const same = (o, why) => assert.equal(requirementText(parseSpec(specText({ looks: ['looks/board.html#main — The cursor'], ...o }))), base, why);
  const differs = (o, why) => assert.notEqual(requirementText(parseSpec(specText({ looks: ['looks/board.html#main — The cursor'], ...o }))), base, why);
  same({ proofs: ['test: other.sh', 'test: more.sh::M'] }, 'PROOF lines');
  same({ code: ['elsewhere/'] }, 'code');
  same({ review: 'approved' }, 'review');
  same({ summary: 'A  cursor\nshows where each collaborator is typing.' }, 'whitespace');
  differs({ then: 'something else' }, 'a step');
  differs({ summary: 'Another summary.' }, 'the Summary');
  differs({ title: 'Other' }, 'the title');
  differs({ looks: ['looks/board.html#other — The cursor'] }, 'a board id');
  differs({ looks: ['looks/board.html#main — Another caption'] }, 'a caption');
  differs({ looks: ['looks/board.html#main — The cursor', 'page: /notes — Open a note'] }, 'a page line');
  differs({ looks: null }, 'no Looks');
  const table = (cell) => requirementText(parseSpec(specText({ scenarios: [{ name: 'Cases', table: [['In', 'Out'], ['a', cell]] }] })));
  assert.notEqual(table('A'), table('B'), 'a table cell');
  assert.equal(table('A'), table('A'));
  const statement = specText().replace('the app SHALL show', 'the app SHALL draw');
  assert.notEqual(requirementText(parseSpec(statement)), requirementText(parseSpec(specText())), 'a statement');
});

test('change: the contract example parses; review and follow-ups are no keys of a proposal', () => {
  assert.deepEqual(parseChange(proposalText()), { title: 'Cursors for collaborators', capabilities: ['collaboration/shared-cursors'], removes: [], problems: [] });
  const msgs = (t) => parseChange(t).problems.map((p) => p.message).join('\n');
  // the format before this one: a proposal carried its review state and follow-ups
  assert.match(msgs(proposalText().replace('capabilities:', 'review: unreviewed\ncapabilities:')), /unknown front matter key "review" \(one of title, capabilities, removes\)/);
  assert.match(msgs(proposalText().replace('capabilities:', 'follow-ups:\n  - later-change\ncapabilities:')), /unknown front matter key "follow-ups"/);
  assert.match(msgs(proposalText({ capabilities: [] })), /"capabilities" or "removes" needs at least one item/);
  const removal = parseChange(proposalText({ capabilities: [], removes: ['collaboration/old-cursors'] }));
  assert.deepEqual([removal.capabilities, removal.removes, removal.problems], [[], ['collaboration/old-cursors'], []], 'a removal names no living capability');
  assert.match(msgs(proposalText({ removes: ['Old/Cursors'] })), /removed capability "Old\/Cursors" is not/);
  assert.match(msgs(proposalText({ capabilities: [], removes: ['a/b'] }).replace('capabilities:\n', '')), /lacks "capabilities"/);
  assert.match(msgs(proposalText({ capabilities: ['shared-cursors'] })), /is not "<domain>\/<capability>"/);
  assert.match(msgs(proposalText({ capabilities: ['Working/Collaborator'] })), /kebab-case/);
  assert.match(msgs(proposalText().replace('title: Cursors for collaborators\n', '')), /lacks "title"/);
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
    [/<domain>\/<capability>\n/, 'collaboration/shared-cursors\n'],
    [/<domain>\/<capability this change deletes[^>]*>/, 'collaboration/old-cursors'],
  ]);
  const spec = filled('.agents/skills/spec/templates/spec.md', [
    [/<repo-relative folder ending in \/>/, 'src/cursors/'],
    [/<repo-relative file>/, 'src/cursors/cursors.js'],
    [/looks\/<board-name>\.html#<section-id>/, 'looks/board.html#main'],
    [/test: <[^>]+>::<[^>]+>/, 'test: src/cursors/cursors.test.js::Cursors.Others'],
  ]);
  if (proposal === null || spec === null) return t.skip('the skills are not in this checkout');
  const c = parseChange(proposal);
  assert.deepEqual(c.problems, []);
  assert.deepEqual([c.capabilities, c.removes], [['collaboration/shared-cursors'], ['collaboration/old-cursors']]);
  const s = parseSpec(spec);
  assert.deepEqual(s.problems, []);
  assert.equal(s.review, 'unreviewed', 'a new spec starts unreviewed');
  assert.deepEqual(s.looks.map((l) => l.kind), ['board', 'page']);
});

test('derived states: a scenario is tested by a well-formed test: line; a feature\'s review across its repositories', () => {
  const sc = (...lines) => ({ proofs: lines.map((v) => parseProof(P(v))) });
  assert.equal(isTested(sc('test: a.sh')), true);
  assert.equal(isTested(sc('test: a.sh::A.b', 'test: b.sh')), true);
  assert.equal(isTested(sc()), false, 'no PROOF line: untested');
  assert.equal(isTested(sc('test: `a.sh`')), false, 'a broken test: line proves nothing');
  assert.equal(isTested(sc('desk: open')), false);
  assert.equal(isTested(sc('desk: open', 'test: a.sh')), true);
  assert.equal(reviewState(['approved']), 'approved');
  assert.equal(reviewState(['approved', 'approved']), 'approved');
  assert.equal(reviewState(['approved', 'unreviewed']), 'unreviewed');
  assert.equal(reviewState(['approved', null]), 'unreviewed', 'a side that does not read is never approved');
  assert.equal(reviewState(['unreviewed', 'changes-requested']), 'changes-requested');
  assert.equal(reviewState(['approved', 'changes-requested']), 'changes-requested');
  assert.equal(reviewState([]), 'unreviewed');
});

test('boards: an element id in either quote; a network load in src=, href=, url(…) or @import, with its line', () => {
  assert.ok(holdsId('<section id="main">', 'main'));
  assert.ok(holdsId("<div class='x' id = 'side-2'>", 'side-2'));
  assert.ok(!holdsId('<section id="mainly">', 'main'));
  assert.ok(!holdsId('<section data-id="main">', 'main'));
  assert.ok(!holdsId('<a href="#main">', 'main'));
  assert.ok(holdsId('<section id=idle>', 'idle') && holdsId('<p id=idle/>', 'idle'));
  assert.ok(!holdsId('<section id=idler>', 'idle'));
  const html = [
    '<link rel="stylesheet" href="https://fonts.example.invalid/a.css">',
    '<img src=http://example.invalid/a.png>',
    '<style>body { background: url( "https://example.invalid/b.png" ) }',
    '@import "https://example.invalid/c.css";',
    '.ok { background: url(data:image/gif;base64,R0lGOD) } </style>',
    '<a href="#main">in the page</a> <a href="mailto:x@example.invalid">mail</a> <a href="https://example.invalid/doc">a link</a>',
    '<img src="local.png"> <script src="//cdn.example.invalid/x.js"></script>',
    '<img srcset="https://example.invalid/2x.png 2x"> <video poster="https://example.invalid/p.png"></video>',
    '<link rel=stylesheet href="../../../../tools/design/house-style/tokens.css"> <img data-src="lazy.png">',
  ].join('\n');
  assert.deepEqual(networkLoads(html), [
    { line: 1, url: 'https://fonts.example.invalid/a.css' },
    { line: 2, url: 'http://example.invalid/a.png' },
    { line: 3, url: 'https://example.invalid/b.png' },
    { line: 4, url: 'https://example.invalid/c.css' },
    { line: 7, url: 'local.png' },
    { line: 7, url: '//cdn.example.invalid/x.js' },
    { line: 8, url: 'https://example.invalid/2x.png' },
    { line: 8, url: 'https://example.invalid/p.png' },
    { line: 9, url: '../../../../tools/design/house-style/tokens.css' },
  ]);
  // text, script, comments and other attributes' values load nothing
  const quiet = [
    '<script>const data = { a: 1 }; let src = "abc";</script>',
    '<p>Set src=foo.png, or use @import rules</p> <p title="data=1 src=x.png">t</p>',
    '<style>/* @import nothing; url(gone.png) */ .g { fill: url(#grad) } :root { --c: #5b5bd6 }</style>',
    '<!-- <img src="old.png"> -->',
    '<svg><use href="#icon"/><a xlink:href="https://example.invalid/doc">a link</a></svg>',
    '<object data="data:image/svg+xml;base64,PHN2Zz4="></object>',
  ].join('\n');
  assert.deepEqual(networkLoads(quiet), []);
  const svg = [
    '<svg><image href="pic.png"/><feImage href="https://example.invalid/f.png"/><use href="icons.svg#a"/></svg>',
    '<link rel=preload as=image imagesrcset="hero.png 1x, hero@2x.png 2x">',
    '<div style="background: image-set(\'a.png\' 1x, \'b.png\' 2x)"></div>',
  ].join('\n');
  assert.deepEqual(networkLoads(svg), [
    { line: 1, url: 'pic.png' },
    { line: 1, url: 'https://example.invalid/f.png' },
    { line: 1, url: 'icons.svg#a' },
    { line: 2, url: 'hero.png' },
    { line: 2, url: 'hero@2x.png' },
    { line: 3, url: 'a.png' },
    { line: 3, url: 'b.png' },
  ]);
  // image-set by its own depth, srcset as a browser splits it, style values by their own lines
  assert.deepEqual(networkLoads('<p style="background: image-set(url(\'a.png\') 1x, \'https://x.invalid/b.png\' 2x)">'), [
    { line: 1, url: 'a.png' },
    { line: 1, url: 'https://x.invalid/b.png' },
  ]);
  assert.deepEqual(networkLoads('<p style=\'background: image-set("data:image/avif;base64,AA" type("image/avif"), "c.jpg" type("image/jpeg"))\'>'), [{ line: 1, url: 'c.jpg' }]);
  assert.deepEqual(networkLoads('<img srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BB,BB 2x">'), []);
  assert.deepEqual(networkLoads('<div style="\n\n\nx: url(c.png)">'), [{ line: 4, url: 'c.png' }]);
  // a comment or a tag inside raw text is text; a custom element is not style; template and textarea hold no markup
  for (const before of ['<script>var s = "<style>";</script>', '<script>var s = "<!--";</script>', '<style>.a::before { content: "<!--" }</style>', '<p title="<!--">', '<style-card>x</style-card>']) {
    assert.deepEqual(networkLoads(`${before}\n<img src="https://x.invalid/a.png">`), [{ line: 2, url: 'https://x.invalid/a.png' }], before);
  }
  assert.deepEqual(networkLoads('<template><img src=h.png></template><textarea><img src=o.png></textarea><title><img src=t.png></title>'), []);
  // values decoded as a browser decodes them; srcdoc is a document of its own
  assert.deepEqual(networkLoads('<div style="background: url(&quot;data:image/png;base64,AA&quot;); fill: url(&quot;#g&quot;)">'), []);
  assert.deepEqual(networkLoads('<div style="background: image-set(&quot;https://x.invalid/g.png&quot; 1x)"> <img src="&#104;ttps://x.invalid/h.png">'), [
    { line: 1, url: 'https://x.invalid/g.png' },
    { line: 1, url: 'https://x.invalid/h.png' },
  ]);
  assert.deepEqual(networkLoads('<iframe srcdoc="<img src=\'https://x.invalid/a.png\'>"></iframe>'), [{ line: 1, url: 'https://x.invalid/a.png' }]);
  for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.mp4', 'h.mov', 'i.webm', 'j.tiff', 'k.heic', 'l.ico']) assert.ok(MEDIA.test(`specs/x/y/${f}`), f);
  for (const f of ['spec.md', 'looks/a.html', 'tokens.css', 'notes.txt', 'png.md']) assert.ok(!MEDIA.test(`specs/x/y/${f}`), f);
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
  for (const g of ['docs/**', '**/proof/**', '**/test/fixtures/**']) assert.ok(cfg.overview.excludeComponents.includes(g), g);
  assert.deepEqual(cfg.budgets.find((b) => b.pattern === 'specs/**/looks/*.html'), { pattern: 'specs/**/looks/*.html', bytes: 30720 }, 'a board has the budget of a spec');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-config-'));
  try {
    const file = path.join(dir, 'config.json');
    const write = (c) => fs.writeFileSync(file, JSON.stringify(c));
    write({ ...cfg, budgets: 'x' });
    assert.throws(() => loadConfig(file), /"budgets"/);
    write({ ...cfg, budgets: [{ pattern: 'docs/**', bytes: null }, ...cfg.budgets] });
    assert.equal(loadConfig(file).budgets[0].bytes, null, 'null is no budget');
    for (const bytes of [undefined, 0, -5, 1.5, '40960']) {
      write({ ...cfg, budgets: [{ pattern: 'docs/**', bytes }] });
      assert.throws(() => loadConfig(file), /positive integer or null/, String(bytes));
    }
    write({ ...cfg, overview: { excludeComponents: 'dev/**' } });
    assert.throws(() => loadConfig(file), /"overview\.excludeComponents"/);
    assert.deepEqual(cfg.overview.componentMarkers, ['README.md', 'package.json', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', '*.asmdef']);
    for (const bad of ['go.mod', ['src/go.mod'], ['']]) {
      write({ ...cfg, overview: { componentMarkers: bad } });
      assert.throws(() => loadConfig(file), /"overview\.componentMarkers"/, JSON.stringify(bad));
    }
    // the keys before this format name their new names
    write({ ...cfg, overview: { moduleMarkers: ['README.md'] } });
    assert.throws(() => loadConfig(file), /"overview\.moduleMarkers" is named "overview\.componentMarkers"/);
    write({ ...cfg, overview: { excludeModules: ['docs/**'] } });
    assert.throws(() => loadConfig(file), /"overview\.excludeModules" is named "overview\.excludeComponents"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: the design block names a tokens file and a brief, and optionally catalogues and a render command', () => {
  const cfg = loadConfig(TEMPLATE);
  assert.deepEqual(cfg.design, { tokens: 'tools/design/house-style/tokens.css', brief: 'tools/design/house-style/brief.md' }, 'the starter names the house style');
  assert.equal(loadConfig().design, undefined, 'this repository names none');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-config-'));
  try {
    const file = path.join(dir, 'config.json');
    const load = (design) => {
      fs.writeFileSync(file, JSON.stringify({ ...cfg, design }));
      return loadConfig(file);
    };
    const full = { tokens: 'design/tokens.css', brief: 'design/brief.md', catalogues: [{ name: 'icons', open: 'https://example.invalid/icons/{entry}' }], render: 'npm run render' };
    assert.deepEqual(load(full).design, full);
    for (const [design, want] of [
      ['design/', /"design" is \{ "tokens", "brief", "catalogues"\?, "render"\? \}/],
      [[], /"design" is \{/],
      [{ brief: 'b.md' }, /"design\.tokens" is a repository path to a file/],
      [{ tokens: 't.css', brief: '' }, /"design\.brief" is a repository path to a file: an empty path/],
      [{ tokens: '../t.css', brief: 'b.md' }, /"design\.tokens" is a repository path to a file: .*"\.\."/],
      [{ tokens: 'design/', brief: 'b.md' }, /"design\.tokens" is a repository path to a file/],
      [{ tokens: 't.css', brief: 'b.md', theme: 'x' }, /unknown key "design\.theme"/],
      [{ ...full, catalogues: {} }, /"design\.catalogues" is a list of \{ "name", "open" \}/],
      [{ ...full, catalogues: [{ name: 'Icons', open: 'x/{entry}' }] }, /entry 0: "name" "Icons" is not kebab-case/],
      [{ ...full, catalogues: [{ name: 'icons', open: 'https://example.invalid/icons' }] }, /entry 0: "open" is a URL template holding \{entry\}/],
      [{ ...full, catalogues: [full.catalogues[0], full.catalogues[0]] }, /"icons" appears twice/],
      [{ ...full, render: '' }, /"design\.render" is a command/],
      [{ ...full, render: ['npm'] }, /"design\.render" is a command/],
    ]) {
      assert.throws(() => load(design), want, JSON.stringify(design));
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
