import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// This file proves the host reference connector's cancellation at erasure. The
// store builds that connector only for the earlier mechanisms' checkpoint
// worker, with barrier durability off. Barrier durability is on by default and
// the store reads its switch once, at load, so it is pinned off here with the
// exact token `0` before the store is imported. Under the switch the journal
// cancels the folds in the barrier's own pool; that is proven in
// JournalPreparationErasure.barrier.integration.test.ts.
vi.hoisted(() => {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const calls = vi.hoisted(() => ({ cancelChat: vi.fn(), cancelAll: vi.fn() }))
const profile = vi.hoisted(() => `/tmp/taskwraith-connector-erasure-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
vi.mock('./CheckpointPreparationWorker', () => ({
  isCheckpointPreparationWorkerEnabled: () => true,
  CheckpointPreparationWorker: class {
    start() {
      return null
    }
  }
}))
vi.mock('./JournalHostReferenceConnector', () => ({
  JournalHostReferenceConnector: class {
    cancelChat = calls.cancelChat
    cancelAll = calls.cancelAll
    checkpointPort(base: unknown) {
      return base
    }
  }
}))
import { AppStore } from '../store'

describe('actual Store connector erasure boundaries', () => {
  it('cancels scoped preparations before legacy journal purge', () => {
    const chatId = '55555555-5555-4555-8555-555555555555'
    const journal = path.join(profile, 'chat-journal-v2', `${chatId}.mutations.jsonl`)
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, 'pending\n')
    calls.cancelChat.mockImplementationOnce((id) => {
      expect(id).toBe(chatId)
      expect(fs.existsSync(journal)).toBe(true)
    })
    const store = AppStore as unknown as {
      executeHistoryDeletionStep(
        intent: { kind: string; chatIds: string[]; runIds: string[] },
        step: string
      ): void
    }
    store.executeHistoryDeletionStep(
      { kind: 'chat', chatIds: [chatId], runIds: [] },
      'chat-records'
    )
    expect(calls.cancelChat).toHaveBeenCalledWith(chatId)
    expect(fs.existsSync(journal)).toBe(false)
  })

  it('cancels all preparations before global clear and reset', () => {
    const store = AppStore as unknown as {
      executeHistoryDeletionStep(
        intent: { kind: string; chatIds: string[]; runIds: string[] },
        step: string
      ): void
    }
    calls.cancelAll.mockClear()
    store.executeHistoryDeletionStep({ kind: 'global', chatIds: [], runIds: [] }, 'chat-records')
    expect(calls.cancelAll).toHaveBeenCalledOnce()
    AppStore.resetTransientDeletionGuardsForTests()
    expect(calls.cancelAll).toHaveBeenCalledTimes(2)
  })
})
