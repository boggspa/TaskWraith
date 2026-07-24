import type { AntigravityGeminiApiDiscoveryStatus } from './AntigravityGeminiApiModelDiscovery'

/**
 * Discovery already classifies every failure precisely, but the combined
 * catalogue also owns a case discovery itself cannot report: the lane never
 * answered inside its own timeout. That is a distinct, user-visible reason for
 * seeing the static fallback list, so it gets its own status here.
 */
export type AntigravityGeminiApiDiscoveryOutcomeStatus =
  | AntigravityGeminiApiDiscoveryStatus
  | 'timedOut'

export const ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'cancelled',
  'disclosureRequired',
  'keyUnavailable',
  'sdkUnavailable',
  'unauthorized',
  'rateLimited',
  'projectLimited',
  'unavailable',
  'invalidResponse',
  'empty',
  'timedOut'
])

/** Bounds the recorded count independently of the discovery module's own cap. */
export const MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT = 1_024

/**
 * The only discovery shape suitable for renderer/iOS projection. Like
 * `AntigravityGeminiApiSecretStatus`, it is a deliberate three-field whitelist:
 * a closed status enum, a bounded count, and a timestamp. It never carries the
 * API key, a raw provider error string, a URL, a project id, or a model id —
 * a rejected key must be reportable without echoing anything Google said.
 */
export interface AntigravityGeminiApiDiscoveryOutcome {
  readonly status: AntigravityGeminiApiDiscoveryOutcomeStatus
  readonly modelCount: number
  readonly checkedAt: string
}

export interface AntigravityGeminiApiDiscoveryOutcomeStoreOptions {
  readonly now?: () => Date
}

/**
 * Remembers only the last authenticated Gemini API discovery result, so the
 * settings card can say why it is showing the static fallback list instead of
 * live models.
 *
 * Deliberately in-memory and single-slot: this is a live diagnostic, not a
 * record. Persisting it would create a second on-disk artifact next to the
 * secret envelope for no benefit, and a stale outcome surviving a restart would
 * be less honest than showing nothing until the first probe of this run lands.
 */
export class AntigravityGeminiApiDiscoveryOutcomeStore {
  private lastOutcome: AntigravityGeminiApiDiscoveryOutcome | null = null
  private readonly now: () => Date

  constructor(options: AntigravityGeminiApiDiscoveryOutcomeStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  record(status: AntigravityGeminiApiDiscoveryOutcomeStatus, modelCount = 0): void {
    if (!ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_STATUSES.has(status)) return
    this.lastOutcome = {
      status,
      // Only a successful pass can honestly claim live models. Every other
      // status means the catalogue is unverified, whatever count came with it.
      modelCount: status === 'ok' ? boundedModelCount(modelCount) : 0,
      checkedAt: this.now().toISOString()
    }
  }

  getLastOutcome(): AntigravityGeminiApiDiscoveryOutcome | null {
    return this.lastOutcome
  }

  /** Drops a prior lane's outcome when the key itself changes. */
  clear(): void {
    this.lastOutcome = null
  }
}

function boundedModelCount(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT)
}
