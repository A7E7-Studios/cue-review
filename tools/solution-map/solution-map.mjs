#!/usr/bin/env node
// The Solution map's command line: name the repositories, build the map, serve it on 127.0.0.1
// and open it in the browser.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRepos, readConfig, git } from './lib/sources.mjs';
import { buildMap } from './lib/build.mjs';
import { createMapServer } from './lib/server.mjs';
import { reviewCommand, startReview } from './lib/review.mjs';

export const DEFAULT_PORT = 7317;
const USAGE = `usage: node tools/solution-map/solution-map.mjs [--repo <id>=<folder>]... [--port <n>] [--pages <address>] [--no-open]
       node tools/solution-map/solution-map.mjs --from <overview.json> [--port <n>] [--no-open]
  without --repo, the repositories are tools/gate/config.json's solutionMap.repos;
  --from serves a saved overview instead of fetching and building one`;

/** The parsed command line: `{ repoArgs, port, pages, open }`; throws on a bad argument. */
export function parseArgs(argv) {
  const o = { repoArgs: [], port: DEFAULT_PORT, pages: null, open: true, help: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--repo') o.repoArgs.push(val());
    else if (a === '--port') {
      o.port = Number(val());
      if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port takes a port number');
    } else if (a === '--pages') o.pages = val();
    else if (a === '--from') o.from = val();
    else if (a === '--no-open') o.open = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

export async function main(argv) {
  let o, repos, root;
  try {
    o = parseArgs(argv);
    if (o.help) { console.log(USAGE); return 0; }
    const top = await git(process.cwd(), ['rev-parse', '--show-toplevel']);
    root = top.ok ? String(top.out).trim() : process.cwd();
    const config = readConfig(root);
    o.config = config;
    o.pages ??= config?.solutionMap?.pages ?? null;
    if (o.from) {
      if (o.repoArgs.length) throw new Error('--from and --repo do not go together');
      const file = path.resolve(o.from);
      JSON.parse(fs.readFileSync(file, 'utf8'));
      repos = [];
      o.build = () => buildMap({ repos: [], pages: o.pages, overview: () => JSON.parse(fs.readFileSync(file, 'utf8')), fromFile: true });
    } else repos = resolveRepos({ args: o.repoArgs, config, root });
  } catch (e) {
    console.error(`solution-map: ${e.message}\n${USAGE}`);
    return 2;
  }
  const reviewCmd = reviewCommand({ config: o.config });
  const { listen, refresh } = createMapServer({
    build: o.build || (() => buildMap({ repos, pages: o.pages })),
    themeFile: path.join(root, 'kit-pages', 'theme.css'),
    review: () => startReview(reviewCmd),
  });
  let port;
  try {
    port = await listen(o.port);
  } catch (e) {
    console.error(`solution-map: cannot listen on 127.0.0.1: ${e.message}`);
    return 2;
  }
  const url = `http://127.0.0.1:${port}/`;
  console.log(`solution-map: ${o.from ? `from ${o.from}` : repos.map((r) => `${r.id}=${r.dir}`).join(', ')}\nsolution-map: ${url}  (Ctrl+C stops it)`);
  refresh().catch((e) => console.error(`solution-map: ${e.message}`));
  if (o.open) openBrowser(url);
  return null;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; });
}
