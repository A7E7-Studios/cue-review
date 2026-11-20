// The readable summary: Markdown that reads the same in a terminal and in $GITHUB_STEP_SUMMARY.

const MARK = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
const MAX_LINES = 30;

const sha = (s) => (s ? s.slice(0, 9) : '?');
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function where(f) {
  if (!f.file) return '';
  return `\`${f.file}${f.line ? `:${f.line}` : ''}\` `;
}

export function formatSummary(r) {
  const out = [];
  const blocking = r.blocking ?? (r.reportOnly ? [] : r.wouldFail);
  const reported = r.wouldFail.filter((id) => !blocking.includes(id));
  let verdict = 'PASS';
  if (blocking.length) verdict = `FAIL (${blocking.join(', ')})${reported.length ? ` · would also fail (${reported.join(', ')}), report-only` : ''}`;
  else if (r.conclusion === 'fail') verdict = `WOULD FAIL (${r.wouldFail.join(', ')}) · report-only, exits 0`;
  else if (r.reportOnly) verdict = 'PASS · report-only';
  out.push(`## gate: ${verdict}`);
  out.push('');
  out.push(
    `${r.pr ? `PR #${r.pr} · ` : ''}base \`${sha(r.base)}\` · head \`${sha(r.head)}\` · merge base \`${sha(r.mergeBase)}\` · ` +
      `${r.changedFiles} changed file(s)`,
  );
  for (const n of r.notes ?? []) out.push(`> ${n}`);
  out.push('');
  out.push('| Check | Result | Summary |');
  out.push('|---|---|---|');
  for (const c of r.checks) out.push(`| ${esc(c.id)} | ${MARK[c.status] ?? c.status} | ${esc(c.summary)} |`);
  const failing = r.checks.filter((c) => c.status === 'fail');
  if (failing.length) {
    out.push('', blocking.length ? '### What fails' : '### What would fail');
    for (const c of failing) {
      const fs = c.findings.filter((f) => f.level === 'fail');
      out.push('', `**${c.id}** (${fs.length})${blocking.length && !blocking.includes(c.id) ? ' · report-only' : ''}`);
      for (const f of fs) out.push(`- ${where(f)}${esc(f.message)}`);
    }
  }
  // Notices (a review value this PR sets) lead, so a reviewer sees them first.
  const infos = r.checks.flatMap((c) => c.findings.filter((f) => f.level === 'info').map((f) => ({ ...f, check: c.id })));
  infos.sort((a, b) => Number(Boolean(b.notice)) - Number(Boolean(a.notice)));
  if (infos.length) {
    out.push('', '### Information');
    for (const f of infos.slice(0, MAX_LINES)) out.push(`- ${f.check}: ${where(f)}${esc(f.message)}`);
    if (infos.length > MAX_LINES) out.push(`- … and ${infos.length - MAX_LINES} more information line(s)`);
  }
  return out.join('\n') + '\n';
}
