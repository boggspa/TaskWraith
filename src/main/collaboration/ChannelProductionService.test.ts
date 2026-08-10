import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateIdentityKeyPair, type KeyPair } from '../../shared/e2ee/keys'
import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import type {
  TransportSocket,
  TransportSocketFactory,
  TransportSocketHandlers
} from '../remote/RemoteTransportClient'
import { ChannelMemberClient } from './ChannelMemberClient'
import {
  CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX,
  ChannelAgentAuthorityStore,
  channelAgentAuthorityFileHash
} from './ChannelAgentAuthorityStore'
import {
  CHANNEL_AGENT_IDENTITY_FILE_SUFFIX,
  ChannelAgentIdentityStore,
  channelAgentSeatFileHash,
  type ChannelAgentIdentitySafeStorage
} from './ChannelAgentIdentityStore'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelError, ChannelStore, type ChannelErrorCode } from './ChannelStore'
import {
  channelProductionDataPaths,
  createChannelProductionService,
  type ChannelProductionService,
  type ChannelProductionServiceOptions
} from './ChannelProductionService'

interface CapturedSocket {
  url: string
  headers: Record<string, string>
  handlers: TransportSocketHandlers
  sent: string[]
  closed: boolean
}

interface RelayEndpoint {
  role: 'mac' | 'iphone'
  handlers: TransportSocketHandlers
  closed: boolean
}

class BlindTestRelay {
  private readonly rooms = new Map<string, Partial<Record<'mac' | 'iphone', RelayEndpoint>>>()

  readonly socketFactory: TransportSocketFactory = (url, headers, handlers) => {
    const roomId = new URL(url).pathname.split('/').at(-1)!
    const role = headers['x-taskwraith-role'] as 'mac' | 'iphone'
    if (role !== 'mac' && role !== 'iphone') throw new Error('invalid relay role')
    const room = this.rooms.get(roomId) ?? {}
    const endpoint: RelayEndpoint = { role, handlers, closed: false }
    room[role] = endpoint
    this.rooms.set(roomId, room)
    queueMicrotask(() => {
      if (!endpoint.closed) handlers.onOpen()
    })

    const socket: TransportSocket = {
      send: (data) => {
        if (endpoint.closed) throw new Error('relay endpoint is closed')
        const peer = room[role === 'mac' ? 'iphone' : 'mac']
        if (peer && !peer.closed) {
          queueMicrotask(() => {
            if (!peer.closed) peer.handlers.onMessage(data)
          })
        }
      },
      close: () => {
        if (endpoint.closed) return
        endpoint.closed = true
        if (room[role] === endpoint) delete room[role]
        queueMicrotask(() => handlers.onClose(1000))
      }
    }
    return socket
  }
}

function socketHarness(): {
  sockets: CapturedSocket[]
  factory: TransportSocketFactory
} {
  const sockets: CapturedSocket[] = []
  return {
    sockets,
    factory: (url, headers, handlers) => {
      const capture: CapturedSocket = {
        url,
        headers,
        handlers,
        sent: [],
        closed: false
      }
      sockets.push(capture)
      return {
        send: (data) => capture.sent.push(data),
        close: () => {
          capture.closed = true
        }
      }
    }
  }
}

const roots = new Set<string>()
const services = new Set<ChannelProductionService>()

function xorCipher(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

const secureStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => xorCipher(Buffer.from(plaintext, 'utf8')),
  decryptString: (ciphertext) => xorCipher(ciphertext).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6'
}

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-channel-production-'))
  roots.add(root)
  return root
}

function createService(
  args: {
    userDataPath?: string
    identity?: KeyPair
    sockets?: ReturnType<typeof socketHarness>
    socketFactory?: TransportSocketFactory
    hostRelayUrl?: () => string
    inviteRelayUrls?: () => readonly string[]
    now?: () => number
    logger?: (line: string) => void
    onChange?: ChannelProductionServiceOptions['onChange']
  } = {}
): {
  service: ChannelProductionService
  userDataPath: string
  identity: KeyPair
  sockets: ReturnType<typeof socketHarness>
  loadIdentity: ReturnType<typeof vi.fn<() => KeyPair>>
} {
  const userDataPath = args.userDataPath ?? temporaryUserData()
  roots.add(userDataPath)
  const identity = args.identity ?? generateIdentityKeyPair()
  const sockets = args.sockets ?? socketHarness()
  const loadIdentity = vi.fn(() => identity)
  const options: ChannelProductionServiceOptions = {
    userDataPath,
    loadIdentity,
    safeStorage: secureStorage,
    relay: {
      hostRelayUrl: args.hostRelayUrl ?? (() => 'ws://127.0.0.1:8787'),
      inviteRelayUrls:
        args.inviteRelayUrls ?? (() => ['wss://relay.example', 'wss://relay.example/'])
    },
    socketFactory: args.socketFactory ?? sockets.factory,
    ...(args.now ? { now: args.now } : {}),
    ...(args.logger ? { logger: args.logger } : {}),
    ...(args.onChange ? { onChange: args.onChange } : {})
  }
  const service = createChannelProductionService(options)
  services.add(service)
  return { service, userDataPath, identity, sockets, loadIdentity }
}

function expectCode(action: () => unknown, code: ChannelErrorCode): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelError)
    expect((error as ChannelError).code).toBe(code)
    return
  }
  throw new Error(`expected ChannelError ${code}`)
}

afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop().catch(() => undefined)))
  services.clear()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('ChannelProductionService', () => {
  it('is side-effect free before start, singleton per data root, and terminal after stop', async () => {
    const fixture = createService()
    const paths = channelProductionDataPaths(fixture.userDataPath)

    expect(fixture.service.status()).toEqual({
      state: 'idle',
      channelCount: 0,
      recoveryBlockedChannelCount: 0,
      openRoomCount: 0
    })
    expect(existsSync(paths.root)).toBe(false)
    expect(fixture.loadIdentity).not.toHaveBeenCalled()

    const same = createChannelProductionService({
      userDataPath: `${fixture.userDataPath}/.`,
      loadIdentity: () => generateIdentityKeyPair(),
      safeStorage: secureStorage,
      relay: {
        hostRelayUrl: () => 'ws://ignored.example',
        inviteRelayUrls: () => []
      },
      socketFactory: socketHarness().factory
    })
    expect(same).toBe(fixture.service)

    expect(fixture.service.start().state).toBe('running')
    expect(fixture.service.start().state).toBe('running')
    expect(fixture.loadIdentity).toHaveBeenCalledOnce()

    await fixture.service.stop()
    expect(fixture.service.status().state).toBe('stopped')
    expectCode(() => fixture.service.start(), 'host_unavailable')

    const replacement = createService({
      userDataPath: fixture.userDataPath,
      identity: fixture.identity
    }).service
    expect(replacement).not.toBe(fixture.service)
    expect(replacement.start().state).toBe('running')
  })

  it('validates the production ports before entering the registry', () => {
    const userDataPath = temporaryUserData()
    const valid = {
      userDataPath,
      loadIdentity: () => generateIdentityKeyPair(),
      safeStorage: secureStorage,
      relay: { hostRelayUrl: () => 'ws://host', inviteRelayUrls: () => [] }
    }

    expect(() => createChannelProductionService(undefined as never)).toThrow(
      'requires an options object'
    )
    expect(() => createChannelProductionService({ ...valid, userDataPath: '' })).toThrow(
      'requires an injected userDataPath'
    )
    expect(() =>
      createChannelProductionService({ ...valid, loadIdentity: undefined as never })
    ).toThrow('requires an identity loader')
    expect(() =>
      createChannelProductionService({ ...valid, safeStorage: undefined as never })
    ).toThrow('requires injected safeStorage')
    expect(() => createChannelProductionService({ ...valid, relay: undefined as never })).toThrow(
      'requires an injected relay port'
    )
  })

  it('owns safe main queries and host commands without leaking authority fields', async () => {
    let now = 1_700_000_000_000
    const onChange = vi.fn()
    const fixture = createService({ now: () => now, onChange })
    fixture.service.start()

    const channel = fixture.service.createChannel({
      chatId: 'chat-general',
      title: 'General',
      ownerDisplayName: 'Host',
      reference: { kind: 'chat', id: 'chat-general' }
    })
    expect(channel).toMatchObject({
      chatId: 'chat-general',
      status: 'active',
      availability: 'ready',
      messageCount: 0
    })

    now += 1
    const invite = fixture.service.issueInvite({ channelId: channel.channelId })
    expect(invite.hostRoomOpened).toBe(true)
    expect(invite.relayUrls).toEqual(['wss://relay.example', 'ws://127.0.0.1:8787'])
    expect(fixture.sockets.sockets).toHaveLength(1)
    expect(fixture.sockets.sockets[0]).toMatchObject({
      url: `ws://127.0.0.1:8787/v1/session/${invite.roomId}`,
      headers: {
        'x-taskwraith-role': 'mac',
        'x-taskwraith-protocol': 'taskwraith-channel-wire-v1',
        'x-taskwraith-channel-id': channel.channelId
      }
    })

    now += 1
    const append = await fixture.service.appendHost({
      channelId: channel.channelId,
      clientMessageId: 'host-1',
      content: 'token=super-secret-value lives at /Users/alice/private/plan.txt'
    })
    expect(append.record).toMatchObject({
      sequence: 1,
      kind: 'human.text',
      content: 'token=[redacted] lives at [redacted-path]'
    })

    const read = fixture.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
    expect(read.highWaterSequence).toBe(1)
    expect(read.records).toEqual([append.record])
    expect(read.members).toEqual([
      expect.objectContaining({
        memberId: channel.ownerMemberId,
        kind: 'human',
        displayName: 'Host',
        status: 'active'
      })
    ])
    const ordinaryProjection = JSON.stringify({
      channels: fixture.service.listChannels(),
      read
    })
    expect(ordinaryProjection).not.toContain('identityPublicKey')
    expect(ordinaryProjection).not.toContain('roomId')
    expect(ordinaryProjection).not.toContain('inviteToken')
    expect(ordinaryProjection).not.toContain('tokenHash')
    expect(fixture.service.listAudit().map((event) => event.kind)).toEqual([
      'message.accepted',
      'invite.created',
      'channel.created'
    ])

    now += 1
    await expect(fixture.service.closeChannel(channel.channelId)).resolves.toMatchObject({
      status: 'closed',
      availability: 'ready'
    })
    expect(fixture.service.status().openRoomCount).toBe(0)
    expect(fixture.sockets.sockets[0].closed).toBe(true)
    expect(onChange.mock.calls.map(([event]) => event.reason)).toEqual([
      'channel',
      'membership',
      'message',
      'channel'
    ])
    expect(onChange.mock.calls.map(([event]) => event.chatId)).toEqual([
      'chat-general',
      'chat-general',
      'chat-general',
      'chat-general'
    ])
  })

  it('projects the matching host SAS transiently and removes it after confirmation or expiry', async () => {
    const relay = new BlindTestRelay()
    const now = 1_700_000_000_000
    const onChange = vi.fn()
    const fixture = createService({
      now: () => now,
      onChange,
      socketFactory: relay.socketFactory,
      hostRelayUrl: () => 'ws://relay.test',
      inviteRelayUrls: () => ['ws://relay.test']
    })
    fixture.service.start()
    const channel = fixture.service.createChannel({
      chatId: 'chat-sas',
      title: 'SAS proof',
      ownerDisplayName: 'Host'
    })
    const invite = fixture.service.issueInvite({ channelId: channel.channelId, ttlMs: 60_000 })
    const client = new ChannelMemberClient({
      socketFactory: relay.socketFactory,
      identity: generateIdentityKeyPair(),
      requestTimeoutMs: 2_000
    })
    let expiringClient: ChannelMemberClient | null = null

    try {
      client.connect('ws://relay.test', invite.roomId)
      await client.whenConnected(2_000)
      const member = await client.beginAdmission({
        channelId: channel.channelId,
        inviteId: invite.inviteId,
        inviteToken: invite.inviteToken,
        displayName: 'Alex',
        expectedHostIdentityPubKeyB64: fixture.service.hostIdentityPublicKey()
      })
      const pending = fixture.service.readChannel({
        channelId: channel.channelId,
        resumeAfter: 0
      }).pendingAdmissions
      expect(pending).toEqual([
        {
          channelId: channel.channelId,
          memberId: expect.any(String),
          displayName: 'Alex',
          confirmCode: member.confirmCode,
          expiresAt: now + 60_000
        }
      ])
      expect(JSON.stringify(pending)).not.toMatch(/handshakeId|roomId|identity|inviteToken/)
      expect(onChange).toHaveBeenCalledWith({
        channelId: channel.channelId,
        chatId: 'chat-sas',
        reason: 'membership'
      })

      await client.confirmAdmission()
      expect(
        fixture.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
          .pendingAdmissions
      ).toEqual([])

      vi.useFakeTimers()
      const expiringInvite = fixture.service.issueInvite({
        channelId: channel.channelId,
        ttlMs: 1_000
      })
      expiringClient = new ChannelMemberClient({
        socketFactory: relay.socketFactory,
        identity: generateIdentityKeyPair(),
        requestTimeoutMs: 2_000
      })
      expiringClient.connect('ws://relay.test', expiringInvite.roomId)
      await expiringClient.whenConnected(2_000)
      await expiringClient.beginAdmission({
        channelId: channel.channelId,
        inviteId: expiringInvite.inviteId,
        inviteToken: expiringInvite.inviteToken,
        displayName: 'Blair',
        expectedHostIdentityPubKeyB64: fixture.service.hostIdentityPublicKey()
      })
      expect(
        fixture.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
          .pendingAdmissions
      ).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(
        fixture.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
          .pendingAdmissions
      ).toEqual([])
    } finally {
      vi.useRealTimers()
      expiringClient?.dispose()
      client.dispose()
    }
  })

  it('waits for in-flight durable work and restores identity, history, audit, and rooms', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const first = createService({ userDataPath, identity })
    first.service.start()
    const channel = first.service.createChannel({
      chatId: 'chat-restart',
      title: 'Restart proof',
      ownerDisplayName: 'Host'
    })
    const invite = first.service.issueInvite({ channelId: channel.channelId })
    const hostIdentity = first.service.hostIdentityPublicKey()

    const pendingAppend = first.service.appendHost({
      channelId: channel.channelId,
      clientMessageId: 'before-stop',
      content: 'accepted before stop'
    })
    const stopping = first.service.stop()
    expect(first.service.status().state).toBe('stopping')
    await stopping
    await expect(pendingAppend).resolves.toMatchObject({
      record: { sequence: 1, content: 'accepted before stop' }
    })

    const restartedSockets = socketHarness()
    const restarted = createService({
      userDataPath,
      identity,
      sockets: restartedSockets
    })
    expect(restarted.service.start()).toMatchObject({
      state: 'running',
      channelCount: 1,
      recoveryBlockedChannelCount: 0,
      openRoomCount: 1
    })
    expect(restarted.service.hostIdentityPublicKey()).toBe(hostIdentity)
    expect(restarted.loadIdentity).toHaveBeenCalledOnce()
    expect(restartedSockets.sockets[0].url).toContain(invite.roomId)
    expect(
      restarted.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
    ).toMatchObject({
      highWaterSequence: 1,
      records: [{ sequence: 1, content: 'accepted before stop' }]
    })
    expect(restarted.service.listAudit().map((event) => event.kind)).toContain('message.accepted')
  })

  it('verifies durable signed-agent history on production restart and erases its stores by scope', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const now = 1_700_000_000_000
    const first = createService({ userDataPath, identity, now: () => now })
    first.service.start()
    const channel = first.service.createChannel({
      chatId: 'chat-agent-restart',
      title: 'Agent restart proof',
      ownerDisplayName: 'Host'
    })
    await first.service.stop()

    const paths = channelProductionDataPaths(userDataPath)
    const store = new ChannelStore(paths.metadata)
    const agentSeatId = 'pooled-agent-production-proof'
    const agentMemberId = 'agent-member-production-proof'
    const identities = new ChannelAgentIdentityStore({
      storageDirectory: paths.agentIdentities,
      safeStorage: secureStorage,
      platform: 'darwin',
      now: () => now
    })
    const agentIdentity = identities.loadOrCreate(agentSeatId)
    const authority = new ChannelAgentAuthorityStore({
      storageDirectory: paths.agentAuthority,
      resolveOwnerPublicKey: (channelId, ownerMemberId) =>
        channelId === channel.channelId && ownerMemberId === channel.ownerMemberId
          ? identity.publicKey
          : null,
      now: () => now
    })
    const signedDelegation = signChannelAgentDelegation(identity.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      delegationId: 'delegation-production-proof',
      channelId: channel.channelId,
      ownerMemberId: channel.ownerMemberId,
      agentMemberId,
      agentSeatId,
      agentPublicKeyB64: agentIdentity.publicKeyB64,
      keyGeneration: agentIdentity.keyGeneration,
      scopes: ['channel.dispatch', 'channel.post'],
      issuedAt: now,
      notBefore: now,
      expiresAt: now + 60_000,
      maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
    })
    authority.registerDelegation(signedDelegation)
    store.registerAgentMember({
      channelId: channel.channelId,
      displayName: 'Build Agent',
      signedDelegation,
      now
    })
    const workspaceIdentityHash = 'a'.repeat(64)
    const permissionPostureHash = 'b'.repeat(64)
    const signedGrant = signChannelAgentDispatchGrant(identity.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      grantId: 'grant-production-proof',
      channelId: channel.channelId,
      ownerMemberId: channel.ownerMemberId,
      agentMemberId,
      agentSeatId,
      agentPublicKeyB64: agentIdentity.publicKeyB64,
      keyGeneration: agentIdentity.keyGeneration,
      delegationId: signedDelegation.delegation.delegationId,
      trigger: 'mention',
      allowedMentionerMemberIds: [channel.ownerMemberId],
      workspaceIdentityHash,
      permissionPostureHash,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + 60_000,
      maxDispatches: 1
    })
    authority.registerDispatchGrant(signedGrant)
    expect(
      authority.consumeDispatch(channel.channelId, {
        grantId: signedGrant.grant.grantId,
        triggerMessageId: 'trigger-production-proof',
        mentionerMemberId: channel.ownerMemberId,
        workspaceIdentityHash,
        permissionPostureHash,
        at: now + 1
      })
    ).toMatchObject({ kind: 'authorized', remainingDispatches: 0 })

    const content = 'Signed production replay works.'
    const signedPost = signChannelAgentPost(agentIdentity.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      channelId: channel.channelId,
      agentMemberId,
      agentSeatId,
      agentPublicKeyB64: agentIdentity.publicKeyB64,
      keyGeneration: agentIdentity.keyGeneration,
      delegationId: signedDelegation.delegation.delegationId,
      dispatchGrantId: signedGrant.grant.grantId,
      triggerMessageId: 'trigger-production-proof',
      runId: 'run-production-proof',
      runAuthorityHash: 'c'.repeat(64),
      clientMessageId: 'agent-post-production-proof',
      kind: 'agent.text',
      content,
      contentHash: hashChannelAgentContent(content),
      createdAt: now + 2
    })
    new ChannelMessageLog(paths.logs, store, undefined, authority).appendSignedAgentPost({
      signedPost,
      now: now + 2
    })

    const restarted = createService({ userDataPath, identity, now: () => now + 3 })
    expect(restarted.service.start()).toMatchObject({
      state: 'running',
      channelCount: 1,
      recoveryBlockedChannelCount: 0
    })
    expect(
      restarted.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 }).records
    ).toEqual([
      expect.objectContaining({
        kind: 'agent.text',
        authorMemberId: agentMemberId,
        content
      })
    ])

    const authorityPath = join(
      paths.agentAuthority,
      `${channelAgentAuthorityFileHash(channel.channelId)}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
    )
    const identityPath = join(
      paths.agentIdentities,
      `${channelAgentSeatFileHash(agentSeatId)}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`
    )
    expect(existsSync(authorityPath)).toBe(true)
    expect(existsSync(identityPath)).toBe(true)

    await restarted.service.purgeForHistoryDeletionScope({
      kind: 'chat',
      chatIds: ['chat-agent-restart']
    })
    expect(existsSync(authorityPath)).toBe(false)
    expect(existsSync(identityPath)).toBe(true)

    await restarted.service.purgeForHistoryDeletionScope({ kind: 'global' })
    expect(existsSync(identityPath)).toBe(false)
  })

  it('does not mint an invite while the host relay is unavailable', async () => {
    let hostRelayUrl = ''
    const fixture = createService({
      hostRelayUrl: () => hostRelayUrl,
      inviteRelayUrls: () => []
    })
    fixture.service.start()
    const channel = fixture.service.createChannel({
      chatId: 'chat-offline',
      title: 'Offline',
      ownerDisplayName: 'Host'
    })

    expectCode(
      () => fixture.service.issueInvite({ channelId: channel.channelId }),
      'host_unavailable'
    )
    const persisted = JSON.parse(
      readFileSync(channelProductionDataPaths(fixture.userDataPath).metadata, 'utf8')
    ) as { invites: unknown[] }
    expect(persisted.invites).toEqual([])

    hostRelayUrl = 'ws://127.0.0.1:8787'
    expect(fixture.service.refreshRelayRooms()).toBe(0)
    expect(fixture.sockets.sockets).toHaveLength(0)
    await fixture.service.stop()
  })

  it('orders close behind accepted local work and fences later mutations', async () => {
    const fixture = createService()
    fixture.service.start()
    const channel = fixture.service.createChannel({
      chatId: 'chat-close-order',
      title: 'Close order',
      ownerDisplayName: 'Host'
    })

    const accepted = fixture.service.appendHost({
      channelId: channel.channelId,
      clientMessageId: 'before-close',
      content: 'durable before close'
    })
    const closing = fixture.service.closeChannel(channel.channelId)
    expectCode(
      () =>
        fixture.service.appendHost({
          channelId: channel.channelId,
          clientMessageId: 'after-close-started',
          content: 'must fail'
        }),
      'channel_closed'
    )

    await expect(accepted).resolves.toMatchObject({ record: { sequence: 1 } })
    await expect(closing).resolves.toMatchObject({ status: 'closed', messageCount: 1 })
    expect(
      fixture.service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
    ).toMatchObject({
      channel: { status: 'closed' },
      highWaterSequence: 1,
      records: [{ sequence: 1, content: 'durable before close' }]
    })
  })

  it('preserves Channels on truncation and purges selected or global history durably', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const onChange = vi.fn()
    const fixture = createService({ userDataPath, identity, onChange })
    fixture.service.start()
    const first = fixture.service.createChannel({
      chatId: 'chat-a',
      title: 'Room A',
      ownerDisplayName: 'Host A'
    })
    const second = fixture.service.createChannel({
      chatId: 'chat-b',
      title: 'Room B',
      ownerDisplayName: 'Host B'
    })
    fixture.service.issueInvite({ channelId: first.channelId })
    fixture.service.issueInvite({ channelId: second.channelId })
    await fixture.service.appendHost({
      channelId: first.channelId,
      clientMessageId: 'a-1',
      content: 'first survives truncation'
    })
    await fixture.service.appendHost({
      channelId: second.channelId,
      clientMessageId: 'b-1',
      content: 'second survives selective purge'
    })
    onChange.mockClear()

    await expect(
      fixture.service.purgeForHistoryDeletionScope({
        kind: 'truncate',
        chatIds: ['chat-a']
      })
    ).resolves.toEqual({
      kind: 'truncate',
      purgedChannelIds: [],
      preservedChannelIds: [first.channelId]
    })
    expect(
      fixture.service.readChannel({ channelId: first.channelId, resumeAfter: 0 })
    ).toMatchObject({
      highWaterSequence: 1,
      records: [{ content: 'first survives truncation' }]
    })
    expect(fixture.sockets.sockets[0]?.closed).toBe(false)

    await expect(
      fixture.service.purgeForHistoryDeletionScope({ kind: 'chat', chatIds: ['chat-a'] })
    ).resolves.toEqual({
      kind: 'chat',
      purgedChannelIds: [first.channelId],
      preservedChannelIds: []
    })
    const paths = channelProductionDataPaths(userDataPath)
    expect(fixture.sockets.sockets[0]?.closed).toBe(true)
    expect(fixture.sockets.sockets[1]?.closed).toBe(false)
    expect(onChange).toHaveBeenCalledWith({
      channelId: first.channelId,
      chatId: 'chat-a',
      reason: 'channel'
    })
    expect(existsSync(join(paths.logs, `${first.channelId}.jsonl`))).toBe(false)
    expect(existsSync(join(paths.logs, `${second.channelId}.jsonl`))).toBe(true)
    expect(fixture.service.listAudit({ channelId: first.channelId })).toEqual([])
    expect(fixture.service.listAudit({ channelId: second.channelId }).length).toBeGreaterThan(0)
    expect(fixture.service.listChannels().map((channel) => channel.channelId)).toEqual([
      second.channelId
    ])
    expectCode(
      () => fixture.service.readChannel({ channelId: first.channelId, resumeAfter: 0 }),
      'not_member'
    )
    const selectiveMetadata = JSON.parse(readFileSync(paths.metadata, 'utf8')) as {
      channels: Array<{ channelId: string }>
      members: Array<{ channelId: string }>
      invites: Array<{ channelId: string }>
    }
    expect(selectiveMetadata.channels.map((channel) => channel.channelId)).toEqual([
      second.channelId
    ])
    expect(selectiveMetadata.members.every((member) => member.channelId === second.channelId)).toBe(
      true
    )
    expect(selectiveMetadata.invites.every((invite) => invite.channelId === second.channelId)).toBe(
      true
    )
    await expect(
      fixture.service.appendHost({
        channelId: second.channelId,
        clientMessageId: 'b-2',
        content: 'healthy Channel continues'
      })
    ).resolves.toMatchObject({ record: { sequence: 2 } })
    onChange.mockClear()

    const orphanPath = join(paths.logs, 'orphan.jsonl')
    writeFileSync(orphanPath, 'orphaned durable bytes\n', 'utf8')
    await expect(fixture.service.purgeForHistoryDeletionScope({ kind: 'global' })).resolves.toEqual(
      {
        kind: 'global',
        purgedChannelIds: [second.channelId],
        preservedChannelIds: []
      }
    )
    expect(fixture.sockets.sockets[1]?.closed).toBe(true)
    expect(onChange).toHaveBeenCalledWith({
      channelId: second.channelId,
      chatId: 'chat-b',
      reason: 'channel'
    })
    expect(fixture.service.listChannels()).toEqual([])
    expect(fixture.service.listAudit()).toEqual([])
    expect(existsSync(join(paths.logs, `${second.channelId}.jsonl`))).toBe(false)
    expect(existsSync(orphanPath)).toBe(false)

    writeFileSync(orphanPath, 'retry orphan\n', 'utf8')
    await expect(fixture.service.purgeForHistoryDeletionScope({ kind: 'global' })).resolves.toEqual(
      {
        kind: 'global',
        purgedChannelIds: [],
        preservedChannelIds: []
      }
    )
    expect(existsSync(orphanPath)).toBe(false)
    await fixture.service.stop()

    const restarted = createService({ userDataPath, identity })
    expect(restarted.service.start()).toMatchObject({
      state: 'running',
      channelCount: 0,
      recoveryBlockedChannelCount: 0,
      openRoomCount: 0
    })
    expect(restarted.service.listAudit()).toEqual([])
  })

  it('isolates corrupt history and restores healthy Channels only', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const first = createService({ userDataPath, identity })
    first.service.start()
    const blocked = first.service.createChannel({
      chatId: 'chat-blocked',
      title: 'Blocked',
      ownerDisplayName: 'Host'
    })
    const blockedInvite = first.service.issueInvite({ channelId: blocked.channelId })
    await first.service.appendHost({
      channelId: blocked.channelId,
      clientMessageId: 'blocked-1',
      content: 'first'
    })
    await first.service.appendHost({
      channelId: blocked.channelId,
      clientMessageId: 'blocked-2',
      content: 'second'
    })
    const healthy = first.service.createChannel({
      chatId: 'chat-healthy',
      title: 'Healthy',
      ownerDisplayName: 'Host'
    })
    const healthyInvite = first.service.issueInvite({ channelId: healthy.channelId })
    await first.service.appendHost({
      channelId: healthy.channelId,
      clientMessageId: 'healthy-1',
      content: 'healthy'
    })
    await first.service.stop()

    const paths = channelProductionDataPaths(userDataPath)
    const blockedLogPath = join(paths.logs, `${blocked.channelId}.jsonl`)
    const lines = readFileSync(blockedLogPath, 'utf8').trimEnd().split('\n')
    const tampered = JSON.parse(lines[0]) as { content: string }
    tampered.content = 'tampered interior record'
    lines[0] = JSON.stringify(tampered)
    writeFileSync(blockedLogPath, `${lines.join('\n')}\n`, 'utf8')

    const restoredSockets = socketHarness()
    const restarted = createService({
      userDataPath,
      identity,
      sockets: restoredSockets
    })
    expect(restarted.service.start()).toMatchObject({
      state: 'running',
      channelCount: 2,
      recoveryBlockedChannelCount: 1,
      openRoomCount: 1
    })
    expect(restoredSockets.sockets).toHaveLength(1)
    expect(restoredSockets.sockets[0].url).toContain(healthyInvite.roomId)
    expect(restoredSockets.sockets[0].url).not.toContain(blockedInvite.roomId)

    expect(
      new Map(
        restarted.service.listChannels().map((channel) => [channel.channelId, channel.availability])
      )
    ).toEqual(
      new Map([
        [blocked.channelId, 'recovery_blocked'],
        [healthy.channelId, 'ready']
      ])
    )
    expectCode(
      () => restarted.service.readChannel({ channelId: blocked.channelId, resumeAfter: 0 }),
      'recovery_blocked'
    )
    expectCode(
      () => restarted.service.issueInvite({ channelId: blocked.channelId }),
      'recovery_blocked'
    )
    expectCode(
      () =>
        restarted.service.appendHost({
          channelId: blocked.channelId,
          clientMessageId: 'blocked-3',
          content: 'must fail'
        }),
      'recovery_blocked'
    )

    await expect(
      restarted.service.appendHost({
        channelId: healthy.channelId,
        clientMessageId: 'healthy-2',
        content: 'still healthy'
      })
    ).resolves.toMatchObject({ record: { sequence: 2 } })

    await expect(
      restarted.service.purgeForHistoryDeletionScope({
        kind: 'workspace',
        chatIds: ['chat-blocked']
      })
    ).resolves.toEqual({
      kind: 'workspace',
      purgedChannelIds: [blocked.channelId],
      preservedChannelIds: []
    })
    expect(restarted.service.status()).toMatchObject({
      channelCount: 1,
      recoveryBlockedChannelCount: 0,
      openRoomCount: 1
    })
    expect(existsSync(blockedLogPath)).toBe(false)
    expect(restarted.service.listChannels().map((channel) => channel.channelId)).toEqual([
      healthy.channelId
    ])
  })
})
