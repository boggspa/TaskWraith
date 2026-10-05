import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadCatalogueDiskReader } from './ThreadCatalogueDiskReader'
import {
  foldOwnedLogThreadCatalogueMutation,
  preparedThreadDirectory
} from './ThreadCatalogueMutation'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'
import type { ThreadFoldLogBatch } from '../../shared/threadCatalogueTypes'
import type { ChatRecord } from './types'

const CHAT = 'chat-fold'
const FULL_COPY_REVISION = 3
const SAVED_AT = '2026-02-01T10:00:00.000Z'
const EPOCH = { global: 'g', chat: 'c' }
const HEADS = { desktop: null, host: null }

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Folded',
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1_000,
    updatedAt: 2_000,
    persistenceRevision: FULL_COPY_REVISION,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Before the writer died',
        timestamp: '2026-01-01T00:00:00Z'
      }
    ],
    runs: [],
    ...overrides
  } as ChatRecord
}

function batch(
  baseRevision: number,
  revision: number,
  operations: unknown[],
  savedAt = SAVED_AT
): ThreadFoldLogBatch {
  return {
    format: 'taskwraith-chat-mutation',
    version: 1,
    chatId: CHAT,
    baseRevision,
    revision,
    savedAt,
    operations
  }
}

const appendMessage = (id: string): unknown => ({
  type: 'messages_splice',
  index: 1,
  deleteCount: 0,
  messages: [{ id, role: 'assistant', content: `reply ${id}`, timestamp: '2026-02-01T09:59:00Z' }]
})

describe('foldOwnedLogThreadCatalogueMutation', () => {
  let profile: string
  let options: ConstructorParameters<typeof ThreadCatalogueDiskReader>[0]

  function seed(chat: ChatRecord = record()): void {
    fs.mkdirSync(join(profile, 'chats'), { recursive: true })
    fs.writeFileSync(join(profile, 'chats', `${chat.appChatId}.json`), JSON.stringify(chat))
  }
  const witness = (): string => new ThreadCatalogueDiskReader(options).read(CHAT)!.source.witness
  function fold(
    logEntries: ThreadFoldLogBatch[],
    overrides: Partial<{ sourceWitness: string; headRevision: number; updatedAt: string }> = {}
  ): ReturnType<typeof foldOwnedLogThreadCatalogueMutation> {
    return foldOwnedLogThreadCatalogueMutation(options, {
      chatId: CHAT,
      sourceWitness: witness(),
      epoch: EPOCH,
      heads: HEADS,
      headRevision: logEntries[logEntries.length - 1]?.revision ?? FULL_COPY_REVISION,
      updatedAt: SAVED_AT,
      profileAuthority: 'authority-1',
      logEntries,
      ...overrides
    })
  }
  const stagedFiles = (): string[] => {
    try {
      return fs.readdirSync(preparedThreadDirectory(profile, CHAT))
    } catch {
      return []
    }
  }

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-fold-'))
    options = { profilePath: profile, runtimeInstanceId: 'rt', segmented: false }
  })
  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  it('keeps the log head and timestamp on the staged record, checkpoint and projection', () => {
    seed()
    const folded = fold([batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])])!
    expect(folded.headRevision).toBe(4)
    expect(folded.updatedAt).toBe(SAVED_AT)
    expect(folded.previousRevision).toBe(FULL_COPY_REVISION)
    expect(folded.projection.revision).toBe(4)
    expect(folded.projection.summary.updatedAt).toBe(Date.parse(SAVED_AT))
    expect(folded.record.name).toBe(`${folded.foldId}.record.json`)
    const directory = preparedThreadDirectory(profile, CHAT)
    const staged = JSON.parse(fs.readFileSync(join(directory, folded.record.name), 'utf8'))
    expect(staged.persistenceRevision).toBe(4)
    expect(staged.updatedAt).toBe(Date.parse(SAVED_AT))
    expect(staged.createdAt).toBe(1_000)
    expect(staged.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2'])
    const checkpoint = JSON.parse(fs.readFileSync(join(directory, folded.checkpoint.name), 'utf8'))
    expect(checkpoint).toMatchObject({ chatId: CHAT, revision: 4, savedAt: SAVED_AT })
    expect(checkpoint.record.persistenceRevision).toBe(4)
  })

  it('does not touch the canonical file: adoption alone publishes the fold', () => {
    seed()
    const before = fs.readFileSync(join(profile, 'chats', `${CHAT}.json`), 'utf8')
    fold([batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])])
    expect(fs.readFileSync(join(profile, 'chats', `${CHAT}.json`), 'utf8')).toBe(before)
  })

  it('rejects a changed source with source_changed and stages nothing', () => {
    seed()
    expect(() =>
      fold([batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])], { sourceWitness: 'f'.repeat(64) })
    ).toThrow(ThreadCatalogueRequestError)
    try {
      fold([batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])], { sourceWitness: 'f'.repeat(64) })
    } catch (error) {
      expect((error as ThreadCatalogueRequestError).code).toBe('source_changed')
    }
    expect(stagedFiles()).toEqual([])
  })

  it('leaves a missing canonical source unresolved instead of resurrecting it', () => {
    const result = foldOwnedLogThreadCatalogueMutation(options, {
      chatId: CHAT,
      sourceWitness: 'a'.repeat(64),
      epoch: EPOCH,
      heads: HEADS,
      headRevision: 4,
      updatedAt: SAVED_AT,
      profileAuthority: 'authority-1',
      logEntries: [batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])]
    })
    expect(result).toBeNull()
    expect(fs.existsSync(join(profile, 'chats', `${CHAT}.json`))).toBe(false)
    expect(stagedFiles()).toEqual([])
  })

  it('never moves the revision past the log head, whatever the batches patch', () => {
    seed()
    const folded = fold([
      batch(FULL_COPY_REVISION, 4, [appendMessage('m2')]),
      batch(4, 5, [
        {
          type: 'record_patch',
          set: { updatedAt: 9_999_999, createdAt: 5, title: 'Renamed' },
          clear: []
        }
      ])
    ])!
    expect(folded.headRevision).toBe(5)
    const staged = JSON.parse(
      fs.readFileSync(join(preparedThreadDirectory(profile, CHAT), folded.record.name), 'utf8')
    )
    expect(staged.persistenceRevision).toBe(5)
    expect(staged.updatedAt).toBe(Date.parse(SAVED_AT))
    expect(staged.createdAt).toBe(1_000)
    expect(staged.title).toBe('Renamed')
  })

  it('refuses a head that is not the last batch and a log that does not meet the full copy', () => {
    seed()
    expect(() =>
      fold([batch(FULL_COPY_REVISION, 4, [appendMessage('m2')])], { headRevision: 5 })
    ).toThrow(/head/)
    expect(() => fold([batch(7, 8, [appendMessage('m2')])])).toThrow(/revision mismatch/)
    expect(stagedFiles()).toEqual([])
  })

  it('is a no-op for an empty log', () => {
    seed()
    expect(fold([], { headRevision: FULL_COPY_REVISION })).toBeNull()
    expect(stagedFiles()).toEqual([])
  })
})
