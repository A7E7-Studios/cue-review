# Specs

A spec states what one feature (a capability) of the product does, in two layers: a Summary and
its Looks for people, and requirements with their scenarios for agents. Each scenario is proven by
an automated test; the owner reviews the feature as a whole, and its spec records only the verdict.
A spec is a living document: it states what the feature does at the commit it sits in, and a change
to it lands in the same pull request as the code that makes it true. The formality gate
([tools/gate](../tools/gate/README.md)) checks the format below; the overview index
([tools/overview](../tools/overview/README.md)) reads every spec of every repository into one map
of features, their systems and their review state.

## Layout

| Path | What |
|---|---|
| [`specs/domains.json`](domains.json) | the domains, `[{ "id", "title", "purpose" }]`, identical in every repository of a solution |
| `specs/systems.json` | optional: this repository's systems, `[{ "id", "title", "purpose", "paths" }]` ([below](#systems)) |
| `specs/<domain>/<capability>/spec.md` | one feature's spec |
| `specs/<domain>/<capability>/looks/<name>.html` | optional: a board holding the feature's picked visual design ([Looks](#looks)) |

- **Nothing else.** `specs/` holds `README.md`, `domains.json`, `systems.json` and capability
  folders; a capability folder holds `spec.md` and the boards its Looks name. Any other file is
  stray, a board no Looks line names among them, and no image or video file is ever committed under
  `specs/` (or `changes/`).
- **Ids.** A capability id is kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`; `<domain>` is an id from
  `domains.json`.
- **One path in every repository.** A capability present in more than one repository has the same
  `<domain>/<capability>` path in each, and each repository's spec states only its own side.
- **Scenario slug.** The scenario name lower-cased, every run of characters outside `[a-z0-9]`
  replaced by one `-`, trimmed of `-`: `An edit made offline reaches the others` becomes
  `an-edit-made-offline-reaches-the-others`. Slugs are unique within a spec: two scenario names
  that differ only in case or punctuation collide, even under different requirements.

## The spec file

```markdown
---
title: Offline edits
review: unreviewed
code:
  - src/sync/
  - src/editor/OfflineBanner.ts
---
# Offline edits

## Summary

You can keep writing when the connection drops: the app keeps every edit and sends it when the
connection returns, and a banner says you are offline. You meet it on a train or in a lift.

## Looks

- looks/offline-banner.html#banner — The banner after five seconds offline
- page: /notes/<id> — Open a note, then turn off the network

## Requirements

### Requirement: Edits made offline are kept
When the connection drops, the app SHALL keep every edit and send it when the connection returns,
because a user otherwise loses work they believe is saved.

#### Scenario: An edit made offline reaches the others
- **WHEN** a user edits a note offline and the connection returns
- **THEN** the edit reaches the other users of the note
- **PROOF** test: src/sync/offline.test.ts::keeps edits made offline

#### Scenario: Edits wait as long as the connection is gone
| Offline for | The edits are sent |
|---|---|
| 5 seconds | when it returns |
| 3 days | when it returns |
- **PROOF** test: src/sync/offline.test.ts::keeps edits for days
```

A new spec starts from [the spec template](../.agents/skills/spec/templates/spec.md).

### Front matter

A YAML subset only: the file's first line is `---`, then `key: value` lines and `key:` lines each
followed by `  - item` lines, then `---`. Three keys, no others:

| Key | Required | Value |
|---|---|---|
| `title` | yes | the feature's name, one value |
| `review` | yes | the owner's verdict on the feature: `unreviewed`, `approved` or `changes-requested` ([Review](#review)) |
| `code` | yes | one or more repository-relative paths with `/` separators, each present at the commit: a folder ends in `/`, a file does not |

### Body

1. One `# <title>`, exactly the front matter's `title`.
2. One `## Summary`, not empty: what the feature does, when you meet it and why, in a few sentences
   a non-developer understands. It is the overview's description of the feature.
3. Optionally one `## Looks`, after the Summary: its [Looks lines](#looks) and nothing else.
4. One `## Requirements` after them, holding one or more `### Requirement: <name>`. Requirement
   names are unique within the spec.
5. Each requirement: a statement paragraph, then one or more `#### Scenario: <name>`.
6. Each scenario, in this order, each part optional: its steps, a table, its PROOF lines.
   - **Steps** are bullets: at most one `- **GIVEN** …` (only for a setup that is not the
     default), then exactly one `- **WHEN** …` and one `- **THEN** …`; `- **AND** …` may follow
     any of them. A bullet may wrap onto lines indented by two spaces.
   - **A table** (Markdown, a header row, a `|---|` row and one row per case) stands in for many
     cases of one outcome.
   - **PROOF lines** end the scenario ([below](#proof-lines)).
   No other bold keyword, plain bullet or paragraph.

These are the only headings and the only text: no `##` section besides Summary, Looks and
Requirements, no text between the `# ` heading and `## Summary` or between `## Requirements` and
its first requirement, and no heading deeper than `####`.

### Writing rules

- **The requirement in one sentence**: "When …, the app SHALL …, because …" (the event-driven form
  of EARS); a behaviour that holds always drops the "When …,". Every statement holds `SHALL` and
  `because`: the reason sits in the same sentence.
- **A scenario is a named example**, and its name states the outcome (`An edit made offline
  reaches the others`, not `Offline case 2`). Steps say only what the name leaves open.
- **Present tense, what IS.** A spec states what the feature does at this commit. No narration of
  a change, no status, no dates, no pull request or issue numbers: git and the merged pull
  requests hold the history; a change folder holds the work in flight.
- **Specified as changes reach it.** A new spec over code that already exists states its Summary
  and only the requirements its first change adds, changes or fixes, and `code` lists the paths
  that change touches. Behaviour no change has reached is not specified yet.
- **Budget.** At most 30720 bytes per `spec.md` and per board (git blob size). A spec that outgrows
  it splits into features.

## PROOF lines

A scenario is proven by automation only. A PROOF line names a test that proves it:

```
- **PROOF** test: <repo path>[::<selector>]
```

The path is written bare (no backticks) and exists at the commit, a file or a folder; `::` is
followed by a selector naming the test inside it (for example `Class.Method`), or left out. A test
may be a scripted run anywhere the project can automate one: a unit test, an editor harness, a run
on a device. A scenario may have several PROOF lines, or none: a scenario without one is
**untested**, a coverage gap the overview shows, never a review item. A PROOF line is one line; it
never wraps, and nothing follows a scenario's PROOF lines.

## Review

The owner reviews a feature as a whole, and `review` in its front matter holds the verdict:

| `review` | Means |
|---|---|
| `unreviewed` | waiting for the owner: new, or changed since the owner last looked |
| `approved` | the owner approved the feature as its spec and Looks state it |
| `changes-requested` | the owner asked for changes; a change that answers them is to come |

- **A new spec starts `unreviewed`**, one written over code that already exists included.
- **A changed feature goes back to `unreviewed`.** A pull request that changes a spec's text (its
  title, Summary, Looks lines and boards, requirements or scenarios; not its `code` paths or PROOF
  lines) sets that spec's `review` to `unreviewed`, and so does one that adds or modifies a change
  folder naming the feature. The gate enforces both.
- **Only the owner's word sets `approved` or `changes-requested`**, and the
  [triage skill](../.agents/skills/triage/SKILL.md) writes it, in a pull request that changes
  nothing else in the spec. The verdict is the whole record: no notes, build or reviewer in the
  spec. The triage pull request says when the owner reviewed and on which build.

## Looks

`## Looks` lists the feature's visual design for people, one line each, never a picture file:

```
- looks/<name>.html#<id> — <caption>
- page: <path in the app, or a URL> — <caption>
```

- **A board** is `looks/<name>.html` in the capability folder: the design the owner picked, as one
  self-contained HTML file (its CSS inline, nothing loaded from the network or another file), each
  design a `<section id="…">`. A board line names a board of this folder and an `id` it holds. The
  Solution map pulls each section in by its id. The directions the owner did not pick stay on the
  change's directions page until its folder is deleted
  ([changes/README.md](../changes/README.md#files)).
- **A page** names where the built feature can be seen: a path in the app, or a URL.
- The pull request that changes how the feature looks updates its board or its lines; a feature
  with no visual side has no `## Looks`.

## Systems

`specs/systems.json` declares this repository's systems: the parts that run on their own and that
you would name to a colleague, such as an app, a conversion tool, the API or a release pipeline.

```json
[{ "id": "editor", "title": "Editor", "purpose": "The app people write notes in.", "paths": ["src/"] }]
```

- `id` is kebab-case and unique; `title` and `purpose` (one or two sentences) are not empty;
  `paths` lists one or more repository-relative paths, written as a spec's `code` is, each present
  at the commit.
- **Domains group features for people; systems say what each feature ships in.** A feature's
  systems follow from its `code` paths: a path belongs to the nearest system that declares it or
  a folder above it. A feature can ship in several systems, and a spec names none itself.
- **A system across repositories** has the same id in each; each repository declares only its own
  paths. Two systems never declare the same path.
- Code outside every system is information, not a failure: the overview lists it.

## Changing a spec

Edit it in place; the diff is the change. Which pull requests carry a change folder:
[changes/README.md](../changes/README.md#which-pull-requests-carry-a-change-folder).

## Checks

```
node tools/gate/gate.mjs --local                                     # this branch, strict
node tools/overview/overview.mjs --repo <id>=<checkout> --summary    # features and their review state
```

What the gate checks: [tools/gate](../tools/gate/README.md). The overview's options and output:
[tools/overview](../tools/overview/README.md). Beside features and systems, the overview lists
components for agents: folders holding a marker file (a `README.md`, a `package.json`, a
`pyproject.toml`, a `build.gradle(.kts)`, a Unity `*.asmdef`, or the markers the project names),
each `code` path belonging to the nearest one up its tree.
