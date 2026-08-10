import { createHash } from 'crypto'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { DEFAULT_CHANNEL_INVITE_TTL_MS, ChannelStore, hashChannelInviteToken } from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'
import {
  PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION,
  MAX_PEOPLE_TO_CHANNEL_REISSUES,
  PeopleToChannelMigrationAdmissionReissue,
  isPeopleToChannelAdmissionReissueError
} from './PeopleToChannelMigrationAdmissionReissue'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-reissue-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

function safeStorage(available = true): HumanCollaborationSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (encrypted) => xor(encrypted).toString('utf8')
  }
}

function sealBase(
  value: Omit<PeopleToChannelMigrationMaterialization, 'materializationDigest'>
): PeopleToChannelMigrationMaterialization {
  return { ...value, materializationDigest: sha256(canonicalJson(value)) }
}

function sealHistory(
  value: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'>
): PeopleToChannelMigrationHistoryMaterialization {
  return { ...value, executionDigest: sha256(canonicalJson(value)) }
}

function fixture(
  args: {
    pendingCollaboratorIds?: string[]
    openInviteCount?: number
    mode?: 'create' | 'merge'
    extraChannel?: boolean
  } = {}
) {
  const directory = temporaryDirectory()
  const escrowPath = join(directory, 'migration', 'admission-escrow.json')
  const store = new ChannelStore(join(directory, 'channels.json'))
  const mode = args.mode ?? 'merge'
  const primaryPlanner = mode === 'create' ? new ChannelStore() : store
  const { channel } = primaryPlanner.createChannel({
    chatId: 'chat_one',
    owner: { displayName: 'Host', identityPublicKey: 'host_key' },
    title: 'Migrated Channel',
    now: 1_000
  })
  const members = primaryPlanner.listMembers(channel.channelId)
  const invites = primaryPlanner.listInvites(channel.channelId)
  const metadataMutation = {
    mode,
    beforeDigest: mode === 'merge' ? channelStoreSubsetDigest(channel, members, invites) : null,
    channel,
    members,
    invites
  }
  let extraChannel: typeof channel | null = null
  const metadataMutations = [metadataMutation]
  if (args.extraChannel) {
    const extraPlanner = new ChannelStore()
    extraChannel = extraPlanner.createChannel({
      chatId: 'chat_two',
      owner: { displayName: 'Host', identityPublicKey: 'host_key' },
      title: 'General Channel',
      now: 1_000
    }).channel
    metadataMutations.push({
      mode: 'create',
      beforeDigest: null,
      channel: extraChannel,
      members: extraPlanner.listMembers(extraChannel.channelId),
      invites: []
    })
  }
  const pendingCollaboratorIds = args.pendingCollaboratorIds ?? ['collaborator_one']
  const openInviteCount = args.openInviteCount ?? 1
  const base = sealBase({
    schemaVersion: PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
    planId: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    migrationAt: 1_000,
    mutations: metadataMutations.map(clone),
    policies: [],
    pendingAdmissionReissues:
      pendingCollaboratorIds.length > 0 || openInviteCount > 0
        ? [
            {
              sourceShareId: 'share_one',
              channelId: channel.channelId,
              pendingCollaboratorIds,
              openInviteCount,
              policy: {
                sourceDigest: 'c'.repeat(64),
                rules: contributionRulesForPreset('comments'),
                requiresHostApproval: false,
                fullHistory: false
              }
            }
          ]
        : [],
    migratedShareIds: ['share_one'],
    retainedShareIds: [],
    generalChatIds: args.extraChannel ? ['chat_one', 'chat_two'] : ['chat_one'],
    backfilledGeneralChatIds: args.extraChannel ? ['chat_two'] : [],
    existingGeneralChatIds: [],
    requirements:
      pendingCollaboratorIds.length > 0 || openInviteCount > 0 ? ['pending_admission_reissue'] : []
  })
  const history = sealHistory({
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: base.planId,
    sourceDigest: base.sourceDigest,
    baseMaterializationDigest: base.materializationDigest,
    migrationAt: base.migrationAt,
    metadataMutations: metadataMutations.map(clone),
    logMutations: [],
    importedContributionCount: 0
  })
  return { directory, escrowPath, store, channel, extraChannel, base, history }
}

function deterministicRandomness() {
  let id = 0
  let token = 0
  return {
    randomId: () => `id_${String((id += 1)).padStart(3, '0')}`,
    randomToken: () => sha256(`token_${(token += 1)}`).slice(0, 32)
  }
}

function service(
  built: ReturnType<typeof fixture>,
  overrides: Partial<ConstructorParameters<typeof PeopleToChannelMigrationAdmissionReissue>[0]> = {}
) {
  return new PeopleToChannelMigrationAdmissionReissue({
    storagePath: built.escrowPath,
    safeStorage: safeStorage(),
    channels: built.store,
    now: () => 2_000,
    ...deterministicRandomness(),
    ...overrides
  })
}

function expectRecoveryBlocked(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(isPeopleToChannelAdmissionReissueError(error)).toBe(true)
}

describe('PeopleToChannelMigrationAdmissionReissue', () => {
  it('escrows only new Channel secrets before one metadata batch and reruns exactly', () => {
    const built = fixture()
    const first = service(built).apply({ base: built.base, history: built.history })

    expect(first).toMatchObject({
      metadataApplied: true,
      channelIds: [built.channel.channelId],
      escrowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      invitations: [
        {
          sourceShareId: 'share_one',
          channelId: built.channel.channelId,
          purpose: 'pending-collaborator',
          sourceCollaboratorId: 'collaborator_one',
          createdAt: 2_000,
          expiresAt: 2_000 + DEFAULT_CHANNEL_INVITE_TTL_MS
        },
        {
          sourceShareId: 'share_one',
          channelId: built.channel.channelId,
          purpose: 'open-invite',
          openInviteOrdinal: 1,
          createdAt: 2_000,
          expiresAt: 2_000 + DEFAULT_CHANNEL_INVITE_TTL_MS
        }
      ]
    })
    const storedInvites = built.store.listInvites(built.channel.channelId)
    expect(storedInvites).toHaveLength(2)
    expect(storedInvites.map((invite) => invite.tokenHash)).toEqual(
      first.invitations.map((invitation) => hashChannelInviteToken(invitation.inviteToken))
    )
    expect(first.invitations.map((invitation) => invitation.policy)).toEqual([
      built.base.pendingAdmissionReissues[0].policy,
      built.base.pendingAdmissionReissues[0].policy
    ])
    expect(statSync(built.escrowPath).mode & 0o777).toBe(0o600)
    const escrowBytes = readFileSync(built.escrowPath)
    const serialized = escrowBytes.toString('utf8')
    expect(serialized).toContain(`"schemaVersion": ${PEOPLE_TO_CHANNEL_ADMISSION_REISSUE_VERSION}`)
    for (const privateValue of [
      'collaborator_one',
      '"policy"',
      '"providerDispatch"',
      built.base.pendingAdmissionReissues[0].policy.sourceDigest,
      ...first.invitations.flatMap((invitation) => [
        invitation.inviteToken,
        invitation.inviteId,
        invitation.roomId
      ])
    ]) {
      expect(serialized).not.toContain(privateValue)
    }

    const rerun = service(built, {
      randomId: () => {
        throw new Error('must not mint another id')
      },
      randomToken: () => {
        throw new Error('must not mint another token')
      }
    }).apply({ base: built.base, history: built.history })
    expect(rerun).toEqual({ ...first, metadataApplied: false })
    expect(readFileSync(built.escrowPath)).toEqual(escrowBytes)
  })

  it('binds each future admission to the frozen source policy', () => {
    const built = fixture()
    const first = service(built).apply({ base: built.base, history: built.history })
    expect(first.invitations.every((invitation) => invitation.policy.rules.appendComment)).toBe(
      true
    )

    const { materializationDigest: _digest, ...changedDraft } = clone(built.base)
    changedDraft.pendingAdmissionReissues[0].policy = {
      ...changedDraft.pendingAdmissionReissues[0].policy,
      sourceDigest: 'd'.repeat(64),
      rules: contributionRulesForPreset('readOnly')
    }
    const changed = sealBase(changedDraft)
    const { executionDigest: _historyDigest, ...historyDraft } = clone(built.history)
    historyDraft.baseMaterializationDigest = changed.materializationDigest
    const history = sealHistory(historyDraft)

    expectRecoveryBlocked(() => service(built).apply({ base: changed, history }))
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(2)
  })

  it('enriches a fresh create and commits every unrelated metadata target atomically', () => {
    const built = fixture({ mode: 'create', extraChannel: true })
    expect(built.store.listChannels()).toEqual([])

    const first = service(built).apply({ base: built.base, history: built.history })
    expect(first.metadataApplied).toBe(true)
    expect(first.channelIds).toEqual(
      [built.channel.channelId, built.extraChannel!.channelId].sort(compareText)
    )
    expect(
      built.store
        .listChannels()
        .map((channel) => channel.channelId)
        .sort(compareText)
    ).toEqual(first.channelIds)
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(2)
    expect(built.store.listInvites(built.extraChannel!.channelId)).toEqual([])

    const rerun = service(built, {
      randomId: () => {
        throw new Error('must reuse full-batch escrow ids')
      },
      randomToken: () => {
        throw new Error('must reuse full-batch escrow tokens')
      }
    }).apply({ base: built.base, history: built.history })
    expect(rerun).toEqual({ ...first, metadataApplied: false })
    expect(built.store.listChannels()).toHaveLength(2)
  })

  it('resumes after encrypted escrow is durable but before Channel metadata', () => {
    const built = fixture({ mode: 'create', extraChannel: true })
    expect(() =>
      service(built, {
        afterEscrowDurable: () => {
          throw new Error('injected crash after escrow')
        }
      }).apply({ base: built.base, history: built.history })
    ).toThrow('injected crash after escrow')
    expect(existsSync(built.escrowPath)).toBe(true)
    expect(built.store.listChannels()).toEqual([])
    expect(built.store.listInvites(built.channel.channelId)).toEqual([])

    const recovered = service(built, {
      randomId: () => {
        throw new Error('must reuse escrow ids')
      },
      randomToken: () => {
        throw new Error('must reuse escrow tokens')
      }
    }).apply({ base: built.base, history: built.history })
    expect(recovered.metadataApplied).toBe(true)
    expect(recovered.invitations).toHaveLength(2)
    expect(built.store.listChannels()).toHaveLength(2)
  })

  it('resumes after Channel metadata is durable but before the caller records completion', () => {
    const built = fixture({ mode: 'create', extraChannel: true })
    expect(() =>
      service(built, {
        afterChannelApplied: () => {
          throw new Error('injected crash after Channel apply')
        }
      }).apply({ base: built.base, history: built.history })
    ).toThrow('injected crash after Channel apply')
    expect(built.store.listChannels()).toHaveLength(2)
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(2)

    const recovered = service(built).apply({ base: built.base, history: built.history })
    expect(recovered.metadataApplied).toBe(false)
    expect(recovered.invitations).toHaveLength(2)
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(2)
    expect(built.store.listChannels()).toHaveLength(2)
  })

  it('blocks a stale Channel target before persisting any new secret authority', () => {
    const built = fixture()
    built.store.createInvite({ channelId: built.channel.channelId, now: 1_500 })

    expectRecoveryBlocked(() => service(built).apply({ base: built.base, history: built.history }))
    expect(existsSync(built.escrowPath)).toBe(false)
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(1)
  })

  it('fails closed on unavailable encryption or corrupt escrow without minting replacements', () => {
    const unavailable = fixture()
    expectRecoveryBlocked(() =>
      service(unavailable, { safeStorage: safeStorage(false) }).apply({
        base: unavailable.base,
        history: unavailable.history
      })
    )
    expect(existsSync(unavailable.escrowPath)).toBe(false)
    expect(unavailable.store.listInvites(unavailable.channel.channelId)).toEqual([])

    const corrupt = fixture()
    service(corrupt).apply({ base: corrupt.base, history: corrupt.history })
    const outer = JSON.parse(readFileSync(corrupt.escrowPath, 'utf8')) as Record<string, unknown>
    outer.payloadDigest = 'f'.repeat(64)
    writeFileSync(corrupt.escrowPath, `${JSON.stringify(outer)}\n`, 'utf8')
    expectRecoveryBlocked(() =>
      service(corrupt).apply({ base: corrupt.base, history: corrupt.history })
    )
    expect(corrupt.store.listInvites(corrupt.channel.channelId)).toHaveLength(2)
  })

  it('bounds a hostile manifest before generating or persisting any credentials', () => {
    const built = fixture()
    const { materializationDigest: _digest, ...oversizedDraft } = clone(built.base)
    oversizedDraft.pendingAdmissionReissues[0].openInviteCount = MAX_PEOPLE_TO_CHANNEL_REISSUES + 1
    const oversized = sealBase(oversizedDraft)
    const { executionDigest: _historyDigest, ...historyDraft } = clone(built.history)
    historyDraft.baseMaterializationDigest = oversized.materializationDigest
    const history = sealHistory(historyDraft)

    expectRecoveryBlocked(() =>
      service(built, {
        randomId: () => {
          throw new Error('must reject before generating ids')
        },
        randomToken: () => {
          throw new Error('must reject before generating tokens')
        }
      }).apply({ base: oversized, history })
    )
    expect(existsSync(built.escrowPath)).toBe(false)
    expect(built.store.listInvites(built.channel.channelId)).toEqual([])
  })

  it('rejects a multiply-linked escrow before trusting its credential custody', () => {
    const built = fixture()
    service(built).apply({ base: built.base, history: built.history })
    linkSync(built.escrowPath, join(built.directory, 'foreign-escrow-link.json'))

    expectRecoveryBlocked(() => service(built).apply({ base: built.base, history: built.history }))
    expect(built.store.listInvites(built.channel.channelId)).toHaveLength(2)
  })

  it('needs no keychain or escrow when the frozen migration has no pending admissions', () => {
    const built = fixture({ pendingCollaboratorIds: [], openInviteCount: 0 })
    const result = service(built, { safeStorage: safeStorage(false) }).apply({
      base: built.base,
      history: built.history
    })

    expect(result).toEqual({
      metadataApplied: false,
      channelIds: [],
      invitations: [],
      escrowDigest: null
    })
    expect(existsSync(built.escrowPath)).toBe(false)
  })
})
