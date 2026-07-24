# Provider Glyphs

Original mnemonic glyphs for representing providers without bundling official logo PNGs.

These are deliberately simplified and slightly "wrong" visual hints. The provider label remains the actual product identifier; the glyph is only supporting iconography.
Gemini glyphs remain in the set for historical chats and usage history even
though Gemini is retired for new runs.
Cursor glyphs are used for live Path-B managed Cursor seats as well as
historical continuity.

Design constraints:

- `24x24` SVG viewBox.
- No container baked into the glyph.
- Provider-accented linework via `--provider-accent`, except Ensemble's
  fixed-palette Confluence Loom.
- A 1-unit black contrast pass behind the linework in every theme. Each
  provider still has one catalogue entry. Ensemble bakes that silhouette into
  its full-colour artwork and adds dual-ink sparkles that remain legible on
  light and dark surfaces.
- No official raster assets.
- No exact provider logo geometry.

Regenerate:

```bash
node design-assets/provider-glyphs/generate-provider-glyphs.mjs
```

Outputs:

- `glyphs/*.svg`: individual provider glyphs.
- `provider-glyphs.catalog.svg`: review sheet with large and small previews.
- `provider-glyphs.manifest.json`: provider ids, accents, and drawing notes.

Bake template PNGs (after changing any glyph):

```bash
npx electron design-assets/provider-glyphs/render-glyph-pngs.cjs
```

Renders each glyph on transparency at 512px via Chromium (the SVGs lean on
`<style>` + paint servers, which qlmanage/NSImage may flatten onto a white
card). Ordinary providers are written as white template masters, copied into
the iOS package resources, tinted by `ProviderGlyphIcon`, and given a runtime
black contrast pass. Ensemble is written as
`png/provider-glyph-ensemble.png`, preserving its full palette and baked
contrast; the baker synchronizes both the SwiftPM resource and the app asset
catalog because the latter wins `UIImage(named:)` lookup.
Pass `--provider=ensemble` to refresh only the full-colour Ensemble copies.
After changing glyph geometry, also sync any inline desktop copy in
`src/renderer/src/components/icons/ProviderGlyph.tsx`.
