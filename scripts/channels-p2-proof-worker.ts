import { execFileSync } from 'child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  type KeyObject
} from 'crypto'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createRelayServer, type RelayServerHandle } from '../relay/src/server'
import {
  CHANNEL_IPC_CHANNELS,
  type ChannelIpcApi,
  type ChannelIpcChangeEvent,
  type ChannelIpcMessage
} from '../src/shared/collaboration/ChannelIpc'
import {
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcApi,
  type ChannelMemberIpcChangeEvent,
  type ChannelMemberIpcMessage
} from '../src/shared/collaboration/ChannelMemberIpc'
import { exportRawEd25519PublicKey } from '../src/shared/e2ee/keys'
import {
  createChannelMemberProductionBootstrap,
  type ChannelMemberProductionBootstrap
} from '../src/main/collaboration/ChannelMemberProductionBootstrap'
import { channelMemberReplicaPaths } from '../src/main/collaboration/ChannelMemberReplicaStore'
import {
  createChannelProductionBootstrap,
  type ChannelProductionAgentRuntimeOptions,
  type ChannelProductionBootstrap
} from '../src/main/collaboration/ChannelProductionBootstrap'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from '../src/main/collaboration/HumanCollaborationIdentityStore'
import type {
  TransportSocket,
  TransportSocketFactory
} from '../src/main/remote/RemoteTransportClient'
import { wsTransportSocketFactory } from '../src/main/remote/wsTransportSocket'
import { ChannelHostPanelController } from '../src/renderer/src/lib/channelHostPanelModel'
import { ChannelMemberPanelController } from '../src/renderer/src/lib/channelMemberPanelModel'

type WorkerRole = 'relay' | 'host' | 'member'

interface RequestMessage {
  type: 'request'
  id: string
  command: string
  params?: Record<string, unknown>
}

interface WireMetrics {
  maxFrameBytes: number
  encryptedFrames: number
  handshakeFrames: number
  agentRouteCalls: number
  plaintextApplicationFrames: number
}

type LocalHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown

const role = process.env.CHANNELS_P2_PROOF_ROLE as WorkerRole
const profilePath = resolve(process.env.CHANNELS_P2_PROOF_PROFILE || '.')
const relayUrl = process.env.CHANNELS_P2_PROOF_RELAY_URL || ''
const instanceId = process.env.TASKWRAITH_INSTANCE_ID || 'relay'
const metrics: WireMetrics = {
  maxFrameBytes: 0,
  encryptedFrames: 0,
  handshakeFrames: 0,
  agentRouteCalls: 0,
  plaintextApplicationFrames: 0
}

class LocalIpcRegistrar {
  private readonly handlers = new Map<string, LocalHandler>()
  private readonly event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent

  handle(channel: string, handler: LocalHandler): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate local IPC handler ${channel}`)
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  registrar(): Pick<IpcMain, 'handle' | 'removeHandler'> {
    return this as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`local IPC handler is missing: ${channel}`)
    return (await handler(this.event, ...args)) as T
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

class ProjectionEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>()

  emit(event: T): void {
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function send(message: Record<string, unknown>): void {
  process.send?.(message)
}

function boundedError(error: unknown): { code?: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    ...(typeof candidate?.code === 'string' ? { code: candidate.code.slice(0, 80) } : {}),
    message:
      typeof candidate?.message === 'string'
        ? candidate.message.replace(/\s+/g, ' ').trim().slice(0, 240)
        : 'worker command failed'
  }
}

function birthIdentity(): string {
  try {
    return execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return `pid-${process.pid}`
  }
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprint(publicKey: KeyObject): string {
  return hash(exportRawEd25519PublicKey(publicKey)).slice(0, 20)
}

function commonReady(): Record<string, unknown> {
  return {
    role,
    instanceId,
    userDataPath: profilePath,
    profileFingerprint: hash(profilePath).slice(0, 16),
    pid: process.pid,
    birthIdentity: birthIdentity()
  }
}

function proofSafeStorage(): HumanCollaborationSafeStorage {
  const keyPath = join(profilePath, 'proof-safe-storage.key')
  mkdirSync(profilePath, { recursive: true })
  const key = existsSync(keyPath) ? readFileSync(keyPath) : randomBytes(32)
  if (key.length !== 32) throw new Error('proof safe-storage key is invalid')
  if (!existsSync(keyPath)) writeFileSync(keyPath, key, { mode: 0o600 })
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString: (encrypted) => {
      if (encrypted.length < 30 || encrypted[0] !== 1) {
        throw new Error('proof safe-storage payload is invalid')
      }
      const nonce = encrypted.subarray(1, 13)
      const tag = encrypted.subarray(13, 29)
      const ciphertext = encrypted.subarray(29)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    }
  }
}

function proofAgentExecution(): ChannelProductionAgentRuntimeOptions {
  const rejectRoute = (): never => {
    metrics.agentRouteCalls += 1
    throw new Error('P2 compatibility mission reached an agent route')
  }
  return {
    composeMainOwnedChannelAgentRun: rejectRoute,
    dispatch: rejectRoute,
    subscribeRunEvents: rejectRoute,
    subscribeRunSessions: rejectRoute,
    claimRunAudience: rejectRoute,
    reconcileRun: rejectRoute
  } as unknown as ChannelProductionAgentRuntimeOptions
}

function instrumentSocketFactory(factory: TransportSocketFactory): TransportSocketFactory {
  return (url, headers, handlers) => {
    const socket = factory(url, headers, handlers)
    const wrapped: TransportSocket = {
      send: (data) => {
        const bytes = Buffer.byteLength(data, 'utf8')
        metrics.maxFrameBytes = Math.max(metrics.maxFrameBytes, bytes)
        try {
          const parsed = JSON.parse(data) as { t?: string; method?: string }
          if (parsed.t === 'channel.enc') metrics.encryptedFrames += 1
          else {
            metrics.handshakeFrames += 1
            if (
              parsed.t === 'channel.req' &&
              (parsed.method === 'channel.log.append' || parsed.method === 'channel.log.resume')
            ) {
              metrics.plaintextApplicationFrames += 1
            }
          }
        } catch {
          metrics.handshakeFrames += 1
        }
        socket.send(data)
      },
      close: () => socket.close()
    }
    return wrapped
  }
}

function recordManifest(
  records: readonly (ChannelIpcMessage | ChannelMemberIpcMessage)[]
): Array<Record<string, unknown>> {
  return records.map((record) => ({
    sequence: record.sequence,
    messageId: record.messageId,
    authorMemberId: record.authorMemberId,
    clientMessageId: record.clientMessageId,
    acceptedAt: record.acceptedAt,
    contentHash: record.contentHash
  }))
}

function manifestDigest(manifest: readonly Record<string, unknown>[]): string {
  return hash(JSON.stringify(manifest))
}

function hostApi(ipc: LocalIpcRegistrar, events: ProjectionEmitter<ChannelIpcChangeEvent>) {
  const api: ChannelIpcApi = {
    list: () => ipc.invoke(CHANNEL_IPC_CHANNELS.list),
    read: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.read, input),
    audit: (input) =>
      input === undefined
        ? ipc.invoke(CHANNEL_IPC_CHANNELS.audit)
        : ipc.invoke(CHANNEL_IPC_CHANNELS.audit, input),
    create: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.create, input),
    issueInvite: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.issueInvite, input),
    append: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.append, input),
    revokeMember: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.revokeMember, input),
    close: (input) => ipc.invoke(CHANNEL_IPC_CHANNELS.close, input),
    onChanged: (callback) => events.subscribe(callback)
  }
  return api
}

function memberApi(ipc: LocalIpcRegistrar, events: ProjectionEmitter<ChannelMemberIpcChangeEvent>) {
  const api: ChannelMemberIpcApi = {
    list: () => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.list),
    snapshot: () => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.snapshot),
    beginJoin: (input) => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.beginJoin, input),
    confirmJoin: () => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.confirmJoin),
    reconnect: (input) => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.reconnect, input),
    append: (input) => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.append, input),
    resume: () => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.resume),
    disconnect: () => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.disconnect),
    resetLocalHistory: (input) => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.resetLocalHistory, input),
    forget: (input) => ipc.invoke(CHANNEL_MEMBER_IPC_CHANNELS.forget, input),
    onChanged: (callback) => events.subscribe(callback)
  }
  return api
}

async function runRelay(): Promise<void> {
  const relay: RelayServerHandle = await createRelayServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatMs: 5_000,
    idleTtlMs: 60_000
  })
  send({ type: 'ready', ...commonReady(), relayPort: relay.port })
  installRpc(async (command) => {
    if (command === 'state') {
      return { roomCount: relay.roomCount(), registrationCount: relay.registrationCount() }
    }
    if (command === 'shutdown') {
      await relay.close()
      setTimeout(() => process.exit(0), 10)
      return { closed: true }
    }
    throw new Error(`unknown relay command ${command}`)
  })
}

async function runHost(): Promise<void> {
  const ipc = new LocalIpcRegistrar()
  const events = new ProjectionEmitter<ChannelIpcChangeEvent>()
  const safeStorage = proofSafeStorage()
  const identityStore = new HumanCollaborationIdentityStore(
    join(profilePath, 'human-collaboration-identity.json'),
    safeStorage
  )
  const chatId = 'channels-p2-proof-chat'
  const chat = { appChatId: chatId, title: 'Channels P2 proof', archived: false }
  const bootstrap: ChannelProductionBootstrap = createChannelProductionBootstrap({
    userDataPath: profilePath,
    loadIdentity: () => identityStore.load(),
    safeStorage,
    relay: {
      hostRelayUrl: () => relayUrl,
      inviteRelayUrls: () => [relayUrl]
    },
    ipc: ipc.registrar(),
    getChat: (candidate) => (candidate === chatId ? chat : null),
    isMainSender: () => true,
    getOwnedChatId: () => null,
    publishToMain: (event) => events.emit(event),
    publishToChat: () => undefined,
    agentManagement: {
      getSettings: () =>
        ({
          agenticServices: {
            shellCommands: 'ask',
            fileChanges: 'ask',
            mcpTools: 'ask',
            subThreadDelegation: 'ask',
            canvasInteraction: 'ask',
            canvasEval: 'ask',
            networkAccess: 'deny'
          },
          agenticWorkspaceGrants: []
        }) as never,
      providerAllowed: () => false,
      getWorkspaces: () => [],
      canonicalizePath: (value) => value,
      getOwnerWindow: () => null,
      confirm: async () => ({ confirmed: false })
    },
    agentExecution: proofAgentExecution(),
    socketFactory: instrumentSocketFactory(wsTransportSocketFactory)
  })
  bootstrap.start()
  const controller = new ChannelHostPanelController({
    api: hostApi(ipc, events),
    chatId,
    createClientMessageId: () => `host:proof-${randomUUID()}`,
    copyText: async () => undefined
  })
  await controller.start()

  const state = async (refresh = true): Promise<Record<string, unknown>> => {
    if (refresh) await controller.retry()
    const snapshot = controller.snapshot()
    const manifest = recordManifest(snapshot.records)
    return {
      channelId: snapshot.channel?.channelId ?? null,
      ownerMemberId: snapshot.channel?.ownerMemberId ?? null,
      status: snapshot.channel?.status ?? null,
      availability: snapshot.channel?.availability ?? null,
      members: snapshot.members.map((member) => ({
        memberId: member.memberId,
        displayName: member.displayName,
        status: member.status
      })),
      pendingAdmissions: snapshot.pendingAdmissions.map((admission) => ({
        memberId: admission.memberId,
        displayName: admission.displayName,
        confirmCode: admission.confirmCode,
        expiresAt: admission.expiresAt
      })),
      highWaterSequence: snapshot.highWaterSequence,
      manifest,
      digest: manifestDigest(manifest),
      notice: snapshot.notice,
      error: snapshot.error,
      wireMetrics: { ...metrics }
    }
  }

  send({
    type: 'ready',
    ...commonReady(),
    identityFingerprint: fingerprint(identityStore.load().publicKey),
    handlerChannels: ipc.channels(),
    serviceState: bootstrap.service.status().state
  })

  installRpc(async (command, params) => {
    if (command === 'create') {
      const accepted = await controller.create(String(params.ownerDisplayName || 'Host'))
      if (!accepted) throw new Error(controller.snapshot().error || 'host create failed')
      return state(false)
    }
    if (command === 'issueInvite') {
      const accepted = await controller.issueInvite()
      const invite = controller.snapshot().invite
      if (!accepted || !invite) throw new Error(controller.snapshot().error || 'invite failed')
      return {
        payload: invite.payload,
        expiresAt: invite.expiresAt,
        hostRoomOpened: invite.hostRoomOpened
      }
    }
    if (command === 'append') {
      const accepted = await controller.append(String(params.content))
      return { accepted, state: await state(false) }
    }
    if (command === 'revoke') {
      const accepted = await controller.revokeMember(String(params.memberId))
      return { accepted, state: await state(false) }
    }
    if (command === 'close') {
      const accepted = await controller.close()
      return { accepted, state: await state(false) }
    }
    if (command === 'state') return state(params.refresh !== false)
    if (command === 'catalogue') return { channels: ipc.channels() }
    if (command === 'shutdown') {
      controller.dispose()
      await bootstrap.stop()
      setTimeout(() => process.exit(0), 10)
      return { closed: true }
    }
    throw new Error(`unknown host command ${command}`)
  })
}

async function runMember(): Promise<void> {
  const ipc = new LocalIpcRegistrar()
  const events = new ProjectionEmitter<ChannelMemberIpcChangeEvent>()
  const safeStorage = proofSafeStorage()
  const bootstrap: ChannelMemberProductionBootstrap = createChannelMemberProductionBootstrap({
    userDataPath: profilePath,
    safeStorage,
    ipc: ipc.registrar(),
    assertMainRendererSender: () => undefined,
    publishToMain: (event) => events.emit(event),
    socketFactory: instrumentSocketFactory(wsTransportSocketFactory)
  })
  bootstrap.start()
  const controller = new ChannelMemberPanelController({
    api: memberApi(ipc, events),
    createClientMessageId: () => `member:proof-${randomUUID()}`
  })
  await controller.start()

  const identityFingerprint = (): string | null => {
    const identityPath = channelMemberReplicaPaths(profilePath).identity
    if (!existsSync(identityPath)) return null
    return fingerprint(
      new HumanCollaborationIdentityStore(identityPath, safeStorage).load().publicKey
    )
  }

  const state = async (refresh = true): Promise<Record<string, unknown>> => {
    if (refresh) await controller.refresh()
    const snapshot = controller.snapshot()
    const manifest = recordManifest(snapshot.records)
    return {
      phase: snapshot.phase,
      connected: snapshot.connected,
      channelId: snapshot.channel?.channelId ?? null,
      memberId: snapshot.channel?.memberId ?? null,
      channelStatus: snapshot.channel?.status ?? null,
      memberships: snapshot.memberships.map((membership) => ({
        channelId: membership.channelId,
        memberId: membership.memberId,
        status: membership.status,
        active: membership.active
      })),
      highWaterSequence: snapshot.highWaterSequence,
      manifest,
      digest: manifestDigest(manifest),
      confirmCode: snapshot.confirmCode,
      notice: snapshot.notice,
      error: snapshot.error,
      identityFingerprint: identityFingerprint(),
      wireMetrics: { ...metrics }
    }
  }

  send({
    type: 'ready',
    ...commonReady(),
    identityFingerprint: identityFingerprint(),
    recoveredHighWaterSequence: controller.snapshot().highWaterSequence,
    recoveredChannelStatus: controller.snapshot().channel?.status ?? null,
    handlerChannels: ipc.channels()
  })

  installRpc(async (command, params) => {
    if (command === 'beginJoin') {
      const accepted = await controller.beginJoin(
        String(params.inviteText),
        String(params.displayName || 'Member')
      )
      return { accepted, state: await state(false) }
    }
    if (command === 'confirmJoin') {
      const accepted = await controller.confirmJoin()
      return { accepted, state: await state(false) }
    }
    if (command === 'append') {
      const accepted = await controller.append(String(params.content))
      return { accepted, state: await state(false) }
    }
    if (command === 'disconnect') {
      const accepted = await controller.disconnect()
      return { accepted, state: await state(false) }
    }
    if (command === 'reconnect') {
      const channelId = typeof params.channelId === 'string' ? params.channelId : undefined
      const accepted = await controller.reconnect(channelId)
      return { accepted, state: await state(false) }
    }
    if (command === 'resume') {
      const accepted = await controller.resume()
      return { accepted, state: await state(false) }
    }
    if (command === 'state') return state(params.refresh !== false)
    if (command === 'catalogue') return { channels: ipc.channels() }
    if (command === 'shutdown') {
      controller.dispose()
      await bootstrap.stop()
      setTimeout(() => process.exit(0), 10)
      return { closed: true }
    }
    throw new Error(`unknown member command ${command}`)
  })
}

function installRpc(
  handler: (command: string, params: Record<string, unknown>) => Promise<unknown> | unknown
): void {
  process.on('message', (message: RequestMessage) => {
    if (!message || message.type !== 'request' || typeof message.id !== 'string') return
    void Promise.resolve(handler(message.command, message.params ?? {}))
      .then((result) => send({ type: 'response', id: message.id, ok: true, result }))
      .catch((error) =>
        send({ type: 'response', id: message.id, ok: false, error: boundedError(error) })
      )
  })
}

async function main(): Promise<void> {
  mkdirSync(profilePath, { recursive: true })
  if (role === 'relay') await runRelay()
  else if (role === 'host') await runHost()
  else if (role === 'member') await runMember()
  else throw new Error('CHANNELS_P2_PROOF_ROLE is invalid')
}

void main().catch((error) => {
  send({ type: 'fatal', error: boundedError(error), ...commonReady() })
  process.exitCode = 1
})
