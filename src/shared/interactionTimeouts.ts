/**
 * Canonical host-owned interaction timeouts.
 *
 * Keep provider defaults, question lifetimes, configurable bounds, and the
 * transport budgets that sit underneath them in one node-builtin-free module
 * so Electron main and the renderer cannot drift independently.
 */

export const APPROVAL_TIMEOUT_DEFAULTS_VERSION = 2
export const APPROVAL_TIMEOUT_MIN_MS = 5_000
export const APPROVAL_TIMEOUT_MAX_MS = 60 * 60 * 1000
export const INTERACTION_TRANSPORT_GRACE_MS = 30_000

export const APPROVAL_TIMEOUT_PROVIDER_IDS = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse'
] as const

export const DEFAULT_APPROVAL_TIMEOUTS_MS = {
  gemini: 240_000,
  codex: 60_000,
  claude: 240_000,
  kimi: 120_000,
  grok: 240_000,
  cursor: 240_000,
  ollama: 240_000,
  antigravity: 240_000,
  pi: 240_000,
  mistral: 120_000,
  muse: 240_000
} as const

export const DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS = 120_000

export const DEFAULT_APPROVAL_KIND_TIMEOUTS_MS = {
  'hostCommand/rerun': 180_000,
  'workspace/session-trust': 360_000,
  // Kimi Code starts its fixed external MCP client deadline while streamed
  // tool arguments are still arriving. TaskWraith cannot extend that clock;
  // keeping this below it avoids an ambiguous provider-side timeout.
  'kimi-mcp/ensemble_roster_edit': 40_000
} as const

/** Idle Boss/Captain approval-review turn before the human modal wins alone. */
export const BOSS_APPROVAL_REVIEW_TIMEOUT_MS = 180_000

/** Universal TaskWraith and Codex-host question-card lifetime. */
export const AGENT_QUESTION_TIMEOUT_MS = 24 * 60 * 1000

/** Broker/hook backstop that honors every user-configurable approval value. */
export const APPROVAL_TRANSPORT_TIMEOUT_MS =
  APPROVAL_TIMEOUT_MAX_MS + INTERACTION_TRANSPORT_GRACE_MS

/** Broker backstop for a question card plus transport settlement grace. */
export const AGENT_QUESTION_TRANSPORT_TIMEOUT_MS =
  AGENT_QUESTION_TIMEOUT_MS + INTERACTION_TRANSPORT_GRACE_MS

const LEGACY_APPROVAL_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  gemini: 120_000,
  codex: 30_000,
  claude: 120_000,
  kimi: 60_000,
  grok: 120_000,
  cursor: 120_000,
  ollama: 120_000,
  antigravity: 120_000,
  pi: 120_000,
  mistral: 60_000,
  muse: 120_000
}

export interface ApprovalTimeoutDefaultsMigration {
  value: Record<string, unknown> | undefined
  changed: boolean
}

/**
 * Upgrade persisted values that are still byte-for-byte equal to the prior
 * defaults. Non-default user choices survive untouched, and the version stamp
 * makes the migration idempotent.
 */
export function migrateApprovalTimeoutDefaults(
  input: Record<string, unknown> | undefined
): ApprovalTimeoutDefaultsMigration {
  if (!input) return { value: input, changed: false }
  if (Number(input.defaultsVersion) >= APPROVAL_TIMEOUT_DEFAULTS_VERSION) {
    return { value: input, changed: false }
  }

  const next: Record<string, unknown> = {
    ...input,
    defaultsVersion: APPROVAL_TIMEOUT_DEFAULTS_VERSION
  }
  if (isRecord(input.perProviderMs)) {
    const perProviderMs: Record<string, unknown> = { ...input.perProviderMs }
    for (const provider of APPROVAL_TIMEOUT_PROVIDER_IDS) {
      if (perProviderMs[provider] === LEGACY_APPROVAL_TIMEOUTS_MS[provider]) {
        perProviderMs[provider] = DEFAULT_APPROVAL_TIMEOUTS_MS[provider]
      }
    }
    next.perProviderMs = perProviderMs
  }
  if (input.mainAuthorityMs === 60_000) {
    next.mainAuthorityMs = DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
  }
  return { value: next, changed: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
