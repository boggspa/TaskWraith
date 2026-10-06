import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/install-thread-ownership-bridge-test' } }))

import { ThreadAuthorityFiles } from '../../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadOwnershipReservation } from '../../host-shared/thread-log/ThreadOwnership'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import {
  HostOwnershipReceiptEvidenceStore,
  createFileReceiptEvidencePersistence,
  type ThreadOwnershipReceiptEvidence
} from '../host/HostOwnershipReceiptEvidenceStore'
import type { ChatRecord } from '../store/types'
import {
  installThreadOwnership,
  type ThreadOwnershipActivationSeams
} from './installThreadOwnership'

const CHAT = 'chat-1'
const SHA = 'c'.repeat(64)
const WRITER = { writerId: 'writer-1', pid: process.pid }

function intent(revision: number): ChatSaveIntent {
  const commandId = `cmd-${revision}`
  return {
    chatId: CHAT,
    record: {
      appChatId: CHAT,
      title: 't',
      persistenceRevision: revision,
      messages: []
    } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

const exact = (
  revision: number,
  commandId = `host-${revision}`
): ThreadOwnershipReceiptEvidence => ({
  kind: 'exact',
  threadId: CHAT,
  commandId,
  revision,
  sha256: SHA
})

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'install-thread-ownership-bridge-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function reservation(overrides: Partial<ThreadOwnershipReservation> = {}) {
  return {
    threadId: CHAT,
    epoch: { host: 'host-1', grant: 4 },
    revalidate: vi.fn(),
    erasing: () => false,
    ...overrides
  } satisfies ThreadOwnershipReservation
}

function seamsFor(overrides: Partial<ThreadOwnershipActivationSeams> = {}) {
  const held = reservation()
  const claim = vi.fn(async () => held)
  const release = vi.fn(async () => undefined)
  const ownedAppend = vi.fn(
    async (item: ChatSaveIntent, _reservation: ThreadOwnershipReservation) =>
      exact(item.record.persistenceRevision ?? 0, item.commandId)
  )
  const seams: ThreadOwnershipActivationSeams = {
    registry: { claim, release },
    ownedAppend,
    mark: { writer: WRITER, grantedAtRevision: () => 2 },
    profilePath: directory,
    ...overrides
  }
  return { seams, held, claim, release, ownedAppend }
}

function install(
  logAuthority: boolean,
  seams?: ThreadOwnershipActivationSeams,
  queue = new PerChatSaveIntentQueue()
) {
  const evidenceFile = join(directory, 'receipts.json')
  const wiring = installThreadOwnership({
    saveIntentQueue: queue,
    evidenceFile,
    logAuthority,
    ...(seams ? { activation: seams } : {})
  })
  return { wiring, queue, evidenceFile }
}

/** The erasure-begin path: the join the catalogue calls, not the coordinator directly. */
function eraseVia(wiring: ReturnType<typeof install>['wiring']): Promise<void> {
  const join = wiring.erasureJoins.coordinator
  if (!join) throw new Error('erasure join missing')
  return join.deactivate(CHAT)
}

/** The head's exact Host receipt is what proves the frozen head reached the Host. */
async function seedConfirmedHead(
  wiring: ReturnType<typeof install>['wiring'],
  queue: PerChatSaveIntentQueue
) {
  await wiring.loadEvidence()
  queue.enqueue(intent(3))
  await wiring.receiptStore.record(exact(3))
}

describe('installThreadOwnership bridge', () => {
  it('builds the real coordinator when log authority is honoured and seams are supplied', async () => {
    const { seams, held, claim, ownedAppend } = seamsFor()
    const { wiring, queue } = install(true, seams)

    expect(wiring.activation).not.toBeNull()
    expect(wiring.coordinator).toBe(wiring.activation)
    expect(wiring.activation!.isActive(CHAT)).toBe(false)
    expect(wiring.port.isActive(CHAT)).toBe(false)

    await seedConfirmedHead(wiring, queue)
    const result = await wiring.activation!.activate(CHAT)

    expect(result).toEqual({ kind: 'activated', drained: 1, receiptFaults: 0 })
    expect(wiring.activation!.isActive(CHAT)).toBe(true)
    expect(wiring.port.isActive(CHAT)).toBe(true)
    expect(claim).toHaveBeenCalledWith(CHAT)
    expect(held.revalidate).toHaveBeenCalledTimes(1)
    expect(ownedAppend).toHaveBeenCalledTimes(1)
    expect(ownedAppend.mock.calls[0][1]).toBe(held)
    // The mark is the real one, on disk, naming the grant it was written under.
    const mark = await new ThreadAuthorityFiles(directory).read(CHAT)
    expect(mark).toMatchObject({
      kind: 'held',
      record: {
        threadId: CHAT,
        writer: WRITER,
        epoch: { host: 'host-1', grant: 4 },
        grantedAtRevision: 2
      }
    })
  })

  it('keeps the placeholder when log authority is off, even with seams', async () => {
    const { seams, claim, ownedAppend } = seamsFor()
    const { wiring, queue } = install(false, seams)

    expect(wiring.activation).toBeNull()
    await seedConfirmedHead(wiring, queue)
    expect(wiring.coordinator.isActive(CHAT)).toBe(false)
    expect(wiring.port.isActive(CHAT)).toBe(false)
    await expect(eraseVia(wiring)).resolves.toBeUndefined()
    expect(claim).not.toHaveBeenCalled()
    expect(ownedAppend).not.toHaveBeenCalled()
    expect(await new ThreadAuthorityFiles(directory).read(CHAT)).toEqual({ kind: 'none' })
  })

  it('keeps the placeholder when log authority is on but no seams are supplied', () => {
    const { wiring } = install(true)
    expect(wiring.activation).toBeNull()
    expect(wiring.coordinator.isActive(CHAT)).toBe(false)
  })

  it('refuses seams that cannot write a mark rather than activate without one', () => {
    const { seams } = seamsFor()
    const { mark: _mark, ...withoutMark } = seams
    expect(() => install(true, withoutMark)).toThrow(/markWriter or a mark identity/)
  })

  it.each([true, false])(
    'records persisted evidence through the real receipt store (log authority %s)',
    async (logAuthority) => {
      const { seams } = seamsFor()
      const { wiring, queue, evidenceFile } = install(logAuthority, seams)
      await wiring.loadEvidence()
      queue.enqueue(intent(3))

      wiring.persistedEvidenceSink({ chatId: CHAT }, exact(3))
      await vi.waitFor(() => expect(wiring.receiptStore.listLoaded(CHAT)).toHaveLength(1))
      await vi.waitFor(() => expect(queue.peek(CHAT)).toEqual([]))

      // Durable: a new store over the same file sees it after a restart.
      const restarted = new HostOwnershipReceiptEvidenceStore(
        createFileReceiptEvidencePersistence(evidenceFile)
      )
      expect(await restarted.listForChat(CHAT)).toEqual([exact(3)])
    }
  )

  it('fails closed when the owned append rejects: mark removed, claim released, saves handed back', async () => {
    const { seams, release } = seamsFor({
      ownedAppend: vi.fn(async () => {
        throw new Error('owned journal unavailable')
      })
    })
    const { wiring, queue } = install(true, seams)
    await seedConfirmedHead(wiring, queue)

    const result = await wiring.activation!.activate(CHAT)

    expect(result).toMatchObject({
      kind: 'failed',
      reason: 'drain_failed',
      ownershipRetained: false
    })
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.pending.map((item) => item.commandId)).toEqual(['cmd-3'])
    expect(wiring.port.isActive(CHAT)).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await new ThreadAuthorityFiles(directory).read(CHAT)).toEqual({ kind: 'none' })
  })

  it('rolls back when the mark identity yields an invalid grant revision', async () => {
    const { seams, release } = seamsFor({
      mark: { writer: WRITER, grantedAtRevision: () => -1 }
    })
    const { wiring, queue } = install(true, seams)
    await seedConfirmedHead(wiring, queue)

    const result = await wiring.activation!.activate(CHAT)

    expect(result).toMatchObject({ kind: 'failed', reason: 'mark_write_failed' })
    expect(wiring.port.isActive(CHAT)).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await new ThreadAuthorityFiles(directory).read(CHAT)).toEqual({ kind: 'none' })
  })

  it('routes erasure through the real coordinator and keeps the mark over owned rows', async () => {
    const { seams, release } = seamsFor()
    const { wiring, queue } = install(true, seams)
    await seedConfirmedHead(wiring, queue)
    await wiring.activation!.activate(CHAT)
    expect(wiring.port.isActive(CHAT)).toBe(true)

    await eraseVia(wiring)

    expect(wiring.port.isActive(CHAT)).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
    // An owned append committed, so the mark must stay discoverable.
    expect((await new ThreadAuthorityFiles(directory).read(CHAT)).kind).toBe('held')
  })

  it('never touches the authority environment variable', async () => {
    const before = process.env.TASKWRAITH_THREAD_LOG_AUTHORITY
    const { seams } = seamsFor()
    const { wiring, queue } = install(true, seams)
    await seedConfirmedHead(wiring, queue)
    await wiring.activation!.activate(CHAT)
    await eraseVia(wiring)
    expect(process.env.TASKWRAITH_THREAD_LOG_AUTHORITY).toBe(before)
  })
})
