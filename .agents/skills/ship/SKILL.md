---
name: ship
description: Build an approved change end to end and merge it - worktree, sub-agents per independent task, a test per scenario, the suites AGENTS.md names, docs and looks, the formality gate, a pull request, an independent review by a fresh sub-agent, every finding fixed or answered, the branch brought up to date with main, then a squash merge. Use when the owner says to build, implement, ship or merge a specified change, a refactor, tooling or docs change that needs no change folder, or a results branch from triage.
---

# Ship a change

You coordinate; sub-agents may do the work. You merge only when the gate, the suites and an
independent review are clean. Formats: `specs/README.md`, `changes/README.md`.

## 1. Start

- No change folder, and the work changes behaviour (a fix included): run **spec** first.
- The change's branch, in a worktree as AGENTS.md says, named for the change id. A change without
  a folder gets a new branch from a freshly fetched `origin/main`, its worktree made the same way.
- Read `changes/<id>/` and the spec edits (`git diff origin/main...HEAD -- specs/`). A committed
  `look.md` or `design.md` is approved.
- No `tasks.md` and more than one step: write it from `../design/templates/tasks.md` (without a
  folder, keep the list in the pull request body).

## 2. Build

- **Sub-agents** per independent task group. Brief each with its task lines and their tests, the
  files, the AGENTS.md rules for those paths, and a task-unique prefix for scratch files. They share
  your git index and working tree: **only you commit**. Read what each returns before committing it.
- **Per task:** the test first where one makes sense (it fails without the work), then the work,
  the test run, and the tick, as the tasks template says.
- **Tests.** Every scenario the change adds or changes has its `test:`, or its human check `open`
  when only a person can prove it; and new logic (pure functions, parsers, state machines, protocol
  handling) has unit tests. Never write `pass` or `fail`; a fix for a `fail` check sets it to `open`.
- **Specs match the code.** When the code cannot meet a scenario as written, stop and ask the
  owner; never weaken a scenario silently. The ruling goes into the spec and `proposal.md`.
- **Docs, in the same commits.** The README nearest each changed code path states what the code
  IS; living docs carry no history; every byte budget holds. Every `code:` and `test:` path exists.
- **Looks.** For each scenario whose look changes and that the running app can show (AGENTS.md's
  render route): `specs/<domain>/<capability>/look/<scenario-slug>.png`, at most 1280 px wide. A
  renamed scenario's look moves; a removed one's is deleted. Where the build differs from
  `look.md`'s pick, say how in the pull request.

## 3. Verify

1. **Commit** in AGENTS.md's commit style; code under a folder whose nearest README rightly stays
   as it is carries `Doc-Impact: none; <reason>`.
2. **Gate**, after committing (it reads commits, not the working tree):
   `node tools/gate/gate.mjs --local`, until it passes, or fails only on `protected` (§6.5).
3. **Suites** AGENTS.md names for what changed; note each command, its result and the commit it ran
   on. A red suite: rerun it alone once. Still red: run the same test on `origin/main`. Red there
   too, it is pre-existing: record main's result in `## Tests`; it does not block. Green there, it
   blocks: fix it.

## 4. Pull request

Push, then `gh pr create`, ready for review (not a draft). Its title becomes the squash commit's
subject, so it follows AGENTS.md's commit style. The body:

| Section | Holds |
|---|---|
| `## What and why` | what changes for the person using it, and why; the looks |
| `## Change` | the change id, or `none: <reason>`; the other repository's pull request, if any |
| `## Tests` | each command run, its result, and the commit it ran on |
| `## Review` | each review round: its findings, and how each was resolved |
| `## Not verified` | what nothing has checked yet: the open human checks, anything not run |

A change with a side in the other repository: open both pull requests, each linking the other.

## 5. Independent review

1. A **fresh** reviewer that wrote none of the code: a new sub-agent, or, where there are none, a
   separate headless run (`claude -p`, `codex exec`). Its brief: read
   `.agents/skills/ship/review-checklist.md` and follow it; the worktree path, the pull request
   number (both, for a change across repositories), the change id; from round 2, the previous
   findings, how each was resolved, and the head last reviewed. A gate failure other than
   `protected` is a blocker; `protected` only means the owner merges, and is no finding. It changes
   nothing.
2. Every finding, nits included: **fix** it, or **answer** it with a reason that cites the code, a
   scenario or a rule. An answer is for a finding that is wrong; work you would rather skip is no
   reason.
3. Commit, gate, rerun the suites the fixes touch, push, and record the round in `## Review`:
   `R1 F2 [minor] <finding> → fixed in <sha>`, or `→ answered: <reason>`.
4. Review again with a fresh reviewer, round by round, until one returns `Verdict: pass`.
5. Still a finding open after round 3: stop, list each open finding for the owner, do not merge.

## 6. Merge

1. **Up to date.** `git fetch origin`; when `origin/main` has moved, merge it in, resolve any
   conflict, rerun the gate and the suites the incoming commits or the resolution touch.
2. **Lands.** The change's `proposal.md` says `review: unreviewed` and every task is ticked (a
   triage results branch keeps the `review` values triage wrote). Commit and push.
3. **Reviewed head.** The final head may differ from the last reviewed head only by a clean merge
   of `origin/main` and the commit of step 2. Anything else gets a review round (§5).
4. **Final checks.** Update the pull request body to the final state, then
   `node tools/gate/gate.mjs --local --pr <n>` passes, or fails only on `protected`. The suites are
   green on the final commit (rerun any whose code changed after its run). CI's gate may be
   report-only (`reportOnly`): its green proves nothing.
5. **Owner merges.** When the gate fails only on `protected` (a protected path; the list is in
   `tools/gate/README.md`), or this is the other repository's side while that repository has no
   `specs/`, the owner merges it, never you: with everything else done, hand it to the owner with
   one line saying so, remove your local worktree (`git worktree remove <path>` from outside it;
   the branch stays on the remote for the pull request), and stop here.
6. **Hold.** `gh pr view <n> --json labels,comments,reviews`: a `hold` label, or a comment or
   review of the owner's saying hold, stops here. Only the owner lifts it.
7. **Still up to date.** `git fetch origin` and `git merge-base --is-ancestor origin/main HEAD`;
   when it fails, go back to step 1.
8. `gh pr merge <n> --squash --match-head-commit <final sha> --subject "<pull request title> (#<n>)"
   --body "<the why, in a few lines>"`, the body ending in the branch's `Doc-Impact:` lines and any
   trailer AGENTS.md's commit style requires.
9. **Across repositories:** merge first the side the other depends on; the second waits until the
   first is merged, then runs steps 7 and 8. A side the owner merges (step 5) is handed over the
   same way, and its partner waits for it when it depends on it.

**Never merge** on a red gate (a `protected` failure included: the owner merges those), a failing
suite that is not pre-existing, an open finding, or the owner's hold; never the other repository's
side while it has no `specs/`; and never with `--admin` or any other bypass.

## 7. After the merge

- `git push origin --delete <branch>`, then `git worktree remove <path>` from outside the worktree.
- Hand back the pull request link and the merge commit. The change now waits on the owner's
  to-review list (`changes/<id>/` on main): name the human checks and the looks to look at.
