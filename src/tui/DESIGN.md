# TaskWraith TUI design contract

This document is the design **contract** for the TaskWraith terminal sidecar.
It describes invariants the renderer must obey. Cut-point numbers and glyph
shapes live in code; restating them here is how documentation drifts.

The implementation authority is [`theme.ts`](./theme.ts). The operator-facing
overview lives in [`README.md`](./README.md).

## Token authority

**`theme.ts` is the sole source of every design decision** the TUI makes:
colour tones, glyph sets, status mapping, density affordances, layout
constants, and motion parameters.

Rules:

1. A design literal in `render.ts` (hex colour, box-drawing character, bare
   width cut, status glyph) is a **defect**. Consume a token instead.
2. Glyph slots are named by **meaning**, not by shape. Two slots may resolve
   to the same character; they must not share a slot when the meanings differ.
3. Provider identity carries colour; transcript prose stays neutral. Semantic
   tones (`TUI_TONE` / `tuiToneHex`) are for _state_, never for message bodies.
4. If an affordance cannot be expressed in a static cell grid, it does not
   get a token — and therefore does not belong in the TUI.

## Density by named affordance

Width adaptation is resolved **once** through `resolveTuiDensity(width)`.
Callers branch on the returned named fields, never on inline column
comparisons.

| Affordance           | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `providerFullName`   | Show short-code + role vs short code alone           |
| `hudModel`           | Include the model label in the HUD                   |
| `reasoningLadder`    | Three-step reasoning ladder vs a single spark        |
| `batonExpandedLabel` | Expanded ensemble baton title vs compact             |
| `batonCastSlots`     | How many seats the baton may name before `+n`        |
| `overlayLabelWidth`  | Label column width inside bordered overlays          |
| `composerHints`      | Composer hint strip depth: `none` / `short` / `full` |
| `segmentSpacing`     | HUD segment join: `tight` / `padded`                 |

The three documented tiers (`compact` / `normal` / `expanded`) are derived
inside the resolver via `TUI_BREAKPOINTS`. Sub-threshold detail (when the
reasoning ladder appears, how many cast slots fit, when hints vanish) is also
owned by that function. **Do not re-list raw column cut points in prose** —
that is precisely how the old README claimed three tiers while the renderer
branched on seven unrelated numbers. Point at `resolveTuiDensity`; change the
code when the contract changes.

Baseline commitment: the surface stays legible at the values published as
`TUI_BASELINE_COLUMNS` × `TUI_BASELINE_ROWS` in `theme.ts`. Floor sizes are
`TUI_MIN_COLUMNS` / `TUI_MIN_ROWS`.

## Unified status glyph ladder

There is **one** run-status ladder. Thread rows, ensemble seats, and overlay
cast markers all resolve through `tuiStatusGlyph` / `tuiStatusTone` against a
shared `TuiRunStatus`:

`working` · `next` · `queued` · `needs-input` · `failed` · `done` · `skipped` ·
`sleeping` · `idle`

Nine statuses, nine distinct glyphs in **both** the Unicode and ASCII sets.
Tool and thinking blocks use separate meaning-named slots
(`toolRunning` / `thinkingRunning`, etc.) so a running tool is never confused
with a queued seat — even when the Unicode shapes happen to look similar.

History: three independent ladders previously disagreed and all collided on
`◌` (queued thread, next seat, running tool). Unification is load-bearing;
reintroducing a parallel status map is a regression.

## Degradation ladder

Presentation degrades in this order:

1. **TrueColor ANSI** — default when the terminal supports it.
2. **`NO_COLOR`** — colour off; glyphs and layout unchanged. Meaning survives
   through glyph + weight.
3. **ASCII glyph set** — when Unicode chrome cannot be trusted.

ASCII selection (`resolveTuiGlyphs(detectTuiUnicode())`, overridable):

- `--ascii` on the CLI forces the ASCII set.
- `TASKWRAITH_TUI_ASCII=1` forces the ASCII set.
- Auto-detection is conservative: `TERM=linux` / `TERM=dumb`, or a locale that
  does not advertise UTF-8, selects ASCII. Mis-rendered box drawing is treated
  as worse than plain ASCII.

**Width-1 invariant:** every entry in `TUI_GLYPHS_ASCII` is exactly one
visible column wide. That is what lets `visibleWidth` / `padAnsi` / composer
viewport math keep an 80×24 layout unchanged under fallback. A multi-column
ASCII substitute is a defect in the glyph set, not a renderer quirk.

Static motion: the only animation is the working shimmer (`TUI_MOTION`). It is
disabled by `NO_COLOR`, `--no-animation`, and any non-TTY. Nothing else
animates; nothing animates while idle.

## Sidecar boundary — what the TUI deliberately drops

The TUI is a **terminal endpoint** onto TaskWraith while Electron main remains
the host. It is not a fully-fledged CLI twin of the desktop app.

Deliberately omitted relative to the GUI chrome framework:

- Hover affordances and pointer-depth interaction
- Motion depth beyond the single state-bound shimmer (glass, blur, stacked
  animated layers, persistent backgrounds)
- Desktop-only interaction depth: drag-and-drop, stacked modals, canvas/media,
  rich documents

Provider colour, sparse rhythm, and the transcript-as-canvas layout are the
parts that transfer. Everything else stays on the desktop surface until it has
a purpose-built terminal interaction and the same authority contract.
