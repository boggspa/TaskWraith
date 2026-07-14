# fable/ios-parallel — merge handoff

Parallel iOS branch worked in an isolated worktree while the desktop
security/QA session held the main checkout. Base: `8e2162aae`. Scope
discipline: every commit touches `ios/**` only, staged by explicit pathspec;
`ios/interop/` untouched; no root configs, no `src/**`, no
`swift/TaskWraithBridge/**`.

## Merge priority

**`843e5b13e` first if cherry-picking anything** — ComposerDiffPill one-ULP
GeometryReader→@State layout livelock at 440pt/420pt iPhone widths (17 Pro
Max, Air). On simulators it wedges launch behind the LaunchScreen at 100%
CPU; on hardware the launch watchdog would kill the app whenever a diff pill
mounts at those widths. Root-caused with main-thread sampling + an lldb
hardware watchpoint (evidence preserved in the session scratchpad); fixed by
quantizing the two measurement feedbacks to whole points.

## Commits (oldest → newest)

| Commit | What | Notes |
| ------ | ---- | ----- |
| `57ffe5686` | Reveal terminal drain on stream exit | `streamingTerminalThreads` + `TokenRevealText.isComplete` |
| `c22cb7025` | Screenshot automation v1 (XCUITest) | Superseded by `0c5a7a15d`; kept for the `-tw-demo` hook history |
| `3b2bf11ef` | Workflow write-actions contract spec | **Mac-side follow-up**: new bridge actions `workflowSetEnabled`/`workflowRunNow` |
| `ec7795a47` | Drain fix adversarial hardening | Store pipeline (flip was invisible to the store-gated transcript), alias-resolved lookup, stale-exit runId guard |
| `843e5b13e` | **ComposerDiffPill layout-livelock fix** | Real-device risk — see above |
| `53a985283` | Spec: posture-escalation gate | `workflowRunNow` must not dispatch at saved posture for a plan-clamped phone |
| `0c5a7a15d` | simctl screenshot harness | XCUITest dropped (snapshot queries time out); Debug-only launch hooks; ASC-exact captures |
| `c12443221` | Parity audit MEDs | Chip reasoning tier ramp + `TWTheme.mix`, inline-code sunken treatment, dedicated diff palette (11 sites) |
| `ef075d376` | Parity audit LOWs | CodeMirror editor palette + light variant, `ask_user_question`→diagnostic glyph, bossCrown + glow |
| `8df7b1feb` | Kimi doc correction | Accent keys off `--provider-kimi-color` #0073E6 both platforms |
| (docs pass) | README harness section, DESIGN.md v0.42, listing + privacy drafts, this file | |

## Verification state

- `swift test` in `ios/TaskWraithKit`: **407 tests / 54 suites green**
  (baseline was 403; +2 drain, +1 store-gate, +1 stale-exit).
- `xcodebuild build` (app target, generic iOS Simulator): clean.
- Screenshot harness: 6/6 captures render ≤5s at exact ASC dimensions on
  iPhone 17 Pro Max + iPad Pro 13" (M5), all unique — this end-to-end
  exercises demo mode, the livelock fix, and the deep-link hooks.
- Adversarial review pass ran over the branch; every CONFIRMED finding was
  fixed in `ec7795a47`/`53a985283`/`0c5a7a15d` (refuted-findings list lives
  in the session transcript).

## Reconciliation notes

- No expected conflicts: the branch never touches files the desktop session
  edits. The only shared surface is git itself.
- `vitest.config.ts` at base already ignores local QA worktrees; this
  worktree lives OUTSIDE the repo dir (`~/Documents/AGBench-fable-ios`) so
  desktop tooling never sees it either way.
- After merge, delete the worktree + branch:
  `git worktree remove ~/Documents/AGBench-fable-ios && git branch -d fable/ios-parallel`.

## Open items by owner

- **Mac/desktop session (Codex):** wire the workflow write-action bridge
  contract (`ios/WORKFLOW-WRITE-ACTIONS.md`, incl. the posture-escalation
  gate); add the `src/shared/contextWindows.ts` ↔
  `ContextWindows.swift` drift-guard test (tables verified in sync 2026-07-14,
  guard is comment-only today).
- **User/console:** host the privacy policy (draft:
  `ios/TaskWraithApp/PrivacyPolicy-DRAFT.md`), ASC privacy questionnaire +
  listing (draft: `ios/TaskWraithApp/AppStoreListing.md`), screenshot upload,
  export-compliance answer per build, APNs `.p8` for closed-app push.
- **iOS (post-contract):** swipe actions/context menu on workflow rows once
  the bridge actions land (small; pattern in the spec doc).
