/**
 * Erasure of a thread whose checkpoint fold is in the barrier's pool.
 *
 * Under barrier durability, on by default, the store hands the journal its
 * checkpoint pool whole and builds no host reference connector, so the
 * connector's cancellation (JournalConnectorErasure.integration.test.ts,
 * pinned off) never runs. The journal's own erasures must cancel the fold
 * instead: before the files it read are removed, and so that a fold that
 * finishes late can never install a checkpoint for erased history.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CheckpointPreparationSource,
  PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from './hostOwnedErasure.testutil'

/** Each fold the pool started, held until a test settles it. */
const pool = vi.hoisted(() => ({
  started: [] as Array<{
    chatId: string
    journal: string
    cancels: number
    journalAtCancel: boolean | null
    settle: (prepared: unknown) => void
  }>
}))

vi.mock('./CheckpointPreparationWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CheckpointPreparationWorker')>()
  const { existsSync: exists } = await import('node:fs')
  class RecordingPool {
    admits(): boolean {
      return true
    }
    onCapacity(): () => void {
      return () => {}
    }
    start(source: CheckpointPreparationSource) {
      let settle!: (prepared: unknown) => void
      const result = new Promise((resolve) => (settle = resolve))
      const entry = {
        chatId: source.chatId,
        journal: source.journal.path,
        cancels: 0,
        journalAtCancel: null as boolean | null,
        settle
      }
      pool.started.push(entry)
      return {
        output: {
          path: `${source.checkpoint.path}.test-prepared`,
          identity: source.checkpoint.identity
        },
        result,
        cancel: () => {
          entry.cancels += 1
          entry.journalAtCancel ??= exists(entry.journal)
        },
        release: () => {}
      }
    }
  }
  return { ...actual, CheckpointPreparationWorker: RecordingPool }
})

afterEach(async () => {
  pool.started.length = 0
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await disposeHostOwnedStores()
})

const MiB = 1024 * 1024

/**
 * A Host-owned store under barrier durability as it ships, holding a running
 * thread whose lines meet the fold rule, quiet long enough for the journal's
 * idle sweep to start its fold in the pool.
 */
async function folding(chatIds: string[]) {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', undefined)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
  const store = await importHostOwnedStore([])
  const { AppStore } = store
  expect(AppStore.getThreadBarrierDurabilityPerf()).toMatchObject({ enabled: true })
  for (const chatId of chatIds) {
    AppStore.saveChat(chatRecord(chatId, 0))
    const created = AppStore.getChat(chatId)!
    AppStore.saveChat({
      ...created,
      messages: [
        ...created.messages,
        {
          id: 'reply-1',
          role: 'assistant',
          content: 'x'.repeat(MiB + 64 * 1024),
          timestamp: '2026-10-05T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: `${chatId}-run`,
          startedAt: '2026-10-05T00:00:00.000Z',
          status: 'running',
          provider: 'codex'
        }
      ]
    })
  }
  vi.advanceTimersByTime(20_000)
  await vi.waitFor(() => expect(pool.started.map((job) => job.chatId).sort()).toEqual(chatIds))
  return store
}

/** A prepared checkpoint as the pool would report it, for a fold that finishes late. */
function lateResult(chatId: string): PreparedCheckpoint {
  return {
    chatId,
    revision: 2,
    sha256: 'a'.repeat(64),
    identity: { dev: 1, ino: 1, size: 1, mtimeNs: '1' }
  } as unknown as PreparedCheckpoint
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe("erasure of a thread folding in the barrier's pool", () => {
  it('cancels the fold before it removes the thread, and a late fold installs nothing', async () => {
    const { AppStore, journalDirectory } = await folding(['chat-erased'])
    const [fold] = pool.started
    expect(fold.cancels).toBe(0)

    await AppStore.deleteChatViaHost('chat-erased')

    expect(fold.cancels).toBe(1)
    // Cancelled while the lines it was folding were still on disk.
    expect(fold.journalAtCancel).toBe(true)
    expect(existsSync(fold.journal)).toBe(false)
    fold.settle(lateResult('chat-erased'))
    await settled()
    const left = existsSync(journalDirectory)
      ? readdirSync(journalDirectory).filter((name) => name.startsWith('chat-erased.'))
      : []
    expect(left.filter((name) => name.endsWith('.checkpoint.json'))).toEqual([])
    expect(AppStore.getChat('chat-erased')).toBeNull()
  }, 15_000)

  it('cancels every fold at a global clear, before the journal directory goes', async () => {
    const { AppStore, journalDirectory } = await folding(['chat-one', 'chat-two'])

    await AppStore.clearChatsViaHost()

    for (const fold of pool.started) {
      expect(fold.cancels).toBe(1)
      expect(fold.journalAtCancel).toBe(true)
      fold.settle(lateResult(fold.chatId))
    }
    await settled()
    expect(existsSync(join(journalDirectory, 'chat-one.checkpoint.json'))).toBe(false)
    expect(existsSync(join(journalDirectory, 'chat-two.checkpoint.json'))).toBe(false)
  }, 15_000)
})
