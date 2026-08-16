/**
 * T4a integration: the dual-write seam between the legacy chat file, the
 * append-only journal, and the chat-list index.
 *
 * WHY THIS FILE EXISTS (DSeekScout's binding edge): the hookup creates THREE
 * durable artifacts per save. `chatJournal.test.ts` proves the journal in
 * isolation; nothing proved that the STORE drives it in the contract order,
 * or that a crash between artifacts converges on recovery. T3b already cost
 * this epic one crash-between-renames scar — this is the same class of bug
 * one layer up.
 *
 * The ordering contract is:
 *   1. legacy `chats/{id}.json`  (read-authoritative)
 *   2. journal append
 *   3. chat-list index entry
 *
 * Only 1->2 is genuinely order-sensitive. The index is NOT ordered against
 * them because it self-heals: `getChatList` validates each entry against the
 * chat file's mtime+size and rebuilds from the file on mismatch. These tests
 * assert that reasoning rather than assuming it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import type { ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-journal-integration-test-${process.pid}`)

// Keep this suite's coalescing window small and independent of the production
// default, so a later retune cannot silently make these tests vacuous.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '50'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatFilePath = (chatId: string): string => join(userDataPath, 'chats', `${chatId}.json`)
const journalDir = (): string => join(userDataPath, 'chat-journal')
const journalFilePath = (chatId: string): string => join(journalDir(), `${chatId}.jsonl`)
const incrementalJournalDir = (): string => join(userDataPath, 'chat-journal-v2')
const incrementalMutationPath = (chatId: string): string =>
  join(incrementalJournalDir(), `${chatId}.mutations.jsonl`)
const incrementalCheckpointPath = (chatId: string): string =>
  join(incrementalJournalDir(), `${chatId}.checkpoint.json`)

function runningRun(runId: string): ChatRun {
  return { runId, startedAt: '2026-05-08T00:00:00.000Z', status: 'running' }
}

function saveChat(appChatId: string, runs: ChatRun[] = []): ChatRecord {
  const chat: ChatRecord = {
    appChatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: appChatId,
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs
  }
  AppStore.saveChat(chat)
  return chat
}

const settleTimers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

/** Every journal artifact belonging to a chat, by filename. */
function journalArtifacts(chatId: string): string[] {
  if (!fs.existsSync(journalDir())) return []
  return fs.readdirSync(journalDir()).filter((name) => name.startsWith(`${chatId}.`))
}

function incrementalJournalArtifacts(chatId: string): string[] {
  if (!fs.existsSync(incrementalJournalDir())) return []
  return fs.readdirSync(incrementalJournalDir()).filter((name) => name.startsWith(`${chatId}.`))
}

describe('T4a chat journal integration', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  describe('dual-write ordering', () => {
    it('mirrors the synchronous first save into the journal', () => {
      saveChat('chat-first')

      // Step 1 and step 2 both completed for the very first save, which takes
      // the synchronous branch because the chat file does not exist yet.
      expect(fs.existsSync(chatFilePath('chat-first'))).toBe(true)
      expect(fs.existsSync(journalFilePath('chat-first'))).toBe(true)
    })

    it('mirrors a coalesced save into the journal only when the write lands', async () => {
      const chat = saveChat('chat-deferred', [runningRun('run-live')])
      const journalAfterFirst = fs.readFileSync(journalFilePath('chat-deferred'), 'utf-8')
      const linesAfterFirst = journalAfterFirst.trim().split('\n').length

      chat.title = 'streaming update'
      AppStore.saveChat(chat)

      // The second save is deferred, so the journal must NOT have grown yet:
      // the journal follows the legacy write, it does not race ahead of it.
      const duringDeferral = fs.readFileSync(journalFilePath('chat-deferred'), 'utf-8')
      expect(duringDeferral.trim().split('\n').length).toBe(linesAfterFirst)

      await settleTimers()

      const afterFlush = fs.readFileSync(journalFilePath('chat-deferred'), 'utf-8')
      expect(afterFlush.trim().split('\n').length).toBe(linesAfterFirst + 1)
      // The legacy file is authoritative and must carry the same update.
      const persisted = JSON.parse(fs.readFileSync(chatFilePath('chat-deferred'), 'utf-8'))
      expect(persisted.title).toBe('streaming update')
    })
  })

  describe('V2 mutation journal parity', () => {
    it('seeds the first durable record as a replay checkpoint', () => {
      const saved = saveChat('chat-v2-first')

      expect(fs.existsSync(incrementalCheckpointPath('chat-v2-first'))).toBe(true)
      expect(fs.existsSync(incrementalMutationPath('chat-v2-first'))).toBe(false)
      const replayed = createIncrementalChatJournal(incrementalJournalDir()).replay('chat-v2-first')
      expect(replayed.record?.persistenceRevision).toBe(saved.persistenceRevision)
      expect(replayed.record?.title).toBe('chat-v2-first')
    })

    it('fsyncs a mutation immediately while the legacy whole record is still deferred', async () => {
      const chat = saveChat('chat-v2-streaming', [runningRun('run-live')])
      chat.title = 'mutation is already durable'
      AppStore.saveChat(chat)

      expect(fs.existsSync(incrementalMutationPath('chat-v2-streaming'))).toBe(true)
      const mutationLine = fs.readFileSync(incrementalMutationPath('chat-v2-streaming'), 'utf8')
      expect(mutationLine).not.toContain('"record"')
      const replayed =
        createIncrementalChatJournal(incrementalJournalDir()).replay('chat-v2-streaming')
      expect(replayed.record?.title).toBe('mutation is already durable')

      const legacyDuringDeferral = JSON.parse(
        fs.readFileSync(chatFilePath('chat-v2-streaming'), 'utf8')
      ) as ChatRecord
      expect(legacyDuringDeferral.title).toBe('chat-v2-streaming')

      await settleTimers()
      const legacyAfterFlush = JSON.parse(
        fs.readFileSync(chatFilePath('chat-v2-streaming'), 'utf8')
      ) as ChatRecord
      expect(legacyAfterFlush.title).toBe('mutation is already durable')
    })

    it('materializes and verifies a checkpoint at the terminal boundary', () => {
      const mismatchesBefore = AppStore.getIncrementalChatPersistenceStats().parityMismatches
      const chat = saveChat('chat-v2-terminal', [runningRun('run-live')])
      chat.title = 'terminal state'
      chat.runs = [
        {
          ...chat.runs[0],
          status: 'success',
          endedAt: '2026-08-16T00:00:01.000Z'
        }
      ]

      AppStore.saveChat(chat)

      expect(fs.existsSync(incrementalMutationPath('chat-v2-terminal'))).toBe(false)
      const checkpoint = JSON.parse(
        fs.readFileSync(incrementalCheckpointPath('chat-v2-terminal'), 'utf8')
      ) as { reason: string; record: ChatRecord }
      expect(checkpoint.reason).toBe('terminal')
      expect(checkpoint.record.title).toBe('terminal state')
      expect(AppStore.getIncrementalChatPersistenceStats().parityMismatches).toBe(mismatchesBefore)
    })

    it('materializes every dirty mutation tail during the shutdown flush', () => {
      const chat = saveChat('chat-v2-shutdown', [runningRun('run-live')])
      chat.title = 'shutdown state'
      AppStore.saveChat(chat)
      expect(fs.existsSync(incrementalMutationPath('chat-v2-shutdown'))).toBe(true)

      AppStore.flushAllChatSaves()

      expect(fs.existsSync(incrementalMutationPath('chat-v2-shutdown'))).toBe(false)
      const checkpoint = JSON.parse(
        fs.readFileSync(incrementalCheckpointPath('chat-v2-shutdown'), 'utf8')
      ) as { reason: string; record: ChatRecord }
      expect(checkpoint.reason).toBe('shutdown')
      expect(checkpoint.record.title).toBe('shutdown state')
    })
  })

  describe('crash convergence', () => {
    it('converges when a crash leaves the legacy file ahead of the journal', async () => {
      const chat = saveChat('chat-crash-a', [runningRun('run-live')])
      chat.title = 'update that only reached the legacy file'
      AppStore.saveChat(chat)
      await settleTimers()

      // Simulate a crash BETWEEN step 1 and step 2: the legacy write landed,
      // the journal append did not. This is the safe direction by design.
      fs.rmSync(journalFilePath('chat-crash-a'), { force: true })

      // Recovery: the legacy file is read-authoritative, so the record is
      // intact and the chat is still listed.
      const recovered = AppStore.getChats().find((c) => c.appChatId === 'chat-crash-a')
      expect(recovered).toBeDefined()
      expect(recovered?.title).toBe('update that only reached the legacy file')
    })

    it('converges when a crash leaves the journal ahead of the index', async () => {
      const chat = saveChat('chat-crash-b', [runningRun('run-live')])
      chat.title = 'update that reached legacy and journal'
      AppStore.saveChat(chat)
      await settleTimers()

      // Simulate a crash BEFORE the index entry was durable by destroying the
      // chat-list index entirely. The index is derived state and must rebuild.
      fs.rmSync(join(userDataPath, 'chat-list-index.jsonl'), { force: true })

      const listed = AppStore.getChatList().find((c) => c.appChatId === 'chat-crash-b')
      expect(listed).toBeDefined()
      expect(listed?.title).toBe('update that reached legacy and journal')
    })

    it('converges when a stale index entry disagrees with the chat file', async () => {
      const chat = saveChat('chat-crash-c', [runningRun('run-live')])
      AppStore.getChatList()

      chat.title = 'newer than the index entry'
      AppStore.saveChat(chat)
      await settleTimers()

      // The index entry was written from the pre-update record; the chat file
      // has since changed. Self-healing means the list must serve the FILE,
      // not the stale entry.
      const listed = AppStore.getChatList().find((c) => c.appChatId === 'chat-crash-c')
      expect(listed?.title).toBe('newer than the index entry')
    })
  })

  describe('history deletion (NON-NEGOTIABLE #4)', () => {
    it('leaves no journal artifact behind for a deleted chat', async () => {
      saveChat('chat-doomed', [runningRun('run-live')])
      await settleTimers()
      expect(journalArtifacts('chat-doomed').length).toBeGreaterThan(0)

      AppStore.deleteChat('chat-doomed')
      await settleTimers()

      // Not just the journal and snapshot: the tombstone marker is NAMED after
      // the chat, so leaving it would keep a deleted chat's id on disk.
      expect(journalArtifacts('chat-doomed')).toEqual([])
      expect(incrementalJournalArtifacts('chat-doomed')).toEqual([])
      expect(fs.existsSync(chatFilePath('chat-doomed'))).toBe(false)
      expect(AppStore.getChats().some((c) => c.appChatId === 'chat-doomed')).toBe(false)
    })

    it('keeps a sibling chat journal intact when one chat is deleted', async () => {
      saveChat('chat-victim', [runningRun('run-v')])
      saveChat('chat-survivor', [runningRun('run-s')])
      await settleTimers()

      AppStore.deleteChat('chat-victim')
      await settleTimers()

      expect(journalArtifacts('chat-victim')).toEqual([])
      expect(incrementalJournalArtifacts('chat-victim')).toEqual([])
      expect(fs.existsSync(journalFilePath('chat-survivor'))).toBe(true)
      expect(incrementalJournalArtifacts('chat-survivor').length).toBeGreaterThan(0)
    })

    it('removes the whole journal directory when all history is cleared', async () => {
      saveChat('chat-one', [runningRun('run-1')])
      saveChat('chat-two', [runningRun('run-2')])
      await settleTimers()
      expect(fs.existsSync(journalDir())).toBe(true)

      AppStore.clearChats()
      await settleTimers()

      // A global delete must not leave a second durable copy of the deleted
      // transcripts sitting in the journal directory.
      expect(fs.existsSync(journalDir())).toBe(false)
      expect(fs.existsSync(incrementalJournalDir())).toBe(false)
      expect(AppStore.getChats()).toHaveLength(0)
    })
  })
})
