# API Key Required

The visual for the "API key required" state: a monoline horizontal key with a serrated
bit, its bow enclosing a dollar sign. Fuses SF Symbols `key.horizontal` and `dollarsign`
into a single mark — key + cost, i.e. this provider needs your own paid key.

Design constraints (same as the other monoline sets here):

- `24x24` SVG viewBox, no baked container.
- Theme-aware linework via `currentColor`.
- `fill="none"` only; `stroke-width="1.6"`, round caps and joins.
- Accessible `<title>` and `<desc>` in every SVG.

## Files

| Concept | File |
| --- | --- |
| The mark | `api-key-required.svg` |
| Size/contrast contact sheet | `preview.png` |

**There are deliberately no PNG exports.** An earlier revision shipped a
`png/{white,black}-{32…1024}` set generated with `qlmanage -t`; it was wrong in both
tones and has been removed. `qlmanage` flattens SVGs onto an opaque WHITE background, so
the white renders were blank white squares (verified: one unique colour across the whole
image) and the black ones were opaque rather than transparent. The failure is silent —
the files are the right dimensions, report `hasAlpha: yes`, and a blank white PNG looks
identical to a correct one in any preview with a white backdrop.

Regenerating them needs a real SVG rasteriser that honours transparency (`rsvg-convert`,
`inkscape`, `cairosvg`, or ImageMagick with librsvg) — none of which is installed here.
`qlmanage` is not a substitute. Until then use the SVG, which is the canonical asset
anyway: it inherits the theme colour through `currentColor`, which no PNG can do.

## Geometry notes

The three parts are mutually constrained — none can be resized on its own.

- **Bow**: `r=5` circle at `(17.5, 11.6)`. This is the floor, not a preference. The
  dollar inside needs `~1.0` of counter between its S-rails to stay readable, which fixes
  the S's height, and the S's outer corners then need `r>=5` to clear the ring. Below that
  the dollar closes into a blob (verified — it is unreadable at every size, not just small
  ones).
- **Dollar**: concentric with the bow, scaled to `0.9`. Bar `y 8.5→14.7`, S-rails at
  `y = 8.9 / 11.6 / 14.3`, arc `r=1.35`. Leaves `1.1` of counter and `0.3` of clearance to
  the ring.
- **Blade**: one continuous outline, not a centreline. A `3.6`-tall rectangle from the tip
  at `x=1.5` to the bow, with two V teeth (`4.0` deep, `2.2` run per arm) cut into its
  lower edge. Both horizontal edges terminate at `x=12.84`, where `y = 11.6 ± 1.8` meets
  the `r=5` circle — recompute that intersection if the bar height or bow radius ever
  changes, or the edges will stop short of the ring or overshoot into it. The notch
  counter is `~2.3`; below ~0.9 the arms merge and the teeth render as filled triangles
  instead of outlines.

**The blade is at its maximum length.** Bow diameter (10, fixed by the dollar) plus blade
plus padding has to fit 24 units, which caps the blade near 11. Growing it further means
either dropping the dollar from the bow, rotating the key to use the canvas diagonal, or
moving off the 1.6 stroke weight.

Padding is `0.7` rather than the `~1.5` of the other sets here — the blade needed the
room. If this ever sits inline next to `slash-commands/icons/*`, it will read very
slightly larger than its neighbours.

## Legibility

The key silhouette holds down to 16px. Two things go before that: the shaft rectangle's
interior (`2.0` clear) closes up below ~36px and the blade reads as a solid wedge, and the
dollar stops reading around ~40px, leaving the bow as a plain coin. Use a key or `$` glyph
on its own at list-row sizes.
