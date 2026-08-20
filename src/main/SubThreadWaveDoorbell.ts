/*
 * SubThreadWaveDoorbell — the one-slot fleet notice on the Ensemble Blackboard.
 *
 * Peers can already READ every wave in the chat (delegate_wave binds
 * parentChatId to the shared appChatId, so `list_subthreads` is panel-wide).
 * What they lacked was a reason to look: the in-prompt sub-thread return block
 * is consumed by whichever seat composes next, so every other seat never learns
 * a wave finished. This module builds the notice that closes that gap.
 *
 * A DOORBELL, NOT A MAILBOX. Exactly one Blackboard entry, ever:
 *
 *  - ONE fixed key, host-owned (`participantId: 'system'`). Blackboard upsert
 *    replaces on `(participantId, key, scope)`, so re-announcing rewrites the
 *    same slot instead of appending. Wave count never moves the footprint.
 *  - It carries POINTERS, never payloads — waveId + counts + holder. Readers
 *    pull the actual results with `read_subthread_result`, which already works
 *    for them. Prompt cost stays flat for a 2-worker wave and a 64-worker one.
 *  - It carries a TTL, so an idle chat drifts back to a zero-slot footprint
 *    rather than parking a durable entry forever.
 *
 * Why any of that matters: session/chat-scoped entries are NEVER in the
 * Blackboard's eviction queue (only round-scoped ones are), and once the 60
 * slots fill, `upsertBlackboardEntry` returns `blackboard_capacity_exhausted`
 * — for every participant and the human, not just for fleet. A per-wave entry
 * would not crowd the board, it would brick it.
 *
 * Pure: no AppStore, no IPC, no clock of its own.
 */

/** The single slot. Never derive this per wave — that is the whole design. */
export const FLEET_DOORBELL_KEY = 'fleet/settled-waves'
/** Self-delete so an idle chat costs zero slots. */
export const FLEET_DOORBELL_TTL_MINUTES = 12 * 60
/** Waves named individually before the rest collapse into a "+N more" tail. */
export const FLEET_DOORBELL_MAX_NAMED_WAVES = 6
/** Hard ceiling, well inside BLACKBOARD_MAX_VALUE_LEN (1000). */
export const FLEET_DOORBELL_MAX_VALUE_LEN = 700

export interface FleetDoorbellWave {
  waveId: string
  total: number
  settled: number
  /** Live claim holder, when the wave is claimed. */
  claimedBy?: string
  /** True when the holder is the host auto-claim rather than a deliberate pick-up. */
  claimAuto?: boolean
}

/**
 * A wave is worth ringing about once every worker can no longer return: that
 * is the moment its results are complete enough for a peer to adopt.
 */
export function isDoorbellReadyWave(wave: FleetDoorbellWave): boolean {
  return wave.total > 0 && wave.settled >= wave.total
}

function describeWave(wave: FleetDoorbellWave): string {
  const size = `${wave.total} agent${wave.total === 1 ? '' : 's'}`
  if (!wave.claimedBy) return `${wave.waveId} (${size}) — unclaimed`
  // An auto-claim means "the spawner still holds it by default", which is a
  // weaker signal than a seat deliberately picking the wave up. Naming the
  // difference is what stops a peer either duplicating work or wrongly
  // assuming nobody is on it.
  const how = wave.claimAuto ? 'held by spawner' : 'claimed by'
  return `${wave.waveId} (${size}) — ${how} ${wave.claimedBy}`
}

/**
 * Build the doorbell value, or null when there is nothing to announce.
 *
 * `null` is a real instruction to the caller: REMOVE the entry. Leaving a
 * stale notice up is worse than none — a peer would read settled waves that
 * have all since been claimed and go looking for work that is gone.
 */
export function buildFleetDoorbellValue(waves: readonly FleetDoorbellWave[]): string | null {
  const ready = waves.filter(isDoorbellReadyWave)
  if (ready.length === 0) return null

  const unclaimed = ready.filter((wave) => !wave.claimedBy)
  const named = ready.slice(0, FLEET_DOORBELL_MAX_NAMED_WAVES)
  const omitted = ready.length - named.length

  const headline =
    unclaimed.length > 0
      ? `${ready.length} settled fleet wave${ready.length === 1 ? '' : 's'}, ${unclaimed.length} unclaimed.`
      : `${ready.length} settled fleet wave${ready.length === 1 ? '' : 's'}, all claimed.`

  const lines = [
    headline,
    ...named.map((wave) => `- ${describeWave(wave)}`),
    ...(omitted > 0 ? [`- +${omitted} more settled wave${omitted === 1 ? '' : 's'}.`] : []),
    'Read results with read_subthread_result; take one with claim_fleet_wave({waveId}).'
  ]
  const value = lines.join('\n')
  return value.length <= FLEET_DOORBELL_MAX_VALUE_LEN
    ? value
    : `${value.slice(0, FLEET_DOORBELL_MAX_VALUE_LEN - 1)}…`
}

/**
 * Should the notice be rewritten?
 *
 * Load-bearing noise control. Every upsert mints a FRESH entry id, and the
 * Blackboard tracks "seen" per entry id — so re-stamping an unchanged notice
 * re-notifies every seat on the panel. Without this guard a 64-worker wave
 * would ring the doorbell 64 times, once per worker return, with identical
 * text. Rewrite only when a reader would actually see something new.
 */
export function shouldRefreshDoorbell(
  existingValue: string | undefined,
  nextValue: string | null
): boolean {
  const current = (existingValue || '').trim()
  if (nextValue === null) return current.length > 0
  return current !== nextValue.trim()
}
