---
name: design
description: Design a specified change before it is built - first its look (two or three visual directions drawn in HTML on the project's design tokens, researched against current UX practice, critiqued against the style brief and an accessibility list, and shown to the owner on changes/<id>/looks.html in the harness's built-in browser; the pick committed as a board beside the spec and recorded in words in changes/<id>/look.md), then its technical design (design.md, each decision researched) and tasks (tasks.md, each with its test), approved by the owner in chat. Use after spec, or when asked for visual directions, mockups, a look or a technical design for a change.
---

# Design a change

The look first, and only when something seen or heard changes; then the technical design. The
owner picks and approves in chat; nothing is committed before that. There is no design pull
request. What each file holds is in its template (`templates/`).

## 0. Read

- The change on its branch, in its worktree: `changes/<id>/proposal.md` and the spec edits
  (`git diff origin/main...HEAD -- specs/`). No change folder yet: run **spec** first.
- The design system: the `design` block of `tools/gate/config.json`. `tokens` is a CSS file of
  custom properties, `brief` the style brief (principles and reference products), `catalogues` the
  component catalogues and how to open an entry, `render` a command that renders the running app.
  Only `tokens` and `brief` are always there.
- From AGENTS.md: the component library, how to render the running app, where the owner reviews,
  and the material it marks restricted, which never appears on a board or a page.

## 1. Look

Skip to step 2 when nothing seen or heard changes.

1. **Now.** Render each screen and state the change touches as it is today (`render`, or AGENTS.md's
   render route), and draw it as HTML for the page of step 5: the feature's board sections where
   it has a board, else redrawn on the tokens.
2. **Research.** Current practice for this kind of interaction on the target platform: the
   platform's own guidelines and how two or three comparable products solve it. Three to five
   findings, each with its source.
3. **Directions.** Two or three that differ in kind, not in polish, each drawn in HTML only on the
   tokens (by role: `var(--…)`, never a raw value) and the catalogues' components. A component the
   catalogues lack is drawn as new, and named. They are drawn on the change's page of step 5,
   `changes/<id>/looks.html` in the change's worktree, which is self-contained as a board is: its
   CSS inline, the custom properties it uses copied from the tokens file into its own `:root`,
   nothing loaded from the network or another file. Each screen and state of a direction is one
   `<section id="<direction>-<screen>-<state>">`, drawn in the default state and in the state that
   tells the directions apart.
4. **Critique**, before the owner sees anything. Each direction against the brief: every principle,
   and how the reference products would do it. Then the accessibility list:
   - contrast: text 4.5:1, large text and control boundaries 3:1, in both themes;
   - focus: a visible focus on every control, and a focus order that follows the reading order;
   - hit sizes: at least 24 px, and the platform's own minimum on touch;
   - text scaling: the layout holds at 200 % text;
   - motion: nothing needed moves under reduced motion; nothing flashes;
   - colour is never the only cue: a word, an icon or a shape goes with it;
   - labels: every control and every meaningful image has one.

   Fix what fails, then critique again. What stays a trade-off goes on the page.
5. **One page.** The page is `changes/<id>/looks.html` in the change's worktree. On it: the current
   state, the directions side by side, each one's trade-offs against the research and the
   critique, and your recommended pick. For sound, describe it. Open it for the owner in the
   harness's built-in browser, give its path, and ask for the pick as the technical design's
   Questions step asks, your recommended pick first.
6. **Wait for the pick.** Nothing else happens until the owner picks, mixes, or asks for another
   round. A mix is a new direction: draw it on the page, critique it and show it again.
7. **The pick.** A board per feature, `specs/<domain>/<capability>/looks/<name>.html` (a second
   only when one outgrows its 30720 bytes), self-contained as the page is, holding every state the
   scenarios name as a `<section id="<screen>-<state>">`. The spec's `## Looks` names each section
   the owner should see, `- looks/<name>.html#<id> — <caption>`, and where the built feature can be
   seen, `- page: <path or URL> — <caption>`. `look.md` from `templates/look.md` records the pick,
   the directions rejected, the critique and the accessibility results in words. `looks.html` is
   committed with `look.md`, and goes when triage deletes the change folder: the directions not
   picked stay only there. No image file is ever committed.

## 2. Technical design

1. **Research each decision** in the platform's and the libraries' own documentation and other
   maintained references; its sources go in the Decisions table.
2. **`design.md`** from `templates/design.md`, when the work needs decisions. The other
   repository's side: under the same change id; a repository without `specs/` carries its side in
   an ordinary pull request there, which `design.md` names.
3. **`tasks.md`** from `templates/tasks.md`, when the work takes more than one step. Each task
   names the test that proves it. Mark which groups depend on which: ship gives independent groups
   to separate sub-agents. New logic, as the ship skill's Build step defines it, gets unit-test
   tasks.
4. **Questions.** A question the design raises goes to the owner as spec's Rounds ask: through the
   harness's question tool when there is one, else in spec's text format; numbered after the last
   one asked (Q<n+1>), with options and the recommended one first. Fold each answer into
   `design.md`, and into `proposal.md`'s Settled questions and the spec when it changes a
   requirement.
5. **Wait for approval.** Give the owner the decisions, the calls for the owner and the scenarios
   no test reaches, in a few lines, and wait for the owner's approval in chat.

## 3. Commit

Only after the owner's approval (a look with no technical design: after the pick), so a committed
board, `look.md` or `design.md` is an approved one: commit on the change's branch in AGENTS.md's
commit style (for example `docs(changes): design <id>`) and push.
Open no pull request. Hand over to **ship**.
