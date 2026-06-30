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

function cloneExternalPathGrants(grants: ExternalPathGrant[] | undefined): ExternalPathGrant[] | undefined {
  if (!Array.isArray(grants)) return undefined
  return grants.map((grant) => ({ ...grant }))
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
  const externalPathGrants = cloneExternalPathGrants(runContext.externalPathGrants)
  if (externalPathGrants?.length) snapshot.externalPathGrants = externalPathGrants
  const effectivePermissions = cloneEffectiveRunPermissions(runContext.effectivePermissions)
  if (effectivePermissions) snapshot.effectivePermissions = effectivePermissions
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
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
      ? { effectivePermissions: cloneEffectiveRunPermissions(resumePermissions.effectivePermissions) }
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

export class SoloChatWakeupService {
  constructor(private deps: SoloChatWakeupServiceDeps) {}

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
   * Timer fired for a solo wakeup. Looks up the record, marks it
   * `'fired'`, and dispatches a continuation run on the chat.
   *
   * Returns `true` if a record was found + handled (so the central
   * `handleAnyWakeupTimerFired` can return early); `false` lets the
   * caller fall back to the ensemble path or expire-as-orphan.
   */
  async handleWakeupFired(wakeupId: string): Promise<boolean> {
    const located = this.findRecordByWakeupId(wakeupId)
    if (!located) return false
    const { chat, wakeup } = located
    if (wakeup.status !== 'pending') return false
    const nowIso = this.deps.nowIso()
    const fired: SoloChatWakeupRecord = {
      ...wakeup,
      status: 'fired',
      firedAt: nowIso
    }
    this.persistWakeup(chat, fired)
    // Refresh the chat from store (saveChat may have replaced it).
    const refreshed: ChatRecord = this.deps.getChat(chat.appChatId) ?? chat
    const appRunId = this.deps.createRunId(wakeup.provider)
    const payload = buildSoloWakeupResumePayload(refreshed, fired, appRunId, nowIso)
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
      await this.deps.dispatchRun(payload)
    } catch (error) {
      // Best-effort. If dispatch fails (e.g. preflight rejection,
      // adapter unavailable, network) we expire the record so the
      // user can see what happened in the next surface refresh.
      const expired: SoloChatWakeupRecord = {
        ...fired,
        status: 'expired',
        expiredAt: this.deps.nowIso()
      }
      this.persistWakeup(refreshed, expired)
      console.warn(
        `Solo wakeup ${wakeupId} dispatch failed; record expired:`,
        error instanceof Error ? error.message : error
      )
    }
    return true
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
