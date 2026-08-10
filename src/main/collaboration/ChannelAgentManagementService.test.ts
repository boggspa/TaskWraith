import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  importRawEd25519PublicKey,
  type KeyPair
} from '../../shared/e2ee/keys'
import { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import { ChannelAgentIdentityStore } from './ChannelAgentIdentityStore'
import {
  CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS,
  ChannelAgentManagementError,
  ChannelAgentManagementService,
  type ChannelAgentManagementAuthorityPort,
  type ChannelAgentManagementChannelPort,
  type ChannelAgentManagementIdentityPort
} from './ChannelAgentManagementService'
import { ChannelStore, type Channel } from './ChannelStore'

const SEAT_ID = 'pooled-agent-management-proof'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

interface Harness {
  readonly root: string
  readonly ownerIdentity: KeyPair
  readonly channels: ChannelStore
  readonly identities: ChannelAgentIdentityStore
  readonly authority: ChannelAgentAuthorityStore
  readonly service: ChannelAgentManagementService
  now: number
  createChannel(title?: string): Channel
  createService(options?: {
    channels?: ChannelAgentManagementChannelPort
    authority?: ChannelAgentManagementAuthorityPort
    identities?: ChannelAgentManagementIdentityPort
    loadOwnerIdentity?: () => KeyPair
  }): ChannelAgentManagementService
}

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function encryptedBytes(value: string | Buffer): Buffer {
  return Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5))
}

function channelPort(
  store: ChannelStore,
  overrides: Partial<ChannelAgentManagementChannelPort> = {}
): ChannelAgentManagementChannelPort {
  return {
    listChannels: () => store.listChannels(),
    getChannel: (channelId) => store.getChannel(channelId),
    getMember: (channelId, memberId) => store.getMember(channelId, memberId),
    listMembers: (channelId) => store.listMembers(channelId),
    registerAgentMember: (args) => store.registerAgentMember(args),
    revokeMember: (args) => store.revokeMember(args),
    ...overrides
  }
}

function authorityPort(
  store: ChannelAgentAuthorityStore,
  overrides: Partial<ChannelAgentManagementAuthorityPort> = {}
): ChannelAgentManagementAuthorityPort {
  return {
    registerDelegation: (value) => store.registerDelegation(value),
    registerDispatchGrant: (value) => store.registerDispatchGrant(value),
    registerRevocation: (value) => store.registerRevocation(value),
    snapshot: (channelId) => store.snapshot(channelId),
    ...overrides
  }
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'channel-agent-management-'))
  roots.push(root)
  const ownerIdentity = generateIdentityKeyPair()
  const channels = new ChannelStore(join(root, 'channels.json'))
  const clock = { value: 1_786_000_000_000 }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => encryptedBytes(plain),
    decryptString: (encrypted: Buffer) => encryptedBytes(encrypted).toString('utf8')
  }
  const identities = new ChannelAgentIdentityStore({
    storageDirectory: join(root, 'identities'),
    safeStorage,
    platform: 'darwin',
    now: () => clock.value
  })
  const authority = new ChannelAgentAuthorityStore({
    storageDirectory: join(root, 'authority'),
    now: () => clock.value,
    resolveOwnerPublicKey: (channelId, ownerMemberId) => {
      const owner = channels.getMember(channelId, ownerMemberId)
      if (!owner || owner.kind !== 'human') return null
      try {
        return importRawEd25519PublicKey(Buffer.from(owner.identityPublicKey, 'base64'))
      } catch {
        return null
      }
    }
  })
  const createService = (
    options: {
      channels?: ChannelAgentManagementChannelPort
      authority?: ChannelAgentManagementAuthorityPort
      identities?: ChannelAgentManagementIdentityPort
      loadOwnerIdentity?: () => KeyPair
    } = {}
  ): ChannelAgentManagementService =>
    new ChannelAgentManagementService({
      channels: options.channels ?? channelPort(channels),
      identities: options.identities ?? identities,
      authority: options.authority ?? authorityPort(authority),
      loadOwnerIdentity: options.loadOwnerIdentity ?? (() => ownerIdentity),
      now: () => clock.value
    })
  const result: Harness = {
    root,
    ownerIdentity,
    channels,
    identities,
    authority,
    service: createService(),
    get now() {
      return clock.value
    },
    set now(value: number) {
      clock.value = value
    },
    createChannel: (title = 'Agent management proof') =>
      channels.createChannel({
        chatId: `chat-${channels.listChannels().length + 1}`,
        owner: {
          displayName: 'Channel Owner',
          identityPublicKey: exportRawEd25519PublicKey(ownerIdentity.publicKey).toString('base64')
        },
        title,
        now: clock.value
      }).channel,
    createService
  }
  return result
}

function seat() {
  return { agentSeatId: SEAT_ID, displayName: 'Build Agent' }
}

function expectCode(action: () => unknown, code: ChannelAgentManagementError['code']): void {
  try {
    action()
    throw new Error('Expected ChannelAgentManagementError')
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelAgentManagementError)
    expect(error).toMatchObject({ code })
  }
}

describe('ChannelAgentManagementService', () => {
  it('enrolls one stable seat idempotently after persisting owner delegation', () => {
    const h = harness()
    const channel = h.createChannel()

    const enrolled = h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-stable-seat'
    })
    const retried = h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-stable-seat'
    })

    expect(enrolled.identity).toMatchObject({ agentSeatId: SEAT_ID, keyGeneration: 1 })
    expect(enrolled.member).toMatchObject({
      kind: 'agent',
      status: 'active',
      agentSeatId: SEAT_ID,
      keyGeneration: 1
    })
    expect(retried.member.memberId).toBe(enrolled.member.memberId)
    expect(
      h.channels.listMembers(channel.channelId).filter((member) => member.kind === 'agent')
    ).toHaveLength(1)
    expect(h.authority.snapshot(channel.channelId)).toMatchObject({
      delegations: [{ signedDelegation: enrolled.signedDelegation }],
      revocations: []
    })
  })

  it('reuses a durable orphan delegation after a crash before membership persistence', () => {
    const h = harness()
    const channel = h.createChannel()
    let failMemberWrite = true
    const crashingChannels = channelPort(h.channels, {
      registerAgentMember: (args) => {
        if (failMemberWrite) {
          failMemberWrite = false
          throw new Error('simulated membership crash')
        }
        return h.channels.registerAgentMember(args)
      }
    })
    const crashing = h.createService({ channels: crashingChannels })

    expect(() =>
      crashing.enrollAgent({
        channelId: channel.channelId,
        seat: seat(),
        operationId: 'enroll-crash-proof'
      })
    ).toThrow(/simulated membership crash/)
    expect(h.authority.snapshot(channel.channelId)?.delegations).toHaveLength(1)
    expect(
      h.channels.listMembers(channel.channelId).filter((member) => member.kind === 'agent')
    ).toHaveLength(0)

    const recovered = h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-crash-proof'
    })
    expect(recovered.member.status).toBe('active')
    expect(h.authority.snapshot(channel.channelId)?.delegations).toHaveLength(1)
  })

  it('materializes retired global generations as revoked Channel tombstones', () => {
    const h = harness()
    const channel = h.createChannel()
    h.identities.loadOrCreate(SEAT_ID)
    h.now += 1
    h.identities.rotate(SEAT_ID)
    h.now += 1
    h.identities.rotate(SEAT_ID)

    const enrolled = h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-generation-three'
    })
    const members = h.channels
      .listMembers(channel.channelId)
      .filter((member) => member.kind === 'agent')

    expect(enrolled.identity.keyGeneration).toBe(3)
    expect(members).toMatchObject([
      { keyGeneration: 1, status: 'revoked' },
      { keyGeneration: 2, status: 'revoked' },
      { keyGeneration: 3, status: 'active' }
    ])
    expect(h.authority.snapshot(channel.channelId)).toMatchObject({
      delegations: [{}, {}, {}],
      revocations: [{}, {}]
    })
  })

  it('issues an idempotent bounded grant and revokes its predecessor before replacement', () => {
    const h = harness()
    const channel = h.createChannel()
    const owner = h.channels.getMember(channel.channelId, channel.ownerMemberId)!
    h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-for-grant'
    })

    const first = h.service.grantDispatch({
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'grant-one',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: HASH_A,
      permissionPostureHash: HASH_B
    })
    const retried = h.service.grantDispatch({
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'grant-one',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: HASH_A,
      permissionPostureHash: HASH_B
    })
    expect(retried.signedDispatchGrant).toEqual(first.signedDispatchGrant)
    expect(first.signedDispatchGrant.grant).toMatchObject({
      maxDispatches: 1,
      expiresAt: h.now + CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS
    })

    h.now += 1
    const replacement = h.service.grantDispatch({
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'grant-two',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: HASH_A,
      permissionPostureHash: HASH_B,
      maxDispatches: 2
    })
    const snapshot = h.authority.snapshot(channel.channelId)!
    expect(replacement.signedDispatchGrant.grant.grantId).not.toBe(
      first.signedDispatchGrant.grant.grantId
    )
    expect(snapshot.dispatchGrants).toHaveLength(2)
    expect(snapshot.revocations).toHaveLength(1)
    expect(snapshot.revocations[0].signedRevocation.revocation).toMatchObject({
      targetKind: 'dispatch_grant',
      targetId: first.signedDispatchGrant.grant.grantId
    })
  })

  it('recovers an already-persisted grant without resetting its budget after a thrown response', () => {
    const h = harness()
    const channel = h.createChannel()
    const owner = h.channels.getMember(channel.channelId, channel.ownerMemberId)!
    h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-grant-crash'
    })
    let failResponse = true
    const crashingAuthority = authorityPort(h.authority, {
      registerDispatchGrant: (value) => {
        const result = h.authority.registerDispatchGrant(value)
        if (failResponse) {
          failResponse = false
          throw new Error('simulated grant response crash')
        }
        return result
      }
    })
    const crashing = h.createService({ authority: crashingAuthority })
    const input = {
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'grant-crash-proof',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: HASH_A,
      permissionPostureHash: HASH_B,
      maxDispatches: 3
    }

    expect(() => crashing.grantDispatch(input)).toThrow(/simulated grant response crash/)
    const recovered = h.service.grantDispatch(input)
    expect(recovered.signedDispatchGrant.grant.maxDispatches).toBe(3)
    expect(h.authority.snapshot(channel.channelId)).toMatchObject({
      dispatchGrants: [{}],
      revocations: []
    })
  })

  it('persists key revocation before member revocation and resumes safely', () => {
    const h = harness()
    const channel = h.createChannel()
    const enrolled = h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-for-revoke'
    })
    h.now += 366 * 24 * 60 * 60 * 1_000
    let failMemberWrite = true
    const crashingChannels = channelPort(h.channels, {
      revokeMember: (args) => {
        if (failMemberWrite) {
          failMemberWrite = false
          throw new Error('simulated revoke crash')
        }
        return h.channels.revokeMember(args)
      }
    })
    const crashing = h.createService({ channels: crashingChannels })

    expect(() =>
      crashing.revokeAgent({
        channelId: channel.channelId,
        agentSeatId: SEAT_ID,
        operationId: 'revoke-crash-proof'
      })
    ).toThrow(/simulated revoke crash/)
    expect(h.channels.getMember(channel.channelId, enrolled.member.memberId)?.status).toBe('active')
    expect(h.authority.snapshot(channel.channelId)?.revocations).toHaveLength(1)

    const recovered = h.service.revokeAgent({
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'revoke-crash-proof',
      reason: 'channel_closed'
    })
    expect(recovered.member.status).toBe('revoked')
    expect(recovered.alreadyRevoked).toBe(false)
    expect(h.authority.snapshot(channel.channelId)?.revocations).toHaveLength(1)
    expect(
      h.authority.snapshot(channel.channelId)?.revocations[0].signedRevocation.revocation.reason
    ).toBe('agent_removed')
  })

  it('rotates one stable identity across every active Channel exactly once per operation', () => {
    const h = harness()
    const first = h.createChannel('First Channel')
    const second = h.createChannel('Second Channel')
    for (const [channel, operationId] of [
      [first, 'enroll-first'],
      [second, 'enroll-second']
    ] as const) {
      h.service.enrollAgent({ channelId: channel.channelId, seat: seat(), operationId })
    }
    h.now += 1

    const rotated = h.service.rotateAgentKey({
      agentSeatId: SEAT_ID,
      operationId: 'rotate-both'
    })
    const retried = h.service.rotateAgentKey({
      agentSeatId: SEAT_ID,
      operationId: 'rotate-both'
    })

    expect(rotated.identity.keyGeneration).toBe(2)
    expect(rotated.channels).toHaveLength(2)
    expect(retried.identity.keyGeneration).toBe(2)
    expect(retried.resumed).toBe(true)
    for (const channel of [first, second]) {
      expect(
        h.channels
          .listMembers(channel.channelId)
          .filter((member) => member.kind === 'agent')
          .map((member) => ({ generation: member.keyGeneration, status: member.status }))
      ).toEqual([
        { generation: 1, status: 'revoked' },
        { generation: 2, status: 'active' }
      ])
      expect(
        h.authority
          .snapshot(channel.channelId)
          ?.revocations.some(
            (record) => record.signedRevocation.revocation.reason === 'key_rotated'
          )
      ).toBe(true)
    }
  })

  it('resumes a global rotation after custody advances but before re-enrollment', () => {
    const h = harness()
    const first = h.createChannel('Crash rotation one')
    const second = h.createChannel('Crash rotation two')
    h.service.enrollAgent({
      channelId: first.channelId,
      seat: seat(),
      operationId: 'enroll-crash-rotation-one'
    })
    h.service.enrollAgent({
      channelId: second.channelId,
      seat: seat(),
      operationId: 'enroll-crash-rotation-two'
    })
    h.now += 1
    let failAfterRotation = true
    const crashingIdentities: ChannelAgentManagementIdentityPort = {
      loadOrCreate: (agentSeatId) => h.identities.loadOrCreate(agentSeatId),
      load: (agentSeatId) => h.identities.load(agentSeatId),
      publicHistory: (agentSeatId) => h.identities.publicHistory(agentSeatId),
      rotate: (agentSeatId) => {
        const result = h.identities.rotate(agentSeatId)
        if (failAfterRotation) {
          failAfterRotation = false
          throw new Error('simulated post-rotation crash')
        }
        return result
      }
    }
    const crashing = h.createService({ identities: crashingIdentities })

    expect(() =>
      crashing.rotateAgentKey({ agentSeatId: SEAT_ID, operationId: 'crash-safe-rotation' })
    ).toThrow(/simulated post-rotation crash/)
    expect(h.identities.load(SEAT_ID)?.keyGeneration).toBe(2)
    for (const channel of [first, second]) {
      expect(
        h.channels
          .listMembers(channel.channelId)
          .filter((member) => member.kind === 'agent')
          .every((member) => member.status === 'revoked')
      ).toBe(true)
    }

    const recovered = h.service.rotateAgentKey({
      agentSeatId: SEAT_ID,
      operationId: 'crash-safe-rotation'
    })
    expect(recovered.identity.keyGeneration).toBe(2)
    expect(recovered.resumed).toBe(true)
    expect(recovered.channels).toHaveLength(2)
  })

  it('requires explicit rotation before re-enrolling a removed seat', () => {
    const h = harness()
    const channel = h.createChannel()
    h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-remove-readd'
    })
    h.service.revokeAgent({
      channelId: channel.channelId,
      agentSeatId: SEAT_ID,
      operationId: 'remove-before-readd'
    })

    expectCode(
      () =>
        h.service.enrollAgent({
          channelId: channel.channelId,
          seat: seat(),
          operationId: 'unsafe-readd'
        }),
      'rotation_required'
    )
    h.now += 1
    const rotated = h.service.rotateAgentKey({
      agentSeatId: SEAT_ID,
      operationId: 'rotate-for-readd',
      reEnrollChannelIds: [channel.channelId]
    })
    expect(rotated.identity.keyGeneration).toBe(2)
    expect(rotated.channels[0].member.status).toBe('active')
  })

  it('rejects an unpinned owner and invalid mentioners before widening authority', () => {
    const h = harness()
    const channel = h.createChannel()
    const wrongOwner = generateIdentityKeyPair()
    const wrongService = h.createService({ loadOwnerIdentity: () => wrongOwner })

    expectCode(
      () =>
        wrongService.enrollAgent({
          channelId: channel.channelId,
          seat: seat(),
          operationId: 'wrong-owner'
        }),
      'identity_mismatch'
    )
    expect(h.identities.load(SEAT_ID)).toBeNull()

    h.service.enrollAgent({
      channelId: channel.channelId,
      seat: seat(),
      operationId: 'enroll-valid-owner'
    })
    const before = h.authority.snapshot(channel.channelId)?.revision
    expectCode(
      () =>
        h.service.grantDispatch({
          channelId: channel.channelId,
          agentSeatId: SEAT_ID,
          operationId: 'invalid-mentioner',
          allowedMentionerMemberIds: ['unknown-human'],
          workspaceIdentityHash: HASH_A,
          permissionPostureHash: HASH_B
        }),
      'invalid_input'
    )
    expect(h.authority.snapshot(channel.channelId)?.revision).toBe(before)
  })
})
