/**
 * Makes a transcript stall impossible to mistake for an idle app.
 *
 * On 2026-09-11 a live ensemble round ran for 52 seconds while the transcript
 * showed nothing, and the only reason anyone found out was that a human sat
 * watching it and said so. Every counter in the app read healthy. A frozen
 * transcript and a quiet one were pixel-identical, and they must never be
 * again — a bound nobody can observe is not a bound.
 *
 * The contract is small: main announces a sequence for every transcript change
 * it makes, and the renderer settles that sequence once the rows are committed
 * into the window the user is looking at. While `settled < announced`, the
 * renderer KNOWS it is behind and by how long, whichever lane is at fault — the
 * pushed tail, the pulled page, or a stuck main thread that stopped announcing
 * at all. It cannot know it is behind something main never announced; that gap
 * is closed by the producer, not here.
 *
 * This is presentation state only. It never withholds, retries, or gates a
 * delivery: a watchdog that can change the thing it watches becomes part of the
 * failure it was meant to report.
 */

/** Below this, catching up is ordinary scheduling and not worth a word to the user. */
export const TRANSCRIPT_STALL_WARN_MS = 1_500

/** Above this, the transcript is meaningfully behind and the user should be told. */
export const TRANSCRIPT_STALL_ALERT_MS = 5_000

export type TranscriptStallLevel = 'current' | 'catching-up' | 'stalled'

export interface TranscriptStallStatus {
  level: TranscriptStallLevel
  /** How long the oldest unsettled announcement has been outstanding. */
  lagMs: number
  /** Newest sequence main has announced for this chat. */
  announcedSequence: number
  /** Newest sequence the visible window has committed. */
  settledSequence: number
}

export interface TranscriptStallWatchdogOptions {
  warnMs?: number
  alertMs?: number
  /** Bounds retained per-chat state; oldest-touched are evicted first. */
  maxTrackedChats?: number
}

interface ChatStallState {
  announcedSequence: number
  settledSequence: number
  /**
   * When the OLDEST still-unsettled announcement arrived — not the newest.
   * Using the newest would reset the clock on every frame, so a producer that
   * keeps announcing while the renderer cannot keep up would report a lag that
   * never grows. That is precisely the 2026-09-11 shape.
   */
  oldestUnsettledAtMs: number
  touchedAt: number
}

const CURRENT: TranscriptStallStatus = {
  level: 'current',
  lagMs: 0,
  announcedSequence: 0,
  settledSequence: 0
}

export class TranscriptStallWatchdog {
  private readonly states = new Map<string, ChatStallState>()
  private readonly warnMs: number
  private readonly alertMs: number
  private readonly maxTrackedChats: number
  private touchSequence = 0

  constructor(options: TranscriptStallWatchdogOptions = {}) {
    this.warnMs = Math.max(0, options.warnMs ?? TRANSCRIPT_STALL_WARN_MS)
    this.alertMs = Math.max(this.warnMs, options.alertMs ?? TRANSCRIPT_STALL_ALERT_MS)
    this.maxTrackedChats = Math.max(1, options.maxTrackedChats ?? 64)
  }

  /** Main said the transcript changed. Called for append AND resync frames. */
  announce(chatId: string, sequence: number, atMs: number): void {
    if (!chatId || !Number.isSafeInteger(sequence) || sequence <= 0) return
    const state = this.states.get(chatId)
    if (!state) {
      this.states.set(chatId, {
        announcedSequence: sequence,
        settledSequence: 0,
        oldestUnsettledAtMs: atMs,
        touchedAt: ++this.touchSequence
      })
      this.prune()
      return
    }
    state.touchedAt = ++this.touchSequence
    if (sequence <= state.announcedSequence) return
    // Only start the clock when moving from settled to unsettled; an already
    // outstanding gap keeps its original arrival time.
    if (state.announcedSequence <= state.settledSequence) state.oldestUnsettledAtMs = atMs
    state.announcedSequence = sequence
  }

  /** The visible window now reflects everything up to `sequence`. */
  settle(chatId: string, sequence: number, atMs: number): void {
    if (!chatId || !Number.isSafeInteger(sequence) || sequence < 0) return
    const state = this.states.get(chatId)
    if (!state) return
    state.touchedAt = ++this.touchSequence
    if (sequence <= state.settledSequence) return
    state.settledSequence = sequence
    // Still behind: the remaining gap started now, not when the settled frame
    // arrived, otherwise partial progress would inflate the reported lag.
    if (state.settledSequence < state.announcedSequence) state.oldestUnsettledAtMs = atMs
  }

  /**
   * A resync tells the renderer to pull, and the pull will commit a window
   * rather than a sequence. Settling to the announced high-water mark is how
   * that pull closes the gap.
   */
  settleToAnnounced(chatId: string, atMs: number): void {
    const state = this.states.get(chatId)
    if (!state) return
    this.settle(chatId, state.announcedSequence, atMs)
  }

  forget(chatId: string): void {
    this.states.delete(chatId)
  }

  status(chatId: string | null | undefined, nowMs: number): TranscriptStallStatus {
    if (!chatId) return CURRENT
    const state = this.states.get(chatId)
    if (!state) return CURRENT
    if (state.settledSequence >= state.announcedSequence) {
      return {
        level: 'current',
        lagMs: 0,
        announcedSequence: state.announcedSequence,
        settledSequence: state.settledSequence
      }
    }
    const lagMs = Math.max(0, nowMs - state.oldestUnsettledAtMs)
    return {
      level: lagMs >= this.alertMs ? 'stalled' : lagMs >= this.warnMs ? 'catching-up' : 'current',
      lagMs,
      announcedSequence: state.announcedSequence,
      settledSequence: state.settledSequence
    }
  }

  /** The worst outstanding lag across every tracked chat, for diagnostics. */
  worstLagMs(nowMs: number): number {
    let worst = 0
    for (const [chatId] of this.states) {
      const lag = this.status(chatId, nowMs).lagMs
      if (lag > worst) worst = lag
    }
    return worst
  }

  private prune(): void {
    if (this.states.size <= this.maxTrackedChats) return
    let oldestChatId: string | null = null
    let oldestTouchedAt = Number.POSITIVE_INFINITY
    for (const [chatId, state] of this.states) {
      if (state.touchedAt < oldestTouchedAt) {
        oldestTouchedAt = state.touchedAt
        oldestChatId = chatId
      }
    }
    if (oldestChatId !== null) this.states.delete(oldestChatId)
  }
}
