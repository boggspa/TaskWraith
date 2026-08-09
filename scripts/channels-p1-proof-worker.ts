import { createHash, createPublicKey, randomUUID, type KeyObject } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createRelayServer, type RelayServerHandle } from '../relay/src/server'
import {
  exportPrivateKeyDer,
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  importEd25519PrivateKeyDer,
  type KeyPair
} from '../src/shared/e2ee/keys'
import type {
  TransportSocket,
  TransportSocketFactory
} from '../src/main/remote/RemoteTransportClient'
import { wsTransportSocketFactory } from '../src/main/remote/wsTransportSocket'
import { ChannelHostTransport } from '../src/main/collaboration/ChannelHostTransport'
import { ChannelMemberClient } from '../src/main/collaboration/ChannelMemberClient'
import { ChannelMessageLog, type ChannelMessage } from '../src/main/collaboration/ChannelMessageLog'
import { ChannelRuntime } from '../src/main/collaboration/ChannelRuntime'
import { ChannelStore } from '../src/main/collaboration/ChannelStore'

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
  plaintextApplicationFrames: number
}

const role = process.env.CHANNELS_PROOF_ROLE as WorkerRole
const profilePath = resolve(process.env.CHANNELS_PROOF_PROFILE || '.')
const relayUrl = process.env.CHANNELS_PROOF_RELAY_URL || ''
const instanceId = process.env.TASKWRAITH_INSTANCE_ID || 'relay'
const metrics: WireMetrics = {
  maxFrameBytes: 0,
  encryptedFrames: 0,
  handshakeFrames: 0,
  plaintextApplicationFrames: 0
}

function send(message: Record<string, unknown>): void {
  process.send?.(message)
}

function event(name: string, payload: Record<string, unknown> = {}): void {
  send({ type: 'event', event: name, ...payload })
}

function boundedError(error: unknown): { code?: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    ...(typeof candidate?.code === 'string' ? { code: candidate.code.slice(0, 80) } : {}),
    message:
      typeof candidate?.message === 'string'
        ? candidate.message.slice(0, 240)
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

function fingerprint(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(exportRawEd25519PublicKey(publicKey))
    .digest('hex')
    .slice(0, 20)
}

function loadIdentity(path: string): KeyPair {
  mkdirSync(profilePath, { recursive: true })
  if (existsSync(path)) {
    const privateKey = importEd25519PrivateKeyDer(readFileSync(path))
    return { privateKey, publicKey: createPublicKey(privateKey) }
  }
  const identity = generateIdentityKeyPair()
  writeFileSync(path, exportPrivateKeyDer(identity.privateKey), { mode: 0o600 })
  return identity
}

function instrumentSocketFactory(factory: TransportSocketFactory): TransportSocketFactory {
  return (url, headers, handlers) => {
    const socket = factory(url, headers, handlers)
    const wrapped: TransportSocket = {
      send: (data) => {
        const bytes = Buffer.byteLength(data, 'utf8')
        metrics.maxFrameBytes = Math.max(metrics.maxFrameBytes, bytes)
        try {
          const parsed = JSON.parse(data) as {
            t?: string
            method?: string
          }
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
          // Parser rejection is exercised separately; metrics stay conservative.
        }
        socket.send(data)
      },
      close: () => socket.close()
    }
    return wrapped
  }
}

function manifest(records: ChannelMessage[]): Array<Record<string, unknown>> {
  return records.map((record) => ({
    sequence: record.sequence,
    messageId: record.messageId,
    authorMemberId: record.authorMemberId,
    clientMessageId: record.clientMessageId,
    acceptedAt: record.acceptedAt,
    contentHash: record.contentHash
  }))
}

function recordSummary(record: ChannelMessage): Record<string, unknown> {
  return manifest([record])[0]!
}

function commonReady(): Record<string, unknown> {
  return {
    role,
    instanceId,
    userDataPath: profilePath,
    pid: process.pid,
    birthIdentity: birthIdentity()
  }
}

async function runRelay(): Promise<void> {
  const relay: RelayServerHandle = await createRelayServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatMs: 5_000,
    idleTtlMs: 60_000
  })
  send({
    type: 'ready',
    ...commonReady(),
    relayPort: relay.port
  })
  installRpc(async (command) => {
    if (command === 'state') {
      return {
        roomCount: relay.roomCount(),
        registrationCount: relay.registrationCount()
      }
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
  const identity = loadIdentity(join(profilePath, 'identity.pk8'))
  const store = new ChannelStore(join(profilePath, 'channels.json'))
  const log = new ChannelMessageLog(join(profilePath, 'channel-logs'), store)
  const replayBatches: Array<Record<string, unknown>> = []
  let crashAfterDurable = false
  const runtime = new ChannelRuntime({
    identityKeyPair: identity,
    store,
    log,
    onAdmissionBegan: (info) =>
      event('admission.began', {
        handshakeId: info.handshakeId,
        channelId: info.channelId,
        memberId: info.memberId,
        displayName: info.displayName,
        confirmCode: info.confirmCode,
        mode: info.mode
      }),
    onReplayBatch: (info) => {
      replayBatches.push({
        memberId: info.memberId,
        recordCount: info.recordCount,
        serializedBytes: info.serializedBytes,
        highWaterSequence: info.highWaterSequence,
        live: info.live
      })
    },
    afterDurableCommit: async (result) => {
      if (!crashAfterDurable || result.deduplicated) return
      crashAfterDurable = false
      event('fault.durable', { record: recordSummary(result.record) })
      await new Promise<void>(() => {
        const timer = setTimeout(() => process.exit(86), 20)
        timer.unref?.()
      })
    }
  })
  for (const channel of store.listChannels()) {
    log.highWaterSequence(channel.channelId)
  }
  const transport = new ChannelHostTransport({
    socketFactory: instrumentSocketFactory(wsTransportSocketFactory),
    runtime,
    reconnectBaseMs: 50,
    reconnectMaxMs: 500
  })
  if (relayUrl) transport.restoreRooms(() => relayUrl)
  send({
    type: 'ready',
    ...commonReady(),
    identityFingerprint: fingerprint(identity.publicKey),
    hostIdentityPubKeyB64: runtime.hostIdentityPublicKey(),
    recoveredChannels: store.listChannels().length
  })

  installRpc(async (command, params) => {
    if (command === 'create') {
      const created = runtime.createChannel({
        chatId: String(params.chatId),
        title: String(params.title),
        ownerDisplayName: String(params.ownerDisplayName)
      })
      return {
        channelId: created.channel.channelId,
        ownerMemberId: created.owner.memberId
      }
    }
    if (command === 'invite') {
      const issued = runtime.createInvite({
        channelId: String(params.channelId),
        ttlMs: Number(params.ttlMs ?? 600_000)
      })
      transport.openRoom(String(params.channelId), issued.invite.roomId, relayUrl)
      return {
        inviteId: issued.invite.inviteId,
        inviteToken: issued.inviteToken,
        roomId: issued.invite.roomId,
        expiresAt: issued.invite.expiresAt
      }
    }
    if (command === 'append') {
      const result = await runtime.appendHost(String(params.channelId), {
        clientMessageId: String(params.clientMessageId),
        content: String(params.content)
      })
      return {
        deduplicated: result.deduplicated,
        record: recordSummary(result.record)
      }
    }
    if (command === 'appendBulk') {
      const count = Number(params.count)
      const contentBytes = Number(params.contentBytes)
      const prefix = String(params.prefix)
      let first: Record<string, unknown> | undefined
      let last: Record<string, unknown> | undefined
      for (let index = 0; index < count; index += 1) {
        const label = `${String(index).padStart(4, '0')}:`
        const result = await runtime.appendHost(String(params.channelId), {
          clientMessageId: `${prefix}-${index}`,
          content: `${label}${'x'.repeat(Math.max(1, contentBytes - label.length))}`
        })
        const summary = recordSummary(result.record)
        first ??= summary
        last = summary
      }
      return { count, first, last }
    }
    if (command === 'armCrash') {
      crashAfterDurable = true
      return { armed: true }
    }
    if (command === 'revoke') {
      const member = await runtime.revokeMember({
        channelId: String(params.channelId),
        memberId: String(params.memberId)
      })
      return { memberId: member.memberId, status: member.status }
    }
    if (command === 'probeMemberSession') {
      const member = store.getMember(String(params.channelId), String(params.memberId))
      if (!member?.roomId) throw new Error('member room missing')
      store.validateMemberSession({
        channelId: String(params.channelId),
        memberId: member.memberId,
        identityPublicKey: member.identityPublicKey,
        roomId: member.roomId
      })
      return { active: true }
    }
    if (command === 'clearReplayBatches') {
      replayBatches.length = 0
      return { cleared: true }
    }
    if (command === 'state') {
      const channelId = String(params.channelId || store.listChannels()[0]?.channelId || '')
      const records =
        channelId && store.getChannel(channelId)
          ? Array.from(
              { length: log.highWaterSequence(channelId) },
              (_, index) => log.getMessage(channelId, index + 1)!
            )
          : []
      return {
        channelId,
        highWaterSequence: records.length,
        digest: channelId ? log.digest(channelId) : '',
        manifest: manifest(records),
        members: channelId
          ? store.listMembers(channelId).map((member) => ({
              memberId: member.memberId,
              status: member.status,
              kind: member.kind
            }))
          : [],
        roomBindings: runtime.listRoomBindings().map((binding) => ({
          memberId: binding.memberId,
          roomFingerprint: createHash('sha256').update(binding.roomId).digest('hex').slice(0, 12)
        })),
        replayBatches: [...replayBatches],
        wireMetrics: { ...metrics }
      }
    }
    if (command === 'shutdown') {
      transport.dispose()
      runtime.dispose()
      setTimeout(() => process.exit(0), 10)
      return { closed: true }
    }
    throw new Error(`unknown host command ${command}`)
  })
}

async function runMember(): Promise<void> {
  const identity = loadIdentity(join(profilePath, 'identity.pk8'))
  const statePath = join(profilePath, 'member-state.json')
  const ignoreState = process.env.CHANNELS_PROOF_IGNORE_STATE === '1'
  let initialRecords: ChannelMessage[] = []
  if (!ignoreState && existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
        records?: ChannelMessage[]
      }
      if (Array.isArray(parsed.records)) initialRecords = parsed.records
    } catch {
      initialRecords = []
    }
  }
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const errors: string[] = []
  const replayBatches: Array<Record<string, unknown>> = []
  const appendResults: Array<Record<string, unknown>> = []
  let revokedCount = 0
  let connected = false
  const client = new ChannelMemberClient({
    socketFactory: instrumentSocketFactory(wsTransportSocketFactory),
    identity,
    initialRecords,
    onRecords: (records, info) => {
      replayBatches.push({
        recordCount: records.length,
        highWaterSequence: info.highWaterSequence,
        live: info.live
      })
      schedulePersist()
    },
    onAppendResult: (value) => {
      const result = value as {
        deduplicated?: boolean
        record?: ChannelMessage
      }
      appendResults.push({
        deduplicated: result.deduplicated === true,
        ...(result.record ? { record: recordSummary(result.record) } : {})
      })
    },
    onRevoked: () => {
      revokedCount += 1
      schedulePersist()
    },
    onConnectionChange: (value) => {
      connected = value
    },
    onError: (error) => {
      errors.push(error.message.slice(0, 240))
      if (errors.length > 20) errors.shift()
    },
    requestTimeoutMs: 10_000
  })

  function persistNow(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = null
    const temporary = `${statePath}.${randomUUID()}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({
        cursor: client.highWaterSequence,
        records: client.records(),
        pinnedHostIdentity: client.hostIdentityPublicKey()
      }),
      { encoding: 'utf8', mode: 0o600 }
    )
    renameSync(temporary, statePath)
  }

  function schedulePersist(): void {
    if (persistTimer) return
    persistTimer = setTimeout(persistNow, 100)
    persistTimer.unref?.()
  }

  send({
    type: 'ready',
    ...commonReady(),
    identityFingerprint: fingerprint(identity.publicKey),
    recoveredCursor: client.highWaterSequence
  })

  installRpc(async (command, params) => {
    if (command === 'connect') {
      client.connect(String(params.relayUrl), String(params.roomId))
      await client.whenConnected()
      return { connected: true }
    }
    if (command === 'beginAdmission') {
      return client.beginAdmission({
        channelId: String(params.channelId),
        inviteId: String(params.inviteId),
        inviteToken: String(params.inviteToken),
        displayName: String(params.displayName),
        expectedHostIdentityPubKeyB64:
          typeof params.expectedHostIdentityPubKeyB64 === 'string'
            ? params.expectedHostIdentityPubKeyB64
            : undefined
      })
    }
    if (command === 'confirmAdmission') {
      const result = await client.confirmAdmission()
      persistNow()
      return result
    }
    if (command === 'reconnect') {
      const result = await client.reconnect({
        channelId: String(params.channelId),
        memberId: String(params.memberId),
        expectedHostIdentityPubKeyB64: String(params.expectedHostIdentityPubKeyB64)
      })
      persistNow()
      return result
    }
    if (command === 'resume') {
      const result = await client.resume({
        ...(params.resumeAfter === undefined ? {} : { resumeAfter: Number(params.resumeAfter) })
      })
      persistNow()
      return result
    }
    if (command === 'append') {
      const result = await client.append(String(params.content), String(params.clientMessageId))
      return {
        accepted: result.accepted,
        deduplicated: result.deduplicated,
        record: recordSummary(result.record)
      }
    }
    if (command === 'appendFire') {
      void client
        .append(String(params.content), String(params.clientMessageId))
        .then((result) =>
          event('append.completed', {
            clientMessageId: String(params.clientMessageId),
            deduplicated: result.deduplicated,
            record: recordSummary(result.record)
          })
        )
        .catch((error) =>
          event('append.failed', {
            clientMessageId: String(params.clientMessageId),
            error: boundedError(error)
          })
        )
      return { sent: true }
    }
    if (command === 'state') {
      persistNow()
      const records = client.records()
      return {
        cursor: client.highWaterSequence,
        digest: client.digest(),
        manifest: manifest(records),
        recordCount: records.length,
        connected,
        established: client.isEstablished,
        revokedCount,
        errors: [...errors],
        replayBatches: [...replayBatches],
        appendResults: [...appendResults],
        wireMetrics: { ...metrics }
      }
    }
    if (command === 'shutdown') {
      persistNow()
      client.dispose()
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
        send({
          type: 'response',
          id: message.id,
          ok: false,
          error: boundedError(error)
        })
      )
  })
}

async function main(): Promise<void> {
  mkdirSync(profilePath, { recursive: true })
  if (role === 'relay') await runRelay()
  else if (role === 'host') await runHost()
  else if (role === 'member') await runMember()
  else throw new Error('CHANNELS_PROOF_ROLE is invalid')
}

void main().catch((error) => {
  send({ type: 'fatal', error: boundedError(error), ...commonReady() })
  process.exitCode = 1
})
