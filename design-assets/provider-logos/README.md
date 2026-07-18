# Provider Logos — Design Reference Catalogue

Official or first-party PNG artwork collected to evaluate a secondary provider
identity direction alongside [`../provider-glyphs`](../provider-glyphs/).

This is a **design-reference set only**. Nothing in the desktop or iOS runtime
loads these files, and no implementation path was changed. The catalogue SVG
links to the PNGs in this directory rather than embedding or re-encoding them.

## Selection rules

- Use an official brand/media pack, first-party site, or first-party repository.
- Require real transparent pixels (`alpha = 0`), not just an RGBA file with an
  opaque tile.
- Exclude rounded-square app icons and baked card backgrounds by default. The
  one deliberate exception is Kimi's requested first-party icon-only tile.
- Preserve sourced PNG bytes exactly; they are only renamed or extracted from
  their first-party container.
- Label requested derivatives explicitly and retain their source relationship,
  transform, hash, and alpha verification in the manifest.
- Keep official light/dark variants when supplied.
- Include all seven canonical provider ids. Gemini is labelled historical
  because it is retained for old chats but retired for new runs.
- Omit Ensemble: it is a TaskWraith orchestration concept, not an external
  provider with an official provider logo.

The Codex entry is OpenAI's exact, untiled `codex-banner-icon.png` from its
official developer site. It is the cloud-like mark shown inside the app icon,
but already supplied on a genuinely transparent canvas. The same treatment is
also present separately from the app icons in OpenAI's signed desktop product
bundle. It is not currently included in OpenAI's public logo pack.

Kimi's first-party guide includes an `icon-without-kimi` set. The selected
rounded-corner tile is the supplied icon-only PNG, not a crop of the lockup.

The Ollama dark-mode file is the catalogue's only derivative. Its RGB values
are an exact chroma inversion (`255 - value`) of the official PNG, while every
alpha value is byte-identical to the source. This makes the black line art white
without filling or changing its transparent canvas.

## Files

- `provider-logos.catalog.svg` — light, dark, and checkerboard review sheet.
- `provider-logos.manifest.json` — source URLs, archive members, dimensions,
  hashes, alpha checks, status, and rights notes.
- `png/*.png` — first-party PNG bytes plus the explicitly labelled Ollama dark
  derivative.

`on-light` and `on-dark` describe the intended review surface, not a runtime
theme token.

## Source map

| Provider id | Selected official artwork | First-party source | Guidance / rights reference |
| --- | --- | --- | --- |
| `gemini` | Gemini Spark, full colour | [Google Image Library](https://blog.google/image-library/) | [Google brand guidance](https://about.google/brand-resource-center/guidance/); credit `Source: Google` |
| `codex` | Untiled Codex banner/cloud icon | [Official transparent PNG](https://developers.openai.com/images/codex/codex-banner-icon.png) and [OpenAI docs usage](https://learn.chatgpt.com/docs/windows/windows-sandbox) | [OpenAI Design Guidelines](https://openai.com/brand/); not included in the public logo pack |
| `claude` | Claude Spark, Clay | [Anthropic press kit](https://www.anthropic.com/press-kit) | [Anthropic newsroom](https://www.anthropic.com/news) |
| `kimi` | Rounded-corner icon without wordmark | [KIMI Brand Guidelines](https://moonshotai.github.io/Branding-Guide/) | [First-party `icon-without-kimi` assets](https://github.com/MoonshotAI/Branding-Guide/tree/main/scenarios/03-icon-without-kimi) |
| `cursor` | Cursor 2D Cube, light + dark | [Cursor brand pack](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip) | [Cursor Brand Guidelines](https://cursor.com/en-US/brand) |
| `grok` | Grok logomark, dark + light | [xAI logo pack](https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip) | [xAI Brand Guidelines](https://x.ai/legal/brand-guidelines) |
| `ollama` | Transparent Ollama llama + recorded RGB-inverted dark derivative | [Ollama repository PNG](https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/docs/ollama.png) | [Ollama terms](https://ollama.com/terms) and [repository licence](https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/LICENSE) |

Retrieved and verified on **2026-07-18**.

## Trademark and repository boundary

These marks remain the property of their respective owners. Their presence is
solely to identify and compare supported providers; it does not imply
affiliation, endorsement, sponsorship, or a transferable licence. Provider
brand terms remain controlling, can change, and may require separate approval
for public redistribution or product use.

This local reference set is an explicit exception for design evaluation to the
repository's normal public-source boundary in `TERMS_NOTES.md` and `README.md`,
which says provider logos should not be committed. Do not stage, publish, ship,
or wire these files into the product without owner/legal review. The existing
packaging configuration excludes `design-assets/**` from application bundles.
