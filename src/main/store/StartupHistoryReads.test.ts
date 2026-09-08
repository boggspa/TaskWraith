import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppStore } from '../store'
import type { ChatRecord } from './types'

const profilePath = vi.hoisted(() => `/tmp/taskwraith-startup-history-reads-${process.pid}`)
const ioProbe = vi.hoisted(() => ({ enabled: false, files: [] as string[] }))
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})
vi.mock('electron', () => ({ app: { getPath: () => profilePath } }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    if (
      ioProbe.enabled &&
      typeof args[0] === 'string' &&
      args[0].startsWith(`${profilePath}/chats/`)
    ) {
      ioProbe.files.push(args[0])
    }
    return Reflect.apply(actual.readFileSync, actual, args)
  }
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

const chatsDir = join(profilePath, 'chats')

/** Seed disk directly: saveChat would warm the very caches a cold boot lacks. */
function seedColdHistory(count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const chatId = `history-${String(index).padStart(3, '0')}`
    const record = {
      appChatId: chatId,
      title: chatId,
      provider: 'claude',
      chatKind: 'single',
      scope: 'workspace',
      workspaceId: 'workspace',
      workspacePath: '/workspace',
      createdAt: index + 1,
      updatedAt: index + 1,
      messages: [
        {
          id: 'message',
          role: 'user',
          content: 'Historical transcript body',
          timestamp: '2026-09-01T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: `run-${index}`,
          provider: 'claude',
          status: 'running',
          startedAt: '2026-09-01T00:00:00.000Z'
        }
      ]
    } as ChatRecord
    const filePath = join(chatsDir, `${chatId}.json`)
    fs.writeFileSync(filePath, JSON.stringify(record))
    fs.utimesSync(filePath, index + 1, index + 1)
    ids.push(chatId)
  }
  return ids
}

function observeHistoricalReads(): () => string[] {
  ioProbe.files = []
  ioProbe.enabled = true
  return () => [...ioProbe.files]
}

describe('cold startup history I/O', () => {
  beforeEach(() => {
    ioProbe.enabled = false
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(profilePath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  afterEach(() => {
    ioProbe.enabled = false
    vi.restoreAllMocks()
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(profilePath, { recursive: true, force: true })
  })

  it('lists recovery candidates without opening transcript bodies when the index is missing', () => {
    const ids = seedColdHistory(30)
    const reads = observeHistoricalReads()

    const candidates = AppStore.listStaleRunSweepCandidates()

    expect(candidates.map((candidate) => candidate.chatId).sort()).toEqual(ids)
    expect(reads()).toEqual([])
  })

  it('applies a one-chat recovery budget to physical reads, including orphan discovery', () => {
    const ids = seedColdHistory(30)
    const reads = observeHistoricalReads()

    const records = AppStore.getChatsForStaleRunSweep({
      budget: { maxChats: 1, maxBytes: 1024 * 1024 }
    })

    expect(records.map((record) => record.appChatId)).toEqual([ids.at(-1)])
    expect(reads()).toEqual([join(chatsDir, `${ids.at(-1)}.json`)])
  })
})
