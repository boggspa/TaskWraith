/**
 * The Pi seat's provider-circumvention wall.
 *
 * House policy: TaskWraith hosts first-party provider seats only. The Pi
 * seat exists to reach models TaskWraith does NOT already host (DeepSeek,
 * GLM, Qwen, MiniMax, Mistral, open-weights serving) — never as a second
 * door to Claude/GPT/Gemini/Grok/Kimi, whose first-party seats carry the
 * subscription terms. Pi itself happily talks to Anthropic/OpenAI/Google/
 * xAI/OpenRouter, so the wall must live on OUR side and fail closed.
 *
 * The user-approved exception is OpenRouter's Ox Alpha only. It is a single
 * model TaskWraith does not offer through another seat; admitting its whole
 * upstream catalogue would reintroduce duplicate model pickers. The exception
 * is therefore enforced as an exact model-id allowlist, not a broad upstream
 * pass-through:
 *
 *  1. Upstream allowlist — only the upstreams below may be configured,
 *     surfaced, or passed to `--provider`.
 *  2. Model deny-patterns — allowed upstreams can still resell hosted
 *     models (qwen-token-plan carries kimi-k2.x); those are refused by id.
 *  3. Env firewall — the spawned child env carries ONLY the allowlisted
 *     upstreams' key variables. A parent-process ANTHROPIC_API_KEY etc.
 *     must never leak in, or pi would silently unlock hosted models.
 *
 * Widening any of these lists is a policy decision, not a code cleanup.
 */

import { isPiModelRetired, piModelRetiresAt } from '../../shared/piModelLifecycle'

export type PiUpstreamId =
  | 'deepseek'
  | 'zai'
  | 'qwen-token-plan'
  | 'minimax'
  | 'mistral'
  | 'groq'
  | 'cerebras'
  | 'openrouter'

export const PI_ALLOWED_UPSTREAMS: readonly PiUpstreamId[] = [
  'deepseek',
  'zai',
  'qwen-token-plan',
  'minimax',
  'mistral',
  'groq',
  'cerebras',
  'openrouter'
]

/** Upstream → the env var pi reads its API key from (docs/providers.md). */
export const PI_UPSTREAM_KEY_ENV: Readonly<Record<PiUpstreamId, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  zai: 'ZAI_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
}

export const PI_UPSTREAM_LABELS: Readonly<Record<PiUpstreamId, string>> = {
  deepseek: 'DeepSeek',
  zai: 'Z.ai (GLM)',
  'qwen-token-plan': 'Qwen Token Plan',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  groq: 'Groq',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter'
}

/**
 * OpenRouter is intentionally a narrow exception. Keep this exact list
 * narrow: every additional id would become another duplicate cross-provider
 * route in Pi's picker.
 */
export const PI_OPENROUTER_ALLOWED_MODEL_IDS = ['stealth/ox-alpha', 'zai/glm-5.2'] as const

/**
 * Model-id deny patterns within otherwise-allowed upstreams. qwen-token-plan
 * resells Moonshot's kimi-k2.x — TaskWraith hosts Kimi first-party, so those
 * ids are exactly the "adjacent same-model seat" the policy forbids.
 */
const PI_DENIED_MODEL_PATTERNS: readonly RegExp[] = [/^kimi/i]

export function isPiUpstreamAllowed(upstream: string): upstream is PiUpstreamId {
  return (PI_ALLOWED_UPSTREAMS as readonly string[]).includes(upstream)
}

export interface PiModelPolicyVerdict {
  allowed: boolean
  reason?: string
}

/** Fail-closed gate consulted before any `--provider`/`--model` reaches pi. */
export function piModelPolicyVerdict(
  upstream: string,
  modelId: string,
  now: Date = new Date()
): PiModelPolicyVerdict {
  if (!isPiUpstreamAllowed(upstream)) {
    return {
      allowed: false,
      reason: `Pi upstream '${upstream}' is not in TaskWraith's allowlist (first-party seats cover the hosted providers).`
    }
  }
  const trimmed = modelId.trim()
  if (!trimmed) {
    return { allowed: false, reason: 'Pi model id is empty.' }
  }
  if (
    upstream === 'openrouter' &&
    !(PI_OPENROUTER_ALLOWED_MODEL_IDS as readonly string[]).includes(trimmed)
  ) {
    return {
      allowed: false,
      reason: `Pi's OpenRouter lane is limited to specific models (${PI_OPENROUTER_ALLOWED_MODEL_IDS.join(', ')}).`
    }
  }
  for (const pattern of PI_DENIED_MODEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Pi model '${trimmed}' is a resold copy of a model TaskWraith hosts first-party.`
      }
    }
  }
  const wireModelId = `${upstream}/${trimmed}`
  if (isPiModelRetired(wireModelId, now)) {
    const retiredAt = piModelRetiresAt(wireModelId)
    return {
      allowed: false,
      reason: `${PI_UPSTREAM_LABELS[upstream]} model '${trimmed}' was retired on ${retiredAt}. Choose an active model before starting another run.`
    }
  }
  return { allowed: true }
}

export function assertPiModelAllowed(upstream: string, modelId: string): void {
  const verdict = piModelPolicyVerdict(upstream, modelId)
  if (!verdict.allowed) {
    throw new Error(verdict.reason ?? 'Pi model refused by policy.')
  }
}

/**
 * The env firewall: given the base child env and the configured upstream
 * keys, return an env containing NO provider key variables except the
 * allowlisted upstreams that are actually configured. Every other known
 * pi credential variable (hosted providers, aggregators, cloud gateways)
 * is stripped even if present in the parent environment.
 */
const PI_FOREIGN_CREDENTIAL_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'XAI_API_KEY',
  'RADIUS_API_KEY',
  'KIMI_API_KEY',
  'NVIDIA_API_KEY',
  'ANT_LING_API_KEY',
  'OPENCODE_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'MINIMAX_CN_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLOUDFLARE_API_KEY',
  'AI_GATEWAY_API_KEY'
]

export function buildPiCredentialEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  configuredKeys: Readonly<Partial<Record<PiUpstreamId, string>>>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv }
  for (const name of PI_FOREIGN_CREDENTIAL_ENV_VARS) {
    delete env[name]
  }
  // Allowlisted upstream vars are also reset first so a parent-shell value
  // can never widen the configured set.
  for (const upstream of PI_ALLOWED_UPSTREAMS) {
    delete env[PI_UPSTREAM_KEY_ENV[upstream]]
  }
  for (const upstream of PI_ALLOWED_UPSTREAMS) {
    const key = configuredKeys[upstream]
    if (typeof key === 'string' && key.trim()) {
      env[PI_UPSTREAM_KEY_ENV[upstream]] = key.trim()
    }
  }
  return env
}
