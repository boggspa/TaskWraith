# TaskWraith companion icons

The companion family combines the existing TaskWraith monoline ghost with one
first-party agent-pool catalogue glyph per product. The ghost paths retain their
original geometry. The catalogue glyphs keep their geometry, with adjusted colours
and line weights for the common product badge.

| Product      | Catalogue glyph       | Accent           |
| ------------ | --------------------- | ---------------- |
| Observatory  | `turbo-telescope`     | Cyan `#6EDBE7`   |
| Provider Hub | `glyph-fanout-routes` | Orange `#FFB276` |
| Studio       | `glyph-timeline`      | Violet `#C6ADFF` |

Each product directory contains the editable `app-icon.svg`, a transparent
1024-pixel `app-icon.png`, and `app-icon.icns` with the complete macOS size ramp
from 16 pixels to 1024 pixels. `mark.svg` and `mark-on-light.svg` provide standalone
marks for dark and light surfaces. `preview.png` shows the family and small sizes.

## Regeneration

From the repository root, on macOS with librsvg's `rsvg-convert` and Apple's
`iconutil` available:

```sh
python3 design-assets/suite-app-icons/build.py
```

The generator reads the ghost from `design-assets/ghost/` and the three glyphs
from `design-assets/agent-pool-icons/icons/`. It writes only this asset directory
and temporary iconsets that are removed after conversion. It does not build apps.
`manifest.json` records the source and output SHA-256 digests; paths are relative
to `design-assets/`. Raster bytes may change with the rendering tool version.

The SVG masters are self-contained and can be rendered without the catalogue.
All three marks use first-party artwork.

## Application integration

- Studio's `scripts/build-studio-companion.cjs` copies the Studio ICNS into its
  staging bundle as `TaskWraithStudio.icns`.
- Provider Hub keeps tracked copies of its SVG, PNG and ICNS under `Source/` as
  `AppIcon.*`, with a provenance record. Its existing build script copies the ICNS.
- Observatory receives tracked SVG, PNG and ICNS copies as `build/icon.*`. Its
  normal electron-builder resource discovery uses `build/icon.icns`.

Source updates take effect on the next build of each application. Existing signed
release artefacts are retained; the release tasks own their rebuilds.
