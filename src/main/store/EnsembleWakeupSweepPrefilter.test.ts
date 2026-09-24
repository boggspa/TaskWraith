/**
 * Part 2b — `getChatsWithEnsembleWakeups()`, the pre-window wakeup source.
 *
 * Boot recovery flatMapped `ensemble.wakeups` across a bare `getChats()`,
 * parsing every record on the main thread before the first paint. This narrows
 * that sweep to rows the index can vouch for whose counted wakeups are not
 * zero, and reads only those.
 *
 * The mode-000 chat is the load-bearing assertion: a file the sweep completes
 * over without EACCES was never opened, which a post-parse filter could not
 * manage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord, EnsembleWakeupRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-wakeup-prefilter-${process.pid}`)

vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

const chatsDir = join(userDataPath, 'chats')

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

function wakeup(chatId: string, wakeupId: string): EnsembleWakeupRecord {
  return {
    wakeupId,
    chatId,
    roundId: 'round-1',
    participantId: 'p-1',
    provider: 'claude',
    scheduledAt: '2026-01-01T00:00:00.000Z',
    wakeAt: '2026-01-01T01:00:00.000Z',
    status: 'pending'
  } as EnsembleWakeupRecord
}

function persistEnsembleChat(wakeups: Record<string, EnsembleWakeupRecord>): ChatRecord {
  const base = AppStore.createChat('ws-1', '/repo/ws-1')
  const saved = AppStore.saveChat({
    ...base,
    title: `Chat ${base.appChatId}`,
    chatKind: 'ensemble',
    messages: [{ id: 'm-1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }],
    runs: [],
    ensemble: { ...(base.ensemble || {}), wakeups }
  } as unknown as ChatRecord)
  return saved
}

function sweptIds(): string[] {
  return AppStore.getChatsWithEnsembleWakeups().map((chat) => chat.appChatId)
}

describe('getChatsWithEnsembleWakeups', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  afterEach(() => {
    if (!fs.existsSync(chatsDir)) return
    for (const file of fs.readdirSync(chatsDir)) fs.chmodSync(join(chatsDir, file), 0o644)
  })

  it('returns the chat holding a wakeup, with the record readable off it', () => {
    const armed = persistEnsembleChat({ 'w-1': wakeup('placeholder', 'w-1') })
    const swept = AppStore.getChatsWithEnsembleWakeups()
    expect(swept.map((chat) => chat.appChatId)).toEqual([armed.appChatId])
    expect(Object.values(swept[0].ensemble?.wakeups || {}).map((row) => row.wakeupId)).toEqual([
      'w-1'
    ])
  })

  it('never opens a vouched chat whose row counted no wakeups', () => {
    if (runningAsRoot) return
    const quiet = persistEnsembleChat({})
    const armed = persistEnsembleChat({ 'w-1': wakeup('placeholder', 'w-1') })
    // Parsing this record would throw EACCES rather than skip it.
    fs.chmodSync(join(chatsDir, `${quiet.appChatId}.json`), 0o000)

    expect(sweptIds()).toEqual([armed.appChatId])
  })

  it('still reads a chat once the index can no longer vouch for its bytes', () => {
    const quiet = persistEnsembleChat({})
    const target = join(chatsDir, `${quiet.appChatId}.json`)
    const record = JSON.parse(fs.readFileSync(target, 'utf-8')) as ChatRecord
    ;(record.ensemble as { wakeups?: unknown }).wakeups = {
      'w-late': wakeup(quiet.appChatId, 'w-late')
    }
    fs.writeFileSync(target, JSON.stringify(record))

    expect(sweptIds()).toEqual([quiet.appChatId])
  })
})
