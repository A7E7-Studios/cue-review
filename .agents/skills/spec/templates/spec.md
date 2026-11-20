---
title: <Feature name>
review: unreviewed
code:
  - <repo-relative folder ending in />
  - <repo-relative file>
---
# <Feature name>

## Summary

<What the feature does for the person using it, when they meet it, and why it matters: a few
sentences a non-developer understands. No class names, no history.>

## Looks

- looks/<board-name>.html#<section-id> — <what the design shows; drop ## Looks for a feature with no visual side>
- page: <path in the app, or a URL> — <what to open and do to see it built>

## Requirements

### Requirement: <a short statement of one behaviour>
When <the event or state>, the <app | site | service> SHALL <behaviour>, because <the reason it
matters to the person>.

#### Scenario: <the outcome, named as a person would tell it>
- **GIVEN** <a starting state that is not the default; drop the line otherwise>
- **WHEN** <what the person or the system does>
- **THEN** <what the person observes>
- **PROOF** test: <repo path to the test file>::<Class.Method>
