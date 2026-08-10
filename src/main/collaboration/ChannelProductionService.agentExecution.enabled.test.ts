import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => ({
  compositionOptions: undefined as unknown,
  start: vi.fn<(channelIds: readonly string[]) => unknown>(),
  handleDurableAppend: vi.fn<(result: unknown) => Promise<unknown>>(),
  drainChannel: vi.fn<(channelId: string) => Promise<void>>(),
  quiesceChannel: vi.fn<(channelId: string) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>()
}))

vi.mock('./ChannelAgentProductionComposition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ChannelAgentProductionComposition')>()
  return {
    ...actual,
    createChannelAgentProductionComposition: (options: unknown) => {
      doubles.compositionOptions = options
      return {
        start: doubles.start,
        handleDurableAppend: doubles.handleDurableAppend,
        drainChannel: doubles.drainChannel,
        quiesceChannel: doubles.quiesceChannel,
        stop: doubles.stop
      }
    }
  }
})

import { generateIdentityKeyPair, type KeyPair } from '../../shared/e2ee/keys'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import type { ChannelAgentProductionCompositionOptions } from './ChannelAgentProductionComposition'
import { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type { ChannelAgentIdentitySafeStorage } from './ChannelAgentIdentityStore'
import {
  createChannelProductionService,
  type ChannelProductionAgentExecutionOptions,
  type ChannelProductionService
} from './ChannelProductionService'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const roots = new Set<string>()
const services = new Set<ChannelProductionService>()

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decryptString: (ciphertext) => ciphertext.toString('utf8'),
  getSelectedStorageBackend: () => 'keychain'
}

const socketFactory: TransportSocketFactory = () => ({
  send: () => undefined,
  close: () => undefined
})

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-channel-agent-production-enabled-'))
  roots.add(root)
  return root
}

function executionPorts(): ChannelProductionAgentExecutionOptions {
  return {
    getChat: vi.fn(),
    resolveWorkspacePrincipal: vi.fn(),
    getSettings: vi.fn(),
    providerAllowed: vi.fn(),
    composeMainOwnedChannelAgentRun: vi.fn(),
    dispatch: vi.fn(),
    subscribeRunEvents: vi.fn(),
    subscribeRunSessions: vi.fn(),
    claimRunAudience: vi.fn(),
    reconcileRun: vi.fn()
  } as unknown as ChannelProductionAgentExecutionOptions
}

function createService(args: {
  userDataPath: string
  identity: KeyPair
  now: () => number
  agentExecution?: ChannelProductionAgentExecutionOptions
}): ChannelProductionService {
  const service = createChannelProductionService({
    userDataPath: args.userDataPath,
    loadIdentity: () => args.identity,
    safeStorage,
    relay: {
      hostRelayUrl: () => 'ws://127.0.0.1:8787',
      inviteRelayUrls: () => []
    },
    socketFactory,
    now: args.now,
    ...(args.agentExecution ? { agentExecution: args.agentExecution } : {})
  })
  services.add(service)
  return service
}

beforeEach(() => {
  doubles.compositionOptions = undefined
  doubles.start.mockReset()
  doubles.handleDurableAppend.mockReset().mockResolvedValue({ kind: 'ignored' })
  doubles.drainChannel.mockReset().mockResolvedValue(undefined)
  doubles.quiesceChannel.mockReset().mockResolvedValue(undefined)
  doubles.stop.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop().catch(() => undefined)))
  services.clear()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('ChannelProductionService enabled agent execution attachment', () => {
  it('recovers only active ready Channels and drains accepted handoffs before stop', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const now = () => 1_700_000_000_000
    const seed = createService({ userDataPath, identity, now })
    seed.start()
    const active = seed.createChannel({
      chatId: 'chat-agent-production-active',
      title: 'Active production Channel',
      ownerDisplayName: 'Host'
    })
    const closed = seed.createChannel({
      chatId: 'chat-agent-production-closed',
      title: 'Closed production Channel',
      ownerDisplayName: 'Host'
    })
    await seed.closeChannel(closed.channelId)
    await seed.stop()
    services.delete(seed)

    const service = createService({
      userDataPath,
      identity,
      now,
      agentExecution: executionPorts()
    })
    service.start()
    expect(doubles.start).toHaveBeenCalledWith([active.channelId])
    const composition = doubles.compositionOptions as ChannelAgentProductionCompositionOptions
    expect(composition.journal).toBeInstanceOf(ChannelAgentDispatchJournalStore)
    expect(composition.channels.getChannel(active.channelId)).toMatchObject({
      channelId: active.channelId,
      chatId: active.chatId
    })
    expect(composition.messages.getMessageById).toBeTypeOf('function')
    expect(composition.runtime.appendSignedAgentPost).toBeTypeOf('function')

    const handling = deferred<unknown>()
    doubles.handleDurableAppend.mockReturnValueOnce(handling.promise)
    const appended = await service.appendHost({
      channelId: active.channelId,
      clientMessageId: 'client-agent-production-stop-drain',
      content: 'A durable human record whose handoff is still pending.'
    })
    await vi.waitFor(() => expect(doubles.handleDurableAppend).toHaveBeenCalledOnce())
    expect(doubles.handleDurableAppend).toHaveBeenCalledWith(appended)

    let stopped = false
    const stopping = service.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(doubles.stop).not.toHaveBeenCalled()
    handling.resolve({ kind: 'ignored' })
    await stopping
    expect(doubles.stop).toHaveBeenCalledOnce()
    services.delete(service)
  })

  it('orders authority mutation, close, and explicit erasure around the agent queue', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    let now = 1_700_100_000_000
    const service = createService({
      userDataPath,
      identity,
      now: () => now,
      agentExecution: executionPorts()
    })
    service.start()
    const composition = doubles.compositionOptions as ChannelAgentProductionCompositionOptions
    const journal = composition.journal as ChannelAgentDispatchJournalStore
    const eraseChannel = vi.spyOn(journal, 'eraseChannel')
    const purgeAll = vi.spyOn(journal, 'purgeAll')
    const channel = service.createChannel({
      chatId: 'chat-agent-production-lifecycle',
      title: 'Agent production lifecycle',
      ownerDisplayName: 'Host'
    })

    const draining = deferred<void>()
    doubles.drainChannel.mockReturnValueOnce(draining.promise)
    let enrolled = false
    const enrollment = service
      .enrollAgent({
        channelId: channel.channelId,
        seat: {
          agentSeatId: 'pooled-agent-production-lifecycle',
          displayName: 'Lifecycle Agent'
        },
        operationId: 'enroll-agent-production-lifecycle'
      })
      .then((result) => {
        enrolled = true
        return result
      })
    await vi.waitFor(() => expect(doubles.drainChannel).toHaveBeenCalledWith(channel.channelId))
    expect(enrolled).toBe(false)
    expect(service.inspectChannelAgentSeats(channel.channelId)).toEqual([])
    draining.resolve(undefined)
    const enrolledAgent = await enrollment

    const owner = service.readChannel({ channelId: channel.channelId, resumeAfter: 0 }).members[0]
    await service.grantAgentDispatch({
      channelId: channel.channelId,
      agentSeatId: enrolledAgent.identity.agentSeatId,
      operationId: 'grant-agent-production-lifecycle',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: 'a'.repeat(64),
      permissionPostureHash: 'b'.repeat(64)
    })
    now += 1
    await service.rotateAgentKey({
      agentSeatId: enrolledAgent.identity.agentSeatId,
      operationId: 'rotate-agent-production-lifecycle'
    })
    now += 1
    await service.revokeAgent({
      channelId: channel.channelId,
      agentSeatId: enrolledAgent.identity.agentSeatId,
      operationId: 'revoke-agent-production-lifecycle'
    })
    expect(doubles.drainChannel.mock.calls.map(([channelId]) => channelId)).toEqual([
      channel.channelId,
      channel.channelId,
      channel.channelId,
      channel.channelId
    ])

    const quiescing = deferred<void>()
    doubles.quiesceChannel.mockReturnValueOnce(quiescing.promise)
    const closing = service.closeChannel(channel.channelId)
    expect(doubles.quiesceChannel).toHaveBeenCalledWith(channel.channelId)
    expect(service.listChannels()).toContainEqual(expect.objectContaining({ status: 'active' }))
    expect(eraseChannel).not.toHaveBeenCalled()
    quiescing.resolve(undefined)
    await expect(closing).resolves.toMatchObject({ status: 'closed' })
    expect(eraseChannel).not.toHaveBeenCalled()

    await expect(
      service.purgeForHistoryDeletionScope({
        kind: 'chat',
        chatIds: [channel.chatId]
      })
    ).resolves.toMatchObject({ purgedChannelIds: [channel.channelId] })
    expect(eraseChannel).toHaveBeenCalledWith(channel.channelId)
    await service.purgeForHistoryDeletionScope({ kind: 'global' })
    expect(purgeAll).toHaveBeenCalledOnce()
  })
})
