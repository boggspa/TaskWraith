# Host Arc — Wave 0 Baseline

Captured by **@GrokBG** (background lane) for the TaskWraith Host Arc mission.
Source goal (uncut): [`docs/HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md).
Durable TaskWraith goal id: `goal-1785776581326-b5gik2` (store objective truncates at `"Do not remove,"`; this repo copy is authoritative for architecture, waves, and the 15 acceptance points).

## Snapshot (re-checked at documentation write)

| Item | Value |
| --- | --- |
| **HEAD** | `f608f748f0ab1ea462eba5691dc322f15e4898ae` (`f608f748f`) |
| **Tip subject** | `feat(renderer): polish fan-out disclosure` |
| **Tip date** | 2026-08-03 17:38:28 +0100 |
| **Branch** | `master` |
| **vs origin** | **+58** commits ahead of `origin/master` |
| **Package** | `taskwraith@1.9.2` |
| **Dirty (pre-existing)** | `?? Note for SolBoss and GrokCapt.md` **only** — do **not** stage, edit, or delete |
| **Live markers (pre-write)** | none |
| **work-guard (pre-write)** | no claims; 1 aged unclaimed dirty path (the note) |
| **Documentation write claim** | `.WORK-IN-PROGRESS-host-arc-wave0-docs.md` claims only `docs/HOST_ARC_GOAL.md` and `docs/HOST_ARC_WAVE0_BASELINE.md` |

## Forbidden zero-diff paths

Do not edit or redesign during Host Arc work:

- `src/main/workLocks/**`
- `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`
- workspace-lock marker / provenance behavior
- `scripts/work-guard*`
- `.githooks/**`
- provider admission, retirement, or live membership
- provider permission ceilings / security walls
- unrelated history-deletion machinery

Composition roots (avoid domain logic; tiny wiring only with recon proof + exact-scope + **@CodexBoss** approval):

- `src/main/index.ts`
- `src/renderer/src/App.tsx`
- `src/main/services/EnsembleOrchestrator.ts`

Additional process rules from the goal:

- No worktrees for this arc.
- Preserve unrelated dirty/untracked work (especially the SolBoss/GrokCapt note).
- Exact markers, disjoint scopes, exact path staging, prompt commits.
- Never bulk stage (`git add -A` / `.` / `-u`) or repo-wide format (`format:all`).
- No version bump, release, publication, push, or notarisation unless the user separately requests it.

## Baseline gates (inventory — not executed in Wave 0 docs write)

- `test`
- `typecheck` / `typecheck:node` / `typecheck:web` / `typecheck:tui`
- `format:ratchet` (never `format:all`)
- `guard:doctrine-integrity`
- `guard:provider-intent`
- `test:swift:ios-kit`
- `test:swift:bridge`
- `tui:build`
- `ci`

## Unique participant aliases

Always address by seat role (examples). **Never** bare `@grok` or `@cursor` (ambiguous; fail-closed):

| Role | Alias |
| --- | --- |
| Boss | `@CodexBoss` |
| Captain | `@KimizCaptain` |
| Background | `@GrokBG` |
| Work | `@GrokWork1`, `@CursorWork1`, `@GrokWork2`, `@CursorWork2`, `@CursorWork3` |
| Review | `@CursorReview1`, `@GrokReview1`, `@CursorReview2`, `@GrokReview2`, `@CursorReview3` |
| Scout | `@GrokScout1`…`@GrokScout5`, `@CursorScout1`…`@CursorScout12` |

## Handoff conventions (Wave 0 proposal — Boss/Captain may amend)

### Scout reports

Each scout returns:

1. **domain**
2. **paths/symbols** (existing machinery)
3. **gaps**
4. **risks**
5. **smallest safe slice**
6. **tests** / evidence hooks

### Commits

- Stage **exact paths only**.
- Raise a self-expiring `.WORK-IN-PROGRESS-*.md` marker before first edit of clean paths; drop it in the same breath as the final commit.
- Keep scopes disjoint across concurrent writers.
- Preserve `Note for SolBoss and GrokCapt.md` untracked and unstaged.

### Review

- Review seats are **read-only** unless explicitly promoted.
- Clear **P0 / P1** and mission-blocking **P2** before advancing.
- Forbidden paths must show **zero diff**.

### Authority

- **@CodexBoss** gates implementation and may mark goal complete.
- **@KimizCaptain** owns Wave 1 architecture synthesis; may complete goal if Boss is unavailable.
- **@GrokBG** runs background shell/file work only inside Boss/Captain-approved write scopes.

## Wave map (from goal)

| Wave | Focus |
| --- | --- |
| 0 | Baseline, goal board, forbidden paths, handoffs |
| 1 | Read-only recon (all scout domains) + Captain architecture proposal |
| 2 | Host protocol contract over current authority |
| 3 | Host extraction + supervised runtime |
| 4 | Desktop / TUI / iOS client cutovers |
| 5 | `.twmission` flight recorder |
| 6 | Adversarial review (P0–P3) |

## Final acceptance (15 points — see goal for full text)

1. Dedicated Host canonical and supervised.
2. Desktop, TUI, iOS same generation/cursor.
3. Providers survive Desktop renderer/window restart.
4. Desktop reconnect without duplicate turns/commands.
5. iOS question answer → same receipt on Desktop/TUI.
6. TUI mission control parity elsewhere.
7. Controlled Host restart durable + idempotent.
8. Duplicate/out-of-order deltas do not corrupt clients.
9. `.twmission` replay deterministic; corrupt bundles rejected.
10. No multi-GB archive scans on UI-critical paths.
11. Slow clients cannot stall Host or peers.
12. No provider capability/permission/admission reduction.
13. Forbidden lock/provenance paths zero diff.
14. Focused tests, typechecks, Swift, a11y, format ratchet, guards, production builds pass.
15. Commits, markers, limitations, tree state reconciled.

## Documentation write notes

- Scope for this commit: **only** `docs/HOST_ARC_GOAL.md` and `docs/HOST_ARC_WAVE0_BASELINE.md`.
- Product code, forbidden paths, and the pre-existing note are untouched.
- Full goal recovered from the user-supplied Host Arc prompt (chat store / ensemble round prompt), not the truncated durable-store objective field.
