/**
 * Kimi Code's managed model routes, as the CLI itself configures them.
 *
 * Ground truth is the `[models."kimi-code/…"]` tables in `~/.kimi-code/config.toml`
 * (read live by `host-shared/kimi/KimiManagedModelCatalog.ts`); the constants here
 * are the fallback that keeps the picker honest before that read lands.
 *
 * Verified 2026-09-11 against Kimi Code's own config:
 *
 * | alias                                 | upstream model                | window | efforts        | default |
 * | ------------------------------------- | ----------------------------- | ------ | -------------- | ------- |
 * | `kimi-code/kimi-for-coding`            | `kimi-for-coding`             | 1M     | low/high/max   | max     |
 * | `kimi-code/kimi-for-coding-highspeed`  | `kimi-for-coding-highspeed`   | 256K   | (none)         | —       |
 * | `kimi-code/k3`                         | `k3`                          | 1M     | low/high/max   | high    |
 * | `kimi-code/k3-256k`                    | `k3-256k`                     | 256K   | low/high/max   | high    |
 *
 * The standard `kimi-for-coding` route now serves **K2.8 Preview** — Moonshot kept
 * the wire id deliberately so third-party clients need no reconfiguration — while
 * Highspeed stayed on K2.7. The two therefore no longer share a capability set,
 * which is why Highspeed is its own picker row rather than a speed tier.
 */

/** K2.8 Preview — the standard `kimi-for-coding` route. */
export const KIMI_K28_MODEL_ID = 'kimi-k2.8-preview'
/** K2.7 Code Highspeed — its own row since 2026-09-11, formerly K2.7's Fast tier. */
export const KIMI_K27_HIGHSPEED_MODEL_ID = 'kimi-k2.7-code-highspeed'
/**
 * The retired combined "K2.7 Coding" row. Kept as a constant because saved
 * chats, scheduled runs, and Ensemble seats still name it; it resolves forward
 * to the K2.8 Preview row, which is the same upstream route it always dispatched
 * when Fast was off.
 */
export const KIMI_K27_MODEL_ID = 'kimi-k2.7-code'
export const KIMI_K3_MODEL_ID = 'kimi-k3'
export const KIMI_K3_256K_MODEL_ID = 'kimi-k3-256k'

export const KIMI_K28_MODEL_LABEL = 'K2.8 Preview'
export const KIMI_K27_HIGHSPEED_MODEL_LABEL = 'K2.7 Code Highspeed'
export const KIMI_K3_MODEL_LABEL = 'K3 (1M)'
export const KIMI_K3_256K_MODEL_LABEL = 'K3 (256K)'

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

const KIMI_K28_ROUTE_IDS = new Set([
  KIMI_K28_MODEL_ID,
  KIMI_K27_MODEL_ID,
  KIMI_STANDARD_API_MODEL,
  KIMI_STANDARD_CLI_MODEL
])
const KIMI_K27_HIGHSPEED_ROUTE_IDS = new Set([
  KIMI_K27_HIGHSPEED_MODEL_ID,
  KIMI_HIGHSPEED_API_MODEL,
  KIMI_HIGHSPEED_CLI_MODEL
])
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

/** True for the K2.7 Code Highspeed route under any of its spellings. */
export function isKimiHighspeedModel(model?: string | null): boolean {
  return KIMI_K27_HIGHSPEED_ROUTE_IDS.has(normalizedKimiModelId(model))
}

export function canonicalKimiTaskWraithModelId(
  model?: string | null
):
  | typeof KIMI_K28_MODEL_ID
  | typeof KIMI_K27_HIGHSPEED_MODEL_ID
  | typeof KIMI_K3_MODEL_ID
  | typeof KIMI_K3_256K_MODEL_ID
  | null {
  const normalized = normalizedKimiModelId(model)
  const k3 = canonicalKimiK3ModelId(normalized)
  if (k3) return k3
  if (KIMI_K27_HIGHSPEED_ROUTE_IDS.has(normalized)) return KIMI_K27_HIGHSPEED_MODEL_ID
  if (KIMI_K28_ROUTE_IDS.has(normalized)) return KIMI_K28_MODEL_ID
  return null
}

/**
 * True when the model exposes Kimi's Low/High/Max effort axis.
 *
 * This is the gate the run, delegation, and composer lanes read — NOT
 * `isKimiK3Model`. K2.8 Preview took the same axis when it replaced K2.7 on the
 * standard route, so keying the control on "is K3" would show the picker stop
 * and then dispatch a fixed `thinking: on` underneath it. K2.7 Code Highspeed is
 * the one managed route with no axis at all.
 */
export function kimiModelSupportsReasoningEfforts(model?: string | null): boolean {
  const canonical = canonicalKimiTaskWraithModelId(model)
  return canonical !== null && canonical !== KIMI_K27_HIGHSPEED_MODEL_ID
}

/**
 * Resolve a TaskWraith Kimi model selection to the alias accepted by Kimi
 * Code's `--model` and ACP model config. A null result means the caller may
 * omit `--model` and let the K2.8 Preview standard default stand.
 */
export function kimiCliModelAlias(model: string, serviceTier?: string | null): string | null {
  const trimmed = model.trim()
  const normalized = trimmed.toLowerCase()
  const canonical = canonicalKimiTaskWraithModelId(normalized)

  // Each managed route is an independent model id now, so resolve the explicit
  // selection before the legacy Fast field. A stale `serviceTier` must never be
  // able to move a chat off the row its picker is showing.
  if (canonical === KIMI_K3_MODEL_ID) return KIMI_K3_CLI_MODEL
  if (canonical === KIMI_K3_256K_MODEL_ID) return KIMI_K3_256K_CLI_MODEL
  if (canonical === KIMI_K27_HIGHSPEED_MODEL_ID) return KIMI_HIGHSPEED_CLI_MODEL
  if (canonical === KIMI_K28_MODEL_ID) return KIMI_STANDARD_CLI_MODEL

  if (serviceTier === 'fast') return KIMI_HIGHSPEED_CLI_MODEL
  if (serviceTier === 'standard') return KIMI_STANDARD_CLI_MODEL
  if (!normalized || normalized === 'default') return null
  return trimmed
}

export function kimiExplicitCliModelAlias(model: string, serviceTier?: string | null): string {
  return kimiCliModelAlias(model, serviceTier) || KIMI_STANDARD_CLI_MODEL
}
