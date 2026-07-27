# TaskWraith Ensemble Glyph

Original TaskWraith artwork for the app-owned Ensemble concept.

External providers are never represented here. Their first-party artwork lives
in [`design-assets/provider-logos`](../provider-logos/) and every semantic
Electron/iOS provider surface uses that catalogue. Unknown future providers use
a neutral terminal fallback drawn in code, not brand-like artwork.

Design constraints:

- `24x24` SVG viewBox.
- No container baked into the glyph.
- Fixed-palette Confluence Loom artwork with a baked black silhouette and
  dual-ink sparkles that remain legible on light and dark surfaces.
- `glyphs/ensemble.svg` is the single source asset.
- `provider-glyphs.manifest.json` records its identity and intent.

Bake the runtime PNG after changing the source:

```bash
npx electron design-assets/provider-glyphs/render-glyph-pngs.cjs
```

Chromium renders the SVG on transparency at 512px so its paint servers remain
intact. The baker writes `png/provider-glyph-ensemble.png` and synchronizes the
SwiftPM resource plus app asset catalogue. The desktop inline copy lives in
`src/renderer/src/components/icons/ProviderGlyph.tsx`.
