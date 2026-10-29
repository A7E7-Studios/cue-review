// Specs, change proposals and PROOF lines: the formats specs/README.md and changes/README.md
// define, read the same way by the gate (which judges them) and the overview (which indexes them).
// Pure functions over text; nothing here touches git or the file system.
import { splitLines, fenceMask, PROOF_LINE } from './markdown.mjs';
import { stripBom } from './git.mjs';

/** A domain, capability or change id. */
export const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** How a person checks a scenario. `test:` lines are the automated kind. */
export const HUMAN_CHECKS = ['desk', 'headset', 'two-headsets', 'printed-card', 'live-tenant'];
export const REVIEW_STATES = ['unreviewed', 'changes-requested'];
export const STEP_KEYWORDS = ['GIVEN', 'WHEN', 'THEN', 'AND'];
/** specs/<domain>/<capability>/spec.md */
export const SPEC_FILE = /^specs\/([^/]+)\/([^/]+)\/spec\.md$/;

const SPEC_KEYS = ['title', 'code'];
const CHANGE_KEYS = ['title', 'capabilities', 'removes', 'review', 'follow-ups'];

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

function validDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
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
 * Parses one PROOF line. Returns { check, state, path?, selector?, date?, build?, by?, note? }, with
 * `error` when the line breaks the format. state is 'test', 'open', 'pass' or 'fail'.
 */
export function parseProof(line) {
  const m = /^\s*[-*+]\s+\*\*PROOF\*\*\s*(.*?)\s*$/.exec(line);
  if (!m) return { error: 'not a PROOF line' };
  const kv = /^([a-z][a-z-]*):\s*(.*)$/.exec(m[1]);
  if (!kv) return { error: `a PROOF line reads "<check>: <value>", not "${m[1]}"` };
  const [, check, value] = kv;
  if (check === 'test') {
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
  if (!HUMAN_CHECKS.includes(check)) return { check, error: `unknown check "${check}" (test, ${HUMAN_CHECKS.join(', ')})` };
  if (value === 'open') return { check, state: 'open' };
  const r = /^(pass|fail) (\d{4}-\d{2}-\d{2}), build ([^,;]+), by ([^,;]+?)(?:;\s*(.*))?$/.exec(value);
  if (!r) {
    return {
      check,
      error: `"${check}:" takes "open", "pass <YYYY-MM-DD>, build <version>, by <who>[; <note>]" or "fail <YYYY-MM-DD>, build <version>, by <who>; <note>"`,
    };
  }
  const [, state, date, build, by, note] = r;
  if (!validDate(date)) return { check, state, error: `${date} is not a calendar date` };
  if (!build.trim() || !by.trim()) return { check, state, error: 'build and by are not empty' };
  if (state === 'fail' && !note?.trim()) return { check, state, error: 'a fail says what failed: "fail <date>, build <version>, by <who>; <note>"' };
  return { check, state, date, build: build.trim(), by: by.trim(), ...(note?.trim() ? { note: note.trim() } : {}) };
}

/**
 * Parses a living spec. Returns
 *   { title, code, purpose, requirements: [{ name, n, text, scenarios: [{ name, n, slug, steps:
 *     [{ keyword, text, n }], text, proofs: [{ n, raw, ...parseProof }] }] }], problems }
 * where `problems` ([{ line, message }]) lists every break of the format that the text alone shows.
 * Whether `code` and `test:` paths exist is the caller's question.
 */
export function parseSpec(text) {
  const lines = splitLines(text);
  const fm = parseFrontMatter(text);
  const problems = [...fm.problems];
  frontMatterKeys(fm, SPEC_KEYS, problems);
  const title = requiredString(fm, 'title', problems);
  const code = list(fm, 'code', problems, { required: true });
  for (const c of code) {
    const bad = pathProblem(c);
    if (bad) problems.push({ line: 1, message: `code: ${bad}` });
  }
  const mask = fenceMask(lines);
  const h1 = [];
  const sections = [];
  const purpose = [];
  const requirements = [];
  let where = 'top';
  let req = null;
  let sc = null;
  let strayRequirements = null;
  let strayTop = null;
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
        where = htext === 'Purpose' ? 'purpose' : htext === 'Requirements' ? 'requirements' : 'other';
        if (where === 'other') problems.push({ line: n, message: `"## ${htext}": a spec has two sections, ## Purpose and ## Requirements` });
        req = sc = null;
      } else if (level === 3) {
        sc = null;
        const r = /^Requirement:\s*(.*)$/.exec(htext);
        if (where !== 'requirements') {
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
          sc = { name: s[1].trim(), n, slug: scenarioSlug(s[1].trim()), steps: [], proofs: [], bad: null };
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
      if (proof) {
        sc.proofs.push({ n, raw: l.trim(), ...parseProof(l) });
        continue;
      }
      const step = mask[i] ? null : /^\s*[-*+]\s+\*\*([A-Za-z]+)\*\*\s*(.*?)\s*$/.exec(l);
      if (step && STEP_KEYWORDS.includes(step[1])) {
        if (sc.proofs.length) problems.push({ line: n, message: `${sc.name}: PROOF lines are the scenario's last bullets` });
        sc.steps.push({ keyword: step[1], text: step[2], n });
      } else if (step) {
        problems.push({ line: n, message: `${sc.name}: "**${step[1]}**" is not GIVEN, WHEN, THEN, AND or PROOF` });
      } else if (!mask[i] && /^\s{2,}\S/.test(l) && sc.steps.length && !sc.proofs.length) {
        const last = sc.steps[sc.steps.length - 1];
        last.text = `${last.text} ${l.trim()}`.trim();
      } else if (!sc.bad) {
        sc.bad = n;
        problems.push({ line: n, message: `${sc.name}: a scenario holds only "- **GIVEN/WHEN/THEN/AND** ..." bullets, then its "- **PROOF** ..." lines` });
      }
      continue;
    }
    if (where === 'purpose') purpose.push(l);
    else if (where === 'requirements') {
      if (req) req.statement.push(l);
      else if (!blank && strayRequirements === null) strayRequirements = n;
    } else if (where === 'top' && !blank && strayTop === null) strayTop = n;
  }
  if (strayTop !== null) problems.push({ line: strayTop, message: 'text outside ## Purpose and ## Requirements' });
  if (strayRequirements !== null) problems.push({ line: strayRequirements, message: 'text under ## Requirements before its first ### Requirement:' });

  if (h1.length !== 1) problems.push({ line: h1[1]?.n ?? fm.bodyStart + 1, message: `a spec has one "# <title>" heading, not ${h1.length}` });
  else if (title && h1[0].text !== title) problems.push({ line: h1[0].n, message: `"# ${h1[0].text}" differs from the front matter title "${title}"` });
  const named = (name) => sections.filter((s) => s.name === name);
  for (const name of ['Purpose', 'Requirements']) {
    const s = named(name);
    if (s.length !== 1) problems.push({ line: s[1]?.n ?? 1, message: `a spec has one "## ${name}", not ${s.length}` });
  }
  if (named('Purpose')[0] && named('Requirements')[0] && named('Purpose')[0].n > named('Requirements')[0].n) {
    problems.push({ line: named('Purpose')[0].n, message: '## Purpose comes before ## Requirements' });
  }
  const purposeText = paragraphs(purpose);
  if (named('Purpose').length && !purposeText) problems.push({ line: named('Purpose')[0].n, message: '## Purpose is empty' });
  if (named('Requirements').length && requirements.length === 0) problems.push({ line: named('Requirements')[0].n, message: '## Requirements holds no ### Requirement:' });

  const reqNames = new Map();
  const slugs = new Map();
  const out = [];
  for (const r of requirements) {
    if (reqNames.has(r.name)) problems.push({ line: r.n, message: `requirement "${r.name}" appears twice` });
    reqNames.set(r.name, r.n);
    const statement = paragraphs(r.statement);
    if (!statement) problems.push({ line: r.n, message: `${r.name}: a requirement opens with its statement` });
    if (r.scenarios.length === 0) problems.push({ line: r.n, message: `${r.name}: a requirement has at least one #### Scenario:` });
    const scenarios = [];
    for (const s of r.scenarios) {
      if (!s.slug) problems.push({ line: s.n, message: `scenario "${s.name}" has no letters or digits for its slug` });
      else if (slugs.has(s.slug)) problems.push({ line: s.n, message: `scenario "${s.name}" has the slug "${s.slug}" of the scenario at line ${slugs.get(s.slug)}` });
      else slugs.set(s.slug, s.n);
      for (const k of ['WHEN', 'THEN']) {
        if (!s.steps.some((st) => st.keyword === k)) problems.push({ line: s.n, message: `${s.name}: a scenario has a **${k}** bullet` });
      }
      if (s.proofs.length === 0) problems.push({ line: s.n, message: `${s.name}: a scenario ends in at least one - **PROOF** line` });
      const seen = new Map();
      for (const p of s.proofs) {
        if (p.error) problems.push({ line: p.n, message: `${s.name}: ${p.error}` });
        else if (p.check !== 'test') {
          if (seen.has(p.check)) problems.push({ line: p.n, message: `${s.name}: a second "${p.check}:" line; each check at most once per scenario` });
          seen.set(p.check, p.n);
        }
      }
      scenarios.push({
        name: s.name,
        n: s.n,
        slug: s.slug,
        steps: s.steps,
        text: s.steps.map((st) => `${st.keyword} ${st.text}`).join('\n'),
        proofs: s.proofs,
      });
    }
    out.push({ name: r.name, n: r.n, text: statement, scenarios });
  }
  return { title, code, purpose: purposeText, requirements: out, problems: problems.sort((a, b) => a.line - b.line) };
}

/** Lines as paragraphs: each paragraph's lines joined by one space, paragraphs by a blank line. */
function paragraphs(lines) {
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
 * Parses a change's proposal.md front matter. Returns { title, capabilities, removes, review,
 * followUps, problems }. `capabilities` is a required key that may be empty only when `removes`
 * (the capabilities this change deletes) has an item. Whether each id exists is the caller's
 * question.
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
  const review = requiredString(fm, 'review', problems);
  if (review && !REVIEW_STATES.includes(review)) problems.push({ line: 1, message: `review "${review}" is not ${REVIEW_STATES.join(' or ')}` });
  const followUps = list(fm, 'follow-ups', problems, { required: false });
  for (const f of followUps) if (!ID.test(f)) problems.push({ line: 1, message: `follow-up "${f}" is not a kebab-case change id` });
  return { title, capabilities, removes, review, followUps, problems };
}

/**
 * A spec's requirement text as one comparable string: title, purpose, requirement names and
 * statements, scenario names and steps, whitespace collapsed. PROOF lines and `code` are left
 * out, so a PR that changes only those does not change it.
 */
export function requirementText(parsed) {
  const c = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return JSON.stringify({
    title: c(parsed.title),
    purpose: c(parsed.purpose),
    requirements: parsed.requirements.map((r) => ({
      name: c(r.name),
      text: c(r.text),
      scenarios: r.scenarios.map((s) => ({ name: c(s.name), steps: s.steps.map((st) => `${st.keyword} ${c(st.text)}`) })),
    })),
  });
}

/** A scenario's identity within its spec: its requirement's name and its own. */
export function scenarioKey(requirement, scenario) {
  return `${requirement.name}\u0000${scenario.name}`;
}

/** A scenario's text for comparison: its steps, whitespace collapsed (its name is in its key); PROOF lines excluded. */
export function scenarioText(scenario) {
  return scenario.steps.map((st) => `${st.keyword} ${String(st.text).replace(/\s+/g, ' ').trim()}`).join('\n');
}

/**
 * The derived human state of a scenario from its parsed PROOF lines: `failing` if any check is
 * fail; else `open` if any is open; else `approved` if it has a human check (all pass); else
 * `automated`. A PROOF line other than `test:` that breaks the format (an unknown check, `open.`,
 * an impossible date, a fail without its note) counts as open: it never makes a scenario approved
 * or automated.
 */
export function humanState(proofs) {
  const human = proofs.filter((p) => p.check !== 'test');
  if (human.some((p) => !p.error && p.state === 'fail')) return 'failing';
  if (human.some((p) => p.error || p.state === 'open')) return 'open';
  if (human.length) return 'approved';
  return 'automated';
}

/**
 * A capability's state from its scenarios' human states, whether a pending change names it, and
 * whether a spec of it breaks the format: `failing` if any scenario fails; else `unreviewed` if a
 * change is pending, any scenario is open or a spec breaks the format; else `approved` if any
 * scenario is approved; else `automated`.
 */
export function capabilityState(scenarioStates, pending, broken = false) {
  if (scenarioStates.includes('failing')) return 'failing';
  if (pending || broken || scenarioStates.includes('open')) return 'unreviewed';
  if (scenarioStates.includes('approved')) return 'approved';
  return 'automated';
}
