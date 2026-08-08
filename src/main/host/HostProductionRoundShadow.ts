/**
 * Host Arc Track3 Mixed Wave A — ensemble round shadow → Host family.
 *
 * WHAT THIS IS. Ensemble rounds live in chat/orchestrator state keyed by
 * roundId + threadId. Host round cards on the wire use the same ids so
 * clients can join. This adapter owns the allowlisted mapping into
 * HostRoundProjection without importing electron, AppStore, or the
 * orchestrator itself.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / EnsembleOrchestrator value imports;
 * - hostProtocol types only;
 * - constructs allowlisted HostRoundProjection fields only;
 * - never forwards prompt, queue text, blackboard, or transcript onto
 *   the wire — even when present on a loose source object.
 *
 * HONESTY:
 * - stale running: status === 'running' && live === false projects as
 *   'completed' (isEnsembleRoundDispatchLive concept; composition root
 *   supplies `live`, this module applies the wire rule);
 * - never invents roundId / threadId (required — rows without them skip);
 * - a throwing listRounds propagates (fail closed, never a false empty);
 * - every listRounds call re-reads (no cache of a moving set).
 */

import type {
  HostRoundOutcome,
  HostRoundProjection,
  HostRoutingProjection,
  HostWaveProjection
} from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_ROUND_ID_MAX = 512

const HOST_ROUND_OUTCOMES = new Set<HostRoundOutcome>([
  'running',
  'completed',
  'cancelled',
  'failed',
  'unknown'
])

/**
 * Thin ensemble-round shape the composition root adapts from chat
 * ensemble activeRound (or any equivalent). Deliberately narrow so this
 * module never pulls store/orchestrator symbols.
 *
 * `live` carries the isEnsembleRoundDispatchLive concept — computed by
 * the caller that can see lanes/participants — so this shadow stays free
 * of store types while still applying the stale-running rule.
 */
export interface HostEnsembleRoundShadowEntry {
  readonly roundId: string
  readonly threadId: string
  /** Source status before stale-running honesty is applied. */
  readonly status: string
  /**
   * True when dispatch is still live (isEnsembleRoundDispatchLive).
   * When status is 'running' and live is false, wire status is 'completed'.
   */
  readonly live: boolean
  readonly participantIds: readonly string[]
  readonly providerRunIds: readonly string[]
  readonly startedAt?: number
  readonly endedAt?: number
  readonly routing?: HostRoutingProjection
  readonly waves?: readonly HostWaveProjection[]
}

export interface HostProductionRoundShadowDeps {
  listRounds: () => readonly HostEnsembleRoundShadowEntry[]
}

/**
 * Optional `rounds` port for createHostProductionBootstrap /
 * createHostProductionSuppliers (Wave B wiring). Defined here so Wave A
 * can ship the shadow without mutating Suppliers.
 */
export interface HostProductionRoundListPort {
  listRounds(): HostRoundProjection[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function filterUsableIds(values: readonly unknown[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (!isUsableId(value) || value.length > HOST_ROUND_ID_MAX) continue
    out.push(value)
  }
  return out
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/**
 * Project source status onto HostRoundOutcome with stale-running honesty.
 *
 * Mirrors RemoteTaskProjection.projectEnsembleRoundStatus: a persisted
 * `running` round whose dispatch is no longer live must not paint as
 * live on the wire.
 */
export function projectHostRoundStatus(status: string, live: boolean): HostRoundOutcome {
  if (status === 'running') {
    return live === true ? 'running' : 'completed'
  }
  if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    return status
  }
  if (HOST_ROUND_OUTCOMES.has(status as HostRoundOutcome)) {
    return status as HostRoundOutcome
  }
  return 'unknown'
}

function mapRouting(raw: HostRoutingProjection | undefined): HostRoutingProjection | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  if (typeof raw.mode !== 'string' || raw.mode.length === 0) return undefined
  if (typeof raw.fanout !== 'string' || raw.fanout.length === 0) return undefined

  const routing: HostRoutingProjection = {
    mode: raw.mode,
    fanout: raw.fanout
  }
  if (isUsableId(raw.activeParticipantId) && raw.activeParticipantId.length <= HOST_ROUND_ID_MAX) {
    routing.activeParticipantId = raw.activeParticipantId
  }
  if (isNonNegativeInt(raw.continuationHops)) {
    routing.continuationHops = raw.continuationHops
  }
  if (isNonNegativeInt(raw.maxContinuationHops)) {
    routing.maxContinuationHops = raw.maxContinuationHops
  }
  if (isUsableId(raw.bossParticipantId) && raw.bossParticipantId.length <= HOST_ROUND_ID_MAX) {
    routing.bossParticipantId = raw.bossParticipantId
  }
  if (
    isUsableId(raw.captainParticipantId) &&
    raw.captainParticipantId.length <= HOST_ROUND_ID_MAX
  ) {
    routing.captainParticipantId = raw.captainParticipantId
  }
  return routing
}

function mapWave(raw: HostWaveProjection): HostWaveProjection | null {
  if (!raw || typeof raw !== 'object') return null
  if (!isUsableId(raw.waveId) || raw.waveId.length > HOST_ROUND_ID_MAX) return null
  if (typeof raw.status !== 'string' || raw.status.length === 0) return null
  if (!Array.isArray(raw.participantIds)) return null

  const wave: HostWaveProjection = {
    waveId: raw.waveId,
    status: raw.status,
    participantIds: filterUsableIds(raw.participantIds)
  }
  if (typeof raw.label === 'string' && raw.label.length > 0) {
    wave.label = raw.label
  }
  return wave
}

function mapWaves(
  raw: readonly HostWaveProjection[] | undefined
): HostWaveProjection[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const waves: HostWaveProjection[] = []
  for (const entry of raw) {
    const mapped = mapWave(entry)
    if (mapped) waves.push(mapped)
  }
  return waves
}

/**
 * Map narrow ensemble round entries into allowlisted HostRoundProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionRoundShadow}.
 */
export function mapEnsembleRoundShadowsToHostRounds(
  entries: readonly HostEnsembleRoundShadowEntry[]
): HostRoundProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostRoundProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.roundId) || entry.roundId.length > HOST_ROUND_ID_MAX) continue
    if (!isUsableId(entry.threadId) || entry.threadId.length > HOST_ROUND_ID_MAX) continue
    if (!Array.isArray(entry.participantIds) || !Array.isArray(entry.providerRunIds)) continue

    // ALLOWLIST REBUILD: only these fields reach the wire.
    // Never copy prompt / queue / blackboard / transcript from the source.
    const row: HostRoundProjection = {
      roundId: entry.roundId,
      threadId: entry.threadId,
      status: projectHostRoundStatus(
        typeof entry.status === 'string' ? entry.status : 'unknown',
        entry.live === true
      ),
      participantIds: filterUsableIds(entry.participantIds),
      providerRunIds: filterUsableIds(entry.providerRunIds)
    }

    if (isNonNegativeInt(entry.startedAt)) row.startedAt = entry.startedAt
    if (isNonNegativeInt(entry.endedAt)) row.endedAt = entry.endedAt

    const routing = mapRouting(entry.routing)
    if (routing) row.routing = routing

    const waves = mapWaves(entry.waves)
    if (waves) row.waves = waves

    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `rounds` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionRoundShadow(
  deps: HostProductionRoundShadowDeps
): HostProductionRoundListPort {
  if (!deps || typeof deps.listRounds !== 'function') {
    throw new Error('HostProductionRoundShadow requires listRounds to be a function')
  }
  return {
    listRounds(): HostRoundProjection[] {
      // Live read every call — no caching of a moving round set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapEnsembleRoundShadowsToHostRounds(deps.listRounds())
    }
  }
}
