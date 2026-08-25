# TS6305 residual in web typecheck (`src/main/store/types.d.ts`)

- **Date:** 2026-08-25
- **Owner:** build/tooling maintainers (documented by Ensemble round, Work3 seat)
- **Status:** RESOLVED (2026-08-25) — fixed in tsconfig.web.json; see "Resolution" below

## User-visible scar

`npm run typecheck:web` (`tsc --noEmit -p tsconfig.web.json`) always reports
exactly one error:

```
error TS6305: Output file '.../src/main/store/types.d.ts' has not been built
from source file '.../types.ts'.
  The file is in the program because:
    Matched by include pattern 'src/main/store/types.ts' in 'tsconfig.web.json'
```

Developers may mistake this for a real defect and attempt tsconfig surgery,
which historically regressed the tree badly.

## Root cause

`tsconfig.web.json` (a) lists `src/main/store/types.ts` in its `include`,
making it an explicit root of the web program, and (b) declares
`references: [{ path: "./tsconfig.node.json" }]`. Under `composite: true`,
TypeScript honors that reference and expects the node project's *built*
declaration output for cross-project roots — but the typecheck scripts run with
`--noEmit`, so the node project never emits `types.d.ts`. The single TS6305 is
therefore a structural artifact of `--noEmit`-mode compositing, not a source
error. All actual code checks are clean: strict composite node = 0 boundary
errors; web = exactly this one reference-resolution error.

## What prevents recurrence / what NOT to do

- Do **not** restructure includes/references to silence it: two prior probes
  regressed to 1,156 TS6305 + 374 TS6307 errors.
- Do **not** delete cross-project imports from consumers (e.g. gutting
  `src/preload/index.d.ts`) — that erases the `window.api` type surface and
  floods renderers with TS2339.
- Do **not** remove `src/main/store/types.ts` from the web include list as a
  standalone change: without the explicit root, TypeScript resolves ALL
  cross-project imports through the reference's declaration outputs and the
  typecheck floods with TS6305s (reproduced 2026-08-25).

## Resolution (2026-08-25)

Three coordinated changes in `tsconfig.web.json`, verified to leave
`npm run typecheck` at zero errors:

1. Removed the `"references": [{ "path": "./tsconfig.node.json" }]` block.
   The typecheck scripts run `tsc -p --noEmit` (never build mode), so the
   reference only ever caused TS6305 expectations of built declaration
   outputs.
2. Added `"disableSourceOfProjectReferenceRedirect": true` so any remaining
   cross-project module resolution reads `.ts` sources directly instead of
   demanding `.d.ts` emit.
3. Kept `src/main/store/types.ts` as an explicit include root (see the
   warning above).
