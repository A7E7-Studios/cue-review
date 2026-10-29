# Overview

The overview index generator: one JSON document that says what the solution is across
repositories — an app and its backend, say, each carrying this same tool.
It lists every capability with its requirements, scenarios and their human review state, the
changes waiting for the owner's review, and the modules. A viewer renders it; this tool only
writes the index.

No npm dependencies; Node 22 or later. It reads the spec format through
[`tools/gate/lib/spec.mjs`](../gate/lib/spec.mjs), the same parser the gate judges with.

```
node tools/overview/overview.mjs --repo app=../app --repo backend=../backend \
  [--ref origin/main] [--out overview.json] [--assets <dir>] [--summary]
```

| Option | Does |
|---|---|
| `--repo <id>=<git dir>[@<ref>]` | a repository to read, any number; the id (lowercase, digits, `-`) tags everything from it; the first given wins a shared capability's title and purpose |
| `--ref <ref>` | the ref of each `--repo` given without `@<ref>`; default `origin/main` |
| `--out <file>` | write the JSON there; without it the JSON goes to stdout, unless `--summary` |
| `--assets <dir>` | copy every referenced image into `<dir>/<repo-id>/<path>` |
| `--summary` | print a plain-text table: per domain each capability, its state and its scenarios approved / open / failing / automated; then the changes to review; then the modules |

Exit: **0** written, **2** usage or setup error (a ref that does not resolve, a folder that is not a
repository). Fetch first: the tool never fetches.

## What it reads

Each repository at its ref, through git objects only (`git ls-tree`, `git cat-file`, `git log`):
the checkout's branch and working tree never matter and are never written. The one write into a
repository is `--assets` fetching a missing LFS object into its LFS cache (below).

| Source | Becomes |
|---|---|
| `specs/domains.json` | `domains`, from the first repository that has it |
| `specs/<domain>/<capability>/spec.md` | a capability; one entry per id across repositories, a side per repository |
| `specs/<domain>/<capability>/look/<scenario-slug>.png` | the scenario's `look` |
| `changes/<id>/` | a change waiting for review, one entry per id across repositories; `proposal.md`'s front matter (`removes` too: the capabilities it deletes), its files, `look/*`, `look/directions/*`, `evidence/*`, and `landed`: the newest first-parent commit on the ref that added `proposal.md` (a renamed folder lands with its rename), its date, and the PR number from a subject ending `(#<n>)` |
| a folder holding a module marker (`README.md`, `package.json`, `pyproject.toml`, `build.gradle(.kts)`, a `*.asmdef`) | a module (below) |

## Modules

A module is a folder (`.` for the root), not under `node_modules`, that holds a file a module
marker matches. The markers are file-name globs, `tools/gate/config.json` `overview.moduleMarkers`;
a repository whose config has no such key gets `README.md`, `package.json`, `pyproject.toml`,
`build.gradle`, `build.gradle.kts` and `*.asmdef` (an empty list marks no module). A `*.asmdef` marks its folder only when it is not
a test assembly: one whose `name` or folder ends with `Tests` (`PlayTests`, `EditModeTests`,
`PlayModeTests` included) or whose name holds `.Tests`. A module's `README.md` gives its title and
summary even where `README.md` is no marker.

| Field | From |
|---|---|
| `readme`, `assembly` | the folder's `README.md` path, its asmdef's `name`; each null when absent |
| `manifest` | the folder's first other marker file, in marker order (`package.json`, `pyproject.toml`, `build.gradle.kts`, or one the config names), or null |
| `package` | the package name a manifest gives: `package.json` `name`, `pyproject.toml` `[project]` (else `[tool.poetry]`) `name`; null otherwise |
| `title` | the README's first heading, else the assembly's name, else the package's name, else the folder's name (the repository id for the root) |
| `summary` | the README's first paragraph as plain text, else the manifest's `description`, else empty; at most 300 characters |
| `capabilities` | every capability with a `code` path whose nearest (deepest) module up its tree is this one; a path ending `/` starts at that folder |

Left out: `specs/`, `changes/`, `.agents/`, `.github/`, and the repository's own
`tools/gate/config.json` globs, `ignore` (vendored packages and samples) and
`overview.excludeModules` (planning and fixture folders). A repository whose config names no
`overview.excludeModules` gets `dev/**`, `docs/**`, `**/proof/**`, `fixtures/**`,
`**/test/fixtures/**`.

## Derived state

| Of | State |
|---|---|
| a scenario (`human`) | `failing` if any human check is `fail`; else `open` if any is `open` or malformed; else `approved` if it has a human check, all `pass`; else `automated` |
| a capability (`state`) | `failing` if any scenario is failing; else `unreviewed` if a pending change names it, any scenario is open, or a side's spec breaks the format; else `approved` if any scenario is approved; else `automated` |
| a change (`review`) | `changes-requested` if any repository's side says so, else `unreviewed` |

A malformed PROOF line is listed with `state: "invalid"` and its `error`. Unless it is a `test:`
line, it counts as an open human check: a scenario with one is never `approved` or `automated`.
A side's `problems` lists each break of the spec format, and a capability with any is never
`approved` or `automated`. `test:` lines carry `exists`.

## Output

[`overview.schema.json`](overview.schema.json) (JSON Schema 2020-12) describes version 2:

```
{ version: 2, generatedAt, assetsDir,
  repos:        [{ id, name, ref, commit }],
  domains:      [{ id, title, purpose }],
  capabilities: [{ id, domain, title, purpose,
                   sides: [{ repo, spec, code, modules, problems }],
                   requirements: [{ repo, name, text,
                     scenarios: [{ name, slug, text, look: { repo, path, asset, missing? } | null,
                                   proofs: [{ check, state, path?, selector?, exists?, date?, build?, by?, note?, error? }],
                                   tested, human }] }],
                   pendingChanges, state }],
  changes:      [{ id, title, review, followUps,
                   sides: [{ repo, path, review, capabilities, removes, files, looks, directions, evidence,
                             landed: { commit, date, pr } | null }] }],
  modules:      [{ repo, path, readme, assembly, package, manifest, title, summary, capabilities }],
  totals:       { repos, domains, modules, capabilities: {..by state}, scenarios: {..by state, tested},
                  changes: { total, unreviewed, changesRequested } } }
```

Texts (`purpose`, a requirement's `text`, a scenario's `text`) keep their inline Markdown; a
scenario's text is one line per step, `GIVEN …`, `WHEN …`, `THEN …`, `AND …`.

`looks`, `directions` and `evidence` hold `{ path, asset }`. Without `--assets` every `asset` is
null. With it, `asset` is `<repo-id>/<path>` under `assetsDir`; an LFS pointer goes through
`git lfs smudge` (which fetches a missing object from the remote into the repository's LFS cache,
as a checkout would, and whose bytes must match the pointer's sha256), and one it cannot resolve
keeps `asset: null` with `missing: "lfs"`.

## Tests

```
cd tools/overview && npm test     # node --test; two throwaway repositories in the OS temp folder
```

The tests build an app and a backend repository with a capability in both, a pending change with
a look, directions and evidence, every PROOF state and derived state, and LFS images with and
without their object; they check the output against the schema, the `--assets` copy, the
`--summary` text and the command line's exits.
