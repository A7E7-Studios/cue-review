# Overview

The overview index generator: one JSON document that says what the solution is across
repositories — an app and its backend, say, each carrying this same tool.
It lists every feature (capability) with its review state, its Looks, its requirements, scenarios
and tests, the systems it ships in, the change folders, and the components. A viewer renders it;
this tool only writes the index.

No npm dependencies; Node 22 or later. It reads the spec and change formats through
[`tools/gate/lib/spec.mjs`](../gate/lib/spec.mjs), the same parser the gate judges with.

```
node tools/overview/overview.mjs --repo app=../app --repo backend=../backend \
  [--ref origin/main] [--out overview.json] [--assets <dir>] [--summary]
```

| Option | Does |
|---|---|
| `--repo <id>=<git dir>[@<ref>]` | a repository to read, any number; the id (lowercase, digits, `-`) tags everything from it; the first given wins a shared feature's title and summary and a shared system's title and purpose |
| `--ref <ref>` | the ref of each `--repo` given without `@<ref>`; default `origin/main` |
| `--out <file>` | write the JSON there; without it the JSON goes to stdout, unless `--summary` |
| `--assets <dir>` | copy every board the Looks name, where it exists, into `<dir>/<repo-id>/<path>` |
| `--summary` | print plain text: per domain each feature, its review state, its tested / total scenarios, its systems and repositories; then the features to review (`unreviewed` and `changes-requested`) with the change folders naming them; then the change folders; then the systems with their feature counts, those no feature ships in, and what lies outside every system |

Exit: **0** written, **2** usage or setup error (a ref that does not resolve, a folder that is not a
repository). Fetch first: the tool never fetches.

## What it reads

Each repository at its ref, through git objects only (`git ls-tree`, `git cat-file`, `git log`):
the checkout's branch and working tree never matter and are never written.

| Source | Becomes |
|---|---|
| `specs/domains.json` | `domains`, from the first repository that has it |
| `specs/systems.json` | `systems`, merged by id across repositories, a side per repository with its `paths` |
| `specs/<domain>/<capability>/spec.md` | a feature; one entry per id across repositories, a side per repository |
| `specs/<domain>/<capability>/looks/<name>.html` | a board a Looks line names: its `exists`, and the file `--assets` copies |
| `changes/<id>/` | a change folder, one entry per id across repositories; `proposal.md`'s front matter, its `## Review` section, its files, and `landed`: the newest first-parent commit on the ref that added `proposal.md` (a renamed folder lands with its rename), its date, and the PR number from a subject ending `(#<n>)` |
| a folder holding a component marker (`README.md`, `package.json`, `pyproject.toml`, `build.gradle(.kts)`, a `*.asmdef`) | a component (below) |

A side's `reviewed` is the newest first-parent commit on the ref whose diff adds or removes the
spec's `review:` line, the one that last set the verdict (the commit that added the spec, when
none did since), with its date and PR number as `landed` has them; a feature's `reviewed` is the
newest of its sides'.

## Systems

A path belongs to the nearest system that declares it or a folder above it: of every declared
path that is the path itself or a folder holding it, the deepest wins
([specs/README.md](../../specs/README.md#systems)). A repository's paths are matched only against
its own `specs/systems.json`.

| Of | Systems |
|---|---|
| a feature's side (`systems`) | the systems its `code` paths fall in, sorted |
| a feature (`systems`) | every side's, sorted |
| a system (`capabilities`, `components`) | the features with a code path in it, sorted; the components whose folder lies in it |
| a component (`system`) | the system its folder falls in, or null; the root component (`.`) is in none |

`outside` lists what lies outside every system, only for a repository that declares at least one
system (one without `specs/systems.json`, or with an empty one, declared none and lists nothing
there): `code`, each spec `code` path in no system, and `components`, each component in no system
whose folder holds no declared path. `uncovered` lists the components inside a system that no spec's
`code` path is at, under or above: code that no feature names yet.

## Components

A component is a folder (`.` for the root), not under `node_modules`, that holds a file a
component marker matches. The markers are file-name globs, `tools/gate/config.json`
`overview.componentMarkers`; a repository whose config has no such key gets `README.md`,
`package.json`, `pyproject.toml`, `build.gradle`, `build.gradle.kts` and `*.asmdef` (an empty list
marks no component). A `*.asmdef` marks its folder only when it is not a test assembly: one whose
`name` or folder ends with `Tests` (`PlayTests`, `EditModeTests`, `PlayModeTests` included) or
whose name holds `.Tests`. A component's `README.md` gives its title and summary even where
`README.md` is no marker.

| Field | From |
|---|---|
| `system` | the system its folder falls in (above), or null |
| `readme`, `assembly` | the folder's `README.md` path, its asmdef's `name`; each null when absent |
| `manifest` | the folder's first other marker file, in marker order (`package.json`, `pyproject.toml`, `build.gradle.kts`, or one the config names), or null |
| `package` | the package name a manifest gives: `package.json` `name`, `pyproject.toml` `[project]` (else `[tool.poetry]`) `name`; null otherwise |
| `title` | the README's first heading, else the assembly's name, else the package's name, else the folder's name (the repository id for the root) |
| `summary` | the README's first paragraph as plain text, else the manifest's `description`, else empty; at most 300 characters |
| `capabilities` | every feature with a `code` path whose nearest (deepest) component up its tree is this one; a path ending `/` starts at that folder |

Left out: `specs/`, `changes/`, `.agents/`, `.github/`, and the repository's own
`tools/gate/config.json` globs, `ignore` (vendored packages and samples) and
`overview.excludeComponents` (planning and fixture folders). A repository whose config names no
`overview.excludeComponents` gets `dev/**`, `docs/**`, `**/proof/**`, `fixtures/**`,
`**/test/fixtures/**`. The keys `overview.moduleMarkers` and `overview.excludeModules` are not
read: a config that still names them gets the defaults.

## Derived state

| Of | State |
|---|---|
| a side (`review`) | the spec's `review`, or null when it is missing or not `unreviewed`, `approved` or `changes-requested` |
| a feature (`review`) | `changes-requested` if any side says so; else `unreviewed` if any side is unreviewed or null; else `approved` |
| a scenario (`tested`) | it has a well-formed `test:` PROOF line; one whose path is missing at the ref still counts, with `exists: false` |

A malformed PROOF line is listed with `state: "invalid"`, the word before its colon as `check`,
and its `error`. A side's `problems` lists each break of the spec format as `{ line, message }`.
A Looks line that breaks the format is left out of `looks` and listed in `problems`.

## Output

[`overview.schema.json`](overview.schema.json) (JSON Schema 2020-12) describes version 3:

```
{ version: 3, generatedAt, assetsDir,
  repos:        [{ id, name, ref, commit }],
  domains:      [{ id, title, purpose }],
  systems:      [{ id, title, purpose, sides: [{ repo, paths }], capabilities, components: [{ repo, path }] }],
  capabilities: [{ id, domain, title, summary, review, reviewed: { commit, date, pr } | null, systems,
                   sides: [{ repo, spec, review, reviewed, code, systems, components, problems: [{ line, message }] }],
                   looks: [{ repo, kind: "board", path, id, caption, exists, asset }
                         | { repo, kind: "page", target, caption }],
                   requirements: [{ repo, name, text,
                     scenarios: [{ name, slug, text, table: { header, rows } | null,
                                   proofs: [{ check: "test", state: "test", path, selector?, exists }
                                          | { check, state: "invalid", path?, error }],
                                   tested }] }],
                   pendingChanges }],
  changes:      [{ id, title, sides: [{ repo, path, capabilities, removes, review, files,
                                        landed: { commit, date, pr } | null }] }],
  components:   [{ repo, path, system, readme, assembly, package, manifest, title, summary, capabilities }],
  outside:      { components: [{ repo, path }], code: [{ repo, capability, path }] },
  uncovered:    [{ repo, system, path }],
  totals:       { repos, domains, systems, components,
                  capabilities: { total, unreviewed, approved, changesRequested },
                  scenarios: { total, tested, untested }, changes: { total } } }
```

Texts (a feature's `summary`, a requirement's `text`, a scenario's `text`) keep their inline
Markdown; a scenario's text is one line per step, `GIVEN …`, `WHEN …`, `THEN …`, `AND …`, then one
line per table row, `| a | b |`. A change side's `review` is its proposal's `## Review` section as
plain text, each paragraph on one line and a heading inside the section a paragraph of its own,
paragraphs joined by a blank line (a section repeated is read as one); null without
`proposal.md` or the section. `pendingChanges`
holds the ids of the change folders whose `capabilities` name the feature.

A board's `asset` is null without `--assets` or when the board does not exist at the ref; with it,
`<repo-id>/<path>` under `assetsDir`.

### From version 2

Version 3 indexes the feature-level review and drops the per-scenario human checks. A version 2
reader migrates thus:

- `modules` is `components`, each with `system`; a side's `modules` is its `components`; the
  config keys are `overview.componentMarkers` and `overview.excludeComponents`.
- A capability's `purpose` is `summary`; its `state` is `review` (`unreviewed`, `approved`,
  `changes-requested`), with `reviewed` beside it, per side too.
- A scenario has no `human` and no `look`; it has `table`. A PROOF line is `test` or `invalid`;
  `date`, `build`, `by` and `note` are gone. A side's `problems` are `{ line, message }`.
- A capability's `looks` replace the scenario looks: boards and pages, from its `## Looks`.
- A change has no `review` or `followUps`; a side's `review` is the `## Review` text, and its
  `looks`, `directions` and `evidence` are gone.
- `systems`, `outside` and `uncovered` are new. `totals` counts features by review state,
  scenarios as tested and untested, and change folders, with `systems` and `components`.
- `--assets` copies boards only; there are no images and no LFS handling.

## Tests

```
cd tools/overview && npm test     # node --test; throwaway repositories in the OS temp folder
```

The tests build a notes app and its backend repository with features in both, their review across
sides and the commits that set it, boards present and missing, pages, tables, tested and untested
scenarios, nested systems and one across both repositories, a system no feature ships in, code
outside every system, and change folders with and without a proposal; they check the output
against the schema, the `--assets` copy, the `--summary` text and the command line's exits.
