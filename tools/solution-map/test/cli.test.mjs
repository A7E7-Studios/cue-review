import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRepos } from '../lib/sources.mjs';
import { parseArgs, DEFAULT_PORT } from '../solution-map.mjs';

test('reads the repositories from the config or the command line', () => {
  const root = path.resolve('/work/notes-app');
  const config = { solutionMap: { repos: [{ id: 'app', path: '.' }, { id: 'api', path: '../notes-api' }] } };
  assert.deepEqual(resolveRepos({ config, root }), [
    { id: 'app', dir: root },
    { id: 'api', dir: path.resolve(root, '../notes-api') },
  ]);
  assert.deepEqual(resolveRepos({ args: ['web=../site'], config, root }), [{ id: 'web', dir: path.resolve('../site') }]);
  assert.throws(() => resolveRepos({ config: {}, root }), /name the repositories/);
  assert.throws(() => resolveRepos({ args: ['App=.'] }), /lowercase/);
  assert.throws(() => resolveRepos({ args: ['app=.', 'app=../x'] }), /given twice/);
  assert.throws(() => resolveRepos({ args: ['app'] }), /<id>=<folder>/);

  assert.deepEqual(parseArgs([]), { repoArgs: [], port: DEFAULT_PORT, pages: null, open: true, help: false, from: null });
  assert.deepEqual(parseArgs(['--repo', 'app=.', '--repo', 'api=../api', '--port', '0', '--pages', 'http://localhost:5173', '--no-open']),
    { repoArgs: ['app=.', 'api=../api'], port: 0, pages: 'http://localhost:5173', open: false, help: false, from: null });
  assert.equal(parseArgs(['--from', 'overview.json']).from, 'overview.json');
  assert.throws(() => parseArgs(['--port', 'x']), /port number/);
  assert.throws(() => parseArgs(['--repo']), /needs a value/);
  assert.throws(() => parseArgs(['--what']), /unknown argument/);
});
