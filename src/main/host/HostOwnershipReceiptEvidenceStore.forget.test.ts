import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFileReceiptEvidencePersistence,
  HostOwnershipReceiptEvidenceStore,
  type ReceiptEvidencePersistence,
  type ThreadOwnershipReceiptEvidence
} from './HostOwnershipReceiptEvidenceStore'

const SHA = 'd'.repeat(64)

const exact = (
  threadId: string,
  commandId: string,
  revision: number
): ThreadOwnershipReceiptEvidence => ({ kind: 'exact', threadId, commandId, revision, sha256: SHA })

function memory() {
  const state = { text: null as string | null, writes: 0, failWrites: false }
  const persistence: ReceiptEvidencePersistence = {
    async read() {
      return state.text
    },
    async write(text) {
      if (state.failWrites) throw new Error('disk full')
      state.writes += 1
      state.text = text
    }
  }
  return { state, persistence }
}

async function seeded() {
  const held = memory()
  const store = new HostOwnershipReceiptEvidenceStore(held.persistence)
  await store.record(exact('chat-1', 'cmd-1', 1))
  await store.record(exact('chat-1', 'cmd-2', 2))
  await store.record(exact('chat-2', 'cmd-3', 3))
  return { ...held, store }
}

describe('HostOwnershipReceiptEvidenceStore.forgetChat / forgetAll', () => {
  it('forgetChat removes the chat from memory and leaves other chats alone', async () => {
    const { store } = await seeded()

    await store.forgetChat('chat-1')

    expect(store.listLoaded('chat-1')).toEqual([])
    expect(store.getLoaded('cmd-1')).toBeNull()
    expect(await store.listForChat('chat-2')).toEqual([exact('chat-2', 'cmd-3', 3)])
  })

  it('forgetChat persists across a reload, leaving no orphan', async () => {
    const { store, persistence, state } = await seeded()
    await store.forgetChat('chat-1')

    const reloaded = new HostOwnershipReceiptEvidenceStore(persistence)
    expect(await reloaded.listForChat('chat-1')).toEqual([])
    expect(await reloaded.get('cmd-2')).toBeNull()
    expect(await reloaded.listForChat('chat-2')).toHaveLength(1)
    expect(state.text).not.toContain('chat-1')
  })

  it('forgetChat persists through the atomic file path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'receipt-forget-'))
    try {
      const file = path.join(directory, 'ownership-receipt-evidence.json')
      const store = new HostOwnershipReceiptEvidenceStore(
        createFileReceiptEvidencePersistence(file)
      )
      await store.record(exact('chat-1', 'cmd-1', 1))
      await store.record(exact('chat-2', 'cmd-2', 2))

      await store.forgetChat('chat-1')

      const text = await readFile(file, 'utf8')
      expect(text).not.toContain('chat-1')
      expect(text).toContain('chat-2')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('forgetAll clears everything, in memory and on disk', async () => {
    const { store, persistence, state } = await seeded()

    await store.forgetAll()

    expect(store.listLoaded('chat-1')).toEqual([])
    expect(store.listLoaded('chat-2')).toEqual([])
    expect(JSON.parse(state.text ?? '{}').entries).toEqual([])
    expect(await new HostOwnershipReceiptEvidenceStore(persistence).get('cmd-3')).toBeNull()
  })

  it('forgetChat with a record reference clears the record field', async () => {
    const { store } = await seeded()
    const record: {
      title: string
      threadOwnershipReceipts?: readonly ThreadOwnershipReceiptEvidence[]
    } = {
      title: 't',
      threadOwnershipReceipts: [exact('chat-1', 'cmd-1', 1)]
    }

    await store.forgetChat('chat-1', record)

    expect(record.threadOwnershipReceipts).toBeUndefined()
    expect('threadOwnershipReceipts' in record).toBe(false)
    expect(record.title).toBe('t')
  })

  it('forgetChat on a chat with no evidence is a no-op that does not write', async () => {
    const { store, state } = await seeded()
    const writes = state.writes

    await store.forgetChat('never-seen')
    await store.forgetChat('never-seen')

    expect(state.writes).toBe(writes)
    expect(store.listLoaded('chat-1')).toHaveLength(2)
  })

  it('forgetAll on an empty store does not write', async () => {
    const { persistence, state } = memory()
    await new HostOwnershipReceiptEvidenceStore(persistence).forgetAll()
    expect(state.writes).toBe(0)
  })

  it('a failed write leaves the evidence in place and rejects', async () => {
    const { store, state } = await seeded()
    state.failWrites = true

    await expect(store.forgetChat('chat-1')).rejects.toThrow('disk full')

    expect(store.listLoaded('chat-1')).toHaveLength(2)
    state.failWrites = false
    await store.forgetChat('chat-1')
    expect(store.listLoaded('chat-1')).toEqual([])
  })
})
