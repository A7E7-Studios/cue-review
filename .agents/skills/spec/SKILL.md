---
name: spec
description: Turn a request for a new feature, a change in behaviour or a bug to fix into settled requirements - look up the facts, ask the owner rounds of numbered questions with options and a recommended answer until nothing is assumed, then write changes/<id>/proposal.md and the living-spec edits (Summary, requirements, scenarios and the tests that prove them) on a branch in its own worktree. Use when the owner asks for a feature, a new capability, a fix, or a change to how something behaves, looks or sounds, and when triage hands over the owner's feedback. Not for a refactor, a tooling-only or a docs-only change, which goes straight to ship.
---

# Spec a change

Turn a request into settled requirements. Facts are yours to find; decisions are the owner's.
Formats: `specs/README.md` (specs, PROOF lines, Looks, review) and `changes/README.md` (change
folders, and which pull requests need one).

## 1. Facts first

`git fetch origin`, then look up, before asking anything:

- **Capabilities.** `specs/domains.json`, `specs/systems.json` and the specs near the request; the
  whole map: `node tools/overview/overview.mjs --repo <id>=. --summary`. Reuse a capability before
  creating one; a new one gets a kebab-case id under the domain that fits.
- **Parallel work** on the same capabilities: change folders on main
  (`git ls-tree -d --name-only origin/main changes/`), branches (`git ls-remote --heads origin`) and
  open pull requests (`gh pr list`). The change id is free on main and as a branch; a change that
  triage opened keeps the id triage gave it.
- **The code** the request touches, and the rules AGENTS.md sets for it. List every code path each
  outcome of the request reaches: each caller of what it changes, each entry point that reaches the
  behaviour. The proposal's `## What changes` names, for each change, the paths it covers.
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
  - how each outcome is proven by a test, and which ones no automation reaches (they stay
    untested: say so);
  - where the owner reviews the feature: at a desk, on a device, with a second person, against
    which account (the proposal's `## Review`; AGENTS.md may say where the owner reviews);
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
   Settled questions, every decision you took without asking under Calls for the owner, and
   `## Review` saying what the owner looks at and where. A change triage handed over keeps each
   remark of the owner's in Why as text, as triage wrote it.
3. **Spec edits** in `specs/<domain>/<capability>/spec.md`; a new capability starts from
   `templates/spec.md`. Keep to `specs/README.md` exactly: the gate refuses a front matter key
   other than `title`, `review` and `code`, a `##` section other than Summary, Looks and
   Requirements, stray text, a step keyword other than GIVEN/WHEN/THEN/AND, and two scenarios with
   one slug.
   - **Summary**: what the feature does, when you meet it and why, in a few sentences a
     non-developer understands. Rewrite it when the change alters what it says.
   - **A requirement per behaviour**: "When …, the app SHALL …, because …"; a behaviour that holds
     always drops the "When …,". Present tense; no history, dates or numbers of pull requests or
     issues.
   - **A scenario per observable outcome**, named by its outcome. Steps only where the name leaves
     something open: one WHEN, one THEN, a GIVEN only for a setup that is not the default; a table
     for many cases of one outcome. It ends in its PROOF lines, `test: <path>::<selector>` for the
     test that proves it (an existing one, or the one ship will write: name its path). A scenario
     no automation reaches has none and is untested; never a human check, never `pass` or `fail`.
   - **Looks** lines are design's, once the owner picks a direction; a renamed or removed screen
     updates its lines and its board.
   - **`review: unreviewed`** in every spec the change names, whether or not its text changes.
   - A new capability over existing code: its Summary and only the requirements this change adds,
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

Tell the owner the change id, the branch, the calls for the owner and the scenarios left untested.

The round structure adapts the `grilling` skill from mattpocock/skills (MIT).
