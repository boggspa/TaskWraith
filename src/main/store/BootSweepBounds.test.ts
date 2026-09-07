/**
 * Bounded boot sweeps: the pre-window pass truncates its READS to the most
 * recent candidates instead of parsing the whole corpus.
 *
 * The index-vouch prefilters narrow the candidate SET once the index is fresh,
 * but every uncertainty widens — so a stale index still parsed everything.
 * The budget here is orthogonal: it caps HOW MUCH the pre-window pass may
 * parse, whatever the index says, most-recently modified first. Truncation is
 * a deferral, never a skip: the post-paint sweep reads the remainder.
 *
 * The mode-000 chats are the load-bearing assertions: unreadable files the
 * bounded sweep completes over prove the bound is real rather than rows that
 * merely got filtered after being parsed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord, ChatRun, SoloChatWakeupRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-boot-sweep-bounds-${process.pid}`)

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

function pendingSoloWakeup(chatId: string): SoloChatWakeupRecord {
  return {
    wakeupId: `wakeup-${chatId}`,
    chatId,
    provider: 'claude',
    scheduledAt: '2026-01-01T00:00:00.000Z',
    wakeAt: '2026-01-02T00:00:00.000Z',
    status: 'pending'
  }
}

describe('bounded boot sweeps', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  afterEach(() => {
    if (!fs.existsSync(chatsDir)) return
    for (const file of fs.readdirSync(chatsDir)) fs.chmodSync(join(chatsDir, file), 0o644)
  })

  it('reads only the most recent stale-run candidates within the budget', () => {
    const first = persistChat([run('run-1', 'running')])
    const second = persistChat([run('run-2', 'running')])
    const third = persistChat([run('run-3', 'running')])
    // Deliberately NOT save order: recency rules the bounded pass. Retouching
    // mtimes also breaks the index vouch, which is the stale-index boot case
    // the budget exists for.
    const base = Date.now() / 1000 - 100
    fs.utimesSync(join(chatsDir, `${second.appChatId}.json`), base, base)
    fs.utimesSync(join(chatsDir, `${third.appChatId}.json`), base + 10, base + 10)
    fs.utimesSync(join(chatsDir, `${first.appChatId}.json`), base + 20, base + 20)

    expect(
      AppStore.getChatsForStaleRunSweep({ budget: { maxChats: 1, maxBytes: 1024 ** 3 } }).map(
        (chat) => chat.appChatId
      )
    ).toEqual([first.appChatId])
    expect(
      AppStore.getChatsForStaleRunSweep({ budget: { maxChats: 2, maxBytes: 1024 ** 3 } }).map(
        (chat) => chat.appChatId
      )
    ).toEqual(expect.arrayContaining([first.appChatId, third.appChatId]))
    // Unbounded keeps today's behavior: every candidate is read.
    expect(AppStore.getChatsForStaleRunSweep().map((chat) => chat.appChatId)).toHaveLength(3)
  })

  it('never opens files past the budget, even when the index cannot vouch', () => {
    if (runningAsRoot) return
    const old = persistChat([run('run-1', 'running')])
    const recent = persistChat([run('run-2', 'running')])
    const base = Date.now() / 1000 - 100
    fs.utimesSync(join(chatsDir, `${old.appChatId}.json`), base, base)
    fs.utimesSync(join(chatsDir, `${recent.appChatId}.json`), base + 10, base + 10)
    // If the bounded sweep parsed this record it would throw EACCES.
    fs.chmodSync(join(chatsDir, `${old.appChatId}.json`), 0o000)

    expect(
      AppStore.getChatsForStaleRunSweep({ budget: { maxChats: 1, maxBytes: 1024 ** 3 } }).map(
        (chat) => chat.appChatId
      )
    ).toEqual([recent.appChatId])
  })

  it('always covers the most recent chat, even with a zero budget', () => {
    persistChat([run('run-1', 'running')])
    const recent = persistChat([run('run-2', 'running')])

    expect(
      AppStore.getChatsForStaleRunSweep({ budget: { maxChats: 0, maxBytes: 0 } }).map(
        (chat) => chat.appChatId
      )
    ).toEqual([recent.appChatId])
  })

  it('lists stale-run candidates most-recently modified first without parsing', () => {
    const first = persistChat([run('run-1', 'running')])
    const second = persistChat([run('run-2', 'running')])
    const base = Date.now() / 1000 - 100
    fs.utimesSync(join(chatsDir, `${first.appChatId}.json`), base, base)
    fs.utimesSync(join(chatsDir, `${second.appChatId}.json`), base + 10, base + 10)

    expect(AppStore.listStaleRunSweepCandidates().map((stat) => stat.chatId)).toEqual([
      second.appChatId,
      first.appChatId
    ])
  })

  it('narrows the solo-wakeup sweep to chats with pending wakeups', () => {
    const quiet = persistChat([run('run-1', 'completed')])
    const armedBase = AppStore.createChat('ws-1', '/repo/ws-1')
    const armed = AppStore.saveChat({
      ...armedBase,
      title: `Chat ${armedBase.appChatId}`,
      runs: [run('run-2', 'completed')],
      soloWakeups: { [`wakeup-${armedBase.appChatId}`]: pendingSoloWakeup(armedBase.appChatId) }
    } as ChatRecord)

    expect(AppStore.getChatsWithSoloWakeups().map((chat) => chat.appChatId)).toEqual([
      armed.appChatId
    ])
    expect(quiet.appChatId).not.toEqual(armed.appChatId)
  })

  it('bounds the solo-wakeup reads to the most recent candidates', () => {
    const firstBase = AppStore.createChat('ws-1', '/repo/ws-1')
    const first = AppStore.saveChat({
      ...firstBase,
      runs: [],
      soloWakeups: { [`wakeup-${firstBase.appChatId}`]: pendingSoloWakeup(firstBase.appChatId) }
    } as ChatRecord)
    const secondBase = AppStore.createChat('ws-1', '/repo/ws-1')
    const second = AppStore.saveChat({
      ...secondBase,
      runs: [],
      soloWakeups: { [`wakeup-${secondBase.appChatId}`]: pendingSoloWakeup(secondBase.appChatId) }
    } as ChatRecord)
    expect(first.appChatId).not.toEqual(second.appChatId)

    expect(
      AppStore.getChatsWithSoloWakeups({ budget: { maxChats: 1, maxBytes: 1024 ** 3 } }).map(
        (chat) => chat.appChatId
      )
    ).toEqual([second.appChatId])
  })

  it('narrows sub-thread recovery to sub-threads with worker control', () => {
    const solo = persistChat([run('run-1', 'completed')])
    const parent = persistChat([run('run-2', 'completed')])
    const childBase = AppStore.createChat('ws-1', '/repo/ws-1')
    const child = AppStore.saveChat({
      ...childBase,
      title: `Chat ${childBase.appChatId}`,
      parentChatId: parent.appChatId,
      runs: [],
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: 'claude',
        delegationPrompt: 'do the thing',
        returnResultToParent: false,
        workerControl: { schemaVersion: 1, attachedAt: new Date().toISOString(), events: [] }
      }
    } as ChatRecord)

    const swept = AppStore.getSubThreadRecoveryChats().map((chat) => chat.appChatId)
    expect(swept).toEqual([child.appChatId])
    expect(swept).not.toContain(solo.appChatId)
    expect(swept).not.toContain(parent.appChatId)
  })
})
