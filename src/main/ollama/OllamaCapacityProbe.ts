/**
 * OllamaCapacityProbe — how many models the local Ollama host will hold at once.
 *
 * Read-only. Nothing here admits, refuses, queues or delays a run; it only
 * reports what the host says about itself so a later admission gate can size
 * itself from the machine instead of from a constant.
 *
 * The rule this module exists to encode: **default to no opinion, and narrow
 * only on evidence the host actually gave us.** A workstation with two 30B
 * models and 51.8 GiB of unified memory and a rack of H100s are the same code
 * path, and the second one must not inherit the first one's caution. So an
 * absent signal returns `undefined` (unbounded) rather than a "safe" small
 * number — a guessed ceiling is indistinguishable, downstream, from a measured
 * one, and it would serialise a host that never needed serialising.
 *
 * Two signals, and they are not symmetric:
 *
 * - A **declared** ceiling (`OLLAMA_MAX_LOADED_MODELS`) is the host operator
 *   stating a limit. It is the strongest signal we get, but it can be stale:
 *   the variable is read by `ollama serve` at start, so a value changed since
 *   then describes a server that is no longer running.
 * - **Observed residency** (`GET /api/ps`) is proof of what the host DID hold.
 *   It is a FLOOR, never a ceiling. Seeing three models resident proves
 *   capacity is at least three; it proves nothing about four. This asymmetry
 *   is the whole safety property — measurement may widen a declaration, and
 *   may never invent or narrow one.
 *
 * Everything fails soft. An unreachable or erroring Ollama yields "no opinion",
 * not a conservative guess: a probe that cannot reach the host has learned
 * nothing, and turning a failed HTTP call into a throttle would let a transient
 * connection refusal serialise an entire fan-out.
 */

/** Environment variable `ollama serve` reads its residency limit from. */
export const OLLAMA_MAX_LOADED_MODELS_ENV_KEY = 'OLLAMA_MAX_LOADED_MODELS'

const DEFAULT_PROBE_TIMEOUT_MS = 2_000

/** One model resident in the local runner, as much as capacity sizing needs. */
export interface OllamaLoadedModel {
  readonly model: string
  /** VRAM footprint reported by the runner, when it reports one. */
  readonly sizeVramBytes?: number
  /** When the runner intends to evict it (`keep_alive`), when reported. */
  readonly expiresAt?: string
}

/** Outcome of one `/api/ps` read. `reachable: false` means "we learned nothing". */
export interface OllamaLoadedModelsResult {
  readonly reachable: boolean
  readonly models: OllamaLoadedModel[]
}

/**
 * Accumulated residency evidence across probes.
 *
 * Deliberately just a high-water mark: capacity questions are about the peak
 * the host tolerated, and a mean or a recent sample would drift downward
 * during idle periods and quietly narrow a limit nobody declared.
 */
export interface OllamaResidencyObservation {
  /** Highest simultaneous residency actually seen. Capacity is at least this. */
  readonly observedHighWater: number
  /** How many probes contributed, for reporting confidence. */
  readonly samples: number
}

export const EMPTY_OLLAMA_RESIDENCY_OBSERVATION: OllamaResidencyObservation = {
  observedHighWater: 0,
  samples: 0
}

/** Where a capacity estimate's ceiling came from. `unknown` means unbounded. */
export type OllamaCapacitySource = 'declared' | 'observed' | 'unknown'

export interface OllamaCapacityEstimate {
  /**
   * Most models that may be resident at once.
   *
   * `undefined` means no opinion — the caller must treat it as unbounded and
   * behave exactly as it did before this module existed.
   */
  readonly ceiling?: number
  /** Residency already proven achievable on this host. */
  readonly floor: number
  readonly source: OllamaCapacitySource
  readonly reachable: boolean
  /** One line for logs and the eventual "waiting on local capacity" card. */
  readonly summary: string
}

export interface OllamaCapacityInputs {
  readonly declaredCeiling?: number
  readonly observation: OllamaResidencyObservation
  readonly reachable: boolean
}

export interface OllamaLoadedModelsOptions {
  readonly baseUrl: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

function positiveInteger(value: unknown): number | undefined {
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '' || raw === null || raw === undefined) return undefined
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.trunc(parsed)
}

/**
 * Read a declared residency ceiling from an environment map.
 *
 * `0` is Ollama's documented "you decide" value, so it reads as NO ceiling
 * rather than as a ceiling of zero — the difference between "unconstrained"
 * and "admit nothing, ever".
 */
export function readDeclaredOllamaModelCeiling(
  env: Record<string, string | undefined>
): number | undefined {
  return positiveInteger(env[OLLAMA_MAX_LOADED_MODELS_ENV_KEY])
}

/** Normalise an `/api/ps` body. Tolerates anything; never throws. */
export function parseOllamaLoadedModels(payload: unknown): OllamaLoadedModel[] {
  const rows =
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { models?: unknown }).models)
      ? ((payload as { models: unknown[] }).models as unknown[])
      : []
  const models: OllamaLoadedModel[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const name = typeof record.model === 'string' ? record.model.trim() : ''
    if (!name) continue
    const model: {
      model: string
      sizeVramBytes?: number
      expiresAt?: string
    } = { model: name }
    const sizeVram = positiveInteger(record.size_vram)
    if (sizeVram !== undefined) model.sizeVramBytes = sizeVram
    const expiresAt = typeof record.expires_at === 'string' ? record.expires_at.trim() : ''
    if (expiresAt) model.expiresAt = expiresAt
    models.push(model)
  }
  return models
}

/**
 * Read currently-resident models from a local Ollama.
 *
 * Fails soft in every direction — refused connection, timeout, non-200,
 * unparseable body all land on `{ reachable: false, models: [] }`, because the
 * only honest thing a failed probe can report is that it learned nothing.
 */
export async function fetchOllamaLoadedModels(
  options: OllamaLoadedModelsOptions
): Promise<OllamaLoadedModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onExternalAbort)
  try {
    const response = await fetchImpl(`${baseUrl}/api/ps`, {
      method: 'GET',
      signal: controller.signal
    })
    if (!response.ok) return { reachable: false, models: [] }
    const payload = (await response.json()) as unknown
    return { reachable: true, models: parseOllamaLoadedModels(payload) }
  } catch {
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/** Fold one residency reading into the running high-water observation. */
export function observeOllamaResidency(
  previous: OllamaResidencyObservation,
  residentCount: number
): OllamaResidencyObservation {
  const count = Number.isFinite(residentCount) ? Math.max(0, Math.trunc(residentCount)) : 0
  return {
    observedHighWater: Math.max(previous.observedHighWater, count),
    samples: previous.samples + 1
  }
}

/**
 * Combine declaration and measurement into a capacity opinion.
 *
 * Observation can only ever RAISE a declared ceiling (a stale env var
 * contradicted by what the host actually held), never lower one and never
 * create one from nothing. With no declaration the answer is `undefined` no
 * matter how much residency we have seen — a host that has held three models
 * has told us nothing about its limit, only about its floor.
 */
export function estimateOllamaCapacity(inputs: OllamaCapacityInputs): OllamaCapacityEstimate {
  const floor = Math.max(0, inputs.observation.observedHighWater)
  const declared = positiveInteger(inputs.declaredCeiling)

  if (!inputs.reachable) {
    return {
      floor,
      source: 'unknown',
      reachable: false,
      summary: 'Ollama did not answer the capacity probe; treating local capacity as unbounded.'
    }
  }

  if (declared === undefined) {
    return {
      floor,
      source: 'unknown',
      reachable: true,
      summary: `No ${OLLAMA_MAX_LOADED_MODELS_ENV_KEY} declared; treating local capacity as unbounded.`
    }
  }

  if (floor > declared) {
    return {
      ceiling: floor,
      floor,
      source: 'observed',
      reachable: true,
      summary: `Observed ${floor} models resident at once, above the declared ${OLLAMA_MAX_LOADED_MODELS_ENV_KEY}=${declared}; trusting the measurement.`
    }
  }

  return {
    ceiling: declared,
    floor,
    source: 'declared',
    reachable: true,
    summary: `${OLLAMA_MAX_LOADED_MODELS_ENV_KEY}=${declared} declared by the host.`
  }
}
