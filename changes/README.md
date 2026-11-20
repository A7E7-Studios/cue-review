# Changes

A change folder is the working plan of one change to the product, shared by the
[spec](../.agents/skills/spec/SKILL.md), [design](../.agents/skills/design/SKILL.md) and
[ship](../.agents/skills/ship/SKILL.md) skills: what the owner asked for, the questions settled on
the way, the design picked and the tasks. It is written on the change's branch, lands on main in
the same pull request as the code, and is deleted by triage once the owner has approved every
feature it names. It is not a living document and records no review state: the verdict lives on
each feature's spec ([specs/README.md](../specs/README.md#review)). Living docs (specs, READMEs,
`ARCHITECTURE.md`, `AGENTS.md`) never link into a change folder (`changes/<id>/`).

## Files

| Path | Required | What |
|---|---|---|
| `changes/<change-id>/proposal.md` | yes | the requirements, where the owner reviews it, the settled questions, the calls for the owner, what is out of scope ([template](../.agents/skills/spec/templates/proposal.md)) |
| `changes/<change-id>/looks.html` | no | the directions page: the current state, the directions side by side, each one's trade-offs against the research and the critique, and the recommended pick; one self-contained HTML file, as a board is (its CSS inline, nothing loaded from the network or another file) |
| `changes/<change-id>/look.md` | no | the visual design picked, in words ([template](../.agents/skills/design/templates/look.md)) |
| `changes/<change-id>/design.md` | no | the technical design ([template](../.agents/skills/design/templates/design.md)); committed only once the owner approved it |
| `changes/<change-id>/tasks.md` | no | the tasks, each with the test that proves it ([template](../.agents/skills/design/templates/tasks.md)) |

- **Nothing else.** `changes/` holds this `README.md` and change folders, and a change folder holds
  only the files above: no images, recordings, clips or frames. The board picked lands beside the
  spec ([Looks](../specs/README.md#looks)).
- **Ids.** A change id is kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$`, named for the behaviour
  (`offline-banner-delay`), and free both on main and as a branch.
- **Across repositories.** A change that spans repositories has the same change id in each, and a
  folder in each that names that repository's own capabilities. A repository without `specs/` has
  no folder: its side is an ordinary pull request there, which `design.md` names and the owner
  merges, never an agent.
- **Size.** At most 30720 bytes per `.md`; `looks.html` has no budget of its own, since it goes with
  the folder.
- **Restricted material** (what AGENTS.md marks restricted) never enters a change folder.

## proposal.md

```markdown
---
title: Show the offline banner sooner
capabilities:
  - editing/offline-edits
---
# Show the offline banner sooner

## Why
## What changes
## Review
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

At least one of `capabilities` and `removes` has an item. The sections, in this order: `## Why`,
`## What changes`, `## Review`, `## Settled questions`, `## Calls for the owner`,
`## Out of scope`; what each holds is in the template. `## Review` says, once for the change, what
the owner looks at and where (at a desk, on a device, with a second person), in free text, so
triage can batch the reviews that need the same setup.

## Lifecycle

1. **Spec.** The spec skill writes `proposal.md` and the spec edits on the change's branch, in its
   own worktree.
2. **Design**, when something seen or heard changes or the work needs a plan. The design skill
   shows the owner the directions on `looks.html` and adds it, `look.md` and the picked board once
   the owner has picked a direction, then `design.md` and `tasks.md` once the owner has approved
   them in chat. Neither step gets a pull request of its own.
3. **Ship.** The ship skill builds the change on the same branch, sets every feature the change
   names to `review: unreviewed`, and merges the code, the spec edits and the change folder in one
   pull request once the gate, the suites and an independent review are clean. A pull request
   that fails the gate's `protected` check ([its paths](../tools/gate/README.md#protected-paths))
   is merged by the owner, never by an agent.
4. **To review.** The features are `unreviewed` on main; the folder tells triage what the owner
   looks at.
5. **Triage.** The [triage skill](../.agents/skills/triage/SKILL.md) records the owner's verdict
   in a pull request that ship merges: each feature's `review` becomes `approved` or
   `changes-requested`, and a folder whose features are all `approved` is deleted. The owner's
   feedback becomes an ordinary change: a bug (the build differs from the spec) or a gap (the spec
   does not cover it). Its proposal holds the breakdown as text, each remark with the owner's
   words, its time, the review session's id and what it concerns; when it lands, the feature is
   `unreviewed` again.

Until ship runs, a branch's specs may name `code` and `test:` paths that do not exist yet, so the
gate's path checks fail there; ship creates the paths before its gate run.

## Which pull requests carry a change folder

A spec's **text** is its title, its Summary, its Looks (the lines and the boards in its
`looks/`), and its requirements and scenarios without
their PROOF lines; the `code` list and `review` are not part of it. **Tooling only** means the
change alters no behaviour a person relies on, in the product or in a tool: a change to what a
tool does is a behaviour change, with a folder.

| Pull request | Change folder |
|---|---|
| changes the text of any `specs/**/spec.md`, or deletes one | adds or modifies one that names the capability (in `capabilities`, or in `removes` for a deleted spec); the gate checks it |
| changes behaviour a person sees or relies on, a fix that restores what a spec already states included | adds one, so the owner reviews it; the skills see to it, the gate cannot |
| a review result: only `review` values, and change folders deleted | none |
| changes no behaviour: only PROOF lines, `code` paths or `specs/systems.json` | none |
| a refactor (its spec edits, if any, only `code` paths), a tooling-only or a docs-only change | none; its body says `none: <reason>` under `## Change` |

A review-only pull request needs no build or test run beyond the gate: a project adds `specs/**`
and `changes/**` to its heavier workflows' `paths-ignore`.

## The to-review list

```
node tools/overview/overview.mjs --repo <id>=<checkout> [--repo <id>=<checkout>] --summary
```

prints, after the features and their review state, the features waiting for the owner and every
change folder on each repository's `origin/main` ([tools/overview](../tools/overview/README.md));
its `--out` JSON adds each change's `landed` (the commit, date and pull request that landed it).
The triage skill turns it into the owner's checklist.
