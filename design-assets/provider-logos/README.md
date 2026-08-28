# Provider Logos — Design Reference Catalogue

Official or first-party artwork collected to evaluate a secondary provider
identity direction alongside [`../provider-glyphs`](../provider-glyphs/).

The files in this directory remain the source/provenance catalogue rather than
an application resource path. Canonical-provider assets, plus the integrated
DeepSeek and Cerebras upstream-brand marks, have byte-identical runtime copies vendored under
`src/renderer/src/assets/provider-logos/` and
`ios/TaskWraithKit/Sources/TaskWraithUI/Resources/`; the desktop and iOS apps use
those copies only as identity marks beside provider or model names. These upstream
marks do not create a TaskWraith provider identity or affect admission. Any future
supplemental upstream-brand assets remain design-only until a separate runtime
integration lands. The catalogue SVG reviews the canonical-provider PNGs here
rather than embedding or re-encoding them.

## Selection rules

- Use an official brand/media pack, first-party site, or first-party repository.
- Require real transparent pixels (`alpha = 0`), not just an RGBA file with an
  opaque tile.
- Exclude rounded-square app icons and baked card backgrounds by default. The
  one deliberate exception is Kimi's requested first-party icon-only tile.
- Preserve sourced PNG and SVG bytes exactly; they are only renamed or
  extracted from their first-party container.
- Label requested derivatives explicitly and retain their source relationship,
  transform, hash, and alpha verification in the manifest.
- Keep official light/dark variants when supplied.
- Track all eleven stable provider identities. The nine static-live providers
  are Codex, Claude, Kimi, Cursor, Grok, Ollama, Pi, Mistral, and Muse;
  AntiGravity is conditionally offered, and Gemini is labelled historical
  because it is retained for old chats but retired for new runs. Cursor's
  live membership is a user-approved product decision; Path-B containment
  is separate runtime assurance. Canonical identity still does not imply
  runtime admission:
  structurally admitted Kimi runs without a reviewed roster tuple are labelled
  `unattested-development`.
- Supplemental upstream-brand files may sit alongside the canonical provider
  set for design evaluation. Those marked `runtimeIntegrated` may be bundled
  solely for factual identity beside their own upstream/model-usage labels;
  they do not create provider identities or affect admission.
- Omit Ensemble: it is a TaskWraith orchestration concept, not an external
  provider with an official provider logo.

The Codex entry is OpenAI's exact, untiled `codex-banner-icon.png` from its
official developer site. It is the cloud-like mark shown inside the app icon,
but already supplied on a genuinely transparent canvas. The same treatment is
also present separately from the app icons in OpenAI's signed desktop product
bundle. It is not currently included in OpenAI's public logo pack.

Kimi's first-party guide includes an `icon-without-kimi` set. The selected
rounded-corner tile is the supplied icon-only PNG, not a crop of the lockup.

Pi's first-party press kit supplies its primary P+i mark as a transparent SVG,
not as a PNG. The source SVG is retained byte-for-byte. Its white on-dark PNG
is rasterised at the SVG's native 800×800 view box, and the black on-light PNG
is an exact RGB inversion (`255 - value`) with byte-identical alpha.

TaskWraith's picker uses provider identity artwork beside model names. Mistral's
brand page also publishes model-family illustrations, but its current labels
(`Devstral 2`, `Mistral Medium 3`) do not exactly name TaskWraith's
`devstral-small` and `mistral-medium-3.5` seats. Substituting those illustrations
would imply a false exact match, so both models correctly inherit the official
Mistral provider icon.

The Ollama dark-mode file uses the same recorded RGB-inversion treatment. This
makes the black line art white without filling or changing its transparent
canvas.

Cerebras supplies transparent black- and white-wordmark PNGs in its official
press kit. DeepSeek's official repository publishes the equivalent full-colour
mark as SVG rather than a press-kit PNG, so the unmodified SVG is retained and
the catalogue PNG is an explicitly recorded transparent rasterisation.

## Files

- `provider-logos.catalog.svg` — light, dark, and checkerboard review sheet.
- `provider-logos.manifest.json` — source URLs, archive members, dimensions,
  hashes, alpha checks, status, and rights notes.
- `png/*.png` — first-party PNG bytes plus explicitly labelled Pi and Ollama
  derivatives and the DeepSeek SVG rasterisation.
- `svg/provider-logo-pi.svg` and `svg/provider-logo-deepseek.svg` —
  byte-identical first-party source SVGs retained for recorded derivatives.

`on-light` and `on-dark` describe the intended surface. The runtime maps them to
the actual light/dark app surface while preserving the sourced pixels.

## Source map

| Provider / upstream id  | Selected official artwork                                        | First-party source                                                                                                                                                           | Guidance / rights reference                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini`                | Gemini Spark, full colour                                        | [Google Image Library](https://blog.google/image-library/)                                                                                                                   | [Google brand guidance](https://about.google/brand-resource-center/guidance/); credit `Source: Google`                                                    |
| `codex`                 | Untiled Codex banner/cloud icon                                  | [Official transparent PNG](https://developers.openai.com/images/codex/codex-banner-icon.png) and [OpenAI docs usage](https://learn.chatgpt.com/docs/windows/windows-sandbox) | [OpenAI Design Guidelines](https://openai.com/brand/); not included in the public logo pack                                                               |
| `claude`                | Claude Spark, Clay                                               | [Anthropic press kit](https://www.anthropic.com/press-kit)                                                                                                                   | [Anthropic newsroom](https://www.anthropic.com/news)                                                                                                      |
| `kimi`                  | Rounded-corner icon without wordmark                             | [KIMI Brand Guidelines](https://moonshotai.github.io/Branding-Guide/)                                                                                                        | [First-party `icon-without-kimi` assets](https://github.com/MoonshotAI/Branding-Guide/tree/main/scenarios/03-icon-without-kimi)                           |
| `antigravity`           | Antigravity icon, full colour                                    | [Google Antigravity press assets](https://antigravity.google/press?app=antigravity)                                                                                          | Official press-download PNG, preserved unmodified for provider identification                                                                             |
| `cursor`                | Cursor 2D Cube, light + dark                                     | [Cursor brand pack](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip)                                                            | [Cursor Brand Guidelines](https://cursor.com/en-US/brand)                                                                                                 |
| `grok`                  | Grok logomark, dark + light                                      | [xAI logo pack](https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip)                                                                                                            | [xAI Brand Guidelines](https://x.ai/legal/brand-guidelines)                                                                                               |
| `ollama`                | Transparent Ollama llama + recorded RGB-inverted dark derivative | [Ollama repository PNG](https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/docs/ollama.png)                                                      | [Ollama terms](https://ollama.com/terms) and [repository licence](https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/LICENSE) |
| `pi`                    | Transparent P+i primary mark, rendered as black/white PNGs       | [Pi press kit](https://pi.dev/press-kit) and [official SVG](https://pi.dev/logo.svg)                                                                                         | [Pi press kit](https://pi.dev/press-kit); project is MIT licensed                                                                                         |
| `mistral`               | Mistral gradient pixel-cat icon                                  | [Mistral brand page](https://mistral.ai/brand/) and [first-party PNG proxy](https://mistral.ai/cms-media/api/documents/file/Mistral-Icon-Gradient-RGB.png)                   | [Mistral brand guidance](https://mistral.ai/brand/)                                                                                                       |
| `cerebras` _(upstream)_ | Orange-C lockup, black + white wordmarks                         | [Cerebras press kit](https://www.cerebras.ai/company/press-kit)                                                                                                              | Retained unmodified; [Cerebras terms](https://cloud.cerebras.ai/terms) govern external use                                                                |
| `deepseek` _(upstream)_ | Blue whale + wordmark, transparent PNG derived from source SVG   | [Official DeepSeek repository source](https://github.com/deepseek-ai/DeepSeek-V2/blob/ec98ee3cbffc32104cd55dba8af884b3d772602a/figures/logo.svg)                             | Source SVG retained; [DeepSeek User Agreement](https://platform.deepseek.com/downloads/DeepSeek%20User%20Agreement.pdf) governs external use              |

The original seven-provider set was retrieved and verified on **2026-07-18**.
The Antigravity press asset was added on **2026-07-23** and reverified against
Google's press download on **2026-07-24**. Pi and Mistral were added from their
official press/brand pages on **2026-07-27**. Cerebras press-kit PNGs and the
DeepSeek official-repository SVG/PNG derivative were added on **2026-08-02**.

## Trademark and repository boundary

These marks remain the property of their respective owners. Their presence is
solely to identify canonical provider records and compatible integrations; it does not imply
affiliation, endorsement, sponsorship, or a transferable licence. Provider
brand terms remain controlling, can change, and may require separate approval
for public redistribution or product use.

The app now vendors byte-identical copies for factual, nominative provider and
integrated-upstream identification. `design-assets/**` itself remains excluded
from application bundles, and the manifest records the exact relationship
between every runtime copy and its sourced or explicitly derived catalogue file.
Public distribution still needs to follow the owners' current brand terms and
the project's release review process.
