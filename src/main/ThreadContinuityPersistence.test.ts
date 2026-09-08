import fs from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from './store'
import type { ChatRecord } from './store/types'
import { updateSeatCheckpoint } from '../shared/threadContinuity'

const userDataPath = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  return mkdtempSync(join(tmpdir(), 'taskwraith-continuity-test-'))
})
vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

function fixture(): ChatRecord {
  return {
    appChatId: 'chat',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Continuity',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [],
    runs: []
  }
}
function withCheckpoint(chat: ChatRecord): ChatRecord {
  return {
    ...chat,
    continuityCheckpoints: updateSeatCheckpoint(chat, {
      seatId: '__solo__',
      text: 'PRIVATE_CHECKPOINT_SENTINEL',
      expectedRevision: 0,
      author: { provider: 'codex', runId: 'run' },
      now: '2026-09-05T12:00:00Z'
    })
  }
}

describe('checkpoint persistence boundaries', () => {
  it('protects actual adapter receipts from stale or forged renderer snapshots', () => {
    const initial = {
      ...fixture(),
      runs: [
        {
          runId: 'r',
          provider: 'codex' as const,
          startedAt: '2026-09-05T12:00:00Z',
          status: 'running'
        }
      ]
    }
    const first = AppStore.saveChat(initial)
    const receipt = { key: 'observed', seatId: '__solo__', revision: 1 }
    const received = AppStore.saveChat(
      { ...first, runs: [{ ...first.runs[0], continuityCheckpointDelivery: receipt }] },
      { authoritativeContinuityDelivery: true }
    )
    expect(AppStore.saveChat(first).runs[0].continuityCheckpointDelivery).toEqual(receipt)
    expect(
      AppStore.saveChat({
        ...received,
        runs: [{ ...received.runs[0], continuityCheckpointDelivery: { ...receipt, key: 'forged' } }]
      }).runs[0].continuityCheckpointDelivery
    ).toEqual(receipt)
  })
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })
  afterAll(() => fs.rmSync(userDataPath, { recursive: true, force: true }))

  it('preserves the canonical checkpoint across stale and forged renderer saves', () => {
    const first = AppStore.saveChat(fixture())
    const owned = AppStore.saveChat(withCheckpoint(first), {
      authoritativeContinuityCheckpoints: true
    })
    const stale = AppStore.saveChat({ ...first, title: 'Renamed' })
    expect(stale.continuityCheckpoints).toEqual(owned.continuityCheckpoints)
    const forged = AppStore.saveChat({ ...stale, continuityCheckpoints: undefined })
    expect(forged.continuityCheckpoints).toEqual(owned.continuityCheckpoints)
    AppStore.resetTransientDeletionGuardsForTests()
    expect(AppStore.getChat('chat')?.continuityCheckpoints).toEqual(owned.continuityCheckpoints)
  })

  it('does not accept renderer-authored notes even on a new record', () => {
    expect(AppStore.saveChat(withCheckpoint(fixture())).continuityCheckpoints).toBeUndefined()
  })

  it('keeps checkpoint text out of both chat-list projections', () => {
    const saved = AppStore.saveChat(withCheckpoint(fixture()), {
      authoritativeContinuityCheckpoints: true
    })
    const row = AppStore.toChatListItem(saved)
    expect(JSON.stringify(row)).not.toContain('PRIVATE_CHECKPOINT_SENTINEL')
    expect(
      JSON.stringify(
        AppStore.normalizeChatListItem({
          ...row,
          continuityCheckpoints: saved.continuityCheckpoints
        })
      )
    ).not.toContain('PRIVATE_CHECKPOINT_SENTINEL')
  })

  it('erases checkpoints when the user truncates the transcript', async () => {
    AppStore.saveChat(withCheckpoint(fixture()), { authoritativeContinuityCheckpoints: true })
    expect((await AppStore.truncateChatHistory('chat'))?.continuityCheckpoints).toBeUndefined()
    AppStore.resetTransientDeletionGuardsForTests()
    expect(AppStore.getChat('chat')?.continuityCheckpoints).toBeUndefined()
  })
})
