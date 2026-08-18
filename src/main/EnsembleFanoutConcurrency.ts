/**
 * EnsembleFanoutConcurrency — how many fan-out CALLS may be in flight at once.
 *
 * A Boss/Captain can dispatch a fan-out, and then, while those lanes are still
 * running, dispatch another, and another. Nothing in the dispatch path said no,
 * so rounds accumulated waves faster than they retired them: every extra wave
 * is another full set of provider turns billed against the same question, and
 * the transcript becomes a pile of half-read lane cards nobody joins.
 *
 * The cap is on WAVES, not on participants. A twenty-seat review fan-out is
 * one wave and stays entirely legal; so are second and third waves beside it.
 * The fourth concurrent call is refused and told to `ensemble_await`
 * until at least one of the open waves settles. That distinction is the whole
 * design — a refusal a Boss misreads as "too many seats" gets answered by
 * shrinking the roster, which costs breadth and fixes nothing.
 *
 * Settlement is read from the lanes themselves rather than from a counter that
 * dispatch increments and completion decrements: a counter has to be right on
 * every cancel, failure, timeout and restart path, and a wrong one either wedges
 * the round shut or stops capping. Lanes already carry durable terminal status
 * (`EnsembleLanes.TERMINAL_LANE_STATUSES`), so "still open" is derived, and a
 * crashed or cancelled wave stops counting the moment its lanes go terminal.
 */
import type { ConcurrentLaneStatus } from './store/types'
import { isTerminalLaneStatus } from './EnsembleLanes'

/**
 * Concurrent fan-out dispatch waves allowed per round.
 *
 * Three, so a bounded recon/work/review split can run together while an
 * unbounded pile-up cannot form. Raising this re-opens the accumulation it
 * exists to stop; it is not a throughput knob.
 */
export const MAX_CONCURRENT_FANOUT_WAVES = 3

/**
 * Bucket for open lanes that carry no wave id.
 *
 * Every current dispatch path stamps one (`appendRoundStatus` returns the
 * receipt id and `seedParticipantRun` carries it), so this covers rounds
 * persisted before wave ids existed. They pool into ONE wave deliberately:
 * giving each unattributed lane its own bucket would read a single legacy
 * twenty-lane wave as twenty waves and refuse every dispatch from then on.
 * Under-counting a historical round is recoverable; permanently wedging a live
 * one is not.
 */
export const UNATTRIBUTED_FANOUT_WAVE_ID = '__unattributed_fanout_wave__'

/** One lane, as much of it as the cap needs to see. */
export interface FanoutWaveLane {
  laneId: string
  status: ConcurrentLaneStatus
  /** Dispatch receipt that launched this lane (`run.fanoutWaveId`). */
  waveId?: string
  /** Human dispatch label ("Reader fan-out"), for the refusal message. */
  label?: string
}

/** A dispatch wave with at least one lane still in flight. */
export interface OpenFanoutWave {
  waveId: string
  label?: string
  openLaneIds: string[]
}

export type FanoutConcurrencyTool = 'ensemble_fanout' | 'ensemble_fanout_all'

/**
 * What the local Ollama admission gate can say about itself at refusal time.
 *
 * Passed by the orchestrator so the refusal can explain WHY waves are staying
 * open on a capacity-bound host. All three fields are point-in-time reads of
 * `OllamaLocalAdmissionPolicy`; `ceiling` undefined means the host declared no
 * limit and the gate is unbounded.
 */
export interface LocalCapacityPressure {
  /** Dispatches queued behind the local admission gate right now. */
  queuedDispatches: number
  /** Distinct local models currently admitted. */
  inFlightModels: number
  /** The host's declared/observed model ceiling; undefined means unbounded. */
  ceiling: number | undefined
}

export interface FanoutConcurrencyRefusal {
  error: 'too_many_concurrent_fanouts'
  message: string
}

/**
 * The dispatch waves that still have work in flight, in first-seen order.
 *
 * A wave is open while ANY of its lanes is non-terminal; a wave whose lanes
 * have all completed, failed or been cancelled is gone and frees its slot.
 */
export function openFanoutWaves(lanes: Iterable<FanoutWaveLane>): OpenFanoutWave[] {
  const byWaveId = new Map<string, OpenFanoutWave>()
  for (const lane of lanes) {
    if (isTerminalLaneStatus(lane.status)) continue
    const waveId = lane.waveId || UNATTRIBUTED_FANOUT_WAVE_ID
    const existing = byWaveId.get(waveId)
    if (existing) {
      existing.openLaneIds.push(lane.laneId)
      // First lane to carry a label names the wave; later lanes of the same
      // wave agree, and an unlabelled one must not blank it.
      if (!existing.label && lane.label) existing.label = lane.label
      continue
    }
    byWaveId.set(waveId, {
      waveId,
      label: lane.label,
      openLaneIds: [lane.laneId]
    })
  }
  return [...byWaveId.values()]
}

/**
 * One sentence of context when the refusal is really local-capacity backpressure.
 *
 * Fires on either signal: dispatches literally queued behind the gate, or the
 * host sitting at its model ceiling (at the ceiling, any further local lane
 * will queue, so open waves holding local lanes drain in turns — true even
 * while nothing happens to be queued at this instant). Queue evidence is
 * trusted on its own because the two reads are not atomic: a slot can free
 * between reading `inFlightModels` and reading `queuedDispatches`, and
 * something queued IS pressure whatever the slot count says.
 *
 * With headroom — or on a host that never declared a ceiling — this returns
 * the empty string and the refusal is byte-identical to the pre-gate message.
 * The empty string is the invariant, not an optimisation: an unbounded host
 * must not even be told a gate exists.
 */
function localCapacityNote(pressure?: LocalCapacityPressure): string {
  if (!pressure) return ''
  const queued = Math.max(0, pressure.queuedDispatches)
  const saturated = pressure.ceiling !== undefined && pressure.inFlightModels >= pressure.ceiling
  if (queued <= 0 && !saturated) return ''
  const slots =
    pressure.ceiling !== undefined
      ? `${pressure.inFlightModels} of ${pressure.ceiling} model slot${pressure.ceiling === 1 ? '' : 's'} in use`
      : `${pressure.inFlightModels} local model${pressure.inFlightModels === 1 ? '' : 's'} in use`
  const queueClause =
    queued > 0 ? `; ${queued} dispatch${queued === 1 ? '' : 'es'} queued behind them` : ''
  return (
    ` Note: the local Ollama host is at its model ceiling (${slots}${queueClause}), so ` +
    `local-model lanes beyond it are waiting on local capacity and open waves holding local ` +
    `lanes drain in turns rather than in parallel. That is backpressure from the host, not a ` +
    `stalled round — dropping or swapping local seats frees nothing. Await as above; slots ` +
    `free as lanes settle.`
  )
}

/**
 * `null` when the caller may dispatch, otherwise the refusal to return verbatim.
 *
 * The message names the waves it is waiting on, points at `ensemble_await`, and
 * says in as many words that this is not a limit on lanes — a Boss that reads
 * it as a seat cap will trim its roster instead of joining, which is the one
 * response that makes the round worse. When the local admission gate reports
 * pressure, one more sentence says the waves are waiting on local capacity —
 * without it, a wave held open by model queueing reads as a stalled round, and
 * the observed answer to THAT is also shrinking the roster.
 */
export function refuseForConcurrentFanouts(
  open: readonly OpenFanoutWave[],
  tool: FanoutConcurrencyTool,
  localCapacity?: LocalCapacityPressure
): FanoutConcurrencyRefusal | null {
  if (open.length < MAX_CONCURRENT_FANOUT_WAVES) return null

  const described = open
    .map((wave) => {
      const name = wave.label?.trim() || 'fan-out'
      const count = wave.openLaneIds.length
      return `${name} (${count} lane${count === 1 ? '' : 's'} still running)`
    })
    .join(', ')

  return {
    error: 'too_many_concurrent_fanouts',
    message:
      `${tool}: ${open.length} fan-out${open.length === 1 ? ' is' : 's are'} already running — ` +
      `${described}. At most ${MAX_CONCURRENT_FANOUT_WAVES} fan-outs may run at once, so this ` +
      `dispatch was not sent. Call ensemble_await (omit laneIds to await every lane in the ` +
      `round) until at least one of them settles, read it with ensemble_lane_result, then ` +
      `dispatch again. This is a limit on concurrent fan-out CALLS, not on participants — a ` +
      `single fan-out may still carry as many lanes as the roster allows, so do not drop seats ` +
      `to get past this.` +
      localCapacityNote(localCapacity)
  }
}
