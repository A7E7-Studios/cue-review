# Kit sync

A project takes the kit as a vendored copy: real files in its own tree, pinned to one kit commit by
`tools/kit/lock.json`. `sync.mjs` writes that copy and the lock; the gate's
[`kit` check](../gate/README.md#checks) fails a pull request whose copy differs from its lock. No
submodule (every worktree holds real files, skills included) and no package manager (a project
need not have one).

No npm dependencies; Node 22 or later.

```
node tools/kit/sync.mjs --kit <kit checkout> [--ref <rev>]        # from a project that carries the kit
node <kit checkout>/tools/kit/sync.mjs --project <dir> [--ref <rev>]  # the first time
node tools/kit/sync.mjs --check [--rev <rev>]                      # is the committed copy as the lock says?
```

| Option | Does |
|---|---|
| `--kit <dir>` | the kit's checkout; default the checkout holding the script, when it is the kit (it has `kit.json`) |
| `--ref <rev>` | the kit revision to take; default `origin/main`. Fetch first: nothing is fetched |
| `--project <dir>` | the project; default the repository holding the current directory |
| `--force` | take the kit's file over one the project changed |
| `--dry-run` | print what would change, write nothing |
| `--check` | compare the project's copy at `--rev` (default `HEAD`) with its lock, as the gate does |

Exit: **0** done, **1** refused (nothing written), a file under the kit's paths that the kit lacks
(everything else written), a write that failed part way (it says so; `git status` shows what it
wrote), or with `--check` a copy not as its lock says; **2** usage or setup error, a project that
stores SHA-256 objects among them.

## What it does

1. Reads the kit at `--ref` through git objects (its working tree never matters) and its
   `kit.json`: the `paths` the kit owns (a folder ends `/`), the `projectOwned` files inside them
   that each project keeps as its own, and the `starters` a project's own files begin from.
2. Compares each kit file with the project's working tree, by git blob id as git would store the
   file (its clean filters applied, so a checkout's line endings are no change).
3. **Refuses**, writing nothing, when the project changed a kit file: one that differs from what
   the old lock records, or that has uncommitted changes; a file the project owned that the kit
   now ships counts as the project's. `--force` takes the kit's. On the first sync, with no lock
   yet, a committed hand copy is replaced, and each such file is printed as `replace`. It refuses
   even with `--force` (and `--dry-run` says so) when the project's git ignores a kit file, which
   would never be committed, and when a file it would write or delete is a link or lies through a
   link or junction outside the project. A project that stores SHA-256 objects is not supported.
4. Writes every kit file that differs, deletes the files the old lock lists that the kit no longer
   has (and folders they leave empty), and writes each starter that the project lacks
   (`tools/gate/config.json` from `config.template.json`); a project's own file is never
   overwritten.
5. Reports any other file under the paths the kit owns now, and leaves it: the gate's `kit` check
   fails on it until it moves out or into the kit. A folder the kit no longer owns loses only the
   files the old lock lists.
6. Writes `tools/kit/lock.json`. The person reviews the diff and commits it.
7. Warns when the project's `tools/gate/config.json` protects no path holding the lock (below).

## The lock

```
{ "version": 1,
  "kit": { "repository": "<the kit's origin URL, no credentials; null for a local folder>", "commit": "<full sha>" },
  "paths": ["tools/gate/", "specs/README.md", …],
  "projectOwned": ["tools/gate/config.json", "tools/kit/lock.json"],
  "files": { "<path>": "<git blob id, what git hash-object prints>" } }
```

The project owns the lock: sync writes it, nobody edits it. With `tools/kit/**` among the
project's protected paths, a pull request that moves the lock, and with it the kit's files, is
merged by the owner. The starter config lists it; a project whose config predates the kit adds it,
and sync warns until it does.

## Tests

```
cd tools/kit && npm test      # node --test; a throwaway kit and project in the OS temp folder
```

The tests sync a kit into a project, update it (added, updated, deleted, unchanged), refuse and
force over a project's edit, dry-run, replace a hand copy on the first sync, keep a CRLF checkout
unchanged, take back a project-owned file, drop a folder, refuse over an ignored file, a file link,
a junction out of the project (on a write, a delete and a dry run) and a SHA-256 project, keep local
paths out of the lock, warn about an unprotected lock, and check the gate's `kit` check and
`--check` agree.
