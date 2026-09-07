# Provider Swatch Update

Status: **implemented app-wide and mirrored on iOS**

First recorded: 2026-07-13  
Source snapshot: `37c4ea489`  
Allocation record: `40d156a4f`
Implementation commit: `8dccc4625`
Colour space: sRGB

## Approved direction

Codex moves from TaskWraith's current lavender `#A070F2` to the approved electric-indigo
field:

- **Proposed Codex:** `#705AFF` / `rgb(112, 90, 255)`
- White contrast: **4.57:1**
- Black contrast: **4.60:1**

`#705AFF` is the balanced-lightness variant of the explored `#644BFF` hue field. The
same-hue balanced variant of the old `#A070F2` token would have been `#8C52EF`, but that
is intentionally not the selected Codex direction.

## Contrast method

These allocations target one solid provider colour that remains readable against both
pure white (`#FFFFFF`) and pure black (`#000000`). For every non-aliased colour:

1. Convert the current sRGB colour to HSL.
2. Keep hue and saturation fixed.
3. Adjust lightness to the closest integer-sRGB colour whose white and black WCAG 2.x
   contrast ratios are equal.
4. When integer rounding produces two neighbours, prefer the colour with the highest
   minimum contrast.

The theoretical equal-contrast point has relative luminance `0.1791288` and contrast
`4.5826:1` against both black and white. Integer sRGB values land just either side of
that point. All proposed static colours below meet WCAG AA's `4.5:1` threshold for
normal text on both backgrounds. They do not meet AAA's `7:1` normal-text threshold.

## Primary provider allocations

| Provider | Current token | Current white / black | Proposed token | Proposed RGB | Proposed white / black | Notes |
| --- | --- | ---: | --- | --- | ---: | --- |
| Gemini | `#2563EB` | 5.17 / 4.06 | `#346EEC` | `rgb(52, 110, 236)` | 4.58 / 4.59 | Historical provider; also inherited by Google/Gemma branding. |
| Codex | `#A070F2` | 3.45 / 6.09 | **`#705AFF`** | **`rgb(112, 90, 255)`** | **4.57 / 4.60** | Approved new indigo field; also inherited by OpenAI/GPT OSS branding. |
| Claude | `#D97706` | 3.19 / 6.59 | `#B16105` | `rgb(177, 97, 5)` | 4.58 / 4.58 | Same rust-orange field, darkened. |
| Kimi | `#1A8CFF` | 3.37 / 6.24 | `#0073E6` | `rgb(0, 115, 230)` | 4.57 / 4.59 | Same saturated blue field, darkened. |
| Grok | `var(--text-primary)` | Theme-dependent | `#757575` | `rgb(117, 117, 117)` | 4.61 / 4.56 | Static monochrome allocation; see the Grok note below. |
| Cursor | `#E3B91E` | 1.87 / 11.22 | `#8D7312` | `rgb(141, 115, 18)` | 4.57 / 4.59 | Same mustard field, substantially darkened. **Superseded 2026-08-16 — see the Cursor revision below.** |
| Ollama | `#20A77A` | 3.06 / 6.87 | `#1A8562` | `rgb(26, 133, 98)` | 4.59 / 4.58 | Same local green-teal field, darkened. |
| Ensemble | `#E8DDE3` | 1.32 / 15.88 | `#986781` | `rgb(152, 103, 129)` | 4.57 / 4.59 | Same soft pink-gray field, moved to a mid-tone mauve. |

### Cursor revision — 2026-08-16 (`a52b510ae`)

The allocation table above is the 2026-07-13 record and is left as recorded.
Cursor has since been re-tuned by `a52b510ae` ("style(theme): brighten Cursor
provider accent"):

| Provider | Allocated 2026-07-13 | Current | RGB | White / black contrast | Note |
| --- | --- | --- | --- | ---: | --- |
| Cursor | `#8D7312` | **`#8C7508`** | `rgb(140, 117, 8)` | **4.50 / 4.66** | Same mustard field; slightly lighter and more saturated. |

Contrast recomputed here by the same sRGB relative-luminance method the table
above uses — that method reproduces the recorded `4.57 / 4.59` for `#8D7312`
exactly, so these figures are directly comparable.

Worth noting against this document's own equal-contrast principle: the revision
trades a little white contrast for black. It lands at **4.5034:1** on white,
which still clears the 4.5:1 AA threshold but with far less headroom than the
`4.57` it replaced — a further brightening in the same direction would drop it
below AA. The black side improves from 4.59 to 4.66, so the pair is no longer
close to equal.

Mirrors updated by the same commit: `src/renderer/src/styles/theme.css` and the
manually-maintained iOS mirror `ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift`.
`MODEL_CATALOGUE.md`'s provider rail was missed and has been corrected
separately.

**Resolved 2026-08-30.** The three design assets that still carried `#8D7312`
— `design-assets/provider-glyphs/glyphs/ensemble.svg` and the two
`auditions/ensemble-confluence-loom*.svg` files — were re-synced to `#8C7508`
in the same pass that fixed the Ollama stop below, and the baked PNGs were
regenerated. The glyph's stops are now checked against `theme.css` wholesale,
not one hex at a time: every `data-brand` stop matches its live token.

### Collision revision — 2026-08-30 (Ollama, Thinking Machines)

The 2026-07-13 allocation rows above are left as recorded. Two swatches have
since been re-hued because the palette grew into them, not because their own
contrast drifted: both old values still met the AA-on-both-grounds invariant,
but each had a neighbour close enough to be the same colour on a chip strip.

Separation is measured here with **CIEDE2000** against every other
`--provider-*-color` in `theme.css` (with `var()` aliases resolved first), the
same dE 7.6 bar `theme.css` cites for the Xiaomi allocation. Both replacements
were picked by sweeping the whole integer-sRGB cube for colours inside the
equal-contrast band and maximising the minimum dE2000 to the rest of the
palette within the requested colour family.

| Provider | Old token | Old white / black | New token | New RGB | Relative luminance | New white / black | Nearest neighbour (dE2000) | Note |
| --- | --- | ---: | --- | --- | ---: | ---: | --- | --- |
| Ollama | `#1A8562` | 4.59 / 4.58 | **`#976C52`** | `rgb(151, 108, 82)` | `0.1791363` | **4.5824 / 4.5827** | cerebras `#BB584A` — **12.93** | Green-teal to walnut brown. |
| Thinking Machines / Inkling | `#016EF6` | 4.60 / 4.56 | **`#C24E68`** | `rgb(194, 78, 104)` | `0.1791759` | **4.5816 / 4.5835** | liquid `#D72D82` — **9.28** | Royal blue to rose. |

Why each moved:

- **Ollama** `#1A8562` sat dE2000 **7.89** from Xiaomi's `#008844` — over the
  7.6 bar, but the tightest pair in the palette's green band and the reason the
  local-inference chip read as a duplicate of MiMo. Brown was the one warm
  family with headroom left. At this luminance a brown is a low-chroma orange
  (`C* 25.4` against Claude's `62.7`), and it is that chroma gap, not hue, that
  clears the crowded 6-32 degree orange band: claude `#B16105` dE **13.02**,
  deep-reinforce `#BE5809` dE **13.71**, cursor `#8C7508` dE **19.22**,
  mistral `#D44404` dE **17.11**.
- **Thinking Machines** `#016EF6` sat dE2000 **1.73** from Meta/Muse's
  `#1671EA` and **1.88** from Gemini's `#346EEC` — indistinguishable, not
  merely close. The blue band was full, so Inkling took a rose of its own.
  `#E02948` stays reserved as the generic OpenRouter fallback; the new token
  clears it by dE **9.50** and clears liquid `#D72D82` by dE **9.28**, then
  cerebras **12.25** and ensemble **12.91**.

The pink region is the tighter of the two. `#C24E68` is the best-separated
colour in the equal-contrast band that still reads as a saturated rose
(`HSL S 0.49`); trading saturation for distance is available if wanted — a
duskier `#B75769` (`S 0.40`) reaches dE **10.97**, and a more vivid `#D04066`
(`S 0.61`) drops to dE **8.18**. Every one of those still clears 7.6, so the
choice is identity, not compliance.

Mirrors updated for this revision: `src/renderer/src/styles/theme.css`,
`src/shared/taskWraithProviderPresentation.ts`,
`ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift`,
`src/renderer/src/styles/providerPaletteContrast.test.ts` (hex pins, the iOS
case list, and the `ollama` Agent-Aura RGB triplet), the `--agent-accent-rgb` /
`--agent-aura-rgb` triplets in `02-transcript-messages-fx.css` and
`05-polish-fx-layouts.css`, the hard-coded fallbacks in
`03-composer-welcome-activity.css`, `06-component-panels-modals.css`,
`07-composer-shells.css`, `ModelUsageSettingsTable.css`, `UsageHeatmap.ts`,
`WelcomeUsageDashboard.tsx`, `agentPoolIconAssets.ts`, `canvasChartSvg.ts`,
`ProviderGlyph.tsx` and `scripts/export-dmg-background.cjs`.

**Design assets corrected in the same pass, 2026-08-30.** All three files —
`design-assets/provider-glyphs/glyphs/ensemble.svg` and the two
`auditions/ensemble-confluence-loom*.svg` — now carry `#976C52`, and the
long-outstanding Cursor `#8D7312` was cleared alongside it. The glyph is the
live source for the baked Ensemble PNG and for the Agent Pool artwork, so
`npx electron design-assets/provider-glyphs/render-glyph-pngs.cjs` was run in
the same pass; it rewrites three copies at once (the master under `png/`, the
`TaskWraithUI/Resources` copy, and the `Assets.xcassets` imageset), and all
three now share one digest. Rebake whenever a stop changes — the SVG and its
PNGs drift silently otherwise, and the PNG is what iOS ships.

**This document remains incomplete.** It has no allocation rows for Meta,
Xiaomi/MiMo, OpenRouter, or the original Thinking Machines swatch, nor for the
other Pi-backed upstream brands added after 2026-07-13. `theme.css` is the
authority in the meantime. Backfilling them was out of scope for this revision.

### Grok exception

Grok previously aliased to `var(--text-primary)`, deliberately choosing the high-contrast
black/white end of the active theme. That adaptive behaviour generally outperformed a
single mid-gray on its corresponding surface. The implementation adopts `#757575`, the
mathematically balanced static monochrome allocation, so Grok now follows the same
invariant provider-hue policy as the other providers.

## Ollama display-brand allocations

Runtime provider remains `ollama`. These are presentation overrides selected by
`src/shared/ollamaBrandTable.ts`; the implementation keeps the documented alias
relationships as aliases.

| Display brand / model family | Current token | Current white / black | Proposed token | Proposed RGB | Proposed white / black | Relationship |
| --- | --- | ---: | --- | --- | ---: | --- |
| Alibaba / Qwen | `#7C3AED` | 5.70 / 3.69 | `#8C52EF` | `rgb(140, 82, 239)` | 4.60 / 4.57 | `qwen` inherits Alibaba. |
| Deep Reinforce / Ornith | `#B45309` | 5.02 / 4.18 | `#BE5809` | `rgb(190, 88, 9)` | 4.58 / 4.59 | `ornith` inherits Deep Reinforce. |
| Google / Gemma | Gemini alias | 5.17 / 4.06 | `#346EEC` | `rgb(52, 110, 236)` | 4.58 / 4.59 | Continue inheriting Gemini. |
| IBM / Granite | `#1F4E79` | 8.66 / 2.42 | `#3079BC` | `rgb(48, 121, 188)` | 4.58 / 4.59 | Same steel-blue field, lightened. |
| Liquid / LFM | `#F7D5E6` | 1.34 / 15.62 | `#D72D82` | `rgb(215, 45, 130)` | 4.58 / 4.59 | Same pink field; large shift from pastel to vivid mid-tone. |
| NVIDIA / Nemotron | `#76B900` | 2.41 / 8.71 | `#538200` | `rgb(83, 130, 0)` | 4.60 / 4.56 | Same NVIDIA green field, darkened. |
| OpenAI / GPT OSS | Codex alias | 3.45 / 6.09 | `#705AFF` | `rgb(112, 90, 255)` | 4.57 / 4.60 | Continue inheriting the approved Codex token. |
| OpenBMB / MiniCPM | `#EF6F61` | 2.95 / 7.12 | `#E22B17` | `rgb(226, 43, 23)` | 4.57 / 4.59 | Same coral-red field, darkened and intensified. |
| Poolside / Laguna | `#86E5F5` | 1.44 / 14.54 | `#0C8194` | `rgb(12, 129, 148)` | 4.58 / 4.58 | Same cyan field; large shift from pastel to deep teal-cyan. |

## Interpretation guardrails

- Ratios apply to the solid colour as foreground against pure white or pure black.
  Opacity, gradients, shadows, antialiasing, `color-mix()`, tinted panels, and disabled
  states must be checked separately.
- Equal black/white contrast is a deliberately constrained compromise. If a surface can
  select a light-mode and dark-mode token independently, two tokens can provide materially
  stronger readability than any single invariant colour.
- The large Liquid, Poolside, Ensemble, and Cursor shifts are mathematical consequences of
  moving very light colours to the equal-contrast luminance. They remain priority surfaces
  for visual identity review after implementation.
- Do not flatten the Google, OpenAI, Qwen, or Ornith aliases into duplicate literals.
  Keeping the aliases prevents future palette drift.
- Gemini remains in the allocation because historical records and Google/Gemma branding
  still consume its hue even though Gemini is retired for new desktop runs.

## Implementation record

Completed in `8dccc4625`:

1. Updated canonical desktop tokens in `src/renderer/src/styles/theme.css`.
2. Updated the iOS mirror in
   `ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift`.
3. Audited and updated hard-coded renderer mirrors, including:
   - `src/renderer/src/lib/UsageHeatmap.ts`
   - `src/renderer/src/components/WelcomeUsageDashboard.tsx`
   - provider fallbacks in renderer CSS and component styles
4. Updated provider-specific iOS shell literals, including Codex, Gemini, and Kimi values in
   `ios/TaskWraithKit/Sources/TaskWraithUI/ComposerShellResolver.swift`.
5. Updated focused colour assertions in `UsageHeatmap.test.ts` and
   `welcomeUsageDashboard.test.ts`.
6. Added `providerPaletteContrast.test.ts` to pin the exact desktop/iOS palette, alias
   relationships, transcript/Aura RGB mirrors, and the `4.5:1` dual-background floor.
7. Routed desktop identity surfaces through canonical variables: sidebar, transcript,
   composer, welcome/usage, settings, run cards, permission cards, shell treatments,
   activity traces, Agent Aura, and Ensemble UI.
8. Routed iOS Ensemble and provider-shell accents through `TWTheme.providerAccent` where
   they had bypassed the palette.
9. Preserved unrelated generic canvas/theme colours and permission-state colours rather
   than blanket-replacing matching historical hex values.

## Verification

- Focused renderer run: **16 test files / 314 tests passed**, including usage-dashboard,
  heatmap, palette/contrast, theme-opacity, permission-card, and reasoning-ladder checks.
- `npm run build`: node + web typechecks and Electron main/preload/renderer production
  bundles passed.
- Swift package: all modified iOS sources compiled; the 403-test run had one unrelated
  timing assertion fail, and its isolated `stalenessBoundRespected` rerun passed.
- `git diff --check` passed on the owned implementation paths.
- No repository-wide Prettier or format command was run.

Still recommended as release visual QA: small text, quota percentages, bars, chips,
participant filters, transcript accents, light/dark themes, and reduce-transparency mode.

## Change history

| Date | State | Notes |
| --- | --- | --- |
| 2026-07-13 | Proposed | Allocated balanced provider and Ollama display-brand swatches. Codex `#705AFF` approved as the new direction. Production code unchanged. |
| 2026-07-13 | Implemented | Applied the allocations across desktop and iOS in `8dccc4625`; added exact palette, alias, RGB-mirror, and dual-background contrast regression coverage. |
| 2026-08-16 | Revised | Cursor re-tuned `#8D7312` to `#8C7508` in `a52b510ae`; see the Cursor revision above. |
| 2026-08-30 | Revised | Ollama `#1A8562` to `#976C52` and Thinking Machines `#016EF6` to `#C24E68` on CIEDE2000 collision grounds (Xiaomi dE 7.89, Meta/Muse dE 1.73); both held at the equal-contrast luminance. See the collision revision above. |
