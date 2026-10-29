---
name: triage
description: Turn the owner's human review of merged changes into results. With no input, list what waits for the owner's review (every change folder on main, and the open or failing human checks) as one checklist. With CueReview sessions (their Copy for agent text or ids), review notes or feedback, map each remark to a change, sort the items into approvals, bugs, changes and questions, record approvals as pass PROOF lines, delete approved change folders and start the follow-up changes. Use for what is waiting for my review, a CueReview recording, or the owner's review results, notes or feedback on merged changes. Not for reviewing code or a pull request.
---

# Triage the owner's review

The owner reviews after the merge. You turn that review into PROOF lines, deleted change folders
and new changes. **Only the owner's words set `pass` or `fail`**; never infer one. **Restricted
material** (what AGENTS.md marks restricted) never appears in a frame you copy, on a page you show
or in a pull request body: describe the defect, never the model.

## A. No input: the to-review list

1. `git fetch origin` in this repository and in each other repository AGENTS.md names.
2. `node tools/overview/overview.mjs --repo <id>=<checkout> [--repo <id>=<checkout>] --summary
   --out <scratch>/overview.json`.
3. Build the checklist, newest landed first:
   - **Per change folder:** title, id, repositories, its landing commit, date and pull request
     (`landed` in the JSON), `review` state, its looks. Under it, each scenario it added or changed
     (`git show <landing commit> -- specs/`) with each human check and what the person looks at:
     `design.md`'s human checks, else the scenario's THEN steps and `proposal.md`'s What changes.
   - **Then the other human checks** that are `open` or `fail`, grouped by check (`desk`,
     `headset`, `two-headsets`, `printed-card`, `live-tenant`), each group headed with what it
     needs: a build that contains the landing commit, two headsets, the printed card, the tenant
     and its account.
4. Give it in chat, or as a local HTML page outside the repository. Never commit it.
5. Suggest the recording: one CueReview session per source ("Record more" keeps the source, so the
   desk checks and the headset checks are separate sessions), one take per change, each opening
   with the change's name said aloud.

## B. With a review: the results

Input: one or more CueReview sessions (each one's "Copy for agent" text: the `cue` executable's
path, the session id, `CUEREVIEW_DATA_DIR`), session ids, or the owner's notes or feedback.
CueReview runs on the owner's computer; on Windows, `cue` is
`%LOCALAPPDATA%\Programs\CueReview\cue.exe` unless the copied text says otherwise.

1. **Read each session**, with `CUEREVIEW_DATA_DIR` set as the copied text says:
   - `cue info ID`: duration, takes, folders.
   - `cue transcript ID --segments`: the whole review; each take starts at a
     `── Take N · m:ss ──` divider.
   - `cue frames ID --per-segment --max-width 1600 --mark-cursor`: one frame per segment; look at
     each. A stereo source (a headset whose frames hold both eyes side by side):
     `--max-width 3200` (it never upscales); read one eye.
   - `cue moments ID`: the spoken pointing ("here", "this") with the cursor and the clicks. A device
     source (a headset, a phone) has no cursor track: the pointing is the hand, the finger or the
     gaze in the frame.
   - `cue frame ID --at-ms MS` and `cue clip ID --start-ms A --end-ms B` where a remark needs a
     closer look. Times are estimates: check the neighbouring frames. Names may be misspelled
     despite the vocabulary setting; `cue find ID --phrase TEXT` locates a phrase.

   Notes instead of a recording: the same steps, from the text.
2. **Map** each take to a change on the to-review list by the name said aloud, else by what is on
   screen. A part that maps to no change becomes a question.
3. **Sort** every remark into one item, with the owner's quote, its time (`m:ss`), its frame, the
   change, and the scenario and check it concerns:

   | Item | When |
   |---|---|
   | approved | the owner says a scenario works |
   | bug | it behaves against its scenario |
   | change | it works as specified, and the owner wants it otherwise |
   | question | the owner asks something, or the remark is unclear |

4. **The build.** A `pass` or `fail` counts only for a build that contains the change's landing
   commit. The build's identifier (`build <version>` in the PROOF line) is the one AGENTS.md names;
   find its commit by AGENTS.md's build-to-commit rule, then
   `git merge-base --is-ancestor <landing commit> <build commit>`. Where AGENTS.md says nothing,
   ask the owner whether build `<version>` includes `<landing commit>`. A remark on a build without
   it, or on a scenario whose text changed on main after the change landed, becomes a question.
5. **Confirm once.** Show the whole list (in chat, or a local page with the frames) with the build
   and who checked, as the owner said them; ask for whatever was not said, and never guess a build.
   The owner corrects it; apply every correction. Write nothing before this.
6. **Record**, per repository, on a new branch from a freshly fetched `origin/main`, in a worktree
   as AGENTS.md says:
   - **approved:** each check the owner covered becomes
     `- **PROOF** <check>: pass <YYYY-MM-DD>, build <version>, by <who>[; <note>]`, dated the day
     of the review. Nothing else in the spec changes.
   - **a bug seen on a check:** `- **PROOF** <check>: fail <YYYY-MM-DD>, build <version>, by <who>; <note>`.
   - **a check the owner says no longer applies:** remove its PROOF line, the scenario's text left
     as it is; the scenario always keeps at least one PROOF line (else ask the owner which check
     or test stands in).
   - **a change approved in full:** `git rm -r changes/<id>/`. A `changes-requested` change is
     removed when the owner has approved every change in its `follow-ups`.
   - **bugs and changes:** the reviewed change's `proposal.md` gets `review: changes-requested`,
     and a new change id (free on main and as a branch) joins its `follow-ups`.
   - **questions:** answer each from the facts, or carry it into the new change's rounds.
7. **Land the results through ship.** Commit in AGENTS.md's commit style (for example
   `docs(specs): record the review of <ids>`). The pull request's `## What and why` lists each
   recorded result with the owner's quote and time, which the reviewer checks every `pass` and
   `fail` line against. One pull request per repository.
8. **The follow-up changes**, one per fix (related items may share one), each under the id step 6
   gave it: **spec**, with the owner's items as settled questions, quoted with their times, asking
   only what is still unclear; spec's hand-over then decides between design and ship. Copy each
   frame a change cites into `changes/<new-id>/evidence/<what-it-shows>.png` (a stereo frame
   cropped to one eye: `ffmpeg -i <frame> -vf crop=iw/2:ih:0:0 <out>`) and cite it in
   `proposal.md` with its quote and time.

Tell the owner what was recorded, what was opened, and every question still open.
