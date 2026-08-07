/**
 * Host Arc Wave 5c Phase 2 — usePendingApprovalsProjection pins.
 *
 * RED-first: these pins existed against the missing module before the
 * implementation landed (same discipline as Wave 5c Phase 1).
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
 *
 * The pins are pure (no DOM) — the same split Phase 1 used.
 */

import { describe, expect, it } from 'vitest'
import type {
  HostProjectedApproval,
  HostProjectedSnapshot
} from '../lib/host/hostSnapshotProjection'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'
import {
  HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX,
  joinHostPendingApprovals
} from './usePendingApprovalsProjection'

function approval(id: string, overrides: Partial<AgentApprovalRequest> = {}): AgentApprovalRequest {
  return {
    id,
    provider: 'codex',
    method: 'shellCommands',
    title: `Approval ${id}`,
    body: 'body',
    actions: ['accept', 'decline'],
    ...overrides
  }
}

function shadowCard(approvalId: string): HostProjectedApproval {
  return {
    approvalId,
    commandId: `${HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX}${approvalId}`,
    status: 'pending',
    actionKind: 'mcpTools',
    createdAt: 0
  }
}

function bridgeCard(approvalId: string): HostProjectedApproval {
  // Deferred-bridge (Host-command) card: a REAL commandId, not the sentinel.
  return {
    approvalId,
    commandId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    status: 'pending',
    actionKind: 'composer.send',
    createdAt: 1700000000000
  }
}

function projection(
  approvals: HostProjectedApproval[],
  freshness: 'live' | 'cached' = 'live'
): HostProjectedSnapshot {
  return {
    generation: 1,
    cursor: 1,
    generatedAt: '2026-08-07T12:00:00.000Z',
    freshness,
    health: { hostStatus: 'ok', supervised: true },
    workspaces: [],
    threads: [],
    providers: [],
    approvals,
    usage: { availability: 'unavailable' },
    warningCodes: [],
    counts: {
      runs: 0,
      missions: 0,
      rounds: 0,
      questions: 0,
      approvals: approvals.length,
      warnings: 0
    }
  }
}

function liveState(approvals: HostProjectedApproval[]): HostProjectionState {
  return { status: 'live', projection: projection(approvals), lastCursor: 1, lastGeneration: 1 }
}

describe('joinHostPendingApprovals', () => {
  it('flattens heads before queue tails, carrying the map-key chatId', () => {
    const out = joinHostPendingApprovals(
      { status: 'idle' },
      { 'chat-a': approval('a1'), 'chat-b': approval('b1') },
      { 'chat-a': [approval('a2')] }
    )
    expect(out.map((entry) => [entry.chatId, entry.approval.id])).toEqual([
      ['chat-a', 'a1'],
      ['chat-a', 'a2'],
      ['chat-b', 'b1']
    ])
  })

  it('Host not live → AppStore list verbatim (fail-closed fallback)', () => {
    const byChatId = { 'chat-a': approval('a1') }
    const queue = { 'chat-a': [approval('a2')] }
    for (const state of [
      { status: 'idle' },
      { status: 'loading' },
      { status: 'unavailable', unavailableReason: 'offline' },
      { status: 'unavailable', projection: projection([shadowCard('a1')], 'cached') }
    ] as HostProjectionState[]) {
      const out = joinHostPendingApprovals(state, byChatId, queue)
      expect(out.map((entry) => entry.approval.id)).toEqual(['a1', 'a2'])
    }
  })

  it('Host live but cached freshness → AppStore list verbatim (cached is not live)', () => {
    const state: HostProjectionState = {
      status: 'live',
      projection: projection([shadowCard('a1')], 'cached')
    }
    const out = joinHostPendingApprovals(state, { 'chat-a': approval('a1') }, {})
    expect(out).toHaveLength(1)
  })

  it('Host live + shadow-backed → Host pending membership filters the AppStore list', () => {
    const out = joinHostPendingApprovals(
      liveState([shadowCard('a1')]),
      { 'chat-a': approval('a1'), 'chat-b': approval('b1') },
      { 'chat-a': [approval('a2')] }
    )
    // a2 and b1 are absent from the Host pending set → main resolved them and
    // the renderer's clear event was missed; the stale rows drop.
    expect(out.map((entry) => [entry.chatId, entry.approval.id])).toEqual([['chat-a', 'a1']])
  })

  it('Host live with ZERO shadow cards never drops AppStore rows (dispatch point 4)', () => {
    const out = joinHostPendingApprovals(
      liveState([]),
      { 'chat-a': approval('a1') },
      { 'chat-a': [approval('a2')] }
    )
    expect(out.map((entry) => entry.approval.id)).toEqual(['a1', 'a2'])
  })

  it('Host-only shadow cards are omitted — never rendered from wire fields alone', () => {
    const out = joinHostPendingApprovals(liveState([shadowCard('ghost')]), {}, {})
    expect(out).toEqual([])
  })

  it('non-shadow (deferred-bridge) cards never filter Desktop membership', () => {
    const out = joinHostPendingApprovals(
      liveState([bridgeCard('tui-ask-1')]),
      { 'chat-a': approval('a1') },
      {}
    )
    expect(out.map((entry) => entry.approval.id)).toEqual(['a1'])
  })

  it('a decided shadow card (status left pending) does not count as pending membership', () => {
    const decided: HostProjectedApproval = { ...shadowCard('a1'), status: 'approved' }
    const out = joinHostPendingApprovals(liveState([decided]), { 'chat-a': approval('a1') }, {})
    // Zero PENDING shadow cards → the empty-set rule keeps the AppStore row.
    expect(out.map((entry) => entry.approval.id)).toEqual(['a1'])
  })
})
