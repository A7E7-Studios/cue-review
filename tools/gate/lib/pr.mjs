// The PR description: where to read it, and its `## ` sections.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { splitLines, fenceMask } from './markdown.mjs';

/**
 * The body of PR `pr`, from the first source that has it: `file`; the Actions event payload
 * (`GITHUB_EVENT_PATH`) when it is this PR's; else `gh api`. Throws when none answers.
 */
export function readPrBody({ pr, file, eventPath = process.env.GITHUB_EVENT_PATH, cwd, repoSlug = process.env.GITHUB_REPOSITORY } = {}) {
  if (file) return fs.readFileSync(file, 'utf8');
  if (eventPath && fs.existsSync(eventPath)) {
    const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    if (ev.pull_request && Number(ev.pull_request.number) === Number(pr)) return ev.pull_request.body ?? '';
  }
  const r = spawnSync('gh', ['api', `repos/${repoSlug || '{owner}/{repo}'}/pulls/${pr}`, '--jq', '.body // ""'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) throw new Error(`cannot read the body of PR ${pr}: gh is not available (${r.error.message}); pass --pr-body <file>`);
  if (r.status !== 0) throw new Error(`cannot read the body of PR ${pr}: ${String(r.stderr).trim()}`);
  return r.stdout.replace(/\n$/, '');
}

/** The `## ` sections of a Markdown body: Map heading -> content, HTML comments removed, trimmed. */
export function prSections(body) {
  const text = String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const out = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = mask[i] ? null : /^ {0,3}(#{1,2})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
    if (h) {
      cur = h[1].length === 2 ? (h[2] ?? '').trim() : null;
      if (cur !== null && !out.has(cur)) out.set(cur, []);
      continue;
    }
    if (cur !== null) out.get(cur).push(lines[i]);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n').trim()]));
}
