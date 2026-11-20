import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMap } from '../lib/build.mjs';
import { createMapServer, withSection, PAGE_DIR } from '../lib/server.mjs';
import http from 'node:http';
import { reviewCommand, startReview } from '../lib/review.mjs';
import { EventEmitter } from 'node:events';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BOARD = '<!doctype html><html><head><style>body{margin:0}</style></head><body><section id="banner">offline banner<section class="detail">its detail pane</section></section><section id="other">other</section></body></html>';

const SPEC = `---
title: Offline edits
review: unreviewed
code:
  - src/
---
# Offline edits

## Summary

You can keep writing when the connection drops, and a banner says you are offline.

## Looks

- looks/offline-banner.html#banner — The banner after five seconds offline

## Requirements

### Requirement: Edits made offline are kept
When the connection drops, the app SHALL keep every edit, because a user otherwise loses work.

#### Scenario: An edit made offline is kept
- **WHEN** a user edits a note offline
- **THEN** the edit is kept
- **PROOF** test: src/offline.test.js
`;
const FILES = {
  'specs/domains.json': JSON.stringify([{ id: 'editing', title: 'Editing', purpose: 'Writing and changing notes.' }]),
  'specs/systems.json': JSON.stringify([{ id: 'editor', title: 'Editor', purpose: 'The app people write notes in.', paths: ['src/'] }]),
  'specs/editing/offline-edits/spec.md': SPEC,
  'specs/editing/offline-edits/looks/offline-banner.html': BOARD,
  'src/offline.test.js': '// the test\n',
};

/** A bare origin and a clone of it with one commit on main, a notes app's spec in it; returns both folders. */
function repoPair(tmp, name) {
  const origin = path.join(tmp, `${name}.git`);
  const work = path.join(tmp, name);
  fs.mkdirSync(origin);
  g(origin, 'init', '--bare', '-q');
  fs.mkdirSync(work);
  g(work, 'init', '-q');
  for (const [p, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    fs.writeFileSync(path.join(work, p), body);
  }
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'first');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', 'origin', 'HEAD:main');
  g(work, 'fetch', '-q', 'origin');
  return { origin, work };
}

/** A clone pushing a second commit to the origin, as another person would. */
function landElsewhere(tmp, origin) {
  const other = fs.mkdtempSync(path.join(tmp, 'other-'));
  execFileSync('git', ['clone', '-q', origin, other]);
  fs.writeFileSync(path.join(other, 'NEW.md'), 'landed\n');
  g(other, 'add', '.');
  g(other, 'commit', '-q', '-m', 'landed later');
  g(other, 'push', '-q', 'origin', 'HEAD:main');
  return g(other, 'rev-parse', 'HEAD');
}

/** A stand-in for the overview that reports only the commit each repository is at, so a fetch's effect is seen alone. */
const standIn = (version = 3) => (repos) => ({
  version, generatedAt: new Date().toISOString(),
  repos: repos.map((r) => ({ id: r.id, name: r.id, ref: r.ref, commit: g(r.dir, 'rev-parse', r.ref) })),
  domains: [], systems: [], capabilities: [], changes: [], uncovered: [],
});

async function serve(build, more = {}) {
  const s = createMapServer({ build, ...more });
  const port = await s.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return { ...s, port, base, close: () => new Promise((r) => s.server.close(r)) };
}

/** A GET with a `Host` header of our choosing, which `fetch` does not allow. */
const getWithHost = (port, p, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

const withTmp = async (fn) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-map-'));
  try { await fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
};

test('serves the page and the map on 127.0.0.1 only', () => withTmp(async (tmp) => {
  const { work } = repoPair(tmp, 'app');
  const s = await serve(() => buildMap({ repos: [{ id: 'app', dir: work }], overview: standIn() }));
  try {
    assert.equal(s.server.address().address, '127.0.0.1');
    const page = await fetch(`${s.base}/explore/editing/x`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module" src="\/page\/app\.mjs">/);
    const view = await fetch(`${s.base}/page/view.mjs`);
    assert.match(view.headers.get('content-type'), /text\/javascript/);
    const map = await (await fetch(`${s.base}/api/map`)).json();
    assert.equal(map.repos[0].state, 'current');
    assert.equal((await fetch(`${s.base}/page/%2e%2e%2flib%2fserver.mjs`)).status, 404);
    // A name rebound to 127.0.0.1 is not this server's.
    assert.equal(await getWithHost(s.port, '/api/map', `evil.example:${s.port}`), 403);
    assert.equal(await getWithHost(s.port, '/api/map', `localhost:${s.port}`), 200);
    assert.equal(await getWithHost(s.port, '/api/map', `127.0.0.1:${s.port + 1}`), 403);
  } finally { await s.close(); }
}));

test('Refresh fetches again and rebuilds the map', () => withTmp(async (tmp) => {
  const { origin, work } = repoPair(tmp, 'app');
  const first = g(work, 'rev-parse', 'origin/main');
  const s = await serve(() => buildMap({ repos: [{ id: 'app', dir: work }], overview: standIn() }));
  try {
    assert.equal((await (await fetch(`${s.base}/api/map`)).json()).repos[0].commit, first);
    const landed = landElsewhere(tmp, origin);
    assert.equal((await (await fetch(`${s.base}/api/map`)).json()).repos[0].commit, first);
    assert.equal((await fetch(`${s.base}/api/refresh`, { method: 'POST' })).status, 403);
    const after = await (await fetch(`${s.base}/api/refresh`, { method: 'POST', headers: { 'x-solution-map': '1' } })).json();
    assert.equal(after.repos[0].commit, landed);
    // Opening the page asks for the same refresh, so it shows main as it is now.
    assert.match(fs.readFileSync(path.join(PAGE_DIR, 'app.mjs'), 'utf8'), /\nload\('\/api\/refresh', 'POST'\);/);
  } finally { await s.close(); }
}));

test('Start review opens CueReview, and says so when it is missing', async () => {
  // Where CueReview is looked for.
  assert.deepEqual(reviewCommand({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } }),
    { command: 'C:\\Users\\me\\AppData\\Local\\Programs\\CueReview\\cuereview.exe', args: [], check: 'C:\\Users\\me\\AppData\\Local\\Programs\\CueReview\\cuereview.exe' });
  assert.deepEqual(reviewCommand({ platform: 'darwin' }), { command: 'open', args: ['-a', 'CueReview'], check: null });
  assert.deepEqual(reviewCommand({ platform: 'linux' }), { command: 'cuereview', args: [], check: null });
  assert.deepEqual(reviewCommand({ platform: 'win32', config: { solutionMap: { review: { app: 'D:/Tools/cuereview.exe' } } } }).command, 'D:/Tools/cuereview.exe');

  // Starting it: detached, and a missing program said in words.
  const started = [];
  const run = (command, args, opts) => {
    started.push({ command, args, detached: opts.detached });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const cmd = { command: 'C:/CueReview/cuereview.exe', args: [], check: 'C:/CueReview/cuereview.exe' };
  assert.deepEqual(await startReview(cmd, { exists: () => true, run }), { ok: true });
  assert.deepEqual(started, [{ command: 'C:/CueReview/cuereview.exe', args: [], detached: true }]);
  const missing = await startReview(cmd, { exists: () => false, run });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /CueReview isn't at C:\/CueReview\/cuereview\.exe\. Install it, or name it in solutionMap\.review\.app\./);
  const failing = (command) => { const c = new EventEmitter(); queueMicrotask(() => c.emit('error', new Error(`spawn ${command} ENOENT`))); return c; };
  assert.match((await startReview({ command: 'cuereview', args: [], check: null }, { run: failing })).error, /did not start: spawn cuereview ENOENT/);

  // Through the server: only the map's own page may ask.
  let asked = 0;
  const s = await serve(async () => ({ model: {}, dirs: {}, commits: {} }), { review: async () => { asked++; return { ok: true }; } });
  try {
    assert.equal((await fetch(`${s.base}/api/review`, { method: 'POST' })).status, 403);
    assert.equal(asked, 0);
    assert.deepEqual(await (await fetch(`${s.base}/api/review`, { method: 'POST', headers: { 'x-solution-map': '1' } })).json(), { ok: true });
    assert.equal(asked, 1);
  } finally { await s.close(); }
});

test('a board section is served from the board by its id', () => withTmp(async (tmp) => {
  const { work } = repoPair(tmp, 'app');
  // The kit's own overview, version 3, reading the spec above.
  const s = await serve(() => buildMap({ repos: [{ id: 'app', dir: work }] }));
  try {
    const map = await (await fetch(`${s.base}/api/map`)).json();
    const f = map.features['editing/offline-edits'];
    assert.equal(f.review, 'unreviewed');
    assert.deepEqual(map.waiting, ['editing/offline-edits']);
    assert.deepEqual(f.systems.map((x) => x.title), ['Editor']);
    assert.deepEqual(f.tested, [1, 1]);
    assert.deepEqual(f.looks.map((l) => [l.kind, l.src, l.exists]), [['board', '/board/app/specs/editing/offline-edits/looks/offline-banner.html?section=banner', true]]);
    const url = `${s.base}/board/app/specs/editing/offline-edits/looks/offline-banner.html`;
    const r = await fetch(`${url}?section=banner`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /^sandbox;/);
    const html = await r.text();
    // Every other section hides; the chosen one's own nested sections do not.
    assert.ok(html.includes('<style>section:not(#banner):not(#banner section):not(:has(#banner)){display:none!important}</style></head>'));
    assert.match(html, /offline banner<section class="detail">its detail pane<\/section>/);
    assert.equal((await fetch(`${url}?section=nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/board/app/specs/editing/x/looks/missing.html`)).status, 404);
    assert.equal(withSection('<section id="a">', 'a"><script>'), null);
    assert.equal(withSection('<section data-id="a">x</section>', 'a'), null, 'only an id attribute names a section');
  } finally { await s.close(); }
}));

test('a repository that cannot be fetched keeps its last fetch, with a banner', () => withTmp(async (tmp) => {
  const { work } = repoPair(tmp, 'app');
  const commit = g(work, 'rev-parse', 'origin/main');
  g(work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
  const { model } = await buildMap({ repos: [{ id: 'app', dir: work }], overview: standIn() });
  assert.equal(model.repos[0].state, 'stale');
  assert.equal(model.repos[0].commit, commit);
  const b = model.banners.find((x) => x.kind === 'stale');
  assert.equal(b.repo, 'app');
  assert.equal(b.commit, commit);
  assert.ok(b.fetchedAt, 'the time of the last good fetch');
}));

test('a repository that is missing leaves the others, with a banner', () => withTmp(async (tmp) => {
  const { work } = repoPair(tmp, 'app');
  const gone = path.join(tmp, 'notes-api');
  const { model } = await buildMap({ repos: [{ id: 'app', dir: work }, { id: 'api', dir: gone }], overview: standIn() });
  assert.deepEqual(model.repos.map((r) => [r.id, r.state]), [['app', 'current'], ['api', 'missing']]);
  assert.deepEqual(model.banners.filter((b) => b.kind === 'missing'), [{ kind: 'missing', repo: 'api', dir: gone }]);
}));

test('an overview of another version gives a banner, not a page error', () => withTmp(async (tmp) => {
  const { work } = repoPair(tmp, 'app');
  const s = await serve(() => buildMap({ repos: [{ id: 'app', dir: work }], overview: standIn(2) }));
  try {
    const r = await fetch(`${s.base}/api/map`);
    assert.equal(r.status, 200);
    const model = await r.json();
    assert.deepEqual(model.banners, [{ kind: 'version', found: 2, reads: 3 }]);
    assert.equal(model.totals.features, 0);
  } finally { await s.close(); }
}));

test('a saved overview is served without reading a repository', async () => {
  const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/overview-v3.json', import.meta.url), 'utf8'));
  let fetched = 0;
  const fetchRepo = async () => { fetched++; return { state: 'current', fetchedAt: null }; };
  const { model, dirs, commits } = await buildMap({ repos: [], overview: () => sample, fromFile: true, fetchRepo });
  assert.equal(fetched, 0);
  assert.deepEqual([dirs, commits], [{}, {}]);
  assert.equal(model.totals.features, 8);
  const boards = Object.values(model.features).flatMap((f) => f.looks).filter((l) => l.kind === 'board');
  assert.ok(boards.length > 0 && boards.every((l) => l.unserved === true), 'its boards are marked as not served');
  const old = await buildMap({ repos: [], overview: () => ({ ...sample, version: 2 }), fromFile: true });
  assert.deepEqual(old.model.banners, [{ kind: 'version', found: 2, reads: 3 }]);
});
