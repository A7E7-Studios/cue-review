// Small throwaway git repositories and spec texts for the gate's and the overview's tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blobId } from '../lib/kit.mjs';

export const GATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function git(dir, args, input) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', input, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo whose first commit on main holds `files` (null deletes); origin/main points at it. */
export function makeRepo(files = { 'README.md': '# Root\n\nThe root.\n' }, { prefix = 'gate-test-' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of Object.entries({
    'user.name': 'Gate Test',
    'user.email': 'gate@test.invalid',
    'commit.gpgsign': 'false',
    'core.autocrlf': 'false',
    'core.hooksPath': '.no-hooks',
  })) {
    git(dir, ['config', k, v]);
  }
  const r = {
    dir,
    write(map) {
      for (const [p, content] of Object.entries(map)) {
        const f = path.join(dir, ...p.split('/'));
        if (content === null) {
          fs.rmSync(f, { force: true, recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      }
      return r;
    },
    commit(message = 'chore: test') {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
      return git(dir, ['rev-parse', 'HEAD']);
    },
    branch(name, from = 'main') {
      git(dir, ['checkout', '-q', '-B', name, from]);
      return r;
    },
    rev(ref) {
      return git(dir, ['rev-parse', ref]);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  r.write(files);
  r.main = r.commit('chore: initial');
  git(dir, ['update-ref', 'refs/remotes/origin/main', r.main]);
  return r;
}

/** The starter config, config.template.json, as a project copies it. */
export function templateConfig() {
  return JSON.parse(fs.readFileSync(path.join(GATE_DIR, 'config.template.json'), 'utf8'));
}

/**
 * The starter config (config.template.json) with report-only off, and the vendored trees, living
 * docs and budgets the tests write: the same in every repository that carries the gate. Its
 * `design` block is left out, since a test repository holds no house style; a test of the design
 * check passes `design` back in.
 */
export function testConfig(overrides = {}) {
  const { design, ...base } = templateConfig();
  const livingDocs = { include: ['specs/**/*.md', '**/README.md', '**/AGENTS.md', '**/ARCHITECTURE.md'], exclude: ['changes/**'] };
  const budgets = [
    { pattern: 'changes/**/*.md', bytes: 30720 },
    { pattern: 'specs/**/spec.md', bytes: 30720 },
    { pattern: 'specs/**/looks/*.html', bytes: 30720 },
    { pattern: '**/AGENTS.md', bytes: 32768 },
    { pattern: '**/README.md', bytes: 40960 },
  ];
  return { ...base, reportOnly: false, ignore: ['Packages/com.vendor.*/**', 'Packages/com.unity.*/**'], livingDocs, budgets, ...overrides };
}

/** A tools/kit/lock.json for `files` ({ path: content }), as sync writes it. */
export function lockText(files, { paths = ['tools/gate/', 'tools/kit/', 'specs/README.md'], projectOwned = ['tools/gate/config.json', 'tools/kit/lock.json'], commit = 'c'.repeat(40) } = {}) {
  const ids = Object.fromEntries(Object.entries(files).map(([p, content]) => [p, blobId(Buffer.from(content))]));
  return JSON.stringify({ version: 1, kit: { repository: 'https://example.invalid/kit.git', commit }, paths, projectOwned, files: ids }, null, 2) + '\n';
}

export function check(report, id) {
  return report.checks.find((c) => c.id === id);
}

export function fails(report, id) {
  return check(report, id).findings.filter((f) => f.level === 'fail');
}

export function failText(report, id) {
  return fails(report, id).map((f) => `${f.file ?? ''}:${f.line ?? ''} ${f.message}`).join('\n');
}

export function infos(report, id) {
  return check(report, id).findings.filter((f) => f.level === 'info');
}

export const DOMAINS = JSON.stringify(
  [
    ['collaboration', 'Collaboration'],
    ['library', 'Library'],
    ['layout', 'Layout'],
    ['reading', 'Reading'],
    ['search', 'Search'],
    ['account', 'Account'],
    ['tooling', 'Tooling'],
  ].map(([id, title]) => ({ id, title, purpose: `Everything about ${title.toLowerCase()}.` })),
  null,
  2,
);

export const P = (v) => `- **PROOF** ${v}`;

const SCENARIO = {
  name: 'A collaborator edits the same note',
  steps: ['GIVEN two users in one note', 'WHEN one user types in a paragraph', 'THEN the other sees a cursor where they type'],
  proofs: ['test: src/cursors/cursors.test.js'],
};

/**
 * A spec in the contract's format; every part can be replaced. A scenario is { name, steps,
 * table?: [[header cells], [row cells], …], proofs }; `looks` is a list of Looks lines without
 * their "- ".
 */
export function specText({
  title = 'Shared cursors',
  review = 'unreviewed',
  code = ['src/cursors/'],
  summary = 'A cursor shows where each collaborator is typing.',
  looks = null,
  requirements,
  scenarios,
  proofs,
  then,
} = {}) {
  const sc = scenarios ?? [
    {
      ...SCENARIO,
      ...(proofs ? { proofs } : {}),
      ...(then ? { steps: [...SCENARIO.steps.slice(0, 2), `THEN ${then}`] } : {}),
    },
  ];
  const reqs = requirements ?? [
    {
      name: 'Cursors show where others type',
      text: 'When two users edit one note, the app SHALL show a cursor for each collaborator, because a user otherwise types over someone else\'s edit.',
      scenarios: sc,
    },
  ];
  const lines = ['---', `title: ${title}`, `review: ${review}`, 'code:', ...code.map((c) => `  - ${c}`), '---', `# ${title}`, '', '## Summary', '', summary, ''];
  if (looks) lines.push('## Looks', '', ...looks.map((l) => `- ${l}`), '');
  lines.push('## Requirements', '');
  for (const r of reqs) {
    lines.push(`### Requirement: ${r.name}`, r.text, '');
    for (const s of r.scenarios) {
      lines.push(`#### Scenario: ${s.name}`);
      for (const st of s.steps ?? []) {
        const [k, ...rest] = st.split(' ');
        lines.push(`- **${k}** ${rest.join(' ')}`);
      }
      if (s.table) lines.push(`| ${s.table[0].join(' | ')} |`, `|${s.table[0].map(() => '---').join('|')}|`, ...s.table.slice(1).map((r) => `| ${r.join(' | ')} |`));
      lines.push(...(s.proofs ?? []).map(P), '');
    }
  }
  return lines.join('\n');
}

/** A change proposal in the contract's format. */
export function proposalText({ title = 'Cursors for collaborators', capabilities = ['collaboration/shared-cursors'], removes = null } = {}) {
  return [
    '---',
    `title: ${title}`,
    'capabilities:',
    ...capabilities.map((c) => `  - ${c}`),
    ...(removes ? ['removes:', ...removes.map((c) => `  - ${c}`)] : []),
    '---',
    `# ${title}`,
    '',
    '## Why',
    '',
    'Writers type over each other.',
    '',
    '## Review',
    '',
    'At a desk, with a second browser window.',
    '',
  ].join('\n');
}

/** A board: one self-contained HTML file, a <section> per id. */
export function boardText(ids = ['main'], { extra = '' } = {}) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><style>section { padding: 1rem; }</style></head><body>',
    ...ids.map((id) => `<section id="${id}"><p>The design of ${id}.</p></section>`),
    extra,
    '</body></html>',
    '',
  ].join('\n');
}

/** The files of a repo with one valid capability, collaboration/shared-cursors. */
export function baseFiles(extra = {}) {
  return {
    'README.md': '# Root\n\nThe root.\n',
    'specs/domains.json': DOMAINS,
    'src/README.md': '# Source\n\nThe code.\n',
    'src/cursors/cursors.js': 'export const cursors = 1;\n',
    'src/cursors/cursors.test.js': 'test\n',
    'specs/collaboration/shared-cursors/spec.md': specText(),
    ...extra,
  };
}
