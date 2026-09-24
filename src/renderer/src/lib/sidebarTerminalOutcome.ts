import type { ChatListItem, ChatRecord, ChatRun } from '../../../main/store/types'

export const SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY =
  'taskwraith-sidebar-terminal-outcome-acknowledgements-v1'

export const SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY = 'taskwraith-sidebar-success-ink-epoch-v1'

export type SidebarTerminalOutcomeTone = 'success' | 'failure'

/**
 * What a sidebar row's title ink is saying.
 *
 * Two are settled outcomes; two are LIVE state. `waiting` is a thread parked
 * on an approval or an ask_user_question — the one case where the row is
 * asking for the user rather than reporting to them. `sleeping` is a run
 * parked on a clock rather than on a person: nothing is owed, it will wake
 * itself, and the row says so instead of looking finished.
 *
 * The ink is the sidebar's whole run vocabulary — the status chips that used
 * to sit in the subline are gone, so anything a row needs to say, it says
 * here.
 */
export type SidebarRowTone = SidebarTerminalOutcomeTone | 'waiting' | 'sleeping'

/** Ink class for a row tone. The two terminal tones keep their historical
 * class names (CSS + pinned tests); `waiting` gets a name that does not claim
 * to be an outcome, and the stylesheet shares one sweep across all three. */
export function sidebarRowToneClass(tone: SidebarRowTone): string {
  if (tone === 'waiting') return 'sidebar-attention-waiting'
  if (tone === 'sleeping') return 'sidebar-attention-sleeping'
  return `sidebar-terminal-outcome-${tone}`
}

/**
 * Is this thread's newest run asleep — parked on a clock, waiting to wake?
 *
 * Deliberately NOT an outcome: `terminalRunEvidence` refuses to settle a
 * sleeping run, because nothing has happened yet. It is live state like
 * `waiting`, so it needs no acknowledgement and retires the moment the run
 * wakes.
 */
export function chatIsSleeping(chat: ChatRecord): boolean {
  const run = latestSidebarRun(chat)
  return String(run?.status || '').toLowerCase() === 'sleeping'
}

/** Structural view of the renderer's pending-attention maps — kept loose so
 * this lib never imports the component graph for `AgentQuestionState` /
 * `AgentApprovalRequest`. */
export interface SidebarPendingAttentionSources {
  /** Head-of-queue approval per chat (`null` when none is showing). */
  approvalHeadByChatId?: Record<string, unknown> | undefined
  /** Approvals queued behind the head. */
  approvalQueueByChatId?: Record<string, readonly unknown[] | undefined> | undefined
  /** Unanswered ask_user_question cards. */
  questionsByChatId?: Record<string, readonly unknown[] | undefined> | undefined
}

/**
 * Is this thread blocked on the user answering something?
 *
 * Keyed on the MAP KEY, never on an approval's own `appChatId`: for sub-thread
 * and fan-out runs the request's chat id can be absent or diverge from the
 * thread it is filed under, and the filing key is what "which thread is
 * blocked" means (the same rule the Approvals footer jump uses).
 */
export function chatIsAwaitingUserResponse(
  chatId: string,
  sources: SidebarPendingAttentionSources | undefined
): boolean {
  if (!chatId || !sources) return false
  if (sources.approvalHeadByChatId?.[chatId]) return true
  if ((sources.approvalQueueByChatId?.[chatId]?.length ?? 0) > 0) return true
  return (sources.questionsByChatId?.[chatId]?.length ?? 0) > 0
}

export interface SidebarTerminalOutcomeProjection {
  fingerprint: string
  source: 'goal' | 'round' | 'run'
  tone: SidebarTerminalOutcomeTone
  /** When this result landed (epoch ms), for the success-ink epoch below.
   * Falls back to the chat's own `updatedAt` when the run/round/goal did not
   * record an end timestamp. */
  settledAtMs: number | null
}

export type SidebarTerminalOutcomeAcknowledgements = Record<string, string>

interface SidebarTerminalOutcomeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface TerminalEvidence {
  activeGoalId?: string
  fingerprint: string
  startedAt?: string
  /** When the unit ended, when it recorded one. */
  endedAt?: string
  tone: SidebarTerminalOutcomeTone | null
}

const TERMINAL_RUN_STATUSES = new Set([
  'cancelled',
  'completed',
  'failed',
  'success',
  'success_with_warnings'
])

const FAILURE_BLOCKER_KINDS = new Set([
  'looping',
  'stuck',
  'tool-error-cluster'
])

function latestSidebarRun(chat: ChatRecord): ChatRun | undefined {
  return (chat as Partial<ChatListItem>).lastRun || chat.runs?.[chat.runs.length - 1]
}

function terminalRunEvidence(run: ChatRun | undefined): TerminalEvidence | null {
  if (!run) return null
  const status = String(run.status || '').toLowerCase()
  const isTerminal = Boolean(run.endedAt || run.cancelled || TERMINAL_RUN_STATUSES.has(status))
  if (!isTerminal || status === 'sleeping') return null

  const exitCode = typeof run.exitCode === 'number' ? run.exitCode : null
  const cancelled = Boolean(run.cancelled || status === 'cancelled' || exitCode === 130)
  const failed = status === 'failed' || (exitCode !== null && exitCode !== 0 && exitCode !== 130)
  const tone: SidebarTerminalOutcomeTone | null = run.suppressRunSummary
    ? null
    : cancelled
      ? null
      : failed
        ? 'failure'
        : 'success'

  return {
    ...(run.activeGoalId ? { activeGoalId: run.activeGoalId } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    fingerprint: [
      'run',
      run.runId,
      status || 'ended',
      run.endedAt || '',
      exitCode ?? '',
      run.cancelled ? 'cancelled' : '',
      run.suppressRunSummary ? 'summary-suppressed' : ''
    ].join(':'),
    tone
  }
}

function terminalRoundEvidence(chat: ChatRecord): TerminalEvidence | null {
  const round = chat.ensemble?.activeRound
  if (!round || round.status === 'running') return null

  const hasQueuedFollowup = Boolean(round.queuedPrompt || round.queuedPrompts?.length)
  if (hasQueuedFollowup) return null

  const blockerKinds = (chat.ensemble?.escalationSignals || [])
    .filter(
      (signal) => signal.roundId === round.roundId && FAILURE_BLOCKER_KINDS.has(String(signal.kind))
    )
    .map((signal) => signal.kind)
    .sort()
  const tone: SidebarTerminalOutcomeTone | null =
    round.status === 'failed' || blockerKinds.length > 0
      ? 'failure'
      : round.status === 'completed'
        ? 'success'
        : null

  return {
    fingerprint: [
      'round',
      round.roundId,
      round.status,
      round.endedAt || '',
      blockerKinds.join(',')
    ].join(':'),
    startedAt: round.startedAt,
    ...(round.endedAt ? { endedAt: round.endedAt } : {}),
    tone
  }
}

function terminalEvidenceForChat(chat: ChatRecord): TerminalEvidence | null {
  if (chat.ensemble?.activeRound) return terminalRoundEvidence(chat)
  return terminalRunEvidence(latestSidebarRun(chat))
}

function chatHasUnsettledTerminalUnit(chat: ChatRecord): boolean {
  const round = chat.ensemble?.activeRound
  if (round) {
    return Boolean(round.status === 'running' || round.queuedPrompt || round.queuedPrompts?.length)
  }
  const run = latestSidebarRun(chat)
  return Boolean(run && !terminalRunEvidence(run))
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Best available "when did this land". A terminal unit that recorded no end
 * timestamp falls back to the chat's own `updatedAt`, which is the closest
 * durable proxy — better than treating the result as undateable, which would
 * park it on the wrong side of the success-ink epoch forever. */
function settledAtMsFor(chat: ChatRecord, preferred: number | null): number | null {
  if (preferred !== null) return preferred
  return typeof chat.updatedAt === 'number' ? chat.updatedAt : null
}

function terminalGoalTimestamp(chat: ChatRecord): string | undefined {
  const goal = chat.activeGoal
  if (!goal) return undefined
  if (goal.status === 'completed') return goal.completedAt || goal.updatedAt
  if (goal.status === 'blocked') return goal.blockedAt || goal.updatedAt
  return undefined
}

function terminalGoalAppliesToEvidence(
  chat: ChatRecord,
  evidence: TerminalEvidence | null
): boolean {
  const goal = chat.activeGoal
  if (!goal || (goal.status !== 'completed' && goal.status !== 'blocked')) return false
  if (goal.status === 'blocked') return true
  if (!evidence) return true
  if (evidence.activeGoalId === goal.id) return true

  const goalAt = parseTimestamp(terminalGoalTimestamp(chat))
  const evidenceStartedAt = parseTimestamp(evidence.startedAt)
  if (goalAt === null) return false
  return evidenceStartedAt === null || goalAt >= evidenceStartedAt
}

/**
 * Projects the latest durable terminal result into the sidebar's two attention
 * tones. This never mutates the run/round history: a completed goal may win the
 * PRESENTATION tone over a failed terminal run from that same goal, while the
 * underlying failed run remains failed everywhere else.
 *
 * Active/paused goals intentionally suppress ordinary successful-turn green —
 * a provider turn ending is not the same thing as the goal succeeding. Concrete
 * failure evidence still surfaces red. Cancelled runs and intentional steer
 * handoffs are terminal but neutral, matching the Task Complete card.
 */
export function projectSidebarTerminalOutcome(
  chat: ChatRecord
): SidebarTerminalOutcomeProjection | null {
  if (chatHasUnsettledTerminalUnit(chat)) return null
  const evidence = terminalEvidenceForChat(chat)
  const goal = chat.activeGoal

  if (goal && terminalGoalAppliesToEvidence(chat, evidence)) {
    const goalTimestamp = terminalGoalTimestamp(chat) || ''
    return {
      fingerprint: [
        'goal',
        goal.id,
        goal.status,
        goalTimestamp,
        evidence?.fingerprint || 'standalone'
      ].join(':'),
      source: 'goal',
      tone: goal.status === 'completed' ? 'success' : 'failure',
      settledAtMs: settledAtMsFor(
        chat,
        parseTimestamp(goalTimestamp) ?? parseTimestamp(evidence?.endedAt)
      )
    }
  }

  if (!evidence?.tone) return null
  if (
    goal &&
    (goal.status === 'active' || goal.status === 'paused') &&
    evidence.tone === 'success'
  ) {
    return null
  }

  return {
    fingerprint: evidence.fingerprint,
    source: chat.ensemble?.activeRound ? 'round' : 'run',
    tone: evidence.tone,
    settledAtMs: settledAtMsFor(chat, parseTimestamp(evidence.endedAt))
  }
}

function defaultStorage(): SidebarTerminalOutcomeStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function loadSidebarTerminalOutcomeAcknowledgements(
  storage: SidebarTerminalOutcomeStorage | null = defaultStorage()
): SidebarTerminalOutcomeAcknowledgements {
  if (!storage) return {}
  try {
    const raw = storage.getItem(SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const acknowledgements: SidebarTerminalOutcomeAcknowledgements = {}
    for (const [chatId, fingerprint] of Object.entries(parsed).slice(-2_000)) {
      if (typeof fingerprint === 'string' && fingerprint.length <= 2_048) {
        acknowledgements[chatId] = fingerprint
      }
    }
    return acknowledgements
  } catch {
    return {}
  }
}

export function persistSidebarTerminalOutcomeAcknowledgements(
  acknowledgements: SidebarTerminalOutcomeAcknowledgements,
  storage: SidebarTerminalOutcomeStorage | null = defaultStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY, JSON.stringify(acknowledgements))
  } catch {
    // Renderer-local acknowledgement is best effort when storage is unavailable.
  }
}

/**
 * First moment this install could have shown success ink, seeded on first read
 * and never moved again.
 *
 * Without it, the very first launch after upgrading lights up EVERY settled
 * thread in the sidebar green at once: the unread check is fingerprint-based,
 * and a fresh install has acknowledged nothing, so a year of finished work all
 * reads as brand-new. That is noise, not news.
 *
 * An epoch rather than bulk-acknowledging every existing outcome: it is one
 * value instead of thousands (the ack store caps at 2,000 entries and would
 * silently drop the overflow), and it stays correct for threads that were not
 * loaded at seed time.
 */
export function loadOrSeedSidebarSuccessInkEpoch(
  nowMs: number,
  storage: SidebarTerminalOutcomeStorage | null = defaultStorage()
): number {
  if (!storage) return nowMs
  try {
    const raw = storage.getItem(SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY)
    const parsed = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    storage.setItem(SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY, String(nowMs))
    return nowMs
  } catch {
    return nowMs
  }
}

/**
 * Should this outcome's ink be withheld as pre-existing history?
 *
 * SUCCESS only. A failure from before the upgrade is still worth flagging —
 * it is unfinished business the user may never have seen — while a success
 * from before the upgrade is a result they already lived through.
 *
 * The cutoff is per-RESULT, not per-thread: an old thread that runs again and
 * succeeds settles after the epoch and shows green like any other new result.
 * Only what had already finished before the upgrade stays quiet.
 */
export function sidebarSuccessInkPredatesEpoch(
  outcome: SidebarTerminalOutcomeProjection,
  epochMs: number | null
): boolean {
  if (outcome.tone !== 'success') return false
  if (epochMs === null) return false
  // An undateable success is treated as history. Every live code path stamps
  // one (run/round/goal end, else the chat's updatedAt), so this is the
  // defensive arm — and erring toward quiet is the whole point of the epoch.
  if (outcome.settledAtMs === null) return true
  return outcome.settledAtMs < epochMs
}

export function acknowledgeSidebarTerminalOutcome(
  acknowledgements: SidebarTerminalOutcomeAcknowledgements,
  chatId: string,
  outcome: SidebarTerminalOutcomeProjection
): SidebarTerminalOutcomeAcknowledgements {
  if (acknowledgements[chatId] === outcome.fingerprint) return acknowledgements
  return { ...acknowledgements, [chatId]: outcome.fingerprint }
}

export function isSidebarTerminalOutcomeUnread(
  acknowledgements: SidebarTerminalOutcomeAcknowledgements,
  chatId: string,
  outcome: SidebarTerminalOutcomeProjection
): boolean {
  return acknowledgements[chatId] !== outcome.fingerprint
}
