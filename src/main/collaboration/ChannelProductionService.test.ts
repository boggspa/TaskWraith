import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateIdentityKeyPair, type KeyPair } from '../../shared/e2ee/keys'
import type {
  TransportSocketFactory,
  TransportSocketHandlers
} from '../remote/RemoteTransportClient'
import { ChannelError, type ChannelErrorCode } from './ChannelStore'
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
    relay: {
      hostRelayUrl: args.hostRelayUrl ?? (() => 'ws://127.0.0.1:8787'),
      inviteRelayUrls:
        args.inviteRelayUrls ?? (() => ['wss://relay.example', 'wss://relay.example/'])
    },
    socketFactory: sockets.factory,
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
  })
})
