// Parses `git diff -U0` output into the added and removed lines of each file.

/**
 * @returns {Map<string, { added: {n:number,text:string}[], removed: {n:number,text:string}[] }>}
 *   keyed by the head path (the base path for a deleted file). `n` is the head line number for
 *   added lines and the base line number for removed ones.
 */
export function parseUnifiedDiff(text) {
  const files = new Map();
  let cur = null;
  let oldPath = null;
  let oldLine = 0;
  let newLine = 0;
  const entry = (p) => {
    if (!files.has(p)) files.set(p, { added: [], removed: [] });
    return files.get(p);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      oldPath = null;
      continue;
    }
    if (!cur && line.startsWith('--- ')) {
      oldPath = stripPrefix(line.slice(4), 'a/');
      continue;
    }
    if (!cur && line.startsWith('+++ ')) {
      const np = stripPrefix(line.slice(4), 'b/');
      cur = entry(np === null ? oldPath : np);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[3]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) {
      cur.added.push({ n: newLine++, text: line.slice(1).replace(/\r$/, '') });
    } else if (line.startsWith('-')) {
      cur.removed.push({ n: oldLine++, text: line.slice(1).replace(/\r$/, '') });
    }
  }
  return files;
}

function stripPrefix(p, prefix) {
  p = p.replace(/\t.*$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = unquote(p);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function unquote(q) {
  // git C-style quoting; core.quotepath=false leaves only control characters and quotes escaped.
  const bytes = [];
  const s = q.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[++i];
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    if (n in map) bytes.push(map[n]);
    else if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
