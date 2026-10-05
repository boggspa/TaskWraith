import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadCatalogueDiskReader,
  captureThreadCatalogueWitness,
  projectThreadCatalogueRecord
} from './ThreadCatalogueDiskReader'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { createSegmentedChatStore } from './SegmentedChatStore'
import {
  CHECKPOINT_PUBLICATION_ENV,
  FLUSHER_DURABILITY_ENVS,
  THREAD_BARRIER_DURABILITY_ENV
} from './ThreadBarrierDurabilityEnv'
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

describe('a journal a power cut left with a gap', () => {
  const PREFIX = 'owner-catalogue-reader-gap-'
  let profile: string
  let warn: ReturnType<typeof vi.spyOn>

  /** Removes only the folder made below with PREFIX, and refuses anything else. */
  function removeProfile(directory: string): void {
    const own = tmpdir() + sep + PREFIX
    if (directory === tmpdir() || !directory.startsWith(own) || dirname(directory) !== tmpdir())
      throw new Error(`Refusing to remove ${directory}`)
    fs.rmSync(directory, { recursive: true, force: true })
  }

  beforeEach(() => {
    // Each case turns on only what it names; nothing comes from the outer environment.
    for (const name of [
      THREAD_BARRIER_DURABILITY_ENV,
      ...FLUSHER_DURABILITY_ENVS,
      CHECKPOINT_PUBLICATION_ENV
    ]) {
      vi.stubEnv(name, '')
    }
    profile = fs.mkdtempSync(join(tmpdir(), PREFIX))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    removeProfile(profile)
  })

  const at = (revision: number): ChatRecord =>
    record({
      persistenceRevision: revision,
      updatedAt: revision + 1,
      messages: [
        {
          id: 'm',
          role: 'user',
          content: `History at ${revision}`,
          timestamp: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  const line = (from: number): string =>
    `${JSON.stringify(deriveChatRecordMutationWithProjection(at(from), at(from + 1)).batch)}\n`
  const journalDir = (): string => join(profile, 'chat-journal-v2')

  /**
   * The full copy at revision 1. The journal's checkpoint at 1 and its sealed
   * segment to 3 reached the disk, and so did the active segment's line to 5,
   * but not its line to 4: under barrier durability nothing past that gap was
   * ever reported done.
   */
  function gapped(): Record<string, string> {
    fs.mkdirSync(join(profile, 'chats'), { recursive: true })
    fs.writeFileSync(join(profile, 'chats', 'chat.json'), JSON.stringify(at(1)))
    createIncrementalChatJournal(journalDir()).initialize('chat', at(1))
    fs.writeFileSync(join(journalDir(), 'chat.sealed.mutations.jsonl'), line(1) + line(2))
    fs.writeFileSync(join(journalDir(), 'chat.mutations.jsonl'), line(4))
    return files()
  }

  function files(): Record<string, string> {
    return Object.fromEntries(
      fs
        .readdirSync(journalDir())
        .sort()
        .map((name) => [name, fs.readFileSync(join(journalDir(), name), 'utf8')])
    )
  }

  const reader = (): ThreadCatalogueDiskReader =>
    new ThreadCatalogueDiskReader({
      profilePath: profile,
      runtimeInstanceId: 'parent-runtime',
      segmented: false
    })

  it('reads the longest chain under barrier durability, as the app loads it, and moves nothing', () => {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
    const before = gapped()

    const decoded = reader().read('chat')!

    expect(decoded.chat.persistenceRevision).toBe(3)
    expect(decoded.chat.messages[0].content).toBe('History at 3')
    expect(decoded.sourceComplete).toBe(true)
    // Read-only: the segment past the gap is read past, never set aside here.
    expect(files()).toEqual(before)
  })

  it.each([
    ['off', {}],
    [
      'asked for and ignored beside the journal flusher',
      { TASKWRAITH_THREAD_BARRIER_DURABILITY: '1', TASKWRAITH_JOURNAL_FLUSHER: '1' }
    ]
  ])('falls back to the full copy at a gap with barrier durability %s, as before', (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const before = gapped()

    const decoded = reader().read('chat')!

    expect(decoded.chat.persistenceRevision).toBe(1)
    expect(decoded.chat.messages[0].content).toBe('History at 1')
    expect(decoded.sourceComplete).toBe(false)
    expect(files()).toEqual(before)
  })
})
