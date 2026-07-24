import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ChatRecord } from '../store/types'
import {
  buildSessionCheckpointFromChat,
  formatSessionCheckpointResumePrompt,
  SessionCheckpointStore
} from './SessionCheckpoint'

function makeCheckpointChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Checkpoint test',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [
        {
          id: 'planner',
          provider: 'claude',
          enabled: true,
          role: 'Planner',
          instructions: 'Plan.',
          order: 1,
          permissionPresetId: 'read_only'
        },
        {
          id: 'worker',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Work.',
          order: 2,
          permissionPresetId: 'workspace_write'
        }
      ],
      lastRoundSummary:
        'Decisions: keep this safe.\nNext action: restore the active queue after restart.',
      blackboard: [
        {
          id: 'risk-1',
          chatId: 'chat-1',
          roundId: 'round-0',
          participantId: 'synthesizer',
          key: 'recovery-risk',
          value: 'Need explicit user confirmation before continuing.',
          category: 'risk',
          scope: 'session',
          createdAt: '2026-06-01T08:58:00.000Z'
        }
      ],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Continue the release sign-off.',
        startedAt: '2026-06-01T09:00:00.000Z',
        activeParticipantId: 'worker',
        orchestrationMode: 'continuous',
        continuationHops: 1,
        maxContinuationHops: 6,
        queuedPrompts: ['Run validation once this lands.'],
        pendingWakeupIds: ['wake-1'],
        participants: [
          {
            participantId: 'planner',
            provider: 'claude',
            role: 'Planner',
            order: 1,
            status: 'answered',
            runId: 'run-1'
          },
          {
            participantId: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            status: 'running',
            runId: 'run-2'
          }
        ]
      }
    }
  }
}

describe('SessionCheckpoint', () => {
  it('captures blackboard, open tasks, summary, and queue state from an active round', () => {
    const checkpoint = buildSessionCheckpointFromChat(
      makeCheckpointChat(),
      'round-started',
      '2026-06-01T09:01:00.000Z'
    )

    expect(checkpoint).toMatchObject({
      id: 'session-checkpoint-chat-1-round-1',
      chatId: 'chat-1',
      roundId: 'round-1',
      status: 'available',
      snapshot: {
        lastRoundSummary:
          'Decisions: keep this safe.\nNext action: restore the active queue after restart.',
        queueState: {
          prompt: 'Continue the release sign-off.',
          activeParticipantId: 'worker',
          queuedPrompts: ['Run validation once this lands.'],
          pendingWakeupIds: ['wake-1']
        }
      }
    })
    expect(checkpoint?.snapshot.blackboard).toHaveLength(1)
    expect(checkpoint?.snapshot.openTasks).toContain(
      'Next action: restore the active queue after restart.'
    )
  })

  it('persists idempotent checkpoints and makes a re-run a no-op update', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'taskwraith-checkpoints-'))
    try {
      const storagePath = join(tmp, 'session-checkpoints.json')
      const store = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-06-01T09:01:00.000Z',
        idFactory: () => 'tmp'
      })

      const first = store.upsertFromChat(makeCheckpointChat(), 'round-started')
      const second = store.upsertFromChat(makeCheckpointChat(), 'round-updated')

      expect(first?.id).toBe(second?.id)
      expect(store.list()).toHaveLength(1)
      expect(store.latestForChat('chat-1')?.reason).toBe('round-updated')
      expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toHaveLength(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('round-trips compact persisted checkpoints through reload and transitions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'taskwraith-checkpoints-'))
    try {
      const storagePath = join(tmp, 'session-checkpoints.json')
      const store = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-06-01T09:01:00.000Z',
        idFactory: () => 'tmp'
      })
      const checkpoint = store.upsertFromChat(makeCheckpointChat(), 'round-started')
      expect(checkpoint).not.toBeNull()
      expect(readFileSync(storagePath, 'utf-8')).not.toContain('\n  {')

      const reloaded = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-06-01T09:02:00.000Z',
        idFactory: () => 'tmp'
      })
      expect(reloaded.latestForChat('chat-1')?.id).toBe(checkpoint?.id)

      const accepted = reloaded.accept(checkpoint!.id)
      expect(accepted?.checkpoint.status).toBe('accepted')

      const reloadedAccepted = new SessionCheckpointStore({ storagePath })
      expect(reloadedAccepted.list()[0].status).toBe('accepted')
      expect(reloadedAccepted.dismiss(checkpoint!.id)?.status).toBe('dismissed')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('retires completed rounds so restart recovery only offers interrupted rounds', () => {
    const store = new SessionCheckpointStore({
      now: () => '2026-06-01T09:01:00.000Z',
      idFactory: () => 'tmp'
    })
    store.upsertFromChat(makeCheckpointChat(), 'round-started')

    expect(store.latestForChat('chat-1')).not.toBeNull()
    const retired = store.completeRound('chat-1', 'round-1', 'completed')

    expect(retired?.status).toBe('superseded')
    expect(retired?.reason).toBe('round-completed')
    expect(store.latestForChat('chat-1')).toBeNull()
  })

  it('formats a safe user-driven resume prompt without auto-resuming providers', () => {
    const checkpoint = buildSessionCheckpointFromChat(
      makeCheckpointChat(),
      'round-started',
      '2026-06-01T09:01:00.000Z'
    )
    expect(checkpoint).not.toBeNull()

    const prompt = formatSessionCheckpointResumePrompt(checkpoint!)

    expect(prompt).toContain('Resume the interrupted Ensemble session from checkpoint')
    expect(prompt).toContain('provider processes were not auto-resumed')
    expect(prompt).toContain('Run validation once this lands.')
    expect(prompt).toContain('Active participant at checkpoint: Worker (codex) was running.')
  })

  it('purges frozen history-deletion scopes strictly and idempotently', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'taskwraith-checkpoints-'))
    try {
      const storagePath = join(tmp, 'session-checkpoints.json')
      const store = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-07-21T09:01:00.000Z',
        idFactory: () => 'tmp'
      })
      store.upsertFromChat(makeCheckpointChat(), 'round-started')
      store.upsertFromChat(
        { ...makeCheckpointChat(), appChatId: 'chat-2', workspaceId: 'ws-2' },
        'round-started'
      )
      store.upsertFromChat(
        { ...makeCheckpointChat(), appChatId: 'chat-3', workspaceId: 'ws-2' },
        'round-started'
      )

      expect(store.purgeForHistoryDeletionScope({ kind: 'chat', chatIds: ['chat-1'] })).toBe(1)
      expect(store.purgeForHistoryDeletionScope({ kind: 'chat', chatIds: ['chat-1'] })).toBe(0)
      expect(store.latestForChat('chat-1')).toBeNull()
      expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toHaveLength(2)

      // Workspace scope also removes records the frozen chat list missed.
      expect(
        store.purgeForHistoryDeletionScope({
          kind: 'workspace',
          workspaceId: 'ws-2',
          chatIds: ['chat-2']
        })
      ).toBe(2)
      expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toHaveLength(0)

      store.upsertFromChat(makeCheckpointChat(), 'round-started')
      expect(store.purgeForHistoryDeletionScope({ kind: 'global' })).toBe(1)
      expect(store.list()).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('soft-skips writer methods for chats inside an in-flight erasure', () => {
    const blocked = new Set<string>()
    const logged: string[] = []
    const store = new SessionCheckpointStore({
      now: () => '2026-07-21T09:01:00.000Z',
      idFactory: () => 'tmp',
      log: (line) => logged.push(line),
      isHistoryMutationBlocked: (chatId) => blocked.has(chatId)
    })
    const checkpoint = store.upsertFromChat(makeCheckpointChat(), 'round-started')
    expect(checkpoint).not.toBeNull()

    blocked.add('chat-1')
    // A late round save cannot mint or refresh checkpoint state mid-erasure…
    expect(store.upsertFromChat(makeCheckpointChat(), 'round-updated')).toBeNull()
    // …and accept/dismiss cannot hand out or transition frozen snapshots.
    expect(store.accept(checkpoint!.id)).toBeNull()
    expect(store.dismiss(checkpoint!.id)).toBeNull()
    expect(store.latestForChat('chat-1')?.reason).toBe('round-started')
    expect(logged.some((line) => line.includes('being erased'))).toBe(true)

    // Round supersession still converges the record toward retirement.
    expect(store.completeRound('chat-1', 'round-1', 'cancelled')?.status).toBe('superseded')
  })

  it('drops orphaned records for chats that no longer exist, keeping live ones', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'taskwraith-checkpoints-'))
    try {
      const storagePath = join(tmp, 'session-checkpoints.json')
      const store = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-07-21T09:01:00.000Z',
        idFactory: () => 'tmp'
      })
      store.upsertFromChat(makeCheckpointChat(), 'round-started')
      store.upsertFromChat({ ...makeCheckpointChat(), appChatId: 'chat-live' }, 'round-started')

      expect(store.purgeOrphanRecords((chatId) => chatId === 'chat-live')).toBe(1)
      expect(store.purgeOrphanRecords((chatId) => chatId === 'chat-live')).toBe(0)
      expect(store.latestForChat('chat-live')).not.toBeNull()
      expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toHaveLength(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('throws from purge when the strict persist fails instead of logging past it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'taskwraith-checkpoints-'))
    try {
      const storagePath = join(tmp, 'session-checkpoints.json')
      const store = new SessionCheckpointStore({
        storagePath,
        now: () => '2026-07-21T09:01:00.000Z',
        idFactory: () => 'tmp'
      })
      store.upsertFromChat(makeCheckpointChat(), 'round-started')
      // Make the atomic tmp+rename write fail by replacing the storage
      // directory with an unwritable path shape (a file where the dir was).
      rmSync(tmp, { recursive: true, force: true })
      writeFileSync(tmp, 'not-a-directory', 'utf-8')

      expect(() => store.purgeForHistoryDeletionScope({ kind: 'global' })).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
