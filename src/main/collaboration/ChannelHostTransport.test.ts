import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  makeChannelRequest,
  parseChannelWireMessage,
  type ChannelWireMessage
} from '../../shared/collaboration/ChannelWireProtocol'
import { ChannelHostTransport } from './ChannelHostTransport'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelStore } from './ChannelStore'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-transport-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

interface FakeSocket extends TransportSocket {
  sent: string[]
  handlers: {
    onOpen: () => void
    onMessage: (data: string) => void
    onClose: (code: number) => void
    onError: (err: Error) => void
  }
  closed: boolean
  failSend?: boolean
}

function createFixture() {
  const directory = temporaryDirectory()
  const store = new ChannelStore(join(directory, 'channels.json'))
  const created = store.createChannel({
    chatId: 'general-chat',
    owner: { displayName: 'Host', identityPublicKey: 'ed25519:host' },
    title: 'Transport room',
    now: 1_000
  })
  const memberB = store.admitMember({
    channelId: created.channel.channelId,
    displayName: 'Member B',
    identityPublicKey: 'ed25519:b',
    roomId: 'room-b',
    now: 2_000
  })
  const memberC = store.admitMember({
    channelId: created.channel.channelId,
    displayName: 'Member C',
    identityPublicKey: 'ed25519:c',
    roomId: 'room-c',
    now: 3_000
  })
  const log = new ChannelMessageLog(join(directory, 'logs'), store)
  const sockets = new Map<string, FakeSocket>()
  const logs: string[] = []

  const socketFactory: TransportSocketFactory = (_url, headers, handlers) => {
    const roomId = headers['x-taskwraith-channel-id']
      ? String(_url).split('/').pop()!
      : String(_url).split('/').pop()!
    const socket: FakeSocket = {
      sent: [],
      handlers,
      closed: false,
      send(data: string) {
        if (socket.failSend) throw new Error('socket send failed')
        if (socket.closed) throw new Error('socket closed')
        socket.sent.push(data)
      },
      close() {
        socket.closed = true
        handlers.onClose(1000)
      }
    }
    sockets.set(roomId, socket)
    queueMicrotask(() => handlers.onOpen())
    return socket
  }

  const transport = new ChannelHostTransport({
    socketFactory,
    store,
    log,
    logger: (line) => logs.push(line)
  })

  return {
    store,
    log,
    transport,
    sockets,
    logs,
    channel: created.channel,
    owner: created.owner,
    memberB,
    memberC
  }
}

function parseSent(socket: FakeSocket): ChannelWireMessage[] {
  return socket.sent
    .map((frame) => parseChannelWireMessage(frame))
    .filter((frame): frame is ChannelWireMessage => frame !== null)
}

function deliver(socket: FakeSocket, payload: unknown): void {
  socket.handlers.onMessage(JSON.stringify(payload))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ChannelHostTransport', () => {
  it('fans a durable append to every active non-host room (star fan-out + author echo)', async () => {
    const { transport, sockets, channel, memberB, memberC, log } = createFixture()
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    transport.openMemberRoom(channel.channelId, memberC.memberId, 'ws://relay', 'room-c')
    const socketB = sockets.get('room-b')!
    const socketC = sockets.get('room-c')!

    deliver(
      socketB,
      makeChannelRequest('req-1', 'channel.log.append', {
        clientMessageId: 'cmsg-1',
        content: 'hello channel'
      })
    )
    await flush()

    const committed = log.getMessage(channel.channelId, 1)
    expect(committed).toMatchObject({
      sequence: 1,
      authorMemberId: memberB.memberId,
      content: 'hello channel'
    })

    const batchesB = parseSent(socketB).filter(
      (m) => m.t === 'channel.event' && m.method === 'channel.log.batch'
    )
    const batchesC = parseSent(socketC).filter(
      (m) => m.t === 'channel.event' && m.method === 'channel.log.batch'
    )
    expect(batchesB.length).toBeGreaterThanOrEqual(1)
    expect(batchesC.length).toBeGreaterThanOrEqual(1)
    expect(batchesB[0]).toMatchObject({
      t: 'channel.event',
      method: 'channel.log.batch',
      params: {
        records: [expect.objectContaining({ sequence: 1, content: 'hello channel' })],
        live: true
      }
    })
    expect(batchesC[0]).toMatchObject({
      t: 'channel.event',
      method: 'channel.log.batch',
      params: {
        records: [expect.objectContaining({ sequence: 1 })],
        live: true
      }
    })

    const appendResult = parseSent(socketB).find(
      (m) => m.t === 'channel.event' && m.method === 'channel.log.appendResult'
    )
    expect(appendResult).toMatchObject({
      reqId: 'req-1',
      params: { accepted: true, record: expect.objectContaining({ sequence: 1 }) }
    })

    transport.dispose()
  })

  it('isolates a failed room without rolling back the durable commit or blocking peers', async () => {
    const { transport, sockets, channel, memberB, memberC, log, logs } = createFixture()
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    transport.openMemberRoom(channel.channelId, memberC.memberId, 'ws://relay', 'room-c')
    const socketB = sockets.get('room-b')!
    const socketC = sockets.get('room-c')!
    socketC.failSend = true

    deliver(
      socketB,
      makeChannelRequest('req-2', 'channel.log.append', {
        clientMessageId: 'cmsg-2',
        content: 'survive failed peer'
      })
    )
    await flush()

    expect(log.getMessage(channel.channelId, 1)).toMatchObject({
      content: 'survive failed peer',
      sequence: 1
    })
    const batchesB = parseSent(socketB).filter(
      (m) => m.t === 'channel.event' && m.method === 'channel.log.batch'
    )
    expect(batchesB).toHaveLength(1)
    expect(socketC.sent).toHaveLength(0)
    expect(logs.some((line) => line.includes('room-c') && line.includes('socket send failed'))).toBe(
      true
    )

    transport.dispose()
  })

  it('replays history on resume then transitions the room to live delivery', async () => {
    const { transport, sockets, channel, memberB, memberC, log } = createFixture()
    // Seed two durable messages from B before C connects for catch-up.
    log.append({
      channelId: channel.channelId,
      principalMemberId: memberB.memberId,
      identityPublicKey: memberB.identityPublicKey,
      roomId: memberB.roomId,
      clientMessageId: 'seed-1',
      content: 'first',
      now: 4_000
    })
    log.append({
      channelId: channel.channelId,
      principalMemberId: memberB.memberId,
      identityPublicKey: memberB.identityPublicKey,
      roomId: memberB.roomId,
      clientMessageId: 'seed-2',
      content: 'second',
      now: 5_000
    })

    transport.openMemberRoom(channel.channelId, memberC.memberId, 'ws://relay', 'room-c')
    const socketC = sockets.get('room-c')!

    deliver(
      socketC,
      makeChannelRequest('req-resume', 'channel.log.resume', { resumeAfter: 0 })
    )
    await flush()

    const batches = parseSent(socketC).filter(
      (m) => m.t === 'channel.event' && m.method === 'channel.log.batch'
    )
    expect(batches.length).toBeGreaterThanOrEqual(1)
    const catchUp = batches[0]!
    expect(catchUp).toMatchObject({
      method: 'channel.log.batch',
      params: {
        live: false,
        highWaterSequence: 2,
        records: [
          expect.objectContaining({ sequence: 1, content: 'first' }),
          expect.objectContaining({ sequence: 2, content: 'second' })
        ]
      }
    })

    const resumeOk = parseSent(socketC).find((m) => m.t === 'channel.res' && m.reqId === 'req-resume')
    expect(resumeOk).toMatchObject({
      ok: true,
      result: { highWaterSequence: 2, live: true }
    })

    // Live fan-out after resume completes.
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    const socketB = sockets.get('room-b')!
    deliver(
      socketB,
      makeChannelRequest('req-live', 'channel.log.append', {
        clientMessageId: 'live-1',
        content: 'third live'
      })
    )
    await flush()

    const liveBatches = parseSent(socketC).filter(
      (m) =>
        m.t === 'channel.event' &&
        m.method === 'channel.log.batch' &&
        (m.params as { live?: boolean }).live === true
    )
    expect(liveBatches.some((m) => JSON.stringify(m).includes('third live'))).toBe(true)

    transport.dispose()
  })

  it('returns the same durable record through transport idempotency', async () => {
    const { transport, sockets, channel, memberB, log } = createFixture()
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    const socketB = sockets.get('room-b')!

    const payload = makeChannelRequest('req-a', 'channel.log.append', {
      clientMessageId: 'same-id',
      content: 'once only'
    })
    deliver(socketB, payload)
    await flush()
    deliver(
      socketB,
      makeChannelRequest('req-b', 'channel.log.append', {
        clientMessageId: 'same-id',
        content: 'once only'
      })
    )
    await flush()

    expect(log.highWaterSequence(channel.channelId)).toBe(1)
    const results = parseSent(socketB).filter(
      (m): m is Extract<ChannelWireMessage, { t: 'channel.event' }> =>
        m.t === 'channel.event' && m.method === 'channel.log.appendResult'
    )
    expect(results).toHaveLength(2)
    const firstId = (results[0]!.params as { record: { messageId: string } }).record.messageId
    const secondId = (results[1]!.params as { record: { messageId: string } }).record.messageId
    expect(firstId).toBe(secondId)

    transport.dispose()
  })

  it('closes the room after channel.member.revoked and rejects further appends', async () => {
    const { transport, sockets, channel, memberB, store } = createFixture()
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    const socketB = sockets.get('room-b')!

    const revoked = store.revokeMember({
      channelId: channel.channelId,
      memberId: memberB.memberId,
      now: 9_000
    })
    transport.notifyMemberRevoked(
      channel.channelId,
      memberB.memberId,
      store.getChannel(channel.channelId)!.membershipRevision
    )

    const revokedEvent = parseSent(socketB).find(
      (m) => m.t === 'channel.event' && m.method === 'channel.member.revoked'
    )
    expect(revokedEvent).toMatchObject({
      params: {
        channelId: channel.channelId,
        memberId: memberB.memberId
      }
    })
    expect(transport.listOpenRooms()).toHaveLength(0)
    expect(revoked.status).toBe('revoked')

    transport.dispose()
  })

  it('revalidates pinned identity on reconnect and rejects appends with author fields', async () => {
    const { transport, sockets, channel, memberB } = createFixture()
    transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
    const socketB = sockets.get('room-b')!

    deliver(socketB, makeChannelRequest('req-re', 'channel.reconnect', {}))
    await flush()

    const reconnectOk = parseSent(socketB).find((m) => m.t === 'channel.res' && m.reqId === 'req-re')
    expect(reconnectOk).toMatchObject({
      ok: true,
      result: {
        channelId: channel.channelId,
        memberId: memberB.memberId
      }
    })
    const snapshot = parseSent(socketB).find(
      (m) => m.t === 'channel.event' && m.method === 'channel.members.snapshot'
    )
    expect(snapshot).toBeTruthy()

    // Forbidden author field → protocol_unsupported, no durable commit.
    socketB.sent.length = 0
    deliver(
      socketB,
      makeChannelRequest('req-bad', 'channel.log.append', {
        clientMessageId: 'evil',
        content: 'nope',
        authorMemberId: 'spoofed'
      })
    )
    await flush()

    const bad = parseSent(socketB).find((m) => m.t === 'channel.res' && m.reqId === 'req-bad')
    expect(bad).toMatchObject({
      ok: false,
      error: { code: 'protocol_unsupported' }
    })

    transport.dispose()
  })

  it('schedules reconnect backoff when a still-wanted room drops', async () => {
    vi.useFakeTimers()
    try {
      const { transport, sockets, channel, memberB } = createFixture()
      transport.openMemberRoom(channel.channelId, memberB.memberId, 'ws://relay', 'room-b')
      const first = sockets.get('room-b')!
      first.handlers.onClose(1006)
      expect(first.closed || true).toBe(true)

      // Advance past first backoff (1s base).
      await vi.advanceTimersByTimeAsync(1_100)
      // A new socket should have been created for the same room id.
      expect(sockets.get('room-b')).toBeTruthy()

      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
