# Changes

A change folder carries one change to the product: what the owner asked for, the questions settled
on the way, the design picked and the work. It is written on the change's branch, lands on main in
the same pull request as the code, and stays on main until the owner has reviewed the result.
**The set of `changes/*/` folders on main is the owner's to-review list.**

The behaviour itself lives in the specs ([specs/README.md](../specs/README.md)); a change folder
says why it changed and how it was decided. It is not a living document. Living docs (specs,
READMEs, `ARCHITECTURE.md`, `AGENTS.md`) never link into a change folder (`changes/<id>/`); a change
folder is deleted when the owner approves it.

## Files

| Path | Required | What |
|---|---|---|
| `changes/<change-id>/proposal.md` | yes | the requirements, the settled questions, the calls for the owner, what is out of scope ([template](../.agents/skills/spec/templates/proposal.md)) |
| `changes/<change-id>/look.md` | no | the visual design ([template](../.agents/skills/design/templates/look.md)) |
| `changes/<change-id>/look/*.png` | no | the pick, one PNG per screen and state |
| `changes/<change-id>/look/directions/*` | no | the directions considered, as PNGs |
| `changes/<change-id>/design.md` | no | the technical design ([template](../.agents/skills/design/templates/design.md)); committed only once the owner approved it |
| `changes/<change-id>/tasks.md` | no | the tasks, each with its test or human check ([template](../.agents/skills/design/templates/tasks.md)) |
| `changes/<change-id>/evidence/*.png` | no | frames from a review recording that this change cites |

- **Nothing else.** `changes/` holds this `README.md` and change folders; any other file directly
  in `changes/` is stray. A change folder without `proposal.md` is an error.
- **Ids.** A change id is kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`, named for the behaviour
  (`offline-banner-delay`), and free both on main and as a branch.
- **Across repositories.** A change that spans repositories has the same change id in each, and a
  folder in each that names that repository's own capabilities. A repository without `specs/` has
  no folder: its side is an ordinary pull request there, which `design.md` names and the owner
  merges, never an agent.
- **Size.** At most 30720 bytes per `.md`. PNGs are stored through Git LFS (`.gitattributes`).
- **Restricted material** (what AGENTS.md marks restricted) never enters `look/` or `evidence/`.

## proposal.md

```markdown
---
title: Show the offline banner sooner
capabilities:
  - editing/offline-edits
review: unreviewed
follow-ups:
  - offline-banner-delay
---
# Show the offline banner sooner

## Why
## What changes
## Settled questions
## Calls for the owner
## Out of scope
```

Front matter is a YAML subset: the file's first line is `---`, then `key: value` lines and `key:`
lines each followed by `  - item` lines, then `---`. These keys, no others:

| Key | Required | Value |
|---|---|---|
| `title` | yes | what the change does, one value a person reads in a list; the `# ` heading repeats it |
| `capabilities` | yes | `<domain>/<capability>` items, both kebab-case, each with a spec in this repository at the commit |
| `removes` | no | `<domain>/<capability>` items this change deletes: each has a spec at the merge base and none at the commit (or was already removed by a change folder on main) |
| `review` | yes | `unreviewed` (landed, waiting for the owner) or `changes-requested` (reviewed; a later change carries the fix) |
| `follow-ups` | no | the kebab-case ids of the changes opened from this change's review |

At least one of `capabilities` and `removes` has an item. The sections, in this order: `## Why`,
`## What changes`, `## Settled questions`, `## Calls for the owner`, `## Out of scope`; what each
holds is in the template.

## Lifecycle

1. **Spec.** The [spec skill](../.agents/skills/spec/SKILL.md) writes `proposal.md` and the spec
   edits on the change's branch, in its own worktree.
2. **Design**, when something seen or heard changes or the work needs a plan. The
   [design skill](../.agents/skills/design/SKILL.md) adds `look.md` and `look/` once the owner has
   picked a direction, then `design.md` and `tasks.md` once the owner has approved them in chat.
   Neither step gets a pull request of its own.
3. **Ship.** The [ship skill](../.agents/skills/ship/SKILL.md) builds the change on the same
   branch, sets `review: unreviewed`, and merges the code, the spec edits and the change folder in
   one pull request once the gate, the suites and an independent review are clean. A pull request
   that fails the gate's `protected` check ([its paths](../tools/gate/README.md#protected-paths)) is merged
   by the owner, never by an agent.
4. **To review.** The folder stays on main; the change is on the owner's to-review list.
5. **Triage.** The [triage skill](../.agents/skills/triage/SKILL.md) records the owner's review in
   a pull request that ship merges:
   - **approved**: the checked scenarios' PROOF lines become `pass`, and the folder is deleted;
   - **changes requested**: `review: changes-requested`, and a new change carries the fix, its id
     added to `follow-ups`. The folder is deleted when the owner has approved every change in its
     `follow-ups`.

Until ship runs, a branch's specs may name `code` and `test:` paths that do not exist yet, so the
gate's path checks fail there; ship creates the paths before its gate run.

## Which pull requests carry a change folder

A spec's **requirement text** is its title, its purpose, and its requirements and scenarios without
their PROOF lines; the `code` list is not part of it. **Tooling only** means the change alters no
behaviour a person relies on, in the product or in a tool: a change to what a tool does is a
behaviour change, with a folder.

| Pull request | Change folder |
|---|---|
| changes the requirement text of any `specs/**/spec.md`, or deletes one | adds or modifies one that names the capability (in `capabilities`, or in `removes` for a deleted spec); the gate checks it |
| changes behaviour a person sees or relies on, a fix that restores what a spec already states included | adds one, so the owner reviews it; the skills see to it, the gate cannot |
| changes no code and no behaviour: only PROOF lines (triage results), only `code` paths, or only deletes change folders | none |
| a refactor (its spec edits, if any, only `code` paths), a tooling-only or a docs-only change | none; its body says `none: <reason>` under `## Change` |

## The to-review list

```
node tools/overview/overview.mjs --repo <id>=<checkout> [--repo <id>=<checkout>] --summary
```

prints, after the capabilities and their state, every change folder on each repository's
`origin/main` ([tools/overview](../tools/overview/README.md)); its `--out` JSON adds each change's
looks, evidence and `landed` (the commit, date and pull request that landed it). The triage skill
turns it into the owner's checklist.
