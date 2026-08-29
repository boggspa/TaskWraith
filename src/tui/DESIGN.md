# TaskWraith TUI design contract

This document is the design **contract** for the TaskWraith terminal client.
Its renderer is Electron-free. The client connects to an authenticated
production Host — the pure-Node `taskwraith-host` process (`node-host-v1`) —
and launches or reuses one directly when none is reachable; production
authority lives in that Node Host, not in Electron.
It describes invariants the renderer must obey. Cut-point numbers and glyph
shapes live in code; restating them here is how documentation drifts.

The implementation authority is [`theme.ts`](./theme.ts). The operator-facing
overview lives in [`README.md`](./README.md).

## Token authority

**`theme.ts` is the sole source of every design decision** the TUI makes:
glyph sets, status mapping, density affordances, layout constants, and motion
parameters. **`palette.ts` owns colour** — the grounds, inks and state tones a
theme is made of, plus theme resolution and provider-accent adaptation. The
split is by concern, not by convenience: `theme.ts` is the vocabulary, and
`palette.ts` is what the vocabulary is drawn in.

Rules:

1. A design literal in `render.ts` (hex colour, box-drawing character, bare
   width cut, status glyph) is a **defect**. Consume a token instead.
2. Glyph slots are named by **meaning**, not by shape. Two slots may resolve
   to the same character; they must not share a slot when the meanings differ.
3. Provider identity carries colour; transcript prose stays neutral. Semantic
   tones are for _state_, never for message bodies.
4. **A theme owns the ground and the state tones. It never owns provider hue.**
   Provider accents are cross-surface identity, pinned by
   `taskWraithProviderPresentation.test.ts` to the desktop `theme.css` and
   mirrored in iOS `Theme.swift`. `adaptProviderAccent` may move an accent's
   luminance toward a contrast floor against the active ground — mixing toward
   black or white preserves hue exactly — but a theme that recolours a provider
   breaks the one thing the TUI shares with every other TaskWraith surface.
5. **Painting a ground obliges setting an ink.** A theme that fills a background
   and leaves the foreground to the terminal renders unreadably wherever the two
   disagree — a light theme under a light terminal profile writes white on
   near-white. `Ansi.paint` takes both, and rewrites every foreground reset
   inside the line so no stretch escapes back to the terminal's own colour.
6. If an affordance cannot be expressed in a static cell grid, it does not
   get a token — and therefore does not belong in the TUI.

## Ghost banner

The home-frame Monoline Ghost lives in [`ghostBanner.ts`](./ghostBanner.ts).
It is a **theme-token-respecting module**: Unicode vs ASCII selection, the
compact-width fallback glyph (`ghost` in the Unicode / ASCII sets), and any
colour/tone are consumed from `theme.ts`. Do not add banner-local colour
hex, a second glyph set, or a parallel density resolver. `theme.ts` stays
the sole token authority; `ghostBanner.ts` composes printable banner lines
from those tokens (hand-authored art, not an SVG→ASCII generator).

The mark is drawn in the **heavy** Box Drawing weight, matching the source
SVG's monoline rather than under-reading it at raster scale. Heavy has no
counterpart to the arcs or diagonals, so the crown's outward flare is stepped
rather than curved; the flare is the feature, the radius is not.

Colour over the banner belongs to [`ghostBannerSweep.ts`](./ghostBannerSweep.ts),
which is where the home-frame sweep lives. `ghostBanner.ts` stays free of ANSI
so that the art can be asserted as plain text.

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

## Themes

Five built-in themes plus `auto`, resolved by name or alias, case-insensitively.
`terminal` paints nothing and inherits the user's own palette — a supported
design, not a degraded one, and the honest answer for a 256-colour terminal.

Precedence: `--theme` > `TASKWRAITH_TUI_THEME` > the saved preference
(`settings.ts`) > the default theme. The environment outranks the saved
preference deliberately: a variable is how a script or terminal profile states
what it needs, and an interactive choice should not override it.

`auto` measures rather than guesses, and asks the terminal before it asks the
OS — a user in light mode running a dark profile is common, and the OS gets that
user the wrong answer. The ladder lives in `appearance.ts`:
declared env (`LC_TASKWRAITH_APPEARANCE` survives SSH) → `COLORFGBG` → an OSC 11
background query → OS appearance → dark. Every rung may answer "I don't know".

**The OSC 11 probe runs exactly once, at startup.** It takes ownership of
terminal input while it runs, which is safe before the interactive reader
attaches and never safe afterwards; it is skipped inside tmux/screen/zellij,
which answer for themselves, and skipped when input is already queued rather
than eating a keystroke. `/theme` previewing `auto` therefore uses the
synchronous rungs only.

## Degradation ladder

Presentation degrades in this order:

1. **TrueColor ANSI** — default when the terminal supports it.
2. **256-colour** — themes whose depth needs 24 bits give up their ground rather
   than painting three surfaces that quantise to one flat block. Tones survive.
3. **`NO_COLOR`** — colour off; glyphs and layout unchanged. Meaning survives
   through glyph + weight.
4. **ASCII glyph set** — when Unicode chrome cannot be trusted.

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

Sparse motion: there are exactly **two** animations, both parameterised by
`TUI_MOTION` and both disabled by `NO_COLOR`, `--no-animation`, and any
non-TTY.

1. **The working shimmer** — a one-dimensional sweep along the working status
   line, bound to a thread being `working`.
2. **The home-frame banner sweep** — a diagonal sweep across the Monoline
   Ghost, drawn only on the home frame.

The banner sweep is a deliberate, reviewed exception to the older rule that
nothing animates while idle: the home frame _is_ the idle state, so a mark
that only moves under load would never move at all. It is the exception, not a
precedent. Its cost is a repaint of an otherwise-still frame, which is why it
runs at `bannerSweepIntervalMs` rather than the working shimmer's rate and why
`bannerSweepTailPadding` leaves the mark at rest for part of every loop. A
third animation, or either of these two running on a frame it does not own, is
a regression.

## Sidecar boundary — what the TUI deliberately drops

The TUI is a **terminal endpoint** onto TaskWraith while the pure-Node
production Host (`taskwraith-host serve --mode production`) remains the
authority. It is not a fully-fledged CLI twin of the desktop app.

Deliberately omitted relative to the GUI chrome framework:

- Hover affordances and pointer-depth interaction
- Motion depth beyond the two sweeps above (glass, blur, stacked animated
  layers, persistent backgrounds)
- Desktop-only interaction depth: drag-and-drop, stacked modals, canvas/media,
  rich documents

Provider colour, sparse rhythm, and the transcript-as-canvas layout are the
parts that transfer. Everything else stays on the desktop surface until it has
a purpose-built terminal interaction and the same authority contract.
