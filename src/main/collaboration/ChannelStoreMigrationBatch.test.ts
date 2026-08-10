import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ChannelError,
  ChannelStore,
  type Channel,
  type ChannelMember,
  type ChannelStoreMigrationMutation
} from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'

const temporaryPaths: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (temporaryPaths.length > 0) {
    rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
  }
})

function fixture(): { store: ChannelStore; storagePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'channels-migration-batch-'))
  temporaryPaths.push(directory)
  const storagePath = join(directory, 'channels.json')
  return { store: new ChannelStore(storagePath), storagePath }
}

function createMutation(
  channelId: string,
  chatId: string,
  suffix = channelId
): ChannelStoreMigrationMutation {
  const owner: ChannelMember = {
    memberId: `owner_${suffix}`,
    channelId,
    kind: 'human',
    displayName: 'Host',
    identityPublicKey: `host-key-${suffix}`,
    status: 'active',
    joinedAt: 1_000
  }
  const historical: ChannelMember = {
    memberId: `member_${suffix}`,
    channelId,
    kind: 'human',
    displayName: 'Former collaborator',
    identityPublicKey: `former-key-${suffix}`,
    status: 'revoked',
    joinedAt: 1_100,
    revokedAt: 1_200,
    presentation: { seatOrder: 3, colorIndex: 6, seatDisabled: true }
  }
  const channel: Channel = {
    channelId,
    chatId,
    ownerMemberId: owner.memberId,
    status: 'active',
    createdAt: 1_000,
    updatedAt: 1_200,
    membershipRevision: 2,
    messageCount: 0,
    reference: { kind: 'chat', id: chatId },
    display: {
      title: `Migrated ${suffix}`,
      status: 'active',
      memberCount: 1,
      messageCount: 0
    }
  }
  return { mode: 'create', beforeDigest: null, channel, members: [owner, historical], invites: [] }
}

function mergeMutation(store: ChannelStore, channel: Channel): ChannelStoreMigrationMutation {
  const currentMembers = store.listMembers(channel.channelId)
  const currentInvites = store.listInvites(channel.channelId)
  const added: ChannelMember = {
    memberId: `member_${channel.channelId}`,
    channelId: channel.channelId,
    kind: 'human',
    displayName: 'Migrated member',
    identityPublicKey: `migrated-key-${channel.channelId}`,
    status: 'active',
    roomId: `migrated-room-${channel.channelId}`,
    joinedAt: 2_000
  }
  return {
    mode: 'merge',
    beforeDigest: channelStoreSubsetDigest(channel, currentMembers, currentInvites),
    channel: {
      ...channel,
      updatedAt: 2_000,
      membershipRevision: channel.membershipRevision + 1,
      display: { ...channel.display, memberCount: channel.display.memberCount + 1 }
    },
    members: [...currentMembers, added],
    invites: currentInvites
  }
}

function expectRecoveryBlocked(action: () => unknown): void {
  expect(action).toThrowError(ChannelError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'recovery_blocked' })
  }
}

describe('ChannelStore migration batch', () => {
  it('atomically creates and merges complete subsets while preserving unrelated state', () => {
    const { store, storagePath } = fixture()
    const existing = store.createChannel({
      chatId: 'existing-chat',
      owner: { displayName: 'Host', identityPublicKey: 'existing-host-key' },
      title: 'Existing',
      now: 500
    })
    const unrelated = store.createChannel({
      chatId: 'unrelated-chat',
      owner: { displayName: 'Host', identityPublicKey: 'unrelated-host-key' },
      title: 'Unrelated',
      now: 600
    })
    const unrelatedBefore = {
      channel: store.getChannel(unrelated.channel.channelId),
      members: store.listMembers(unrelated.channel.channelId),
      invites: store.listInvites(unrelated.channel.channelId)
    }
    const created = createMutation('migrated-channel', 'migrated-chat')
    const merged = mergeMutation(store, existing.channel)
    const persist = vi.spyOn(store as unknown as { persist(): void }, 'persist')

    expect(store.applyMigrationBatch([created, merged])).toEqual({
      applied: true,
      channelIds: [existing.channel.channelId, 'migrated-channel'].sort()
    })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.getChannel(existing.channel.channelId)).toEqual(merged.channel)
    expect(store.getChannel('migrated-channel')).toEqual(created.channel)
    expect(store.getMember('migrated-channel', 'member_migrated-channel')).toMatchObject({
      status: 'revoked',
      revokedAt: 1_200,
      presentation: { seatOrder: 3, colorIndex: 6, seatDisabled: true }
    })
    expect(store.getMember('migrated-channel', 'member_migrated-channel')).not.toHaveProperty(
      'roomId'
    )
    expect({
      channel: store.getChannel(unrelated.channel.channelId),
      members: store.listMembers(unrelated.channel.channelId),
      invites: store.listInvites(unrelated.channel.channelId)
    }).toEqual(unrelatedBefore)

    const restarted = new ChannelStore(storagePath)
    expect(restarted.getChannel(existing.channel.channelId)).toEqual(merged.channel)
    expect(restarted.getChannel('migrated-channel')).toEqual(created.channel)
  })

  it('accepts an exact full-batch rerun without rewriting metadata', () => {
    const { store, storagePath } = fixture()
    const first = createMutation('channel-one', 'chat-one')
    const second = createMutation('channel-two', 'chat-two')
    store.applyMigrationBatch([first, second])
    const durableBefore = readFileSync(storagePath, 'utf8')
    const persist = vi.spyOn(store as unknown as { persist(): void }, 'persist')

    expect(store.applyMigrationBatch([first, second])).toEqual({
      applied: false,
      channelIds: ['channel-one', 'channel-two']
    })
    expect(persist).not.toHaveBeenCalled()
    expect(readFileSync(storagePath, 'utf8')).toBe(durableBefore)
  })

  it('blocks stale, colliding, or partially applied batches without changing durable state', () => {
    const { store, storagePath } = fixture()
    const existing = store.createChannel({
      chatId: 'existing-chat',
      owner: { displayName: 'Host', identityPublicKey: 'existing-host-key' },
      title: 'Existing',
      now: 500
    })
    const stale = mergeMutation(store, existing.channel)
    store.admitMember({
      channelId: existing.channel.channelId,
      displayName: 'Concurrent member',
      identityPublicKey: 'concurrent-key',
      roomId: 'concurrent-room',
      now: 1_500
    })
    let durableBefore = readFileSync(storagePath, 'utf8')
    expectRecoveryBlocked(() => store.applyMigrationBatch([stale]))
    expect(readFileSync(storagePath, 'utf8')).toBe(durableBefore)

    const first = createMutation('channel-one', 'chat-one')
    store.applyMigrationBatch([first])
    durableBefore = readFileSync(storagePath, 'utf8')
    expectRecoveryBlocked(() =>
      store.applyMigrationBatch([first, createMutation('channel-two', 'chat-two')])
    )
    expectRecoveryBlocked(() =>
      store.applyMigrationBatch([createMutation('channel-one', 'different-chat', 'different')])
    )
    expect(readFileSync(storagePath, 'utf8')).toBe(durableBefore)
    expect(store.getChannel('channel-two')).toBeNull()
  })

  it('rolls back every in-memory target when the single persistence step fails', () => {
    const { store } = fixture()
    const first = createMutation('channel-one', 'chat-one')
    const second = createMutation('channel-two', 'chat-two')
    const persist = vi
      .spyOn(store as unknown as { persist(): void }, 'persist')
      .mockImplementationOnce(() => {
        throw new Error('injected persistence failure')
      })

    expect(() => store.applyMigrationBatch([first, second])).toThrow('injected persistence failure')
    expect(store.listChannels()).toEqual([])

    persist.mockRestore()
    expect(store.applyMigrationBatch([first, second])).toMatchObject({ applied: true })
  })

  it('validates the complete candidate instead of persisting malformed migration records', () => {
    const { store } = fixture()
    const malformed = createMutation('channel-one', 'chat-one')
    delete malformed.members[1]!.revokedAt

    expectRecoveryBlocked(() => store.applyMigrationBatch([malformed]))
    expect(store.listChannels()).toEqual([])
  })
})
