import { describe, expect, it, vi } from 'vitest'

import {
  HostThreadRecordPersistClient,
  type HostPersistenceDiagnosticOptions,
  type HostPersistenceObservation,
  type HostThreadRecordPersistInput
} from '../host/HostThreadRecordPersistCommand'
import type { HostCommandReceipt } from '../../shared/hostProtocol'
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

  it('rebases a submitted lineage in place and discards a newer stale pending slot', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { enqueued, persistence } = harness({ drain: vi.fn(() => held) })
    persistence.stage(input('chat-1', 7, 3))
    const barrier = persistence.barrier('chat-1')
    await Promise.resolve()
    persistence.stage(input('chat-1', 8, 7))
    const recovered = input('chat-1', 5, 4)

    expect(persistence.rebase(recovered)).toBe(true)
    expect(persistence.snapshot()).toMatchObject({
      pendingChatIds: [],
      submittedChatIds: ['chat-1']
    })
    expect(enqueued[0].record.persistenceRevision).toBe(7)

    release()
    await barrier
    expect(persistence.hasUnconfirmed('chat-1')).toBe(false)
    expect(persistence.stage(input('chat-1', 6, 5))).toBe('staged')
  })

  it('rebases a failed-drain pending lineage for the next barrier', async () => {
    const drain = vi
      .fn()
      .mockRejectedValueOnce(new Error('revision conflict'))
      .mockResolvedValue(undefined)
    const { enqueued, persistence } = harness({ drain })
    persistence.stage(input('chat-1', 9, 3))
    await expect(persistence.barrier('chat-1')).rejects.toThrow('revision conflict')

    const recovered = input('chat-1', 5, 4)
    expect(persistence.rebase(recovered)).toBe(true)
    await persistence.barrier('chat-1')

    expect(enqueued).toHaveLength(2)
    expect(enqueued[1]).toBe(recovered)
    expect(persistence.hasUnconfirmed('chat-1')).toBe(false)
  })

  it('discards only a pending record and never claims an enqueued record was cancelled', () => {
    const { persistence } = harness()
    persistence.stage(input('chat-pending', 4, 3))
    expect(persistence.hasUnconfirmed('chat-pending')).toBe(true)
    expect(persistence.discard('chat-pending')).toBe(true)
    expect(persistence.hasUnconfirmed('chat-pending')).toBe(false)
    expect(persistence.discard('chat-pending')).toBe(false)

    persistence.stage(input('chat-submitted', 4, 3))
    persistence.materialize('chat-submitted')
    expect(persistence.discard('chat-submitted')).toBe(false)
    expect(persistence.hasUnconfirmed('chat-submitted')).toBe(true)
  })

  it('releases a submitted slot on an exact or newer Host revision acknowledgement', () => {
    const { persistence } = harness()
    persistence.stage(input('chat-1', 7, 3))
    persistence.materialize('chat-1')

    expect(persistence.acknowledgeRevision('chat-1', 6)).toBe(false)
    expect(persistence.hasUnconfirmed('chat-1')).toBe(true)
    expect(persistence.acknowledgeRevision('chat-1', 9)).toBe(true)
    expect(persistence.hasUnconfirmed('chat-1')).toBe(false)
    expect(persistence.stage(input('chat-1', 10, 9))).toBe('staged')
  })

  it('materializes a requested terminal successor as soon as its predecessor is acknowledged', () => {
    const { enqueued, persistence } = harness()
    persistence.stage(input('chat-1', 4, 3))
    persistence.materialize('chat-1')
    const terminal = input('chat-1', 7, 4)
    persistence.stage(terminal)

    expect(persistence.materialize('chat-1')).toBe(false)
    expect(enqueued).toHaveLength(1)
    expect(persistence.acknowledgeRevision('chat-1', 4)).toBe(true)

    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].record).toBe(terminal.record)
    expect(enqueued[1].expectedRevision).toBe(4)
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

  it('drains a successor staged behind an unacknowledged checkpoint before closing', async () => {
    const { enqueued, port, persistence } = harness()
    persistence.stage(input('chat-1', 4, 3))
    persistence.materialize('chat-1')
    const latest = input('chat-1', 8, 4)
    persistence.stage(latest)

    await persistence.shutdown()

    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].record).toBe(latest.record)
    expect(port.drainAll).toHaveBeenCalledTimes(2)
    expect(persistence.hasUnconfirmed('chat-1')).toBe(false)
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

describe('compatibility persistence observations', () => {
  function observed(
    options: HostPersistenceDiagnosticOptions = {},
    overrides: Partial<HostChatCompatibilityPersistencePort> = {}
  ) {
    const events: HostPersistenceObservation[] = []
    const f = harness(overrides)
    let id = 0
    let time = 0
    const persistence = new HostChatCompatibilityPersistence(f.port, {
      observer: (event) => {
        events.push(event)
      },
      diagnosticNowMs: () => time,
      diagnosticCreateId: () => `barrier-${++id}`,
      ...options
    })
    return {
      ...f,
      persistence,
      events,
      advance: (n: number) => {
        time += n
      }
    }
  }

  it.each(['working', 'throwing-clock', 'throwing-sink', 'rejecting-sink'] as const)(
    'preserves exact shared promise identity and one shared operation with %s diagnostics',
    async (mode) => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const options: HostPersistenceDiagnosticOptions =
        mode === 'throwing-clock'
          ? {
              diagnosticNowMs: () => {
                throw new Error('clock')
              }
            }
          : mode === 'throwing-sink'
            ? {
                observer: () => {
                  throw new Error('sink')
                }
              }
            : mode === 'rejecting-sink'
              ? {
                  observer: () => Promise.reject(new Error('sink'))
                }
              : {}
      const f = observed(options, { drain: vi.fn(() => held) })
      f.persistence.stage(input('C', 4, 3))
      const first = f.persistence.barrier('C')
      const second = f.persistence.barrier('C')
      expect(second).toBe(first)
      await Promise.resolve()
      expect(f.enqueued).toHaveLength(1)
      f.advance(12)
      release()
      await first
      expect(f.port.drain).toHaveBeenCalledTimes(1)
      if (mode === 'working' || mode === 'throwing-clock') {
        const starts = f.events.filter(
          (event) => event.phase === 'barrier' && event.outcome === 'started'
        )
        const ends = f.events.filter(
          (event) => event.phase === 'barrier' && event.outcome === 'succeeded'
        )
        expect(starts).toHaveLength(1)
        expect(ends).toHaveLength(1)
        expect(ends[0].durationMs).toBe(mode === 'working' ? 12 : null)
        expect(f.events.find((event) => event.phase === 'barrier_join')).toMatchObject({
          outcome: 'joined',
          relatedOperationId: starts[0].operationId
        })
      }
    }
  )

  it('preserves newer-target chaining and records predecessor links without another caller wrapper', async () => {
    const releases: Array<() => void> = []
    const f = observed(
      {},
      {
        drain: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releases.push(resolve)
            })
        )
      }
    )
    f.persistence.stage(input('C', 4, 3))
    const first = f.persistence.barrier('C')
    await waitForLength(releases, 1)
    f.advance(3)
    const latest = input('C', 8, 7)
    f.persistence.stage(latest)
    const second = f.persistence.barrier('C')
    expect(second).not.toBe(first)
    expect(f.persistence.barrier('C')).toBe(second)
    const barriers = f.events.filter(
      (event) => event.phase === 'barrier' && event.outcome === 'started'
    )
    expect(barriers[1].relatedOperationId).toBe(barriers[0].operationId)
    f.advance(7)
    releases.shift()!()
    await first
    await waitForLength(releases, 1)
    expect(f.enqueued[1].record).toBe(latest.record)
    expect(f.enqueued[1].expectedRevision).toBe(7)
    f.advance(10)
    releases.shift()!()
    await second
    expect(
      f.events
        .filter((event) => event.phase === 'barrier' && event.outcome === 'succeeded')
        .map((event) => event.durationMs)
    ).toEqual([10, 17])
  })

  it('keeps rejection identity/order and restores the newest context with the first CAS base', async () => {
    let reject!: (error: unknown) => void
    const held = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    const f = observed({}, { drain: vi.fn(() => held) })
    f.persistence.stage({ ...input('C', 4, 3), diagnosticContext: { requestId: 'first' } })
    const first = f.persistence.barrier('C')
    const joined = f.persistence.barrier('C')
    expect(joined).toBe(first)
    await Promise.resolve()
    const latest = { ...input('C', 9, 8), diagnosticContext: { requestId: 'latest' } }
    f.persistence.stage(latest)
    const original = new Error('private error')
    const order: string[] = []
    const observer = first.catch((error) => {
      expect(error).toBe(original)
      order.push('rejected')
    })
    reject(original)
    await observer
    expect(order).toEqual(['rejected'])
    expect(
      f.events.filter((event) => event.phase === 'barrier' && event.outcome === 'failed')
    ).toHaveLength(1)
    vi.mocked(f.port.drain).mockResolvedValue(undefined)
    await f.persistence.barrier('C')
    expect(f.enqueued[1].record).toBe(latest.record)
    expect(f.enqueued[1]).toMatchObject({
      expectedRevision: 3,
      diagnosticContext: { requestId: 'latest' }
    })
    expect(JSON.stringify(f.events)).not.toContain('private error')
  })

  it('restores identical record lineage after synchronous materialization failure', () => {
    const original = new Error('enqueue')
    const f = observed(
      {},
      {
        enqueue: vi.fn(() => {
          throw original
        })
      }
    )
    const entry = { ...input('C', 4, 3), diagnosticContext: { runId: 'R' } }
    f.persistence.stage(entry)
    expect(() => f.persistence.materialize('C')).toThrow(original)
    expect(f.persistence.latestSequence('C')).toBe(1)
    const retried: HostThreadRecordPersistInput[] = []
    vi.mocked(f.port.enqueue).mockImplementation((value) => {
      retried.push(value)
    })
    expect(f.persistence.materialize('C')).toBe(true)
    expect(retried[0].record).toBe(entry.record)
    expect(retried[0].diagnosticContext?.runId).toBe('R')
    expect(
      f.events
        .filter((event) => event.phase === 'materialize' && event.outcome !== 'started')
        .map((event) => event.outcome)
    ).toEqual(['failed', 'succeeded'])
  })

  it('keeps rebased submitted entry identity and the latest absorbed context', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = observed({}, { drain: vi.fn(() => held) })
    f.persistence.stage({ ...input('C', 4, 3), diagnosticContext: { requestId: 'first' } })
    const barrier = f.persistence.barrier('C')
    await waitForLength(f.enqueued, 1)
    f.persistence.stage({ ...input('C', 8, 7), diagnosticContext: { requestId: 'latest' } })
    const recovered = input('C', 6, 5)
    expect(f.persistence.rebase(recovered)).toBe(true)
    expect(f.events.find((event) => event.phase === 'rebase')).toMatchObject({
      sequence: 2,
      relatedSequence: 1,
      context: { requestId: 'latest' },
      expectedRevision: 5
    })
    release()
    await barrier
    expect(f.persistence.hasUnconfirmed('C')).toBe(false)
    expect(f.port.enqueue).toHaveBeenCalledTimes(1)
  })

  it('distinguishes quiet and deleting barriers without a fictitious physical write', async () => {
    const f = observed()
    await f.persistence.barrier('quiet')
    await f.persistence.prepareDelete('deleting')
    await expect(f.persistence.barrier('deleting')).rejects.toThrow('deleting')
    expect(f.events.map((event) => [event.phase, event.outcome])).toEqual([
      ['barrier_quiet', 'skipped'],
      ['barrier_rejected', 'failed']
    ])
    expect(f.port.enqueue).not.toHaveBeenCalled()
  })

  it('does no diagnostic clock or ID work without an observer and retains untouched input', async () => {
    const clock = vi.fn(() => 1)
    const id = vi.fn(() => 'not-used')
    const f = observed({ observer: undefined, diagnosticNowMs: clock, diagnosticCreateId: id })
    const entry = input('C', 4, 3)
    Object.defineProperty(entry, 'diagnosticContext', {
      get: () => {
        throw new Error('context')
      }
    })
    f.persistence.stage(entry)
    await f.persistence.barrier('C')
    expect(f.enqueued[0]).toBe(entry)
    expect(clock).not.toHaveBeenCalled()
    expect(id).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
  })

  it('joins wrapper materialization to real client commands with bounded body-free context', async () => {
    const events: HostPersistenceObservation[] = []
    let commandId = 0
    let diagnosticId = 0
    const options = {
      observer: (event: HostPersistenceObservation) => {
        events.push(event)
      },
      diagnosticCreateId: () => `diag-${++diagnosticId}`
    }
    const client = new HostThreadRecordPersistClient({
      ...options,
      profilePath: '/unused',
      transfer: {
        publish: ({ transferId }) => ({ transferId, sha256: 'a'.repeat(64), byteLength: 42 }),
        remove: () => true
      },
      createId: () => `id-${++commandId}`,
      broker: {
        submitCommand: async (command) => ({
          ok: true,
          receipt: {
            type: 'host.receipt',
            protocolVersion: command.protocolVersion,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            name: command.name,
            actor: command.actor,
            status: 'succeeded'
          } as HostCommandReceipt
        }),
        lookupReceipt: async () => ({ ok: false, error: 'unexpected' })
      }
    })
    const persistence = new HostChatCompatibilityPersistence(client, options)
    const latest = {
      ...input('C', 9, 8),
      diagnosticContext: { requestId: 'latest', roundId: 'round' }
    }
    persistence.stage({ ...input('C', 4, 3), diagnosticContext: { requestId: 'first' } })
    persistence.stage(latest)
    const first = persistence.barrier('C')
    expect(persistence.barrier('C')).toBe(first)
    await first
    const materialize = events.find((event) => event.phase === 'materialize')!
    const enqueue = events.find((event) => event.phase === 'enqueue')!
    const persist = events.find((event) => event.phase === 'persist')!
    const receipt = events.find((event) => event.phase === 'client_receipt_wait')!
    expect(materialize).toMatchObject({
      sequence: 2,
      expectedRevision: 3,
      parentOperationId: events.find((event) => event.phase === 'barrier')!.operationId
    })
    expect(enqueue.context).toMatchObject({
      requestId: 'latest',
      lineageId: materialize.operationId
    })
    expect(persist.parentOperationId).toBe(enqueue.operationId)
    expect(receipt).toMatchObject({ parentOperationId: persist.operationId, commandId: 'id-2' })
    expect(events.filter((event) => event.phase === 'stage')[1]).toMatchObject({
      sequence: 2,
      relatedSequence: 1
    })
    expect(JSON.stringify(events)).not.toContain('body-9')
    expect(JSON.stringify(events)).not.toContain('messages')
    expect(
      events.filter((event) => event.phase === 'persist' && event.outcome === 'succeeded')
    ).toHaveLength(1)
  })
})
