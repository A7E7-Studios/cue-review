---
name: triage
description: Turn the owner's review of merged features into results. With no input, list what waits for the owner's review (every feature that is unreviewed, grouped by where the owner looks at it, and every feature with changes requested and the change that answers it) as one checklist. With CueReview sessions (their Copy for agent text or ids), review notes or feedback, map each remark to a feature, record the owner's verdict per feature (approved or changes-requested) in its spec's review key, delete the change folders whose features are all approved, and start a change for each bug or gap. Use for what is waiting for my review, a CueReview recording, or the owner's review results, notes or feedback on merged features. Not for reviewing code or a pull request.
---

# Triage the owner's review

The owner reviews features after the merge, each as a whole. You turn that review into `review`
verdicts, deleted change folders and new changes. **Only the owner's words set `approved` or
`changes-requested`**; never infer one. Formats: `specs/README.md` (Review) and
`changes/README.md` (Lifecycle). **Restricted material** (what AGENTS.md marks restricted) never
appears on a page you show, in a change folder or in a pull request body: describe the defect,
never the model.

## A. No input: the to-review list

1. `git fetch origin` in this repository and in each other repository AGENTS.md names.
2. `node tools/overview/overview.mjs --repo <id>=<checkout> [--repo <id>=<checkout>] --summary
   --out <scratch>/overview.json`.
3. Build the checklist:
   - **Unreviewed:** every feature whose `capabilities[].review` is `unreviewed`, grouped by where
     the owner looks at it: the `## Review` of each change on main that names it (a desk, a device,
     a second person, an account). Per feature: its title, Summary and Looks, the change that
     landed it with its commit, date and pull request (`landed` in the JSON), the scenarios that
     change added or changed (`git show <landing commit> -- specs/`), and which of them are
     untested. Newest landed first within a group; a feature no change folder names sits in a
     group of its own.
   - **Changes requested:** every feature whose `review` is `changes-requested`, with the change
     that answers it (a change folder, branch or pull request naming it), or "none yet".
4. Give it in chat, or as a local HTML page outside the repository. Never commit it.
5. Suggest the recording: one CueReview session per source ("Record more" keeps the source, so a
   desk review and a device review are separate sessions), one take per feature, each opening
   with the feature's name said aloud.

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
     each. A stereo source (frames holding both eyes side by side): `--max-width 3200` (it never
     upscales); read one eye.
   - `cue moments ID`: the spoken pointing ("here", "this") with the cursor and the clicks. A device
     source has no cursor track: the pointing is the hand, the finger or the gaze in the frame.
   - `cue frame ID --at-ms MS` and `cue clip ID --start-ms A --end-ms B` where a remark needs a
     closer look. Times are estimates: check the neighbouring frames. Names may be misspelled
     despite the vocabulary setting; `cue find ID --phrase TEXT` locates a phrase.

   Frames and clips are for you to look at; none is ever copied into the repository. Notes instead
   of a recording: the same steps, from the text.
2. **Map** each take and each remark to a feature on the to-review list, by the name said aloud,
   else by what is on screen. A part that maps to no feature becomes a question.
3. **Sort.** Per feature, the owner's verdict, and every remark as one item with the owner's words,
   its time (`m:ss`), the session id and the feature (and the scenario, when one fits):

   | Item | When |
   |---|---|
   | approved | the owner says the feature is right as its spec and Looks state it |
   | bug | the build differs from the spec |
   | gap | the build does what the spec says, and the owner wants what the spec does not cover |
   | question | the owner asks something, or the remark is unclear |

   The verdict is the one the owner gave; where the owner raised a bug or a gap and gave none, ask
   in step 5. A feature the owner did not reach stays `unreviewed`.
4. **The build.** A verdict counts only for a build that contains the landing commit of every
   change naming the feature. Identify the build as AGENTS.md says, find its commit by its
   build-to-commit rule, then `git merge-base --is-ancestor <landing commit> <build commit>`. Where
   AGENTS.md says nothing, ask the owner whether the build includes `<landing commit>`. A remark on
   a build without it, or on a feature whose spec text changed on main since, becomes a question.
5. **Confirm once.** Show the whole list (in chat, or a local page) with the build and the day of
   the review, as the owner said them; ask for whatever was not said, and never guess a build.
   Questions go to the owner as spec's Rounds ask: through the harness's question tool when there
   is one, else in spec's text format. The owner corrects the list; apply every correction. Write
   nothing before this.
6. **Record**, per repository, on a new branch from a freshly fetched `origin/main`, in a worktree
   as AGENTS.md says:
   - **each verdict:** the feature's `review:` becomes `approved` or `changes-requested`. Nothing
     else in the spec changes: no note, build or reviewer.
   - **each change folder** whose features are all `approved`: `git rm -r changes/<id>/`. A folder
     with any feature not `approved` stays.
   - **questions:** answer each from the facts, or carry it into the new change's rounds.
7. **Land the results through ship.** Commit in AGENTS.md's commit style (for example
   `docs(specs): record the review of <features>`). The pull request's `## What and why` says when
   the owner reviewed and on which build, and lists each verdict with the owner's words and time,
   which the reviewer checks every `review` value against. One pull request per repository.
8. **The feedback changes**, one per fix (related items may share one), each under a new change id
   free on main and as a branch: **spec**, naming the feature, its proposal's Why holding each
   remark as text (the owner's words, `m:ss`, the CueReview session id, the feature, and whether
   it is a bug or a gap), and settled questions for what the owner already decided, asking only
   what is still unclear. What a frame shows is described in words. Spec's hand-over then decides
   between design and ship; when the change lands, the feature is `unreviewed` again.

Tell the owner what was recorded, which folders were deleted, what was opened, and every question
still open.
