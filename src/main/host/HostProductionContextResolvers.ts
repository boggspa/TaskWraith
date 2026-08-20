/**
 * Production Host command context resolution.
 *
 * Host commands carry stable target ids and bounded user arguments. Bridge
 * mutations also need canonical workspace, provider, run, roster, approval,
 * and question context that an untrusted client must never nominate. This
 * adapter re-reads those values from injected main-owned sources immediately
 * before execution and fails closed when the source is missing or ambiguous.
 *
 * The module deliberately imports no AppStore, Electron, ApprovalService, or
 * RemoteQuestionRegistry values. The composition root supplies three narrow
 * live-read callbacks; HostProductionBootstrap owns construction of this
 * resolver so index.ts remains wiring-only.
 */

import type { BridgeRosterParticipant } from '../BridgeActionPayload'
import type { HostDecodeResult } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_MAX_ID } from '../../shared/hostProtocol'
import type { TaskWraithControlThreadOffers } from '../../shared/taskWraithControlProtocol'
import {
  resolveTaskWraithThreadOffers,
  validateTaskWraithThreadSelection,
  type TaskWraithThreadSelection
} from '../control/TaskWraithThreadOffers'
import type {
  HostBridgeApprovalContext,
  HostBridgeComposerSendContext,
  HostBridgeContextResolvers,
  HostBridgeEnsembleSeatContext,
  HostBridgeQuestionContext,
  HostBridgeRunCancelContext,
  HostBridgeThreadSelectContext
} from './HostBridgeCommandExecutor'

export interface HostProductionResolverRun {
  readonly runId: string
  readonly provider?: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly requestedModel?: string
  readonly actualModel?: string
  readonly status?: string
  readonly cancelled?: boolean
}

export interface HostProductionResolverParticipant {
  readonly id: string
  readonly provider: string
  readonly enabled: boolean
  readonly order: number
}

export interface HostProductionResolverRound {
  readonly roundId: string
  readonly status?: string
}

export interface HostProductionResolverChat {
  readonly appChatId: string
  readonly scope?: string
  readonly workspaceId?: string | null
  readonly provider?: string | null
  readonly archived?: boolean
  readonly chatKind?: string
  readonly workflowMode?: 'normal' | 'plan'
  readonly requestedModel?: string | null
  readonly lastActualModel?: string | null
  readonly providerMetadata?: Readonly<Record<string, unknown>>
  readonly settingsSnapshot?: {
    readonly model?: string
    readonly approvalMode?: string
  }
  readonly runs?: readonly HostProductionResolverRun[]
  readonly ensemble?: {
    readonly enabled?: boolean
    readonly participants?: readonly HostProductionResolverParticipant[]
    readonly activeRound?: HostProductionResolverRound
  }
}

export interface HostProductionResolverApproval {
  /** Optional explicit canonical id; the lookup key remains authoritative. */
  readonly approvalId?: string
  /** Legacy Bridge alias. Must be byte-identical to the Host approval id. */
  readonly toolCallId: string
  readonly workspaceId?: string | null
  readonly threadId?: string
}

export interface HostProductionResolverQuestion {
  /** Optional explicit canonical id; the lookup key remains authoritative. */
  readonly questionId?: string
  /** Legacy Bridge alias. Must be byte-identical to the Host question id. */
  readonly promptId: string
  readonly workspaceId?: string | null
  readonly threadId?: string
  readonly runId?: string
}

export interface HostProductionContextResolverDeps {
  readonly getChat: (threadId: string) => HostProductionResolverChat | null | undefined
  readonly getApproval: (approvalId: string) => HostProductionResolverApproval | null | undefined
  readonly getQuestion: (questionId: string) => HostProductionResolverQuestion | null | undefined
}

type RequiredContext =
  | HostBridgeComposerSendContext
  | HostBridgeRunCancelContext
  | HostBridgeApprovalContext
  | HostBridgeQuestionContext
  | HostBridgeEnsembleSeatContext
  | HostBridgeThreadSelectContext
  | TaskWraithControlThreadOffers

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'success',
  'succeeded',
  'failed',
  'cancelled',
  'canceled'
])

function ok<T extends RequiredContext>(value: T): HostDecodeResult<T> {
  return { ok: true, value }
}

function fail<T extends RequiredContext>(error: string): HostDecodeResult<T> {
  return { ok: false, error }
}

function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

function usableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.length <= HOST_PROTOCOL_MAX_ID
  )
}

function latestRun(chat: HostProductionResolverChat): HostProductionResolverRun | undefined {
  return [...(chat.runs ?? [])].reverse().find((run) => usableId(run?.runId))
}

function activeRun(chat: HostProductionResolverChat): HostProductionResolverRun | undefined {
  return [...(chat.runs ?? [])].reverse().find((run) => {
    if (!usableId(run?.runId) || run.cancelled === true || nonEmptyString(run.endedAt)) return false
    const status = String(run.status ?? '')
      .trim()
      .toLowerCase()
    return !TERMINAL_RUN_STATUSES.has(status)
  })
}

function isEnsemble(chat: HostProductionResolverChat): boolean {
  return chat.chatKind === 'ensemble' || chat.ensemble?.enabled === true
}

function liveRound(chat: HostProductionResolverChat): HostProductionResolverRound | undefined {
  const round = chat.ensemble?.activeRound
  return round?.status === 'running' && usableId(round.roundId) ? round : undefined
}

function workspaceIdForChat(chat: HostProductionResolverChat): HostDecodeResult<string> {
  if (chat.scope === 'global') return { ok: true, value: 'global' }
  if (usableId(chat.workspaceId)) return { ok: true, value: chat.workspaceId }
  return { ok: false, error: `Thread ${chat.appChatId} has no canonical workspace id.` }
}

function workspaceIdForScopedRecord(
  workspaceId: string | null | undefined,
  threadId: string,
  getChat: HostProductionContextResolverDeps['getChat']
): HostDecodeResult<string> {
  if (usableId(workspaceId)) return { ok: true, value: workspaceId }
  const chat = getChat(threadId)
  if (!chat || chat.appChatId !== threadId) {
    return { ok: false, error: `Thread ${threadId} was not found for scope resolution.` }
  }
  return workspaceIdForChat(chat)
}

function modelForChat(chat: HostProductionResolverChat): string | undefined {
  const run = latestRun(chat)
  const metadata = chat.providerMetadata ?? {}
  return nonEmptyString(
    run?.actualModel,
    run?.requestedModel,
    metadata.customModel,
    metadata.selectedModelType,
    chat.requestedModel,
    chat.lastActualModel,
    chat.settingsSnapshot?.model
  )
}

function providerForChat(chat: HostProductionResolverChat): string | undefined {
  return nonEmptyString(latestRun(chat)?.provider, chat.provider)
}

function reasoningForProvider(
  provider: string,
  chat: HostProductionResolverChat
): string | undefined {
  const metadata = chat.providerMetadata ?? {}
  const providerKeys: Readonly<Record<string, readonly string[]>> = {
    codex: ['codexReasoningEffort', 'reasoningEffort'],
    claude: ['claudeReasoningEffort', 'reasoningEffort'],
    kimi: ['kimiReasoningEffort', 'reasoningEffort'],
    grok: ['grokReasoningEffort', 'reasoningEffort'],
    mistral: ['mistralReasoningEffort', 'reasoningEffort'],
    muse: ['museReasoningEffort', 'reasoningEffort'],
    ollama: ['ollamaReasoningEffort', 'reasoningEffort'],
    cursor: ['cursorReasoningEffort', 'reasoningEffort'],
    antigravity: ['geminiReasoningEffort', 'reasoningEffort'],
    gemini: ['geminiReasoningEffort', 'reasoningEffort']
  }
  return nonEmptyString(
    ...(providerKeys[provider] ?? ['reasoningEffort']).map((key) => metadata[key])
  )
}

function approvalModeForChat(chat: HostProductionResolverChat): string | undefined {
  return nonEmptyString(chat.providerMetadata?.approvalMode, chat.settingsSnapshot?.approvalMode)
}

function readChat(
  getChat: HostProductionContextResolverDeps['getChat'],
  threadId: string
): HostDecodeResult<HostProductionResolverChat> {
  const chat = getChat(threadId)
  if (!chat) return { ok: false, error: `Thread ${threadId} was not found.` }
  if (chat.appChatId !== threadId) {
    return { ok: false, error: `Thread ${threadId} resolved to a different canonical id.` }
  }
  return { ok: true, value: chat }
}

function rosterForToggle(
  chat: HostProductionResolverChat,
  participantId: string,
  enabled: boolean
): HostDecodeResult<readonly BridgeRosterParticipant[]> {
  const participants = chat.ensemble?.participants
  if (!isEnsemble(chat) || !Array.isArray(participants) || participants.length === 0) {
    return { ok: false, error: 'Thread is not an Ensemble chat.' }
  }

  const seen = new Set<string>()
  for (const participant of participants) {
    if (
      !usableId(participant?.id) ||
      !usableId(participant.provider) ||
      typeof participant.enabled !== 'boolean' ||
      !Number.isInteger(participant.order) ||
      participant.order < 0 ||
      seen.has(participant.id)
    ) {
      return { ok: false, error: 'Ensemble roster is missing canonical participant data.' }
    }
    seen.add(participant.id)
  }

  const target = participants.find((participant) => participant.id === participantId)
  if (!target) return { ok: false, error: 'That seat no longer exists.' }
  if (
    target.enabled === true &&
    enabled === false &&
    participants.filter((participant) => participant.enabled === true).length <= 1
  ) {
    return { ok: false, error: 'At least one participant must stay enabled.' }
  }

  return {
    ok: true,
    value: [...participants]
      .sort((left, right) => left.order - right.order)
      .map((participant) => ({
        id: participant.id,
        provider: participant.provider,
        enabled: participant.id === participantId ? enabled : participant.enabled
      }))
  }
}

/** Build the complete production resolver set over live main-owned sources. */
export function createHostProductionContextResolvers(
  deps: HostProductionContextResolverDeps
): HostBridgeContextResolvers {
  if (!deps || typeof deps !== 'object') {
    throw new Error('HostProductionContextResolvers requires dependencies')
  }
  if (typeof deps.getChat !== 'function') {
    throw new Error('HostProductionContextResolvers requires getChat')
  }
  if (typeof deps.getApproval !== 'function') {
    throw new Error('HostProductionContextResolvers requires getApproval')
  }
  if (typeof deps.getQuestion !== 'function') {
    throw new Error('HostProductionContextResolvers requires getQuestion')
  }

  const offersForChat = (
    threadId: string,
    chat: HostProductionResolverChat
  ): HostDecodeResult<TaskWraithControlThreadOffers> => {
    const provider = providerForChat(chat)
    if (!provider) return { ok: false, error: 'Thread has no canonical provider.' }
    const currentModel = modelForChat(chat)
    const currentReasoningEffort = reasoningForProvider(provider, chat)
    return ok(
      resolveTaskWraithThreadOffers({
        threadId,
        provider,
        ...(currentModel ? { currentModel } : {}),
        ...(currentReasoningEffort ? { currentReasoningEffort } : {}),
        ensemble: isEnsemble(chat),
        archived: chat.archived === true
      })
    )
  }

  return {
    async resolveThreadOffers(threadId: string) {
      const resolved = readChat(deps.getChat, threadId)
      if (!resolved.ok) return fail<TaskWraithControlThreadOffers>(resolved.error)
      return offersForChat(threadId, resolved.value)
    },

    async resolveComposerSend(threadId, selection?: TaskWraithThreadSelection) {
      const resolved = readChat(deps.getChat, threadId)
      if (!resolved.ok) return fail<HostBridgeComposerSendContext>(resolved.error)
      const chat = resolved.value
      if (chat.archived === true) {
        return fail<HostBridgeComposerSendContext>('Archived threads cannot start a new turn.')
      }
      const workspace = workspaceIdForChat(chat)
      if (!workspace.ok) return fail<HostBridgeComposerSendContext>(workspace.error)

      if (isEnsemble(chat)) {
        if (selection?.model || selection?.reasoningEffort) {
          const offers = offersForChat(threadId, chat)
          if (!offers.ok) return fail<HostBridgeComposerSendContext>(offers.error)
          const validated = validateTaskWraithThreadSelection(offers.value, selection)
          if (!validated.ok) return fail<HostBridgeComposerSendContext>(validated.error)
        }
        const round = liveRound(chat)
        return ok<HostBridgeComposerSendContext>({
          mode: 'ensemble',
          workspaceId: workspace.value,
          ...(round ? { roundId: round.roundId } : {})
        })
      }

      const provider = providerForChat(chat)
      if (!provider) {
        return fail<HostBridgeComposerSendContext>('Thread has no canonical provider.')
      }
      const approvalMode = approvalModeForChat(chat)
      const defaultModel = modelForChat(chat)
      const defaultReasoningEffort = reasoningForProvider(provider, chat)
      let selected: TaskWraithThreadSelection = {}
      if (selection?.model || selection?.reasoningEffort) {
        const offers = offersForChat(threadId, chat)
        if (!offers.ok) return fail<HostBridgeComposerSendContext>(offers.error)
        const validated = validateTaskWraithThreadSelection(offers.value, selection)
        if (!validated.ok) return fail<HostBridgeComposerSendContext>(validated.error)
        selected = validated.value
      }
      return ok<HostBridgeComposerSendContext>({
        mode: 'solo',
        workspaceId: workspace.value,
        provider,
        ...(approvalMode ? { approvalMode } : {}),
        ...(chat.workflowMode ? { workflowMode: chat.workflowMode } : {}),
        ...(selected.model
          ? { model: selected.model }
          : defaultModel
            ? { model: defaultModel }
            : {}),
        ...(selected.reasoningEffort
          ? { reasoningEffort: selected.reasoningEffort }
          : defaultReasoningEffort
            ? { reasoningEffort: defaultReasoningEffort }
            : {})
      })
    },

    async resolveRunCancel(threadId) {
      const resolved = readChat(deps.getChat, threadId)
      if (!resolved.ok) return fail<HostBridgeRunCancelContext>(resolved.error)
      const chat = resolved.value
      const workspace = workspaceIdForChat(chat)
      if (!workspace.ok) return fail<HostBridgeRunCancelContext>(workspace.error)

      const round = isEnsemble(chat) ? liveRound(chat) : undefined
      if (round) {
        return ok<HostBridgeRunCancelContext>({
          mode: 'ensemble',
          workspaceId: workspace.value,
          roundId: round.roundId
        })
      }

      const run = activeRun(chat)
      if (!run) {
        return ok<HostBridgeRunCancelContext>({
          mode: 'none',
          message: 'No active run to cancel.'
        })
      }
      const provider = nonEmptyString(run.provider, chat.provider)
      if (!provider)
        return fail<HostBridgeRunCancelContext>('Active run has no canonical provider.')
      return ok<HostBridgeRunCancelContext>({
        mode: 'solo',
        workspaceId: workspace.value,
        provider,
        runId: run.runId
      })
    },

    async resolveApprovalDecide(approvalId) {
      const approval = deps.getApproval(approvalId)
      if (!approval) {
        return fail<HostBridgeApprovalContext>(`Approval ${approvalId} was not found.`)
      }
      if (
        (approval.approvalId !== undefined && approval.approvalId !== approvalId) ||
        approval.toolCallId !== approvalId
      ) {
        return fail<HostBridgeApprovalContext>('Approval id alias does not match canonical bytes.')
      }
      if (!usableId(approval.threadId)) {
        return fail<HostBridgeApprovalContext>('Approval has no canonical thread id.')
      }
      const workspace = workspaceIdForScopedRecord(
        approval.workspaceId,
        approval.threadId,
        deps.getChat
      )
      if (!workspace.ok) return fail<HostBridgeApprovalContext>(workspace.error)
      return ok<HostBridgeApprovalContext>({
        workspaceId: workspace.value,
        threadId: approval.threadId,
        toolCallId: approval.toolCallId
      })
    },

    async resolveQuestionAnswer(questionId) {
      const question = deps.getQuestion(questionId)
      if (!question) {
        return fail<HostBridgeQuestionContext>(`Question ${questionId} was not found.`)
      }
      if (
        (question.questionId !== undefined && question.questionId !== questionId) ||
        question.promptId !== questionId
      ) {
        return fail<HostBridgeQuestionContext>('Question id alias does not match canonical bytes.')
      }
      if (!usableId(question.threadId)) {
        return fail<HostBridgeQuestionContext>('Question has no canonical thread id.')
      }
      const workspace = workspaceIdForScopedRecord(
        question.workspaceId,
        question.threadId,
        deps.getChat
      )
      if (!workspace.ok) return fail<HostBridgeQuestionContext>(workspace.error)
      return ok<HostBridgeQuestionContext>({
        workspaceId: workspace.value,
        threadId: question.threadId,
        promptId: question.promptId,
        ...(usableId(question.runId) ? { runId: question.runId } : {})
      })
    },

    async resolveEnsembleSeatToggle(threadId, participantId, enabled) {
      const resolved = readChat(deps.getChat, threadId)
      if (!resolved.ok) return fail<HostBridgeEnsembleSeatContext>(resolved.error)
      const workspace = workspaceIdForChat(resolved.value)
      if (!workspace.ok) return fail<HostBridgeEnsembleSeatContext>(workspace.error)
      const roster = rosterForToggle(resolved.value, participantId, enabled)
      if (!roster.ok) return fail<HostBridgeEnsembleSeatContext>(roster.error)
      return ok<HostBridgeEnsembleSeatContext>({
        workspaceId: workspace.value,
        participants: roster.value
      })
    },

    async resolveThreadSelect(threadId) {
      const resolved = readChat(deps.getChat, threadId)
      if (!resolved.ok) return fail<HostBridgeThreadSelectContext>(resolved.error)
      return ok<HostBridgeThreadSelectContext>({ appChatId: resolved.value.appChatId })
    }
  }
}
