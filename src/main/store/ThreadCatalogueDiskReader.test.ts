import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ThreadCatalogueDiskReader,
  captureThreadCatalogueWitness,
  projectThreadCatalogueRecord
} from './ThreadCatalogueDiskReader'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { createSegmentedChatStore } from './SegmentedChatStore'
import type { ChatRecord } from './types'

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat',
    title: 'History',
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 1,
    messages: [
      { id: 'm', role: 'user', content: 'Original history', timestamp: '2026-01-01T00:00:00.000Z' }
    ],
    runs: [],
    ...overrides
  } as ChatRecord
}

describe('isolated canonical history reader', () => {
  let profile: string
  let reader: ThreadCatalogueDiskReader

  function write(chat: ChatRecord): void {
    fs.mkdirSync(join(profile, 'chats'), { recursive: true })
    fs.writeFileSync(join(profile, 'chats', `${chat.appChatId}.json`), JSON.stringify(chat))
  }

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-catalogue-reader-'))
    reader = new ThreadCatalogueDiskReader({
      profilePath: profile,
      runtimeInstanceId: 'parent-runtime',
      segmented: false
    })
  })

  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  it('derives empty recovery state explicitly from a legacy chat', () => {
    write(record())
    const decoded = reader.read('chat')!
    expect(decoded.chat.messages[0].content).toBe('Original history')
    expect(projectThreadCatalogueRecord(decoded.persisted).recovery).toEqual({
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    })
  })

  it('does not certify zero recovery when a leading checkpoint cannot be decoded', () => {
    write(record())
    fs.mkdirSync(join(profile, 'chat-journal-v2'), { recursive: true })
    fs.writeFileSync(
      join(profile, 'chat-journal-v2', 'chat.checkpoint.json'),
      '{"revision":2,"record":'
    )
    const decoded = reader.read('chat')!
    expect(decoded.chat.messages[0].content).toBe('Original history')
    expect(decoded.sourceComplete).toBe(false)
  })

  it('finds a journal-only pending wakeup without modifying either durable source', () => {
    const base = record()
    write(base)
    const journal = createIncrementalChatJournal(join(profile, 'chat-journal-v2'))
    journal.initialize('chat', base)
    const next = record({
      persistenceRevision: 2,
      updatedAt: 3,
      soloWakeups: {
        wake: {
          wakeupId: 'wake',
          chatId: 'chat',
          provider: 'claude',
          status: 'pending',
          scheduledAt: '2026-01-01T00:00:00.000Z',
          wakeAt: '2026-01-02T00:00:00.000Z'
        }
      }
    })
    journal.append(deriveChatRecordMutationWithProjection(base, next).batch)
    const before = captureThreadCatalogueWitness(reader.options, 'chat')
    const decoded = reader.read('chat')!
    expect(decoded.chat.persistenceRevision).toBe(2)
    expect(projectThreadCatalogueRecord(decoded.persisted).recovery.soloWakeups).toBe(1)
    expect(captureThreadCatalogueWitness(reader.options, 'chat')).toEqual(before)
  })

  it('does not resurrect a deleted chat from a healthy segmented mirror', () => {
    const base = record()
    const segmented = createSegmentedChatStore(join(profile, 'chat-store-v2'), {
      enabled: () => true
    })
    segmented.mirrorSave(null, base)
    const withSegments = new ThreadCatalogueDiskReader({ ...reader.options, segmented: true })
    expect(withSegments.read('chat')).toBeNull()
  })

  it('invalidates the witness on a same-revision composer overlay change', () => {
    write(record())
    const before = captureThreadCatalogueWitness(reader.options, 'chat')
    fs.mkdirSync(join(profile, 'chat-composer-selections'), { recursive: true })
    fs.writeFileSync(
      join(profile, 'chat-composer-selections', 'chat.json'),
      JSON.stringify({
        schemaVersion: 1,
        chatId: 'chat',
        baseRevision: 1,
        revision: 2,
        updatedAt: 3,
        providerMetadataPatch: { selectedModelType: 'chosen-model' }
      })
    )
    const after = captureThreadCatalogueWitness(reader.options, 'chat')
    expect(after.witness).not.toBe(before.witness)
    const decoded = reader.read('chat')!
    expect(decoded.chat.persistenceRevision).toBe(1)
    expect(decoded.chat.providerMetadata?.selectedModelType).toBe('chosen-model')
  })

  it('keeps durable projections independent of runtime defaults', () => {
    const legacy = record({
      provider: undefined,
      chatKind: 'ensemble',
      ensemble: undefined,
      createdAt: 0,
      updatedAt: 0
    })
    write(legacy)
    const first = new ThreadCatalogueDiskReader({
      ...reader.options,
      defaultProvider: 'claude'
    }).read('chat')!
    const second = new ThreadCatalogueDiskReader({
      ...reader.options,
      defaultProvider: 'codex',
      runtimeInstanceId: 'next-runtime'
    }).read('chat')!
    expect(projectThreadCatalogueRecord(first.persisted)).toEqual(
      projectThreadCatalogueRecord(second.persisted)
    )
  })
})
