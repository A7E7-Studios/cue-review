---
name: design
description: Design a specified change before it is built - first its look (two or three visual directions built from the repository's component library, researched against current UX practice and shown to the owner on one page; the pick recorded in changes/<id>/look.md with its images), then its technical design (design.md, each decision researched) and tasks (tasks.md), approved by the owner in chat. Use after spec, or when asked for visual directions, mockups, a look or a technical design for a change.
---

# Design a change

The look first, and only when something seen or heard changes; then the technical design. The
owner picks and approves in chat; nothing is committed before that. There is no design pull
request. What each file holds is in its template (`templates/`).

## 0. Read

- The change on its branch, in its worktree: `changes/<id>/proposal.md` and the spec edits
  (`git diff origin/main...HEAD -- specs/`). No change folder yet: run **spec** first.
- From AGENTS.md: the component library and its tokens, how to render the running app, and the
  material it marks restricted, which never appears in an image or on a page.

## 1. Look

Skip to step 2 when nothing seen or heard changes.

1. **Now.** Render each screen and state the change touches as it is today, by AGENTS.md's render
   route.
2. **Research.** Current practice for this kind of interaction on the target platform: the
   platform's own guidelines and how two or three comparable products solve it. Three to five
   findings, each with its source.
3. **Directions.** Two or three that differ in kind, not in polish, each a board or a render built
   only from the library's components and tokens: the running app where that is cheap, else a
   board (for example an HTML page) rendered to PNG. Draw each in the default state and in the state
   that tells the directions apart, at most 1280 px wide, as
   `changes/<id>/look/directions/<direction>/<screen>-<state>.png`. Of a direction, only its PNGs
   are ever committed (§3); the code of a board or a throwaway render never is. Draw a component the
   library lacks as new, and name it.
4. **One page.** Show the owner one page: a local HTML file outside the repository, or the
   harness's page or artifact tool when it has one. On it: the current state, the directions side
   by side, each one's trade-offs against the research, and your recommended pick. For sound,
   describe it or attach the clip.
5. **Wait for the pick.** Nothing else happens until the owner picks, mixes, or asks for another
   round. A mix is a new direction: draw it and show it again.
6. **The pick in every state** its scenarios name, as `look/<screen>-<state>.png`, and
   `look.md` from `templates/look.md`.

## 2. Technical design

1. **Research each decision** in the platform's and the libraries' own documentation and other
   maintained references; its sources go in the Decisions table.
2. **`design.md`** from `templates/design.md`, when the work needs decisions. The other
   repository's side: under the same change id; a repository without `specs/` carries its side in
   an ordinary pull request there, which `design.md` names.
3. **`tasks.md`** from `templates/tasks.md`, when the work takes more than one step. Mark which
   groups depend on which: ship gives independent groups to separate sub-agents. New logic, as the
   ship skill's Build step defines it, gets unit-test tasks.
4. **Questions.** A question the design raises goes to the owner as spec's Rounds ask: through the
   harness's question tool when there is one, else in spec's text format; numbered after the last
   one asked (Q<n+1>), with options and the recommended one first. Fold each answer into
   `design.md`, and into `proposal.md`'s Settled questions and the spec when it changes a
   requirement.
5. **Wait for approval.** Give the owner the decisions, the calls for the owner and the human
   checks, in a few lines, and wait for the owner's approval in chat.

## 3. Commit

Only after the owner's approval (a look with no technical design: after the pick), so a committed
`look.md` or `design.md` is an approved one: commit on the change's branch in AGENTS.md's commit
style (for example `docs(changes): design <id>`) and push.
Open no pull request. Hand over to **ship**.
