import type { ChatUpdateDelivery } from '../shared/chatUpdateTransport'
import { estimateJsonishBytes } from '../shared/transcriptPage'

const MIB = 1024 * 1024

/** Ordinary patches keep the coordinator's configured ACK timeout unchanged. */
export const SNAPSHOT_ACK_MIN_TIMEOUT_MS = 15_000
export const SNAPSHOT_ACK_MAX_TIMEOUT_MS = 120_000
/** Conservative scheduling allowance, not a claimed IPC throughput benchmark. */
export const SNAPSHOT_ACK_BUDGET_BYTES_PER_SECOND = 4 * MIB

export const SNAPSHOT_RETRY_INITIAL_DELAY_MS = 5_000
export const SNAPSHOT_RETRY_MAX_DELAY_MS = 60_000

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Full-walk estimate used only when a delivery is already an exceptional
 * snapshot. Patch construction and ACKs stay on their existing O(changes) path.
 */
export function estimateChatUpdateSnapshotBytes(delivery: ChatUpdateDelivery): number {
  return delivery.kind === 'snapshot' ? estimateJsonishBytes(delivery) : 0
}

/**
 * A snapshot has to cross structured clone and be accepted by a potentially
 * busy renderer before its ACK can run. Give that work a byte-scaled deadline;
 * treating a five-second scheduling delay as corruption creates the very
 * snapshot loop that makes the renderer slower. Patches retain the configured
 * timeout byte-for-byte.
 */
export function resolveChatUpdateAckTimeoutMs(input: {
  kind: ChatUpdateDelivery['kind']
  configuredTimeoutMs: number
  snapshotBytes?: number
}): number {
  const configured = finiteNonNegative(input.configuredTimeoutMs)
  if (configured === 0 || input.kind !== 'snapshot') return configured

  const snapshotBytes = finiteNonNegative(input.snapshotBytes ?? 0)
  const transferBudgetMs = Math.ceil((snapshotBytes / SNAPSHOT_ACK_BUDGET_BYTES_PER_SECOND) * 1_000)
  const scaled = Math.min(
    SNAPSHOT_ACK_MAX_TIMEOUT_MS,
    SNAPSHOT_ACK_MIN_TIMEOUT_MS + transferBudgetMs
  )
  // An explicit larger coordinator timeout remains authoritative; this policy
  // may lengthen a snapshot deadline but never shortens caller configuration.
  return Math.max(configured, scaled)
}

/**
 * Exponential retry with a hard ceiling. The first retry also leaves at least
 * half of the failed snapshot's ACK window for structured-clone/GC recovery.
 */
export function resolveSnapshotRetryDelayMs(input: {
  consecutiveTimeouts: number
  ackTimeoutMs: number
}): number {
  const attempts = Math.max(1, Math.floor(finiteNonNegative(input.consecutiveTimeouts)))
  const exponent = Math.min(30, attempts - 1)
  const exponential = Math.min(
    SNAPSHOT_RETRY_MAX_DELAY_MS,
    SNAPSHOT_RETRY_INITIAL_DELAY_MS * 2 ** exponent
  )
  const recoveryFloor = Math.min(
    SNAPSHOT_RETRY_MAX_DELAY_MS,
    Math.ceil(finiteNonNegative(input.ackTimeoutMs) / 2)
  )
  return Math.max(exponential, recoveryFloor)
}
