// Watch-PR host poller — Workstream A / Slice-6 (A1d integration).
//
// Main-process scheduler that drives the committed A1 cores for every chat with
// an active "watch PR" opt-in (Chat.watchedPr — the visible per-chat toggle is
// the ENTIRE authorization; a host poller has no permission posture). Each tick
// runs ONE bounded runWatchPrPollCycle per watched chat: fetch CI state via the
// injected GitService surface, re-validate the live head, and on a genuine fresh
// event ask the RENDERER to post the thread notification (the auto variant of
// handleNotifyThreadOfCi — ensemble ⇒ blackboard upsert, solo ⇒ transcript note
// + composer draft), awaiting its ack so the dedupe cursor advances ONLY after
// the notify actually lands.
//
// Quality bar (parity-four-baseline): zero sync IO — all git/gh work goes
// through the async GitService; timers are injected for tests; every cycle
// emits a visible progress event and a specific, actionable failure surface
// (gh unauthenticated / not installed are surfaced, never silently skipped —
// the a-recon gh-auth silent-failure gap).

import {
  WatchNotifyLedger,
  type PolledPrCiState,
  type WatchHeadSnapshot,
  type WatchedPrDescriptor
} from '../../shared/watchedPrNotify'
import {
  runWatchPrPollCycle,
  type WatchPollFailure,
  type WatchPollProgress
} from '../../shared/watchPrPollCycle'
import type { GitCiStatusSummary, GitPrSummary, GitResult } from './GitService'

/** Renderer → main: set or clear the per-chat watch opt-in. */
export interface SetWatchedPrPayload {
  chatId: string
  watchedPr: {
    workspacePath: string
    owner: string
    repo: string
    prNumber: number
  } | null
}

/** Renderer → main: outcome of a requested thread notification. */
export interface WatchPrAckPayload {
  chatId: string
  signature: string
  ok: boolean
  error?: string
}

/** Main → renderer: a fresh notify-worthy CI event for a watched PR. */
export interface WatchPrNotifyPayload {
  descriptor: WatchedPrDescriptor
  polled: PolledPrCiState
  signature: string
  /** Rich snapshots captured by the poll so the renderer can build the notice
   *  (buildCiNotice) without a second gh round-trip. */
  pr: GitPrSummary | null
  ci: GitCiStatusSummary | null
}

export const WATCH_PR_NOTIFY_CHANNEL = 'github:watch-pr-notify'
export const WATCH_PR_PROGRESS_CHANNEL = 'github:watch-pr-progress'
export const SET_WATCHED_PR_CHANNEL = 'github:set-watched-pr'
export const WATCH_PR_ACK_CHANNEL = 'github:watch-pr-notify-ack'

export interface WatchPrPollerDeps {
  /** The current opt-in set — one descriptor per chat with Chat.watchedPr set. */
  listWatchedChats: () => WatchedPrDescriptor[]
  /** Async CI fetch (GitService.ciStatus). maxRuns is bounded by the poller. */
  fetchCiSummary: (
    descriptor: WatchedPrDescriptor,
    options: { maxRuns: number }
  ) => Promise<GitResult<GitCiStatusSummary>>
  /** Best-effort main → renderer send (mainWindow.webContents.send). May throw safely. */
  send: (channel: string, payload: unknown) => void
  intervalMs?: number
  initialDelayMs?: number
  ackTimeoutMs?: number
  timers?: {
    setInterval: typeof setInterval
    clearInterval: typeof clearInterval
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  }
}

export interface WatchPrPoller {
  start: () => void
  stop: () => void
  /** One poll pass over all watched chats. Exposed for tests; start() schedules it. */
  tick: () => Promise<void>
  /** Renderer ack for a requested notification. */
  resolveAck: (chatId: string, signature: string, ok: boolean, error?: string) => void
  /** Drop a chat's dedupe cursor when its watch toggle is turned off. */
  forget: (chatId: string) => void
  /** Test/introspection helper. */
  lastSignatureFor: (chatId: string) => string | undefined
}

const DEFAULT_INTERVAL_MS = 90_000
const DEFAULT_INITIAL_DELAY_MS = 10_000
const DEFAULT_ACK_TIMEOUT_MS = 30_000

function notifyFailure(message: string): WatchPollFailure {
  return { kind: 'notify-error', message }
}

/** Map gh's failure wording onto the specific, actionable WatchPollFailure kinds. */
function failureFromGhText(text: string): WatchPollFailure {
  if (/not installed or not on PATH/i.test(text)) {
    return {
      kind: 'gh-not-installed',
      message: "GitHub CLI (gh) isn't installed or isn't on PATH — install it to watch PR checks."
    }
  }
  if (/not authenticated|auth login|authentication/i.test(text)) {
    return {
      kind: 'gh-unauthenticated',
      message: "GitHub CLI isn't authenticated — run `gh auth login`, then toggle the watch off and on."
    }
  }
  return { kind: 'fetch-error', message: `Couldn't check this PR's status: ${text}` }
}

/**
 * ciStatus reports gh auth/availability problems as ok:true + status 'blocked'
 * + a warning (never as a thrown error). Detect that shape and throw the
 * specific failure so the poll cycle surfaces it instead of silently skipping.
 */
function throwIfAuthSurface(summary: GitCiStatusSummary): void {
  if (summary.status !== 'blocked' || summary.binding.pr) return
  const warning = summary.warnings?.find((entry) => entry.trim().length > 0)
  if (warning) throw failureFromGhText(warning.trim())
}

/** Mirror of buildCiNotice().shouldOffer's merge-blocked half (prLifecycle tone 'blocked'). */
function isMergeBlocked(pr: GitPrSummary | undefined | null): boolean {
  if (!pr || pr.isDraft) return false
  const state = (pr.state || '').toUpperCase()
  if (state === 'MERGED' || state === 'CLOSED') return false
  return ['BLOCKED', 'UNKNOWN'].includes((pr.mergeStateStatus || '').toUpperCase())
}

function toPolledState(summary: GitCiStatusSummary): PolledPrCiState {
  const pr = summary.binding.pr
  return {
    // A missing/rotated PR yields a number that cannot match the stored opt-in,
    // so the decision core takes its skip-pr-changed path (watch stays armed).
    prNumber: typeof pr?.number === 'number' ? pr.number : -1,
    headSha: pr?.headRefOid ?? '',
    conclusion: summary.status,
    notifyWorthy: summary.status === 'failed' || isMergeBlocked(pr)
  }
}

function toHeadSnapshot(summary: GitCiStatusSummary): WatchHeadSnapshot {
  const pr = summary.binding.pr
  return {
    prNumber: typeof pr?.number === 'number' ? pr.number : -1,
    headSha: pr?.headRefOid ?? ''
  }
}

export function createWatchPrPoller(deps: WatchPrPollerDeps): WatchPrPoller {
  const ledger = new WatchNotifyLedger()
  const timers = deps.timers ?? {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  }
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const initialDelayMs = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS

  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let tickInFlight = false
  const chatsInFlight = new Set<string>()
  const pendingAcks = new Map<
    string,
    {
      resolve: () => void
      reject: (failure: WatchPollFailure) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const send = (channel: string, payload: unknown): void => {
    try {
      deps.send(channel, payload)
    } catch {
      // Best-effort: a dead renderer must not break the poll loop.
    }
  }

  const fetchSummary = async (
    descriptor: WatchedPrDescriptor,
    maxRuns: number
  ): Promise<GitCiStatusSummary> => {
    let result: GitResult<GitCiStatusSummary>
    try {
      result = await deps.fetchCiSummary(descriptor, { maxRuns })
    } catch (error) {
      throw failureFromGhText(error instanceof Error ? error.message : String(error))
    }
    if (!result.ok) throw failureFromGhText(result.error)
    throwIfAuthSurface(result.data)
    return result.data
  }

  const requestNotify = (payload: WatchPrNotifyPayload): Promise<void> => {
    const key = `${payload.descriptor.chatId}:${payload.signature}`
    send(WATCH_PR_NOTIFY_CHANNEL, payload)
    return new Promise<void>((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pendingAcks.delete(key)
        reject(
          notifyFailure(
            "Couldn't post the CI update to this thread: the app didn't confirm it in time."
          )
        )
      }, ackTimeoutMs)
      pendingAcks.set(key, { resolve, reject, timer })
    })
  }

  const pollOne = async (descriptor: WatchedPrDescriptor): Promise<void> => {
    // Rich snapshots captured during fetchPrCiState so the notify payload can
    // carry them without a third gh call.
    let richPr: GitPrSummary | null = null
    let richCi: GitCiStatusSummary | null = null
    await runWatchPrPollCycle(descriptor, {
      fetchPrCiState: async (current) => {
        const summary = await fetchSummary(current, 10)
        richPr = summary.binding.pr ?? null
        richCi = summary
        return toPolledState(summary)
      },
      fetchCurrentHead: async (current) => {
        const summary = await fetchSummary(current, 1)
        return toHeadSnapshot(summary)
      },
      ledger,
      notify: (current, polled, signature) =>
        requestNotify({ descriptor: current, polled, signature, pr: richPr, ci: richCi }),
      onProgress: (progress: WatchPollProgress) => {
        send(WATCH_PR_PROGRESS_CHANNEL, progress)
      }
    })
  }

  const tick = async (): Promise<void> => {
    if (tickInFlight) return
    tickInFlight = true
    try {
      let watched: WatchedPrDescriptor[]
      try {
        watched = deps.listWatchedChats()
      } catch {
        return // A store hiccup skips one tick; the next interval retries.
      }
      for (const descriptor of watched) {
        if (!descriptor?.chatId || chatsInFlight.has(descriptor.chatId)) continue
        chatsInFlight.add(descriptor.chatId)
        try {
          await pollOne(descriptor)
        } catch {
          // runWatchPrPollCycle never throws by contract; stay defensive so one
          // bad chat can never skip the rest of the watched set.
        } finally {
          chatsInFlight.delete(descriptor.chatId)
        }
      }
    } finally {
      tickInFlight = false
    }
  }

  return {
    start: () => {
      if (intervalTimer) return
      intervalTimer = timers.setInterval(() => {
        void tick()
      }, intervalMs)
      // Let the app finish booting before the first gh round-trips.
      initialTimer = timers.setTimeout(() => {
        void tick()
      }, initialDelayMs)
      const maybeUnref = (timer: unknown): void => {
        ;(timer as { unref?: () => void } | null)?.unref?.()
      }
      maybeUnref(intervalTimer)
      maybeUnref(initialTimer)
    },
    stop: () => {
      if (intervalTimer) {
        timers.clearInterval(intervalTimer)
        intervalTimer = null
      }
      if (initialTimer) {
        timers.clearTimeout(initialTimer)
        initialTimer = null
      }
      for (const [key, pending] of pendingAcks) {
        timers.clearTimeout(pending.timer)
        pending.reject(notifyFailure("Couldn't post the CI update to this thread: the watcher stopped."))
        pendingAcks.delete(key)
      }
    },
    tick,
    resolveAck: (chatId, signature, ok, error) => {
      const key = `${chatId}:${signature}`
      const pending = pendingAcks.get(key)
      if (!pending) return
      pendingAcks.delete(key)
      timers.clearTimeout(pending.timer)
      if (ok) {
        pending.resolve()
      } else {
        pending.reject(
          notifyFailure(error?.trim() || "Couldn't post the CI update to this thread.")
        )
      }
    },
    forget: (chatId) => {
      ledger.forget(chatId)
    },
    lastSignatureFor: (chatId) => ledger.lastSignatureFor(chatId)
  }
}
