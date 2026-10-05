/**
 * Threads the history worker cannot settle at once. While a running writer
 * keeps a publication open, the worker imports the thread again after waits
 * that double from the first to a cap, a change to the thread starts them
 * again from the first, and each retry is counted. A thread held by a head
 * and a ticket left without their bytes is settled by the real worker and
 * decoder, on the strict path, without anyone touching it.
 */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogue } from './ThreadCatalogue'
import {
  THREAD_CATALOGUE_RETRY_BASE_MS,
  THREAD_CATALOGUE_RETRY_MAX_MS,
  ThreadCatalogueWorkerService
} from './ThreadCatalogueWorkerService'

const CHAT = 'chat'

describe('a thread the history worker cannot settle yet', () => {
  let profile: string
  let service: ThreadCatalogueWorkerService
  /** Milliseconds from the start of the test at which each import reached the catalogue. */
  let attempts: number[]
  let start: number

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    profile = fs.mkdtempSync(join(tmpdir(), 'catalogue-retry-'))
    fs.mkdirSync(join(profile, 'chats'))
    fs.writeFileSync(join(profile, 'chats', `${CHAT}.json`), JSON.stringify({ appChatId: CHAT }))
    const writer = new ThreadCatalogue({
      profilePath: profile,
      writer: 'desktop',
      writerId: 'writer-1',
      canWrite: () => true,
      writerLifecycle: () => 'active',
      canPublishResolution: () => false,
      canErase: () => false,
      isSourceWitnessCurrent: () => true,
      isIndexedGenerationCommitted: () => false
    })
    writer.registerWriter()
    writer.beginPublication(CHAT)
    service = new ThreadCatalogueWorkerService({
      reader: { profilePath: profile, runtimeInstanceId: 'retry-test', segmented: false },
      decoderPath: join(profile, 'decoder-is-not-needed.cjs'),
      writer: 'host',
      writerId: 'resolver',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })
    attempts = []
    start = Date.now()
    const pending = service.catalogue.publicationPending.bind(service.catalogue)
    vi.spyOn(service.catalogue, 'publicationPending').mockImplementation((chatId) => {
      attempts.push(Date.now() - start)
      return pending(chatId)
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await service.dispose()
    fs.rmSync(profile, { recursive: true, force: true })
  })

  it('waits twice as long after each import that could not settle it, up to the cap', async () => {
    service.notifyChanged(CHAT)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(THREAD_CATALOGUE_RETRY_BASE_MS).toBe(100)
    expect(THREAD_CATALOGUE_RETRY_MAX_MS).toBe(5_000)
    const capped = Array.from({ length: 10 }, (_unused, index) => 6_400 + 5_000 * (index + 1))
    expect(attempts).toEqual([100, 200, 400, 800, 1_600, 3_200, 6_400, ...capped])
    expect(service.retryStats()).toEqual({
      scheduled: attempts.length,
      waiting: 1,
      longestWaitMs: 5_000
    })
  })

  it('starts again from the first wait when the thread changes', async () => {
    service.notifyChanged(CHAT)
    await vi.advanceTimersByTimeAsync(20_000)
    const before = attempts.length

    service.notifyChanged(CHAT)
    await vi.advanceTimersByTimeAsync(1_000)

    const since = attempts.slice(before).map((at) => at - 20_000)
    expect(since).toEqual([100, 200, 400, 800])
  })

  it('stops counting a thread as waiting once it no longer needs a retry', async () => {
    service.notifyChanged(CHAT)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(service.retryStats().waiting).toBe(1)

    // Settled elsewhere: the next import finds the thread current.
    vi.spyOn(service, 'ensureIndexed').mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(service.retryStats().waiting).toBe(0)
    const settledAt = attempts.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toHaveLength(settledAt)
  })

  it('stops counting a thread as waiting once an import fails for good', async () => {
    service.notifyChanged(CHAT)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(service.retryStats().waiting).toBe(1)

    vi.spyOn(service, 'ensureIndexed').mockRejectedValue(new Error('History source is damaged'))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(service.retryStats().waiting).toBe(0)
  })
})

describe('a thread held by a head and a ticket left without their bytes', () => {
  let directory: string
  let decoderPath: string
  let profile: string

  beforeAll(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'catalogue-damaged-decoder-'))
    decoderPath = join(directory, 'decoder.cjs')
    await build({
      entryPoints: ['src/main/workers/threadCatalogueDecoder.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: decoderPath,
      logLevel: 'silent'
    })
  })

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'catalogue-damaged-profile-'))
    fs.mkdirSync(join(profile, 'chats'))
    fs.writeFileSync(
      join(profile, 'chats', `${CHAT}.json`),
      JSON.stringify({
        appChatId: CHAT,
        title: 'Stranded history',
        provider: 'claude',
        scope: 'global',
        createdAt: 1,
        updatedAt: 1,
        persistenceRevision: 1,
        messages: [],
        runs: []
      })
    )
  })

  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  /**
   * A ticket left without its bytes by `desktop-1`, which is gone, and its
   * head left the same way unless `head` keeps it pending.
   */
  function strand(head: 'damaged' | 'pending' = 'damaged'): { ticketFile: string } {
    const writer = new ThreadCatalogue({
      profilePath: profile,
      writer: 'desktop',
      writerId: 'desktop-1',
      canWrite: () => true,
      writerLifecycle: () => 'active',
      canPublishResolution: () => false,
      canErase: () => false,
      isSourceWitnessCurrent: () => true,
      isIndexedGenerationCommitted: () => false
    })
    writer.registerWriter()
    const ticket = writer.beginPublication(CHAT)
    const headFile = join(writer.directory, 'desktop', `${CHAT}.json`)
    const ticketFile = join(
      writer.directory,
      'pending',
      'desktop',
      CHAT,
      `${ticket.operationId}.json`
    )
    fs.writeFileSync(ticketFile, '')
    if (head === 'damaged') fs.writeFileSync(headFile, Buffer.alloc(fs.statSync(headFile).size))
    return { ticketFile }
  }

  function worker(assertSourceAuthority: () => void): ThreadCatalogueWorkerService {
    return new ThreadCatalogueWorkerService({
      reader: { profilePath: profile, runtimeInstanceId: 'desktop-2', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'desktop-2',
      writerLifecycle: (_writer, id) => (id === 'desktop-2' ? 'active' : 'retired'),
      assertSourceAuthority
    })
  }

  it('is listed again by the worker started after the writer that left them, with nothing left to repair', async () => {
    const { ticketFile } = strand()
    const service = worker(() => {})
    try {
      await service.refreshInventory()
      const entry = await service.ensureIndexed(CHAT, 'metadata')

      expect(entry?.projection.summary.title).toBe('Stranded history')
      expect(service.catalogue.read(CHAT)).toMatchObject({ status: 'ready' })
      expect(fs.existsSync(ticketFile)).toBe(false)
      expect(service.catalogue.repairChatIds()).toEqual([])
      const listed = service.database.list()
      expect(listed.entries.map((indexed) => indexed.chatId)).toEqual([CHAT])
      expect(listed.coverage).toBe('complete')
    } finally {
      await service.dispose()
    }
  })

  it('stays unsettled, to be imported again, while the worker cannot prove the sources durable', async () => {
    const { ticketFile } = strand()
    const service = worker(() => {
      throw new Error('History source authority is unavailable')
    })
    try {
      await expect(service.ensureIndexed(CHAT, 'metadata')).rejects.toMatchObject({
        code: 'source_unsettled'
      })
      expect(fs.existsSync(ticketFile)).toBe(true)
      expect(service.catalogue.repairChatIds()).toEqual([CHAT])
    } finally {
      await service.dispose()
    }
  })

  it('fails as it did before when a debt other than a damaged file cannot be proven', async () => {
    strand('pending')
    const service = worker(() => {
      throw new Error('History source authority is unavailable')
    })
    try {
      const failure = await service.ensureIndexed(CHAT, 'metadata').catch((error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toHaveProperty('code')
      expect((failure as Error).message).toBe('History source authority is unavailable')
    } finally {
      await service.dispose()
    }
  })

  it('reports as it is a request error met while proving the sources durable', async () => {
    strand()
    const source = join(profile, 'chats', `${CHAT}.json`)
    let asked = 0
    const service = worker(() => {
      asked += 1
      // The thread changes after the flush has taken its first look at it.
      if (asked === 2) {
        const later = new Date(Date.now() + 60_000)
        fs.utimesSync(source, later, later)
      }
    })
    try {
      await expect(service.ensureIndexed(CHAT, 'metadata')).rejects.toMatchObject({
        code: 'source_changed'
      })
    } finally {
      await service.dispose()
    }
  })
})
