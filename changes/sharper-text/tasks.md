# Tasks: Sharpen text by bundling an auto-hinted Figtree

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks.

## 1. The hinted faces

- [x] 1.1 `scripts/hint-figtree.py` builds reproducible hinted WOFF2 faces per weight and subset; test: two runs give identical files (md5)
- [x] 1.2 `src/ui/fonts.css` declares them with the package's unicode ranges; test: src/ui/fonts.test.ts::ships hinted static Figtree faces
- [x] 1.3 Every weight the styles use has a face; test: src/ui/fonts.test.ts::declares a face for every weight the styles use
- [x] 1.4 The app and Storybook import `fonts.css`, the token names `Figtree`, the package moves to devDependencies; test: src/ui/fonts.test.ts::is the family the app and Storybook set text in
- [x] 1.5 Text is sharp at 100% in the installed app; check: Text renders sharply at 100% display scaling
- [x] 1.6 docs/DESIGN.md Typography and README.md state where the faces come from; test: node tools/gate/gate.mjs --local
