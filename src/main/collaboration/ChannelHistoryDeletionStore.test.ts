import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contributionRulesForPreset } from './HumanContributionRules'
import {
  CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX,
  channelAgentAuthorityFileHash
} from './ChannelAgentAuthorityStore'
import {
  CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX,
  channelAgentDispatchJournalChannelFileHash,
  channelAgentDispatchJournalRecordFileHash
} from './ChannelAgentDispatchJournalStore'
import {
  CHANNEL_AGENT_IDENTITY_FILE_SUFFIX,
  ChannelAgentIdentityStore,
  channelAgentSeatFileHash,
  type ChannelAgentIdentitySafeStorage
} from './ChannelAgentIdentityStore'
import { ChannelAuditLog } from './ChannelAuditLog'
import { ChannelHumanPolicyStore, channelHumanPolicyPath } from './ChannelHumanPolicyStore'
import { ChannelHumanReviewStore, channelHumanReviewPath } from './ChannelHumanReviewStore'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelStore, type Channel } from './ChannelStore'
import {
  executeChannelHistoryDeletion,
  planChannelHistoryDeletion,
  purgeColdChannelHistoryDeletion,
  type ChannelHistoryDeletionPaths,
  type ChannelHistoryDeletionStores
} from './ChannelHistoryDeletionStore'

const roots = new Set<string>()
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function paths(userDataPath: string): ChannelHistoryDeletionPaths {
  const root = join(userDataPath, 'channels')
  return {
    metadata: join(root, 'channels.json'),
    logs: join(root, 'logs'),
    audit: join(root, 'audit.json'),
    agentIdentities: join(root, 'agent-identities'),
    agentAuthority: join(root, 'agent-authority'),
    agentDispatchJournal: join(root, 'agent-dispatch-journal'),
    humanPolicies: channelHumanPolicyPath(userDataPath),
    humanReviews: channelHumanReviewPath(userDataPath)
  }
}

function temporaryPaths(): ChannelHistoryDeletionPaths {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-cold-channel-purge-'))
  roots.add(root)
  return paths(root)
}

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn(() => Buffer.from('encrypted')),
  decryptString: vi.fn(() => 'decrypted'),
  getSelectedStorageBackend: vi.fn(() => 'kwallet6')
}

function fakeChannel(channelId: string, chatId: string): Channel {
  return {
    channelId,
    chatId,
    ownerMemberId: `${channelId}-owner`,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    membershipRevision: 1,
    messageCount: 0,
    display: {
      title: channelId,
      status: 'active',
      memberCount: 1,
      messageCount: 0
    }
  }
}

function orderedStores(calls: string[]): ChannelHistoryDeletionStores {
  return {
    log: {
      purgeAll: () => {
        calls.push('log:all')
      },
      purgeChannels: (ids) => {
        calls.push(`log:${ids.join(',')}`)
      }
    },
    audit: {
      purgeAll: () => {
        calls.push('audit:all')
        return 0
      },
      purgeChannels: (ids) => {
        calls.push(`audit:${ids.join(',')}`)
        return 0
      }
    },
    agentDispatchJournal: {
      purgeAll: () => {
        calls.push('dispatch:all')
        return 0
      },
      eraseChannel: (id) => {
        calls.push(`dispatch:${id}`)
        return 0
      }
    },
    agentAuthority: {
      purgeAll: () => {
        calls.push('authority:all')
        return 0
      },
      eraseChannel: (id) => {
        calls.push(`authority:${id}`)
        return 0
      }
    },
    agentIdentities: {
      purgeAll: () => {
        calls.push('identities:all')
        return 0
      }
    },
    store: {
      purgeAllChannels: () => {
        calls.push('metadata:all')
        return []
      },
      purgeChannels: (ids) => {
        calls.push(`metadata:${ids.join(',')}`)
        return [...ids]
      }
    },
    humanPolicies: {
      purgeChannels: (ids) => {
        calls.push(`policies:${ids.join(',')}`)
        return 0
      }
    },
    humanReviews: {
      purgeAll: () => {
        calls.push('reviews:all')
      },
      purgeChannels: (ids) => {
        calls.push(`reviews:${ids.join(',')}`)
        return 0
      }
    }
  }
}

function seedStore(inputPaths: ChannelHistoryDeletionPaths) {
  const store = new ChannelStore(inputPaths.metadata)
  const first = store.createChannel({
    chatId: 'chat-a',
    title: 'A',
    owner: { displayName: 'Owner A', identityPublicKey: 'owner-a-key' },
    now: 1
  })
  const second = store.createChannel({
    chatId: 'chat-b',
    title: 'B',
    owner: { displayName: 'Owner B', identityPublicKey: 'owner-b-key' },
    now: 2
  })
  mkdirSync(inputPaths.logs, { recursive: true, mode: 0o700 })
  writeFileSync(join(inputPaths.logs, `${first.channel.channelId}.jsonl`), 'first\n')
  writeFileSync(join(inputPaths.logs, `${second.channel.channelId}.jsonl`), 'second\n')
  writeFileSync(join(inputPaths.logs, 'orphan.jsonl'), 'orphan\n')

  const audit = new ChannelAuditLog(inputPaths.audit)
  audit.append({
    kind: 'message.accepted',
    channelId: first.channel.channelId,
    at: 1
  })
  audit.append({
    kind: 'message.accepted',
    channelId: second.channel.channelId,
    at: 2
  })

  const policies = new ChannelHumanPolicyStore(inputPaths.humanPolicies)
  policies.applyMigrationPolicies({
    migrationPlanId: 'a'.repeat(64),
    now: 3,
    policies: [first, second].map(({ channel, owner }, index) => ({
      channelId: channel.channelId,
      memberId: owner.memberId,
      sourceShareId: `share-${index}`,
      sourceCollaboratorId: `collaborator-${index}`,
      sourceDigest: String(index + 1).repeat(64),
      rules: contributionRulesForPreset('comments'),
      requiresHostApproval: true,
      fullHistory: false
    }))
  })

  const reviews = new ChannelHumanReviewStore(inputPaths.humanReviews)
  for (const [index, { channel, owner }] of [first, second].entries()) {
    reviews.enqueue({
      channelId: channel.channelId,
      memberId: owner.memberId,
      identityPublicKeyB64: `identity-${index}`,
      roomId: `room-${index}`,
      clientMessageId: `client-${index}`,
      content: `review-${index}`,
      now: 4,
      ttlMs: 1000
    })
  }

  for (const directory of [
    inputPaths.agentIdentities,
    inputPaths.agentAuthority,
    inputPaths.agentDispatchJournal
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  const seatId = 'shared-agent-seat'
  const identityFile = join(
    inputPaths.agentIdentities,
    `${channelAgentSeatFileHash(seatId)}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`
  )
  writeFileSync(identityFile, 'encrypted identity')
  writeFileSync(join(inputPaths.agentIdentities, 'unrelated.keep'), 'keep')

  const artifacts = [first.channel, second.channel].map((channel, index) => {
    const authorityFile = join(
      inputPaths.agentAuthority,
      `${channelAgentAuthorityFileHash(channel.channelId)}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
    )
    const dispatchFile = join(
      inputPaths.agentDispatchJournal,
      `${channelAgentDispatchJournalChannelFileHash(channel.channelId)}.${channelAgentDispatchJournalRecordFileHash(`dispatch-${index}`)}${CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX}`
    )
    writeFileSync(authorityFile, 'authority')
    writeFileSync(dispatchFile, 'dispatch')
    return { authorityFile, dispatchFile }
  })
  return { first, second, identityFile, artifacts }
}

describe('Channel history deletion store extraction', () => {
  it('preserves the exact scoped and global metadata-last ordering', () => {
    const channels = [fakeChannel('channel-a', 'chat-a'), fakeChannel('channel-b', 'chat-b')]
    const scopedPlan = planChannelHistoryDeletion({
      scope: { kind: 'chat', chatIds: ['chat-a'] },
      store: { listChannels: () => channels }
    })
    const scopedCalls: string[] = []
    expect(executeChannelHistoryDeletion(orderedStores(scopedCalls), scopedPlan)).toEqual({
      kind: 'chat',
      purgedChannelIds: ['channel-a'],
      preservedChannelIds: []
    })
    expect(scopedCalls).toEqual([
      'log:channel-a',
      'audit:channel-a',
      'dispatch:channel-a',
      'authority:channel-a',
      'metadata:channel-a',
      'policies:channel-a',
      'reviews:channel-a'
    ])

    const globalPlan = planChannelHistoryDeletion({
      scope: { kind: 'global' },
      store: { listChannels: () => channels },
      listHumanPolicyChannelIds: () => ['channel-a', 'orphan-policy']
    })
    const globalCalls: string[] = []
    expect(executeChannelHistoryDeletion(orderedStores(globalCalls), globalPlan)).toEqual({
      kind: 'global',
      purgedChannelIds: ['channel-a', 'channel-b'],
      preservedChannelIds: []
    })
    expect(globalCalls).toEqual([
      'log:all',
      'audit:all',
      'dispatch:all',
      'authority:all',
      'identities:all',
      'metadata:all',
      'policies:channel-a,orphan-policy',
      'reviews:all'
    ])
  })

  it('keeps truncate and empty scoped requests side-effect free', () => {
    const channels = [fakeChannel('channel-a', 'chat-a')]
    const truncate = planChannelHistoryDeletion({
      scope: { kind: 'truncate', chatIds: ['chat-a'] },
      store: { listChannels: () => channels }
    })
    const calls: string[] = []
    expect(executeChannelHistoryDeletion(orderedStores(calls), truncate)).toEqual({
      kind: 'truncate',
      purgedChannelIds: [],
      preservedChannelIds: ['channel-a']
    })
    expect(calls).toEqual([])

    const empty = planChannelHistoryDeletion({
      scope: { kind: 'workspace', chatIds: ['missing'] },
      store: { listChannels: () => channels }
    })
    expect(executeChannelHistoryDeletion(orderedStores(calls), empty)).toEqual({
      kind: 'workspace',
      purgedChannelIds: [],
      preservedChannelIds: []
    })
    expect(calls).toEqual([])
  })

  it('validates the global identity-store dependency before deleting any store', () => {
    const plan = planChannelHistoryDeletion({
      scope: { kind: 'global' },
      store: { listChannels: () => [fakeChannel('channel-a', 'chat-a')] },
      listHumanPolicyChannelIds: () => []
    })
    const calls: string[] = []
    const stores = orderedStores(calls)
    delete stores.agentIdentities
    expect(() => executeChannelHistoryDeletion(stores, plan)).toThrow('agent identity store')
    expect(calls).toEqual([])
  })

  it('cold scoped purge deletes only the selected channel and retains agent identity custody', () => {
    const inputPaths = temporaryPaths()
    const seeded = seedStore(inputPaths)
    const highWater = vi.spyOn(ChannelMessageLog.prototype, 'highWaterSequence')
    const identityLoad = vi.spyOn(ChannelAgentIdentityStore.prototype, 'load')

    expect(
      purgeColdChannelHistoryDeletion({
        paths: inputPaths,
        scope: { kind: 'chat', chatIds: ['chat-a'] }
      })
    ).toEqual({
      kind: 'chat',
      purgedChannelIds: [seeded.first.channel.channelId],
      preservedChannelIds: []
    })

    expect(highWater).not.toHaveBeenCalled()
    expect(identityLoad).not.toHaveBeenCalled()
    expect(existsSync(join(inputPaths.logs, `${seeded.first.channel.channelId}.jsonl`))).toBe(false)
    expect(existsSync(join(inputPaths.logs, `${seeded.second.channel.channelId}.jsonl`))).toBe(true)
    expect(existsSync(seeded.artifacts[0].authorityFile)).toBe(false)
    expect(existsSync(seeded.artifacts[0].dispatchFile)).toBe(false)
    expect(existsSync(seeded.artifacts[1].authorityFile)).toBe(true)
    expect(existsSync(seeded.artifacts[1].dispatchFile)).toBe(true)
    expect(existsSync(seeded.identityFile)).toBe(true)
    expect(
      new ChannelStore(inputPaths.metadata).listChannels().map((row) => row.channelId)
    ).toEqual([seeded.second.channel.channelId])
    expect(
      new ChannelHumanPolicyStore(inputPaths.humanPolicies).list().map((row) => row.channelId)
    ).toEqual([seeded.second.channel.channelId])
    expect(
      new ChannelHumanReviewStore(inputPaths.humanReviews).list().map((row) => row.channelId)
    ).toEqual([seeded.second.channel.channelId])
  })

  it('cold global purge removes orphan stores without loading identity or reconciling reviews', () => {
    const inputPaths = temporaryPaths()
    const seeded = seedStore(inputPaths)
    const highWater = vi.spyOn(ChannelMessageLog.prototype, 'highWaterSequence')
    const identityLoad = vi.spyOn(ChannelAgentIdentityStore.prototype, 'load')
    const identityCreate = vi.spyOn(ChannelAgentIdentityStore.prototype, 'loadOrCreate')
    const reviewSweep = vi.spyOn(ChannelHumanReviewStore.prototype, 'sweep')
    const listAwaiting = vi.spyOn(ChannelHumanReviewStore.prototype, 'listAwaitingMaterialization')

    expect(
      purgeColdChannelHistoryDeletion({
        paths: inputPaths,
        scope: { kind: 'global' },
        safeStorage
      })
    ).toEqual({
      kind: 'global',
      purgedChannelIds: [seeded.first.channel.channelId, seeded.second.channel.channelId],
      preservedChannelIds: []
    })

    expect(highWater).not.toHaveBeenCalled()
    expect(identityLoad).not.toHaveBeenCalled()
    expect(identityCreate).not.toHaveBeenCalled()
    expect(reviewSweep).not.toHaveBeenCalled()
    expect(listAwaiting).not.toHaveBeenCalled()
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(new ChannelStore(inputPaths.metadata).listChannels()).toEqual([])
    expect(new ChannelAuditLog(inputPaths.audit).list()).toEqual([])
    expect(new ChannelHumanPolicyStore(inputPaths.humanPolicies).list()).toEqual([])
    expect(new ChannelHumanReviewStore(inputPaths.humanReviews).list()).toEqual([])
    expect(existsSync(join(inputPaths.logs, 'orphan.jsonl'))).toBe(false)
    expect(existsSync(seeded.identityFile)).toBe(false)
    expect(existsSync(join(inputPaths.agentIdentities, 'unrelated.keep'))).toBe(true)
    for (const artifact of seeded.artifacts) {
      expect(existsSync(artifact.authorityFile)).toBe(false)
      expect(existsSync(artifact.dispatchFile)).toBe(false)
    }
  })
})
