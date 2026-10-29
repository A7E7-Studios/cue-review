#!/usr/bin/env node
// The deterministic formality gate. Reads the head as git objects only, never as a checkout, so
// CI runs it from main's checkout on pull_request_target with the PR head fetched as data.
//
//   node tools/gate/gate.mjs --local [--report-only] [--pr <n>] [--json-out <file>]
//   node tools/gate/gate.mjs --base <sha> --head <sha> [--pr <n>] [--json-out <file>] [--main <ref>]
//
// Exit: 0 pass (or report-only), 1 fail (protected always fails), 2 usage or setup error.
import fs from 'node:fs';
import { runGate, loadConfig, DEFAULT_CONFIG, Repo, formatSummary } from './lib/index.mjs';
import { readPrBody } from './lib/pr.mjs';

const USAGE = `usage:
  node tools/gate/gate.mjs --local [--base <rev>] [--head <rev>] [options]
  node tools/gate/gate.mjs --base <rev> --head <rev> [options]
options:
  --main <ref>        main (default origin/main); --local without --base judges head from its merge base with it
  --pr <n>            also check PR n's description (from --pr-body, the Actions event, or gh api)
  --pr-body <file>    the PR description, read from a file
  --report-only       print what would fail and exit 0, except protected, which always blocks
                      (in GitHub Actions, config.json reportOnly does the same)
  --json-out <file>   write the JSON report
  --json              print the JSON report instead of the Markdown summary
  --config <file>     another config.json
  --repo <dir>        the repository (default: the one holding the current directory)`;

function parseArgs(argv) {
  const o = { json: false, local: false, reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--base') o.base = val();
    else if (a === '--head') o.head = val();
    else if (a === '--pr') o.pr = val();
    else if (a === '--pr-body') o.prBodyFile = val();
    else if (a === '--main') o.main = val();
    else if (a === '--config') o.config = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '--json-out') o.jsonOut = val();
    else if (a === '--json') o.json = true;
    else if (a === '--local') o.local = true;
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function exit(code, message) {
  if (message) console.error(message);
  process.exit(code);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  exit(2, `gate: ${e.message}\n${USAGE}`);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.pr !== undefined && !/^\d+$/.test(args.pr)) exit(2, `gate: --pr takes a number\n${USAGE}`);
args.main ??= 'origin/main';

let repo;
try {
  repo = Repo.open(args.repo ?? process.cwd());
} catch (e) {
  exit(2, `gate: not in a git repository: ${e.message}`);
}

if (args.local) {
  args.head ??= 'HEAD';
  if (!args.base) {
    const main = repo.resolve(args.main);
    if (!main) exit(2, `gate: ${args.main} does not resolve: git fetch origin main, or pass --base`);
    args.base = main;
  }
}
if (!args.base || !args.head) exit(2, `gate: give --local, or --base and --head\n${USAGE}`);

let config;
try {
  config = loadConfig(args.config ?? DEFAULT_CONFIG);
} catch (e) {
  exit(2, `gate: ${e.message}`);
}
// --local is strict unless asked; CI follows config.json.
// Only a run in GitHub Actions without --local honours config.json's reportOnly; every other run
// is strict unless --report-only, so `--base origin/main --head HEAD` gives an agent the real verdict.
const inCi = process.env.GITHUB_ACTIONS === 'true';
const reportOnly = args.reportOnly || (inCi && !args.local && config.reportOnly);

let prBody = null;
if (args.pr !== undefined) {
  try {
    prBody = readPrBody({ pr: args.pr, file: args.prBodyFile, cwd: repo.dir });
  } catch (e) {
    exit(2, `gate: ${e.message}`);
  }
}

let report;
try {
  report = runGate({ repo, base: args.base, head: args.head, main: args.main, pr: args.pr ?? null, prBody, config, reportOnly });
} catch (e) {
  exit(2, `gate: ${e.message}`);
}

if (args.jsonOut) fs.writeFileSync(args.jsonOut, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : formatSummary(report));
process.exitCode = report.blocking.length ? 1 : 0;
