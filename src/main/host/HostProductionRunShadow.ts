/**
 * Host Arc Track3 Mixed Wave A — active-run shadow → Host family.
 *
 * WHAT THIS IS. Live provider runs (RunManager / equivalent) are keyed by
 * runId and bound to a thread (threadId or appChatId). Host run cards on the
 * wire reuse those ids so clients can join. This adapter owns the allowlisted
 * mapping into HostRunProjection without importing electron, AppStore, or
 * RunManager itself.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / RunManager value imports;
 * - constructs allowlisted HostRunProjection fields only;
 * - never invents threadId (required on the wire — rows without one are
 *   skipped, not fabricated);
 * - never fabricates usage (omitted on this shadow path even if a source
 *   row carries foreign usage-shaped fields).
 *
 * HONESTY:
 * - only rows supplied by listActive are projected;
 * - status mapping: starting→running; known terminals pass through;
 *   requires_action only when evidenced; unmapped → unknown;
 * - a throwing listActive propagates (fail closed, never a false empty);
 * - every listRuns call re-reads (no cache of a moving set).
 *
 * Wave B note: HostProductionSuppliers should import / re-export
 * {@link HostProductionRunListPort} (or move the interface there) and wire
 * createHostProductionRunShadow into the optional `runs` supplier port.
 */

import type { HostProviderTerminalOutcome, HostRunProjection } from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_RUN_ID_MAX = 512

const KNOWN_PROVIDER_OUTCOMES = new Set<HostProviderTerminalOutcome>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'requires_action',
  'unknown'
])

/**
 * Port shape for createHostProductionBootstrap / createHostProductionSuppliers.
 * Defined here in Wave A so Wave B can re-export or move without editing this
 * module's call surface.
 */
export interface HostProductionRunListPort {
  listRuns(): HostRunProjection[]
}

/**
 * Thin active-run shape the composition root adapts from RunManager
 * (or any equivalent). Deliberately narrow so this module never pulls
 * run-manager/store symbols.
 */
export interface HostActiveRunShadowEntry {
  readonly runId: string
  /** Preferred thread key on the wire. */
  readonly threadId?: string
  /** RunManager field name — used when threadId is absent. */
  readonly appChatId?: string
  readonly providerId: string
  /**
   * Explicit wire outcome when the source already speaks Host vocabulary.
   * Takes precedence over {@link status} when it is a known outcome.
   */
  readonly providerOutcome?: string
  /**
   * Source lifecycle status (e.g. RunSessionStatus). Mapped carefully:
   * starting→running; unmapped→unknown; requires_action only when present.
   */
  readonly status?: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly modelId?: string
}

export interface HostProductionRunShadowDeps {
  listActive: () => readonly HostActiveRunShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function resolveThreadId(entry: HostActiveRunShadowEntry): string | null {
  if (isUsableId(entry.threadId) && entry.threadId.length <= HOST_RUN_ID_MAX) {
    return entry.threadId
  }
  if (isUsableId(entry.appChatId) && entry.appChatId.length <= HOST_RUN_ID_MAX) {
    return entry.appChatId
  }
  return null
}

function mapProviderOutcome(entry: HostActiveRunShadowEntry): HostProviderTerminalOutcome {
  if (
    typeof entry.providerOutcome === 'string' &&
    KNOWN_PROVIDER_OUTCOMES.has(entry.providerOutcome as HostProviderTerminalOutcome)
  ) {
    return entry.providerOutcome as HostProviderTerminalOutcome
  }

  switch (entry.status) {
    case 'starting':
      return 'running'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'requires_action':
      // Only when the source explicitly evidences this status — never invent.
      return 'requires_action'
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/**
 * Map active-run entries into allowlisted HostRunProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionRunShadow}.
 */
export function mapActiveRunShadowsToHostRuns(
  entries: readonly HostActiveRunShadowEntry[]
): HostRunProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostRunProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.runId) || entry.runId.length > HOST_RUN_ID_MAX) continue
    if (!isUsableId(entry.providerId) || entry.providerId.length > HOST_RUN_ID_MAX) continue

    // threadId is REQUIRED on HostRunProjection — skip rather than invent.
    const threadId = resolveThreadId(entry)
    if (threadId === null) continue

    // ALLOWLIST REBUILD: only these fields reach the wire.
    // usage is intentionally omitted — never fabricate it on this path.
    const row: HostRunProjection = {
      runId: entry.runId,
      threadId,
      providerId: entry.providerId,
      providerOutcome: mapProviderOutcome(entry)
    }

    const startedAt = optionalNonNegativeInt(entry.startedAt)
    if (startedAt !== undefined) row.startedAt = startedAt

    const endedAt = optionalNonNegativeInt(entry.endedAt)
    if (endedAt !== undefined) row.endedAt = endedAt

    if (isUsableId(entry.modelId) && entry.modelId.length <= HOST_RUN_ID_MAX) {
      row.modelId = entry.modelId
    }

    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `runs` port for createHostProductionBootstrap /
 * createHostProductionSuppliers (Wave B wire).
 */
export function createHostProductionRunShadow(
  deps: HostProductionRunShadowDeps
): HostProductionRunListPort {
  if (!deps || typeof deps.listActive !== 'function') {
    throw new Error('HostProductionRunShadow requires listActive to be a function')
  }
  return {
    listRuns(): HostRunProjection[] {
      // Live read every call — no caching of a moving active set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapActiveRunShadowsToHostRuns(deps.listActive())
    }
  }
}
