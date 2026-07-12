# How to: Motion, transitions & haptics

**Platform:** Electron + iOS
**Audience:** contributors and design reviewers (not an end-user product tour)

This page is the durable motion vocabulary for TaskWraith’s multi-platform
polish pass. Prefer these tokens and recipes over one-off timings. The north
star is **DigitOdometer-style** motion: subtle, fast, slightly skeuomorphic —
never heavy FX or layout thrash.

For the user-facing reduce-motion control, see
[Appearance tab](../settings-and-configuration/appearance-tab.md)
(**Settings → App → Appearance → Reduce motion**).

---

## Design principles

1. **Subtle + fast** — roughly **120–300ms** for UI chrome; DigitOdometer’s
   **430ms** roll is grandfathered and is not retokened.
2. **Compositor-friendly** — animate **transform** and **opacity** only for new
   work. Do not animate layout properties (`width`, `height`, `top`, `left`,
   `margin` for generic presence) except the legacy sidebar/dock resize path
   (see [Grandfathered panel presence](#grandfathered-panel-presence)).
3. **Reduce-motion always** — every new animation must honor:
   - Electron: `:root[data-reduce-motion]` **and** `@media (prefers-reduced-motion: reduce)`
   - iOS: `@Environment(\.accessibilityReduceMotion)` + `ComposerMotion.reducedFade`
4. **Row/card roots only** — transitions belong on stable groups (cards,
   banners, chips, panels), never deep children or streaming text nodes.
5. **No new animation libraries** — no framer-motion, react-spring, Lottie, etc.

---

## Electron motion tokens

**File:** `src/renderer/src/assets/css/00-motion-tokens.css`
Imported first from `src/renderer/src/assets/main.css` so every CSS consumer
inherits the same budget.

### Duration tiers

| Token | Value | Use for |
| --- | --- | --- |
| `--motion-fast` | `120ms` | Micro: chevrons, hover, chip state flips |
| `--motion-base` | `180ms` | Fades, control swaps, menus, default presence |
| `--motion-slow` | `260ms` | Panel/sheet presence (`usePresence` slide; matches legacy panel settle) |

DigitOdometer remains **430ms** with place stagger `18ms × place` in
`06-component-panels-modals.css` — do not fold it into the CSS vars.

### Easings

| Token | Curve | Use for |
| --- | --- | --- |
| `--motion-ease-out` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | **House decel** (same as DigitOdometer). Structural chrome, presence entry. |
| `--motion-ease-inout` | `ease-in-out` | Neutral in-place opacity swaps |
| `--motion-ease-pop` | `cubic-bezier(0.34, 1.26, 0.5, 1)` | **Only** tiny accents ≤16px (badges/dots). **Never** panels, sheets, sidebars, or composer shell. |

### Reduce-motion kill-switch

The token file collapses all three duration vars to `0.01ms` under:

- `:root[data-reduce-motion="true"]` (app setting, written by the renderer)
- `@media (prefers-reduced-motion: reduce)` (OS preference)

Components that consume the vars inherit the kill-switch. Bespoke keyframes
still need their own reduce-motion guards.

JS mirrors the same budget in `src/renderer/src/hooks/usePanelPresence.ts`:

```ts
MOTION_DURATIONS = { fast: 120, base: 180, slow: 260 }
isMotionReduced()      // data-reduce-motion OR matchMedia
presenceSettleMs(ms)   // 0 when reduced, else ms + 48 settle pad
```

There is **no** main-process `systemPreferences` → IPC bridge for reduce-motion.
Chromium already honors the OS pref via `matchMedia`; inventing a second path is
surplus overhead.

---

## Usage rules (both platforms)

| Pattern | Motion | When |
| --- | --- | --- |
| **Fade** | opacity only, base duration | In-place content swaps, tooltips, menus |
| **Rise-fade** | 4–8px `translateY` + opacity, base, ease-out | Appearing rows / cards / chips; enter **from** spawn origin |
| **Slide** | slow duration, larger translate | Panels / sheets via presence recipe |
| **Wipe / sweep** | progress & highlight only | Progress bars, selection highlights — **never** enter/exit presence |
| **Odometer / numeric tick** | DigitOdometer (Electron) or `NumericTickText` (iOS) | **Live-ticking** numbers only — never static settings tables |

### Exit asymmetry

Exits are **fade-only** (no positional yank), typically ~0.75× entry duration
when you control both ends. This matches iOS `ComposerMotion` (insert may
move; removal is `.opacity`).

---

## Presence recipe (Electron)

**Hook:** `usePresence(open, { durationMs, variant, skipInitialAnimation })`
**Classes:** `.tw-presence`, `.tw-presence--slide|rise|fade`, enter/exit modifiers
**CSS:** `src/renderer/src/assets/css/13-panel-transitions.css`

### Contract

1. **First-mount skip** — restored UI after launch must not animate unless the
   surface opts in (`skipInitialAnimation: false` for newly created cards).
2. **Exit before unmount** — keep the subtree mounted until CSS finishes
   (`presenceSettleMs`); under reduce-motion settle is `0` and class dance is
   skipped.
3. **Idle strips classes** — settled surfaces carry no transition class so
   drag-resize and live interaction stay instant.
4. **Variants**
   - `fade` — opacity only
   - `rise` — ~6px translateY + opacity (chips/rows)
   - `slide` — ~12px translateY + opacity; uses `--motion-slow`

### Call sites (examples)

Presence-style exits land on foldouts/modals/cards such as compact tool-trace,
creative-approval backdrop, `ask_user_question` cards, and link-preview chrome.
Apply `className` from `usePresence` on the **surface root** only.

### Grandfathered panel presence

`usePanelPresence(open, durationMs = 260)` is a **thin alias** over `usePresence`
that maps to legacy `.tw-panel-anim` / `.tw-panel-collapsed` margin-based classes
for the workspace **sidebar** and **right dock**. That path is pre-existing
resize-friendly layout animation and must not be “fixed” into pure transform
without Design + General sign-off. New surfaces must use `usePresence` +
`.tw-presence-*`, not the panel margin path.

---

## Live numbers

### Electron — `DigitOdometer`

| Piece | Path |
| --- | --- |
| Component | `src/renderer/src/components/DigitOdometer.tsx` |
| Model | `DigitOdometerModel.ts` |
| CSS | `06-component-panels-modals.css` (`digit-odometer-roll`, 430ms) |
| Thin wrapper | `AnimatedDiffNumber` for ± composer diffs |

**Use for:** live-ticking counters (token/telemetry, git ahead/behind, unread
counts, download %, run file/approval counts, heatmap totals, hop chips, etc.).

**Do not use for:** static labels, settings comparison tables, one-shot
copy that never changes while mounted.

Includes `sr-only` accessibility label and full reduce-motion collapse (no
roll animation).

### iOS — `NumericTickText` (not a DigitOdometer port)

| Piece | Path |
| --- | --- |
| Wrapper | `ios/TaskWraithKit/Sources/TaskWraithUI/NumericTickText.swift` |
| Native API | `.contentTransition(.numericText)` |

Design decision: **keep native numericText**; do not port Electron’s wheel.
Under Reduce Motion the content transition becomes `.identity` and animation
falls back to `ComposerMotion.reducedFade`.

Migrate live counts (badge chips, tool activity ±, context meter %, diff
stats). Leave static `Text` alone.

---

## iOS motion vocabulary (`ComposerMotion`)

**File:** `ios/TaskWraithKit/Sources/TaskWraithUI/ComposerMotion.swift`

| API | Role |
| --- | --- |
| `focusSpring` | Damped shell spring (`response: 0.32`, `dampingFraction: 0.82`) — **not** `.bouncy` |
| `inlineFade` | 0.16s ease-in-out for in-composer control swaps |
| `reducedFade` | 0.12s ease-out opacity-only fallback |
| `aboveRowsTransition` / `telemetryTransition` / `compactPillTransition` | Composer shell groups; insert moves, remove fades |
| `cardPresence(edge:)` | Banners, status strips, queued bubbles — row/card roots |
| `floatingChipTransition` | Jump-to-latest / keyboard chips — subtle scale + opacity insert, fade remove |

Always gate with `accessibilityReduceMotion` → opacity-only path.

---

## Haptics (iOS only)

**File:** `ios/TaskWraithKit/Sources/TaskWraithUI/MotionHaptics.swift`
**Desktop:** **none** (no reliable hardware path; do not invent web vibration).

| Token | SensoryFeedback | Fire on |
| --- | --- | --- |
| `selection` | `.selection` | Toggles, pickers, chip taps |
| `success` | `.success` | Approval accept, pairing/send success |
| `warning` | `.warning` | Approval deny, failure, destructive confirm |
| `impactMedium` | `.impact(weight: .medium)` | Discrete drag pickup |
| `forApproval(destructive:)` | success vs warning | Approval decision rows |

**Law:** haptic **only** on user-initiated discrete actions. **Zero** haptics on
streaming, passive, or timer-driven updates. Prefer `MotionHaptics.*` (or
`.motionHaptic`) over scattered `sensoryFeedback` literals.

---

## Reduce-motion (end-to-end)

| Layer | Mechanism |
| --- | --- |
| User setting | Appearance → **Reduce motion** → `AppSettings.reduceMotion` |
| Renderer | ORs setting with OS `prefers-reduced-motion`; writes `:root[data-reduce-motion]` |
| CSS tokens | Duration vars → `0.01ms` |
| Presence JS | `isMotionReduced()` → skip class dance, `presenceSettleMs → 0` |
| DigitOdometer | Nulls roll animation under reduce-motion |
| iOS | `accessibilityReduceMotion` → `.opacity` / `.identity` + `reducedFade` |

---

## DO-NOT list (hard constraints)

Writers and reviewers must refuse or waive only with Design + CheckCommit:

1. **No bouncy / overshoot on structural chrome** (sidebar, dock, composer shell,
   sheets). `--motion-ease-pop` and iOS scale accents are for ≤16px accents only.
2. **No layout-property animation** on new presence (no width/height/top/left
   thrash). Grandfathered: sidebar/dock `.tw-panel-anim` only.
3. **No transitions on streaming transcript text** or live thinking segments —
   animate at **row/card** level, never deep children that reflow every token.
4. **FX / aura / living-workspace / epic sky layers are out of scope** for this
   polish pass — intensity FX, not UI transition system.
5. **No new animation libraries.**
6. **No main-process reduce-motion IPC bridge** (redundant with Chromium).
7. **No Swift DigitOdometer wheel** — use `NumericTickText`.
8. **No desktop haptics.**
9. **Do not put motion tokens in `App.tsx`** — keep `00-motion-tokens.css` (and
   iOS enums) as the single sources of truth.

---

## File map (quick reference)

| Concern | Electron | iOS |
| --- | --- | --- |
| Duration/easing tokens | `src/renderer/src/assets/css/00-motion-tokens.css` | `ComposerMotion.swift` |
| Presence hook / settle | `src/renderer/src/hooks/usePanelPresence.ts` | SwiftUI `.transition` + `withAnimation` |
| Presence CSS | `13-panel-transitions.css` | — |
| Live numbers | `DigitOdometer.tsx` + `AnimatedDiffNumber` | `NumericTickText.swift` |
| Haptics | — | `MotionHaptics.swift` |
| User reduce-motion UI | Appearance tab | System Accessibility → Reduce Motion |

---

## Related

- [Appearance tab](../settings-and-configuration/appearance-tab.md) — reduce motion / transparency / FX Labs
- [Agent question cards](../transcript-and-search/agent-question-cards.md) — Electron presence consumer
- [Queued messages row](../transcript-and-search/queued-messages-row.md) — row-level chrome
- [iOS ensemble UI](../ensemble-mode/ios-ensemble-ui.md) — mobile shell surfaces

---

## Commit note

`docs/` is gitignored-but-tracked. Pathspec commits for this page need:

```bash
git add -f docs/how-to/motion-and-transitions/ docs/how-to/README.md
```
