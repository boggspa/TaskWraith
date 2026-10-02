import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogue } from '../../host-shared/thread-catalogue/ThreadCatalogue'
import {
  THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS,
  ThreadCatalogueSourcePublisher
} from '../../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import { captureThreadCatalogueWitness } from '../../host-shared/thread-catalogue/ThreadCatalogueWitness'
import type { ThreadCatalogueProjection } from '../../shared/threadCatalogueTypes'
import { ThreadCatalogueDurability } from '../../host-shared/thread-catalogue/ThreadCatalogueDurability'
import { threadCatalogueWriteGate } from '../../host-shared/thread-catalogue/ThreadCatalogueWriteGate'

const profiles = new Set<string>()
const profile = (): string => {
  const value = fs.mkdtempSync(join(tmpdir(), 'thread-source-regression-'))
  profiles.add(value)
  fs.mkdirSync(join(value, 'chats'), { recursive: true, mode: 0o700 })
  return value
}
const projection = (chatId = 'chat'): ThreadCatalogueProjection => ({
  revision: 1,
  summary: {
    chatId,
    title: 'History',
    provider: 'claude',
    chatKind: 'single',
    scope: 'global',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messageCount: 0,
    runCount: 0
  },
  recovery: {
    unsettledRuns: 0,
    ensembleWakeups: 0,
    soloWakeups: 0,
    workerEvents: 0,
    joinPolicies: 0,
    nextBlackboardExpiryAt: null
  }
})
const reader = (profilePath: string) => ({
  profilePath,
  runtimeInstanceId: 'writer',
  segmented: false
})

afterEach(() => {
  vi.useRealTimers()
  for (const value of profiles) fs.rmSync(value, { recursive: true, force: true })
  profiles.clear()
})

describe('ThreadCatalogue source-operation supervision regressions', () => {
  it.each([false, true])(
    'keeps Desktop marker-before-source ordering and refuses stale completion (source replaced=%s)',
    async (replaceSource) => {
      const profilePath = profile()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const durability = new ThreadCatalogueDurability<number>({
        open: (_dev, _ino, fd) => fd,
        noteWrite: () => {},
        awaitDurable: () => held,
        forget: async (files) => {
          for (const fd of files) fs.closeSync(fd)
        },
        acquire: () => ({ noteMutation: () => ({ file: -1, offset: 1 }), release: async () => {} })
      })
      const publisher = new ThreadCatalogueSourcePublisher({
        profilePath,
        writer: 'desktop',
        writerId: 'writer',
        segmented: false,
        canWrite: () => true,
        project: () => projection(),
        deferredDurability: durability,
        catalogueDeferredDurabilityFlag: '1'
      })
      await threadCatalogueWriteGate.admit('chat', async () => {
        const ticket = publisher.begin('chat')
        const headPath = join(profilePath, 'thread-catalogue-v1', 'desktop', 'chat.json')
        expect(JSON.parse(fs.readFileSync(headPath, 'utf8')).phase).toBe('pending')
        fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{}')
        publisher.finishAfter(ticket, { appChatId: 'chat' }, Promise.resolve())
        if (replaceSource)
          fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{"changed":true}')
        await Promise.resolve()
        expect(JSON.parse(fs.readFileSync(headPath, 'utf8')).phase).toBe('pending')
        release()
        await publisher.drain()
        expect(JSON.parse(fs.readFileSync(headPath, 'utf8')).phase).toBe(
          replaceSource ? 'repair' : 'durable'
        )
      })
      await durability.retire()
      await publisher.dispose()
    }
  )

  it.each(['0', 'true', undefined])(
    'does not inject deferred durability for Desktop flag %s',
    (flag) => {
      const write = vi.fn()
      const publisher = new ThreadCatalogueSourcePublisher({
        profilePath: profile(),
        writer: 'desktop',
        writerId: 'writer',
        segmented: false,
        canWrite: () => true,
        catalogueDeferredDurabilityFlag: flag ?? '0',
        deferredDurability: { write, awaitDurable: async () => {} }
      })
      expect(write).not.toHaveBeenCalled()
      publisher.catalogue.beginPublication('chat')
      expect(write).not.toHaveBeenCalled()
    }
  )
  it('returns the exact source witness captured for an optimistic projection', () => {
    const profilePath = profile()
    fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{}', { mode: 0o600 })
    const publisher = new ThreadCatalogueSourcePublisher({
      profilePath,
      writer: 'host',
      writerId: 'writer',
      segmented: false,
      canWrite: () => true
    })
    const ticket = publisher.begin('chat')
    const witness = publisher.finishProjection(ticket, projection())

    expect(witness).toBe(captureThreadCatalogueWitness(reader(profilePath), 'chat').witness)
  })

  it('keeps an in-flight source durability repair inside drain and pending state', async () => {
    const profilePath = profile()
    fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{}', { mode: 0o600 })
    let enterRepair!: () => void
    const repairEntered = new Promise<void>((resolve) => {
      enterRepair = resolve
    })
    let releaseRepair!: () => void
    const repairReleased = new Promise<void>((resolve) => {
      releaseRepair = resolve
    })
    const publisher = new ThreadCatalogueSourcePublisher<{
      appChatId: string
      persistenceRevision: number
    }>({
      profilePath,
      writer: 'desktop',
      writerId: 'writer',
      segmented: false,
      canWrite: () => true,
      project: () => projection(),
      repairSource: async () => {
        enterRepair()
        await repairReleased
        return captureThreadCatalogueWitness(reader(profilePath), 'chat').witness
      }
    })

    const ticket = publisher.begin('chat')
    publisher.finishAfter(
      ticket,
      { appChatId: 'chat', persistenceRevision: 1 },
      Promise.reject(new Error('source durability is uncertain'))
    )
    await repairEntered
    let drained = false
    const drain = publisher.drainChat('chat').then(() => {
      drained = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    const pendingDuringRepair = publisher.hasPending('chat')
    const drainedDuringRepair = drained
    releaseRepair()
    await drain

    expect(pendingDuringRepair).toBe(true)
    expect(drainedDuringRepair).toBe(false)
  })

  // A production Host's lifetime-stop deadline is summed from this bound
  // (HOST_LIFETIME_STOP_DEADLINE_MS), so the drain must wait the exported one.
  it('fails a drain whose writers never finish after THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const profilePath = profile()
    fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{}', { mode: 0o600 })
    const publisher = new ThreadCatalogueSourcePublisher({
      profilePath,
      writer: 'host',
      writerId: 'writer',
      segmented: false,
      canWrite: () => true
    })
    // A source writer that never finishes.
    publisher.begin('chat')
    const startedAt = Date.now()
    let outcome: unknown = 'pending'
    void publisher.drain().then(
      () => {
        outcome = 'drained'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    // Straight to one 10 ms poll short of the bound, rather than every poll.
    vi.setSystemTime(startedAt + THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS - 20)
    await vi.advanceTimersByTimeAsync(10)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(10)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('History source writers have not drained')
  })

  it('retries writer registration after an untracked save repaired during cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const profilePath = profile()
    const control = join(profilePath, 'thread-history-control-v1')
    fs.mkdirSync(control, { recursive: true, mode: 0o700 })
    fs.writeFileSync(join(control, 'owners'), 'blocks owner directory', { mode: 0o600 })
    const publisher = new ThreadCatalogueSourcePublisher<{
      appChatId: string
      persistenceRevision: number
    }>({
      profilePath,
      writer: 'desktop',
      writerId: 'writer',
      segmented: false,
      canWrite: () => true,
      project: () => projection(),
      repairSource: async () => captureThreadCatalogueWitness(reader(profilePath), 'chat').witness
    })
    fs.rmSync(join(control, 'owners'), { force: true })
    fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), '{}', { mode: 0o600 })

    const ticket = publisher.begin('chat')
    expect(ticket.untracked).toBe(true)
    publisher.finishAfter(ticket, { appChatId: 'chat', persistenceRevision: 1 }, Promise.resolve())
    await vi.advanceTimersByTimeAsync(0)
    expect(publisher.catalogue.currentRegisteredWriter('desktop')).toBeNull()

    await vi.advanceTimersByTimeAsync(2_100)
    expect(publisher.catalogue.currentRegisteredWriter('desktop')?.writerId).toBe('writer')
    await publisher.dispose()
  })

  it('forgets only erased repair debt and cancels obsolete retries', async () => {
    vi.useFakeTimers()
    const profilePath = profile()
    const repairSource = vi.fn(async (_chatId: string) => {
      throw new Error('temporarily unavailable')
    })
    const publisher = new ThreadCatalogueSourcePublisher({
      profilePath,
      writer: 'desktop',
      writerId: 'writer',
      segmented: false,
      canWrite: () => true,
      repairSource
    })
    publisher.fail(publisher.begin('erased'))
    publisher.fail(publisher.begin('retained'))
    await vi.advanceTimersByTimeAsync(0)
    expect(repairSource.mock.calls.map(([id]) => id)).toEqual(['erased', 'retained'])
    publisher.forgetErased('erased')
    await vi.advanceTimersByTimeAsync(2100)
    expect(repairSource.mock.calls.map(([id]) => id)).toEqual(['erased', 'retained', 'retained'])
    expect(publisher.catalogue.hasOutstandingPublication('erased')).toBe(false)
    publisher.forgetErased()
    const count = repairSource.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(repairSource).toHaveBeenCalledTimes(count)
    await publisher.dispose()
  })

  it('cleans an unescaped publication when an erasure epoch lands after its pending head', () => {
    const profilePath = profile()
    const eraser = new ThreadCatalogue({
      profilePath,
      writer: 'desktop',
      writerId: 'eraser',
      canWrite: () => true,
      writerLifecycle: () => 'active',
      canPublishResolution: () => true,
      canErase: () => true,
      isSourceWitnessCurrent: () => true,
      isIndexedGenerationCommitted: () => true
    })
    let injected = false
    const source = new ThreadCatalogue({
      profilePath,
      writer: 'desktop',
      writerId: 'writer',
      canWrite: () => true,
      writerLifecycle: () => 'active',
      canPublishResolution: () => false,
      canErase: () => false,
      isSourceWitnessCurrent: () => true,
      isIndexedGenerationCommitted: () => false,
      afterAtomicRename: (target) => {
        if (
          !injected &&
          target === join(profilePath, 'thread-catalogue-v1', 'desktop', 'chat.json')
        ) {
          injected = true
          eraser.beginErasure('chat')
        }
      }
    })

    expect(() => source.beginPublication('chat')).toThrow('history erasure')
    expect(source.hasOutstandingPublication('chat')).toBe(false)
  })
})
