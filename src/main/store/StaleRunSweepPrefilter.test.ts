/**
 * Part 2 — `getChatsForStaleRunSweep()`, the pre-window stale-run source.
 *
 * The boot reconcile pass used a bare `getChats()`, parsing every record on
 * the main thread before the first paint to reach the few chats holding an
 * unsettled run. This narrows that sweep by the vouched chat-list summaries
 * and reads only the candidates.
 *
 * The mode-000 chat is the load-bearing assertion: an unreadable file the
 * sweep still completes over proves the skip is real rather than a row that
 * merely got filtered after being parsed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-stale-run-prefilter-${process.pid}`)

vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

const chatsDir = join(userDataPath, 'chats')

// Root reads straight through mode 000, which would make the "never opens the
// file" contrast vacuous rather than red.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

function run(runId: string, status: 'completed' | 'running'): ChatRun {
  return {
    runId,
    provider: 'claude',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...(status === 'completed' ? { endedAt: '2026-01-01T00:01:00.000Z' } : {}),
    status
  } as ChatRun
}

function persistChat(runs: ChatRun[]): ChatRecord {
  const base = AppStore.createChat('ws-1', '/repo/ws-1')
  return AppStore.saveChat({
    ...base,
    title: `Chat ${base.appChatId}`,
    messages: [
      { id: 'm-1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' }
    ],
    runs
  } as ChatRecord)
}

function sweptIds(): string[] {
  return AppStore.getChatsForStaleRunSweep().map((chat) => chat.appChatId)
}

describe('getChatsForStaleRunSweep', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  afterEach(() => {
    if (!fs.existsSync(chatsDir)) return
    for (const file of fs.readdirSync(chatsDir)) fs.chmodSync(join(chatsDir, file), 0o644)
  })

  it('returns the chat holding an unsettled run, with its canonical runs', () => {
    const open = persistChat([run('run-1', 'completed'), run('run-2', 'running')])
    const swept = AppStore.getChatsForStaleRunSweep()
    expect(swept.map((chat) => chat.appChatId)).toEqual([open.appChatId])
    expect(swept[0].runs.map((row) => row.runId)).toEqual(['run-1', 'run-2'])
  })

  it('never opens a vouched chat whose summarised runs have all ended', () => {
    if (runningAsRoot) return
    const settled = persistChat([run('run-1', 'completed')])
    const open = persistChat([run('run-2', 'running')])
    // If the sweep parsed this record it would throw EACCES, not skip it.
    fs.chmodSync(join(chatsDir, `${settled.appChatId}.json`), 0o000)

    expect(sweptIds()).toEqual([open.appChatId])
  })

  it('still reads a settled-looking chat once the index can no longer vouch', () => {
    const settled = persistChat([run('run-1', 'completed')])
    // Same summary row, different bytes: the stat pair no longer matches, so
    // the prefilter must fall back to the canonical read rather than trust it.
    const target = join(chatsDir, `${settled.appChatId}.json`)
    const record = JSON.parse(fs.readFileSync(target, 'utf-8')) as ChatRecord
    record.runs = [run('run-1', 'running')]
    fs.writeFileSync(target, JSON.stringify(record))

    expect(sweptIds()).toEqual([settled.appChatId])
  })
})
