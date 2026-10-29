# Gate

The deterministic formality gate: it checks that a branch keeps the repository's formats (specs,
change folders, living docs, byte budgets, links, the nearest README and the PR description), that
a project's copy of the kit is as its lock says, and that the branch touches nothing only the owner
may merge. It judges form, never whether the code is right; tests and the independent review do
that. The formats it enforces are defined in `specs/README.md` and `changes/README.md`.

No npm dependencies; Node 22 or later; nothing to install.

```
node tools/gate/gate.mjs --local [--pr <n>]                          # this branch, strict
node tools/gate/gate.mjs --base <rev> --head <rev> [--pr <n>]        # CI (.github/workflows/gate.yml)
```

| Option | Does |
|---|---|
| `--local` | head `HEAD`, base `origin/main` (or `--main`, or `--base`); always strict unless `--report-only`; with `--pr <n>` the description is read through `gh api` |
| `--base <rev>`, `--head <rev>` | judge the head's changes since its merge base with the base; CI passes `--base HEAD`, the main it just checked out |
| `--main <ref>` | main, default `origin/main`; CI passes `--main HEAD` |
| `--pr <n>` | also run the `pr` check on PR n's description |
| `--pr-body <file>` | read that description from a file instead |
| `--report-only` | print what would fail and exit 0 (except `protected`, which always blocks) |
| `--json-out <file>`, `--json` | write the JSON report to a file (local use; CI keeps only the summary); print it instead of the summary |
| `--config <file>`, `--repo <dir>` | another config; another repository |

Exit: **0** pass, **1** fail, **2** usage or setup error (an unknown option, a revision that does not
resolve, no merge base, an unreadable config or PR description). In GitHub Actions
(`GITHUB_ACTIONS=true`) and without `--local`, `reportOnly: true` in `config.json` makes a failing
run exit 0 and head its summary `WOULD FAIL`; every other run is strict unless `--report-only`, so
`--base origin/main --head HEAD --pr <n>` gives the same verdict as `--local --pr <n>`. Report-only
never covers [`protected`](#protected-paths): a PR that touches a protected path exits 1 always.

The summary on stdout is Markdown — a verdict line, a table of checks, every failing finding with
`file:line`, then information (each `pass` or `fail` the PR writes first) — so CI appends it to
`$GITHUB_STEP_SUMMARY` unchanged.

## What it reads

The head only as git objects (`git ls-tree`, `git cat-file`, `git diff`, `git log`), never the
working tree, and it runs nothing from the head. In CI the working tree is main's checkout, so the
gate's code and `config.json` are main's and a PR cannot rewrite its own gate. Locally, commit
first: uncommitted edits are not seen.

Every check looks at the PR's changes since the merge base of base and head. Sizes are git blob
sizes, the same on every OS whatever the checkout's line endings.

The PR description comes from `--pr-body`, else from the Actions event payload
(`GITHUB_EVENT_PATH`) when it is the same PR, else from `gh api`.

## Checks

| Check | Fails when |
|---|---|
| `specs` | a capability folder breaks the format: its path (`specs/<domain>/<capability>/spec.md`, both kebab-case, the domain in `specs/domains.json`), its front matter (`title`, `code` with at least one path, no other key), a `code` or `test:` path missing at head (a folder ends `/`, a file does not), one `# <title>` equal to the front matter title, one non-empty `## Purpose` then one `## Requirements`, each `### Requirement:` with a statement and at least one `#### Scenario:`, each scenario only `**GIVEN**`/`**WHEN**`/`**THEN**`/`**AND**` bullets (a `**WHEN**` and a `**THEN**` required) ending in at least one PROOF line, a PROOF line malformed or out of place or a check twice, scenario slugs repeated, a `look/<slug>.png` naming no scenario, a stray file; `specs/domains.json` unreadable; a scenario whose text changed since the merge base (or that is new) carrying `pass` or `fail`; or a changed scenario dropping a human check it had at the merge base (it keeps each, as `open`) |
| `changes` | a `changes/<id>/` with an id that is not kebab-case, no `proposal.md`, front matter that breaks the format (`title`; `capabilities`, `<domain>/<capability>` items each with a spec at head; optional `removes`, the capabilities it deletes, each with no spec at head and one at the merge base, or already removed by a change folder on main; at least one item in the two; `review`, `unreviewed` or `changes-requested`; optional `follow-ups`, change ids; no other key); a file directly in `changes/` other than its README; a PR that changes a spec's requirement text without adding or modifying a change folder whose `capabilities` names the capability; or a PR that deletes a spec without one whose `removes` names it (`removes` answers only for a spec the PR deletes) |
| `history` | an added line of a living doc, outside code fences and inline code, matches a rule in `config.json`: a PR or issue reference, a cross-repo reference (two or more name characters before `#`), an ISO date outside a PROOF line, `used to` (not after `is`, `was`, `be`, `get` and their forms), `(ruled`, work promised for later (`follow-up PR`, `pull request`, `issue`, `ticket`, `task` or `work`; `to be done`, `will be added` or `is planned` + `later`), `TODO`. The workflow's own words — a `follow-up` change, the `follow-ups` field — are not hits. Write a hex colour as inline code: a bare `#333` reads as a PR reference |
| `budgets` | a changed file over its byte budget is new, or grew since the merge base |
| `links` | a relative link or anchor on an added line of a changed `.md` does not resolve at head; or a link anywhere else that resolved at the merge base no longer does, because the PR deleted or renamed a file of any kind or a folder, or changed a doc's headings |
| `readme` | code changed under a folder whose nearest `README.md` did not change, and no commit in range carries `Doc-Impact: none; <reason>`; or a `Doc-Impact` line reads otherwise |
| `pr` | with `--pr` only: the PR changes code and its description lacks a non-empty `## Tests` or `## Review` |
| `kit` | in a project that carries the kit (it has `tools/kit/lock.json`): a file the lock lists is missing or holds other bytes than its git blob id; a file under a path the kit owns is neither in the lock nor one the project owns (`projectOwned`, its `tools/gate/config.json` among them); or the PR deletes the lock. A drift main already had is information for a PR that touches neither a kit file nor the lock (a change to the project's own files touches neither). Skipped where there is no lock, the kit's own repository among them ([tools/kit](../kit/README.md)) |
| `protected` | the PR touches a protected path: **the owner merges this PR; agents never do**. Never report-only; see [Protected paths](#protected-paths) |

Rules the table leaves implicit:

- **Old problems are not this PR's.** A capability folder, change folder, `specs/domains.json` or
  kit copy the PR touches answers for every problem it has. One it does not touch fails only on problems
  it did not have at the merge base — a `code` or `test:` path this PR deleted, a capability a
  pending change names that this PR removed; the rest are listed as information. A PR that writes
  anything under `specs/` answers for `specs/domains.json`.
- **Scenario text** is its step bullets, whitespace collapsed (re-wrapping a bullet changes
  nothing); a scenario is keyed by its requirement's name and its own, so a renamed scenario or
  requirement is new. PROOF lines are not text. A `pass` or `fail` written on an unchanged scenario
  is a notice at the top of the information, naming the scenario, the check and the value.
- **Requirement text** is a spec's title, purpose, requirements and scenarios without PROOF lines
  and without `code`. A PR that changes only PROOF lines, only `code` paths, or only deletes change
  folders needs no change folder. A deleted change folder is not a written one.
- **Code**, for `readme` and `pr`, is any path outside `*.md`, `specs/` and `changes/`, except a
  `.meta` sidecar (as Unity writes) of a Markdown file or of a folder (at head or at the merge base). The nearest
  README is looked up at head, then at the merge base for a deleted folder; when it is the root
  `README.md` the result is information only.
- **Ignored paths** (`config.json` `ignore`: vendored packages and samples) are no check's
  concern in `history`, `budgets`, `links` and `readme`, and the overview lists no module under
  them. `pr` still counts them as code.
- **Budgets** take the first matching pattern, and one with `"bytes": null` leaves its files
  unbudgeted; an over-budget file that did not grow is information.
- **Links**: `http(s):` and other schemes, and paths leaving the repository, are not checked; an
  anchor matches a GitHub heading slug (repeats get `-1`, `-2`) or an HTML `id`/`name`, ignoring
  case. Links already broken at the merge base are counted as information.

## Protected paths

The rules agents work by, the procedures they follow, their permissions and hooks, and the tools
that judge and list their work never change through a PR that merges itself. A PR that touches any
path matching `config.json` `protectedPaths` fails `protected` with "the owner merges this PR;
agents never do", and the ship skill never merges a PR that fails it. The globs match without
regard to case, as a Windows checkout loads `claude.md` for `CLAUDE.md`. Every repository protects
the globs below; one may add its own owner paths to its `config.json`.

| Glob | Covers |
|---|---|
| `tools/gate/**` | this gate: its code and `config.json` |
| `tools/overview/**` | the overview index, which the to-review list is read from |
| `tools/setup-agents/**` | the setup that links the skills and configures the agents |
| `tools/kit/**` | the sync command and the project's lock, which the `kit` check reads |
| `.github/**` | what GitHub reads from the repository: the workflows (`gate.yml` among them), `CODEOWNERS`, templates |
| `CODEOWNERS`, `docs/CODEOWNERS` | the other two places GitHub reads code owners from |
| `**/.agents/skills/**` | the skills, at the root and in any subtree |
| `**/AGENTS.md`, `**/CLAUDE.md`, `**/CLAUDE.local.md` | the agent rules, at the root and in any subtree |
| `**/.claude/**` | agent settings, permissions, hooks and skills, at the root and in any subtree |
| `**/.mcp.json` | the MCP servers an agent is given, at the root and in any subtree |

`protected` is a safety boundary, so `reportOnly` never covers it: while the other checks only
report, a failing `protected` still makes the run exit 1 and heads the summary `FAIL (protected)`.
The JSON report lists what fails the run in `blocking`.

## config.json

| Key | What |
|---|---|
| `reportOnly` | `true`: a run in GitHub Actions prints what would fail and exits 0. `--local` and runs elsewhere ignore it |
| `ignore` | globs of paths that are not ours (vendored packages, samples) |
| `protectedPaths` | globs of the paths only the owner merges ([Protected paths](#protected-paths)) |
| `livingDocs` | `{ include, exclude }`: globs of the living docs, the docs that state what IS and that the history lint reads. Change folders are planning, never living |
| `budgets` | `[{ pattern, bytes }]`: the byte budget of the files a glob matches; the first matching entry wins, and `"bytes": null` means no budget, so a `null` entry placed first exempts what it matches from the entries after it |
| `history` | `[{ id, message, pattern, flags?, skipProofLines? }]`, JavaScript regular expressions |
| `overview.excludeModules` | globs of folders the overview lists no module from (planning and fixture folders); the gate does not read it |
| `overview.moduleMarkers` | file-name globs (no `/`) that make a folder a module in the overview ([its Modules](../overview/README.md#modules)); without the key, its defaults. The gate does not read it |

The values are each repository's own, in its `config.json`. A new project starts from
[`config.template.json`](config.template.json), which the tests read too, so they hold in every
repository whatever its own values.

Globs: `**` spans folders, `*` and `?` stay inside one.

## JSON report

```
{ version: 1, reportOnly, conclusion: "pass" | "fail", wouldFail: [check ids], blocking: [check ids],
  pr, base, head, main, mergeBase, changedFiles, docImpact: [{ sha, reason, line }], notes,
  checks: [{ id, title, status: "pass" | "fail" | "skip", summary,
             findings: [{ level: "fail" | "info", message, file?, line?, notice? }] }] }
```

## Layout

| File | Holds |
|---|---|
| `gate.mjs` | the command line |
| `config.json`, `config.template.json` | this repository's config; the starter a new project copies |
| `lib/index.mjs` | `runGate()`, `loadConfig()` |
| `lib/checks.mjs` | the checks |
| `lib/context.mjs` | revisions, changed paths, the Markdown diff, commits, nearest README |
| `lib/kit.mjs` | the lock: `parseLock`, `blobId`, `kitProblems`; shared with [`tools/kit`](../kit/README.md) |
| `lib/spec.mjs` | `parseSpec`, `parseChange`, `parseProof`, front matter, scenario slugs and the derived states; shared with [`tools/overview`](../overview/README.md) |
| `lib/git.mjs` | reads a repository at a revision through git objects |
| `lib/markdown.mjs` | fences, inline code, heading anchors, links, a document's first heading and paragraph |
| `lib/diff.mjs`, `lib/glob.mjs`, `lib/trailers.mjs`, `lib/pr.mjs`, `lib/report.mjs` | diff parsing, globs, `Doc-Impact`, the PR description, the Markdown summary |

## Tests

```
cd tools/gate && npm test        # node --test; builds throwaway repositories in the OS temp folder
```

Every check has passing and failing cases on small repositories built by `test/helpers.mjs`;
`test/units.test.mjs` covers the parsers.
