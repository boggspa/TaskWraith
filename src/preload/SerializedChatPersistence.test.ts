import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../main/store/types'
import { SerializedChatPersistence } from './SerializedChatPersistence'

function chat(
  appChatId: string,
  persistenceRevision: number,
  overrides: Partial<ChatRecord> = {}
): ChatRecord {
  return {
    appChatId,
    provider: 'codex',
    title: appChatId,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    persistenceRevision,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('SerializedChatPersistence', () => {
  function createCasRemote(initial: ChatRecord) {
    let canonical = structuredClone(initial)
    const saveRemote = vi.fn(async (record: ChatRecord) => {
      const previous = structuredClone(canonical)
      if (record.persistenceRevision !== canonical.persistenceRevision) {
        return { chat: structuredClone(canonical), previous, accepted: false }
      }
      canonical = {
        ...structuredClone(record),
        updatedAt: previous.updatedAt + 1,
        persistenceRevision: (record.persistenceRevision || 0) + 1
      }
      return { chat: structuredClone(canonical), previous, accepted: true }
    })
    return { saveRemote, canonical: () => structuredClone(canonical) }
  }

  it('three-way rebases disjoint title and message mutations so both survive', async () => {
    const remote = createCasRemote(
      chat('chat-1', 7, { title: 'Base title', messages: [], updatedAt: 10 })
    )
    const persistence = new SerializedChatPersistence(remote.saveRemote)

    const titleMutation = persistence.save(
      chat('chat-1', 7, { title: 'Accepted title', messages: [], updatedAt: 11 })
    )
    const messageMutation = persistence.save(
      chat('chat-1', 7, {
        title: 'Base title',
        updatedAt: 12,
        messages: [
          { id: 'message-1', role: 'user', content: 'Disjoint mutation', timestamp: 'now' }
        ]
      })
    )

    await expect(titleMutation).resolves.toMatchObject({
      persistenceRevision: 8,
      title: 'Accepted title'
    })
    await expect(messageMutation).resolves.toMatchObject({
      persistenceRevision: 9,
      title: 'Accepted title',
      messages: [expect.objectContaining({ content: 'Disjoint mutation' })]
    })
    expect(remote.saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 8
    ])
    expect(remote.saveRemote.mock.calls[1][0]).toMatchObject({
      title: 'Accepted title',
      updatedAt: 11,
      messages: [expect.objectContaining({ content: 'Disjoint mutation' })]
    })
    expect(remote.canonical()).toMatchObject({
      persistenceRevision: 9,
      title: 'Accepted title',
      messages: [expect.objectContaining({ content: 'Disjoint mutation' })]
    })
  })

  it('rebases a revision-8 descendant after a queued revision-7 sibling completes', async () => {
    const remote = createCasRemote(
      chat('chat-1', 7, { title: 'Base title', messages: [], updatedAt: 10 })
    )
    const secondStarted = deferred<void>()
    const releaseSecond = deferred<void>()
    let callCount = 0
    const saveRemote = vi.fn(async (record: ChatRecord) => {
      callCount += 1
      if (callCount === 2) {
        secondStarted.resolve()
        await releaseSecond.promise
      }
      return remote.saveRemote(record)
    })
    const persistence = new SerializedChatPersistence(saveRemote)

    const first = persistence.save(
      chat('chat-1', 7, { title: 'Accepted title', messages: [], updatedAt: 100 })
    )
    const second = persistence.save(
      chat('chat-1', 7, {
        title: 'Base title',
        messages: [],
        pinnedNotes: 'Queued revision-7 sibling',
        updatedAt: 200
      })
    )
    const firstCanonical = await first
    await secondStarted.promise
    const third = persistence.save({
      ...firstCanonical,
      messages: [
        { id: 'message-1', role: 'user', content: 'Revision-8 descendant', timestamp: 'now' }
      ],
      updatedAt: 300
    })

    releaseSecond.resolve()
    const secondCanonical = await second
    await expect(third).resolves.toMatchObject({
      persistenceRevision: 10,
      title: 'Accepted title',
      pinnedNotes: 'Queued revision-7 sibling',
      messages: [expect.objectContaining({ content: 'Revision-8 descendant' })]
    })
    expect(saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 8, 9
    ])
    expect(saveRemote.mock.calls[2][0]).toMatchObject({
      persistenceRevision: 9,
      updatedAt: secondCanonical.updatedAt,
      title: 'Accepted title',
      pinnedNotes: 'Queued revision-7 sibling',
      messages: [expect.objectContaining({ content: 'Revision-8 descendant' })]
    })
    expect(remote.canonical()).toMatchObject({
      persistenceRevision: 10,
      title: 'Accepted title',
      pinnedNotes: 'Queued revision-7 sibling',
      messages: [expect.objectContaining({ content: 'Revision-8 descendant' })]
    })
  })

  it('fails closed when the revision-8 descendant conflicts with its queued sibling', async () => {
    const remote = createCasRemote(
      chat('chat-1', 7, { title: 'Base title', messages: [], updatedAt: 10 })
    )
    const secondStarted = deferred<void>()
    const releaseSecond = deferred<void>()
    let callCount = 0
    const saveRemote = vi.fn(async (record: ChatRecord) => {
      callCount += 1
      if (callCount === 2) {
        secondStarted.resolve()
        await releaseSecond.promise
      }
      return remote.saveRemote(record)
    })
    const persistence = new SerializedChatPersistence(saveRemote)

    const first = persistence.save(
      chat('chat-1', 7, { title: 'Accepted title', messages: [], updatedAt: 100 })
    )
    const second = persistence.save(
      chat('chat-1', 7, {
        title: 'Base title',
        messages: [],
        pinnedNotes: 'Accepted sibling value',
        updatedAt: 200
      })
    )
    const firstCanonical = await first
    await secondStarted.promise
    const conflictingThird = persistence.save({
      ...firstCanonical,
      pinnedNotes: 'Conflicting descendant value',
      updatedAt: 300
    })

    releaseSecond.resolve()
    await second
    await expect(conflictingThird).resolves.toMatchObject({
      persistenceRevision: 9,
      title: 'Accepted title',
      pinnedNotes: 'Accepted sibling value'
    })
    expect(saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 8, 8
    ])
    expect(saveRemote.mock.calls[2][0]).toMatchObject({
      persistenceRevision: 8,
      pinnedNotes: 'Conflicting descendant value',
      updatedAt: 300
    })
    expect(remote.canonical()).toMatchObject({
      persistenceRevision: 9,
      pinnedNotes: 'Accepted sibling value'
    })
  })

  it('preserves the first accepted value when queued snapshots conflict on one field', async () => {
    const remote = createCasRemote(chat('chat-1', 7, { title: 'Base title' }))
    const persistence = new SerializedChatPersistence(remote.saveRemote)

    const first = persistence.save(chat('chat-1', 7, { title: 'First title' }))
    const conflicting = persistence.save(chat('chat-1', 7, { title: 'Second title' }))

    await expect(first).resolves.toMatchObject({ title: 'First title', persistenceRevision: 8 })
    await expect(conflicting).resolves.toMatchObject({
      title: 'First title',
      persistenceRevision: 8
    })
    expect(remote.saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 7
    ])
    expect(remote.canonical()).toMatchObject({ title: 'First title', persistenceRevision: 8 })
  })

  it('accepts equal concurrent values while merging another disjoint field', async () => {
    const remote = createCasRemote(chat('chat-1', 7, { title: 'Base title' }))
    const persistence = new SerializedChatPersistence(remote.saveRemote)

    const first = persistence.save(chat('chat-1', 7, { title: 'Shared title' }))
    const equalAndDisjoint = persistence.save(
      chat('chat-1', 7, { title: 'Shared title', pinnedNotes: 'Second mutation' })
    )

    await first
    await expect(equalAndDisjoint).resolves.toMatchObject({
      persistenceRevision: 9,
      title: 'Shared title',
      pinnedNotes: 'Second mutation'
    })
    expect(remote.saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 8
    ])
  })

  it('rejects nested changes that conflict within the same top-level field', async () => {
    const remote = createCasRemote(chat('chat-1', 7, { messages: [] }))
    const persistence = new SerializedChatPersistence(remote.saveRemote)
    const firstMessage = {
      id: 'message-1',
      role: 'user' as const,
      content: 'First nested mutation',
      timestamp: 'now'
    }
    const secondMessage = {
      id: 'message-2',
      role: 'user' as const,
      content: 'Conflicting nested mutation',
      timestamp: 'now'
    }

    const first = persistence.save(chat('chat-1', 7, { messages: [firstMessage] }))
    const conflicting = persistence.save(chat('chat-1', 7, { messages: [secondMessage] }))

    await first
    await expect(conflicting).resolves.toMatchObject({ messages: [firstMessage] })
    expect(remote.saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 7
    ])
    expect(remote.canonical().messages).toEqual([firstMessage])
  })

  it('does not synthesize concurrent session and grant state across protected fields', async () => {
    const remote = createCasRemote(chat('chat-1', 7))
    const persistence = new SerializedChatPersistence(remote.saveRemote)

    const sessionMutation = persistence.save(
      chat('chat-1', 7, { linkedProviderSessionId: 'canonical-session' })
    )
    const grantMetadataMutation = persistence.save(
      chat('chat-1', 7, { providerMetadata: { rendererGrantCandidate: true } })
    )

    await sessionMutation
    await expect(grantMetadataMutation).resolves.toMatchObject({
      linkedProviderSessionId: 'canonical-session',
      persistenceRevision: 8
    })
    expect(remote.saveRemote.mock.calls.map(([record]) => record.persistenceRevision)).toEqual([
      7, 7
    ])
    expect(remote.canonical()).not.toHaveProperty('providerMetadata')
  })

  it('sends an already-canonical snapshot unchanged and starts a fresh lineage', async () => {
    const remote = createCasRemote(chat('chat-1', 7, { title: 'Base title' }))
    const persistence = new SerializedChatPersistence(remote.saveRemote)
    const first = await persistence.save(chat('chat-1', 7, { title: 'Canonical title' }))
    const canonicalMutation = {
      ...first,
      pinnedNotes: 'Built from revision 8'
    }

    await expect(persistence.save(canonicalMutation)).resolves.toMatchObject({
      persistenceRevision: 9,
      title: 'Canonical title',
      pinnedNotes: 'Built from revision 8'
    })
    expect(remote.saveRemote.mock.calls[1][0]).toEqual(canonicalMutation)
  })

  it('keeps canonical mutations in the same per-chat queue while allowing other chats through', async () => {
    const firstResult = deferred<{
      chat: ChatRecord
      previous: ChatRecord | null
      accepted: boolean
    }>()
    const saveRemote = vi
      .fn<
        (record: ChatRecord) => Promise<{
          chat: ChatRecord
          previous: ChatRecord | null
          accepted: boolean
        }>
      >()
      .mockImplementationOnce(() => firstResult.promise)
      .mockImplementation(async (record) => ({
        previous: record,
        chat: {
          ...record,
          persistenceRevision: (record.persistenceRevision || 0) + 1
        },
        accepted: true
      }))
    const persistence = new SerializedChatPersistence(saveRemote)
    const mutation = vi.fn(async () => chat('chat-1', 3, { messages: [] }))

    const first = persistence.save(chat('chat-1', 1))
    const clear = persistence.run('chat-1', mutation)
    const other = persistence.save(chat('chat-2', 4))

    await expect(other).resolves.toMatchObject({ appChatId: 'chat-2', persistenceRevision: 5 })
    expect(mutation).not.toHaveBeenCalled()

    firstResult.resolve({
      chat: chat('chat-1', 2),
      previous: chat('chat-1', 1),
      accepted: true
    })
    await first
    await expect(clear).resolves.toMatchObject({ appChatId: 'chat-1', persistenceRevision: 3 })
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('does not rebase a queued stale snapshot when main rejected the preceding save', async () => {
    const firstResult = deferred<{
      chat: ChatRecord
      previous: ChatRecord | null
      accepted: boolean
    }>()
    const secondResult = deferred<{
      chat: ChatRecord
      previous: ChatRecord | null
      accepted: boolean
    }>()
    const saveRemote = vi
      .fn<
        (record: ChatRecord) => Promise<{
          chat: ChatRecord
          previous: ChatRecord | null
          accepted: boolean
        }>
      >()
      .mockImplementationOnce(() => firstResult.promise)
      .mockImplementationOnce(() => secondResult.promise)
    const persistence = new SerializedChatPersistence(saveRemote)

    const first = persistence.save(chat('chat-1', 7, { title: 'Stale first mutation' }))
    const second = persistence.save(chat('chat-1', 7, { title: 'Stale second mutation' }))
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledTimes(1))

    firstResult.resolve({
      chat: chat('chat-1', 8, { title: 'Canonical main mutation' }),
      previous: chat('chat-1', 8, { title: 'Canonical main mutation' }),
      accepted: false
    })
    await expect(first).resolves.toMatchObject({
      title: 'Canonical main mutation',
      persistenceRevision: 8
    })
    await vi.waitFor(() => expect(saveRemote).toHaveBeenCalledTimes(2))
    expect(saveRemote.mock.calls[1][0]).toMatchObject({
      title: 'Stale second mutation',
      persistenceRevision: 7
    })

    secondResult.resolve({
      chat: chat('chat-1', 8, { title: 'Canonical main mutation' }),
      previous: chat('chat-1', 8, { title: 'Canonical main mutation' }),
      accepted: false
    })
    await expect(second).resolves.toMatchObject({ title: 'Canonical main mutation' })
  })
})
