# Tasks: <change title>

Each task is one line and names the test that proves it: `test:` a test path with its selector, or
a command. A task is ticked when its test passes. Each code path the proposal's `## What changes`
names has its own task and test. Where no automation reaches a path or a scenario, the pull request
names it under `## Not verified`; such a scenario has no task of its own. Each group ends by
updating the README nearest the code it changes.

## 1. <group: one module or concern>

- [ ] 1.1 <work>; test: <path::selector or command>
- [ ] 1.2 <work>; test: <path::selector or command>
- [ ] 1.3 Update <README nearest the code> to state what the code does; test: node tools/gate/gate.mjs --local

## 2. <group> (after 1)

- [ ] 2.1 <work>; test: <path::selector or command>
- [ ] 2.2 Update <README nearest the code> to state what the code does; test: node tools/gate/gate.mjs --local
