/**
 * Xiaomi MiMo registration shared by Electron main and the pure-Node Host.
 *
 * pi 0.84.2 (the pinned catalogue) bundles MiMo V2 Pro, V2.5 and V2.5 Pro for
 * the three token-plan regions and nothing newer, and 0.87.0 (2026-09-21, the
 * latest release) still stops at V2.5 Pro. The V2.6 rows therefore have to be
 * written into the isolated per-run home before spawn, exactly as the Cerebras
 * and OpenRouter registrations do, or `--model mimo-v2.6-pro` is refused before
 * a request is made. Verified on the installed 0.84.2: a `models.json` with the
 * entry below makes `pi --list-models mimo` list the route at 1.0M / 131.1K.
 *
 * The entry mirrors the shape pi ships for the V2.5 rows on the same upstream
 * (`pi-ai/dist/providers/data/xiaomi-token-plan-*.json`): OpenAI-completions
 * API, `thinkingFormat: 'deepseek'` (pi sends `thinking: { type }`, which is
 * the toggle Xiaomi documents for V2.6), and replayed assistant messages that
 * carry `reasoning_content`. Cost is zero because the token plan is a prepaid
 * credit allowance with no per-token rate. There is deliberately no
 * `thinkingLevelMap`: MiMo has no effort axis, so the on/off ladder in
 * `piReasoning` is the whole control surface.
 *
 * Sources, read 2026-09-22: https://mimo.mi.com/docs/en-US/updates/model,
 * https://mimo.mi.com/models/en-US/mimo-v2.6-pro,
 * https://mimo.mi.com/models/en-US/mimo-v2.6-flash,
 * https://mimo.mi.com/docs/en-US/price/token-plan, and the models.dev
 * registry pi generates its token-plan catalogs from.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XIAOMI_TOKEN_PLAN_UPSTREAMS, type PiUpstreamId } from './PiModelPolicy'
import { findPiStaticModel } from './PiModels'

/** MiMo ids the pinned pi does not bundle; every other MiMo row is pi's own. */
export const PI_XIAOMI_REGISTERED_MODEL_IDS: readonly string[] = [
  'mimo-v2.6-pro',
  'mimo-v2.6-flash'
]

export function isPiXiaomiTokenPlanUpstream(upstream: string): upstream is PiUpstreamId {
  return (XIAOMI_TOKEN_PLAN_UPSTREAMS as readonly string[]).includes(upstream)
}

/**
 * Register the selected unbundled MiMo route in Pi's owner-only per-run home.
 * Returns false, writing nothing, for a bundled MiMo row or a non-Xiaomi
 * upstream; throws on a malformed id or an existing models file.
 */
export function writePiXiaomiModelRegistration(input: {
  isolatedHomeDir: string
  upstream: string
  modelId: string
}): boolean {
  const modelId = input.modelId.trim()
  if (!modelId || modelId.includes(String.fromCharCode(0))) {
    throw new TypeError('Pi Xiaomi model id is invalid.')
  }
  if (!isPiXiaomiTokenPlanUpstream(input.upstream)) return false
  if (!PI_XIAOMI_REGISTERED_MODEL_IDS.includes(modelId)) return false
  const model = findPiStaticModel(`${input.upstream}/${modelId}`)
  if (!model) return false

  const config = {
    providers: {
      [input.upstream]: {
        models: [
          {
            id: model.modelId,
            name: model.label,
            api: 'openai-completions',
            reasoning: model.thinking,
            input: model.images ? ['text', 'image'] : ['text'],
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              requiresReasoningContentOnAssistantMessages: true,
              thinkingFormat: 'deepseek'
            }
          }
        ]
      }
    }
  }
  // The isolated home is fresh and owner-only. Exclusive creation refuses to
  // replace another configuration source if launch preparation ever changes.
  writeFileSync(join(input.isolatedHomeDir, 'models.json'), JSON.stringify(config), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  return true
}
