export const KIMI_K27_MODEL_ID = 'kimi-k2.7-code'
export const KIMI_K3_MODEL_ID = 'kimi-k3'
export const KIMI_K3_256K_MODEL_ID = 'kimi-k3-256k'

export const KIMI_STANDARD_API_MODEL = 'kimi-for-coding'
export const KIMI_HIGHSPEED_API_MODEL = 'kimi-for-coding-highspeed'
export const KIMI_K3_API_MODEL = 'k3'
export const KIMI_K3_256K_API_MODEL = 'k3-256k'

export const KIMI_STANDARD_CLI_MODEL = `kimi-code/${KIMI_STANDARD_API_MODEL}`
export const KIMI_HIGHSPEED_CLI_MODEL = `kimi-code/${KIMI_HIGHSPEED_API_MODEL}`
export const KIMI_K3_CLI_MODEL = `kimi-code/${KIMI_K3_API_MODEL}`
export const KIMI_K3_256K_CLI_MODEL = `kimi-code/${KIMI_K3_256K_API_MODEL}`

// Kimi's published "256K" window is 256 Ki-tokens on the wire. Keep the
// exact values for context math while presentation continues to use Kimi's
// familiar 256K / 1M labels.
export const KIMI_256K_CONTEXT_WINDOW = 262_144
export const KIMI_K3_LONG_CONTEXT_WINDOW = 1_048_576

export const KIMI_K3_REASONING_EFFORTS = ['low', 'high', 'max'] as const
export type KimiK3ReasoningEffort = (typeof KIMI_K3_REASONING_EFFORTS)[number]

const KIMI_K3_LONG_ROUTE_IDS = new Set([KIMI_K3_MODEL_ID, KIMI_K3_API_MODEL, KIMI_K3_CLI_MODEL])
const KIMI_K3_256K_ROUTE_IDS = new Set([
  KIMI_K3_256K_MODEL_ID,
  KIMI_K3_256K_API_MODEL,
  KIMI_K3_256K_CLI_MODEL
])

function normalizedKimiModelId(model?: string | null): string {
  return String(model || '')
    .trim()
    .toLowerCase()
}

export function canonicalKimiK3ModelId(
  model?: string | null
): typeof KIMI_K3_MODEL_ID | typeof KIMI_K3_256K_MODEL_ID | null {
  const normalized = normalizedKimiModelId(model)
  if (KIMI_K3_LONG_ROUTE_IDS.has(normalized)) return KIMI_K3_MODEL_ID
  if (KIMI_K3_256K_ROUTE_IDS.has(normalized)) return KIMI_K3_256K_MODEL_ID
  return null
}

export function isKimiK3Model(model?: string | null): boolean {
  return canonicalKimiK3ModelId(model) !== null
}

export function canonicalKimiTaskWraithModelId(
  model?: string | null
): typeof KIMI_K27_MODEL_ID | typeof KIMI_K3_MODEL_ID | typeof KIMI_K3_256K_MODEL_ID | null {
  const normalized = normalizedKimiModelId(model)
  const k3 = canonicalKimiK3ModelId(normalized)
  if (k3) return k3
  if (
    normalized === KIMI_K27_MODEL_ID ||
    normalized === KIMI_STANDARD_API_MODEL ||
    normalized === KIMI_STANDARD_CLI_MODEL ||
    normalized === KIMI_HIGHSPEED_API_MODEL ||
    normalized === KIMI_HIGHSPEED_CLI_MODEL
  ) {
    return KIMI_K27_MODEL_ID
  }
  return null
}

/**
 * Resolve a TaskWraith Kimi model selection to the alias accepted by Kimi
 * Code's `--model` and ACP model config. A null result means the caller may
 * omit `--model` and let the K2.7 standard default stand.
 */
export function kimiCliModelAlias(model: string, serviceTier?: string | null): string | null {
  const trimmed = model.trim()
  const normalized = trimmed.toLowerCase()
  const canonicalK3 = canonicalKimiK3ModelId(normalized)

  // K3 routes are independent model ids, not speed tiers. Resolve them before
  // the shared Fast field so a stale K2.7 flag can never change their family.
  if (canonicalK3 === KIMI_K3_MODEL_ID) return KIMI_K3_CLI_MODEL
  if (canonicalK3 === KIMI_K3_256K_MODEL_ID) return KIMI_K3_256K_CLI_MODEL

  if (serviceTier === 'fast') return KIMI_HIGHSPEED_CLI_MODEL
  if (serviceTier === 'standard') return KIMI_STANDARD_CLI_MODEL
  if (!normalized || normalized === 'default' || normalized === KIMI_K27_MODEL_ID) {
    return null
  }
  if (normalized === KIMI_STANDARD_API_MODEL || normalized === KIMI_STANDARD_CLI_MODEL) {
    return KIMI_STANDARD_CLI_MODEL
  }
  if (normalized === KIMI_HIGHSPEED_API_MODEL || normalized === KIMI_HIGHSPEED_CLI_MODEL) {
    return KIMI_HIGHSPEED_CLI_MODEL
  }
  return trimmed
}

export function kimiExplicitCliModelAlias(model: string, serviceTier?: string | null): string {
  return kimiCliModelAlias(model, serviceTier) || KIMI_STANDARD_CLI_MODEL
}
