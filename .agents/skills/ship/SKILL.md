---
name: ship
description: Build an approved change end to end and merge it - worktree, sub-agents per independent task, existing code reused before new code is written, a test per scenario, the suites AGENTS.md names, docs, the review reset, the formality gate, a self-check of the whole change, a pull request, review rounds by fresh sub-agents until one finds no blocker or major, every finding fixed or answered and the fixes self-checked, the branch brought up to date with main, then a squash merge. Use when the owner says to build, implement, ship or merge a specified change, a refactor, tooling or docs change that needs no change folder, or a results branch from triage.
---

# Ship a change

You coordinate; sub-agents may do the work. You merge only when the gate, the suites and an
independent review are clean. Formats: `specs/README.md`, `changes/README.md`.

## 1. Start

- No change folder, and the work changes behaviour (a fix included): run **spec** first.
- The change's branch, in a worktree as AGENTS.md says, named for the change id. A change without
  a folder gets a new branch from a freshly fetched `origin/main`, its worktree made the same way.
- Read `changes/<id>/` and the spec edits (`git diff origin/main...HEAD -- specs/`). A committed
  board, `look.md` or `design.md` is approved.
- A triage results branch (only `review` values and deleted change folders): no build; verify with
  the gate alone (§3.2), then the pull request, the review and the merge.
- No `tasks.md` and more than one step: write it from `../design/templates/tasks.md` (without a
  folder, keep the list in the pull request body).

## 2. Build

- **Sub-agents** per independent task group. Brief each with its task lines and their tests, the
  files, the AGENTS.md rules for those paths, and a task-unique prefix for scratch files. They share
  your git index and working tree: **only you commit**. Read what each returns before committing it.
- **Reuse first.** Before writing code for a task, look for code that already does it or nearly
  does: search the repository, the modules the change touches and the shared utilities. Integrate
  into it, or refactor it so both uses share one implementation; never add a second version. Keep
  the architecture clean: one home per concern, the existing structure and patterns followed. Brief
  each sub-agent to do the same and to report what it reused.
- **Per task:** the test first where one makes sense (it fails without the work), then the work,
  the test run, and the tick, as the tasks template says.
- **Tests.** Every scenario the change adds or changes has its `test:`, and new logic (pure
  functions, parsers, state machines, protocol handling) has unit tests. A scenario no automation
  reaches stays without one, untested, and the pull request names it under `## Not verified`. Never
  write a human check, `pass` or `fail`.
- **Specs match the code.** When the code cannot meet a scenario as written, stop and ask the
  owner; never weaken a scenario silently. The ruling goes into the spec and `proposal.md`.
- **Docs, in the same commits.** The README nearest each changed code path states what the code
  IS; living docs carry no history; every byte budget holds. Every `code:` and `test:` path exists.
- **Looks.** The look is the board the design skill committed; ship draws none. Where the build
  differs from it, say how in the pull request. Every Looks line names a board and a section that
  exist; a board stays self-contained (its CSS inline, nothing from the network). No image,
  recording, clip or frame is ever committed.
- **The review reset.** Every feature the change names (`capabilities` in `proposal.md`) is
  `review: unreviewed`, whether or not its spec text changed: set it where it is not.

## 3. Verify

1. **Commit** in AGENTS.md's commit style; code under a folder whose nearest README rightly stays
   as it is carries `Doc-Impact: none; <reason>`.
2. **Gate**, after committing (it reads commits, not the working tree):
   `node tools/gate/gate.mjs --local`, until it passes, or fails only on `protected` (§6.5).
3. **Suites** AGENTS.md names for what changed; note each command, its result and the head it ran
   on. A red suite: rerun it alone once. Still red: run the same test on `origin/main`. Red there
   too, it is pre-existing: record main's result in `## Tests`; it does not block. Green there, it
   blocks: fix it.
4. **Self-check.** Before round 1, run every check of the review checklist on your branch (12 and
   14 on the pull request body §4 writes), and fix what they find; commit the fixes, then rerun the
   gate and the suites they touch.

## 4. Pull request

Push, then `gh pr create`, ready for review (not a draft). Its title becomes the squash commit's
subject, so it follows AGENTS.md's commit style. The body:

| Section | Holds |
|---|---|
| `## What and why` | what changes for the person using it, and why; the Looks lines |
| `## Reuse` | where existing code was reused, or refactored so both uses share it; or `none: <what was searched>` |
| `## Change` | the change id, or `none: <reason>`; the other repository's pull request, if any |
| `## Tests` | each command run and its result, and the head it ran on, named once; updated after the last fix |
| `## Review` | each review round: its findings and follow-ups, and how each was resolved |
| `## Not verified` | what nothing has checked yet: the untested scenarios, anything not run |

A change with a side in the other repository: open both pull requests, each linking the other.

## 5. Independent review

1. A **fresh** reviewer that wrote none of the code: a new sub-agent, or, where there are none, a
   separate headless run (`claude -p`, `codex exec`). Its brief: read
   `.agents/skills/ship/review-checklist.md` and follow it; the worktree path, the pull request
   number (both, for a change across repositories), the change id; from round 2, the previous
   findings and follow-ups, how each was resolved, and the head last reviewed. A gate failure
   other than `protected` is a blocker; `protected` only means the owner merges, and is no
   finding. It changes nothing.
2. Every finding, a follow-up included: **fix** it, or **answer** it with a reason that cites the
   code, a scenario or a rule. An answer is for a finding that is wrong; work you would rather skip
   is no reason.
3. Commit, and **self-check the fixes**: every check of the review checklist on
   `git diff <head last reviewed>..HEAD`, as its *Round 2 and later* reviews them; fix and commit
   what they find. Then gate, rerun the suites the fixes touch, push, and record the round in
   `## Review`:
   `R1 F2 [minor] <finding> → fixed`, or `→ answered: <reason>`. Name no commit there:
   `## Tests` names the head, once.
4. Review again with a fresh reviewer, round by round, while the last round returns
   `Verdict: fail` (a `blocker` or `major` open). A round that passes ends the review: fix or
   answer its follow-ups without another round, with one exception. When those fixes, what their
   self-check fixed included, changed code (more than docs, comments or wording), one more round
   reviews them. Passing, it ends the review the same way, its own follow-ups fixed or answered
   without a further round; failing, the rounds go on, up to step 5's stop.
5. A `blocker` or `major` still open after round 3: stop, list each open finding for the owner, do
   not merge.

## 6. Merge

1. **Up to date.** `git fetch origin`; when `origin/main` has moved, merge it in, resolve any
   conflict, rerun the gate and the suites the incoming commits or the resolution touch.
2. **Lands.** Every feature the change names is `review: unreviewed` and every task is ticked (a
   triage results branch keeps the `review` values triage wrote). Commit and push.
3. **Reviewed head.** The final head may differ from the last reviewed head only by a clean merge
   of `origin/main`, the commit of step 2, and commits fixing the last round's follow-ups and what
   their self-check found (§5.3–5.4).
   Anything else gets a review round (§5).
4. **Final checks.** Update the pull request body to the final state, then
   `node tools/gate/gate.mjs --local --pr <n>` passes, or fails only on `protected`. The suites are
   green on the final commit (rerun any whose code changed after its run), and `## Tests` names that
   head. CI's gate may be report-only (`reportOnly`): its green proves nothing.
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
- Hand back the pull request link and the merge commit. The features now wait on the owner's
  to-review list: name them, what the proposal's `## Review` says the owner looks at and where,
  and the scenarios left untested.
