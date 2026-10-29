# `tools/setup-agents` — one checkout's agent setup

```
node tools/setup-agents/setup.mjs            # set up this checkout
node tools/setup-agents/setup.mjs --unlink   # remove the skill links it made, nothing else
```

Run it once in every checkout and every worktree, from anywhere inside it; it works on the checkout
that holds the script. Node 20 or later, no install step. A link already in place is left as it
is, so running it again is also the repair when a link has drifted.

It links every `.agents/skills` folder (tracked, or untracked and not ignored), whole, into its
sibling `.claude/skills`: a junction on Windows (no admin, no Developer Mode), a relative symlink
elsewhere.

Why the links: skills are written once in `.agents/skills/`, which Codex reads natively; Claude Code
reads only `.claude/skills/`. Each checkout links to its own tree, so a branch's skill edits are the
ones its sessions see. The links are ignored by anchored `.gitignore` entries, one per location
(`/.claude/skills` at the root, `/<dir>/.claude/skills` for a nested one, with no trailing slash:
to git a symlink is not a directory); a new `.agents/skills` location needs its own entry, and the
script reports a link git does not ignore.

What it reports (exit 1, once every folder it can link is linked):

- A real `.claude/skills` folder with content. It is never deleted; move what it holds into the
  sibling `.agents/skills` or delete it, then run setup again. An empty one is replaced by the link.
- A `.claude/skills` link git does not ignore.

Outside a git checkout it does nothing and exits 1; an unknown flag prints the usage and exits 2.

A link that points anywhere other than its sibling (a moved checkout, a copied tree) is replaced.
Removing a link never touches the skills it points at; `git clean -fdX` removes only the link.

**Run `--unlink` before checking out a branch that lacks these ignore entries** (such a branch may
track files under a `.claude/skills` path this checkout links, a skill kept there rather than in
`.agents/skills`), and run setup again on the way back. On macOS and Linux git replaces the ignored
symlink, and a link the branch does not ignore shows as untracked there. On Windows, with the
junction in place, Git for Windows checks out through it and aborts with
`fatal: cannot create directory at '<dir>/.claude/skills/<skill>'`. The branch stays where it was,
but the working tree is half switched:
- files only the current branch has are deleted, its `.agents/skills` files and setup itself among them;
- files both branches hold in different versions carry the other branch's version (`.gitignore`, say);
- files only the other branch has may stand untracked.

Your own uncommitted edits survive, since git refuses to start over them. To recover, with
`<branch>` the one you tried to check out and `<link>` the `.claude/skills` path the error names
(`<dir>/.claude/skills`), run from the checkout's root:

```
# Git Bash
node -e "require('fs').rmSync('<link>', { force: true })"
git diff -z --no-renames --name-only --diff-filter=DM HEAD <branch> | git restore --pathspec-from-file=- --pathspec-file-nul
git diff -z --no-renames --name-only --diff-filter=A HEAD <branch> | xargs -0 rm -f --
```

```
# PowerShell
node -e "require('fs').rmSync('<link>', { force: true })"
git -c core.quotePath=false diff --no-renames --name-only --diff-filter=DM HEAD <branch> | ForEach-Object { git restore -- $_ }
git -c core.quotePath=false diff --no-renames --name-only --diff-filter=A HEAD <branch> | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
```

The first line removes the dangling link; the second restores what was deleted or overwritten; the
third removes what the other branch brought. `--no-renames` matters: without it a skill that one
branch holds under `.claude/skills` and the other under `.agents/skills` reads as a rename and is
not restored. `git status` then shows only your own edits; run
`node tools/setup-agents/setup.mjs --unlink` and check out again.

## Tests

```
cd tools/setup-agents && npm test   # node --test; throwaway checkouts in the OS temp folder
```

They copy the script into a throwaway checkout and check the links it makes and keeps, what it
reports and leaves alone, and that `--unlink` removes only its links.
