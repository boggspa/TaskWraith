/**
 * 1.0.5-EW37 — Solo-chat wakeups.
 *
 * Extends the Phase N (1.0.5) wakeup foundation off the
 * ensemble-only `payload.ensembleRun` gate so a solo chat can also
 * pause + resume itself via the `schedule_wakeup` MCP tool. Uses
 * the same shared substrate (`WakeupTimerService` +
 * `classifyWakeupRecovery`) as the ensemble path; this module
 * just owns the solo-specific bookkeeping (persistence on
 * `chat.soloWakeups`, dispatch on fire).
 *
 * **Lifecycle**:
 *
 *   1. Agent (mid-run) calls `schedule_wakeup`.
 *   2. `scheduleWakeup` persists a `SoloChatWakeupRecord` on
 *      `chat.soloWakeups[wakeupId]` and arms a timer.
 *   3. The agent's current run is allowed to exit naturally (we
 *      don't kill it — the agent's task-complete returns its own
 *      exit). The chat's last-run-status reflects the pending
 *      wakeup.
 *   4. Timer fires → `handleWakeupFired` looks up the record,
 *      marks it `'fired'`, and dispatches a continuation run on
 *      the chat using `runCoordinator.dispatch`. The continuation
 *      prompt seeds the agent with the original reason +
 *      reuses `chat.linkedProviderSessionId` so the provider's
 *      own session context survives where supported.
 *   5. On app restart, `recoverPersistedWakeups` runs the same
 *      classifier as the ensemble path; pending wakeups whose
 *      `wakeAt` is in the past + within the grace window fire
 *      immediately, those still in the future get re-armed, and
 *      anything past the grace window expires cleanly.
 *
 * **What this module deliberately does NOT do**:
 *
 *   - Cross-chat scheduling. A wakeup belongs to exactly one chat.
 *   - Solo-chat orchestration of multiple wakeups within a single
 *     turn (the agent should schedule one wakeup per
 *     "pause-and-resume" cycle).
 *   - Survival across `chatKind` mutations. If a chat is
 *     converted between solo and ensemble (rare / accidental),
 *     the wakeup will surface in the appropriate path on next
 *     boot and either fire or expire normally.
 */

import type {
  ChatMessage,
  ChatRecord,
  EffectiveRunPermissions,
  ExternalPathGrant,
  ProviderId,
  SoloChatWakeupRecord
} from './store/types'
import type { AgentRunPayload } from './run/AgentRunTypes'
import type { RunPermissionPostureContext } from './RunPermissionPosture'

/**
 * Pure validator + builder. Resolves the requested wake target
 * (one of `wakeAt`, `delayMs`, or `delaySeconds`) into a millisecond
 * timestamp + validates against the 7-day max delay.
 *
 * Exported for testing — the orchestrator method below delegates
 * to this so the exit conditions are pinned without spinning up
 * the full service.
 */
export interface ScheduleWakeupInput {
  wakeAt?: string
  delayMs?: number
  delaySeconds?: number
  reason?: string
  cancelOnUserInput?: boolean
}

export interface SoloWakeupRunContext {
  approvalMode?: string
  sessionTrust?: boolean
  externalPathGrants?: ExternalPathGrant[]
  effectivePermissions?: EffectiveRunPermissions
}

/** Same 7-day cap as the ensemble path (`MAX_WAKEUP_DELAY_MS` in
 * `EnsembleOrchestrator.ts`). Node's `setTimeout` silently clamps
 * delays > 2³¹−1 ms to 1ms, so far-future wakeups would otherwise
 * fire immediately. Sequential wakeups handle longer horizons.
 */
export const SOLO_MAX_WAKEUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export function resolveSoloWakeAtMs(input: ScheduleWakeupInput, nowMs: number): number {
  if (input.wakeAt) {
    const parsed = Date.parse(input.wakeAt)
    if (Number.isFinite(parsed)) return parsed
  }
  if (input.delayMs !== undefined && Number.isFinite(input.delayMs)) {
    return nowMs + Math.max(0, input.delayMs)
  }
  if (input.delaySeconds !== undefined && Number.isFinite(input.delaySeconds)) {
    return nowMs + Math.max(0, input.delaySeconds) * 1000
  }
  return Number.NaN
}

/** Max chars of the recalled assistant message folded into the resume
 * prompt — enough to re-orient the agent without re-dumping a whole turn. */
const SOLO_RECALL_MAX_CHARS = 1200
/** Max distinct tool names listed in the recall trace. */
const SOLO_RECALL_MAX_TOOLS = 8

/**
 * 1.0.7 (AR14 / AV3) — solo "scratchpad recall". When a solo chat resumes from
 * a `schedule_wakeup`, reconstruct a compact recap of what the agent was doing
 * before it slept so the continuation isn't a cold "continue per your earlier
 * plan". Pure + dependency-free (no cross-import of the ensemble prompt
 * builder, to avoid a cycle): reads the chat's own recent history.
 *
 * Recall = the last substantive ASSISTANT message (truncated) + a de-duplicated
 * trace of the tools that message ran. Returns '' when there's nothing useful
 * to recall (brand-new chat, no prior assistant turn) so the caller can omit
 * the section.
 */
export function buildSoloScratchpadRecall(chat: ChatRecord): string {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  // Walk backwards to the most recent assistant message with real content.
  let lastAssistant: ChatMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      lastAssistant = m
      break
    }
  }
  if (!lastAssistant) return ''

  const lines: string[] = ['Where you left off before sleeping:']
  const body = lastAssistant.content.trim()
  const recap =
    body.length > SOLO_RECALL_MAX_CHARS
      ? `${body.slice(0, SOLO_RECALL_MAX_CHARS - 1).trimEnd()}…`
      : body
  lines.push('', 'Your last message:', recap)

  // Compact, de-duplicated tool trace (name × count) from that turn's run.
  const runId = lastAssistant.runId
  const activities = runId
    ? messages
        .filter((m) => m.runId === runId && Array.isArray(m.toolActivities))
        .flatMap((m) => m.toolActivities || [])
    : lastAssistant.toolActivities || []
  if (activities.length > 0) {
    const counts = new Map<string, number>()
    for (const a of activities) {
      const name = (a?.toolName || '').trim()
      if (!name) continue
      counts.set(name, (counts.get(name) || 0) + 1)
    }
    const trace = Array.from(counts.entries())
      .slice(0, SOLO_RECALL_MAX_TOOLS)
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join(', ')
    if (trace) lines.push('', `Tools you used: ${trace}.`)
  }
  return lines.join('\n')
}

function cloneExternalPathGrants(
  grants: ExternalPathGrant[] | undefined
): ExternalPathGrant[] | undefined {
  if (!Array.isArray(grants)) return undefined
  return grants.map((grant) => ({ ...grant }))
}

function cloneDurableExternalPathGrants(
  grants: ExternalPathGrant[] | undefined
): ExternalPathGrant[] | undefined {
  const durable = grants?.filter((grant) => grant.duration === 'thisThread')
  return durable?.length ? cloneExternalPathGrants(durable) : undefined
}

function cloneEffectiveRunPermissions(
  permissions: EffectiveRunPermissions | undefined
): EffectiveRunPermissions | undefined {
  if (!permissions) return undefined
  return {
    ...permissions,
    agenticServices: { ...permissions.agenticServices },
    externalPathGrants: cloneExternalPathGrants(permissions.externalPathGrants) || [],
    workspaceGrantServiceIds: [...permissions.workspaceGrantServiceIds]
  }
}

function buildResumePermissionSnapshot(
  runContext: SoloWakeupRunContext | undefined
): SoloChatWakeupRecord['resumePermissions'] | undefined {
  if (!runContext) return undefined
  const snapshot: SoloChatWakeupRecord['resumePermissions'] = {}
  if (typeof runContext.approvalMode === 'string') snapshot.approvalMode = runContext.approvalMode
  if (runContext.sessionTrust !== undefined) snapshot.sessionTrust = runContext.sessionTrust
  // A scheduled wakeup is a new run, potentially after app restart. Never
  // persist/replay a `thisRun` bearer token under its fresh run id; only
  // canonical thread grants are eligible to resume.
  const externalPathGrants = cloneDurableExternalPathGrants(runContext.externalPathGrants)
  if (externalPathGrants?.length) snapshot.externalPathGrants = externalPathGrants
  const effectivePermissions = cloneEffectiveRunPermissions(runContext.effectivePermissions)
  if (effectivePermissions) {
    effectivePermissions.externalPathGrants =
      cloneDurableExternalPathGrants(effectivePermissions.externalPathGrants) || []
    snapshot.effectivePermissions = effectivePermissions
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

/**
 * True when `prompt` is a main-built solo wakeup resume (see
 * `buildSoloWakeupResumePayload`). User-send cancel must skip these so a
 * resume is never treated as user input that cancels pending wakeups.
 */
export function isSoloWakeupResumePrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false
  return (
    prompt.startsWith('[Resumed at ') && prompt.includes(' from your scheduled wakeup.')
  )
}

/**
 * Build the continuation `AgentRunPayload` we dispatch when a solo
 * wakeup fires. Pure — exported for tests so we can pin the prompt
 * + provider-session-id wiring without spinning up the full
 * service.
 *
 * Prompt seeds the agent with a wakeup-resume context: timestamp + original
 * reason, a 1.0.7 "scratchpad recall" recap of where it left off (last message
 * + tool trace), then "continue per your earlier plan".
 */
export function buildSoloWakeupResumePayload(
  chat: ChatRecord,
  wakeup: SoloChatWakeupRecord,
  appRunId: string,
  nowIso: string
): AgentRunPayload {
  const reasonLine = wakeup.reason ? ` Reason recorded at schedule time: ${wakeup.reason}.` : ''
  // 1.0.7 — fold in the scratchpad recall when there's prior context to recall.
  const recall = buildSoloScratchpadRecall(chat)
  const recallBlock = recall ? `\n\n${recall}` : ''
  const prompt =
    `[Resumed at ${nowIso} from your scheduled wakeup.${reasonLine}]${recallBlock}\n\n` +
    `Continue your task per your earlier plan. If you need to pause again, ` +
    `call schedule_wakeup again with a fresh delay.`
  // Preserve scope + workspace + provider from the chat so the
  // continuation runs in the same context the original turn did.
  // `linkedProviderSessionId` is used by the adapter to resume the
  // provider's own session where supported (Codex, Claude).
  const resumePermissions = wakeup.resumePermissions
  return {
    provider: wakeup.provider,
    scope: chat.workspacePath ? 'workspace' : 'global',
    workspace: chat.workspacePath,
    prompt,
    appRunId,
    appChatId: chat.appChatId,
    providerSessionId: chat.linkedProviderSessionId ?? null,
    ...(resumePermissions?.approvalMode ? { approvalMode: resumePermissions.approvalMode } : {}),
    ...(resumePermissions?.sessionTrust !== undefined
      ? { sessionTrust: resumePermissions.sessionTrust }
      : {}),
    ...(resumePermissions?.externalPathGrants?.length
      ? { externalPathGrants: cloneExternalPathGrants(resumePermissions.externalPathGrants) }
      : {}),
    ...(resumePermissions?.effectivePermissions
      ? {
          effectivePermissions: cloneEffectiveRunPermissions(resumePermissions.effectivePermissions)
        }
      : {})
  }
}

export interface SoloChatWakeupServiceDeps {
  // Returns the chat or null/undefined. Both shapes are accepted
  // so the production wiring against `AppStore.getChat` (returns
  // `ChatRecord | null`) doesn't need a coercion layer.
  getChat: (chatId: string) => ChatRecord | undefined | null
  saveChat: (chat: ChatRecord) => void
  /** Returns iterable of all chats so the recovery scanner can
   * collect solo wakeups across every chat. */
  listChats: () => Iterable<ChatRecord>
  /** Programmatic run dispatch — same surface ensemble + bridge +
   * sub-thread paths all use. */
  dispatchRun: (payload: AgentRunPayload) => Promise<{ dispatched: boolean; appRunId: string }>
  /**
   * Stamp the continuation's permission posture so the
   * `normalizeAgentRunPayload` clamp trusts this main-built resumed
   * posture instead of downgrading it to read-only. Optional so the
   * unit-test harness can omit it. See src/main/RunPermissionPosture.ts.
   */
  signRunPermissionPosture?: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => string
  /** Wakeup timer scheduling. Pluggable so tests can inject a
   * fake timer. */
  scheduleWakeupTimer: (wakeup: SoloChatWakeupRecord) => void
  cancelWakeupTimer: (wakeupId: string) => void
  /** Random run id generator — matches the seam ensemble path uses. */
  createRunId: (provider: ProviderId) => string
  now: () => number
  nowIso: () => string
}

export interface ScheduleWakeupResult {
  ok: boolean
  error?: string
  wakeup?: SoloChatWakeupRecord
  message?: string
}

export interface CancelWakeupResult {
  ok: boolean
  error?: string
  cancelled?: SoloChatWakeupRecord[]
  message?: string
}

export type SoloWakeupHistoryClearScope =
  | { kind: 'chat'; chatIds: readonly string[] }
  | { kind: 'workspace'; workspaceId: string; chatIds: readonly string[] }
  | { kind: 'global' }

declare const soloWakeupHistoryHoldBrand: unique symbol

/**
 * Opaque process-local hold raised by a destructive history transaction.
 * `completion` joins the exact fire callbacks that were already in flight when
 * the fence was raised. The caller must retain the hold through store commit.
 */
export type SoloWakeupHistoryHold = Readonly<{
  completion: Promise<void>
  [soloWakeupHistoryHoldBrand]: true
}>

interface ActiveSoloWakeupHistoryHold {
  kind: SoloWakeupHistoryClearScope['kind']
  workspaceId?: string
  chatIds: string[]
}

interface SoloWakeupHistoryAuthority {
  globalGeneration: number
  workspaceId?: string
  workspaceGeneration: number
  chatId: string
  chatGeneration: number
}

function normalizedHistoryScopeValue(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function sameWakeupIncarnation(
  current: SoloChatWakeupRecord | undefined,
  expected: SoloChatWakeupRecord
): current is SoloChatWakeupRecord {
  if (!current) return false
  return (
    current.wakeupId === expected.wakeupId &&
    current.chatId === expected.chatId &&
    current.provider === expected.provider &&
    current.runId === expected.runId &&
    current.scheduledAt === expected.scheduledAt &&
    current.wakeAt === expected.wakeAt &&
    current.status === expected.status &&
    current.reason === expected.reason &&
    current.cancelOnUserInput === expected.cancelOnUserInput &&
    JSON.stringify(current.resumePermissions ?? null) ===
      JSON.stringify(expected.resumePermissions ?? null) &&
    current.firedAt === expected.firedAt &&
    current.cancelledAt === expected.cancelledAt &&
    current.expiredAt === expected.expiredAt
  )
}

export class SoloChatWakeupService {
  private globalHistoryHolds = 0
  private globalHistoryGeneration = 0
  private readonly workspaceHistoryHolds = new Map<string, number>()
  private readonly workspaceHistoryGenerations = new Map<string, number>()
  private readonly chatHistoryHolds = new Map<string, number>()
  private readonly chatHistoryGenerations = new Map<string, number>()
  private readonly activeHistoryHolds = new Map<
    SoloWakeupHistoryHold,
    ActiveSoloWakeupHistoryHold
  >()
  private readonly fireActivitiesByChat = new Map<string, Set<Promise<boolean>>>()

  constructor(private deps: SoloChatWakeupServiceDeps) {}

  /**
   * Raise a history-specific wakeup admission fence synchronously, cancel every
   * still-armed timer in the frozen scope, and return an exact join for fire
   * callbacks that entered before the fence. Persisted records are deliberately
   * left for the outer delete/truncate commit: once durable prepare exists,
   * ordinary `saveChat` is correctly fail-closed.
   */
  beginHistoryClear(scope: SoloWakeupHistoryClearScope): SoloWakeupHistoryHold {
    const chatIds =
      scope.kind === 'global'
        ? [...new Set([...this.deps.listChats()].map((chat) => chat.appChatId).filter(Boolean))]
        : [...new Set(scope.chatIds.map((chatId) => chatId.trim()).filter(Boolean))]
    const workspaceId =
      scope.kind === 'workspace' ? normalizedHistoryScopeValue(scope.workspaceId) : undefined
    if (scope.kind === 'workspace' && !workspaceId) {
      throw new Error('Solo wakeup workspace history clear requires an exact workspace id.')
    }

    // Generations advance before timer cancellation or any promise creation.
    // A callback already queued in the microtask queue therefore cannot publish
    // even when `clearTimeout` can no longer remove its wall-clock callback.
    if (scope.kind === 'global') {
      this.globalHistoryGeneration += 1
      this.globalHistoryHolds += 1
    } else {
      if (workspaceId) {
        this.workspaceHistoryGenerations.set(
          workspaceId,
          (this.workspaceHistoryGenerations.get(workspaceId) ?? 0) + 1
        )
        this.workspaceHistoryHolds.set(
          workspaceId,
          (this.workspaceHistoryHolds.get(workspaceId) ?? 0) + 1
        )
      }
      for (const chatId of chatIds) {
        this.chatHistoryGenerations.set(chatId, (this.chatHistoryGenerations.get(chatId) ?? 0) + 1)
        this.chatHistoryHolds.set(chatId, (this.chatHistoryHolds.get(chatId) ?? 0) + 1)
      }
    }

    const synchronousErrors: unknown[] = []
    for (const chatId of chatIds) {
      const chat = this.deps.getChat(chatId)
      for (const wakeup of Object.values(chat?.soloWakeups || {})) {
        if (wakeup.status !== 'pending') continue
        try {
          this.deps.cancelWakeupTimer(wakeup.wakeupId)
        } catch (error) {
          synchronousErrors.push(error)
        }
      }
    }

    const activities = chatIds.flatMap((chatId) => [
      ...(this.fireActivitiesByChat.get(chatId) || [])
    ])
    const completion = Promise.allSettled(activities).then((results) => {
      const callbackErrors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      const errors = [...synchronousErrors, ...callbackErrors]
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'Solo wakeup history clear could not cancel and join every callback.'
        )
      }
    })
    const hold = Object.freeze({ completion }) as SoloWakeupHistoryHold
    this.activeHistoryHolds.set(hold, {
      kind: scope.kind,
      ...(workspaceId ? { workspaceId } : {}),
      chatIds
    })
    return hold
  }

  /** Release one exact history hold after the outer store commit. */
  endHistoryClear(hold: SoloWakeupHistoryHold): boolean {
    const active = this.activeHistoryHolds.get(hold)
    if (!active) return false
    this.activeHistoryHolds.delete(hold)
    if (active.kind === 'global') {
      this.globalHistoryHolds = Math.max(0, this.globalHistoryHolds - 1)
      return true
    }
    if (active.workspaceId) {
      const count = this.workspaceHistoryHolds.get(active.workspaceId) ?? 0
      if (count <= 1) this.workspaceHistoryHolds.delete(active.workspaceId)
      else this.workspaceHistoryHolds.set(active.workspaceId, count - 1)
    }
    for (const chatId of active.chatIds) {
      const count = this.chatHistoryHolds.get(chatId) ?? 0
      if (count <= 1) this.chatHistoryHolds.delete(chatId)
      else this.chatHistoryHolds.set(chatId, count - 1)
    }
    return true
  }

  /**
   * Schedule a wakeup against a solo chat. Mirrors the ensemble
   * path's `scheduleWakeupForRun` but without participant/round
   * constraints.
   *
   * Rejects when:
   *   - chat is unknown / not solo (ensemble path owns those)
   *   - request is malformed (no wakeAt/delayMs/delaySeconds)
   *   - requested delay > 7 days
   *   - chat already has a pending wakeup (one at a time)
   */
  scheduleWakeup(
    chatId: string,
    provider: ProviderId,
    runId: string | undefined,
    input: ScheduleWakeupInput,
    runContext?: SoloWakeupRunContext
  ): ScheduleWakeupResult {
    if (!chatId) return { ok: false, error: 'schedule_wakeup requires an active chat id.' }
    const chat = this.deps.getChat(chatId)
    if (!chat) return { ok: false, error: 'No chat matches this wakeup request.' }
    if (this.isHistoryBlocked(chat)) {
      return {
        ok: false,
        error: 'Chat history is being cleared; new wakeups are temporarily blocked.'
      }
    }
    if (chat.chatKind === 'ensemble') {
      return {
        ok: false,
        error: 'Ensemble chats schedule wakeups via the ensemble round path.'
      }
    }
    const existing = this.findPendingWakeupForChat(chat)
    if (existing) {
      return {
        ok: false,
        error: `Chat already has a pending wakeup (${existing.wakeupId}). Cancel it first.`
      }
    }
    const nowMs = this.deps.now()
    const wakeAtMs = resolveSoloWakeAtMs(input, nowMs)
    if (!Number.isFinite(wakeAtMs)) {
      return {
        ok: false,
        error: 'schedule_wakeup requires wakeAt, delayMs, or delaySeconds.'
      }
    }
    const requestedDelayMs = wakeAtMs - nowMs
    if (requestedDelayMs > SOLO_MAX_WAKEUP_DELAY_MS) {
      const requestedDays = Math.round(requestedDelayMs / (24 * 60 * 60 * 1000))
      return {
        ok: false,
        error: `schedule_wakeup max delay is 7 days; requested ~${requestedDays} days. Schedule sequential wakeups (one now, another on resume) for longer horizons.`
      }
    }
    const nowIso = this.deps.nowIso()
    const resumePermissions = buildResumePermissionSnapshot(runContext)
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: `solo-wakeup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatId,
      provider,
      runId,
      scheduledAt: nowIso,
      wakeAt: new Date(wakeAtMs).toISOString(),
      status: 'pending',
      reason: input.reason,
      cancelOnUserInput: input.cancelOnUserInput !== false,
      ...(resumePermissions ? { resumePermissions } : {})
    }
    this.persistWakeup(chat, wakeup)
    this.deps.scheduleWakeupTimer(wakeup)
    const message = `Chat will resume at ${wakeup.wakeAt}.`
    return { ok: true, wakeup, message }
  }

  /**
   * Cancel pending wakeup(s) for a chat. If `wakeupId` is provided,
   * cancels exactly that one; otherwise cancels every pending
   * wakeup the chat owns.
   */
  cancelWakeup(chatId: string, wakeupId?: string): CancelWakeupResult {
    if (!chatId) return { ok: false, error: 'cancel_wakeup requires an active chat id.' }
    const chat = this.deps.getChat(chatId)
    if (!chat) return { ok: false, error: 'No chat matches this wakeup cancellation.' }
    const wakeups = Object.values(chat.soloWakeups || {}).filter((wakeup) => {
      if (wakeup.status !== 'pending') return false
      return wakeupId ? wakeup.wakeupId === wakeupId : true
    })
    if (wakeupId && wakeups.length === 0) {
      return { ok: false, error: 'No matching pending wakeup belongs to this chat.' }
    }
    if (wakeups.length === 0) {
      return { ok: true, cancelled: [], message: 'No pending wakeups to cancel.' }
    }
    const cancelled = wakeups.map((wakeup) =>
      this.markCancelled(chat, wakeup, 'cancelled by user or agent')
    )
    for (const wakeup of cancelled) this.deps.cancelWakeupTimer(wakeup.wakeupId)
    return {
      ok: true,
      cancelled,
      message: `Cancelled ${cancelled.length} wakeup${cancelled.length === 1 ? '' : 's'}.`
    }
  }

  /**
   * Cancel pending solo wakeups that opted into cancel-on-user-input
   * (default true). Mirrors ensemble `cancelWakeupsOnUserInput` /
   * `cancelPersistedWakeupsOnUserInput`. Ensemble chats are ignored —
   * the ensemble path owns those wakeups.
   *
   * Call from the solo user-send / dispatch path; do not call for
   * main-built wakeup resumes (see `isSoloWakeupResumePrompt`).
   */
  cancelWakeupsOnUserInput(chatId: string): SoloChatWakeupRecord[] {
    if (!chatId) return []
    const chat = this.deps.getChat(chatId)
    if (!chat || chat.chatKind === 'ensemble') return []
    const wakeups = Object.values(chat.soloWakeups || {}).filter(
      (wakeup) => wakeup.status === 'pending' && wakeup.cancelOnUserInput !== false
    )
    if (wakeups.length === 0) return []
    const cancelled = wakeups.map((wakeup) =>
      this.markCancelled(chat, wakeup, 'cancelled by user input')
    )
    for (const wakeup of cancelled) this.deps.cancelWakeupTimer(wakeup.wakeupId)
    return cancelled
  }

  /**
   * Timer fired for a solo wakeup. Looks up the record, marks it
   * `'fired'`, and dispatches a continuation run on the chat.
   *
   * Returns `true` if a record was found + handled (so the central
   * `handleAnyWakeupTimerFired` can return early); `false` lets the
   * caller fall back to the ensemble path or expire-as-orphan.
   */
  handleWakeupFired(wakeupId: string): Promise<boolean> {
    const located = this.findRecordByWakeupId(wakeupId)
    if (!located) return Promise.resolve(false)
    const { chat, wakeup } = located
    if (wakeup.status !== 'pending') return Promise.resolve(false)
    if (this.isHistoryBlocked(chat)) return Promise.resolve(true)
    const authority = this.captureHistoryAuthority(chat)
    // Defer the body by one microtask so the activity is registered before its
    // first persistence/dispatch side effect. A same-stack deletion can now
    // synchronously fence and join this exact promise.
    const activity = Promise.resolve().then(() =>
      this.handleWakeupFiredWithAuthority(wakeup, authority)
    )
    const active = this.fireActivitiesByChat.get(chat.appChatId) ?? new Set<Promise<boolean>>()
    active.add(activity)
    this.fireActivitiesByChat.set(chat.appChatId, active)
    void activity
      .finally(() => {
        active.delete(activity)
        if (active.size === 0) this.fireActivitiesByChat.delete(chat.appChatId)
      })
      .catch(() => {})
    return activity
  }

  private async handleWakeupFiredWithAuthority(
    wakeup: SoloChatWakeupRecord,
    authority: SoloWakeupHistoryAuthority
  ): Promise<boolean> {
    const currentBeforeFire = this.currentWakeupForAuthority(wakeup, authority)
    if (!currentBeforeFire) return true
    const nowIso = this.deps.nowIso()
    const fired: SoloChatWakeupRecord = {
      ...currentBeforeFire.wakeup,
      status: 'fired',
      firedAt: nowIso
    }
    this.persistWakeup(currentBeforeFire.chat, fired)
    // Refresh from the store and validate both the history generation and the
    // exact fired-record incarnation. Never retain the pre-save ChatRecord as a
    // fallback: delete/truncate is allowed to make the chat disappear.
    const refreshed = this.currentWakeupForAuthority(fired, authority)
    if (!refreshed) return true
    const appRunId = this.deps.createRunId(wakeup.provider)
    const payload = buildSoloWakeupResumePayload(refreshed.chat, refreshed.wakeup, appRunId, nowIso)
    // Stamp the resumed posture so the normalize-time clamp trusts this
    // main-built continuation rather than downgrading it to read-only.
    if (this.deps.signRunPermissionPosture) {
      payload.effectivePermissionsSignature = this.deps.signRunPermissionPosture(
        payload.approvalMode,
        payload.effectivePermissions,
        {
          provider: payload.provider,
          scope: payload.scope,
          appRunId: payload.appRunId,
          appChatId: payload.appChatId,
          prompt: payload.prompt,
          workflowMode: payload.workflowMode === 'plan' ? 'plan' : 'normal',
          runtimeProfileId: payload.runtimeProfileId
        }
      )
    }
    try {
      if (!this.currentWakeupForAuthority(fired, authority)) return true
      const dispatched = await this.deps.dispatchRun(payload)
      if (!dispatched.dispatched) {
        this.expireFiredWakeupAfterDispatchFailure(
          fired,
          authority,
          new Error('Run coordinator declined the resumed wakeup dispatch.')
        )
      }
    } catch (error) {
      this.expireFiredWakeupAfterDispatchFailure(fired, authority, error)
    }
    return true
  }

  /**
   * Both a rejected dispatch promise and a resolved `{ dispatched: false }`
   * represent a non-started continuation. Re-fetch the exact current record so
   * this diagnostic state can never overwrite a concurrent cancel or a
   * delete/truncate commit.
   */
  private expireFiredWakeupAfterDispatchFailure(
    fired: SoloChatWakeupRecord,
    authority: SoloWakeupHistoryAuthority,
    error: unknown
  ): void {
    const currentAfterFailure = this.currentWakeupForAuthority(fired, authority)
    if (currentAfterFailure) {
      const expired: SoloChatWakeupRecord = {
        ...currentAfterFailure.wakeup,
        status: 'expired',
        expiredAt: this.deps.nowIso()
      }
      this.persistWakeup(currentAfterFailure.chat, expired)
    }
    console.warn(
      `Solo wakeup ${fired.wakeupId} dispatch failed; record expired:`,
      error instanceof Error ? error.message : error
    )
  }

  /**
   * Collect every pending solo wakeup across all chats. Used by
   * boot-time recovery + ad-hoc lookups.
   */
  getAllPersistedWakeups(): SoloChatWakeupRecord[] {
    const out: SoloChatWakeupRecord[] = []
    for (const chat of this.deps.listChats()) {
      if (chat.chatKind === 'ensemble') continue
      const records = chat.soloWakeups
      if (!records) continue
      for (const record of Object.values(records)) {
        if (record.status === 'pending') out.push(record)
      }
    }
    return out
  }

  /**
   * Mark a wakeup expired (used by boot-time recovery for records
   * past the grace window). Exported so the central recovery code
   * in `index.ts` can iterate over classifier output.
   */
  expireWakeup(wakeup: SoloChatWakeupRecord, expiredAt: string, reasonNote?: string): void {
    const chat = this.deps.getChat(wakeup.chatId)
    if (!chat) return
    const expired: SoloChatWakeupRecord = {
      ...wakeup,
      status: 'expired',
      expiredAt
    }
    this.persistWakeup(chat, expired)
    if (reasonNote) {
      console.warn(`Solo wakeup ${wakeup.wakeupId} expired: ${reasonNote}`)
    }
  }

  private findPendingWakeupForChat(chat: ChatRecord): SoloChatWakeupRecord | undefined {
    const records = chat.soloWakeups
    if (!records) return undefined
    for (const wakeup of Object.values(records)) {
      if (wakeup.status === 'pending') return wakeup
    }
    return undefined
  }

  private isHistoryBlocked(chat: ChatRecord): boolean {
    if (this.globalHistoryHolds > 0) return true
    if ((this.chatHistoryHolds.get(chat.appChatId) ?? 0) > 0) return true
    const workspaceId = normalizedHistoryScopeValue(chat.workspaceId)
    return Boolean(workspaceId && (this.workspaceHistoryHolds.get(workspaceId) ?? 0) > 0)
  }

  private captureHistoryAuthority(chat: ChatRecord): SoloWakeupHistoryAuthority {
    const workspaceId = normalizedHistoryScopeValue(chat.workspaceId)
    return {
      globalGeneration: this.globalHistoryGeneration,
      ...(workspaceId ? { workspaceId } : {}),
      workspaceGeneration: workspaceId
        ? (this.workspaceHistoryGenerations.get(workspaceId) ?? 0)
        : 0,
      chatId: chat.appChatId,
      chatGeneration: this.chatHistoryGenerations.get(chat.appChatId) ?? 0
    }
  }

  private currentWakeupForAuthority(
    expected: SoloChatWakeupRecord,
    authority: SoloWakeupHistoryAuthority
  ): { chat: ChatRecord; wakeup: SoloChatWakeupRecord } | null {
    const chat = this.deps.getChat(authority.chatId)
    if (!chat || this.isHistoryBlocked(chat)) return null
    const workspaceId = normalizedHistoryScopeValue(chat.workspaceId)
    const workspaceGeneration = workspaceId
      ? (this.workspaceHistoryGenerations.get(workspaceId) ?? 0)
      : 0
    if (
      this.globalHistoryGeneration !== authority.globalGeneration ||
      workspaceId !== authority.workspaceId ||
      workspaceGeneration !== authority.workspaceGeneration ||
      (this.chatHistoryGenerations.get(authority.chatId) ?? 0) !== authority.chatGeneration
    ) {
      return null
    }
    const wakeup = chat.soloWakeups?.[expected.wakeupId]
    return sameWakeupIncarnation(wakeup, expected) ? { chat, wakeup } : null
  }

  private findRecordByWakeupId(
    wakeupId: string
  ): { chat: ChatRecord; wakeup: SoloChatWakeupRecord } | null {
    for (const chat of this.deps.listChats()) {
      if (chat.chatKind === 'ensemble') continue
      const record = chat.soloWakeups?.[wakeupId]
      if (record) return { chat, wakeup: record }
    }
    return null
  }

  private persistWakeup(chat: ChatRecord, wakeup: SoloChatWakeupRecord): void {
    const next: ChatRecord = {
      ...chat,
      soloWakeups: {
        ...(chat.soloWakeups || {}),
        [wakeup.wakeupId]: wakeup
      },
      updatedAt: Date.now()
    }
    this.deps.saveChat(next)
  }

  private markCancelled(
    chat: ChatRecord,
    wakeup: SoloChatWakeupRecord,
    _reason?: string
  ): SoloChatWakeupRecord {
    const cancelled: SoloChatWakeupRecord = {
      ...wakeup,
      status: 'cancelled',
      cancelledAt: this.deps.nowIso()
    }
    this.persistWakeup(chat, cancelled)
    return cancelled
  }
}
