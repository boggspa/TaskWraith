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
| Raster exports | `png/api-key-required-{white,black}-{32,64,128,256,512,1024}.png` |
| Size/contrast contact sheet | `preview.png` |

PNGs are transparent-background renders. Prefer the SVG in-app so the stroke inherits the
theme colour; the PNGs are for docs, decks and store artwork.

## Geometry notes

The three parts are mutually constrained — none can be resized on its own.

- **Bow**: `r=5` circle at `(17.5, 11.8)`. This is the floor, not a preference. The
  dollar inside needs `~1.0` of counter between its S-rails to stay readable, which fixes
  the S's height, and the S's outer corners then need `r>=5` to clear the ring. Below that
  the dollar closes into a blob (verified — it is unreadable at every size, not just small
  ones).
- **Dollar**: concentric with the bow, scaled to `0.9`. Bar `y 8.7→14.9`, S-rails at
  `y = 9.1 / 11.8 / 14.5`, arc `r=1.35`. Leaves `1.1` of counter and `0.3` of clearance to
  the ring.
- **Blade**: shaft `x 12.5→1.5` at `y=11.8`, with two V-notched teeth cut into the
  underside (`5.35` deep, `2.3` run per arm, spanning `x 1.6→10.8`). Two things keep the
  teeth reading as outlines rather than solid wedges: the notch counter is `~2.6` (below
  ~0.9 the arms merge into a filled triangle), and the shaft stroke stays — drop it and
  the zigzag alone reads as a lowercase "w".

**The blade is at its maximum length.** Bow diameter (10, fixed by the dollar) plus blade
plus padding has to fit 24 units, which caps the blade near 11. Growing it further means
either dropping the dollar from the bow, rotating the key to use the canvas diagonal, or
moving off the 1.6 stroke weight.

Padding is `0.7` rather than the `~1.5` of the other sets here — the blade needed the
room. If this ever sits inline next to `slash-commands/icons/*`, it will read very
slightly larger than its neighbours.

## Legibility

The key silhouette holds down to 16px. The dollar reads to ~40px; below that the bow goes
to a plain coin, so use a key or `$` glyph on its own at list-row sizes.

To regenerate the PNGs (macOS, no extra tooling):

```
for tone in white black; do
  sed 's|stroke="currentColor"|stroke="'"$tone"'"|' api-key-required.svg > /tmp/ak-$tone.svg
  for s in 32 64 128 256 512 1024; do
    qlmanage -t -s $s -o /tmp/ak-out /tmp/ak-$tone.svg
    mv /tmp/ak-out/ak-$tone.svg.png png/api-key-required-$tone-$s.png
  done
done
```
