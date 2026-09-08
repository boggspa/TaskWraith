import { createHash } from 'node:crypto'
import { encodeThreadJsonChunks } from './ThreadCatalogueJson'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ThreadCatalogueDatabase,
  THREAD_INDEX_CHUNK_BYTES,
  THREAD_INDEX_MAX_REPLY_BYTES,
  type ThreadIndexedGeneration,
  type ThreadIndexedObjectKind
} from './ThreadCatalogueDatabase'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'

function projection(
  chatId: string,
  updatedAt = 1,
  counts: { messages?: number; runs?: number } = {}
): ThreadCatalogueProjection {
  return {
    revision: 1,
    summary: {
      chatId,
      title: chatId,
      provider: 'claude',
      scope: 'workspace',
      chatKind: 'single',
      workspaceId: 'workspace',
      createdAt: 1,
      updatedAt,
      archived: false,
      messageCount: counts.messages ?? 0,
      runCount: counts.runs ?? 0
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

describe('worker-owned thread query index', () => {
  let directory: string
  let database: ThreadCatalogueDatabase
  let publications: Map<string, { generation: string; id: string }>
  let known: Set<string>

  function openDatabase(): ThreadCatalogueDatabase {
    return new ThreadCatalogueDatabase(directory, {
      isPublicationCurrent: (generation, id) =>
        publications.get(generation.chatId)?.generation === generation.generation &&
        publications.get(generation.chatId)?.id === id,
      isInventoryCurrent: (witness) => witness === 'inventory',
      hasUnresolvedPublications: () => false
    })
  }

  function activate(generation: ThreadIndexedGeneration): boolean {
    const id = `publication-${generation.generation}`
    publications.set(generation.chatId, { generation: generation.generation, id })
    database.setInventory([...known], 'inventory')
    return database.activateGeneration(generation, id)
  }

  function begin(chatId = 'chat', witness = 'source-1'): ThreadIndexedGeneration {
    known.add(chatId)
    return database.beginGeneration({
      chatId,
      sourceWitness: witness,
      epoch: { global: 'global-1', chat: 'chat-1' },
      heads: { desktop: null, host: null }
    })
  }

  function publish(
    generation: ThreadIndexedGeneration,
    updatedAt = 1,
    counts: { messages?: number; runs?: number } = {}
  ): void {
    if (counts.messages !== undefined) database.sealKind(generation, 'message', counts.messages)
    if (counts.runs !== undefined) database.sealKind(generation, 'run-locator', counts.runs)
    database.commitGeneration(generation, projection(generation.chatId, updatedAt, counts))
    expect(activate(generation)).toBe(true)
  }

  function writeObjects(
    generation: ThreadIndexedGeneration,
    objects: readonly {
      kind: ThreadIndexedObjectKind
      ordinal: number
      recordId: string
      value: unknown
      preview: unknown
    }[]
  ): void {
    for (const item of objects) {
      database.writeObjectFrames(generation, [
        {
          type: 'start',
          kind: item.kind,
          ordinal: item.ordinal,
          recordId: item.recordId,
          previewJson: JSON.stringify(item.preview)
        }
      ])
      const hash = createHash('sha256')
      let bytes = 0
      let chunkNo = 0
      for (const payload of encodeThreadJsonChunks(item.value)) {
        hash.update(payload)
        bytes += payload.byteLength
        database.writeObjectFrames(generation, [
          { type: 'chunk', kind: item.kind, ordinal: item.ordinal, chunkNo: chunkNo++, payload }
        ])
      }
      database.writeObjectFrames(generation, [
        {
          type: 'finish',
          kind: item.kind,
          ordinal: item.ordinal,
          byteLength: bytes,
          sha256: hash.digest('hex')
        }
      ])
    }
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'thread-query-index-'))
    publications = new Map()
    known = new Set()
    database = openDatabase()
  })

  afterEach(() => {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('keeps partial and committed-but-unpublished imports invisible', () => {
    const generation = begin()
    writeObjects(generation, [
      {
        kind: 'message',
        ordinal: 0,
        recordId: 'm',
        value: { id: 'm', content: 'history' },
        preview: { id: 'm' }
      }
    ])
    expect(database.isCommitted(generation)).toBe(false)
    expect(database.readObjects(generation, 'message')).toBeNull()
    expect(database.list().entries).toEqual([])
    database.commitGeneration(generation, projection('chat'))
    expect(database.isCommitted(generation)).toBe(true)
    expect(database.list().entries).toEqual([])
    expect(activate(generation)).toBe(true)
    expect(database.list().entries.map((entry) => entry.chatId)).toEqual(['chat'])
  })

  it('never seals an unfinished recovery record as complete', () => {
    const generation = begin()
    database.writeObjectFrames(generation, [
      { type: 'start', kind: 'recovery', ordinal: 0, recordId: 'run:pending', previewJson: '{}' }
    ])
    expect(() => database.sealKind(generation, 'recovery', 1)).toThrow('incomplete')
    expect(database.readObjects(generation, 'recovery')).toBeNull()
  })

  it('rejects a run locator after its source publication is invalidated', () => {
    const generation = begin()
    database.writeRunLocators(generation, [{ ordinal: 0, runId: 'run' }])
    publish(generation, 1, { runs: 1 })
    publications.delete('chat')
    expect(() => database.findRun('run')).toThrow('repair')
  })

  it('does not activate an older completion over a newer resolved publication', () => {
    const old = begin()
    const next = begin('chat', 'source-2')
    database.commitGeneration(old, projection('chat'))
    database.commitGeneration(next, projection('chat', 2))
    expect(activate(next)).toBe(true)
    expect(database.activateGeneration(old, `publication-${old.generation}`)).toBe(false)
    expect(database.current('chat')?.generation).toBe(next.generation)
  })

  it('preserves staging and committed-awaiting-publication generations during pruning', () => {
    publish(begin())
    const staging = begin('chat', 'staging')
    const pending = begin('chat', 'pending')
    database.commitGeneration(pending, projection('chat'))
    database.pruneSuperseded('chat')
    database.commitGeneration(staging, projection('chat'))
    expect(database.isCommitted(staging)).toBe(true)
    expect(database.isCommitted(pending)).toBe(true)
  })

  it('checks database generation and source identity independently after restart', () => {
    const generation = begin()
    publish(generation)
    database.close()
    database = openDatabase()
    expect(database.isCommitted(generation)).toBe(true)
    expect(database.isCommitted({ ...generation, generation: 'missing' })).toBe(false)
    expect(database.isCommitted({ ...generation, sourceWitness: 'stale' })).toBe(false)
    expect(
      database.isCommitted({ ...generation, epoch: { ...generation.epoch, chat: 'erased' } })
    ).toBe(false)
  })

  it('pages from a deep cursor without requiring earlier transcript objects', () => {
    const generation = begin()
    for (let first = 0; first < 1000; first += 100) {
      writeObjects(
        generation,
        Array.from({ length: 100 }, (_, index) => {
          const ordinal = first + index
          return {
            kind: 'message' as const,
            ordinal,
            recordId: `message-${ordinal}`,
            value: { id: `message-${ordinal}`, content: `Content ${ordinal}` },
            preview: { id: `message-${ordinal}` }
          }
        })
      )
    }
    publish(generation, 1, { messages: 1000 })
    expect(database.findOrdinal(generation, 'message', 'message-900')).toBe(900)
    const page = database.readObjects(generation, 'message', { before: 900, maxObjects: 3 })
    expect(page?.map((entry) => entry.ordinal)).toEqual([897, 898, 899])
  }, 15_000)

  it('preserves duplicate historical message IDs by ordinal', () => {
    const generation = begin()
    writeObjects(
      generation,
      [0, 1].map((ordinal) => ({
        kind: 'message',
        ordinal,
        recordId: 'duplicate',
        value: { id: 'duplicate', content: `Copy ${ordinal}` },
        preview: { id: 'duplicate' }
      }))
    )
    publish(generation, 1, { messages: 2 })
    expect(database.findOrdinal(generation, 'message', 'duplicate')).toBe(0)
    expect(database.readObjects(generation, 'message')?.map((entry) => entry.ordinal)).toEqual([
      0, 1
    ])
  })

  it('returns a bounded reference for one giant message and preserves all content in chunks', () => {
    const generation = begin()
    const value = { id: 'giant', content: '😀'.repeat(THREAD_INDEX_MAX_REPLY_BYTES) }
    writeObjects(generation, [
      {
        kind: 'message',
        ordinal: 0,
        recordId: 'giant',
        value,
        preview: { id: 'giant', content: 'Preview' }
      }
    ])
    publish(generation, 1, { messages: 1 })
    const page = database.readObjects(generation, 'message', { maxBytes: 1024 })!
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024)
    expect(page[0].kind).toBe('chunked')
    if (page[0].kind !== 'chunked') throw new Error('Expected chunk reference')
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < page[0].reference.byteLength) {
      const chunk = database.readChunk(generation, page[0].reference, offset)!
      expect(chunk.byteLength).toBeGreaterThan(0)
      expect(chunk.byteLength).toBeLessThanOrEqual(THREAD_INDEX_CHUNK_BYTES)
      chunks.push(Buffer.from(chunk))
      offset += chunk.byteLength
    }
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(value)
  })

  it('does not let a nonfinite limit remove the byte bound', () => {
    const generation = begin()
    writeObjects(generation, [
      {
        kind: 'message',
        ordinal: 0,
        recordId: 'm',
        value: { id: 'm', content: 'x'.repeat(THREAD_INDEX_MAX_REPLY_BYTES * 2) },
        preview: { id: 'm' }
      }
    ])
    publish(generation, 1, { messages: 1 })
    const page = database.readObjects(generation, 'message', { maxBytes: Number.NaN })!
    expect(page[0].kind).toBe('chunked')
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      THREAD_INDEX_MAX_REPLY_BYTES
    )
  })

  it('queries exact run membership without loading historical run payloads', () => {
    const generation = begin()
    database.writeRunLocators(generation, [{ ordinal: 0, runId: 'historical-run' }])
    publish(generation, 1, { runs: 1 })
    expect(database.findRun('historical-run')).toEqual({
      chatId: 'chat',
      generation: generation.generation,
      ordinal: 0
    })
    expect(database.findRun('absent')).toBeNull()
  })

  it('pages list metadata deterministically across equal sort keys', () => {
    for (const id of ['c', 'a', 'b']) publish(begin(id), 10)
    const first = database.list({ limit: 2 })
    expect(first.entries.map((entry) => entry.chatId)).toEqual(['a', 'b'])
    const second = database.list({ before: first.next!, limit: 2 })
    expect(second.entries.map((entry) => entry.chatId)).toEqual(['c'])
  })

  it('removes all committed and staged generations without leaving the test content in the database', () => {
    const marker = 'ERASE-THIS-THREAD-ONLY-48f7126a'
    const first = begin()
    writeObjects(first, [
      { kind: 'message', ordinal: 0, recordId: 'm', value: { content: marker }, preview: null }
    ])
    publish(first, 1, { messages: 1 })
    const staged = begin('chat', 'next-source')
    writeObjects(staged, [
      { kind: 'message', ordinal: 0, recordId: 'm', value: { content: marker }, preview: null }
    ])
    database.removeChat('chat')
    expect(database.current('chat')).toBeNull()
    expect(database.isCommitted(first)).toBe(false)
    expect(database.isCommitted(staged)).toBe(false)
    expect(fs.readFileSync(database.filePath).includes(Buffer.from(marker))).toBe(false)
    expect(fs.existsSync(`${database.filePath}-journal`)).toBe(false)
  })
})
