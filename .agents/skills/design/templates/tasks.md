# Tasks: <change title>

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. <group: one module or concern>

- [ ] 1.1 <work>; test: <path::selector or command>
- [ ] 1.2 <work>; check: <scenario name>
- [ ] 1.3 Update <README nearest the code> to state what the code does; test: node tools/gate/gate.mjs --local

## 2. <group> (after 1)

- [ ] 2.1 <work>; test: <path::selector or command>
- [ ] 2.2 Update <README nearest the code> to state what the code does; test: node tools/gate/gate.mjs --local
