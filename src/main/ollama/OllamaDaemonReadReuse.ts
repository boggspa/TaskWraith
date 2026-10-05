/**
 * Reuse of the Ollama daemon reads a launching run makes.
 *
 * Measured against a counting daemon serving four tags, one Ollama turn cost
 * three model-list reads (`/api/tags` plus the `/api/status`, `/api/me` and
 * recommendations probes that ride with it) and nine `/api/show` requests: the
 * admission preflight and the capability warnings each built a status
 * snapshot that read every model's show, and the launch plan read its own.
 *
 * The rules:
 * - A read made for the UI (status card, model picker, capability contract,
 *   an explicit Refresh) always reaches the daemon. Concurrent catalog reads
 *   share one in-flight request, and each successful answer replaces what runs
 *   reuse, so Refresh is also how the app invalidates it.
 * - A read made for a launching run may reuse an answer the daemon gave
 *   moments ago: the model list for {@link OLLAMA_RUN_CATALOG_REUSE_MS}, a
 *   model's show for {@link OLLAMA_RUN_MODEL_SHOW_REUSE_MS}. Show answers are
 *   keyed by base URL, model and the digest `/api/tags` reported, so a model
 *   re-pulled or re-created under the same tag is read again.
 * - Concurrent runs share one in-flight `/api/show` request per key.
 * - Failures are never remembered.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Long enough to span one run's preflight, launch plan and warnings. */
export const OLLAMA_RUN_CATALOG_REUSE_MS = 10_000

/** Show metadata changes only on pull, remove or re-create. */
export const OLLAMA_RUN_MODEL_SHOW_REUSE_MS = 30_000

interface RememberedAnswer {
  readonly value: unknown
  readonly at: number
}

const catalogAnswers = new Map<string, RememberedAnswer>()
const modelShowAnswers = new Map<string, RememberedAnswer>()
const modelShowFlights = new Map<string, Promise<unknown>>()
const runReads = new AsyncLocalStorage<true>()

function remember(
  answers: Map<string, RememberedAnswer>,
  key: string,
  value: unknown,
  maxAgeMs: number
): void {
  const now = Date.now()
  for (const [entryKey, entry] of answers) {
    if (now - entry.at > maxAgeMs) answers.delete(entryKey)
  }
  answers.set(key, { value, at: now })
}

function recall<T>(
  answers: Map<string, RememberedAnswer>,
  key: string,
  maxAgeMs: number
): T | undefined {
  const entry = answers.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > maxAgeMs) {
    answers.delete(key)
    return undefined
  }
  return entry.value as T
}

/** Reject when `signal` aborts, without cancelling `promise` for anyone else. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

/**
 * Run `read` as a read made for a launching run. Main's capability warnings
 * reach the Ollama adapter through provider-generic code that carries no
 * caller, so the run marks the call instead.
 */
export function withinOllamaRunReads<T>(read: () => T): T {
  return runReads.run(true, read)
}

/** True inside {@link withinOllamaRunReads}. */
export function isOllamaRunRead(): boolean {
  return runReads.getStore() === true
}

/** A plain read's answer: it replaces what runs reuse, and a failure removes it. */
export function rememberOllamaCatalog(key: string, catalog: unknown): void {
  if (catalog) remember(catalogAnswers, key, catalog, OLLAMA_RUN_CATALOG_REUSE_MS)
  else catalogAnswers.delete(key)
}

/** The model list a read made moments ago returned, for a run to reuse. */
export function recentOllamaCatalog<T>(key: string): T | undefined {
  return recall<T>(catalogAnswers, key, OLLAMA_RUN_CATALOG_REUSE_MS)
}

/** A UI read's answer: it replaces what runs reuse, and a failure removes it. */
export function rememberOllamaModelShow(key: string, show: unknown): void {
  if (show) remember(modelShowAnswers, key, show, OLLAMA_RUN_MODEL_SHOW_REUSE_MS)
  else modelShowAnswers.delete(key)
}

/**
 * A model's show metadata for a launching run: a recent answer, else the
 * request another run already has in flight, else `read`, which is this run's
 * own request on its own signal. A request another run's Stop ended says
 * nothing about this run, which then asks again; this run's own Stop rejects
 * as the request would have. `read` resolving `null` is a failure and is
 * shared with the runs waiting on it but never remembered.
 */
export async function readOllamaModelShowForRun<T>(
  key: string,
  read: () => Promise<T | null>,
  signal?: AbortSignal
): Promise<T | null> {
  const recent = recall<T>(modelShowAnswers, key, OLLAMA_RUN_MODEL_SHOW_REUSE_MS)
  if (recent) return recent
  const shared = modelShowFlights.get(key) as Promise<T | null> | undefined
  if (shared) {
    try {
      return await untilAborted(shared, signal)
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  const flight = read()
  modelShowFlights.set(key, flight)
  try {
    const show = await flight
    if (show) remember(modelShowAnswers, key, show, OLLAMA_RUN_MODEL_SHOW_REUSE_MS)
    return show
  } finally {
    if (modelShowFlights.get(key) === flight) modelShowFlights.delete(key)
  }
}

export function resetOllamaDaemonReadReuseForTests(): void {
  catalogAnswers.clear()
  modelShowAnswers.clear()
  modelShowFlights.clear()
}
