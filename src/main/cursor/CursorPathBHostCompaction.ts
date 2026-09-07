import { randomUUID } from 'node:crypto'

import type { ContextCompactionSignal } from '../../shared/contextCompaction'
import type { ChatRecord, EnsembleParticipant } from '../store/types'
import {
  buildCursorPathBCompactionSummary,
  type CursorPathBCompactionSummary
} from '../services/CursorContextPressureRecovery'

export interface CursorPathBHostCompactionPlanInput {
  readonly chat: ChatRecord
  readonly participantId?: string
  readonly roundPrompt: string
  readonly nowIso: string
  readonly preTokens?: number
  readonly eventUuid: string
  readonly trigger?: 'auto' | 'manual'
}

export type CursorPathBHostCompactionPlan =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true
      readonly summary: CursorPathBCompactionSummary
      readonly signal: ContextCompactionSignal
      readonly nextChat: ChatRecord
    }

export interface CursorPathBHostCompactionRuntimeDeps {
  getChat(chatId: string): ChatRecord | undefined
  saveChat(chat: ChatRecord): void
  now(): number
  nowIso(): string
  appendCard(signal: ContextCompactionSignal, extraMetadata?: Record<string, unknown>): void
  broadcastProgress(status: 'started' | 'completed' | 'failed'): void
  seatPreTokens(chat: ChatRecord, participantId: string): number | undefined
}

/**
 * Path-B has no compact RPC and no resume token. Host compaction is extractive:
 * persist a bounded transcript summary and drop the linked session so the next
 * turn is a fresh contained spawn. Native-only fallback is unchanged.
 */
export function planCursorPathBHostCompaction(
  input: CursorPathBHostCompactionPlanInput
): CursorPathBHostCompactionPlan {
  const trigger = input.trigger ?? 'manual'
  if (input.participantId) {
    if (!input.chat.ensemble) {
      return { ok: false, error: 'Participant compaction requires an ensemble chat.' }
    }
    const seat = (input.chat.ensemble.participants || []).find(
      (candidate) => candidate.id === input.participantId
    )
    if (!seat) return { ok: false, error: 'Participant not found on this ensemble.' }
    if (seat.provider !== 'cursor') {
      return { ok: false, error: 'Participant provider does not match the request.' }
    }
    const summary = buildSummary(input)
    const participants = (input.chat.ensemble.participants || []).map((participant) =>
      participant.id === seat.id ? resetCursorSeat(participant, summary) : participant
    )
    return success(input, summary, trigger, {
      ...input.chat,
      ensemble: { ...input.chat.ensemble, participants },
      updatedAt: Date.parse(input.nowIso) || input.chat.updatedAt
    })
  }

  if (input.chat.provider !== 'cursor') {
    return { ok: false, error: 'Solo Cursor compaction requires a Cursor chat.' }
  }
  const summary = buildSummary(input)
  const { linkedProviderSessionId: _dropSession, ...rest } = input.chat
  return success(input, summary, trigger, {
    ...rest,
    contextCompactionSummary: toStoredSummary(summary),
    updatedAt: Date.parse(input.nowIso) || input.chat.updatedAt
  })
}

export function compactCursorPathBHostContext(
  payload: {
    chatId: string
    participantId?: string
    trigger?: 'auto' | 'manual'
    cardMetadata?: Record<string, unknown>
    reservationCanWrite: () => boolean
  },
  deps: CursorPathBHostCompactionRuntimeDeps
): { ok: boolean; error?: string } {
  if (!payload.reservationCanWrite()) {
    return { ok: false, error: 'Compaction was cancelled for history deletion.' }
  }
  const chat = deps.getChat(payload.chatId)
  if (!chat) return { ok: false, error: 'Chat not found.' }
  const roundPrompt = latestUserPrompt(chat) || payload.chatId
  const preTokens = payload.participantId
    ? deps.seatPreTokens(chat, payload.participantId)
    : undefined
  deps.broadcastProgress('started')
  const plan = planCursorPathBHostCompaction({
    chat,
    ...(payload.participantId ? { participantId: payload.participantId } : {}),
    roundPrompt,
    nowIso: deps.nowIso(),
    ...(typeof preTokens === 'number' ? { preTokens } : {}),
    eventUuid: `cursor-pathb-host-${payload.chatId}-${payload.participantId || 'solo'}-${randomUUID()}`,
    trigger: payload.trigger ?? 'manual'
  })
  if (!plan.ok) {
    deps.broadcastProgress('failed')
    return plan
  }
  if (!payload.reservationCanWrite()) {
    return { ok: false, error: 'Compaction was cancelled for history deletion.' }
  }
  const nextChat = { ...plan.nextChat, updatedAt: deps.now() }
  deps.saveChat(nextChat)
  deps.appendCard(plan.signal, payload.cardMetadata)
  deps.broadcastProgress('completed')
  return { ok: true }
}

function buildSummary(input: CursorPathBHostCompactionPlanInput): CursorPathBCompactionSummary {
  return (
    buildCursorPathBCompactionSummary({
      messages: input.chat.messages || [],
      roundPrompt: input.roundPrompt,
      nowIso: input.nowIso,
      ...(typeof input.preTokens === 'number' ? { preTokens: input.preTokens } : {})
    }) || {
      text: 'Host recovered a Cursor Path-B seat at full context.',
      createdAt: input.nowIso,
      provider: 'cursor',
      provenance: {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: [],
        carriedForwardMessageIds: []
      }
    }
  )
}

function resetCursorSeat(
  seat: EnsembleParticipant,
  summary: CursorPathBCompactionSummary
): EnsembleParticipant {
  const next: EnsembleParticipant = {
    ...seat,
    contextCompactionSummary: toStoredSummary(summary),
    linkedProviderSessionId: null,
    promptShellVersion: undefined,
    promptDynamicStateVersion: undefined
  }
  return next
}

function toStoredSummary(
  summary: CursorPathBCompactionSummary
): NonNullable<EnsembleParticipant['contextCompactionSummary']> {
  return {
    text: summary.text,
    createdAt: summary.createdAt,
    provider: summary.provider,
    ...(summary.preTokens !== undefined ? { preTokens: summary.preTokens } : {}),
    provenance: summary.provenance
  }
}

function success(
  input: CursorPathBHostCompactionPlanInput,
  summary: CursorPathBCompactionSummary,
  trigger: 'auto' | 'manual',
  nextChat: ChatRecord
): Extract<CursorPathBHostCompactionPlan, { ok: true }> {
  return {
    ok: true,
    summary,
    nextChat,
    signal: {
      kind: 'completed',
      telemetry: {
        provider: 'cursor',
        trigger,
        ...(typeof input.preTokens === 'number' ? { preTokens: input.preTokens } : {}),
        eventUuid: input.eventUuid
      }
    }
  }
}

function latestUserPrompt(chat: ChatRecord): string {
  const rows = [...(chat.messages || [])].reverse()
  const user = rows.find((row) => row.role === 'user' && String(row.content || '').trim())
  return String(user?.content || '').trim()
}
