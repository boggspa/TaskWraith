# Ghost Asset Exports

Private visual asset exports for the small ghost companion.

Generated files:

- `ghost-guy-mark.svg` and `ghost-guy-mark-*.png`: transparent logo mark, no floor shadow.
- `ghost-guy-mark-monoline.svg`: theme-aware monoline logo mark for loading masks and compact brand placements.
- `ghost-guy-sticker.svg` and `ghost-guy-sticker-*.png`: transparent sticker-style mark with glow and floor shadow.
- `ghost-guy-wwdc26 alpha.png` and `ghost-guy-wwdc26.jpg`: WWDC26-style
  companion exports.
- Runtime mastheads include `masthead-wwdc26.png` and `masthead-sticker.png`
  in the iOS package resources.

Default PNG sizes: 128, 256, 512, and 1024 px.

Regenerate from the repo root:

```sh
node scripts/export-ghost-assets.cjs
```

Custom sizes:

```sh
node scripts/export-ghost-assets.cjs --sizes=128,256,512,1024
```
