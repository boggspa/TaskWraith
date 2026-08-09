import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateIdentityKeyPair, type KeyPair } from '../../shared/e2ee/keys'
import type {
  TransportSocket,
  TransportSocketFactory,
  TransportSocketHandlers
} from '../remote/RemoteTransportClient'
import { ChannelHostTransport } from './ChannelHostTransport'
import { ChannelMemberClient } from './ChannelMemberClient'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelRuntime } from './ChannelRuntime'
import { ChannelError, ChannelStore } from './ChannelStore'

interface RelayEndpoint {
  role: 'mac' | 'iphone'
  handlers: TransportSocketHandlers
  closed: boolean
}

interface RelayFrame {
  roomId: string
  from: 'mac' | 'iphone'
  data: string
}

class BlindTestRelay {
  readonly frames: RelayFrame[] = []
  private readonly rooms = new Map<string, Partial<Record<'mac' | 'iphone', RelayEndpoint>>>()

  readonly socketFactory: TransportSocketFactory = (url, headers, handlers) => {
    const roomId = new URL(url).pathname.split('/').at(-1)!
    const role = headers['x-taskwraith-role'] as 'mac' | 'iphone'
    if (role !== 'mac' && role !== 'iphone') throw new Error('invalid relay role')
    const room = this.rooms.get(roomId) ?? {}
    const incumbent = room[role]
    if (incumbent && !incumbent.closed) this.closeEndpoint(roomId, incumbent, 4006)
    const endpoint: RelayEndpoint = { role, handlers, closed: false }
    room[role] = endpoint
    this.rooms.set(roomId, room)
    queueMicrotask(() => {
      if (!endpoint.closed) handlers.onOpen()
    })

    const socket: TransportSocket = {
      send: (data) => {
        if (endpoint.closed) throw new Error('relay endpoint is closed')
        this.frames.push({ roomId, from: role, data })
        const peer = room[role === 'mac' ? 'iphone' : 'mac']
        if (peer && !peer.closed) {
          queueMicrotask(() => {
            if (!peer.closed) peer.handlers.onMessage(data)
          })
        }
      },
      close: () => this.closeEndpoint(roomId, endpoint, 1000)
    }
    return socket
  }

  disconnect(roomId: string, role: 'mac' | 'iphone'): void {
    const endpoint = this.rooms.get(roomId)?.[role]
    if (endpoint) this.closeEndpoint(roomId, endpoint, 1006)
  }

  private closeEndpoint(roomId: string, endpoint: RelayEndpoint, code: number): void {
    if (endpoint.closed) return
    endpoint.closed = true
    const room = this.rooms.get(roomId)
    if (room?.[endpoint.role] === endpoint) delete room[endpoint.role]
    queueMicrotask(() => endpoint.handlers.onClose(code))
  }
}

const cleanup: Array<() => void> = []

afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

interface Fixture {
  directory: string
  relay: BlindTestRelay
  store: ChannelStore
  log: ChannelMessageLog
  runtime: ChannelRuntime
  transport: ChannelHostTransport
  channelId: string
  ownerMemberId: string
  hostIdentityPubKeyB64: string
  admissions: Array<{ memberId: string; confirmCode: string; mode: string }>
  replayBatches: Array<{
    memberId: string
    recordCount: number
    serializedBytes: number
    live: boolean
  }>
}

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channel-runtime-'))
  const relay = new BlindTestRelay()
  const store = new ChannelStore(join(directory, 'channels.json'))
  const log = new ChannelMessageLog(join(directory, 'logs'), store)
  const admissions: Fixture['admissions'] = []
  const replayBatches: Fixture['replayBatches'] = []
  const runtime = new ChannelRuntime({
    identityKeyPair: generateIdentityKeyPair(),
    store,
    log,
    onAdmissionBegan: (info) =>
      admissions.push({
        memberId: info.memberId,
        confirmCode: info.confirmCode,
        mode: info.mode
      }),
    onReplayBatch: (info) =>
      replayBatches.push({
        memberId: info.memberId,
        recordCount: info.recordCount,
        serializedBytes: info.serializedBytes,
        live: info.live
      })
  })
  const transport = new ChannelHostTransport({
    socketFactory: relay.socketFactory,
    runtime,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20
  })
  const created = runtime.createChannel({
    chatId: 'general',
    title: 'General',
    ownerDisplayName: 'Host'
  })
  cleanup.push(() => {
    transport.dispose()
    runtime.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    relay,
    store,
    log,
    runtime,
    transport,
    channelId: created.channel.channelId,
    ownerMemberId: created.owner.memberId,
    hostIdentityPubKeyB64: runtime.hostIdentityPublicKey(),
    admissions,
    replayBatches
  }
}

interface MemberHandle {
  client: ChannelMemberClient
  identity: KeyPair
  roomId: string
  memberId: string
  sasCode: string
  errors: Error[]
  snapshots: unknown[]
  appendResults: unknown[]
  revoked: unknown[]
}

async function addMember(
  fixture: Fixture,
  displayName: string,
  identity = generateIdentityKeyPair()
): Promise<MemberHandle> {
  const issued = fixture.runtime.createInvite({
    channelId: fixture.channelId,
    ttlMs: 60_000
  })
  fixture.transport.openRoom(fixture.channelId, issued.invite.roomId, 'ws://relay.test')
  const errors: Error[] = []
  const snapshots: unknown[] = []
  const appendResults: unknown[] = []
  const revoked: unknown[] = []
  let sasCode = ''
  const client = new ChannelMemberClient({
    socketFactory: fixture.relay.socketFactory,
    identity,
    onSasCode: (code) => {
      sasCode = code
    },
    onMembersSnapshot: (snapshot) => snapshots.push(snapshot),
    onAppendResult: (result) => appendResults.push(result),
    onRevoked: (event) => revoked.push(event),
    onError: (error) => errors.push(error)
  })
  client.connect('ws://relay.test', issued.invite.roomId)
  await client.whenConnected()
  const admissionIndex = fixture.admissions.length
  const local = await client.beginAdmission({
    channelId: fixture.channelId,
    inviteId: issued.invite.inviteId,
    inviteToken: issued.inviteToken,
    displayName,
    expectedHostIdentityPubKeyB64: fixture.hostIdentityPubKeyB64
  })
  const host = fixture.admissions[admissionIndex]
  expect(host).toBeDefined()
  expect(local.confirmCode).toBe(host!.confirmCode)
  const confirmed = await client.confirmAdmission()
  expect(confirmed.memberId).toBe(host!.memberId)
  await client.resume({ resumeAfter: 0 })
  await flush()
  return {
    client,
    identity,
    roomId: issued.invite.roomId,
    memberId: confirmed.memberId,
    sasCode,
    errors,
    snapshots,
    appendResults,
    revoked
  }
}

describe('encrypted Channel runtime over blind member rooms', () => {
  it('does not let one invite or token cross into another relay room', async () => {
    const fixture = await createFixture()
    const inviteA = fixture.runtime.createInvite({
      channelId: fixture.channelId,
      ttlMs: 60_000
    })
    const inviteB = fixture.runtime.createInvite({
      channelId: fixture.channelId,
      ttlMs: 60_000
    })
    fixture.transport.openRoom(fixture.channelId, inviteA.invite.roomId, 'ws://relay.test')
    fixture.transport.openRoom(fixture.channelId, inviteB.invite.roomId, 'ws://relay.test')
    const client = new ChannelMemberClient({
      socketFactory: fixture.relay.socketFactory
    })
    client.connect('ws://relay.test', inviteB.invite.roomId)
    await client.whenConnected()

    await expect(
      client.beginAdmission({
        channelId: fixture.channelId,
        inviteId: inviteA.invite.inviteId,
        inviteToken: inviteA.inviteToken,
        displayName: 'Cross-room member',
        expectedHostIdentityPubKeyB64: fixture.hostIdentityPubKeyB64
      })
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(
      fixture.store.listMembers(fixture.channelId).filter((member) => member.status !== 'revoked')
    ).toHaveLength(1)
    client.dispose()
  })

  it('admits two pinned humans, sequences simultaneous appends, and never relays app plaintext', async () => {
    const fixture = await createFixture()
    const memberB = await addMember(fixture, 'Member B')
    const memberC = await addMember(fixture, 'Member C')
    const frameStart = fixture.relay.frames.length

    const [fromB, fromC, fromHost] = await Promise.all([
      memberB.client.append('hello from B', 'b-1'),
      memberC.client.append('hello from C', 'c-1'),
      fixture.runtime.appendHost(fixture.channelId, {
        clientMessageId: 'host-1',
        content: 'hello from Host'
      })
    ])
    await flush()

    expect(fromB.record.authorMemberId).toBe(memberB.memberId)
    expect(fromC.record.authorMemberId).toBe(memberC.memberId)
    expect(fromHost.record.authorMemberId).toBe(fixture.ownerMemberId)
    expect(fixture.log.highWaterSequence(fixture.channelId)).toBe(3)
    expect(memberB.client.records()).toEqual(memberC.client.records())
    expect(memberB.client.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    expect(memberB.client.digest()).toBe(fixture.log.digest(fixture.channelId))
    expect(memberB.snapshots.at(-1)).toMatchObject({
      channelId: fixture.channelId,
      members: expect.arrayContaining([
        expect.objectContaining({ memberId: memberB.memberId, kind: 'human' }),
        expect.objectContaining({ memberId: memberC.memberId, kind: 'human' })
      ])
    })
    expect(memberB.errors).toEqual([])
    expect(memberC.errors).toEqual([])

    for (const relayed of fixture.relay.frames.slice(frameStart)) {
      const frame = JSON.parse(relayed.data) as { t?: string }
      expect(frame.t).toBe('channel.enc')
      expect(relayed.data).not.toContain('hello from')
    }

    const batchCount = memberC.client.records().length
    const retry = await memberB.client.append('hello from B', 'b-1')
    await flush()
    expect(retry.deduplicated).toBe(true)
    expect(fixture.log.highWaterSequence(fixture.channelId)).toBe(3)
    expect(memberC.client.records()).toHaveLength(batchCount)
  })

  it('reconnects the same pinned member without allocating a seat and replays the offline gap once', async () => {
    const fixture = await createFixture()
    const memberB = await addMember(fixture, 'Member B')
    const memberC = await addMember(fixture, 'Member C')
    await memberB.client.append('before disconnect', 'before')
    await flush()
    const retained = memberB.client.records()
    const cursor = memberB.client.highWaterSequence
    const originalCount = fixture.store.listMembers(fixture.channelId).length
    memberB.client.dispose()
    await flush()

    await fixture.runtime.appendHost(fixture.channelId, {
      clientMessageId: 'host-offline',
      content: 'host while B offline'
    })
    await memberC.client.append('C while B offline', 'c-offline')
    await flush()

    const errors: Error[] = []
    const reconnected = new ChannelMemberClient({
      socketFactory: fixture.relay.socketFactory,
      identity: memberB.identity,
      initialRecords: retained,
      initialCursor: cursor,
      onError: (error) => errors.push(error)
    })
    reconnected.connect('ws://relay.test', memberB.roomId)
    await reconnected.whenConnected()
    const confirmed = await reconnected.reconnect({
      channelId: fixture.channelId,
      memberId: memberB.memberId,
      expectedHostIdentityPubKeyB64: fixture.hostIdentityPubKeyB64
    })
    expect(confirmed.memberId).toBe(memberB.memberId)
    await reconnected.resume()
    await flush()

    expect(fixture.store.listMembers(fixture.channelId)).toHaveLength(originalCount)
    expect(reconnected.records()).toEqual(memberC.client.records())
    expect(reconnected.records().map((record) => record.sequence)).toEqual([1, 2, 3])
    expect(errors).toEqual([])
    reconnected.dispose()
  })

  it('replays more than one MiB in bounded ordered batches', async () => {
    const fixture = await createFixture()
    const member = await addMember(fixture, 'Member B')
    member.client.dispose()
    await flush()

    for (let index = 0; index < 140; index += 1) {
      await fixture.runtime.appendHost(fixture.channelId, {
        clientMessageId: `large-${index}`,
        content: `${String(index).padStart(4, '0')}:${'x'.repeat(7_800)}`
      })
    }
    expect(
      Buffer.byteLength(
        JSON.stringify(
          Array.from({ length: 140 }, (_, index) =>
            fixture.log.getMessage(fixture.channelId, index + 1)
          )
        ),
        'utf8'
      )
    ).toBeGreaterThan(1024 * 1024)

    const replayStart = fixture.replayBatches.length
    const reconnected = new ChannelMemberClient({
      socketFactory: fixture.relay.socketFactory,
      identity: member.identity
    })
    reconnected.connect('ws://relay.test', member.roomId)
    await reconnected.whenConnected()
    await reconnected.reconnect({
      channelId: fixture.channelId,
      memberId: member.memberId,
      expectedHostIdentityPubKeyB64: fixture.hostIdentityPubKeyB64
    })
    await reconnected.resume({ resumeAfter: 0 })
    await flush()

    const batches = fixture.replayBatches.slice(replayStart)
    expect(batches.length).toBeGreaterThan(2)
    expect(batches.every((batch) => batch.recordCount <= 256)).toBe(true)
    expect(batches.every((batch) => batch.serializedBytes <= 512 * 1024)).toBe(true)
    expect(batches.at(-1)?.live).toBe(true)
    expect(reconnected.records()).toHaveLength(140)
    expect(reconnected.records().map((record) => record.sequence)).toEqual(
      Array.from({ length: 140 }, (_, index) => index + 1)
    )
    expect(reconnected.digest()).toBe(fixture.log.digest(fixture.channelId))
    reconnected.dispose()
  }, 30_000)

  it('revokes only the targeted room and denies its pinned identity on reconnect', async () => {
    const fixture = await createFixture()
    const memberB = await addMember(fixture, 'Member B')
    const memberC = await addMember(fixture, 'Member C')

    await fixture.runtime.revokeMember({
      channelId: fixture.channelId,
      memberId: memberB.memberId
    })
    await flush()
    expect(memberB.revoked.at(-1)).toMatchObject({
      channelId: fixture.channelId,
      memberId: memberB.memberId
    })
    await expect(memberB.client.append('denied', 'after-revoke')).rejects.toThrow('not established')

    expect(fixture.transport.listOpenRooms()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ roomId: memberB.roomId })])
    )
    expect(() =>
      fixture.store.validateMemberSession({
        channelId: fixture.channelId,
        memberId: memberB.memberId,
        identityPublicKey: memberB.client.identityPublicKey(),
        roomId: memberB.roomId
      })
    ).toThrowError(expect.objectContaining({ code: 'revoked' }))
    expect(() =>
      fixture.transport.openRoom(fixture.channelId, memberB.roomId, 'ws://relay.test')
    ).toThrowError(ChannelError)

    const accepted = await memberC.client.append('C remains active', 'c-active')
    await flush()
    expect(accepted.record.authorMemberId).toBe(memberC.memberId)
    expect(fixture.store.getMember(fixture.channelId, memberC.memberId)?.status).toBe('active')
  })
})
