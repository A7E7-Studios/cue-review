// Specs, change proposals and PROOF lines: the formats specs/README.md and changes/README.md
// define, read the same way by the gate (which judges them) and the overview (which indexes them).
// Pure functions over text; nothing here touches git or the file system.
import { splitLines, fenceMask, PROOF_LINE } from './markdown.mjs';
import { stripBom } from './git.mjs';

/** A domain, capability, system or change id. */
export const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The owner's verdict on a feature, in its spec's front matter. */
export const REVIEW_STATES = ['unreviewed', 'approved', 'changes-requested'];
export const STEP_KEYWORDS = ['GIVEN', 'WHEN', 'THEN', 'AND'];
/** specs/<domain>/<capability>/spec.md */
export const SPEC_FILE = /^specs\/([^/]+)\/([^/]+)\/spec\.md$/;
/** A board beside a spec: looks/<name>.html inside the capability folder. */
export const BOARD = /^looks\/[A-Za-z0-9][\w.-]*\.html$/;

const SPEC_KEYS = ['title', 'review', 'code'];
const CHANGE_KEYS = ['title', 'capabilities', 'removes'];
const SECTIONS = ['Summary', 'Looks', 'Requirements'];

/** A scenario name lower-cased, every run outside [a-z0-9] one `-`, trimmed of `-`. */
export function scenarioSlug(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** What is wrong with a repo-relative path, or null. A trailing `/` (a folder) is allowed. */
export function pathProblem(p) {
  if (typeof p !== 'string' || p.trim() === '') return 'an empty path';
  if (p !== p.trim()) return `"${p}" has surrounding spaces`;
  if (p.includes('\\')) return `"${p}" uses a backslash; paths use /`;
  if (/^\/|^[A-Za-z]:/.test(p)) return `"${p}" is absolute; paths are relative to the repository root`;
  const segs = p.replace(/\/$/, '').split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return `"${p}" has an empty, "." or ".." segment`;
  return null;
}

function unquote(v) {
  const m = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return m ? m[1] : v;
}

/**
 * The front matter subset: a first line `---`, then `key: value` lines and `key:` lines followed
 * by `  - item` lines, then `---`. Returns { present, data, problems: [{ line, message }], bodyStart }
 * where bodyStart is the index (0-based) of the first line after the block.
 */
export function parseFrontMatter(text) {
  const lines = splitLines(text);
  if (stripBom(lines[0] ?? '').trimEnd() !== '---') {
    return { present: false, data: {}, problems: [{ line: 1, message: 'no front matter: the file starts with a "---" line' }], bodyStart: 0 };
  }
  const data = {};
  const problems = [];
  let list = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    if (l.trimEnd() === '---') return { present: true, data, problems, bodyStart: i + 1 };
    if (l.trim() === '') continue;
    const item = /^\s*-(?:\s+(.*?))?\s*$/.exec(l);
    if (item) {
      if (!list) problems.push({ line: n, message: 'a "- item" line outside a list key' });
      else if (!item[1]) problems.push({ line: n, message: `an empty item in "${list}"` });
      else data[list].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):(?:\s+(.*?))?\s*$/.exec(l);
    if (!kv) {
      problems.push({ line: n, message: `front matter line "${l.trim()}" is not "key: value", "key:" or "  - item"` });
      list = null;
      continue;
    }
    const [, key, value] = kv;
    if (key in data) problems.push({ line: n, message: `front matter key "${key}" appears twice` });
    if (value === undefined || value === '') {
      data[key] = [];
      list = key;
    } else {
      data[key] = unquote(value);
      list = null;
    }
  }
  return { present: true, data, problems: [...problems, { line: 1, message: 'the front matter has no closing "---" line' }], bodyStart: lines.length };
}

function frontMatterKeys(fm, allowed, problems) {
  for (const k of Object.keys(fm.data)) {
    if (!allowed.includes(k)) problems.push({ line: 1, message: `unknown front matter key "${k}" (one of ${allowed.join(', ')})` });
  }
}

function requiredString(fm, key, problems) {
  const v = fm.data[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (fm.present) problems.push({ line: 1, message: v === undefined ? `front matter lacks "${key}"` : `front matter "${key}" must be one non-empty value` });
  return null;
}

function list(fm, key, problems, { required }) {
  const v = fm.data[key];
  if (v === undefined) {
    if (required && fm.present) problems.push({ line: 1, message: `front matter lacks "${key}"` });
    return [];
  }
  if (!Array.isArray(v)) {
    problems.push({ line: 1, message: `front matter "${key}" must be a list of "  - item" lines` });
    return [];
  }
  if (required && v.length === 0) problems.push({ line: 1, message: `front matter "${key}" needs at least one item` });
  return v;
}

/**
 * Parses one PROOF line. Returns { check: 'test', state: 'test', path, selector? }, with `error`
 * when the line breaks the format. A scenario is proven by tests only, so any other check is an
 * error.
 */
export function parseProof(line) {
  const m = /^\s*[-*+]\s+\*\*PROOF\*\*\s*(.*?)\s*$/.exec(line);
  if (!m) return { error: 'not a PROOF line' };
  const kv = /^([a-z][a-z-]*):\s*(.*)$/.exec(m[1]);
  if (!kv) return { error: `a PROOF line reads "test: <path>[::<selector>]", not "${m[1]}"` };
  const [, check, value] = kv;
  if (check !== 'test') return { check, error: `"${check}:": a scenario is proven by tests only, "test: <path>[::<selector>]"; the owner reviews the feature, in its front matter` };
  if (!value) return { check, error: 'test: takes a repository path, optionally ::<selector>' };
  if (value.includes('`')) return { check, error: 'write the test path bare, without backticks' };
  const i = value.indexOf('::');
  const p = (i >= 0 ? value.slice(0, i) : value).trim();
  const selector = i >= 0 ? value.slice(i + 2).trim() : '';
  const bad = pathProblem(p);
  if (bad) return { check, state: 'test', path: p, error: `test: ${bad}` };
  if (i >= 0 && !selector) return { check, state: 'test', path: p, error: 'test: an empty ::selector' };
  return { check, state: 'test', path: p, ...(selector ? { selector } : {}) };
}

/**
 * Parses one Looks line: `- looks/<name>.html#<id> — <caption>` or `- page: <where> — <caption>`.
 * Returns { kind: 'board', board, id, caption } or { kind: 'page', target, caption }, or { error }.
 */
export function parseLook(line) {
  const m = /^\s*[-*+]\s+(.*?)\s*$/.exec(line);
  if (!m) return { error: 'a Looks line is a "- " bullet' };
  const parts = m[1].split(/\s+—\s+/);
  const form = '"- looks/<name>.html#<id> — <caption>" or "- page: <path or URL> — <caption>"';
  if (parts.length < 2) return { error: `a Looks line reads ${form}` };
  const head = parts[0];
  const caption = parts.slice(1).join(' — ').trim();
  if (!caption) return { error: 'a Looks line ends in its caption' };
  const page = /^page:\s*(\S.*)$/.exec(head);
  if (page) return { kind: 'page', target: page[1].trim(), caption };
  const board = /^(looks\/[^\s#]+)#([A-Za-z0-9_-]+)$/.exec(head);
  if (!board) return { error: `a Looks line reads ${form}, not "${head}"` };
  if (!BOARD.test(board[1])) return { error: `${board[1]} is not looks/<name>.html` };
  return { kind: 'board', board: board[1], id: board[2], caption };
}

/** A Markdown table row's cells, trimmed; null for a line that is no row. */
function tableRow(l) {
  const t = l.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Parses a living spec. Returns
 *   { title, review, code, summary, looks: [{ n, ...parseLook }], requirements: [{ name, n, text,
 *     scenarios: [{ name, n, slug, steps: [{ keyword, text, n }], table: { header, rows } | null,
 *     text, proofs: [{ n, raw, ...parseProof }] }] }], problems }
 * where `problems` ([{ line, message }]) lists every break of the format that the text alone shows.
 * Whether `code`, board and `test:` paths exist is the caller's question.
 */
export function parseSpec(text) {
  const lines = splitLines(text);
  const fm = parseFrontMatter(text);
  const problems = [...fm.problems];
  frontMatterKeys(fm, SPEC_KEYS, problems);
  const title = requiredString(fm, 'title', problems);
  const review = requiredString(fm, 'review', problems);
  if (review && !REVIEW_STATES.includes(review)) problems.push({ line: 1, message: `review "${review}" is not ${REVIEW_STATES.join(', ')}` });
  const code = list(fm, 'code', problems, { required: true });
  for (const c of code) {
    const bad = pathProblem(c);
    if (bad) problems.push({ line: 1, message: `code: ${bad}` });
  }
  const mask = fenceMask(lines);
  const h1 = [];
  const sections = [];
  const summary = [];
  const looks = [];
  const requirements = [];
  let where = 'top';
  let req = null;
  let sc = null;
  const stray = {};
  for (let i = fm.bodyStart; i < lines.length; i++) {
    const l = lines[i];
    const n = i + 1;
    const h = mask[i] ? null : /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(l);
    if (h) {
      const level = h[1].length;
      const htext = (h[2] ?? '').replace(/[ \t]+#+$/, '').trim();
      if (level === 1) {
        h1.push({ text: htext, n });
        where = 'top';
        req = sc = null;
      } else if (level === 2) {
        sections.push({ name: htext, n });
        where = SECTIONS.includes(htext) ? htext : 'other';
        if (where === 'other') problems.push({ line: n, message: `"## ${htext}": a spec's sections are ## Summary, ## Looks and ## Requirements` });
        req = sc = null;
      } else if (level === 3) {
        sc = null;
        const r = /^Requirement:\s*(.*)$/.exec(htext);
        if (where !== 'Requirements') {
          problems.push({ line: n, message: `"### ${htext}" outside ## Requirements` });
          req = null;
        } else if (!r || !r[1].trim()) {
          problems.push({ line: n, message: `"### ${htext}" is not "### Requirement: <name>"` });
          req = null;
        } else {
          req = { name: r[1].trim(), n, statement: [], scenarios: [] };
          requirements.push(req);
        }
      } else if (level === 4) {
        const s = /^Scenario:\s*(.*)$/.exec(htext);
        if (!req) {
          problems.push({ line: n, message: `"#### ${htext}" outside a ### Requirement:` });
          sc = null;
        } else if (!s || !s[1].trim()) {
          problems.push({ line: n, message: `"#### ${htext}" is not "#### Scenario: <name>"` });
          sc = null;
        } else {
          sc = { name: s[1].trim(), n, slug: scenarioSlug(s[1].trim()), steps: [], tableLines: [], proofs: [], bad: null };
          req.scenarios.push(sc);
        }
      } else {
        problems.push({ line: n, message: `"${'#'.repeat(level)} ${htext}": a spec's headings stop at #### Scenario:` });
      }
      continue;
    }
    const blank = l.trim() === '';
    const proof = !mask[i] && PROOF_LINE.test(l);
    if (proof && !sc) {
      problems.push({ line: n, message: `a PROOF line outside any #### Scenario: ${l.trim().slice(0, 120)}` });
      continue;
    }
    if (sc) {
      if (blank) continue;
      const badLine = (message) => {
        if (sc.bad) return;
        sc.bad = n;
        problems.push({ line: n, message: `${sc.name}: ${message}` });
      };
      if (proof) {
        sc.proofs.push({ n, raw: l.trim(), ...parseProof(l) });
        continue;
      }
      if (sc.proofs.length) {
        badLine('PROOF lines are the scenario\'s last lines');
        continue;
      }
      const row = mask[i] ? null : tableRow(l);
      if (row) {
        sc.tableLines.push({ n, cells: row });
        continue;
      }
      const step = mask[i] ? null : /^\s*[-*+]\s+\*\*([A-Za-z]+)\*\*\s*(.*?)\s*$/.exec(l);
      if (step && STEP_KEYWORDS.includes(step[1])) {
        if (sc.tableLines.length) badLine('steps come before the table');
        else sc.steps.push({ keyword: step[1], text: step[2], n });
      } else if (step) {
        badLine(`"**${step[1]}**" is not GIVEN, WHEN, THEN, AND or PROOF`);
      } else if (!mask[i] && /^\s{2,}\S/.test(l) && sc.steps.length && !sc.tableLines.length) {
        const last = sc.steps[sc.steps.length - 1];
        last.text = `${last.text} ${l.trim()}`.trim();
      } else {
        badLine('a scenario holds its "- **GIVEN/WHEN/THEN/AND** ..." steps, a table, then its "- **PROOF** ..." lines, each optional');
      }
      continue;
    }
    if (where === 'Summary') summary.push(l);
    else if (where === 'Looks') {
      if (blank) continue;
      if (mask[i]) stray.looks ??= n;
      else looks.push({ n, ...parseLook(l) });
    } else if (where === 'Requirements') {
      if (req) req.statement.push(l);
      else if (!blank) stray.requirements ??= n;
    } else if (where === 'top' && !blank) stray.top ??= n;
  }
  if (stray.top !== undefined) problems.push({ line: stray.top, message: 'text outside ## Summary, ## Looks and ## Requirements' });
  if (stray.requirements !== undefined) problems.push({ line: stray.requirements, message: 'text under ## Requirements before its first ### Requirement:' });
  if (stray.looks !== undefined) problems.push({ line: stray.looks, message: '## Looks holds only its Looks lines' });
  for (const lk of looks) if (lk.error) problems.push({ line: lk.n, message: `Looks: ${lk.error}` });

  if (h1.length !== 1) problems.push({ line: h1[1]?.n ?? fm.bodyStart + 1, message: `a spec has one "# <title>" heading, not ${h1.length}` });
  else if (title && h1[0].text !== title) problems.push({ line: h1[0].n, message: `"# ${h1[0].text}" differs from the front matter title "${title}"` });
  const named = (name) => sections.filter((s) => s.name === name);
  for (const name of SECTIONS) {
    const s = named(name);
    const want = name === 'Looks' ? s.length <= 1 : s.length === 1;
    if (!want) problems.push({ line: s[1]?.n ?? 1, message: name === 'Looks' ? `a spec has at most one "## Looks", not ${s.length}` : `a spec has one "## ${name}", not ${s.length}` });
  }
  const order = sections.filter((s) => SECTIONS.includes(s.name));
  for (let k = 1; k < order.length; k++) {
    if (SECTIONS.indexOf(order[k].name) < SECTIONS.indexOf(order[k - 1].name)) {
      problems.push({ line: order[k].n, message: `## ${order[k].name} comes after ## ${order[k - 1].name}: the order is ${SECTIONS.join(', ')}` });
    }
  }
  const summaryText = paragraphs(summary);
  if (named('Summary').length && !summaryText) problems.push({ line: named('Summary')[0].n, message: '## Summary is empty' });
  if (named('Looks').length && looks.length === 0) problems.push({ line: named('Looks')[0].n, message: '## Looks lists nothing; a feature with no visual side has no ## Looks' });
  if (named('Requirements').length && requirements.length === 0) problems.push({ line: named('Requirements')[0].n, message: '## Requirements holds no ### Requirement:' });

  const reqNames = new Map();
  const slugs = new Map();
  const out = [];
  for (const r of requirements) {
    if (reqNames.has(r.name)) problems.push({ line: r.n, message: `requirement "${r.name}" appears twice` });
    reqNames.set(r.name, r.n);
    const statement = paragraphs(r.statement);
    if (!statement) problems.push({ line: r.n, message: `${r.name}: a requirement opens with its statement` });
    else if (statement.includes('\n\n')) problems.push({ line: r.n, message: `${r.name}: the statement is one paragraph, its reason in the same sentence` });
    else if (!/\bSHALL\b/.test(statement) || !/\bbecause\b/.test(statement)) {
      problems.push({ line: r.n, message: `${r.name}: the statement reads "When …, the app SHALL …, because …": it holds SHALL and its reason` });
    }
    if (r.scenarios.length === 0) problems.push({ line: r.n, message: `${r.name}: a requirement has at least one #### Scenario:` });
    const scenarios = [];
    for (const s of r.scenarios) {
      if (!s.slug) problems.push({ line: s.n, message: `scenario "${s.name}" has no letters or digits for its slug` });
      else if (slugs.has(s.slug)) problems.push({ line: s.n, message: `scenario "${s.name}" has the slug "${s.slug}" of the scenario at line ${slugs.get(s.slug)}` });
      else slugs.set(s.slug, s.n);
      stepProblems(s, problems);
      const table = tableOf(s, problems);
      for (const p of s.proofs) if (p.error) problems.push({ line: p.n, message: `${s.name}: ${p.error}` });
      scenarios.push({ name: s.name, n: s.n, slug: s.slug, steps: s.steps, table, text: scenarioText({ steps: s.steps, table }), proofs: s.proofs });
    }
    out.push({ name: r.name, n: r.n, text: statement, scenarios });
  }
  return { title, review, code, summary: summaryText, looks, requirements: out, problems: problems.sort((a, b) => a.line - b.line) };
}

/** Steps are optional; given any, at most one GIVEN first, then one WHEN, then one THEN, AND after any. */
function stepProblems(s, problems) {
  if (!s.steps.length) return;
  const count = (k) => s.steps.filter((st) => st.keyword === k).length;
  if (count('WHEN') !== 1 || count('THEN') !== 1) {
    problems.push({ line: s.n, message: `${s.name}: steps hold one **WHEN** and one **THEN** (they have ${count('WHEN')} and ${count('THEN')})` });
    return;
  }
  if (count('GIVEN') > 1) problems.push({ line: s.n, message: `${s.name}: at most one **GIVEN**` });
  const firstOf = (k) => s.steps.findIndex((st) => st.keyword === k);
  if (s.steps[0].keyword === 'AND') problems.push({ line: s.steps[0].n, message: `${s.name}: **AND** follows another step` });
  if (count('GIVEN') && firstOf('GIVEN') !== 0) problems.push({ line: s.steps[firstOf('GIVEN')].n, message: `${s.name}: **GIVEN** comes first` });
  if (firstOf('THEN') < firstOf('WHEN')) problems.push({ line: s.steps[firstOf('THEN')].n, message: `${s.name}: **WHEN** comes before **THEN**` });
}

/** A scenario's table: a header row, a |---| row and at least one row, all of the header's width. */
function tableOf(s, problems) {
  const t = s.tableLines;
  if (!t.length) return null;
  const sep = t[1] && t[1].cells.every((c) => /^:?-{3,}:?$/.test(c));
  if (!sep || t.length < 3) {
    problems.push({ line: t[0].n, message: `${s.name}: a table has a header row, a |---| row and one row per case` });
    return null;
  }
  const width = t[0].cells.length;
  for (const r of t.slice(1)) {
    if (r.cells.length !== width) problems.push({ line: r.n, message: `${s.name}: a table row has ${r.cells.length} cells, the header ${width}` });
  }
  return { header: t[0].cells, rows: t.slice(2).map((r) => r.cells) };
}

/** Lines as paragraphs: each paragraph's lines joined by one space, paragraphs by a blank line. */
export function paragraphs(lines) {
  const out = [];
  let cur = [];
  for (const l of lines) {
    if (l.trim() === '') {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
    } else cur.push(l.trim());
  }
  if (cur.length) out.push(cur.join(' '));
  return out.join('\n\n');
}

/** A `<domain>/<capability>` id, both kebab-case. */
export function isCapabilityId(c) {
  const m = /^([^/]+)\/([^/]+)$/.exec(c);
  return Boolean(m && ID.test(m[1]) && ID.test(m[2]));
}

/**
 * Parses a change's proposal.md front matter. Returns { title, capabilities, removes, problems }.
 * `capabilities` is a required key that may be empty only when `removes` (the capabilities this
 * change deletes) has an item. Whether each id exists is the caller's question.
 */
export function parseChange(text) {
  const fm = parseFrontMatter(text);
  const problems = [...fm.problems];
  frontMatterKeys(fm, CHANGE_KEYS, problems);
  const title = requiredString(fm, 'title', problems);
  const capabilities = list(fm, 'capabilities', problems, { required: false });
  if (fm.present && fm.data.capabilities === undefined) problems.push({ line: 1, message: 'front matter lacks "capabilities"' });
  const removes = list(fm, 'removes', problems, { required: false });
  if (fm.present && capabilities.length === 0 && removes.length === 0) {
    problems.push({ line: 1, message: 'front matter names no capability: "capabilities" or "removes" needs at least one item' });
  }
  for (const [key, ids] of [
    ['capability', capabilities],
    ['removed capability', removes],
  ]) {
    for (const c of ids) if (!isCapabilityId(c)) problems.push({ line: 1, message: `${key} "${c}" is not "<domain>/<capability>" in kebab-case` });
  }
  return { title, capabilities, removes, problems };
}

/**
 * A spec's text as one comparable string: title, Summary, Looks lines, requirement names and
 * statements, scenario names, steps and tables, whitespace collapsed. PROOF lines, `code` and
 * `review` are left out, so a PR that changes only those does not change it. Boards are files of
 * their own; the caller compares them.
 */
export function requirementText(parsed) {
  const c = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return JSON.stringify({
    title: c(parsed.title),
    summary: c(parsed.summary),
    looks: (parsed.looks ?? []).map((l) => (l.error ? null : l.kind === 'board' ? [l.board, l.id, c(l.caption)] : [l.target, c(l.caption)])),
    requirements: parsed.requirements.map((r) => ({
      name: c(r.name),
      text: c(r.text),
      scenarios: r.scenarios.map((s) => ({ name: c(s.name), text: scenarioText(s) })),
    })),
  });
}

/** A scenario's identity within its spec: its requirement's name and its own. */
export function scenarioKey(requirement, scenario) {
  return `${requirement.name}\u0000${scenario.name}`;
}

/** A scenario's text for comparison: its steps and table, whitespace collapsed (its name is in its key); PROOF lines excluded. */
export function scenarioText(scenario) {
  const c = (s) => String(s).replace(/\s+/g, ' ').trim();
  const steps = scenario.steps.map((st) => `${st.keyword} ${c(st.text)}`);
  const table = scenario.table ? [scenario.table.header, ...scenario.table.rows].map((r) => `| ${r.map(c).join(' | ')} |`) : [];
  return [...steps, ...table].join('\n');
}

/** Whether a scenario has a well-formed test: PROOF line. */
export function isTested(scenario) {
  return scenario.proofs.some((p) => p.state === 'test' && !p.error);
}

/**
 * A feature's review state across the repositories that carry it: `changes-requested` if any side
 * says so, else `unreviewed` if any side is unreviewed or does not read, else `approved`.
 */
export function reviewState(sides) {
  if (sides.some((r) => r === 'changes-requested')) return 'changes-requested';
  if (!sides.length || sides.some((r) => r !== 'approved')) return 'unreviewed';
  return 'approved';
}
