import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFileReceiptEvidencePersistence,
  HostOwnershipReceiptEvidenceStore,
  MAX_RECEIPT_EVIDENCE_PER_CHAT,
  type ReceiptEvidencePersistence,
  type ThreadOwnershipReceiptEvidence
} from './HostOwnershipReceiptEvidenceStore'

const SHA = 'a'.repeat(64)

const exact = (
  threadId: string,
  commandId: string,
  revision: number
): ThreadOwnershipReceiptEvidence => ({ kind: 'exact', threadId, commandId, revision, sha256: SHA })

const reanchor = (
  threadId: string,
  commandId: string,
  revision: number
): ThreadOwnershipReceiptEvidence => ({ kind: 'reanchor', threadId, commandId, revision })

function memory(initial: string | null = null) {
  const state = {
    text: initial,
    writes: 0,
    failWrites: false,
    failReads: false,
    quarantined: [] as string[]
  }
  const persistence: ReceiptEvidencePersistence = {
    async read() {
      if (state.failReads) throw new Error('read failed')
      return state.text
    },
    async write(text) {
      if (state.failWrites) throw new Error('disk full')
      state.writes += 1
      state.text = text
    },
    async quarantine(text) {
      state.quarantined.push(text)
      state.text = null
    }
  }
  return { state, persistence }
}

describe('HostOwnershipReceiptEvidenceStore', () => {
  it('round-trips exact and re-anchor evidence by command handle', async () => {
    const { persistence } = memory()
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    await store.record(exact('chat-1', 'cmd-1', 4))
    await store.record(reanchor('chat-1', 'cmd-2', 5))
    expect(await store.get('cmd-1')).toEqual(exact('chat-1', 'cmd-1', 4))
    expect(await store.get('cmd-2')).toEqual(reanchor('chat-1', 'cmd-2', 5))
  })

  it('returns null for a command it never recorded', async () => {
    const store = new HostOwnershipReceiptEvidenceStore(memory().persistence)
    expect(await store.get('missing')).toBeNull()
    await store.record(exact('chat-1', 'cmd-1', 1))
    expect(await store.get('missing')).toBeNull()
    expect(await store.listForChat('other')).toEqual([])
  })

  it('survives a restart: a new store over the same persistence sees the same evidence', async () => {
    const { persistence } = memory()
    const before = new HostOwnershipReceiptEvidenceStore(persistence)
    await before.record(exact('chat-1', 'cmd-1', 1))
    await before.record(reanchor('chat-1', 'cmd-2', 2))
    await before.record(
      { kind: 'unavailable', reason: 'legacy_receipt' },
      { chatId: 'chat-1', commandId: 'cmd-3' }
    )

    const after = new HostOwnershipReceiptEvidenceStore(persistence)
    expect(await after.listForChat('chat-1')).toEqual(await before.listForChat('chat-1'))
    expect(await after.get('cmd-3')).toEqual({ kind: 'unavailable', reason: 'legacy_receipt' })
  })

  it('lists a chat in insertion order and keeps chats apart', async () => {
    const store = new HostOwnershipReceiptEvidenceStore(memory().persistence)
    await store.record(exact('chat-1', 'cmd-b', 2))
    await store.record(exact('chat-2', 'cmd-x', 9))
    await store.record(exact('chat-1', 'cmd-a', 1))
    await store.record(reanchor('chat-1', 'cmd-c', 3))
    expect(
      (await store.listForChat('chat-1')).map((item) =>
        item.kind === 'unavailable' ? '' : item.commandId
      )
    ).toEqual(['cmd-b', 'cmd-a', 'cmd-c'])
    expect(await store.listForChat('chat-2')).toHaveLength(1)
  })

  it('re-recording a command updates it in place and never downgrades to unavailable', async () => {
    const { persistence, state } = memory()
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    await store.record(
      { kind: 'unavailable', reason: 'command_mismatch' },
      { chatId: 'chat-1', commandId: 'cmd-1' }
    )
    await store.record(exact('chat-1', 'cmd-2', 2))
    await store.record(exact('chat-1', 'cmd-1', 1))
    expect((await store.listForChat('chat-1'))[0]).toEqual(exact('chat-1', 'cmd-1', 1))

    const writes = state.writes
    await store.record(
      { kind: 'unavailable', reason: 'invalid_receipt' },
      { chatId: 'chat-1', commandId: 'cmd-1' }
    )
    await store.record(exact('chat-1', 'cmd-1', 1))
    expect(await store.get('cmd-1')).toEqual(exact('chat-1', 'cmd-1', 1))
    expect(state.writes).toBe(writes)
  })

  it('refuses evidence it cannot place or that contradicts its reference', async () => {
    const store = new HostOwnershipReceiptEvidenceStore(memory().persistence)
    await expect(store.record({ kind: 'unavailable', reason: 'legacy_receipt' })).rejects.toThrow(
      /malformed or has no chat/
    )
    await expect(store.record(exact('chat-1', 'cmd-1', 1), { chatId: 'chat-2' })).rejects.toThrow()
    await expect(
      store.record(exact('chat-1', 'cmd-1', 1), { chatId: 'chat-1', commandId: 'cmd-9' })
    ).rejects.toThrow()
    await expect(
      store.record({ kind: 'exact', threadId: 'c', commandId: 'x', revision: 1, sha256: 'nope' })
    ).rejects.toThrow()
    await expect(
      store.record({ kind: 'unavailable', reason: 'made_up' } as never, { chatId: 'c' })
    ).rejects.toThrow()
  })

  it('reports a failed write and leaves what it already held unchanged', async () => {
    const { persistence, state } = memory()
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    await store.record(exact('chat-1', 'cmd-1', 1))
    state.failWrites = true
    await expect(store.record(exact('chat-1', 'cmd-2', 2))).rejects.toThrow('disk full')
    expect(await store.get('cmd-2')).toBeNull()
    expect(await store.get('cmd-1')).not.toBeNull()
    state.failWrites = false
    await store.record(exact('chat-1', 'cmd-2', 2))
    expect(await store.get('cmd-2')).not.toBeNull()
  })

  it('serialises concurrent records so none is lost', async () => {
    const store = new HostOwnershipReceiptEvidenceStore(memory().persistence)
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => store.record(exact('chat-1', `cmd-${n}`, n)))
    )
    expect(await store.listForChat('chat-1')).toHaveLength(20)
  })

  it('sets an unparseable document aside and starts empty', async () => {
    const { persistence, state } = memory('{ not json')
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    expect(await store.get('cmd-1')).toBeNull()
    expect(store.wasQuarantined()).toBe(true)
    expect(state.quarantined).toEqual(['{ not json'])
  })

  it('does not treat an unreadable store as empty, and does not overwrite it', async () => {
    const { persistence, state } = memory()
    state.failReads = true
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    await expect(store.record(exact('chat-1', 'cmd-1', 1))).rejects.toThrow('read failed')
    expect(state.writes).toBe(0)
    state.failReads = false
    await store.record(exact('chat-1', 'cmd-1', 1))
    expect(state.writes).toBe(1)
  })

  it('drops malformed stored entries but keeps the valid ones', async () => {
    const good = { chatId: 'chat-1', commandId: 'cmd-1', evidence: exact('chat-1', 'cmd-1', 1) }
    const text = JSON.stringify({
      format: 'taskwraith.ownership-receipt-evidence',
      version: 1,
      entries: [good, { chatId: 'chat-1', evidence: { kind: 'exact' } }, null, 7]
    })
    const store = new HostOwnershipReceiptEvidenceStore(memory(text).persistence)
    expect(await store.listForChat('chat-1')).toEqual([good.evidence])
  })

  it('keeps only the newest evidence per chat', async () => {
    const store = new HostOwnershipReceiptEvidenceStore(memory().persistence)
    for (let n = 0; n < MAX_RECEIPT_EVIDENCE_PER_CHAT + 3; n += 1) {
      await store.record(exact('chat-1', `cmd-${n}`, n))
    }
    await store.record(exact('chat-2', 'other', 1))
    const kept = await store.listForChat('chat-1')
    expect(kept).toHaveLength(MAX_RECEIPT_EVIDENCE_PER_CHAT)
    expect(await store.get('cmd-0')).toBeNull()
    expect(await store.get('cmd-3')).not.toBeNull()
    expect(await store.get('other')).not.toBeNull()
  })

  it('answers synchronously only after the first load', async () => {
    const { persistence } = memory()
    const seed = new HostOwnershipReceiptEvidenceStore(persistence)
    await seed.record(exact('chat-1', 'cmd-1', 1))

    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    expect(store.getLoaded('cmd-1')).toBeNull()
    expect(store.listLoaded('chat-1')).toEqual([])
    await store.load()
    expect(store.getLoaded('cmd-1')).toEqual(exact('chat-1', 'cmd-1', 1))
    expect(store.listLoaded('chat-1')).toHaveLength(1)
  })

  it('hydrates evidence a chat record carried without writing', async () => {
    const { persistence, state } = memory()
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    await store.hydrate('chat-1', [exact('chat-1', 'cmd-1', 1), exact('chat-1', 'cmd-1', 1)])
    expect(state.writes).toBe(0)
    expect(await store.listForChat('chat-1')).toEqual([exact('chat-1', 'cmd-1', 1)])
    await store.record(exact('chat-1', 'cmd-2', 2))
    expect(JSON.parse(state.text as string).entries).toHaveLength(2)
  })

  it('adapts to onPersistedEvidence and reports a failed record instead of throwing', async () => {
    const { persistence, state } = memory()
    const onError = vi.fn()
    const store = new HostOwnershipReceiptEvidenceStore(persistence)
    const sink = store.persistedEvidenceSink(onError)
    sink({ chatId: 'chat-1' }, exact('chat-1', 'cmd-1', 1))
    await vi.waitFor(async () => expect(await store.get('cmd-1')).not.toBeNull())
    state.failWrites = true
    sink({ chatId: 'chat-1' }, exact('chat-1', 'cmd-2', 2))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
  })
})

describe('createFileReceiptEvidencePersistence', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('persists atomically across a simulated restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'receipt-evidence-'))
    directories.push(dir)
    const file = path.join(dir, 'nested', 'ownership-receipt-evidence.json')

    const first = new HostOwnershipReceiptEvidenceStore(createFileReceiptEvidencePersistence(file))
    await first.record(exact('chat-1', 'cmd-1', 1))
    await first.record(reanchor('chat-1', 'cmd-2', 2))
    expect(await readdir(path.dirname(file))).toEqual(['ownership-receipt-evidence.json'])

    const second = new HostOwnershipReceiptEvidenceStore(createFileReceiptEvidencePersistence(file))
    expect(await second.listForChat('chat-1')).toEqual([
      exact('chat-1', 'cmd-1', 1),
      reanchor('chat-1', 'cmd-2', 2)
    ])
  })

  it('moves a corrupt file aside rather than overwriting it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'receipt-evidence-'))
    directories.push(dir)
    const file = path.join(dir, 'ownership-receipt-evidence.json')
    await writeFile(file, 'garbage')

    const store = new HostOwnershipReceiptEvidenceStore(createFileReceiptEvidencePersistence(file))
    await store.record(exact('chat-1', 'cmd-1', 1))
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe('garbage')
    expect(await store.get('cmd-1')).not.toBeNull()
  })
})
