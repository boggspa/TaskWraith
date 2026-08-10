import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import {
  CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
  type ChannelAgentMessageProof
} from '../../shared/collaboration/ChannelAgentMessageProof'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION,
  ChannelMemberReplicaError,
  ChannelMemberReplicaStore,
  channelMemberReplicaPaths
} from './ChannelMemberReplicaStore'

const directories: string[] = []
const hostKeys = generateIdentityKeyPair()
const hostIdentityPubKeyB64 = exportRawEd25519PublicKey(hostKeys.publicKey).toString('base64')

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-member-replica-'))
  directories.push(path)
  return path
}

function message(
  channelId: string,
  sequence: number,
  content = `message ${sequence}`
): ChannelMessage {
  return {
    channelId,
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: sequence % 2 === 0 ? 'member-b' : 'member-a',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content,
    acceptedAt: 1_000 + sequence,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex')
  }
}

function agentMessage(channelId: string, sequence: number): ChannelMessage {
  const agentKeys = generateIdentityKeyPair()
  const agentPublicKeyB64 = exportRawEd25519PublicKey(agentKeys.publicKey).toString('base64')
  const delegation: ChannelAgentDelegation = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: `delegation-${sequence}`,
    channelId,
    ownerMemberId: 'owner-a',
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    maxPostBytes: 8_000
  }
  const grant: ChannelAgentDispatchGrant = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: `grant-${sequence}`,
    channelId,
    ownerMemberId: 'owner-a',
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: delegation.delegationId,
    trigger: 'mention',
    allowedMentionerMemberIds: ['member-a'],
    workspaceIdentityHash: 'a'.repeat(64),
    permissionPostureHash: 'b'.repeat(64),
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    maxDispatches: 1
  }
  const content = `agent message ${sequence}`
  const post: ChannelAgentPost = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    channelId,
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: delegation.delegationId,
    dispatchGrantId: grant.grantId,
    triggerMessageId: `trigger-${sequence}`,
    runId: `run-${sequence}`,
    runAuthorityHash: 'c'.repeat(64),
    clientMessageId: `agent-client-${sequence}`,
    kind: 'agent.text',
    content,
    contentHash: hashChannelAgentContent(content),
    createdAt: 2_500
  }
  const proof: ChannelAgentMessageProof = {
    schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
    authorityRevision: 3,
    signedDelegation: signChannelAgentDelegation(hostKeys.privateKey, delegation),
    signedDispatchGrant: signChannelAgentDispatchGrant(hostKeys.privateKey, grant),
    consumption: {
      schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
      recordedRevision: 3,
      channelId,
      grantId: grant.grantId,
      triggerMessageId: post.triggerMessageId,
      mentionerMemberId: 'member-a',
      workspaceIdentityHash: grant.workspaceIdentityHash,
      permissionPostureHash: grant.permissionPostureHash,
      dispatchOrdinal: 1,
      consumedAt: 2_000
    },
    signedPost: signChannelAgentPost(agentKeys.privateKey, post)
  }
  return {
    channelId,
    sequence,
    messageId: `agent-message-${sequence}`,
    authorMemberId: 'agent-a',
    clientMessageId: post.clientMessageId,
    kind: 'agent.text',
    content,
    acceptedAt: 2_600,
    contentHash: post.contentHash,
    agentProof: proof
  }
}

function activate(
  store: ChannelMemberReplicaStore,
  channelId = 'channel-a',
  overrides: Partial<Parameters<ChannelMemberReplicaStore['activate']>[0]> = {}
) {
  return store.activate({
    channelId,
    hostChatId: `host-chat-${channelId}`,
    memberId: `member-${channelId}`,
    displayName: 'Chris',
    title: `Channel ${channelId}`,
    relayUrls: ['wss://relay.example'],
    roomId: `room-${channelId}`,
    hostIdentityPubKeyB64,
    now: 1_000,
    ...overrides
  })
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ChannelMemberReplicaStore', () => {
  it('keeps joined memberships outside the hosted-Channel authority tree', () => {
    const paths = channelMemberReplicaPaths('/tmp/taskwraith-user-data')

    expect(paths.root).toBe('/tmp/taskwraith-user-data/channel-memberships')
    expect(paths.identity).toBe('/tmp/taskwraith-user-data/channel-memberships/identity.json')
    expect(paths.memberships).toBe('/tmp/taskwraith-user-data/channel-memberships/memberships.json')
    expect(paths.records).toBe('/tmp/taskwraith-user-data/channel-memberships/records')
  })

  it('durably retains multiple memberships and contiguous deduplicated history', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store, 'channel-a')
    store.appendRecords('channel-a', [message('channel-a', 1), message('channel-a', 2)])
    activate(store, 'channel-b')
    store.appendRecords('channel-b', [message('channel-b', 1, 'hello B')])
    store.setActive('channel-a')
    store.appendRecords('channel-a', [message('channel-a', 2)])
    const staleTemporary = `${store.dataPaths().memberships}.dead.tmp`
    writeFileSync(staleTemporary, 'stale')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(existsSync(staleTemporary)).toBe(false)
    expect(restarted.readActive()).toMatchObject({
      session: { channelId: 'channel-a', status: 'active' },
      highWaterSequence: 2,
      records: [{ sequence: 1 }, { sequence: 2 }]
    })
    expect(restarted.listSessions().map((session) => session.channelId)).toEqual([
      'channel-a',
      'channel-b'
    ])
    expect(restarted.read('channel-b')).toMatchObject({
      highWaterSequence: 1,
      records: [{ content: 'hello B' }]
    })
  })

  it('retains verified agent members and self-contained signed posts for offline replay', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    const signed = agentMessage('channel-a', 2)
    store.appendRecords('channel-a', [message('channel-a', 1), signed])
    store.updateMembers({
      channelId: 'channel-a',
      membershipRevision: 3,
      members: [
        {
          memberId: 'member-a',
          kind: 'human',
          displayName: 'Host',
          status: 'active',
          joinedAt: 900
        },
        {
          memberId: 'agent-a',
          kind: 'agent',
          displayName: 'Build Agent',
          status: 'active',
          joinedAt: 2_000
        }
      ]
    })

    expect(new ChannelMemberReplicaStore(root).readActive()).toEqual({
      session: expect.objectContaining({
        membershipRevision: 3,
        members: expect.arrayContaining([expect.objectContaining({ kind: 'agent' })])
      }),
      records: [message('channel-a', 1), signed],
      highWaterSequence: 2
    })
  })

  it('rejects a forged agent proof even when the local envelope checksum is recomputed', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [agentMessage('channel-a', 1)])
    const recordPath = join(store.dataPaths().records, 'channel-a.jsonl')
    const envelope = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      schemaVersion: number
      record: Record<string, unknown>
      checksum: string
    }
    const proof = envelope.record.agentProof as Record<string, unknown>
    ;(proof.consumption as Record<string, unknown>).mentionerMemberId = 'member-forged'
    envelope.checksum = createHash('sha256')
      .update(
        JSON.stringify({ schemaVersion: envelope.schemaVersion, record: envelope.record }),
        'utf8'
      )
      .digest('hex')
    writeFileSync(recordPath, `${JSON.stringify(envelope)}\n`, 'utf8')

    expect(() => new ChannelMemberReplicaStore(root).readActive()).toThrow(
      ChannelMemberReplicaError
    )
  })

  it('loads schema-v1 human replicas and migrates metadata on the next mutation', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const paths = store.dataPaths()
    const memberships = JSON.parse(readFileSync(paths.memberships, 'utf8')) as Record<
      string,
      unknown
    >
    memberships.schemaVersion = 1
    const membershipPayload = {
      schemaVersion: memberships.schemaVersion,
      activeChannelId: memberships.activeChannelId,
      sessions: memberships.sessions
    }
    memberships.checksum = createHash('sha256')
      .update(JSON.stringify(membershipPayload), 'utf8')
      .digest('hex')
    writeFileSync(paths.memberships, JSON.stringify(memberships), 'utf8')

    const recordPath = join(paths.records, 'channel-a.jsonl')
    const recordEnvelope = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    recordEnvelope.schemaVersion = 1
    const recordPayload = {
      schemaVersion: recordEnvelope.schemaVersion,
      record: recordEnvelope.record
    }
    recordEnvelope.checksum = createHash('sha256')
      .update(JSON.stringify(recordPayload), 'utf8')
      .digest('hex')
    writeFileSync(recordPath, `${JSON.stringify(recordEnvelope)}\n`, 'utf8')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(restarted.readActive()).toMatchObject({
      records: [{ kind: 'human.text' }],
      highWaterSequence: 1
    })
    restarted.markRevoked('channel-a', 3_000)
    expect(JSON.parse(readFileSync(paths.memberships, 'utf8'))).toMatchObject({
      schemaVersion: CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
    })
  })

  it('pins a Channel id to the first verified host identity', () => {
    const store = new ChannelMemberReplicaStore(directory())
    activate(store)

    expect(() =>
      activate(store, 'channel-a', {
        hostIdentityPubKeyB64: Buffer.alloc(32, 9).toString('base64')
      })
    ).toThrow(/different host identity/i)
  })

  it('persists member revisions, revocation, and readable offline history', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    store.updateMembers({
      channelId: 'channel-a',
      membershipRevision: 2,
      members: [
        {
          memberId: 'member-a',
          kind: 'human',
          displayName: 'Host',
          status: 'active',
          joinedAt: 900
        }
      ],
      now: 1_100
    })
    store.markRevoked('channel-a', 1_200)

    expect(new ChannelMemberReplicaStore(root).readActive()).toMatchObject({
      session: {
        status: 'revoked',
        membershipRevision: 2,
        members: [{ displayName: 'Host' }]
      },
      highWaterSequence: 1,
      records: [{ content: 'message 1' }]
    })
  })

  it('fails closed on gaps, conflicts, and same-revision membership changes', () => {
    const store = new ChannelMemberReplicaStore(directory())
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])

    expect(() => store.appendRecords('channel-a', [message('channel-a', 3)])).toThrow(
      /not contiguous/i
    )
    expect(() =>
      store.appendRecords('channel-a', [message('channel-a', 1, 'conflicting content')])
    ).toThrow(/conflicts/i)

    const members = [
      {
        memberId: 'member-a',
        kind: 'human' as const,
        displayName: 'Host',
        status: 'active' as const,
        joinedAt: 900
      }
    ]
    store.updateMembers({ channelId: 'channel-a', membershipRevision: 2, members })
    expect(() =>
      store.updateMembers({
        channelId: 'channel-a',
        membershipRevision: 2,
        members: [{ ...members[0], displayName: 'Changed' }]
      })
    ).toThrow(/revision conflicts/i)
  })

  it('drops only an unsynced torn tail and replays it from the host later', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const recordsPath = join(root, 'channel-memberships', 'records', 'channel-a.jsonl')
    appendFileSync(recordsPath, '{"schemaVersion":1,"record":')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(restarted.readActive()).toMatchObject({ highWaterSequence: 1 })
    expect(readFileSync(recordsPath, 'utf8')).toMatch(/\n$/)
    restarted.appendRecords('channel-a', [message('channel-a', 2)])
    expect(restarted.readActive()?.highWaterSequence).toBe(2)
  })

  it('blocks corrupted committed metadata or record bytes', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const paths = store.dataPaths()
    const metadata = JSON.parse(readFileSync(paths.memberships, 'utf8')) as {
      sessions: Array<{ displayName: string }>
    }
    metadata.sessions[0].displayName = 'Tampered'
    writeFileSync(paths.memberships, JSON.stringify(metadata))

    expect(() => new ChannelMemberReplicaStore(root).readActive()).toThrow(
      ChannelMemberReplicaError
    )

    const secondRoot = directory()
    const second = new ChannelMemberReplicaStore(secondRoot)
    activate(second)
    second.appendRecords('channel-a', [message('channel-a', 1)])
    const recordPath = join(second.dataPaths().records, 'channel-a.jsonl')
    const committed = readFileSync(recordPath, 'utf8').replace('message 1', 'tampered')
    mkdirSync(second.dataPaths().records, { recursive: true })
    writeFileSync(recordPath, committed)
    expect(() => new ChannelMemberReplicaStore(secondRoot).readActive()).toThrow(
      ChannelMemberReplicaError
    )
  })

  it('can reset only local records or forget one membership without touching identity', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store, 'channel-a')
    store.appendRecords('channel-a', [message('channel-a', 1)])
    activate(store, 'channel-b')
    writeFileSync(store.dataPaths().identity, 'encrypted identity', { mode: 0o600 })

    expect(store.resetRecords('channel-a').highWaterSequence).toBe(0)
    store.forget('channel-b')
    expect(store.read('channel-b')).toBeNull()
    expect(store.readActive()?.session.channelId).toBe('channel-a')
    expect(readFileSync(store.dataPaths().identity, 'utf8')).toBe('encrypted identity')
  })

  it('can reset a corrupted local record log while retaining pinned membership metadata', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const recordPath = join(store.dataPaths().records, 'channel-a.jsonl')
    writeFileSync(recordPath, readFileSync(recordPath, 'utf8').replace('message 1', 'tampered'))

    const restarted = new ChannelMemberReplicaStore(root)
    expect(() => restarted.readActive()).toThrow(ChannelMemberReplicaError)
    expect(restarted.resetRecords('channel-a')).toMatchObject({
      session: { channelId: 'channel-a', hostIdentityPubKeyB64 },
      records: [],
      highWaterSequence: 0
    })
    expect(restarted.readActive()?.highWaterSequence).toBe(0)
  })

  it('can explicitly clear corrupted replicas without replacing the member identity', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    writeFileSync(store.dataPaths().identity, 'encrypted identity', { mode: 0o600 })
    writeFileSync(store.dataPaths().memberships, '{corrupted')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(() => restarted.readActive()).toThrow(ChannelMemberReplicaError)
    restarted.forgetAll()

    expect(restarted.readActive()).toBeNull()
    expect(readFileSync(store.dataPaths().identity, 'utf8')).toBe('encrypted identity')
    expect(readFileSync(store.dataPaths().memberships, 'utf8')).not.toContain('channel-a')
  })
})
