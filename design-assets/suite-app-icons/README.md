# TaskWraith Studio companion icon

This directory carries the Studio-only subset of the approved TaskWraith
companion icon family from source commit
`63603c538d66c862f64440126a8452b98242471c`. The artwork combines the unchanged
first-party TaskWraith monoline ghost with the first-party `glyph-timeline`
catalogue symbol and the Studio violet accent `#C6ADFF`.

The `studio/` directory contains the editable `app-icon.svg`, a transparent
1024-pixel `app-icon.png`, and `app-icon.icns` with the complete macOS size ramp
from 16 pixels to 1024 pixels. `manifest.json` records the source and output
SHA-256 digests using paths relative to `design-assets/`.

## Regeneration

From the repository root, on macOS with librsvg's `rsvg-convert` and Apple's
`iconutil` available:

```sh
python3 design-assets/suite-app-icons/build.py
```

The generator reads the ghost from `design-assets/ghost/` and the timeline
glyph from `design-assets/agent-pool-icons/icons/`. It writes only the three
Studio app-icon assets, `manifest.json`, and temporary iconsets that are removed
after conversion. It does not build an application. Raster bytes may change
with the rendering tool version; the SVG master is self-contained.

## Application integration

`scripts/build-studio-companion.cjs` copies `studio/app-icon.icns` into the
staging bundle as `TaskWraithStudio.icns`, the name referenced by its
`Info.plist`. Existing signed release and acceptance artefacts are deliberately
unchanged. The next separately authorised Studio package build must verify the
new bundled icon before signing or notarisation.
