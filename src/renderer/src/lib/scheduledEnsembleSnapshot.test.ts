import { describe, expect, it } from 'vitest'
import {
  applyScheduledEnsembleSnapshot,
  buildScheduledEnsembleSnapshot
} from './scheduledEnsembleSnapshot'
import type {
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  ScheduledEnsembleSnapshot
} from '../../../main/store/types'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'codex-worker',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: '',
    order: 1,
    permissionPresetId: 'read_only',
    ...overrides
  } as EnsembleParticipant
}

function ensemble(overrides: Partial<EnsembleConfig> = {}): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 8,
    orchestrationMode: 'turn_bound',
    maxContinuationHops: 6,
    participants: [
      participant({ id: 'claude', provider: 'claude', role: 'Explorer', order: 1 }),
      participant({ id: 'codex', provider: 'codex', role: 'Worker', order: 2 })
    ],
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'c1',
    title: 'Chat',
    provider: 'codex',
    chatKind: 'ensemble',
    ensemble: ensemble(),
    messages: [],
    runs: [],
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides
  } as ChatRecord
}

const FIXED_NOW = new Date('2026-05-27T12:00:00.000Z')

describe('buildScheduledEnsembleSnapshot', () => {
  it('returns null for non-ensemble chats', () => {
    expect(
      buildScheduledEnsembleSnapshot(chat({ chatKind: 'single', ensemble: undefined }))
    ).toBeNull()
  })

  it('returns null for null/undefined chats', () => {
    expect(buildScheduledEnsembleSnapshot(null)).toBeNull()
    expect(buildScheduledEnsembleSnapshot(undefined)).toBeNull()
  })

  it('captures the orchestration mode, participants, and budgets', () => {
    const snap = buildScheduledEnsembleSnapshot(
      chat({
        ensemble: ensemble({
          fanoutPolicy: 'all',
          concurrentModeEnabled: true
        })
      }),
      { now: () => FIXED_NOW }
    )!
    expect(snap.orchestrationMode).toBe('turn_bound')
    expect(snap.fanoutPolicy).toBe('all')
    expect(snap.concurrentModeEnabled).toBe(true)
    expect(snap.participants.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(snap.maxParticipants).toBe(8)
    expect(snap.maxContinuationHops).toBe(6)
    expect(snap.capturedAt).toBe('2026-05-27T12:00:00.000Z')
    expect(snap.dmTargetParticipantId).toBeUndefined()
  })

  it('carries dmTargetParticipantId when provided', () => {
    const snap = buildScheduledEnsembleSnapshot(chat(), {
      dmTargetParticipantId: 'codex',
      now: () => FIXED_NOW
    })!
    expect(snap.dmTargetParticipantId).toBe('codex')
  })

  it('deep-copies the participant array so later edits to the chat do not mutate the snapshot', () => {
    const sourceChat = chat()
    const snap = buildScheduledEnsembleSnapshot(sourceChat, { now: () => FIXED_NOW })!
    // Mutate the source chat's participant after capture.
    sourceChat.ensemble!.participants[0].enabled = false
    sourceChat.ensemble!.participants[0].role = 'MUTATED'
    // Snapshot's copy must be unaffected.
    expect(snap.participants[0].enabled).toBe(true)
    expect(snap.participants[0].role).toBe('Explorer')
  })

  it('normalises orchestrationMode to turn_bound when continuous is not explicitly set', () => {
    const snap = buildScheduledEnsembleSnapshot(
      chat({ ensemble: ensemble({ orchestrationMode: undefined as any }) }),
      { now: () => FIXED_NOW }
    )!
    expect(snap.orchestrationMode).toBe('turn_bound')
  })

  it('maps legacy concurrent snapshots to read-only fan-out', () => {
    const snap = buildScheduledEnsembleSnapshot(
      chat({
        ensemble: ensemble({
          concurrentModeEnabled: true
        })
      }),
      { now: () => FIXED_NOW }
    )!
    expect(snap.fanoutPolicy).toBe('read_only')
    expect(snap.concurrentModeEnabled).toBe(true)
  })
})

describe('applyScheduledEnsembleSnapshot', () => {
  it('replaces orchestration mode + participants on the chat ensemble config', () => {
    const sourceChat = chat({
      ensemble: ensemble({
        orchestrationMode: 'continuous',
        participants: [participant({ id: 'kimi', provider: 'kimi', role: 'Reviewer' })]
      })
    })
    const snapshot: ScheduledEnsembleSnapshot = {
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'read_only',
      concurrentModeEnabled: true,
      participants: [participant({ id: 'claude', provider: 'claude', role: 'Explorer', order: 1 })],
      maxParticipants: 4,
      maxContinuationHops: 2,
      capturedAt: FIXED_NOW.toISOString()
    }
    const next = applyScheduledEnsembleSnapshot(sourceChat, snapshot)
    expect(next.ensemble!.orchestrationMode).toBe('turn_bound')
    expect(next.ensemble!.fanoutPolicy).toBe('read_only')
    expect(next.ensemble!.concurrentModeEnabled).toBe(true)
    expect(next.ensemble!.participants.map((p) => p.id)).toEqual(['claude'])
    expect(next.ensemble!.maxParticipants).toBe(4)
    expect(next.ensemble!.maxContinuationHops).toBe(2)
    // Original chat untouched.
    expect(sourceChat.ensemble!.participants.map((p) => p.id)).toEqual(['kimi'])
  })

  it('returns the chat unchanged when chat.ensemble is missing', () => {
    const sourceChat = chat({ chatKind: 'single', ensemble: undefined })
    const snapshot: ScheduledEnsembleSnapshot = {
      orchestrationMode: 'turn_bound',
      participants: [],
      capturedAt: FIXED_NOW.toISOString()
    }
    expect(applyScheduledEnsembleSnapshot(sourceChat, snapshot)).toBe(sourceChat)
  })
})
