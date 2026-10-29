# Design: <change title>

## Context

<What exists that this change builds on, and the constraint that shapes the design. Name the
modules and files.>

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| <what had to be decided> | <the choice> | <option>: <why not>; <option>: <why not> | <the platform's or library's own docs, a maintained reference: title and URL> |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | <each module, and the README that changes with it> |
| State on the network | <who owns each piece of state, who may change it, how it reaches the others> |
| Formats and contracts | <each file format or API contract, its version, the migration, the reader on the other side> |
| Storage | <what is stored where, how long, what happens to what is already stored> |
| The other repository | <its side under this change id, and the contract between the two; without `specs/` there, the ordinary pull request that carries its side> |

Leave out a row that does not apply.

## Test plan

| Scenario or logic | Test |
|---|---|
| <scenario name> | `<path>::<selector>`, <new or existing> |
| <new logic, as the ship skill defines it> | `<path>::<selector>`, unit test |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| <scenario name> | <desk, headset, two-headsets, printed-card or live-tenant> | <what they do, and what passes> |

## Risks

- <What could go wrong, how the design limits it, and how we would notice.>
