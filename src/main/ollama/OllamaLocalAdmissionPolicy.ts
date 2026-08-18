/**
 * OllamaLocalAdmissionPolicy — the ensemble's side of the local admission gate.
 *
 * `OllamaCapacityProbe` says how much the host holds, `OllamaLocalAdmissionGate`
 * bounds distinct models in flight, and `OllamaLocalAdmissionCoordinator` adds
 * ownership and the queue clock. What none of them can answer is the pair of
 * questions the orchestrator actually asks at a dispatch site: *is this seat one
 * of the ones I am supposed to bound*, and *which key does it count under*. This
 * module answers exactly those, so `EnsembleOrchestrator` — a 22k-line monolith
 * — receives wiring lines and no policy.
 *
 * **The invariant that outranks everything here: unknown capacity is
 * unbounded.** A host that declares no ceiling, or that does not answer the
 * probe at all, must behave byte-for-byte as it did before this file existed. A
 * rack of H100s and a laptop run the same code path, and only the laptop's
 * operator ever told us a number. Nothing in this file invents a ceiling, and
 * nothing narrows one — measured residency may only ever widen a declaration.
 *
 * **Why a leaked slot is worse than the oversubscription it prevents.** This is
 * a counter that dispatch increments and completion decrements, the exact shape
 * `EnsembleFanoutConcurrency` refuses for the wave cap. If a slot is taken and
 * never handed back, the round does not merely run slowly — it wedges shut, for
 * good, with no user-visible cause. So all three of the coordinator's
 * mitigations are used together and none is optional:
 *
 * 1. slots are identity tokens, so a late release from a dead holder finds
 *    nothing rather than evicting whoever inherited the model;
 * 2. `releaseRun` calls `forget` on EVERY round exit, driven from `finalizeRun`
 *    — the one chokepoint every terminal path funnels through;
 * 3. `releaseRun` then reconciles against the caller's LIVE RUN REGISTRY, not
 *    against this module's own bookkeeping, so a run that died between
 *    admission and release costs one reconcile instead of a narrowed gate.
 *
 * The window (2) cannot close on its own is a grant that lands in the same tick
 * as its run's release; `admit` closes that one directly by handing the ticket
 * straight back when it observes its own run already aborted.
 */
import {
  EMPTY_OLLAMA_RESIDENCY_OBSERVATION,
  estimateOllamaCapacity,
  fetchOllamaLoadedModels,
  observeOllamaResidency,
  readDeclaredOllamaModelCeiling,
  type OllamaCapacityEstimate,
  type OllamaResidencyObservation
} from './OllamaCapacityProbe'
import { OllamaLocalAdmissionCoordinator } from './OllamaLocalAdmissionCoordinator'
import { isOllamaCloudModelId, ollamaModelIdAliases } from '../../shared/ollamaModelAvailability'
import { normalizeOllamaBaseUrl } from './OllamaProvider'

/**
 * The shape of a seat this module needs. Structural on purpose:
 * `EnsembleParticipant` and `ActiveParticipantRun['participant']` both satisfy
 * it without this file importing the orchestrator's type graph.
 */
export interface LocalAdmissionSeat {
  readonly provider: string
  readonly model?: string
}

/** Only local Ollama seats are bounded; every other provider is untouched. */
const OLLAMA_PROVIDER_ID = 'ollama'

/**
 * Key for a local seat whose model id we do not know.
 *
 * Such a seat runs whatever the host's default is, which means all of them run
 * the SAME model and belong in one slot. Grouping them is therefore both safe
 * and more accurate than skipping them. It costs nothing against the probe
 * either: residency is only ever counted, never matched against these keys.
 */
export const UNRESOLVED_LOCAL_OLLAMA_MODEL_KEY = '(ollama-host-default)'

/** Picker sentinels that name no model at all. */
const NON_MODEL_IDS = new Set(['cli-default', 'custom', 'default'])

const DEFAULT_CAPACITY_REFRESH_INTERVAL_MS = 30_000

function admissionAbortedError(): Error {
  const error = new Error('Local model admission was aborted before it was granted.')
  error.name = 'AbortError'
  return error
}

/**
 * The gate key for a seat, or `undefined` when the seat is not bounded here.
 *
 * Three exclusions, each for its own reason:
 *
 * - **Not Ollama.** Hosted providers do not share the local VRAM pool, and a
 *   fan-out of them is meant to run wide.
 * - **Ollama Cloud** (`:cloud` / `-cloud`). These are dispatched to Ollama's
 *   servers, so they load no local weights. Charging them a local slot would
 *   serialise work that costs the host nothing.
 * - Nothing else. An unknown model id is grouped, not skipped — see
 *   `UNRESOLVED_LOCAL_OLLAMA_MODEL_KEY`.
 *
 * Aliases are folded so that `gemma3` and `gemma3:latest` — the same weights,
 * loaded once — take one slot rather than two. `ollamaModelIdAliases` already
 * owns that equivalence for the rest of the app; sorting its output is just a
 * deterministic way to pick one representative from the set.
 */
export function localOllamaModelKey(seat?: LocalAdmissionSeat | null): string | undefined {
  if (!seat || seat.provider !== OLLAMA_PROVIDER_ID) return undefined
  const model = String(seat.model || '').trim()
  if (!model || NON_MODEL_IDS.has(model.toLowerCase())) {
    return UNRESOLVED_LOCAL_OLLAMA_MODEL_KEY
  }
  if (isOllamaCloudModelId(model)) return undefined
  const aliases = ollamaModelIdAliases(model)
  if (aliases.length === 0) return UNRESOLVED_LOCAL_OLLAMA_MODEL_KEY
  return [...aliases].sort()[0]
}

/** Distinct gate keys across a set of seats, for `reconcile`. */
export function localOllamaModelKeys(seats: Iterable<LocalAdmissionSeat>): string[] {
  const keys = new Set<string>()
  for (const seat of seats) {
    const key = localOllamaModelKey(seat)
    if (key) keys.add(key)
  }
  return [...keys]
}

export interface OllamaLocalAdmissionPolicyOptions {
  /**
   * The configured daemon address, read fresh so a settings change is picked
   * up mid-session. Normalised here through the provider's own helper, so an
   * empty or malformed setting probes the default host rather than silently
   * disabling the probe (and with it the gate).
   */
  readonly getBaseUrl: () => string | null | undefined
  /** Environment to read the declared ceiling from. Defaults to `process.env`. */
  readonly getEnv?: () => Record<string, string | undefined>
  readonly fetchImpl?: typeof fetch
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number
  readonly capacityRefreshIntervalMs?: number
}

export class OllamaLocalAdmissionPolicy {
  private readonly coordinator: OllamaLocalAdmissionCoordinator
  private readonly options: OllamaLocalAdmissionPolicyOptions
  private readonly now: () => number
  private readonly refreshIntervalMs: number
  /** One controller per run, so a finalizing run can leave the queue. */
  private readonly controllers = new Map<string, AbortController>()
  private observation: OllamaResidencyObservation = EMPTY_OLLAMA_RESIDENCY_OBSERVATION
  private estimate?: OllamaCapacityEstimate
  private refreshInFlight?: Promise<void>
  private probedAtLeastOnce = false
  private lastProbeAt = 0

  constructor(options: OllamaLocalAdmissionPolicyOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.refreshIntervalMs =
      options.capacityRefreshIntervalMs ?? DEFAULT_CAPACITY_REFRESH_INTERVAL_MS
    this.coordinator = new OllamaLocalAdmissionCoordinator({ now: this.now })
  }

  /** Distinct local models currently admitted. */
  get inFlight(): number {
    return this.coordinator.inFlight
  }

  /** Dispatches queued behind local capacity. */
  get waiting(): number {
    return this.coordinator.waiting
  }

  /** Latest capacity opinion, for logs and "waiting on local capacity" copy. */
  get capacityEstimate(): OllamaCapacityEstimate | undefined {
    return this.estimate
  }

  /**
   * Wait for room to run this seat, if it is a seat we bound at all.
   *
   * Resolves immediately — and without touching the coordinator — for every
   * non-local seat, so a fan-out of hosted providers is not even observed here.
   * Rejects with an `AbortError` when the run finalizes while still queued; the
   * caller treats that exactly as a cancellation before dispatch, because that
   * is precisely what it is.
   */
  async admit(runId: string, seat?: LocalAdmissionSeat | null): Promise<void> {
    const model = localOllamaModelKey(seat)
    if (!model) return
    await this.ensureCapacity()
    const controller = this.controllerFor(runId)
    if (controller.signal.aborted) throw admissionAbortedError()
    const ticket = await this.coordinator.admit(runId, model, controller.signal)
    // The grant and this run's release can land in the same turn: `drain()`
    // resolves the waiter, then `releaseRun` runs before this continuation, so
    // `forget` has already walked a ticket set that did not yet contain ours.
    // The ticket is the only handle left to it — hand it back here or the slot
    // is gone until something else happens to reconcile.
    if (controller.signal.aborted) {
      ticket.release()
      throw admissionAbortedError()
    }
  }

  /**
   * Give back everything a run holds, and re-derive the rest from live state.
   *
   * `liveSeats` must come from the caller's authoritative registry of runs that
   * are genuinely still going — never from this module, whose whole failure
   * mode is believing its own stale bookkeeping. Passing the finalizing run's
   * own seat is harmless: its ticket is already handed back by `forget`, and
   * reconcile only ever frees a model no live seat claims.
   */
  releaseRun(runId: string, liveSeats: Iterable<LocalAdmissionSeat>): void {
    const controller = this.controllers.get(runId)
    this.controllers.delete(runId)
    // Aborts a still-queued admission so it leaves the queue instead of being
    // granted a slot nobody is left to release.
    controller?.abort()
    this.coordinator.forget(runId)
    this.coordinator.reconcile(localOllamaModelKeys(liveSeats))
  }

  /**
   * A working deadline with local queue time added back.
   *
   * Extends by the WORST wait among the given runs, never the sum: a caller
   * waiting on twelve lanes lost the slowest lane's queue time, not twelve
   * lanes' worth of it. With no queueing anywhere the base deadline is returned
   * unchanged, which is what keeps an unconstrained host's timeout behaviour
   * identical to before.
   */
  effectiveDeadline(baseDeadlineMs: number, runIds: Iterable<string>): number {
    let worstId: string | undefined
    let worstMs = 0
    for (const runId of runIds) {
      const queuedMs = this.coordinator.queuedMsFor(runId)
      if (queuedMs > worstMs) {
        worstMs = queuedMs
        worstId = runId
      }
    }
    if (worstId === undefined) return baseDeadlineMs
    return this.coordinator.effectiveDeadline(worstId, baseDeadlineMs)
  }

  private controllerFor(runId: string): AbortController {
    const existing = this.controllers.get(runId)
    if (existing) return existing
    const created = new AbortController()
    this.controllers.set(runId, created)
    return created
  }

  /**
   * Size the gate from the host.
   *
   * The first admission waits for one probe (the probe's own timeout bounds it,
   * and a fan-out is about to move gigabytes of weights, so a couple of seconds
   * once is not the expensive part). After that the refresh is throttled and
   * fire-and-forget: capacity sharpening is not worth a dispatch stall, and an
   * un-refreshed gate is merely a slightly stale one.
   */
  private async ensureCapacity(): Promise<void> {
    if (!this.probedAtLeastOnce) {
      this.probedAtLeastOnce = true
      await this.refreshCapacity()
      return
    }
    // Every seat in a wave must await the SAME probe, and await it the same
    // number of hops deep. A fan-out launches its lanes in declared order and
    // they reach this line in that order; if the first seat waited for a probe
    // while later seats sailed past it, the wave would dispatch in
    // probe-completion order instead — silently reordering a round for no
    // reason the user could see.
    if (this.refreshInFlight) {
      await this.refreshInFlight
      return
    }
    if (this.now() - this.lastProbeAt >= this.refreshIntervalMs) void this.refreshCapacity()
  }

  private refreshCapacity(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    const inFlight = this.probeAndApply().finally(() => {
      this.lastProbeAt = this.now()
      this.refreshInFlight = undefined
    })
    this.refreshInFlight = inFlight
    return inFlight
  }

  private async probeAndApply(): Promise<void> {
    const result = await fetchOllamaLoadedModels({
      baseUrl: normalizeOllamaBaseUrl(this.options.getBaseUrl()),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    })
    if (result.reachable) {
      this.observation = observeOllamaResidency(this.observation, result.models.length)
    }
    const env = this.options.getEnv?.() ?? process.env
    const declaredCeiling = readDeclaredOllamaModelCeiling(env)
    const estimate = estimateOllamaCapacity({
      ...(declaredCeiling !== undefined ? { declaredCeiling } : {}),
      observation: this.observation,
      reachable: result.reachable
    })
    this.estimate = estimate
    // An unreachable probe yields no ceiling, which WIDENS an existing one back
    // to unbounded. That is the correct direction: a probe that learned nothing
    // must never be the reason a round starts serialising.
    this.coordinator.setCapacity(estimate.ceiling)
  }
}
