import { describe, expect, it, vi } from 'vitest'

import type { HostThreadRecordPersistInput } from '../host/HostThreadRecordPersistCommand'
import {
  HostChatCompatibilityPersistence,
  type HostChatCompatibilityPersistencePort
} from './HostChatCompatibilityPersistence'
import type { ChatRecord } from './types'

function record(chatId: string, revision: number, content = `body-${revision}`): ChatRecord {
  return {
    appChatId: chatId,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Compatibility checkpoint',
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    archived: false,
    workflowMode: 'normal',
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        content,
        timestamp: '2026-09-04T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

function input(
  chatId: string,
  revision: number,
  expectedRevision: number
): HostThreadRecordPersistInput {
  return { chatId, record: record(chatId, revision), expectedRevision }
}

function harness(overrides: Partial<HostChatCompatibilityPersistencePort> = {}) {
  const enqueued: HostThreadRecordPersistInput[] = []
  const port: HostChatCompatibilityPersistencePort = {
    enqueue: vi.fn((entry) => {
      enqueued.push(entry)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    ...overrides
  }
  return {
    enqueued,
    port,
    persistence: new HostChatCompatibilityPersistence(port)
  }
}

async function waitForLength(values: readonly unknown[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && values.length < length; attempt += 1) {
    await Promise.resolve()
  }
  expect(values).toHaveLength(length)
}

describe('HostChatCompatibilityPersistence', () => {
  it('retains the latest full record by reference while preserving the first Host CAS base', () => {
    const { enqueued, persistence } = harness()
    const first = input('chat-1', 4, 3)
    const latest = input('chat-1', 9, 8)

    expect(persistence.stage(first)).toBe('staged')
    expect(persistence.stage(latest)).toBe('replaced')
    expect(persistence.snapshot().pendingChatIds).toEqual(['chat-1'])
    expect(persistence.materialize('chat-1')).toBe(true)

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({ chatId: 'chat-1', expectedRevision: 3 })
    expect(enqueued[0].record).toBe(latest.record)
    expect(enqueued[0].record.messages[0].content).toBe('body-9')
  })

  it('ignores duplicate and stale revisions without replacing the pending reference', () => {
    const { enqueued, persistence } = harness()
    const newest = input('chat-1', 7, 3)

    expect(persistence.stage(newest)).toBe('staged')
    expect(persistence.stage(input('chat-1', 7, 6))).toBe('duplicate')
    expect(persistence.stage(input('chat-1', 6, 5))).toBe('stale')
    persistence.materialize('chat-1')

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].record).toBe(newest.record)
  })

  it('materializes at most one unconfirmed checkpoint per chat', () => {
    const { enqueued, persistence } = harness()
    persistence.stage(input('chat-1', 4, 3))

    expect(persistence.materialize('chat-1')).toBe(true)
    expect(persistence.materialize('chat-1')).toBe(false)
    expect(enqueued).toHaveLength(1)
    expect(persistence.snapshot()).toMatchObject({
      pendingChatIds: [],
      submittedChatIds: ['chat-1']
    })
  })

  it('shares equal-target barriers and performs one enqueue plus one drain', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { enqueued, port, persistence } = harness({ drain: vi.fn(() => held) })
    persistence.stage(input('chat-1', 4, 3))

    const first = persistence.barrier('chat-1')
    const second = persistence.barrier('chat-1')
    expect(second).toBe(first)
    await Promise.resolve()
    expect(enqueued).toHaveLength(1)

    release()
    await first
    expect(port.drain).toHaveBeenCalledTimes(1)
    expect(persistence.snapshot().submittedChatIds).toEqual([])
    await expect(persistence.barrier('chat-1')).resolves.toBeUndefined()
    expect(port.drain).toHaveBeenCalledTimes(1)
  })

  it('chains a newer barrier behind an in-flight checkpoint without losing the latest record', async () => {
    const releases: Array<() => void> = []
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )
    const { enqueued, persistence } = harness({ drain })
    persistence.stage(input('chat-1', 4, 3))
    const first = persistence.barrier('chat-1')
    await waitForLength(releases, 1)

    const latest = input('chat-1', 8, 7)
    persistence.stage(latest)
    const second = persistence.barrier('chat-1')
    expect(second).not.toBe(first)
    expect(enqueued).toHaveLength(1)

    releases.shift()!()
    await first
    await waitForLength(releases, 1)
    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].record).toBe(latest.record)
    expect(enqueued[1].expectedRevision).toBe(7)

    releases.shift()!()
    await second
    expect(drain).toHaveBeenCalledTimes(2)
  })

  it('restores a failed submitted lineage beneath a newer pending record', async () => {
    let reject!: (error: Error) => void
    const failed = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    const { enqueued, port, persistence } = harness({ drain: vi.fn(() => failed) })
    persistence.stage(input('chat-1', 4, 3))
    const first = persistence.barrier('chat-1')
    await Promise.resolve()
    const latest = input('chat-1', 9, 8)
    persistence.stage(latest)

    reject(new Error('Host unavailable'))
    await expect(first).rejects.toThrow('Host unavailable')
    expect(persistence.snapshot()).toMatchObject({
      pendingChatIds: ['chat-1'],
      submittedChatIds: []
    })

    vi.mocked(port.drain).mockResolvedValue(undefined)
    await persistence.barrier('chat-1')
    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].record).toBe(latest.record)
    expect(enqueued[1].expectedRevision).toBe(3)
  })

  it('restores a record when injected enqueue throws synchronously', () => {
    const enqueue = vi.fn(() => {
      throw new Error('enqueue failed')
    })
    const { persistence } = harness({ enqueue })
    persistence.stage(input('chat-1', 4, 3))

    expect(() => persistence.materialize('chat-1')).toThrow('enqueue failed')
    expect(persistence.snapshot()).toMatchObject({
      pendingChatIds: ['chat-1'],
      submittedChatIds: []
    })
  })

  it('fences delete, discards pending work, drains submitted work, and is idempotent', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { enqueued, port, persistence } = harness({ drain: vi.fn(() => held) })
    persistence.stage(input('chat-1', 4, 3))
    persistence.materialize('chat-1')
    persistence.stage(input('chat-1', 5, 4))

    const first = persistence.prepareDelete('chat-1')
    const second = persistence.prepareDelete('chat-1')
    expect(second).toBe(first)
    expect(persistence.stage(input('chat-1', 6, 5))).toBe('blocked')
    expect(persistence.snapshot().pendingChatIds).toEqual([])

    release()
    await first
    await expect(persistence.prepareDelete('chat-1')).resolves.toBeUndefined()
    expect(enqueued).toHaveLength(1)
    expect(port.drain).toHaveBeenCalledTimes(1)
    expect(persistence.snapshot().deletingChatIds).toEqual(['chat-1'])
  })

  it('allows a failed delete preparation to be retried without restoring discarded work', async () => {
    const drain = vi
      .fn()
      .mockRejectedValueOnce(new Error('drain failed'))
      .mockResolvedValue(undefined)
    const { persistence } = harness({ drain })
    persistence.stage(input('chat-1', 4, 3))
    persistence.materialize('chat-1')

    await expect(persistence.prepareDelete('chat-1')).rejects.toThrow('drain failed')
    expect(persistence.snapshot().pendingChatIds).toEqual([])
    await expect(persistence.prepareDelete('chat-1')).resolves.toBeUndefined()
    expect(drain).toHaveBeenCalledTimes(2)
  })

  it('materializes every chat once at shutdown and shares the shutdown promise', async () => {
    const { enqueued, port, persistence } = harness()
    const firstRecord = input('chat-b', 3, 2)
    const latestRecord = input('chat-a', 7, 4)
    persistence.stage(input('chat-a', 5, 4))
    persistence.stage(latestRecord)
    persistence.stage(firstRecord)

    const first = persistence.shutdown()
    const second = persistence.shutdown()
    expect(second).toBe(first)
    expect(persistence.stage(input('chat-c', 1, 0))).toBe('blocked')
    await first

    expect(enqueued).toHaveLength(2)
    expect(enqueued.find((entry) => entry.chatId === 'chat-a')?.record).toBe(latestRecord.record)
    expect(enqueued.find((entry) => entry.chatId === 'chat-b')?.record).toBe(firstRecord.record)
    expect(port.drainAll).toHaveBeenCalledTimes(1)
    expect(persistence.snapshot()).toEqual({
      pendingChatIds: [],
      submittedChatIds: [],
      deletingChatIds: [],
      closing: true,
      closed: true
    })
  })

  it('waits for delete preparation before starting the all-chat shutdown drain', async () => {
    let releaseDelete!: () => void
    const heldDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    const drainAll = vi.fn(async () => {})
    const { port, persistence } = harness({
      drain: vi.fn(() => heldDelete),
      drainAll
    })
    persistence.stage(input('chat-delete', 4, 3))
    persistence.materialize('chat-delete')
    const deleting = persistence.prepareDelete('chat-delete')

    const shutdown = persistence.shutdown()
    await Promise.resolve()
    expect(drainAll).not.toHaveBeenCalled()

    releaseDelete()
    await deleting
    await shutdown
    expect(port.drain).toHaveBeenCalledTimes(1)
    expect(drainAll).toHaveBeenCalledTimes(1)
  })

  it('restores every unconfirmed reference when the shutdown drain fails', async () => {
    const { persistence } = harness({
      drainAll: vi.fn().mockRejectedValue(new Error('Host stopped'))
    })
    const latest = input('chat-1', 6, 3)
    persistence.stage(latest)

    await expect(persistence.shutdown()).rejects.toThrow('Host stopped')
    expect(persistence.snapshot()).toMatchObject({
      pendingChatIds: ['chat-1'],
      submittedChatIds: [],
      closing: true,
      closed: false
    })
  })

  it('exposes only bounded coordination metadata, never retained record bodies', () => {
    const { persistence } = harness()
    persistence.stage(input('chat-secret', 4, 3))

    const serialized = JSON.stringify(persistence.snapshot())
    expect(serialized).toContain('chat-secret')
    expect(serialized).not.toContain('body-4')
    expect(serialized).not.toContain('messages')
  })

  it('rejects malformed identity and revision inputs before retaining them', () => {
    const { persistence } = harness()
    expect(() => persistence.stage({ ...input('chat-1', 4, 3), chatId: '' })).toThrow(/chat id/)
    expect(() => persistence.stage({ ...input('chat-1', 4, 3), chatId: 'chat-2' })).toThrow(
      /identity/
    )
    expect(() => persistence.stage({ ...input('chat-1', 4, 3), expectedRevision: -1 })).toThrow(
      /expected revision/
    )
    expect(persistence.snapshot().pendingChatIds).toEqual([])
  })
})
