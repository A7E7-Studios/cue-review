// Start review: opens CueReview, the kit's review recorder, on this computer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * How CueReview opens here: `{ command, args, check }`, where `check` is the file that must exist
 * first (null when the command is looked up on PATH). `solutionMap.review.app` names the program;
 * otherwise CueReview's default install: `%LOCALAPPDATA%\Programs\CueReview\cuereview.exe` on
 * Windows, the CueReview app on macOS, `cuereview` on PATH on Linux.
 */
export function reviewCommand({ platform = process.platform, env = process.env, config = null } = {}) {
  const app = config?.solutionMap?.review?.app;
  if (app) return { command: app, args: [], check: app };
  if (platform === 'win32') {
    const exe = path.win32.join(env.LOCALAPPDATA || '', 'Programs', 'CueReview', 'cuereview.exe');
    return { command: exe, args: [], check: exe };
  }
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'CueReview'], check: null };
  return { command: 'cuereview', args: [], check: null };
}

/**
 * Opens CueReview, detached, so it outlives the map. Resolves `{ ok: true }`, or `{ ok: false,
 * error }` when the program is not there or does not start.
 */
export function startReview(cmd, { exists = fs.existsSync, run = spawn } = {}) {
  if (cmd.check && !exists(cmd.check)) {
    return Promise.resolve({ ok: false, error: `CueReview isn't at ${cmd.check}. Install it, or name it in solutionMap.review.app.` });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = run(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      resolve({ ok: false, error: `CueReview did not start: ${e.message}` });
      return;
    }
    child.once('error', (e) => resolve({ ok: false, error: `CueReview did not start: ${e.message}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}
