/**
 * Host Arc Track3 Mixed Wave A — dual-read join for Desktop pending questions.
 *
 * PURE LOGIC ONLY. Same split as usePendingApprovalsProjection: every decision
 * worth testing lives here; React wiring stays a thin consumer (Wave B Sidebar).
 * This repo has no jsdom renderer environment, so hook behaviour would be
 * untestable.
 *
 * THE DUAL-READ CONTRACT (mirrors Cap dispatch host-arc-5c-phase2-dispatch):
 * - Host not live / not freshness-live → the renderer pending map renders
 *   VERBATIM (today's behaviour; fail-closed honesty).
 * - Host live + open question cards → Host open membership is authority for
 *   which renderer rows still show; the JOIN is by questionId, the key both
 *   sides share after main-side question shadow registration.
 * - Host live with ZERO open cards → renderer list verbatim. Host-empty
 *   membership can never be told apart from "questions never wired", so rows
 *   are never dropped on an empty Host set.
 * - Host-only cards (no renderer join hit) are OMITTED — the renderer cannot
 *   resolve a question without local fields (messageId, options, …), and
 *   fabricating them from wire preview is forbidden.
 */

import type { AgentQuestionState } from '../components/AgentQuestionCard'
import type { HostProjectedQuestion } from '../lib/host/hostSnapshotProjection'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'

/**
 * Minimal identity for the Host↔renderer join key.
 *
 * AgentQuestionState uses `questionId`; accept `id` as an alias so a future
 * narrower view-model still joins without inventing a second key.
 */
export interface PendingQuestionIdentity {
  readonly questionId?: string
  readonly id?: string
}

export interface PendingQuestionListEntry {
  readonly chatId: string
  readonly question: AgentQuestionState
}

function flattenRendererPending(
  byChatId: Record<string, readonly AgentQuestionState[] | undefined>
): PendingQuestionListEntry[] {
  const out: PendingQuestionListEntry[] = []
  for (const [chatId, queue] of Object.entries(byChatId)) {
    if (!queue) continue
    for (const question of queue) out.push({ chatId, question })
  }
  return out
}

function rendererQuestionJoinId(question: PendingQuestionIdentity): string | undefined {
  if (typeof question.questionId === 'string' && question.questionId.length > 0) {
    return question.questionId
  }
  if (typeof question.id === 'string' && question.id.length > 0) {
    return question.id
  }
  return undefined
}

function isOpenQuestionCard(card: HostProjectedQuestion): boolean {
  return card.status === 'open'
}

/**
 * Dual-read join of Host projection state with the renderer pending-question map.
 *
 * Returns the list Desktop should render for the Approvals popover / corner
 * pill question rows. Pure: no DOM, no store reads.
 */
export function joinHostPendingQuestions(
  hostState: HostProjectionState,
  byChatId: Record<string, readonly AgentQuestionState[] | undefined>
): PendingQuestionListEntry[] {
  const rendererList = flattenRendererPending(byChatId)

  // Host not live → renderer list verbatim (fail-closed fallback).
  if (hostState.status !== 'live') {
    return rendererList
  }

  const projection = hostState.projection
  // Cached is not live — even under status:'live', only freshness:'live' is
  // authority. Without a projection there is nothing to join on.
  if (!projection || projection.freshness !== 'live') {
    return rendererList
  }

  const openQuestionIds = new Set<string>()
  for (const card of projection.questions) {
    if (isOpenQuestionCard(card)) {
      openQuestionIds.add(card.questionId)
    }
  }

  // Zero open cards → never drop renderer rows.
  // Empty Host membership cannot be distinguished from "questions never wired".
  if (openQuestionIds.size === 0) {
    return rendererList
  }

  // Host open membership filters the renderer list. Host-only cards (no
  // renderer join hit) are omitted — never render from wire fields alone.
  return rendererList.filter((entry) => {
    const id = rendererQuestionJoinId(entry.question)
    return id !== undefined && openQuestionIds.has(id)
  })
}
