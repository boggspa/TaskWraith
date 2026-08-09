import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNEL_WIRE_PROTOCOL } from '../../shared/collaboration/ChannelWireProtocol'
import type { ChannelHandshakeConfirmResult } from '../../shared/collaboration/ChannelWireProtocol'
import type { ChannelAdmissionInput, ChannelMemberClientOptions } from './ChannelMemberClient'
import { ChannelRemoteError } from './ChannelMemberClient'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  ChannelMemberProductionError,
  createChannelMemberProductionService,
  type ChannelMemberClientLike,
  type ChannelMemberProductionJoinInput,
  type ChannelMemberProductionServiceOptions
} from './ChannelMemberProductionService'
import {
  ChannelMemberReplicaError,
  ChannelMemberReplicaStore,
  channelMemberReplicaPaths
} from './ChannelMemberReplicaStore'

const directories: string[] = []
const hostIdentityPubKeyB64 = Buffer.alloc(32, 5).toString('base64')

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-member-production-'))
  directories.push(path)
  return path
}

function record(sequence: number, content = `record ${sequence}`): ChannelMessage {
  return {
    channelId: 'channel-a',
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: sequence % 2 === 0 ? 'member-b' : 'owner-a',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content,
    acceptedAt: 1_000 + sequence,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex')
  }
}

function joinInput(overrides: Partial<ChannelMemberProductionJoinInput> = {}) {
  return {
    protocol: CHANNEL_WIRE_PROTOCOL,
    version: 1,
    channelId: 'channel-a',
    hostChatId: 'host-chat-a',
    inviteId: 'invite-a',
    inviteToken: 'invite-secret',
    roomId: 'room-a',
    relayUrls: ['ws://down.example', 'wss://relay.example'],
    displayName: 'Member B',
    expiresAt: 50_000,
    title: 'General',
    ...overrides
  }
}

interface FakeHost {
  records: ChannelMessage[]
  members: Array<{
    memberId: string
    kind: 'human'
    displayName: string
    status: 'active'
    joinedAt: number
  }>
  clients: FakeChannelMemberClient[]
  appendIds: Map<string, ChannelMessage>
  rejectAdmission?: ChannelRemoteError
}

class FakeChannelMemberClient implements ChannelMemberClientLike {
  isConnected = false
  isEstablished = false
  highWaterSequence: number
  readonly connectCalls: Array<{ relayUrl: string; roomId: string }> = []
  readonly admissionInputs: ChannelAdmissionInput[] = []
  readonly reconnectInputs: Array<{
    channelId: string
    memberId: string
    expectedHostIdentityPubKeyB64: string
  }> = []
  readonly resumeAfter: number[] = []
  disposed = false
  private readonly localRecords: ChannelMessage[]

  constructor(
    readonly options: ChannelMemberClientOptions,
    private readonly host: FakeHost
  ) {
    this.localRecords = [...(options.initialRecords ?? [])]
    this.highWaterSequence = options.initialCursor ?? this.localRecords.length
  }

  identityPublicKey(): string {
    return Buffer.alloc(32, 8).toString('base64')
  }

  hostIdentityPublicKey(): string {
    return this.isEstablished ? hostIdentityPubKeyB64 : ''
  }

  records(): ChannelMessage[] {
    return structuredClone(this.localRecords)
  }

  connect(relayUrl: string, roomId: string): void {
    this.connectCalls.push({ relayUrl, roomId })
  }

  async whenConnected(): Promise<void> {
    const relayUrl = this.connectCalls.at(-1)?.relayUrl ?? ''
    if (relayUrl.includes('down')) throw new Error('WebSocket connect timed out')
    this.isConnected = true
    this.options.onConnectionChange?.(true)
  }

  async beginAdmission(input: ChannelAdmissionInput): Promise<{ confirmCode: string }> {
    this.admissionInputs.push(structuredClone(input))
    if (this.host.rejectAdmission) throw this.host.rejectAdmission
    this.options.onSasCode?.('123456')
    return { confirmCode: '123456' }
  }

  async confirmAdmission(): Promise<ChannelHandshakeConfirmResult> {
    this.isEstablished = true
    const result = this.establishedResult()
    this.options.onEstablished?.(result)
    return result
  }

  async reconnect(input: {
    channelId: string
    memberId: string
    expectedHostIdentityPubKeyB64: string
  }): Promise<ChannelHandshakeConfirmResult> {
    this.reconnectInputs.push(structuredClone(input))
    if (input.expectedHostIdentityPubKeyB64 !== hostIdentityPubKeyB64) {
      throw new ChannelRemoteError('identity_mismatch', 'wrong host key')
    }
    this.isEstablished = true
    const result = this.establishedResult()
    this.options.onEstablished?.(result)
    return result
  }

  async append(
    content: string,
    clientMessageId = 'generated'
  ): Promise<{ accepted: true; deduplicated: boolean; record: ChannelMessage }> {
    const existing = this.host.appendIds.get(clientMessageId)
    if (existing) return { accepted: true, deduplicated: true, record: structuredClone(existing) }
    const next = record(this.host.records.length + 1, content)
    next.authorMemberId = 'member-b'
    next.clientMessageId = clientMessageId
    this.host.records.push(next)
    this.host.appendIds.set(clientMessageId, next)
    this.applyRecords([next], true)
    return { accepted: true, deduplicated: false, record: structuredClone(next) }
  }

  async resume(args?: { resumeAfter?: number }): Promise<{ highWaterSequence: number }> {
    const resumeAfter = args?.resumeAfter ?? this.highWaterSequence
    this.resumeAfter.push(resumeAfter)
    this.options.onMembersSnapshot?.({
      channelId: 'channel-a',
      membershipRevision: 2,
      members: this.host.members
    })
    this.applyRecords(
      this.host.records.filter((candidate) => candidate.sequence > resumeAfter),
      true
    )
    return { highWaterSequence: this.host.records.length }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.isConnected = false
    this.isEstablished = false
    this.options.onConnectionChange?.(false)
  }

  revoke(): void {
    this.options.onRevoked?.({ channelId: 'channel-a', memberId: 'member-b' })
  }

  private applyRecords(records: ChannelMessage[], live: boolean): void {
    for (const value of records) {
      if (!this.localRecords.some((stored) => stored.sequence === value.sequence)) {
        this.localRecords.push(structuredClone(value))
      }
      this.highWaterSequence = Math.max(this.highWaterSequence, value.sequence)
    }
    this.options.onRecords?.(structuredClone(records), {
      highWaterSequence: this.host.records.length,
      live
    })
  }

  private establishedResult(): ChannelHandshakeConfirmResult {
    return {
      sessionId: 'session-a',
      channelId: 'channel-a',
      memberId: 'member-b',
      membershipRevision: 2,
      hostIdentityPubKeyB64,
      establishedAt: 1_100
    }
  }
}

function fakeHost(records: ChannelMessage[] = []): FakeHost {
  return {
    records: structuredClone(records),
    members: [
      {
        memberId: 'owner-a',
        kind: 'human',
        displayName: 'Host',
        status: 'active',
        joinedAt: 900
      },
      {
        memberId: 'member-b',
        kind: 'human',
        displayName: 'Member B',
        status: 'active',
        joinedAt: 1_100
      }
    ],
    clients: [],
    appendIds: new Map()
  }
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`encrypted:${plain}`, 'utf8'),
  decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^encrypted:/, '')
}

function service(
  root: string,
  host: FakeHost,
  onChange?: (snapshot: unknown) => void,
  overrides: Partial<ChannelMemberProductionServiceOptions> = {}
) {
  return createChannelMemberProductionService({
    userDataPath: root,
    safeStorage,
    now: () => 10_000,
    connectTimeoutMs: 50,
    socketFactory: () => ({ send: () => {}, close: () => {} }),
    createClient: (options) => {
      const client = new FakeChannelMemberClient(options, host)
      host.clients.push(client)
      return client
    },
    ...(onChange ? { onChange } : {}),
    ...overrides
  })
}

function allFileText(root: string): string {
  const values: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) values.push(readFileSync(child).toString('utf8'))
    }
  }
  visit(root)
  return values.join('\n')
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ChannelMemberProductionService', () => {
  it('joins through relay fallback, waits for SAS, and persists a secret-free offline replica', async () => {
    const root = directory()
    const host = fakeHost([record(1, 'host history')])
    const changes: unknown[] = []
    const member = service(root, host, (snapshot) => changes.push(snapshot))

    expect(member.snapshot()).toMatchObject({ phase: 'idle', connected: false, channel: null })
    await expect(member.beginJoin(joinInput())).resolves.toEqual({ confirmCode: '123456' })
    expect(member.snapshot().phase).toBe('awaiting_sas')
    expect(host.clients).toHaveLength(2)
    expect(host.clients[0].disposed).toBe(true)
    expect(host.clients[1].admissionInputs[0]).toMatchObject({
      channelId: 'channel-a',
      inviteId: 'invite-a',
      inviteToken: 'invite-secret',
      displayName: 'Member B'
    })

    await expect(member.confirmJoin()).resolves.toMatchObject({
      phase: 'connected',
      connected: true,
      channel: { channelId: 'channel-a', title: 'General', status: 'active' },
      members: [{ displayName: 'Host' }, { displayName: 'Member B' }],
      records: [{ content: 'host history' }],
      highWaterSequence: 1
    })
    expect(member.listMemberships()).toEqual([
      expect.objectContaining({ channelId: 'channel-a', active: true })
    ])

    const persisted = allFileText(join(root, 'channel-memberships'))
    expect(persisted).not.toContain('invite-secret')
    expect(persisted).not.toContain('session-a')
    expect(JSON.stringify(member.snapshot())).not.toContain('relay.example')
    expect(JSON.stringify(member.snapshot())).not.toContain(hostIdentityPubKeyB64)
    expect(JSON.stringify(changes)).not.toContain('invite-secret')
  })

  it('restarts offline, reuses the encrypted identity, pins the host, and resumes only the gap', async () => {
    const root = directory()
    const host = fakeHost([record(1)])
    const first = service(root, host)
    await first.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await first.confirmJoin()
    first.dispose()
    host.records.push(record(2, 'while offline'))

    const restarted = service(root, host)
    expect(restarted.snapshot()).toMatchObject({
      phase: 'disconnected',
      records: [{ sequence: 1 }],
      highWaterSequence: 1
    })
    await expect(restarted.reconnect()).resolves.toMatchObject({
      phase: 'connected',
      records: [{ sequence: 1 }, { sequence: 2, content: 'while offline' }],
      highWaterSequence: 2
    })

    const client = host.clients.at(-1)!
    expect(client.options.initialCursor).toBe(1)
    expect(client.options.initialRecords).toEqual([expect.objectContaining({ sequence: 1 })])
    expect(client.reconnectInputs).toEqual([
      {
        channelId: 'channel-a',
        memberId: 'member-b',
        expectedHostIdentityPubKeyB64: hostIdentityPubKeyB64
      }
    ])
    expect(client.resumeAfter).toEqual([1])
  })

  it('durably applies an append response and preserves its idempotent client id', async () => {
    const root = directory()
    const host = fakeHost()
    const member = service(root, host)
    await member.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await member.confirmJoin()

    await expect(
      member.append({ content: 'hello Channel', clientMessageId: 'member-b-1' })
    ).resolves.toMatchObject({ deduplicated: false, record: { sequence: 1 } })
    await expect(
      member.append({ content: 'hello Channel', clientMessageId: 'member-b-1' })
    ).resolves.toMatchObject({ deduplicated: true, record: { sequence: 1 } })

    expect(host.records).toHaveLength(1)
    expect(new ChannelMemberReplicaStore(root).readActive()).toMatchObject({
      highWaterSequence: 1,
      records: [{ clientMessageId: 'member-b-1', content: 'hello Channel' }]
    })
  })

  it('disconnects fail-closed when a live record cannot enter the durable replica', async () => {
    class FaultyReplicaStore extends ChannelMemberReplicaStore {
      failAppends = false

      override appendRecords(channelId: string, records: readonly ChannelMessage[]) {
        if (this.failAppends) throw new ChannelMemberReplicaError('injected replica failure')
        return super.appendRecords(channelId, records)
      }
    }

    const root = directory()
    const host = fakeHost()
    const store = new FaultyReplicaStore(root)
    const member = service(root, host, undefined, { createStore: () => store })
    await member.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await member.confirmJoin()
    store.failAppends = true

    await expect(
      member.append({ content: 'host still commits this', clientMessageId: 'member-b-1' })
    ).rejects.toMatchObject({ code: 'recovery_blocked' })
    expect(member.snapshot()).toMatchObject({
      phase: 'recovery_blocked',
      connected: false,
      highWaterSequence: 0,
      error: { code: 'recovery_blocked' }
    })
    expect(host.records).toHaveLength(1)
    expect(new ChannelMemberReplicaStore(root).readActive()?.highWaterSequence).toBe(0)
  })

  it('retains readable history after revocation and refuses silent reconnect', async () => {
    const root = directory()
    const host = fakeHost([record(1)])
    const member = service(root, host)
    await member.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await member.confirmJoin()
    host.clients.at(-1)!.revoke()

    expect(member.snapshot()).toMatchObject({
      phase: 'revoked',
      connected: false,
      channel: { status: 'revoked' },
      records: [{ sequence: 1 }],
      error: { code: 'revoked' }
    })
    const restarted = service(root, host)
    await expect(restarted.reconnect()).rejects.toMatchObject({ code: 'revoked' })
    expect(host.clients).toHaveLength(1)
  })

  it('fails closed without replacing a missing identity or accepting a host-key change', async () => {
    const root = directory()
    const host = fakeHost()
    const member = service(root, host)
    await member.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await member.confirmJoin()
    member.dispose()
    rmSync(channelMemberReplicaPaths(root).identity)

    const missingIdentity = service(root, host)
    await expect(missingIdentity.reconnect()).rejects.toMatchObject({
      code: 'identity_unavailable'
    })

    const pinnedRoot = directory()
    const pinnedHost = fakeHost()
    const pinned = service(pinnedRoot, pinnedHost)
    await pinned.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await pinned.confirmJoin()
    pinned.disconnect()
    pinnedHost.rejectAdmission = new ChannelRemoteError('identity_mismatch', 'spoofed host')
    await expect(
      pinned.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    ).rejects.toMatchObject({ code: 'protocol_error' })
    expect(pinnedHost.clients.at(-1)!.admissionInputs[0].expectedHostIdentityPubKeyB64).toBe(
      hostIdentityPubKeyB64
    )
  })

  it('projects corrupt replicas as recovery-blocked and clears them only explicitly', () => {
    const root = directory()
    const paths = channelMemberReplicaPaths(root)
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.memberships, '{corrupted', { mode: 0o600 })
    const host = fakeHost()
    const member = service(root, host)

    expect(member.snapshot()).toMatchObject({
      phase: 'recovery_blocked',
      connected: false,
      error: { code: 'recovery_blocked' }
    })
    expect(host.clients).toHaveLength(0)
    member.disconnect()
    expect(member.snapshot().phase).toBe('recovery_blocked')
    member.forget()
    expect(member.snapshot()).toMatchObject({ phase: 'idle', channel: null, error: null })
  })

  it('can discard only corrupted local history and replay it from the pinned host', async () => {
    const root = directory()
    const host = fakeHost([record(1, 'authoritative host copy')])
    const first = service(root, host)
    await first.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    await first.confirmJoin()
    first.dispose()
    const recordPath = join(channelMemberReplicaPaths(root).records, 'channel-a.jsonl')
    writeFileSync(
      recordPath,
      readFileSync(recordPath, 'utf8').replace('authoritative host copy', 'tampered locally')
    )

    const restarted = service(root, host)
    expect(restarted.snapshot().phase).toBe('recovery_blocked')
    expect(restarted.resetLocalHistory('channel-a')).toMatchObject({
      phase: 'disconnected',
      highWaterSequence: 0,
      error: null
    })
    await expect(restarted.reconnect()).resolves.toMatchObject({
      phase: 'connected',
      records: [{ content: 'authoritative host copy' }],
      highWaterSequence: 1
    })
  })

  it('rejects expired, malformed, and remotely refused invites without persisting tokens', async () => {
    const root = directory()
    const host = fakeHost()
    const member = service(root, host)

    await expect(member.beginJoin(joinInput({ expiresAt: 9_999 }))).rejects.toMatchObject({
      code: 'invite_expired'
    })
    await expect(
      member.beginJoin(joinInput({ relayUrls: ['https://not-a-websocket.example'] }))
    ).rejects.toMatchObject({ code: 'invalid_invite' })

    host.rejectAdmission = new ChannelRemoteError('revoked', 'invite consumed')
    await expect(
      member.beginJoin(joinInput({ relayUrls: ['wss://relay.example'] }))
    ).rejects.toBeInstanceOf(ChannelMemberProductionError)
    expect(member.snapshot()).toMatchObject({ phase: 'idle', error: { code: 'revoked' } })
    expect(readFileSync(channelMemberReplicaPaths(root).identity, 'utf8')).not.toContain(
      'invite-secret'
    )
  })
})
