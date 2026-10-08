/**
 * Which credential a Claude seat RUNS with — the user's explicit choice
 * between the Claude Code subscription login (the active account in Settings
 * → Providers → Claude → Accounts) and a stored Anthropic API key.
 *
 * Before this setting existed a stored key silently won: saving a key for
 * usage or for one experiment moved every Claude run onto pay-as-you-go
 * billing with no visible switch. The setting makes that choice explicit
 * and keeps a stored key inert while the subscription is selected. Shared so
 * the renderer summary and main's launch path resolve the same lane.
 */
export const CLAUDE_AUTH_MODES = ['subscription', 'api-key'] as const

export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number]

export function isClaudeAuthMode(value: unknown): value is ClaudeAuthMode {
  return value === 'subscription' || value === 'api-key'
}

export interface ClaudeRunLaneInput {
  /** The persisted choice; absent on installs that predate the setting. */
  claudeAuthMode?: ClaudeAuthMode | null
  /** Whether an Anthropic API key is stored. */
  apiKeyConfigured: boolean
}

/**
 * The lane a new Claude seat launches on.
 *
 * - `subscription` chosen → subscription, even with a key stored.
 * - `api-key` chosen → the key when one is stored; otherwise the subscription
 *   (a mode pointing at a missing key never strands the seat).
 * - no choice recorded → the pre-setting behaviour: a stored key wins, so an
 *   upgrade changes nothing until the user picks.
 */
export function resolveClaudeRunLane(input: ClaudeRunLaneInput): ClaudeAuthMode {
  if (input.claudeAuthMode === 'subscription') return 'subscription'
  return input.apiKeyConfigured ? 'api-key' : 'subscription'
}
