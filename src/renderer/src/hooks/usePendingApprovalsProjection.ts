/**
 * Host Arc Wave 5c Phase 2 — dual-read join for Desktop pending approvals.
 *
 * PURE LOGIC ONLY. The same split Phase 1 used: every decision worth testing
 * lives here; React wiring stays a thin consumer. This repo has no jsdom
 * renderer environment, so hook behaviour would be untestable.
 *
 * THE DUAL-READ CONTRACT (Cap dispatch host-arc-5c-phase2-dispatch):
 * - Host not live/ready → the AppStore list renders VERBATIM (today's
 *   behaviour; fail-closed honesty).
 * - Host live + shadow-backed → Host pending membership is authority for
 *   which AppStore rows still show; the JOIN is by approvalId, the key both
 *   sides share after main-side shadow registration.
 * - Host live with ZERO shadow cards → AppStore list verbatim. Host-empty
 *   membership can never be told apart from "shadow never wired", so rows
 *   are never dropped on an empty Host set (dispatch point 4).
 * - Host-only shadow cards (no AppStore join hit) are OMITTED — the renderer
 *   cannot resolve an approval without the AppStore fields, and fabricating
 *   title/provider is forbidden.
 * - Non-shadow cards (deferred-bridge / TUI) never touch Desktop membership.
 */

import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'
import type { HostProjectedApproval } from '../lib/host/hostSnapshotProjection'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'

/**
 * Sentinel commandId prefix for AppStore-shadow rows.
 *
 * Must match main's HostProductionApprovalShadow export. Duplicated here so
 * the renderer never imports from main.
 */
export const HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX = 'appstore-shadow:' as const

export interface PendingApprovalListEntry {
  readonly chatId: string
  readonly approval: AgentApprovalRequest
}

function flattenAppStorePending(
  byChatId: Record<string, AgentApprovalRequest | null | undefined>,
  queueByChatId: Record<string, readonly AgentApprovalRequest[] | undefined>
): PendingApprovalListEntry[] {
  // Heads first so the currently-blocking approval for each chat leads;
  // carry the MAP KEY (the chatId the approval is filed under).
  const out: PendingApprovalListEntry[] = []
  for (const [chatId, head] of Object.entries(byChatId)) {
    if (head) out.push({ chatId, approval: head })
    const tail = queueByChatId[chatId]
    if (tail) for (const approval of tail) out.push({ chatId, approval })
  }
  return out
}

function isShadowPendingCard(card: HostProjectedApproval): boolean {
  return (
    card.status === 'pending' &&
    typeof card.commandId === 'string' &&
    card.commandId.startsWith(HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX)
  )
}

/**
 * Dual-read join of Host projection state with AppStore pending maps.
 *
 * Returns the list Desktop should render for the Approvals popover / corner
 * pill. Pure: no DOM, no store reads.
 */
export function joinHostPendingApprovals(
  hostState: HostProjectionState,
  byChatId: Record<string, AgentApprovalRequest | null | undefined>,
  queueByChatId: Record<string, readonly AgentApprovalRequest[] | undefined> = {}
): PendingApprovalListEntry[] {
  const appStoreList = flattenAppStorePending(byChatId, queueByChatId)

  // Host not live → AppStore list verbatim (fail-closed fallback).
  if (hostState.status !== 'live') {
    return appStoreList
  }

  const projection = hostState.projection
  // Cached is not live — even under status:'live', only freshness:'live' is
  // authority. Without a projection there is nothing to join on.
  if (!projection || projection.freshness !== 'live') {
    return appStoreList
  }

  // Only shadow-sentinel + pending cards participate in Desktop membership.
  // Deferred-bridge / TUI cards (real Host commandIds) are ignored here.
  const pendingShadowIds = new Set<string>()
  for (const card of projection.approvals) {
    if (isShadowPendingCard(card)) {
      pendingShadowIds.add(card.approvalId)
    }
  }

  // Zero shadow cards → never drop AppStore rows (dispatch point 4).
  // Empty Host membership cannot be distinguished from "shadow never wired".
  if (pendingShadowIds.size === 0) {
    return appStoreList
  }

  // Host pending membership filters the AppStore list. Host-only shadow cards
  // (no AppStore join hit) are omitted — never render from wire fields alone.
  return appStoreList.filter((entry) => pendingShadowIds.has(entry.approval.id))
}
