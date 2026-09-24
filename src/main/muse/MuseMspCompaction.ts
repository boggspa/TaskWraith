/**
 * Muse MSP compaction planes — occupancy pressure vs the compaction item.
 *
 * Muse 1.0.3 keeps these on two different protocol surfaces and they must not
 * be conflated:
 *
 * - `session/contextUsage.pressure` is `ContextPressureLevel` occupancy
 *   (`normal` | `warning` | `blocked`) against the host pressure basis.
 * - `ItemKind: "compaction"` is the SS4.5.10 lifecycle item (trigger, outcome,
 *   tokensBefore/tokensAfter). That is the plane that maps onto TaskWraith's
 *   `ContextCompactionSignal`.
 *
 * No Electron imports — unit-testable and safe inside the Host Node closure.
 */

import type {
  ContextCompactionSignal,
  ContextCompactionTrigger
} from '../../shared/contextCompaction'
import { MUSE_MSP_CONTEXT_PRESSURE_LEVELS, type MuseMspItem } from './MuseMspProtocol'

function asTrigger(value: unknown): ContextCompactionTrigger | undefined {
  return value === 'auto' || value === 'manual' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * True when occupancy pressure should extend the inactivity watchdog's counted
 * compaction grace.
 *
 * The closed 1.0.3 vocabulary is occupancy, not "currently compacting", so
 * `normal` / `warning` / `blocked` never qualify. Open-enum evolution may add
 * compact* members; those still trip the grace via a family match.
 */
export function museMspContextPressureIndicatesCompactionQuiet(
  pressure: string | undefined | null
): boolean {
  if (!pressure) return false
  if ((MUSE_MSP_CONTEXT_PRESSURE_LEVELS as readonly string[]).includes(pressure)) {
    return false
  }
  return /compact/i.test(pressure)
}

/** Map a Muse `compaction` item onto TaskWraith's shared compaction signal. */
export function museMspCompactionItemToSignal(
  item: MuseMspItem,
  phase: 'started' | 'updated' | 'completed'
): ContextCompactionSignal | null {
  if (item.kind !== 'compaction') return null
  const trigger = asTrigger(item.trigger)
  const telemetry = {
    provider: 'muse',
    eventUuid: item.itemId,
    ...(trigger ? { trigger } : {})
  }
  if (phase === 'started' && item.status === 'inProgress') {
    return { kind: 'started', telemetry }
  }
  if (phase !== 'completed') return null

  const outcome = item.outcome
  if (outcome === 'failed' || item.status === 'failed') {
    const error = text(item.reason)
    return {
      kind: 'failed',
      telemetry: { ...telemetry, ...(error ? { error } : {}) }
    }
  }
  if (outcome === 'cancelled' || item.status === 'cancelled') {
    return {
      kind: 'failed',
      telemetry: { ...telemetry, error: text(item.reason) || 'cancelled' }
    }
  }
  // `compacted` and `noop` are both success on this schema (SS3.7: a noop is
  // not an error). Unknown outcomes with a completed status follow that arm.
  const preTokens = finiteNumber(item.tokensBefore)
  const postTokens = finiteNumber(item.tokensAfter)
  return {
    kind: 'completed',
    telemetry: {
      ...telemetry,
      ...(preTokens !== undefined ? { preTokens } : {}),
      ...(postTokens !== undefined ? { postTokens } : {})
    }
  }
}
