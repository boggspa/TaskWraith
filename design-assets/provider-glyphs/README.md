# Provider Glyphs

Original mnemonic glyphs for representing providers without bundling official logo PNGs.

These are deliberately simplified and slightly "wrong" visual hints. The provider label remains the actual product identifier; the glyph is only supporting iconography.
Gemini glyphs remain in the set for historical chats and usage history even
though Gemini is retired for new runs.

Design constraints:

- `24x24` SVG viewBox.
- No container baked into the glyph.
- Provider-accented linework via `--provider-accent`.
- A 1-unit black contrast pass behind the linework in every theme. Each
  provider still has one catalogue entry.
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

Renders each glyph white-on-transparent at 512px via Chromium (the SVGs
lean on `<style>` + `var(--provider-accent)`, which qlmanage/NSImage
flatten onto a white card). Writes masters to `png/` and copies into the
iOS package resources, where `ProviderGlyphIcon` tints them with the
provider accent and adds the black contrast pass at runtime
(`renderingMode(.template)`). The baker intentionally strips the SVG contrast
copy so the template mask can be tinted independently.
After changing glyph geometry, also sync any inline desktop copy in
`src/renderer/src/components/icons/ProviderGlyph.tsx`.
