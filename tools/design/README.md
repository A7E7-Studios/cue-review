# Design

The kit's house style: a starting design system for a project that has none of its own. The
[design skill](../../.agents/skills/design/SKILL.md) builds every visual direction on a project's
tokens and critiques it against its brief; these two files are what it uses until the project
names its own.

| File | What |
|---|---|
| [`house-style/tokens.css`](house-style/tokens.css) | CSS custom properties by role: the font stack, type sizes, spacing, control heights, radii, motion and colours, for a light theme and a dark one (`[data-theme="dark"]`, or the system setting unless `[data-theme="light"]`). Nothing is loaded from the network. |
| [`house-style/brief.md`](house-style/brief.md) | the style brief: the principles a design is critiqued against, and the reference products it is measured by |

## How a project uses it

A project's `tools/gate/config.json` names its design system in its `design` block
([its keys](../gate/README.md)). The starter config points at the house style:

```json
"design": {
  "tokens": "tools/design/house-style/tokens.css",
  "brief": "tools/design/house-style/brief.md"
}
```

A board the design skill draws copies the token values it uses into its own inline CSS, so a
committed board stays self-contained whichever tokens it was built on.

## Who owns these files

The sync owns `tools/design/`: every sync overwrites it with the kit's version. A project never
edits these files. To restyle, it keeps its own tokens and brief in a folder of its own (a copy of
these as a start, or its component library's tokens) and points its `design` block at them.
