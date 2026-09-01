/**
 * Stage 4 — `getChats({ listShells: true })`, the background-sweep shell path.
 *
 * Background id/updatedAt/workspaceId-class sweeps (thread-message targeting,
 * sub-thread control-plane recovery, PR watching, history deletion, the wave
 * cascade's child discovery) used to parse EVERY chat's transcript to read a
 * handful of list-carried fields. The shell path serves the chat-list index
 * row instead, but only when the index can vouch for the bytes on disk (the
 * exact mtimeMs+size pair), and it never changes the DEFAULT: a bare
 * getChats() is still the full canonical read and ChatRecord.messages keeps
 * its complete-transcript meaning.
 *
 * The last test is the load-bearing one for callers: a shell is a summaryOnly
 * row whose messages/runs are EMPTY arrays and saveChat fails closed on it, so
 * a sweep that resolves run rows or saves must hydrate the record by id first
 * (cascadeWaveChildrenOnParentTerminal was the first caller to get that wrong).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatListItem, ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-chat-shell-sweep-${process.pid}`)

// Inline writes: a save lands on disk before it returns, so the index entry it
// writes is born with the stat pair that lets it vouch for the file.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

const chatsDir = join(userDataPath, 'chats')
const chatListIndexPath = join(userDataPath, 'chat-list-index.jsonl')
const summariesDir = join(userDataPath, 'chat-list-summaries')

// Root reads straight through mode 000, which would make the "never opens the
// file" contrast vacuous rather than red.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

function chatPath(chatId: string): string {
  return join(chatsDir, `${chatId}.json`)
}

function run(runId: string, status: 'completed' | 'running'): ChatRun {
  return {
    runId,
    provider: 'claude',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...(status === 'completed' ? { endedAt: '2026-01-01T00:01:00.000Z' } : {}),
    status
  }
}

/** Persist a chat with a real transcript and run rows, so a shell and the
 *  canonical record are distinguishable by more than a marker. */
function persistChat(workspaceId: string, overrides: Partial<ChatRecord>): ChatRecord {
  const base = AppStore.createChat(workspaceId, `/repo/${workspaceId}`)
  return AppStore.saveChat({
    ...base,
    title: `Chat ${base.appChatId}`,
    messages: [
      { id: 'm-1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'm-2', role: 'assistant', content: 'world', timestamp: '2026-01-01T00:00:01.000Z' }
    ],
    runs: [run('run-1', 'completed'), run('run-2', 'running')],
    ...overrides
  } as ChatRecord)
}

function shellSweep(workspaceId?: string): ChatRecord[] {
  return AppStore.getChats(workspaceId, { listShells: true })
}

function findRow(rows: ChatRecord[], chatId: string): ChatRecord {
  const row = rows.find((chat) => chat.appChatId === chatId)
  expect(row, `chat ${chatId} missing from the sweep`).toBeDefined()
  return row as ChatRecord
}

function isShell(row: ChatRecord): boolean {
  return (row as Partial<ChatListItem>).summaryOnly === true
}

describe('getChats({ listShells: true }) background sweep', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  afterEach(() => {
    // A test may have made a chat file unreadable; hand it back before rmSync.
    if (!fs.existsSync(chatsDir)) return
    for (const file of fs.readdirSync(chatsDir)) fs.chmodSync(join(chatsDir, file), 0o644)
  })

  it('serves summary shells from a vouching index and leaves the default sweep canonical', () => {
    const saved = persistChat('ws-1', {
      delegationContext: {
        createdAt: 1,
        parentProvider: 'claude',
        delegationPrompt: 'scout the repo',
        returnResultToParent: false,
        parentAppRunId: 'run-parent',
        lifecycle: 'ephemeral'
      }
    })

    // DEFAULT: unchanged — the complete canonical record.
    const canonical = findRow(AppStore.getChats(), saved.appChatId)
    expect(isShell(canonical)).toBe(false)
    expect(canonical.messages.map((message) => message.id)).toEqual(['m-1', 'm-2'])
    expect(canonical.runs.map((row) => row.runId)).toEqual(['run-1', 'run-2'])

    // SHELL: the list row — list-carried chrome and counts, empty transcript.
    const shell = findRow(shellSweep(), saved.appChatId) as ChatListItem
    expect(shell.summaryOnly).toBe(true)
    expect(shell.messages).toEqual([])
    expect(shell.runs).toEqual([])
    expect(shell.messageCount).toBe(2)
    expect(shell.runCount).toBe(2)
    expect(shell.runsSummary?.map((row) => row.runId)).toEqual(['run-1', 'run-2'])
    expect(shell.lastRun?.runId).toBe('run-2')
    expect(shell.title).toBe(saved.title)
    expect(shell.workspaceId).toBe('ws-1')
    expect(shell.updatedAt).toBe(saved.updatedAt)
    // The wave cascade discovers ephemeral children through exactly this pair.
    expect(shell.delegationContext?.parentAppRunId).toBe('run-parent')
    expect(shell.delegationContext?.lifecycle).toBe('ephemeral')
  })

  it.skipIf(runningAsRoot)('never opens the chat file when the index vouches for it', () => {
    const saved = persistChat('ws-1', {})
    AppStore.clearChatRecordCacheForTests()
    // stat() still answers (that needs the directory, not the file), so the
    // index can vouch — but nothing can read the bytes any more. readJson
    // reports every failed open, which turns "did it open the file?" into a
    // positive observation rather than an argument from silence.
    fs.chmodSync(chatPath(saved.appChatId), 0o000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failedOpens = (): number =>
      consoleError.mock.calls.filter((call) =>
        call.some((arg) => String(arg).includes(saved.appChatId))
      ).length
    try {
      const shell = findRow(shellSweep(), saved.appChatId)
      expect(isShell(shell)).toBe(true)
      expect(shell.title).toBe(saved.title)
      expect(failedOpens()).toBe(0)
      // The canonical read has to open the file, and cannot.
      expect(AppStore.getChats().some((chat) => chat.appChatId === saved.appChatId)).toBe(false)
      expect(failedOpens()).toBeGreaterThan(0)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('falls back to the canonical read when the file no longer matches the index stat pair', () => {
    const saved = persistChat('ws-1', {})
    // Touch the file behind the index: same bytes, different mtime. The EXACT
    // pair is the contract, so the entry can no longer vouch for it.
    const touched = new Date('2030-01-01T00:00:00.000Z')
    fs.utimesSync(chatPath(saved.appChatId), touched, touched)

    const row = findRow(shellSweep(), saved.appChatId)
    expect(isShell(row)).toBe(false)
    expect(row.title).toBe(saved.title)
    expect(row.messages.map((message) => message.id)).toEqual(['m-1', 'm-2'])
    expect(row.runs.map((item) => item.runId)).toEqual(['run-1', 'run-2'])
  })

  it('falls back to the canonical read when the index entry cannot vouch', () => {
    const saved = persistChat('ws-1', {})

    // A row written before runsSummary existed has no summary file: the
    // freshness marker is absent, so the entry must not be served as a shell.
    fs.rmSync(join(summariesDir, `${saved.appChatId}.json`), { force: true })
    // The index store stamps its in-memory cache against the JSONL's own
    // mtime+size. A trailing whitespace-only line (skipped by the parser)
    // forces the re-read without resetting the record cache or the journal
    // the way a whole-store reset would.
    fs.appendFileSync(chatListIndexPath, ' ')
    const withoutSummary = findRow(shellSweep(), saved.appChatId)
    expect(isShell(withoutSummary)).toBe(false)
    expect(withoutSummary.messages).toHaveLength(2)

    // No index at all: every chat takes the canonical read.
    fs.rmSync(chatListIndexPath, { force: true })
    const withoutIndex = findRow(shellSweep(), saved.appChatId)
    expect(isShell(withoutIndex)).toBe(false)
    expect(withoutIndex.messages).toHaveLength(2)
  })

  it('applies the workspace filter and updatedAt ordering to shells', () => {
    const older = persistChat('ws-1', { updatedAt: 1_000 })
    const other = persistChat('ws-2', { updatedAt: 2_000 })
    const newer = persistChat('ws-1', { updatedAt: 3_000 })

    const rows = shellSweep('ws-1')
    expect(rows.map((chat) => chat.appChatId)).toEqual([newer.appChatId, older.appChatId])
    expect(rows.filter(isShell)).toHaveLength(2)
    expect(rows.some((chat) => chat.appChatId === other.appChatId)).toBe(false)
  })

  it('refuses to persist a shell, so run-row consumers must hydrate by id first', () => {
    const saved = persistChat('ws-1', {})
    const shell = findRow(shellSweep(), saved.appChatId)

    // Exactly the shape the wave cascade used to build from a shell: spread the
    // row, restamp a run, save. The fence throws before anything lands.
    expect(() =>
      AppStore.saveChat({
        ...shell,
        runs: shell.runs.map((row) => ({ ...row, status: 'cancelled', cancelled: true })),
        updatedAt: Date.now()
      } as ChatRecord)
    ).toThrow(/summary-only/)

    // Hydrated by id, the same mutation lands on the persisted run row.
    const hydrated = AppStore.getChat(shell.appChatId)
    if (!hydrated) throw new Error('hydrated record missing')
    expect(hydrated.runs.at(-1)?.runId).toBe('run-2')
    const persisted = AppStore.saveChat({
      ...hydrated,
      runs: hydrated.runs.map((row) =>
        row.runId === 'run-2' ? { ...row, status: 'cancelled', cancelled: true } : row
      ),
      updatedAt: Date.now()
    } as ChatRecord)
    expect(persisted.runs.at(-1)).toMatchObject({ runId: 'run-2', status: 'cancelled' })
    expect(AppStore.getChat(shell.appChatId)?.runs.at(-1)?.status).toBe('cancelled')
  })
})
