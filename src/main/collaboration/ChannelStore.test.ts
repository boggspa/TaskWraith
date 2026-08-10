import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_SCHEMA_VERSION,
  ChannelError,
  ChannelStore,
  MAX_CHANNEL_MEMBERS,
  type TaskWraithReference
} from './ChannelStore'
import {
  CHANNEL_LOG_SCHEMA_VERSION,
  ChannelMessageLog,
  redactChannelContent
} from './ChannelMessageLog'
import {
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  signChannelAgentRevocation,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost,
  type ChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { CHANNEL_AGENT_MESSAGE_PROOF_VERSION } from '../../shared/collaboration/ChannelAgentMessageProof'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p1-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function channelFixture() {
  const directory = temporaryDirectory()
  const storePath = join(directory, 'channels.json')
  const store = new ChannelStore(storePath)
  const created = store.createChannel({
    chatId: 'general-chat',
    owner: { displayName: 'Host', identityPublicKey: 'ed25519:host' },
    title: 'Launch room',
    reference: { kind: 'chat', id: 'general-chat' },
    now: 1_000
  })
  const log = new ChannelMessageLog(join(directory, 'logs'), store)
  return { directory, storePath, store, log, ...created }
}

function agentChannelFixture() {
  const directory = temporaryDirectory()
  const storePath = join(directory, 'channels.json')
  const ownerKeys = generateIdentityKeyPair()
  const agentKeys = generateIdentityKeyPair()
  const store = new ChannelStore(storePath)
  const created = store.createChannel({
    chatId: 'agent-chat',
    owner: {
      displayName: 'Host',
      identityPublicKey: exportRawEd25519PublicKey(ownerKeys.publicKey).toString('base64')
    },
    title: 'Agent room',
    now: 1_000
  })
  const baseDelegation: ChannelAgentDelegation = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: 'delegation-agent-1',
    channelId: created.channel.channelId,
    ownerMemberId: created.owner.memberId,
    agentMemberId: 'agent-member-1',
    agentSeatId: 'pooled-agent-1',
    agentPublicKeyB64: exportRawEd25519PublicKey(agentKeys.publicKey).toString('base64'),
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 100_000,
    maxPostBytes: 8_000
  }
  const signDelegation = (overrides: Partial<ChannelAgentDelegation> = {}) =>
    signChannelAgentDelegation(ownerKeys.privateKey, { ...baseDelegation, ...overrides })
  return {
    directory,
    storePath,
    store,
    ownerKeys,
    agentKeys,
    baseDelegation,
    signDelegation,
    ...created
  }
}

function agentLogFixture() {
  const fixture = agentChannelFixture()
  const signedDelegation = fixture.signDelegation()
  const member = fixture.store.registerAgentMember({
    channelId: fixture.channel.channelId,
    displayName: 'Build Agent',
    signedDelegation,
    now: 2_000
  })
  const grantValue: ChannelAgentDispatchGrant = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: 'grant-agent-1',
    channelId: fixture.channel.channelId,
    ownerMemberId: fixture.owner.memberId,
    agentMemberId: member.memberId,
    agentSeatId: member.agentSeatId,
    agentPublicKeyB64: member.identityPublicKey,
    keyGeneration: member.keyGeneration,
    delegationId: signedDelegation.delegation.delegationId,
    trigger: 'mention',
    allowedMentionerMemberIds: [fixture.owner.memberId],
    workspaceIdentityHash: 'a'.repeat(64),
    permissionPostureHash: 'b'.repeat(64),
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 100_000,
    maxDispatches: 2
  }
  const signedGrant = signChannelAgentDispatchGrant(fixture.ownerKeys.privateKey, grantValue)
  const makeAuthority = () =>
    new ChannelAgentAuthorityStore({
      storageDirectory: join(fixture.directory, 'agent-authority'),
      resolveOwnerPublicKey: (channelId, ownerMemberId) =>
        channelId === fixture.channel.channelId && ownerMemberId === fixture.owner.memberId
          ? fixture.ownerKeys.publicKey
          : null,
      platform: 'darwin'
    })
  const authority = makeAuthority()
  authority.registerDelegation(signedDelegation)
  authority.registerDispatchGrant(signedGrant)
  authority.consumeDispatch(fixture.channel.channelId, {
    grantId: grantValue.grantId,
    triggerMessageId: 'trigger-message-1',
    mentionerMemberId: fixture.owner.memberId,
    workspaceIdentityHash: grantValue.workspaceIdentityHash,
    permissionPostureHash: grantValue.permissionPostureHash,
    at: 3_000
  })
  const postValue = (overrides: Partial<ChannelAgentPost> = {}): ChannelAgentPost => {
    const content = overrides.content ?? 'Agent result'
    return {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      channelId: fixture.channel.channelId,
      agentMemberId: member.memberId,
      agentSeatId: member.agentSeatId,
      agentPublicKeyB64: member.identityPublicKey,
      keyGeneration: member.keyGeneration,
      delegationId: signedDelegation.delegation.delegationId,
      dispatchGrantId: grantValue.grantId,
      triggerMessageId: 'trigger-message-1',
      runId: 'run-agent-1',
      runAuthorityHash: 'c'.repeat(64),
      clientMessageId: 'agent-client-1',
      kind: 'agent.text',
      content,
      contentHash: hashChannelAgentContent(content),
      createdAt: 4_000,
      ...overrides
    }
  }
  const signPost = (overrides: Partial<ChannelAgentPost> = {}) =>
    signChannelAgentPost(fixture.agentKeys.privateKey, postValue(overrides))
  const log = new ChannelMessageLog(
    join(fixture.directory, 'logs'),
    fixture.store,
    redactChannelContent,
    authority
  )
  return {
    ...fixture,
    authority,
    makeAuthority,
    signedDelegation,
    signedGrant,
    member,
    postValue,
    signPost,
    log
  }
}

function expectCode(action: () => unknown, code: ChannelError['code']) {
  expect(action).toThrowError(ChannelError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('ChannelStore', () => {
  it('persists human metadata and its immutable display envelope', () => {
    const { store, storePath, channel, owner } = channelFixture()
    const invited = store.admitMember({
      channelId: channel.channelId,
      displayName: 'Member B',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b',
      now: 2_000
    })

    const reloaded = new ChannelStore(storePath)
    expect(reloaded.getChannel(channel.channelId)).toMatchObject({
      chatId: 'general-chat',
      ownerMemberId: owner.memberId,
      membershipRevision: 2
    })
    expect(reloaded.getMember(channel.channelId, invited.memberId)).toMatchObject({
      kind: 'human',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b',
      status: 'active'
    })
    expect(reloaded.getDisplayEnvelope(channel.channelId)).toEqual({
      title: 'Launch room',
      status: 'active',
      memberCount: 2,
      messageCount: 0
    })
  })

  it('migrates v2 human snapshots exactly before the next durable mutation', () => {
    const { storePath, channel, owner } = channelFixture()
    const v2 = JSON.parse(readFileSync(storePath, 'utf8')) as {
      schemaVersion: number
      members: unknown[]
    }
    v2.schemaVersion = 2
    writeFileSync(storePath, JSON.stringify(v2), 'utf8')

    const reloaded = new ChannelStore(storePath)
    expect(reloaded.getMember(channel.channelId, owner.memberId)).toEqual(v2.members[0])
    reloaded.createInvite({ channelId: channel.channelId, now: 2_000 })

    const migrated = JSON.parse(readFileSync(storePath, 'utf8')) as {
      schemaVersion: number
      members: unknown[]
    }
    expect(migrated.schemaVersion).toBe(CHANNEL_SCHEMA_VERSION)
    expect(migrated.members).toEqual(v2.members)
  })

  it('persists only bounded schema-v4 human presentation metadata', () => {
    const { storePath, channel, owner } = channelFixture()
    const valid = JSON.parse(readFileSync(storePath, 'utf8')) as {
      schemaVersion: number
      members: Array<Record<string, unknown>>
    }
    valid.members[0].presentation = { seatOrder: 4_096, colorIndex: 7, seatDisabled: true }
    writeFileSync(storePath, JSON.stringify(valid), 'utf8')

    expect(new ChannelStore(storePath).getMember(channel.channelId, owner.memberId)).toMatchObject({
      presentation: { seatOrder: 4_096, colorIndex: 7, seatDisabled: true }
    })

    for (const presentation of [
      {},
      { seatOrder: -1 },
      { seatOrder: 4_097 },
      { colorIndex: 8 },
      { seatDisabled: 'yes' },
      { colorIndex: 2, cssColor: 'red' }
    ]) {
      valid.members[0].presentation = presentation
      writeFileSync(storePath, JSON.stringify(valid), 'utf8')
      expectCode(() => new ChannelStore(storePath).listChannels(), 'recovery_blocked')
    }

    valid.members[0].presentation = { colorIndex: 2 }
    valid.schemaVersion = 3
    writeFileSync(storePath, JSON.stringify(valid), 'utf8')
    expectCode(() => new ChannelStore(storePath).listChannels(), 'recovery_blocked')
  })

  it('persists owner-signed agent membership while keeping relay sessions human-only', () => {
    const { store, storePath, channel, signDelegation } = agentChannelFixture()
    const signedDelegation = signDelegation()
    const admitted = store.registerAgentMember({
      channelId: channel.channelId,
      displayName: 'Build Agent',
      signedDelegation,
      now: 2_000
    })

    expect(admitted).toEqual({
      memberId: 'agent-member-1',
      channelId: channel.channelId,
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey: signedDelegation.delegation.agentPublicKeyB64,
      status: 'active',
      agentSeatId: 'pooled-agent-1',
      keyGeneration: 1,
      joinedAt: 2_000
    })
    expect(
      store.registerAgentMember({
        channelId: channel.channelId,
        displayName: 'Mutable label is ignored',
        signedDelegation,
        now: 200_000
      })
    ).toEqual(admitted)
    expect(store.getDisplayEnvelope(channel.channelId).memberCount).toBe(2)
    expect(store.getChannel(channel.channelId)?.membershipRevision).toBe(2)
    expect(new ChannelStore(storePath).getMember(channel.channelId, admitted.memberId)).toEqual(
      admitted
    )
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: admitted.memberId,
          identityPublicKey: admitted.identityPublicKey
        }),
      'human_only'
    )

    const v3 = JSON.parse(readFileSync(storePath, 'utf8')) as { schemaVersion: number }
    v3.schemaVersion = 3
    writeFileSync(storePath, JSON.stringify(v3), 'utf8')
    const legacyAgentStore = new ChannelStore(storePath)
    expect(legacyAgentStore.getMember(channel.channelId, admitted.memberId)).toEqual(admitted)
    legacyAgentStore.createInvite({ channelId: channel.channelId, now: 3_000 })
    expect(JSON.parse(readFileSync(storePath, 'utf8')).schemaVersion).toBe(CHANNEL_SCHEMA_VERSION)
  })

  it('rejects forged, rootless, postless, and non-contiguous agent memberships', () => {
    const { store, channel, baseDelegation, signDelegation } = agentChannelFixture()
    const foreignOwner = generateIdentityKeyPair()
    const forged = signChannelAgentDelegation(foreignOwner.privateKey, baseDelegation)
    expectCode(
      () =>
        store.registerAgentMember({
          channelId: channel.channelId,
          displayName: 'Forged',
          signedDelegation: forged,
          now: 2_000
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        store.registerAgentMember({
          channelId: channel.channelId,
          displayName: 'Wrong root',
          signedDelegation: signDelegation({ channelId: 'other-channel' }),
          now: 2_000
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        store.registerAgentMember({
          channelId: channel.channelId,
          displayName: 'Dispatch only',
          signedDelegation: signDelegation({ scopes: ['channel.dispatch'] }),
          now: 2_000
        }),
      'protocol_unsupported'
    )
    expectCode(
      () =>
        store.registerAgentMember({
          channelId: channel.channelId,
          displayName: 'Generation two',
          signedDelegation: signDelegation({ keyGeneration: 2 }),
          now: 2_000
        }),
      'identity_mismatch'
    )
    expect(store.listMembers(channel.channelId)).toHaveLength(1)
  })

  it('retains revoked agent generations and counts active agents against the shared ceiling', () => {
    const { store, channel, signDelegation } = agentChannelFixture()
    const first = store.registerAgentMember({
      channelId: channel.channelId,
      displayName: 'Build Agent',
      signedDelegation: signDelegation(),
      now: 2_000
    })
    store.revokeMember({ channelId: channel.channelId, memberId: first.memberId, now: 3_000 })

    const rotatedKeys = generateIdentityKeyPair()
    const rotated = store.registerAgentMember({
      channelId: channel.channelId,
      displayName: 'Build Agent',
      signedDelegation: signDelegation({
        delegationId: 'delegation-agent-2',
        agentMemberId: 'agent-member-2',
        agentPublicKeyB64: exportRawEd25519PublicKey(rotatedKeys.publicKey).toString('base64'),
        keyGeneration: 2,
        issuedAt: 4_000,
        notBefore: 4_000
      }),
      now: 4_000
    })
    expect(store.getMember(channel.channelId, first.memberId)).toMatchObject({
      status: 'revoked',
      revokedAt: 3_000,
      keyGeneration: 1
    })
    expect(rotated).toMatchObject({ status: 'active', keyGeneration: 2 })

    for (let index = 0; index < MAX_CHANNEL_MEMBERS - 2; index += 1) {
      store.admitMember({
        channelId: channel.channelId,
        displayName: `Human ${index}`,
        identityPublicKey: `human-key-${index}`,
        roomId: `human-room-${index}`,
        now: 5_000 + index
      })
    }
    const anotherKeys = generateIdentityKeyPair()
    expectCode(
      () =>
        store.registerAgentMember({
          channelId: channel.channelId,
          displayName: 'Ninth active member',
          signedDelegation: signDelegation({
            delegationId: 'delegation-other-seat',
            agentMemberId: 'agent-member-other-seat',
            agentSeatId: 'pooled-agent-2',
            agentPublicKeyB64: exportRawEd25519PublicKey(anotherKeys.publicKey).toString('base64'),
            keyGeneration: 1
          }),
          now: 6_000
        }),
      'quota_exceeded'
    )
  })

  it('blocks legacy or malformed snapshots from smuggling agent membership', () => {
    const { store, storePath, channel, signDelegation } = agentChannelFixture()
    store.registerAgentMember({
      channelId: channel.channelId,
      displayName: 'Build Agent',
      signedDelegation: signDelegation(),
      now: 2_000
    })
    const valid = JSON.parse(readFileSync(storePath, 'utf8')) as {
      schemaVersion: number
      members: Array<Record<string, unknown>>
    }

    writeFileSync(storePath, JSON.stringify({ ...valid, schemaVersion: 2 }), 'utf8')
    expectCode(() => new ChannelStore(storePath).listChannels(), 'recovery_blocked')

    const malformed = structuredClone(valid)
    const agent = malformed.members.find((member) => member.kind === 'agent')!
    agent.roomId = 'relay-room'
    writeFileSync(storePath, JSON.stringify(malformed), 'utf8')
    expectCode(() => new ChannelStore(storePath).listChannels(), 'recovery_blocked')
  })

  it('enforces the eight-member ceiling, pins identities, and scopes revocation', () => {
    const { store, channel } = channelFixture()
    const members = Array.from({ length: MAX_CHANNEL_MEMBERS - 1 }, (_, index) =>
      store.admitMember({
        channelId: channel.channelId,
        displayName: `Member ${index}`,
        identityPublicKey: `ed25519:${index}`,
        roomId: `room-${index}`,
        now: 2_000 + index
      })
    )
    expect(
      store.listMembers(channel.channelId).filter((member) => member.status === 'active')
    ).toHaveLength(MAX_CHANNEL_MEMBERS)

    expectCode(
      () =>
        store.admitMember({
          channelId: channel.channelId,
          displayName: 'Ninth',
          identityPublicKey: 'ed25519:ninth',
          roomId: 'room-ninth'
        }),
      'quota_exceeded'
    )
    expect(
      store.admitMember({
        channelId: channel.channelId,
        displayName: 'Different display name is ignored on reconnect',
        identityPublicKey: 'ed25519:0',
        roomId: 'other-room'
      })
    ).toEqual(members[0])

    store.revokeMember({ channelId: channel.channelId, memberId: members[0]!.memberId, now: 9_000 })
    expect(store.getMember(channel.channelId, members[1]!.memberId)?.status).toBe('active')
    expectCode(
      () =>
        store.admitMember({
          channelId: channel.channelId,
          displayName: 'Rejoin',
          identityPublicKey: 'ed25519:0',
          roomId: 'fresh-room'
        }),
      'revoked'
    )
  })

  it('binds a session to its pinned identity and room without an inbound author field', () => {
    const { store, channel, owner } = channelFixture()
    const member = store.admitMember({
      channelId: channel.channelId,
      displayName: 'Member B',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b'
    })

    expect(
      store.validateMemberSession({
        channelId: channel.channelId,
        memberId: member.memberId,
        identityPublicKey: 'ed25519:b',
        roomId: 'room-b'
      })
    ).toMatchObject({ memberId: member.memberId })
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: member.memberId,
          identityPublicKey: 'ed25519:wrong',
          roomId: 'room-b'
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          roomId: 'invented-room'
        }),
      'identity_mismatch'
    )
  })

  it('persists a single-use pending admission before activating the pinned member', () => {
    const { store, storePath, channel } = channelFixture()
    const issued = store.createInvite({
      channelId: channel.channelId,
      now: 2_000,
      ttlMs: 60_000
    })

    expectCode(
      () =>
        store.beginMemberAdmission({
          channelId: channel.channelId,
          inviteId: issued.invite.inviteId,
          inviteToken: 'wrong-token',
          roomId: issued.invite.roomId,
          displayName: 'Member B',
          identityPublicKey: 'ed25519:b',
          now: 3_000
        }),
      'identity_mismatch'
    )

    const pending = store.beginMemberAdmission({
      channelId: channel.channelId,
      inviteId: issued.invite.inviteId,
      inviteToken: issued.inviteToken,
      roomId: issued.invite.roomId,
      displayName: 'Member B',
      identityPublicKey: 'ed25519:b',
      now: 3_000
    })
    expect(pending.member).toMatchObject({
      status: 'pending',
      roomId: issued.invite.roomId,
      identityPublicKey: 'ed25519:b'
    })
    expect(store.getDisplayEnvelope(channel.channelId).memberCount).toBe(1)
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: pending.member.memberId,
          identityPublicKey: 'ed25519:b',
          roomId: issued.invite.roomId
        }),
      'not_member'
    )

    const active = store.confirmMemberAdmission({
      channelId: channel.channelId,
      inviteId: issued.invite.inviteId,
      memberId: pending.member.memberId,
      now: 4_000
    })
    expect(active.status).toBe('active')
    expect(store.getDisplayEnvelope(channel.channelId).memberCount).toBe(2)

    const reloaded = new ChannelStore(storePath)
    expect(reloaded.getInvite(channel.channelId, issued.invite.inviteId)).toMatchObject({
      memberId: active.memberId,
      consumedAt: 4_000
    })
    expectCode(
      () =>
        reloaded.beginMemberAdmission({
          channelId: channel.channelId,
          inviteId: issued.invite.inviteId,
          inviteToken: issued.inviteToken,
          roomId: issued.invite.roomId,
          displayName: 'Imposter',
          identityPublicKey: 'ed25519:imposter',
          now: 5_000
        }),
      'revoked'
    )
  })

  it('reserves seats transactionally for pending handshakes and releases expired ones', () => {
    const { store, channel } = channelFixture()
    for (let index = 0; index < MAX_CHANNEL_MEMBERS - 1; index += 1) {
      const issued = store.createInvite({
        channelId: channel.channelId,
        now: 2_000,
        ttlMs: index === 0 ? 1_000 : 60_000
      })
      store.beginMemberAdmission({
        channelId: channel.channelId,
        inviteId: issued.invite.inviteId,
        inviteToken: issued.inviteToken,
        roomId: issued.invite.roomId,
        displayName: `Pending ${index}`,
        identityPublicKey: `ed25519:pending-${index}`,
        now: 2_100
      })
    }

    const ninth = store.createInvite({
      channelId: channel.channelId,
      now: 2_200,
      ttlMs: 60_000
    })
    expectCode(
      () =>
        store.beginMemberAdmission({
          channelId: channel.channelId,
          inviteId: ninth.invite.inviteId,
          inviteToken: ninth.inviteToken,
          roomId: ninth.invite.roomId,
          displayName: 'Ninth',
          identityPublicKey: 'ed25519:ninth',
          now: 2_300
        }),
      'quota_exceeded'
    )

    const replacement = store.beginMemberAdmission({
      channelId: channel.channelId,
      inviteId: ninth.invite.inviteId,
      inviteToken: ninth.inviteToken,
      roomId: ninth.invite.roomId,
      displayName: 'Replacement',
      identityPublicKey: 'ed25519:replacement',
      now: 3_100
    })
    expect(replacement.member.status).toBe('pending')
    expect(
      store.listMembers(channel.channelId).filter((member) => member.status !== 'revoked')
    ).toHaveLength(MAX_CHANNEL_MEMBERS)
  })

  it('keeps the display envelope when its TaskWraith reference is unavailable', () => {
    const { store, channel } = channelFixture()
    const unavailable = store.resolveReference(channel.channelId, () => undefined)
    expect(unavailable).toMatchObject({
      state: 'referent unavailable',
      reference: { kind: 'chat', id: 'general-chat' },
      display: { title: 'Launch room', status: 'active', memberCount: 1, messageCount: 0 }
    })

    const available = store.resolveReference(channel.channelId, (reference) => ({
      reference: reference as TaskWraithReference,
      redacted: true
    }))
    expect(available).toMatchObject({ state: 'available', value: { redacted: true } })
  })

  it('isolates envelope drift to one channel and preserves the others', () => {
    const directory = temporaryDirectory()
    const storePath = join(directory, 'channels.json')
    const store = new ChannelStore(storePath)
    const a = store.createChannel({
      chatId: 'chat-a',
      owner: { displayName: 'Host A', identityPublicKey: 'ed25519:a' },
      title: 'Room A',
      now: 1_000
    })
    const b = store.createChannel({
      chatId: 'chat-b',
      owner: { displayName: 'Host B', identityPublicKey: 'ed25519:b' },
      title: 'Room B',
      now: 2_000
    })

    const onDisk = JSON.parse(readFileSync(storePath, 'utf8')) as {
      channels: Array<{ channelId: string; display: { messageCount: number } }>
    }
    const drifted = onDisk.channels.find((channel) => channel.channelId === a.channel.channelId)
    expect(drifted).toBeDefined()
    drifted!.display.messageCount = 999
    writeFileSync(storePath, JSON.stringify(onDisk), 'utf8')

    const reloaded = new ChannelStore(storePath)
    expectCode(() => reloaded.getDisplayEnvelope(a.channel.channelId), 'recovery_blocked')
    expectCode(
      () =>
        reloaded.admitMember({
          channelId: a.channel.channelId,
          displayName: 'X',
          identityPublicKey: 'ed25519:x',
          roomId: 'room-x'
        }),
      'recovery_blocked'
    )
    expect(reloaded.getDisplayEnvelope(b.channel.channelId)).toEqual({
      title: 'Room B',
      status: 'active',
      memberCount: 1,
      messageCount: 0
    })
    expect(reloaded.listMembers(b.channel.channelId)).toHaveLength(1)
    expect(reloaded.getChannel(b.channel.channelId)?.chatId).toBe('chat-b')
  })

  it('marks the whole store recovery-blocked when the snapshot is fully corrupt', () => {
    const directory = temporaryDirectory()
    const storePath = join(directory, 'channels.json')
    writeFileSync(storePath, JSON.stringify({ garbage: true }), 'utf8')

    const store = new ChannelStore(storePath)
    expectCode(
      () =>
        store.createChannel({
          chatId: 'any',
          owner: { displayName: 'Host', identityPublicKey: 'ed25519:host' },
          title: 'Nope'
        }),
      'recovery_blocked'
    )
    expectCode(() => store.getDisplayEnvelope('missing'), 'recovery_blocked')
  })

  it('loads a missing or empty store as a fresh empty store without error', () => {
    const directory = temporaryDirectory()
    const missingPath = join(directory, 'missing-channels.json')
    const missing = new ChannelStore(missingPath)
    expect(missing.getChannel('none')).toBeNull()

    const emptyPath = join(directory, 'empty-channels.json')
    writeFileSync(
      emptyPath,
      JSON.stringify({ schemaVersion: 1, channels: [], members: [] }),
      'utf8'
    )
    const empty = new ChannelStore(emptyPath)
    const created = empty.createChannel({
      chatId: 'fresh-chat',
      owner: { displayName: 'Host', identityPublicKey: 'ed25519:host' },
      title: 'Fresh room',
      now: 3_000
    })
    expect(created.channel.chatId).toBe('fresh-chat')
    expect(empty.getDisplayEnvelope(created.channel.channelId).title).toBe('Fresh room')
  })

  it('purges selected Channel metadata last while preserving unrelated durable ownership', () => {
    const directory = temporaryDirectory()
    const storePath = join(directory, 'channels.json')
    const store = new ChannelStore(storePath)
    const first = store.createChannel({
      chatId: 'chat-a',
      owner: { displayName: 'Host A', identityPublicKey: 'ed25519:a' },
      title: 'Room A',
      now: 1_000
    })
    const second = store.createChannel({
      chatId: 'chat-b',
      owner: { displayName: 'Host B', identityPublicKey: 'ed25519:b' },
      title: 'Room B',
      now: 2_000
    })
    store.createInvite({ channelId: first.channel.channelId, now: 3_000 })
    store.createInvite({ channelId: second.channel.channelId, now: 3_000 })
    const staleMetadata = `${storePath}.stale.tmp`
    writeFileSync(staleMetadata, 'stale metadata', 'utf8')

    expect(store.purgeChannels([first.channel.channelId])).toEqual([first.channel.channelId])
    expect(existsSync(staleMetadata)).toBe(false)
    expect(store.getChannel(first.channel.channelId)).toBeNull()
    expect(store.listMembers(first.channel.channelId)).toEqual([])
    expect(store.listInvites(first.channel.channelId)).toEqual([])
    expect(store.getChannel(second.channel.channelId)?.chatId).toBe('chat-b')
    expect(store.listMembers(second.channel.channelId)).toHaveLength(1)
    expect(store.listInvites(second.channel.channelId)).toHaveLength(1)

    const restarted = new ChannelStore(storePath)
    expect(restarted.listChannels().map((channel) => channel.channelId)).toEqual([
      second.channel.channelId
    ])
    expect(restarted.purgeChannels([first.channel.channelId])).toEqual([])
    expect(restarted.purgeAllChannels()).toEqual([second.channel.channelId])
    expect(new ChannelStore(storePath).listChannels()).toEqual([])
    writeFileSync(staleMetadata, 'stale empty metadata', 'utf8')
    expect(restarted.purgeAllChannels()).toEqual([])
    expect(existsSync(staleMetadata)).toBe(false)
  })
})

describe('ChannelMessageLog', () => {
  it('durably sequences host-owned human text and retains idempotency after restart', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    const first = log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'first',
      content: 'hello'
    })
    expect(first).toMatchObject({ sequence: 1, authorMemberId: owner.memberId, kind: 'human.text' })

    const restartedStore = new ChannelStore(storePath)
    const restartedLog = new ChannelMessageLog(join(directory, 'logs'), restartedStore)
    expect(
      restartedLog.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId: 'first',
        content: 'hello'
      })
    ).toEqual(first)
    expectCode(
      () =>
        restartedLog.append({
          channelId: channel.channelId,
          principalMemberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          clientMessageId: 'first',
          content: 'changed'
        }),
      'idempotency_conflict'
    )
  })

  it('finds one durable message by exact id after restart without exposing cached bytes', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    const first = log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'lookup-first',
      content: 'first durable trigger'
    })
    const second = log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'lookup-second',
      content: 'second durable trigger'
    })
    const restarted = new ChannelMessageLog(join(directory, 'logs'), new ChannelStore(storePath))

    const found = restarted.getMessageById(channel.channelId, second.messageId)
    expect(found).toEqual(second)
    if (found) found.content = 'mutated caller copy'
    expect(restarted.getMessageById(channel.channelId, second.messageId)).toEqual(second)
    expect(restarted.getMessageById(channel.channelId, first.messageId)).toEqual(first)
    expect(restarted.getMessageById(channel.channelId, 'missing-message')).toBeNull()
    expect(restarted.getMessageById(channel.channelId, '')).toBeNull()
    expect(restarted.getMessageById(channel.channelId, ' padded-message ')).toBeNull()
    expect(restarted.getMessageById(channel.channelId, 'control\0message')).toBeNull()
  })

  it('durably appends and restart-verifies signed agent text with its authority prefix', () => {
    const {
      directory,
      storePath,
      channel,
      member,
      signPost,
      log,
      makeAuthority,
      authority,
      signedDelegation,
      signedGrant
    } = agentLogFixture()
    const signedPost = signPost()
    const consumption = authority.snapshot(channel.channelId)!.consumptions[0]
    const appended = log.appendSignedAgentPost({ signedPost, now: 5_000 })
    expect(appended).toMatchObject({
      deduplicated: false,
      record: {
        sequence: 1,
        authorMemberId: member.memberId,
        kind: 'agent.text',
        content: 'Agent result',
        agentProof: {
          schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
          authorityRevision: 3,
          signedDelegation,
          signedDispatchGrant: signedGrant,
          consumption,
          signedPost
        }
      }
    })

    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number
      agentProof: { authorityRevision: number }
    }
    expect(stored).toMatchObject({
      schemaVersion: CHANNEL_LOG_SCHEMA_VERSION,
      kind: 'agent.text',
      agentProof: {
        schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
        authorityRevision: 3,
        signedDelegation,
        signedDispatchGrant: signedGrant,
        consumption,
        signedPost
      }
    })

    const restarted = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(storePath),
      redactChannelContent,
      makeAuthority()
    )
    expect(restarted.replay({ channelId: channel.channelId, resumeAfter: 0 })).toEqual({
      records: [appended.record],
      highWaterSequence: 1
    })
  })

  it('deduplicates a historical agent post after revocation without admitting a rewrite', () => {
    const {
      directory,
      storePath,
      store,
      channel,
      owner,
      member,
      authority,
      makeAuthority,
      signedGrant,
      ownerKeys,
      signPost,
      log
    } = agentLogFixture()
    const signedPost = signPost()
    const appended = log.appendSignedAgentPost({ signedPost, now: 5_000 })
    const revocation: ChannelAgentRevocation = {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      revocationId: 'revoke-agent-posts',
      channelId: channel.channelId,
      ownerMemberId: owner.memberId,
      agentSeatId: member.agentSeatId,
      keyGeneration: member.keyGeneration,
      targetKind: 'dispatch_grant',
      targetId: signedGrant.grant.grantId,
      revokedAt: 6_000,
      reason: 'owner_revoked'
    }
    authority.registerRevocation(signChannelAgentRevocation(ownerKeys.privateKey, revocation))
    store.revokeMember({ channelId: channel.channelId, memberId: member.memberId, now: 6_000 })

    const restarted = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(storePath),
      redactChannelContent,
      makeAuthority()
    )
    expect(restarted.appendSignedAgentPost({ signedPost, now: 7_000 })).toEqual({
      record: appended.record,
      deduplicated: true
    })
    expectCode(
      () =>
        restarted.appendSignedAgentPost({
          signedPost: signPost({ content: 'Changed result' }),
          now: 7_000
        }),
      'idempotency_conflict'
    )
    expectCode(
      () =>
        restarted.appendSignedAgentPost({
          signedPost: signPost({
            clientMessageId: 'agent-client-after-revocation',
            createdAt: 7_000
          }),
          now: 7_000
        }),
      'revoked'
    )
  })

  it('rejects forged, unconsumed, unredacted, and authority-free agent posts', () => {
    const { directory, store, channel, agentKeys, postValue, signPost, log } = agentLogFixture()
    const foreignAgent = generateIdentityKeyPair()
    expectCode(
      () =>
        log.appendSignedAgentPost({
          signedPost: signChannelAgentPost(foreignAgent.privateKey, postValue()),
          now: 5_000
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        log.appendSignedAgentPost({
          signedPost: signPost({ triggerMessageId: 'unconsumed-trigger' }),
          now: 5_000
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        log.appendSignedAgentPost({
          signedPost: signChannelAgentPost(
            agentKeys.privateKey,
            postValue({ content: 'token=super-secret-value' })
          ),
          now: 5_000
        }),
      'protocol_unsupported'
    )
    const authorityFree = new ChannelMessageLog(join(directory, 'other-logs'), store)
    expectCode(
      () => authorityFree.appendSignedAgentPost({ signedPost: signPost(), now: 5_000 }),
      'protocol_unsupported'
    )
    expect(log.highWaterSequence(channel.channelId)).toBe(0)
  })

  it('loads schema-v1 human records and writes only new records with the current schema', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'legacy-one',
      content: 'legacy'
    })
    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    legacy.schemaVersion = 1
    const { checksum: _checksum, ...withoutChecksum } = legacy
    legacy.checksum = createHash('sha256')
      .update(JSON.stringify(withoutChecksum), 'utf8')
      .digest('hex')
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, 'utf8')

    const restarted = new ChannelMessageLog(join(directory, 'logs'), new ChannelStore(storePath))
    expect(restarted.highWaterSequence(channel.channelId)).toBe(1)
    restarted.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'current-two',
      content: 'current'
    })
    const versions = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { schemaVersion: number }).schemaVersion)
    expect(versions).toEqual([1, CHANNEL_LOG_SCHEMA_VERSION])
  })

  it('upgrades schema-v2 agent proof to a self-contained chain during torn-tail repair', () => {
    const { directory, storePath, channel, signPost, log, makeAuthority } = agentLogFixture()
    const appended = log.appendSignedAgentPost({ signedPost: signPost(), now: 5_000 })
    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const proof = legacy.agentProof as Record<string, unknown>
    legacy.schemaVersion = 2
    legacy.agentProof = {
      authorityRevision: proof.authorityRevision,
      signedPost: proof.signedPost
    }
    const { checksum: _checksum, ...withoutChecksum } = legacy
    legacy.checksum = createHash('sha256')
      .update(JSON.stringify(withoutChecksum), 'utf8')
      .digest('hex')
    writeFileSync(path, `${JSON.stringify(legacy)}\n{"partial"`, 'utf8')

    const restarted = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(storePath),
      redactChannelContent,
      makeAuthority()
    )
    expect(restarted.replay({ channelId: channel.channelId, resumeAfter: 0 })).toEqual({
      records: [appended.record],
      highWaterSequence: 1
    })
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(repaired).toMatchObject({
      schemaVersion: CHANNEL_LOG_SCHEMA_VERSION,
      agentProof: appended.record.kind === 'agent.text' ? appended.record.agentProof : undefined
    })
  })

  it('blocks restart when an agent proof revision is rewritten even with a fresh checksum', () => {
    const { directory, storePath, channel, signPost, log, makeAuthority } = agentLogFixture()
    log.appendSignedAgentPost({ signedPost: signPost(), now: 5_000 })
    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    const rewritten = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    ;(rewritten.agentProof as Record<string, unknown>).authorityRevision = 2
    const { checksum: _checksum, ...withoutChecksum } = rewritten
    rewritten.checksum = createHash('sha256')
      .update(JSON.stringify(withoutChecksum), 'utf8')
      .digest('hex')
    writeFileSync(path, `${JSON.stringify(rewritten)}\n`, 'utf8')

    const restarted = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(storePath),
      redactChannelContent,
      makeAuthority()
    )
    expectCode(() => restarted.highWaterSequence(channel.channelId), 'recovery_blocked')
  })

  it('redacts secrets and local paths before hashing and durable persistence', () => {
    const { directory, channel, owner, log } = channelFixture()
    const committed = log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'redacted',
      content: 'token=super-secret-value lives at /Users/alice/private/plan.txt'
    })
    expect(committed.content).toBe('token=[redacted] lives at [redacted-path]')
    const durable = readFileSync(join(directory, 'logs', `${channel.channelId}.jsonl`), 'utf8')
    expect(durable).not.toContain('super-secret-value')
    expect(durable).not.toContain('/Users/alice')
  })

  it('recovers a durable append after failure before metadata persistence and deduplicates retry', () => {
    const { channel, owner, store, log } = channelFixture()
    vi.spyOn(store, 'recordCommittedMessage').mockImplementationOnce(() => {
      throw new Error('injected metadata failure')
    })
    const input = {
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'crash-window',
      content: 'durable before metadata'
    }

    expect(() => log.append(input)).toThrow('injected metadata failure')
    expect(log.highWaterSequence(channel.channelId)).toBe(1)
    expect(store.getChannel(channel.channelId)?.messageCount).toBe(0)

    const retried = log.appendWithResult(input)
    expect(retried).toMatchObject({ deduplicated: true, record: { sequence: 1 } })
    expect(store.getChannel(channel.channelId)?.messageCount).toBe(1)
  })

  it('reconciles metadata that lags a valid durable log after restart', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'one',
      content: 'one'
    })
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as {
      channels: Array<{
        channelId: string
        messageCount: number
        display: { messageCount: number }
      }>
    }
    const storedChannel = raw.channels.find((entry) => entry.channelId === channel.channelId)!
    storedChannel.messageCount = 0
    storedChannel.display.messageCount = 0
    writeFileSync(storePath, JSON.stringify(raw), 'utf8')

    const restartedStore = new ChannelStore(storePath)
    const restartedLog = new ChannelMessageLog(join(directory, 'logs'), restartedStore)
    expect(restartedLog.highWaterSequence(channel.channelId)).toBe(1)
    expect(restartedStore.getChannel(channel.channelId)?.messageCount).toBe(1)
  })

  it('blocks recovery when metadata claims history but the durable log is missing', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'one',
      content: 'one'
    })
    rmSync(join(directory, 'logs', `${channel.channelId}.jsonl`))

    const restartedLog = new ChannelMessageLog(join(directory, 'logs'), new ChannelStore(storePath))
    expectCode(() => restartedLog.highWaterSequence(channel.channelId), 'recovery_blocked')
  })

  it('replays bounded, gapless records and rejects cursors ahead of durable history', () => {
    const { channel, owner, log } = channelFixture()
    for (const clientMessageId of ['one', 'two', 'three']) {
      log.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId,
        content: clientMessageId
      })
    }

    const firstBatch = log.replay({ channelId: channel.channelId, resumeAfter: 0, maxRecords: 2 })
    expect(firstBatch.highWaterSequence).toBe(3)
    expect(firstBatch.records.map((record) => record.sequence)).toEqual([1, 2])
    expect(log.replay({ channelId: channel.channelId, resumeAfter: 2 }).records).toHaveLength(1)
    expectCode(() => log.replay({ channelId: channel.channelId, resumeAfter: 4 }), 'invalid_cursor')
  })

  it('discards only a torn final log tail and preserves the complete committed prefix', () => {
    const { directory, channel, owner, log } = channelFixture()
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'first',
      content: 'first'
    })
    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"schemaVersion":`, 'utf8')

    const recovered = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(join(directory, 'channels.json'))
    )
    expect(recovered.highWaterSequence(channel.channelId)).toBe(1)
    expect(
      recovered.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId: 'second',
        content: 'second'
      })
    ).toMatchObject({ sequence: 2 })
  })

  it('structurally rejects agent-shaped messages before persistence', () => {
    const { channel, owner, log } = channelFixture()
    expectCode(
      () =>
        log.append({
          channelId: channel.channelId,
          principalMemberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          clientMessageId: 'agent-attempt',
          kind: 'agent.text' as never,
          content: 'start a provider'
        }),
      'human_only'
    )
    expect(log.highWaterSequence(channel.channelId)).toBe(0)
  })

  it('purges selected logs idempotently and removes orphan logs only on global erasure', () => {
    const { directory, store, channel, owner, log } = channelFixture()
    const second = store.createChannel({
      chatId: 'chat-b',
      owner: { displayName: 'Host B', identityPublicKey: 'ed25519:b' },
      title: 'Room B'
    })
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'one-a',
      content: 'first'
    })
    log.append({
      channelId: second.channel.channelId,
      principalMemberId: second.owner.memberId,
      identityPublicKey: 'ed25519:b',
      clientMessageId: 'one-b',
      content: 'second'
    })
    const logs = join(directory, 'logs')
    const firstPath = join(logs, `${channel.channelId}.jsonl`)
    const secondPath = join(logs, `${second.channel.channelId}.jsonl`)
    const orphanPath = join(logs, 'orphan.jsonl')
    const staleFirstPath = `${firstPath}.stale.tmp`
    writeFileSync(orphanPath, 'orphaned durable bytes\n', 'utf8')
    writeFileSync(staleFirstPath, 'stale first history\n', 'utf8')

    log.purgeChannels([channel.channelId, channel.channelId])
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(staleFirstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(true)
    expect(existsSync(orphanPath)).toBe(true)
    expectCode(() => log.highWaterSequence(channel.channelId), 'recovery_blocked')
    expect(log.highWaterSequence(second.channel.channelId)).toBe(1)

    log.purgeChannels([channel.channelId])
    log.purgeAll()
    expect(existsSync(secondPath)).toBe(false)
    expect(existsSync(orphanPath)).toBe(false)
    log.purgeAll()
  })
})
