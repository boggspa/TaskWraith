# Provider Swatch Update

Status: **analysis and allocation only — no production palette change yet**

First recorded: 2026-07-13  
Source snapshot: `37c4ea489`  
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
| Grok | `var(--text-primary)` | Theme-dependent | `#757575` | `rgb(117, 117, 117)` | 4.61 / 4.56 | Provisional static monochrome allocation; see the Grok note below. |
| Cursor | `#E3B91E` | 1.87 / 11.22 | `#8D7312` | `rgb(141, 115, 18)` | 4.57 / 4.59 | Same mustard field, substantially darkened. |
| Ollama | `#20A77A` | 3.06 / 6.87 | `#1A8562` | `rgb(26, 133, 98)` | 4.59 / 4.58 | Same local green-teal field, darkened. |
| Ensemble | `#E8DDE3` | 1.32 / 15.88 | `#986781` | `rgb(152, 103, 129)` | 4.57 / 4.59 | Same soft pink-gray field, moved to a mid-tone mauve. |

### Grok exception

Grok currently aliases to `var(--text-primary)`, deliberately choosing the high-contrast
black/white end of the active theme. That adaptive behaviour will generally outperform
a single mid-gray on its corresponding surface. `#757575` is the mathematically balanced
static monochrome allocation if the new policy requires one invariant hue; retain the
dynamic alias if per-theme maximum contrast remains the higher priority.

## Ollama display-brand allocations

Runtime provider remains `ollama`. These are presentation overrides selected by
`src/shared/ollamaBrandTable.ts`; alias relationships should remain aliases when the code
switch is made.

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
  moving very light colours to the equal-contrast luminance. They require visual identity
  review before implementation.
- Do not flatten the Google, OpenAI, Qwen, or Ornith aliases into duplicate literals.
  Keeping the aliases prevents future palette drift.
- Gemini remains in the allocation because historical records and Google/Gemma branding
  still consume its hue even though Gemini is retired for new desktop runs.

## Future implementation checklist

No item in this section was changed as part of this analysis document.

1. Update canonical desktop tokens in `src/renderer/src/styles/theme.css`.
2. Update the iOS mirror in
   `ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift`.
3. Audit hard-coded renderer mirrors, especially:
   - `src/renderer/src/lib/UsageHeatmap.ts`
   - `src/renderer/src/components/WelcomeUsageDashboard.tsx`
   - provider fallbacks in renderer CSS and component styles
4. Audit provider-specific iOS shell literals, especially Codex and Kimi values in
   `ios/TaskWraithKit/Sources/TaskWraithUI/ComposerShellResolver.swift`.
5. Update focused colour assertions in `UsageHeatmap.test.ts`,
   `welcomeUsageDashboard.test.ts`, and affected provider-component tests.
6. Do not blanket-replace old hex values. Some matches are unrelated canvas/theme colours,
   while some dashboard rails and shell treatments intentionally use lighter or darker
   variants.
7. Visually verify small text, quota percentages, bars, chips, participant filters,
   transcript accents, light/dark themes, and reduce-transparency mode.
8. Record the implementation commit and any reviewed exceptions in the history below.

## Change history

| Date | State | Notes |
| --- | --- | --- |
| 2026-07-13 | Proposed | Allocated balanced provider and Ollama display-brand swatches. Codex `#705AFF` approved as the new direction. Production code unchanged. |

