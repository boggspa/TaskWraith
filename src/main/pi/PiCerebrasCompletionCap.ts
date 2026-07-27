import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS,
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
} from '../../shared/piCerebrasCompletionCap'

export {
  PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS,
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
}

/**
 * Pi reads `models.json` from PI_CODING_AGENT_DIR. TaskWraith gives every
 * run a fresh, owner-only directory, so write the selected Cerebras cap into
 * that isolated home instead of changing the user's global Pi configuration.
 */
export function writePiCerebrasCompletionCapOverride(input: {
  isolatedHomeDir: string
  modelId: string
  maxCompletionTokens: number
}): void {
  const modelId = input.modelId.trim()
  const maxCompletionTokens = normalizePiCerebrasMaxCompletionTokens(input.maxCompletionTokens)
  if (!modelId || modelId.includes('\0')) {
    throw new TypeError('Pi Cerebras model id is invalid.')
  }
  if (maxCompletionTokens === undefined) {
    throw new RangeError(
      `Pi Cerebras completion cap must be a whole number from 1 to ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS}.`
    )
  }

  const modelsPath = join(input.isolatedHomeDir, 'models.json')
  const config = {
    providers: {
      cerebras: {
        modelOverrides: {
          [modelId]: { maxTokens: maxCompletionTokens }
        }
      }
    }
  }
  // The directory is freshly created and owner-only. Exclusive creation keeps
  // a malformed pre-existing config from being overwritten or silently used.
  writeFileSync(modelsPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

/**
 * Cerebras's 429 body is sometimes empty. Keep the raw error intact while
 * attaching the actionable Pi-specific explanation only for a Cerebras model.
 */
export function enrichPiCerebrasRateLimitError(model: string, message: string): string {
  if (!model.startsWith('cerebras/') || !/(?:^|\D)429(?:\D|$)/.test(message)) {
    return message
  }
  return `${message}\n\nCerebras rate-limit note: Pi normally requests up to ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS.toLocaleString()} completion tokens. Cerebras reserves prompt tokens plus that requested completion budget before it records usage, so a 30,000 TPM project allocation can reject this turn before processing—even when the organization-level limit is higher. In Settings → Providers → Pi, apply a lower Cerebras completion cap (${PI_CEREBRAS_30K_TPM_RECOMMENDED_MAX_COMPLETION_TOKENS.toLocaleString()} is a conservative starting point for 30k TPM), or raise the API key's Cerebras project allocation. Other 429s, including Cerebras's 5-RPM project limit, can still occur.`
}
