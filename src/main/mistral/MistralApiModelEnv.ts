/**
 * Make a key-marked Mistral model the model Vibe actually runs.
 *
 * `vibe-acp` switches only to an alias in its own loaded model list
 * (`set_config_option model=` matches `config.models`). That list is Vibe's
 * built-ins, its plan extras and the user's ~/.vibe/config.toml, and none of
 * TaskWraith's API-key rows are in it. The switch was therefore never sent, and
 * the turn ran Vibe's persisted model on the user's API key. Measured
 * 2026-10-06 against Vibe's own session logs: 206 key-marked turns between
 * 2026-08-17 and 2026-09-09, none priced as the model that was requested.
 *
 * Vibe 2.25 reads VIBE_* variables above the user TOML (its EnvironmentLayer).
 * `VIBE_MODELS` adds the selected model by alias, and models deep-merge, so the
 * user's own entries survive. `VIBE_ACTIVE_MODEL` then opens the session on it.
 * Nothing is written to disk.
 *
 * Thinking travels in the same entry on purpose. The environment is not a
 * durable Vibe layer, so a later `set_config_option thinking=` on this alias
 * would materialize a full `[[models]]` entry for it in the user's real
 * config.toml. Opening the session at the run's thinking level means it
 * already reports the requested value, and TaskWraith never sends that write.
 */
import { modelRequiresApiKey } from '../../shared/apiKeyModelIndicator'
import { isMistralThinkingCapableModel } from '../../shared/mistralModels'
import { taskWraithModelLabel } from '../../shared/taskWraithProviderPresentation'
import { MISTRAL_SEAT_MODELS, type MistralThinkingLevel } from './MistralCliArgs'
import { mistralModelRate } from './MistralUsage'

export const VIBE_MODELS_ENV = 'VIBE_MODELS'
export const VIBE_ACTIVE_MODEL_ENV = 'VIBE_ACTIVE_MODEL'

/**
 * Image input for each key-marked seat model. Vibe refuses an image turn on a
 * model without it, or reroutes the image through a separate vision model.
 * Mirrors PI_STATIC_MODELS `images` wherever the Pi lane carries the same
 * Mistral API model (a test pins the agreement); `mistral-large-4` and
 * `zai-glm-5-3` are seat-only rows, sourced from api.mistral.ai/v1/models.
 */
export const MISTRAL_API_MODEL_IMAGE_INPUT: Readonly<Record<string, boolean>> = {
  'mistral-large-4': true,
  'zai-glm-5-3': false,
  'mistral-large-2512': true,
  'zai-glm-5-2': false,
  'codestral-2508': false,
  'mistral-small-2603': true,
  'labs-leanstral-1-5': false,
  'mistral-medium-latest': true,
  'mistral-medium-2508': true,
  'mistral-medium-2505': true,
  'ministral-14b-2512': true,
  'ministral-8b-2512': true,
  'ministral-3b-2512': true
}

/**
 * Starting level for a thinking-capable API model when the run names none.
 * Vibe sends medium, high and max all as the API's `high`, which Mistral
 * recommends for agentic and coding work.
 */
const MISTRAL_API_DEFAULT_THINKING: MistralThinkingLevel = 'high'

export interface MistralApiModelVibeConfig {
  env: Record<typeof VIBE_MODELS_ENV | typeof VIBE_ACTIVE_MODEL_ENV, string>
  /** The level the session opens at, and so the only one it can be asked for. */
  thinkingLevel: MistralThinkingLevel
}

/**
 * The Vibe environment that opens a session on a key-marked seat model, or
 * null for a subscription model or an id outside this seat's catalogue.
 *
 * A model without a thinking ladder always opens at `off`, whatever level the
 * run carried over, so Vibe never sends `reasoning_effort` to a model that
 * does not take it.
 */
export function mistralApiModelVibeConfig(
  model: string | null | undefined,
  requestedThinking: MistralThinkingLevel | null | undefined
): MistralApiModelVibeConfig | null {
  const alias = typeof model === 'string' ? model.trim() : ''
  if (!(MISTRAL_SEAT_MODELS as readonly string[]).includes(alias)) return null
  if (!modelRequiresApiKey('mistral', alias)) return null
  const thinkingLevel: MistralThinkingLevel = isMistralThinkingCapableModel(alias)
    ? (requestedThinking ?? MISTRAL_API_DEFAULT_THINKING)
    : 'off'
  const rate = mistralModelRate(alias)
  const entry = {
    name: alias,
    provider: 'mistral',
    alias,
    display_name: taskWraithModelLabel('mistral', alias) ?? alias,
    input_price: rate.inputUsdPerMillion,
    output_price: rate.outputUsdPerMillion,
    thinking: thinkingLevel,
    supports_images: MISTRAL_API_MODEL_IMAGE_INPUT[alias] === true
  }
  return {
    env: {
      [VIBE_MODELS_ENV]: JSON.stringify([entry]),
      [VIBE_ACTIVE_MODEL_ENV]: alias
    },
    thinkingLevel
  }
}
