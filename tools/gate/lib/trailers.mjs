// The one commit trailer the gate reads: `Doc-Impact: none; <reason>`.

/**
 * Reads Doc-Impact lines from commits [{ sha, message }], from any line of the message (agents
 * often put it above other trailers). Returns { docImpact: [{ sha, reason, line }], malformed:
 * [{ sha, line, message }] }.
 */
export function readDocImpact(commits) {
  const docImpact = [];
  const malformed = [];
  for (const c of commits) {
    for (const raw of c.message.replace(/\r\n?/g, '\n').split('\n')) {
      const l = raw.trim();
      if (!/^Doc-Impact\s*:/i.test(l)) continue;
      const d = /^Doc-Impact:\s*none\s*(?:;|:|—|–|-{1,2})\s*(\S.*)$/i.exec(l);
      if (d) docImpact.push({ sha: c.sha, reason: d[1].trim(), line: l });
      else malformed.push({ sha: c.sha, line: l, message: 'Doc-Impact reads "Doc-Impact: none; <reason>"' });
    }
  }
  return { docImpact, malformed };
}
