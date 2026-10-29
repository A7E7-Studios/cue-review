---
name: spec
description: Turn a request for a new feature, a change in behaviour or a bug to fix into settled requirements - look up the facts, ask the owner rounds of numbered questions with options and a recommended answer until nothing is assumed, then write changes/<id>/proposal.md and the living-spec edits (requirements, scenarios, PROOF lines) on a branch in its own worktree. Use when the owner asks for a feature, a new capability, a fix, or a change to how something behaves, looks or sounds. Not for a refactor, a tooling-only or a docs-only change, which goes straight to ship.
---

# Spec a change

Turn a request into settled requirements. Facts are yours to find; decisions are the owner's.
Formats: `specs/README.md` (specs, PROOF lines, looks) and `changes/README.md` (change folders, and
which pull requests need one).

## 1. Facts first

`git fetch origin`, then look up, before asking anything:

- **Capabilities.** `specs/domains.json` and the specs near the request; the whole map:
  `node tools/overview/overview.mjs --repo <id>=. --summary`. Reuse a capability before creating
  one; a new one gets a kebab-case id under the domain that fits.
- **Parallel work** on the same capabilities: change folders on main
  (`git ls-tree -d --name-only origin/main changes/`), branches (`git ls-remote --heads origin`) and
  open pull requests (`gh pr list`). The change id is free on main and as a branch; a change that
  triage opened keeps the id triage gave it.
- **The code** the request touches, and the rules AGENTS.md sets for it.
- **The other repository** AGENTS.md names: does the request need its side too?
- **The kind of change**, by `changes/README.md`'s table:
  - no folder needed (a refactor, tooling only, docs only): hand it to **ship** and stop.
  - a one-line fix whose outcome is plain: no rounds and no summary to confirm; write (step 3).
  - everything else, a fix included: rounds.

Use sub-agents for slow lookups and ask the questions that do not depend on them meanwhile. Never
ask the owner for a fact you can look up.

## 2. Rounds

Map the request as a decision tree: each decision branches into the decisions that depend on it.
The **frontier** is every decision whose prerequisites are settled. Ask the whole frontier in one
round, then wait for the answers. A question that depends on another in the same round waits for a
later round.

**Ask through the harness's question tool** when it has one. Claude Code's `AskUserQuestion` takes
up to 4 questions per call and 2–4 options each: the recommended option first, its label ending
"(Recommended)"; one short description per option; a preview on any option whose example the
owner should compare. It adds "Other" itself. A round of more than 4 questions spans several calls.

Only a harness without such a tool gets the questions as text. Each option is its own top-level
list item, its details nested under it:

```
**Q1 - <title>**: <the question>

- **a) <option> (Recommended)**
  - <what it means, what it costs, and why it is recommended>
- **b) <option>**
  - <what it means, what it costs>
```

Never `a) … b) … c)` on one line, and never a plain line after a nested list: Markdown folds such
a line into the last bullet.

- Number questions across rounds (Q1, Q2, … never restarting), in the question tool too (its
  header starts `Q<n>`). Word each so "yes" accepts your recommendation.
- Cover, as the tree reaches them:
  - each observable outcome (each becomes a scenario) and its edges: empty, first use, repeated,
    offline, two people at once;
  - which outcomes only a person can check, and how: `desk`, `headset`, `two-headsets`,
    `printed-card`, `live-tenant`;
  - whether anything seen or heard changes (design then draws it);
  - the other repository's side, the contracts between the two, stored data and its migration;
  - what is out of scope.
- A small change needs one round.
- The rounds end when the frontier is empty, nothing is silently assumed, and the owner confirms a
  short summary of the requirements. Write nothing before that confirmation.

## 3. Write

1. **Worktree.** `git fetch origin`, then a worktree as AGENTS.md says, named for the change id, on
   a new branch `<id>` from `origin/main`.
2. **`changes/<id>/proposal.md`** from `templates/proposal.md`: every question of the rounds under
   Settled questions, every decision you took without asking under Calls for the owner.
3. **Spec edits** in `specs/<domain>/<capability>/spec.md`; a new capability starts from
   `templates/spec.md`. Keep to `specs/README.md` exactly: the gate refuses a `#` heading other
   than the title, any other `##` section or stray text, a step keyword other than
   GIVEN/WHEN/THEN/AND, and two scenarios with one slug.
   - A requirement per behaviour: `The … SHALL …, because …`. Present tense; no history, dates or
     numbers of pull requests or issues.
   - A scenario per observable outcome, GIVEN/WHEN/THEN, ending in its PROOF lines:
     `test: <path>::<selector>` for the test that proves it (an existing one, or the one ship will
     write: name its path), and `<check>: open` for each check a person makes.
   - A scenario whose text you change keeps each human check it had, as `open`: every `pass` and
     `fail` goes, no check is dropped. A scenario you leave alone keeps its PROOF lines exactly.
   - Renaming a scenario renames its look (`look/<scenario-slug>.png`); removing one removes it.
   - A new capability over existing code: its Purpose and only the requirements this change adds,
     changes or fixes; `code:` lists the paths this change touches, a folder ending in `/`.
   - Deleting a capability: `git rm -r` its folder, and list it under the proposal's `removes:`.
4. **The other repository's side**, when there is one: the same change id, its own folder and spec
   edits in its own worktree, each naming its own capabilities. A repository without `specs/` gets
   no folder; design names its side.
5. **Commit** in AGENTS.md's commit style (for example `docs(specs): specify <id>`) and push the
   branch. Open no pull request. The gate's path checks fail on this branch until ship creates the
   `code:` and `test:` paths; that is expected.

## 4. Hand over

- Something seen or heard changes, or the work needs decisions (several modules, the network, a
  format or contract, storage, the other repository): **design**.
- Otherwise: **ship**.

Tell the owner the change id, the branch and the calls for the owner.

The round structure adapts the `grilling` skill from mattpocock/skills (MIT).
