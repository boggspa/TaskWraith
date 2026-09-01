# Model Catalogue

**Platform:** Electron

TaskWraith's model picker is provider-aware: choose a provider, then a model,
the reasoning level it supports, and (where offered) a Fast tier. This page is
the concise, public reference for the curated picker catalogue.

> **Snapshot: 29 August 2026.** Your actual picker is still governed by the
> provider CLI, your account and plan, and (for Ollama) the models installed on
> your machine. Codex is refreshed from its live provider catalogue when
> available; the rows below describe TaskWraith's curated fallback and the
> standard options it presents. Rows added or corrected after v1.9.6 describe
> the current source-ahead checkout and are not a v1.9.6 release guarantee.

## Reading the catalogue

- **Default** marks TaskWraith's initial selection for a new provider seat.
- **Reasoning** uses the composer's common ladder: **Light**, **Medium**,
  **High**, **Extra**, **Max**, and **Ultracode**. A dash means that model has
  no configurable TaskWraith reasoning control.
- **Fast** is provider-specific: **Toggle** exposes the Fast control in the
  picker, **Included** means the provider's model is always Fast, and **Pair**
  means normal and Fast are separate model rows. Fast availability and pricing
  depend on the provider plan.

The thin colour rail beside each provider is the same provider hue used by the
in-app New Additions notification. The marks are the actual first-party
provider logos from the project's [provider-logo catalogue](../design-assets/provider-logos/README.md),
not the monoline glyph set.

## Provider catalogue

<table>
  <tr>
    <td width="10" bgcolor="#705AFF"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-codex-cloud.png" alt="Codex logo" width="34" />
    </td>
    <td valign="middle"><strong>Codex / OpenAI</strong><br /><sub>Violet provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model                                         | Reasoning                                       | Fast   | Notes                                                            |
| --------------------------------------------- | ----------------------------------------------- | ------ | ---------------------------------------------------------------- |
| **GPT-5.6-Sol** `gpt-5.6-sol`                 | Light · Medium · High · Extra · Max · Ultracode | Toggle | Latest frontier agentic coding model.                            |
| **GPT-5.6-Terra** `gpt-5.6-terra`             | Light · Medium · High · Extra · Max · Ultracode | Toggle | Balanced agentic coding for everyday work.                       |
| **GPT-5.6-Luna** `gpt-5.6-luna`               | Light · Medium · High · Extra · Max             | Toggle | Fast and affordable agentic coding.                              |
| **GPT-5.5** `gpt-5.5` **(Default)**           | Light · Medium · High · Extra                   | Toggle | Default while the GPT-5.6 rollout remains account-dependent.     |
| **GPT-5.4** `gpt-5.4`                         | Light · Medium · High · Extra                   | Toggle | Still offered when directly runnable even if discovery omits it. |
| **GPT-5.4 Mini** `gpt-5.4-mini`               | Light · Medium · High · Extra                   | —      | Smaller GPT-5.4 option.                                          |
| **GPT-5.3 Codex Spark** `gpt-5.3-codex-spark` | Light · Medium · High · Extra                   | —      | Research preview where available.                                |

<table>
  <tr>
    <td width="10" bgcolor="#B16105"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-claude.png" alt="Claude logo" width="34" />
    </td>
    <td valign="middle"><strong>Claude / Anthropic</strong><br /><sub>Clay provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model                                               | Reasoning                                       | Fast   | Notes                                                  |
| --------------------------------------------------- | ----------------------------------------------- | ------ | ------------------------------------------------------ |
| **Opus 5** `claude-opus-5`                          | Light · Medium · High · Extra · Max · Ultracode | Toggle | 1M context by default, adaptive thinking.              |
| **Fable 5.1** `claude-fable-5-1`                    | Light · Medium · High · Extra · Max · Ultracode | —      | 1M context, adaptive thinking.                         |
| **Sonnet 5** `claude-sonnet-5` **(Default)**        | Light · Medium · High · Extra · Max · Ultracode | —      | 1M context, extended thinking.                         |
| **Fable 5 Legacy** `claude-fable-5`                 | Light · Medium · High · Extra · Max · Ultracode | —      | 1M context legacy Fable, adaptive thinking.            |
| **Sonnet 4.6 Legacy** `claude-sonnet-4-6`           | Light · Medium · High · Max                     | —      | 200K context legacy Sonnet.                            |
| **Opus 4.8 1M Legacy** `claude-opus-4-8-1m`         | Light · Medium · High · Extra · Max · Ultracode | Toggle | 1M context legacy Opus, extended thinking.             |
| **Opus 4.7 1M Legacy** `claude-opus-4-7-1m`         | Light · Medium · High · Extra · Max · Ultracode | Toggle | 1M context legacy Opus.                                |
| **Haiku 4.5** `claude-haiku-4-5`                    | —                                               | —      | Fast and efficient; no configurable reasoning control. |

<table>
  <tr>
    <td width="10" bgcolor="#0073E6"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-kimi.png" alt="Kimi logo" width="34" />
    </td>
    <td valign="middle"><strong>Kimi / Moonshot</strong><br /><sub>Blue provider hue · catalogued for admitted runtimes; packaged source-ahead builds await a commissioned tuple</sub></td>
  </tr>
</table>

| Model                                          | Reasoning        | Fast               | Notes                                            |
| ---------------------------------------------- | ---------------- | ------------------ | ------------------------------------------------ |
| **K2.7 Coding** `kimi-k2.7-code` **(Default)** | On (fixed)       | Toggle — Highspeed | Thinking is always on.                           |
| **K3 (up to 1M)** `kimi-k3`                    | Low · High · Max | —                  | 256K on Moderato; up to 1M on Allegretto+ tiers. |
| **K3 256K** `kimi-k3-256k`                     | Low · High · Max | —                  | Quota-efficient K3 route — fixed 256K context. Never inherits K2.7's Highspeed tier. |

<table>
  <tr>
    <td width="10" bgcolor="#757575"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-grok-on-light.png" alt="Grok logo" width="34" />
    </td>
    <td valign="middle"><strong>Grok / xAI</strong><br /><sub>Neutral provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model                                               | Reasoning           | Fast     | Notes                                                |
| --------------------------------------------------- | ------------------- | -------- | ---------------------------------------------------- |
| **Grok 4.6 Fast** `grok-4.6` **(Default)**          | Low · Medium · High · Extra-high | Included | 500K-context coding model; Fast is provider-encoded. |
| **Grok 4.5 Fast** `grok-4.5`                        | Low · Medium · High | Included | Previous default; retained as a selectable row.      |
| **Grok Composer 2.5 Fast** `grok-composer-2.5-fast` | —                   | Included | Historical/specialised Fast model row.               |

<table>
  <tr>
    <td width="10" bgcolor="#8C7508"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-cursor-on-light.png" alt="Cursor logo" width="34" />
    </td>
    <td valign="middle"><strong>Cursor</strong><br /><sub>Mustard provider hue · managed runs with native and TaskWraith tools</sub></td>
  </tr>
</table>

Managed Cursor is selectable for new runs and supports both Cursor's native
tools and TaskWraith's governed tool gateway. The selected permission posture
and workspace Tool Grants apply to TaskWraith-mediated calls; see
[Trust & Safety](TRUST_AND_SAFETY.md) for provider-native boundaries.

| Model                                                   | Reasoning           | Fast     | Notes                                                 |
| ------------------------------------------------------- | ------------------- | -------- | ----------------------------------------------------- |
| **Composer 2.5 Fast** `composer-2.5-fast` **(Default)** | —                   | Included | Fast route is encoded in the selected model row.      |
| **Composer 2.5** `composer-2.5`                         | —                   | Pair     | Select this normal row or its Fast counterpart above. |
| **Cursor Grok 4.6** `grok-4.6`                          | Low · Medium · High · Extra-high | Toggle | First-party Cursor model pool with 256K context.       |
| **Cursor Grok 4.5** `grok-4.5`                          | Low · Medium · High | Toggle   | First-party Cursor model pool with 500K context.      |

<table>
  <tr>
    <td width="10" bgcolor="#308713"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-antigravity.png" alt="AntiGravity logo" width="34" />
    </td>
    <td valign="middle"><strong>AntiGravity / Google</strong><br /><sub>Green provider hue · consented official CLI + separately billed Gemini API-key lanes</sub></td>
  </tr>
</table>

The separately consented official `agy` CLI lane follows the signed-in
AntiGravity subscription catalogue. Its newest family is:

| Model                                                           | Reasoning           | Fast | Notes                                                                      |
| --------------------------------------------------------------- | ------------------- | ---- | -------------------------------------------------------------------------- |
| **Gemini 3.7 Flash** `gemini-3.7-flash-{low,medium,high}`        | Low · Medium · High | —    | Authenticated `agy models` catalogue; availability remains account-controlled. |

The independent bring-your-own-key lane curates the authenticated Gemini API
`models.list` response, so the live picker—not a frozen documentation table—is
authoritative. Its current static fallback floor is:

| Model                                                               | Reasoning | Fast | Notes                                                       |
| ------------------------------------------------------------------- | --------- | ---- | ----------------------------------------------------------- |
| **Gemini 3.6 Flash** `gemini-api:gemini-3.6-flash`                  | —         | —    | Latest balanced model for agentic and multimodal work.      |
| **Gemini 3.5 Flash** `gemini-api:gemini-3.5-flash`                  | —         | —    | Sustained frontier performance for agentic and coding work. |
| **Gemini 3.1 Pro Preview** `gemini-api:gemini-3.1-pro-preview`      | —         | —    | Preview-tier reasoning model retained in the fallback floor. |
| **Gemini 3.1 Flash-Lite** `gemini-api:gemini-3.1-flash-lite`        | —         | —    | Lowest-cost row for high-throughput execution.              |

Live discovery wins for both lanes. The consent-gated CLI catalogue has a
current mixed-family floor so a transient `agy models` failure does not hide
the provider; the API-key lane likewise retains bounded fallback rows, and the
four rows above are exactly that floor — the 3.6, 3.5, and 3.1 families. The
2.5 family was dropped from the floor because `gemini-2.5-flash` now 404s as
"no longer available to new users". A stale row still fails visibly at
dispatch. See Google's
[Gemini API model catalogue](https://ai.google.dev/gemini-api/docs/models) for
the upstream API lifecycle.

<table>
  <tr>
    <td width="10" bgcolor="#1671EA"></td>
    <td valign="middle"><strong>Muse Code / Meta</strong><br /><sub>Meta blue provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model                                             | Reasoning                                       | Fast | Notes                              |
| ------------------------------------------------- | ----------------------------------------------- | ---- | ---------------------------------- |
| **Muse Spark 1.2** `muse-spark-1.2` **(Default)** | Light · Medium · High · Extra · Ultracode | —    | 200K context · $1.25/$4.25 per Mtok. |

Muse's model lifecycle is provider-published from the local Muse CLI catalogue,
so the live picker follows the CLI's own current-model set; the row above is
TaskWraith's curated fallback. Muse's own picker labels its stops **Minimal ·
Low · Medium · High · Extra High · Ultra**; the Reasoning column above maps
them onto the shared ladder vocabulary.

<table>
  <tr>
    <td width="10" bgcolor="#D44404"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-mistral.png" alt="Mistral logo" width="34" />
    </td>
    <td valign="middle"><strong>Mistral Vibe</strong><br /><sub>Mistral orange provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model                                                | Reasoning     | Fast | Notes                                                          |
| ---------------------------------------------------- | ------------- | ---- | -------------------------------------------------------------- |
| **Devstral Small** `devstral-small` **(Default)**    | —             | —    | 256K context · coding-tuned · $0.10/$0.30 per Mtok.            |
| **Mistral Medium 3.5** `mistral-medium-3.5`          | High (fixed)  | —    | 256K context · flagship · $1.50/$7.50 per Mtok. Always thinks at High. |
| **Mistral Large 3** `mistral-large-2512`             | —             | —    | 262K context · flagship · $0.50/$1.50 per Mtok.                |
| **GLM-5.2 (via Mistral)** `zai-glm-5-2`              | —             | —    | 1M context · $1.40/$4.40 per Mtok.                             |
| **Codestral (Aug 2025)** `codestral-2508`            | —             | —    | 131K context · coding-tuned · $0.30/$0.90 per Mtok.            |
| **Mistral Small 4** `mistral-small-2603`             | —             | —    | 256K context · $0.15/$0.60 per Mtok.                           |
| **Devstral 2** `devstral-2512`                       | —             | —    | 262K context · $0.40/$2.00 per Mtok.                           |
| **Leanstral 1.5 (Labs)** `labs-leanstral-1-5`        | —             | —    | 262K context · free research tier.                             |
| **Mistral Medium (Latest)** `mistral-medium-latest`  | —             | —    | 262K context · flagship · $1.50/$7.50 per Mtok.                |
| **Mistral Medium 3.1** `mistral-medium-2508`         | —             | —    | 262K context · $0.40/$2.00 per Mtok.                           |
| **Mistral Medium 3** `mistral-medium-2505`           | —             | —    | 131K context · $0.40/$2.00 per Mtok.                           |
| **Ministral 3 (14B)** `ministral-14b-2512`           | —             | —    | 262K context · $0.20/$0.20 per Mtok.                           |
| **Ministral 3 (8B)** `ministral-8b-2512`             | —             | —    | 262K context · $0.15/$0.15 per Mtok.                           |
| **Ministral 3 (3B)** `ministral-3b-2512`             | —             | —    | 262K context · $0.10/$0.10 per Mtok.                           |

Only the first two rows bill against the Vibe subscription. Every row below
them is API-only: it runs on a user-supplied Mistral API key
(`MISTRAL_API_KEY`), metered per token and separate from any Vibe plan.
The picker marks those rows with the API-key glyph so the lane is visible
before you start a run.

Vibe's third catalogue entry, `local`, is a llamacpp backend and is
deliberately omitted: local inference is Ollama's lane here, and listing it
would leave a permanently dead row for anyone without their own llama-server.

<table>
  <tr>
    <td width="10" bgcolor="#4878AE"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-devin-on-light.png" alt="Devin logo" width="34" />
    </td>
    <td valign="middle"><strong>Devin / Cognition</strong><br /><sub>Steel-blue provider hue · active for new runs</sub></td>
  </tr>
</table>

| Model | Vendor | Reasoning (default in bold) | List price (in / out per 1M tokens) | Notes |
| --- | --- | --- | --- | --- |
| **SWE-1.6 Slow** `swe-1-6-slow` **(Default)** | Cognition | — | $0.5 / $2.5 | Seat default; the model a fresh Devin CLI install pins in its own config |
| **SWE-1.6** `swe-1-6` | Cognition | — | $0.5 / $2.5 | — |
| **SWE-1.6 Fast** `swe-1-6-fast` | Cognition | — | $0.5 / $2.5 | — |
| **SWE-1.7** `swe-1-7` | Cognition | Medium · **Max** | $0.5 / $2.5 | The family the CLI resolves a bare `swe-1.7` to |
| **SWE-1.7 Lightning** `swe-1-7-lightning` | Cognition | Medium · **Max** | $2.5 / $12.5 | `swe` alias resolves here |
| **Adaptive** `adaptive` | Cognition | — | $0.5 / $2 | Cognition's model router; enterprise admins must enable it |
| **Claude Fable 5.1** `claude-fable-5-1` | Anthropic | Low · **Medium** · High · Extra High · Max | $10 / $50 | new |
| **Claude Opus 5** `claude-opus-5` | Anthropic | Low · **Medium** · High · Extra High · Max | $5 / $25 | `opus` alias resolves here |
| **Claude Sonnet 5** `claude-sonnet-5` | Anthropic | Low · **Medium** · High · Extra High · Max | $2 / $10 | `claude` / `sonnet` alias resolves here |
| **GPT-5.6 Sol** `gpt-5-6-sol` | OpenAI | None · Low · **Medium** · High · Extra High · Max | $4 / $20 | — |
| **GPT-5.6 Terra** `gpt-5-6-terra` | OpenAI | **None** · Low · Medium · High · Extra High · Max | $2 / $12 | `gpt` alias resolves here |
| **GPT-5.6 Luna** `gpt-5-6-luna` | OpenAI | None · Low · **Medium** · High · Extra High · Max | $0.2 / $1.2 | — |
| **GPT-5.3-Codex** `gpt-5-3-codex` | OpenAI | **Low** · Medium · High · Extra High | $1.75 / $14 | `codex` alias resolves here |
| **Gemini 3.7 Flash** `gemini-3-7-flash` | Google | Low · **Medium** · High | $1.5 / $7.5 | `gemini` alias resolves here |
| **Grok 4.6** `grok-4-6` | xAI | **Low** · Medium · High · Extra High | $2 / $6 | new; beta |
| **Grok 4.5** `grok-4-5` | xAI | **Low** · Medium · High | $2 / $6 | — |
| **Kimi K3** `kimi-k3` | Moonshot AI | Low · **High** · Max | $3 / $15 | — |
| **GLM-5.3** `glm-5-3` | Z.ai | **Low** · High · Max | $1.4 / $4.4 | — |
| **GLM-5.3 Flash** `glm-5-3-flash` | Z.ai | **Low** · High · Max | $0.15 / $0.5 | — |
| **GLM-5.2** `glm-5-2` | Z.ai | None · **High** · Max | $1.4 / $4.4 | — |
| **GLM-5.2 1M** `glm-5-2-1m` | Z.ai | None · **High** · Max | $0.7 / $2.2 | 1M-context variants of GLM-5.2 |
| **DeepSeek V4 Pro** `deepseek-v4-pro` | DeepSeek | **Low** · High · Max | $1.32 / $3.96 | — |
| **DeepSeek V4 Flash** `deepseek-v4-flash` | DeepSeek | **Low** · High · Max | $0.14 / $0.28 | — |
| **Inkling** `inkling` | Thinking Machines | **None** · Low · Medium · High · Extra High · Max | $1.4 / $4.4 | — |
| **Nemotron 3 Ultra** `nemotron-3-ultra` | NVIDIA | **None** · Medium · High | $0.6 / $2.4 | — |

Devin's rows are the model families the Devin CLI itself enumerates
(`devin models list --format json`, CLI 3000.6.7, retrieved 2026-09-01), one
picker row per family with the CLI's own label and the list price it showed for
a self-serve seat; enterprise seats are metered in ACUs instead. A family's
reasoning column is its variant ladder: the ordinary effort slider picks the
level and the run folds it into the exact CLI variant as
`devin acp --model <family>-<level>` (SWE-1.7 at Max is the bare `swe-1-7`
uid), so "Claude Opus 5" plus "High" dispatches `claude-opus-5-high`. The
picker carries Cognition's own families and the Adaptive router in full, plus
the newest generation of every other vendor line without the double-price
`-fast` / `-priority` speed tiers; the curation rule lives in
`src/shared/devinModelCatalog.ts`. There is no "CLI default" row — a legacy
stored `cli-default` selection resolves to SWE-1.6 Slow, and a custom id
outside the catalogue passes through verbatim and fails visibly at the CLI if
unknown. The seat is the Devin CLI over ACP on your own paid seat. It
authenticates through `WINDSURF_API_KEY` / `DEVIN_API_KEY` or the credentials
file written by `devin auth login`, and Settings → Providers → Devin can pin a
custom API server URL (HTTPS only; HTTP on loopback).

<table>
  <tr>
    <td width="10" bgcolor="#68768C"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-pi-on-light.png" alt="Pi logo" width="34" />
    </td>
    <td valign="middle"><strong>Pi</strong><br /><sub>Slate provider hue · active for new runs · bring your own upstream keys</sub></td>
  </tr>
</table>

Pi brokers several upstreams behind one seat. Unlike AntiGravity's API lane,
the catalogue is **not** live-discovered: it is a version-pinned list extracted
from the Pi CLI's bundled catalogue, because a provider whose model list can
transiently come back empty would vanish from every picker. You only see rows
for upstreams you have configured a key for, so this table is broader than what
any one install shows. Rows retire on dated lifecycle entries.

Two upstreams are folded in the ids below. The Xiaomi token plan ships three
regional deployments of one identical MiMo catalogue
(`xiaomi-token-plan-{cn,sgp,ams}`); Settings → Providers → Pi files your key
under exactly one region, so only that region's rows are ever offered. The
OpenRouter rows are user-approved exceptions rather than a general OpenRouter
lane, and their metadata is written into the run's isolated Pi home at launch.

| Model                                                     | Reasoning    | Fast | Notes                                       |
| ----------------------------------------------------------- | ------------ | ---- | --------------------------------------------- |
| **DeepSeek V4 Pro** `deepseek/deepseek-v4-pro`             | —            | —    | 1M context via DeepSeek.                    |
| **DeepSeek V4 Flash** `deepseek/deepseek-v4-flash` **(Default)** | —      | —    | 1M context via DeepSeek.                    |
| **GLM-5.2** `zai/glm-5.2`                                  | —            | —    | 1M context via Z.ai.                        |
| **GLM-5.1** `zai/glm-5.1`                                  | —            | —    | 200K context via Z.ai.                      |
| **GLM-4.7** `zai/glm-4.7`                                  | —            | —    | ~200K context via Z.ai.                     |
| **Qwen3.7 Max** `qwen-token-plan/qwen3.7-max`              | —            | —    | 1M context via the Qwen token plan.         |
| **Qwen3.7 Plus** `qwen-token-plan/qwen3.7-plus`            | —            | —    | 1M context via the Qwen token plan.         |
| **Qwen3.8 Max** `qwen-token-plan/qwen3.8-max`              | —            | —    | 1M context via the Qwen token plan. The `…-max-preview` id survives only as a legacy alias for older transcripts. |
| **MiniMax M3** `minimax/MiniMax-M3`                        | Off / High   | —    | 1M context via MiniMax; High is the on/adaptive control. |
| **MiniMax M2.7** `minimax/MiniMax-M2.7`                    | —            | —    | ~200K context via MiniMax.                  |
| **MiMo V2 Pro** `xiaomi-token-plan-{cn,sgp,ams}/mimo-v2-pro` | —          | —    | 1M context via the Xiaomi token plan. **Retired 2026-08-30** after Xiaomi sunset it in favor of MiMo V2.5 and MiMo V2.5 Pro; no longer offered for new runs, kept here so older transcripts still decode. |
| **MiMo V2.5** `xiaomi-token-plan-{cn,sgp,ams}/mimo-v2.5`   | —            | —    | 1M context via the Xiaomi token plan.       |
| **MiMo V2.5 Pro** `xiaomi-token-plan-{cn,sgp,ams}/mimo-v2.5-pro` | —      | —    | 1M context via the Xiaomi token plan.       |
| **Devstral 2512** `mistral/devstral-2512`                  | —            | —    | 256K context via Mistral.                   |
| **Mistral Medium 3.5** `mistral/mistral-medium-3.5`        | High (fixed) | —    | 256K context via Mistral. Always thinks at High. |
| **Mistral Large 3 (2512)** `mistral/mistral-large-2512`    | —            | —    | 256K context via Mistral. Not a reasoning model. |
| **GLM-5.2 (via Mistral)** `mistral/zai-glm-5-2`            | —            | —    | 1M context via Mistral.                     |
| **Mistral Medium (Latest)** `mistral/mistral-medium-latest` | —           | —    | 256K context via Mistral.                   |
| **Mistral Small 4** `mistral/mistral-small-2603`           | —            | —    | 256K context via Mistral.                   |
| **Mistral Medium 3.1** `mistral/mistral-medium-2508`       | —            | —    | 256K context via Mistral.                   |
| **Mistral Medium 3** `mistral/mistral-medium-2505`         | —            | —    | 131K context via Mistral.                   |
| **Codestral (Aug 2025)** `mistral/codestral-2508`          | —            | —    | 131K context via Mistral.                   |
| **Leanstral 1.5 (Labs)** `mistral/labs-leanstral-1-5`      | —            | —    | 256K context via Mistral. Free research tier. |
| **Ministral 3 (14B)** `mistral/ministral-14b-2512`         | —            | —    | 256K context via Mistral.                   |
| **Ministral 3 (8B)** `mistral/ministral-8b-2512`           | —            | —    | 256K context via Mistral.                   |
| **Ministral 3 (3B)** `mistral/ministral-3b-2512`           | —            | —    | 256K context via Mistral.                   |
| **GPT-OSS 120B (Groq)** `groq/openai/gpt-oss-120b`         | —            | —    | 131K context via Groq.                      |
| **Qwen3 32B (Groq)** `groq/qwen/qwen3-32b`                 | —            | —    | 131K context via Groq.                      |
| **GLM-4.7 (Cerebras)** `cerebras/zai-glm-4.7`              | —            | —    | 131K context via Cerebras. **Retired 2026-08-17**; no longer offered for new runs, kept here so older transcripts still decode. |
| **GPT-OSS 120B (Cerebras)** `cerebras/gpt-oss-120b`        | —            | —    | 131K context via Cerebras.                  |
| **Ox Alpha** `openrouter/stealth/ox-alpha`                 | —            | —    | **Retired 2026-08-28** after OpenRouter withdrew it; no longer offered for new runs, kept here so older chats and saved ensemble seats still decode. |
| **GLM 5.2** `openrouter/z-ai/glm-5.2`                     | —            | —    | 256K context via OpenRouter.                |
| **Laguna S 2.1** `openrouter/poolside/laguna-s-2.1`        | —            | —    | 256K context via OpenRouter.                |
| **Nemotron 3 Ultra** `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | — | — | 1M context via OpenRouter.                  |
| **North Mini Code (OpenRouter Free)** `openrouter/cohere/north-mini-code:free` | Off / High | — | 256K context, 64K output, text and tools via OpenRouter. |
| **MiniMax M3 (OpenRouter Free)** `openrouter/minimax/minimax-m3:free` | Off / High | — | 1M multimodal context via OpenRouter.       |
| **Inkling (OpenRouter Free)** `openrouter/thinkingmachines/inkling:free` | Off → Max | — | 1M text/image context, 256K output; Minimal, Low, Medium, High, and Max (no Extra High). |
| **Inkling Small (OpenRouter Free)** `openrouter/thinkingmachines/inkling-small:free` | Off → Max | — | Faster Inkling route with the same 1M context and effort ladder. |

Pi sends `--thinking` only when a reasoning choice is set, and every picker is
filtered through the selected route's own ladder. Boolean routes expose only
Off and High; always-on routes hide Off; Inkling keeps Off and Minimal distinct
and omits unsupported Extra High. UltraTask/top-tier requests clamp to the
selected model's real ceiling instead of forwarding a level that route ignores.
Leaving the control unset preserves the upstream default.

The two free Inkling endpoints are research, agentic-harness-only routes.
Thinking Machines logs prompts and outputs for model improvement, so TaskWraith
surfaces them without gating the user-approved capability and warns users not to
send confidential or personal data through those free endpoints.

<table>
  <tr>
    <td width="10" bgcolor="#1A8562"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-ollama.png" alt="Ollama logo" width="28" />
    </td>
    <td valign="middle"><strong>Ollama / local</strong><br /><sub>Green provider hue · active when Ollama is installed and reachable</sub></td>
  </tr>
</table>

Ollama now has two lanes, and the picker separates them. **Local** models are
discovered from the local daemon, so only pulled model tags can run; the
curated presets below make common choices easy to find, and **Custom model ID**
accepts another compatible installed tag.

**Cloud** models are discovered from your signed-in Ollama account rather than
from pulled tags, so they run without being present on disk (shipped in
v1.9.6). Discovery reports whether the daemon supports cloud, whether cloud is
enabled, and whether you are authenticated; a model may additionally name a
required plan. Nothing appears unless the daemon both supports and enables
cloud, so a local-only install is unchanged. In the composer picker a cloud
group is marked with a cloud icon in place of the usual provider swatch, and
model preflight states cloud rather than local expectations for those rows.

There is no generic TaskWraith reasoning or Fast switch for either lane—native
tool, vision, and thinking capabilities remain model-specific.

| Curated local model        | Model ID             | Picker note                                     |
| -------------------------- | -------------------- | ----------------------------------------------- |
| Qwen 3 (4B Param) **(Default)** | `qwen3:4b-instruct` | 262K local context.                        |
| Qwen 3.5 (2B Param)        | `qwen3.5:2b`         | 262K; vision, tools, thinking.                  |
| Qwen 3.5 (4B Param)        | `qwen3.5:4b`         | 262K local context.                             |
| Qwen 3.5 (9B)              | `qwen3.5:9b`         | 262K local context.                             |
| Qwen 3.6 (35B-A3B)         | `qwen3.6:35b`        | 262K; vision, tools, thinking.                  |
| Qwen 3.8 (27B-MLX)         | `qwen3.8:27b-mlx`    | 262K; vision, tools, thinking.                  |
| Qwen 3.8 Flash Next (125B-MLX) | `qwen3.8-flash-next:125b-mlx` | 262K; vision, tools, thinking; 6B active. |
| Gemma 3 (4B Param)         | `gemma3:4b`          | 131K; vision.                                   |
| Gemma 4 (12B)              | `gemma4:12b`         | 262K local context.                             |
| Gemma 4 (31B-MLX)          | `gemma4:31b-mlx`     | 262K local context.                             |
| Ornith 1.0 (9B)            | `ornith:9b`          | 262K agentic coding.                            |
| Ornith 1.0 (35B)           | `ornith:35b`         | 262K agentic coding.                            |
| Ornith 1.5 (9B Param)      | `ornith-1.5:9b`      | 262K agentic coding.                            |
| Ornith 1.5 (35B Param)     | `ornith-1.5:35b`     | 262K agentic coding.                            |
| Laguna XS 2.1 (33B-A3B Q8) | `laguna-xs-2.1:q8_0` | 262K; tools and thinking.                       |
| GPT OSS (20B)              | `gpt-oss:20b`        | 131K local context.                             |
| LFM 2.5 Thinking (1.2B Param) | `lfm2.5-thinking:1.2b` | 128K; tools, thinking.                    |
| LFM 2.5 (8B-A1B)           | `lfm2.5:8b`          | 128K; tools, thinking.                          |
| MiniCPM-V 4.5 (8B)         | `minicpm-v4.5:8b`    | 40K; vision, tools, thinking.                   |
| Granite 4.0 (3B Param)     | `granite4:3b`        | 131K; tools.                                    |
| Granite 4.1 (3B)           | `granite4.1:3b`      | 131K; tools.                                    |
| Granite 4.1 (30B)          | `granite4.1:30b`     | 131K; tools.                                    |
| Granite 4.2 (3B)           | `granite4.2:3b`      | 131K; tools, thinking.                          |
| Granite 4.2 (8B)           | `granite4.2:8b`      | 131K; tools, thinking.                          |
| Granite 4.2 (30B)          | `granite4.2:30b`     | 131K; tools, thinking.                          |
| Nemotron 3 Nano (4B Param) | `nemotron-3-nano:4b` | 262K; tools, thinking.                          |
| Nemotron 3 Nano Omni (33B) | `nemotron3:33b`      | 131K; vision, tools, thinking.                  |
| Nemotron 3.5 Lightning (30B-MLX) | `nemotron-3.5-lightning:30b-mlx` | 262K; tools, thinking; 3B active. |
| Devstral Small 2 (24B Param) | `devstral-small-2:24b` | 393K; vision, tools; agentic coding.        |
| Mistral Medium 3.5 (128B Param) | `mistral-medium-3.5:128b` | 262K; vision, tools, thinking; agentic coding. |
| Ministral 3 (3B Param)     | `ministral-3:3b`     | 262K; vision, tools.                            |
| Ministral 3 (14B Param)    | `ministral-3:14b`    | 262K; vision, tools.                            |
| Muse Glimmer (30B-MLX)     | `muse-glimmer:30b-mlx` | 131K; vision, tools, thinking.                |
| Llama 3.1 (8B Param)       | `llama3.1:8b`        | 131K; tools.                                    |
| DeepSeek R1 (1.5B Param)   | `deepseek-r1:1.5b`   | 131K; tools, thinking.                          |
| DeepSeek R1 (8B Param)     | `deepseek-r1:8b`     | 131K; tools, thinking.                          |
| Rnj-1 (8B Param)           | `rnj-1`              | 33K; tools; agentic coding.                     |
| GLM-4.7-Flash (30B-A3B Q4) | `glm-4.7-flash:q4_K_M` | 203K; tools, thinking.                        |
| North Mini Code 1.0 (30B-A3B Q4) | `north-mini-code-1.0:q4_K_M` | 500K; tools, thinking.          |
| Llama 3.2 (3B Param)       | `llama3.2:3b`        | 131K; tools.                                    |
| Custom model ID            | `custom`             | Enter a compatible locally installed model tag. |

## Historical standalone provider

<table>
  <tr>
    <td width="10" bgcolor="#346EEC"></td>
    <td width="54" align="center" valign="middle">
      <img src="../design-assets/provider-logos/png/provider-logo-gemini.png" alt="Gemini logo" width="34" />
    </td>
    <td valign="middle"><strong>Gemini / Google (legacy provider id)</strong><br /><sub>Blue provider hue · historical chats remain readable; new runs are retired</sub></td>
  </tr>
</table>

Historical records under the older standalone `gemini` provider id can contain
**Auto** (`auto`), **Pro** (`pro`), **Flash** (`flash`), and **Flash Lite**
(`flash-lite`, the previous default). They are shown for history and usage
continuity only, not as new-run choices; the live AntiGravity integration above
is a separate provider path.

## Keeping this page current

The live picker remains authoritative. When supported models or their controls
change, update this page alongside
[StaticProviderModels.ts](../src/main/providers/StaticProviderModels.ts),
[the picker defaults](../src/renderer/src/lib/providerModelDefaults.ts),
and the [Provider, Model, and Permissions Pickers guide](../docs/how-to/composer/provider-model-permissions-pickers.md).
For official context-window and rate references, use **Settings → Data → Model
usage**.

Provider marks remain the property of their respective owners and are shown
only to identify supported integrations. See the linked provider-logo catalogue
for source and trademark guidance.
