# Specs

A spec states what one capability of the product does, in words a non-developer can follow, and
how each behaviour is proven: by an automated test, by a person, or both. A spec is a living
document: it states what the product does at the commit it sits in, and a change to it lands in
the same pull request as the code that makes it true. The formality gate
([tools/gate](../tools/gate/README.md)) checks the format below; the overview index
([tools/overview](../tools/overview/README.md)) reads every spec of every repository into one map
of capabilities and their review state.

## Layout

| Path | What |
|---|---|
| [`specs/domains.json`](domains.json) | the domains, `[{ "id", "title", "purpose" }]`, identical in every repository of a solution |
| `specs/<domain>/<capability>/spec.md` | one capability's spec |
| `specs/<domain>/<capability>/look/<scenario-slug>.png` | optional: how one scenario looks, rendered from the running app |

- **Nothing else.** `specs/` holds `README.md`, `domains.json` and capability folders; a capability
  folder holds `spec.md` and `look/<scenario-slug>.png` files. Any other file is stray, and a look
  whose slug names no scenario of its spec is an error.
- **Ids.** A capability id is kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`; `<domain>` is an id from
  `domains.json`.
- **One path in every repository.** A capability present in more than one repository has the same
  `<domain>/<capability>` path in each, and each repository's spec states only its own side.
- **Scenario slug.** The scenario name lower-cased, every run of characters outside `[a-z0-9]`
  replaced by one `-`, trimmed of `-`: `A user edits a note offline` becomes
  `a-user-edits-a-note-offline`. Slugs are unique within a spec, so a slug names one look: two
  scenario names that differ only in case or punctuation collide, even under different
  requirements.

## The spec file

```markdown
---
title: Offline edits
code:
  - src/sync/
  - src/editor/OfflineBanner.ts
---
# Offline edits

## Purpose

Plain language a non-developer understands, 1–3 sentences. It doubles as the overview's description.

## Requirements

### Requirement: Edits made offline are kept
The app SHALL keep every edit made without a connection and send it when the connection returns,
because a user otherwise loses work they believe is saved.

#### Scenario: A user edits a note offline
- **GIVEN** a user with no connection
- **WHEN** they edit a note and the connection returns
- **THEN** the edit reaches the other users of the note
- **PROOF** test: src/sync/offline.test.ts::keeps edits made offline
- **PROOF** desk: open
```

A new spec starts from [the spec template](../.agents/skills/spec/templates/spec.md).

### Front matter

A YAML subset only: the file's first line is `---`, then `key: value` lines and `key:` lines each
followed by `  - item` lines, then `---`. Two keys, no others:

| Key | Required | Value |
|---|---|---|
| `title` | yes | the capability's name, one value |
| `code` | yes | one or more repository-relative paths with `/` separators, each present at the commit: a folder ends in `/`, a file does not |

### Body

1. One `# <title>`, exactly the front matter's `title`.
2. One `## Purpose`, not empty: 1–3 sentences a non-developer understands. It is the overview's
   description of the capability.
3. One `## Requirements` after it, holding one or more `### Requirement: <name>`. Requirement names
   are unique within the spec.
4. Each requirement: a statement paragraph, then one or more `#### Scenario: <name>`.
5. Each scenario: bullets only. `- **GIVEN** …` is optional, `- **WHEN** …` and `- **THEN** …` are
   required, `- **AND** …` may follow any of them; a bullet may wrap onto lines indented by two
   spaces. The scenario ends in its PROOF lines. No other bold keyword, plain bullet or paragraph.

These are the only headings and the only text: no `##` section besides Purpose and Requirements, no
text between the `# ` heading and `## Purpose` or between `## Requirements` and its first
requirement, and no heading deeper than `####`.

### Writing rules

- **Present tense, what IS.** A spec states what the capability does at this commit. A decision is
  a requirement whose statement gives its reason in the same sentence (`SHALL …, because …`).
- **No history.** No narration of a change, status, dates (outside PROOF lines), pull request or
  issue numbers. Git and the merged pull requests hold the history; the change folder holds the
  open questions.
- **A scenario is an acceptance test.** One observable outcome, stated so a test or a person can
  tell pass from fail.
- **Specified as changes reach it.** A new capability over code that already exists states its
  Purpose and only the requirements its first change adds, changes or fixes, and `code` lists the
  paths that change touches. Behaviour no change has reached is not specified yet.
- **Budget.** At most 30720 bytes per `spec.md` (git blob size). A spec that outgrows it splits
  into capabilities.

## PROOF lines

Every scenario ends in one or more PROOF lines, and nothing follows them. A PROOF line is one line;
it never wraps.

```
- **PROOF** test: <repo path>[::<selector>]
- **PROOF** <check>: open
- **PROOF** <check>: pass <YYYY-MM-DD>, build <version>, by <who>[; <note>]
- **PROOF** <check>: fail <YYYY-MM-DD>, build <version>, by <who>; <note>
```

`test:` names an automated test that proves the scenario; a scenario may have none or several. The
path is written bare (no backticks) and exists at the commit, a file or a folder; `::` is followed
by a selector naming the test inside it (for example `Class.Method`), or left out. Every other line
is a human check, named for how a **person** checks it:

| Check | The person checks it |
|---|---|
| `desk` | at a computer: a web page, an editor, a tool's output |
| `headset` | wearing one headset |
| `two-headsets` | with two people in two headsets, in one session |
| `printed-card` | with a printed code or card in the room |
| `live-tenant` | against a live tenant and its account |

- Each check appears at most once per scenario. The date is a calendar date; `<version>` and
  `<who>` are not empty and contain no `,` or `;`; a `fail` always carries its note.
- **`build <version>`** is the build's identifier as AGENTS.md names it: the one its rule for
  reading a build's commit takes.
- **Agents write `test:` and `open` only.** Only the owner's word sets `pass` or `fail`, and the
  [triage skill](../.agents/skills/triage/SKILL.md) writes it, with the date of the check, the
  build checked and who checked.
- **A changed scenario starts over.** A scenario's text is its name and its step bullets,
  whitespace collapsed (re-wrapping a bullet changes nothing), and it is known by its requirement's
  name and its own. A scenario whose text differs from the merge base, or that is new there
  (renaming its requirement makes it new), carries no `pass` or `fail`, and keeps each human check
  it had, as `open`; the gate fails a dropped one. An unchanged scenario keeps its PROOF lines as
  they are.
- **A check that no longer applies** is removed by triage on the owner's word, as a change to the
  PROOF lines of an unchanged scenario.
- **A fix reopens a failed check.** The change that fixes a `fail` sets that check back to `open`,
  for the owner to check again.

The human state of a scenario and of a capability (`failing`, `open` or `unreviewed`, `approved`,
`automated`) is derived from these lines: [tools/overview](../tools/overview/README.md#derived-state).

## Looks

A look is `look/<scenario-slug>.png` beside the spec: the scenario as the running app shows it,
rendered by the route AGENTS.md names, never drawn or edited by hand.

- Optional. A scenario only a person can see (on a device, with real hands, with a second person)
  has no look; its human check carries it.
- The pull request that changes how a scenario looks refreshes its PNG. A renamed scenario's look
  moves with its slug; a removed scenario's look is deleted.
- At most 1280 px wide. PNGs are stored through Git LFS (`.gitattributes`).
- The change folder's `look/` holds the design that was picked; the spec's `look/` holds what was
  built.

## Changing a spec

Edit it in place; the diff is the change. Which pull requests carry a change folder:
[changes/README.md](../changes/README.md#which-pull-requests-carry-a-change-folder).

## Checks

```
node tools/gate/gate.mjs --local                                     # this branch, strict
node tools/overview/overview.mjs --repo <id>=<checkout> --summary    # capabilities and their state
```

What the gate checks: [tools/gate](../tools/gate/README.md). The overview's options and output:
[tools/overview](../tools/overview/README.md). The overview groups capabilities by module: a
module is a folder holding a module marker (a `README.md`, a `package.json`, a `pyproject.toml`, a
`build.gradle(.kts)`, a Unity `*.asmdef`, or the markers the project names), and each `code` path
belongs to the nearest one up its tree.
