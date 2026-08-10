import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  importRawEd25519PublicKey,
  importRawX25519PublicKey,
  signEd25519,
  verifyEd25519,
  type KeyPair
} from '../../shared/e2ee/keys'
import { openChannelFrame, sealChannelMessage } from '../../shared/collaboration/ChannelCipher'
import { verifyChannelAgentMessageProof } from '../../shared/collaboration/ChannelAgentMessageProof'
import {
  channelConfirmCode,
  computeChannelTranscriptHash,
  deriveChannelSessionKeys,
  type ChannelSessionKeys
} from '../../shared/collaboration/ChannelKeySchedule'
import {
  CHANNEL_WIRE_PROTOCOL,
  makeChannelRequest,
  parseChannelWireMessage,
  type ChannelEncryptedFrame,
  type ChannelHandshakeBeginResult,
  type ChannelHandshakeConfirmResult,
  type ChannelHandshakeContext,
  type ChannelWireEvent
} from '../../shared/collaboration/ChannelWireProtocol'
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import type { ChannelMessage } from './ChannelMessageLog'

export class ChannelRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ChannelRemoteError'
  }
}

export interface ChannelMemberClientOptions {
  socketFactory: TransportSocketFactory
  identity?: KeyPair
  initialRecords?: ChannelMessage[]
  initialCursor?: number
  onSasCode?: (code: string) => void
  onEstablished?: (result: ChannelHandshakeConfirmResult) => void
  onMembersSnapshot?: (snapshot: unknown) => void
  onRecords?: (
    records: ChannelMessage[],
    info: { highWaterSequence: number; live: boolean }
  ) => void
  onAppendResult?: (result: unknown) => void
  onRevoked?: (event: unknown) => void
  onCursor?: (cursor: number) => void
  onConnectionChange?: (connected: boolean) => void
  onError?: (error: Error) => void
  requestTimeoutMs?: number
}

export interface ChannelAdmissionInput {
  channelId: string
  inviteId: string
  inviteToken: string
  displayName: string
  expectedHostIdentityPubKeyB64?: string
}

export interface ChannelReconnectInput {
  channelId: string
  memberId: string
  expectedHostIdentityPubKeyB64: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingConfirmation {
  handshakeId: string
  confirmCode: string
  memberTranscriptSigB64: string
  keys: ChannelSessionKeys
  hostIdentityPubKeyB64: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseChannelMessage(value: unknown, ownerPublicKeyB64: string): ChannelMessage | null {
  const message = asObject(value)
  if (
    !message ||
    typeof message.channelId !== 'string' ||
    !Number.isInteger(message.sequence) ||
    (message.sequence as number) < 1 ||
    typeof message.messageId !== 'string' ||
    typeof message.authorMemberId !== 'string' ||
    typeof message.clientMessageId !== 'string' ||
    (message.kind !== 'human.text' && message.kind !== 'agent.text') ||
    typeof message.content !== 'string' ||
    typeof message.acceptedAt !== 'number' ||
    typeof message.contentHash !== 'string'
  ) {
    return null
  }
  const prefix = {
    channelId: message.channelId,
    sequence: message.sequence as number,
    messageId: message.messageId,
    authorMemberId: message.authorMemberId,
    clientMessageId: message.clientMessageId
  }
  const suffix = {
    content: message.content,
    acceptedAt: message.acceptedAt,
    contentHash: message.contentHash
  }
  if (message.kind === 'human.text') {
    return message.agentProof === undefined ? { ...prefix, kind: 'human.text', ...suffix } : null
  }
  const verified = verifyChannelAgentMessageProof({
    ownerPublicKeyB64,
    proof: message.agentProof,
    acceptedAt: message.acceptedAt
  })
  if (!verified.ok) return null
  const post = verified.value.signedPost.post
  if (
    post.channelId !== message.channelId ||
    post.agentMemberId !== message.authorMemberId ||
    post.clientMessageId !== message.clientMessageId ||
    post.content !== message.content ||
    post.contentHash !== message.contentHash
  ) {
    return null
  }
  return { ...prefix, kind: 'agent.text', ...suffix, agentProof: verified.value }
}

export class ChannelMemberClient {
  private readonly opts: ChannelMemberClientOptions
  private readonly identity: KeyPair
  private socket: TransportSocket | null = null
  private roomId = ''
  private connected = false
  private disposed = false
  private sessionId = ''
  private sessionKeys: ChannelSessionKeys | null = null
  private pendingConfirmation: PendingConfirmation | null = null
  private pinnedHostIdentityPubKeyB64 = ''
  private nextOutboundSeq = 1
  private lastInboundSeq = 0
  private channelId = ''
  private cursor: number
  private readonly applied = new Map<number, ChannelMessage>()
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private connectWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(options: ChannelMemberClientOptions) {
    this.opts = options
    this.identity = options.identity ?? generateIdentityKeyPair()
    const initial = [...(options.initialRecords ?? [])].sort(
      (left, right) => left.sequence - right.sequence
    )
    for (const record of initial) this.applied.set(record.sequence, record)
    this.cursor = options.initialCursor ?? initial.at(-1)?.sequence ?? 0
  }

  identityPublicKey(): string {
    return b64.encode(exportRawEd25519PublicKey(this.identity.publicKey))
  }

  hostIdentityPublicKey(): string {
    return this.pinnedHostIdentityPubKeyB64
  }

  get isConnected(): boolean {
    return this.connected
  }

  get isEstablished(): boolean {
    return Boolean(this.sessionKeys && this.sessionId)
  }

  get highWaterSequence(): number {
    return this.cursor
  }

  records(): ChannelMessage[] {
    return [...this.applied.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => JSON.parse(JSON.stringify(record)) as ChannelMessage)
  }

  digest(): string {
    return createHash('sha256').update(JSON.stringify(this.records()), 'utf8').digest('hex')
  }

  connect(relayUrl: string, roomId: string): void {
    if (this.disposed) return
    this.roomId = roomId
    const url = `${relayUrl.replace(/\/$/, '')}/v1/session/${roomId}`
    this.socket = this.opts.socketFactory(
      url,
      {
        'x-taskwraith-role': 'iphone',
        'x-taskwraith-protocol': CHANNEL_WIRE_PROTOCOL
      },
      {
        onOpen: () => this.setConnected(true),
        onMessage: (data) => this.handleInbound(data),
        onClose: () => {
          this.setConnected(false)
          this.clearSession()
          const error = new Error('Channel transport disconnected')
          this.settleConnectWaiters(error)
          this.rejectPending(error)
        },
        onError: (error) => this.opts.onError?.(error)
      }
    )
  }

  whenConnected(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((candidate) => candidate.timer !== timer)
        reject(new Error('Channel connection timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.connectWaiters.push({ resolve, reject, timer })
    })
  }

  async beginAdmission(input: ChannelAdmissionInput): Promise<{ confirmCode: string }> {
    this.requireConnected()
    const ephemeral = generateEphemeralKeyPair()
    const memberNonce = randomBytes(16)
    const memberIdentityPubKeyB64 = this.identityPublicKey()
    const memberEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(ephemeral.publicKey))
    const memberNonceB64 = b64.encode(memberNonce)
    const begin = (await this.sendPlainRequest('channel.admission.begin', {
      channelId: input.channelId,
      inviteId: input.inviteId,
      inviteToken: input.inviteToken,
      roomId: this.roomId,
      displayName: input.displayName,
      memberIdentityPubKeyB64,
      memberEphemeralPubKeyB64,
      memberNonceB64
    })) as ChannelHandshakeBeginResult
    if (
      begin.protocol !== CHANNEL_WIRE_PROTOCOL ||
      begin.mode !== 'admission' ||
      begin.channelId !== input.channelId ||
      begin.inviteId !== input.inviteId ||
      begin.roomId !== this.roomId
    ) {
      throw new Error('Channel admission response did not match the request')
    }
    const context: ChannelHandshakeContext = {
      protocol: CHANNEL_WIRE_PROTOCOL,
      mode: 'admission',
      channelId: input.channelId,
      chatId: begin.chatId,
      inviteId: input.inviteId,
      inviteTokenHash: createHash('sha256').update(input.inviteToken, 'utf8').digest('hex'),
      inviteExpiresAt: begin.inviteExpiresAt,
      memberId: begin.memberId,
      roomId: this.roomId,
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      memberIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      memberEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      memberNonceB64
    }
    this.prepareConfirmation({
      begin,
      context,
      ephemeral,
      memberNonce,
      expectedHostIdentityPubKeyB64: input.expectedHostIdentityPubKeyB64
    })
    this.opts.onSasCode?.(this.pendingConfirmation!.confirmCode)
    return { confirmCode: this.pendingConfirmation!.confirmCode }
  }

  async confirmAdmission(): Promise<ChannelHandshakeConfirmResult> {
    const pending = this.pendingConfirmation
    if (!pending) throw new Error('No pending Channel admission')
    const result = (await this.sendPlainRequest('channel.admission.confirm', {
      handshakeId: pending.handshakeId,
      confirmCode: pending.confirmCode,
      memberTranscriptSigB64: pending.memberTranscriptSigB64
    })) as ChannelHandshakeConfirmResult
    this.establish(result, pending)
    return result
  }

  async admit(input: ChannelAdmissionInput): Promise<ChannelHandshakeConfirmResult> {
    await this.beginAdmission(input)
    return this.confirmAdmission()
  }

  async reconnect(input: ChannelReconnectInput): Promise<ChannelHandshakeConfirmResult> {
    if (!input.expectedHostIdentityPubKeyB64) {
      throw new Error('Pinned host identity is required for Channel reconnect')
    }
    this.requireConnected()
    const ephemeral = generateEphemeralKeyPair()
    const memberNonce = randomBytes(16)
    const memberIdentityPubKeyB64 = this.identityPublicKey()
    const memberEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(ephemeral.publicKey))
    const memberNonceB64 = b64.encode(memberNonce)
    const begin = (await this.sendPlainRequest('channel.reconnect', {
      channelId: input.channelId,
      memberId: input.memberId,
      roomId: this.roomId,
      memberIdentityPubKeyB64,
      memberEphemeralPubKeyB64,
      memberNonceB64
    })) as ChannelHandshakeBeginResult
    if (
      begin.protocol !== CHANNEL_WIRE_PROTOCOL ||
      begin.mode !== 'reconnect' ||
      begin.channelId !== input.channelId ||
      begin.memberId !== input.memberId ||
      begin.roomId !== this.roomId
    ) {
      throw new Error('Channel reconnect response did not match the pinned member')
    }
    const context: ChannelHandshakeContext = {
      protocol: CHANNEL_WIRE_PROTOCOL,
      mode: 'reconnect',
      channelId: input.channelId,
      chatId: begin.chatId,
      inviteId: `pinned:${input.memberId}`,
      inviteTokenHash: `pinned:${memberIdentityPubKeyB64}`,
      inviteExpiresAt: begin.inviteExpiresAt,
      memberId: input.memberId,
      roomId: this.roomId,
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      memberIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      memberEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      memberNonceB64
    }
    this.prepareConfirmation({
      begin,
      context,
      ephemeral,
      memberNonce,
      expectedHostIdentityPubKeyB64: input.expectedHostIdentityPubKeyB64
    })
    const pending = this.pendingConfirmation!
    const result = (await this.sendPlainRequest('channel.admission.confirm', {
      handshakeId: pending.handshakeId,
      confirmCode: pending.confirmCode,
      memberTranscriptSigB64: pending.memberTranscriptSigB64
    })) as ChannelHandshakeConfirmResult
    this.establish(result, pending)
    return result
  }

  append(
    content: string,
    clientMessageId: string = randomUUID()
  ): Promise<{ accepted: true; deduplicated: boolean; record: ChannelMessage }> {
    return this.sendEncryptedRequest('channel.log.append', {
      clientMessageId,
      content
    }) as Promise<{ accepted: true; deduplicated: boolean; record: ChannelMessage }>
  }

  resume(args?: {
    resumeAfter?: number
    maxRecords?: number
    maxBytes?: number
  }): Promise<{ highWaterSequence: number }> {
    return this.sendEncryptedRequest('channel.log.resume', {
      resumeAfter: args?.resumeAfter ?? this.cursor,
      ...(args?.maxRecords === undefined ? {} : { maxRecords: args.maxRecords }),
      ...(args?.maxBytes === undefined ? {} : { maxBytes: args.maxBytes })
    }) as Promise<{ highWaterSequence: number }>
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('Channel client disposed')
    this.settleConnectWaiters(error)
    this.rejectPending(error)
    this.socket?.close()
    this.socket = null
    this.setConnected(false)
    this.clearSession()
  }

  private prepareConfirmation(args: {
    begin: ChannelHandshakeBeginResult
    context: ChannelHandshakeContext
    ephemeral: KeyPair
    memberNonce: Buffer
    expectedHostIdentityPubKeyB64?: string
  }): void {
    const transcriptHash = computeChannelTranscriptHash(args.context)
    if (!transcriptHash.equals(b64.decode(args.begin.transcriptHashB64))) {
      throw new Error('Channel handshake transcript mismatch')
    }
    if (
      args.expectedHostIdentityPubKeyB64 &&
      args.expectedHostIdentityPubKeyB64 !== args.begin.hostIdentityPubKeyB64
    ) {
      throw new Error('Channel host identity does not match the pinned key')
    }
    if (
      !verifyEd25519(
        importRawEd25519PublicKey(b64.decode(args.begin.hostIdentityPubKeyB64)),
        transcriptHash,
        b64.decode(args.begin.hostTranscriptSigB64)
      )
    ) {
      throw new Error('Channel host transcript signature is invalid')
    }
    const confirmCode = channelConfirmCode(args.context)
    if (confirmCode !== args.begin.confirmCode) {
      throw new Error('Channel SAS did not match the signed transcript')
    }
    this.pendingConfirmation = {
      handshakeId: args.begin.handshakeId,
      confirmCode,
      memberTranscriptSigB64: b64.encode(signEd25519(this.identity.privateKey, transcriptHash)),
      keys: deriveChannelSessionKeys({
        localEphemeralPrivate: args.ephemeral.privateKey,
        peerEphemeralPublic: importRawX25519PublicKey(
          b64.decode(args.begin.hostEphemeralPubKeyB64)
        ),
        hostNonce: b64.decode(args.begin.hostNonceB64),
        memberNonce: args.memberNonce
      }),
      hostIdentityPubKeyB64: args.begin.hostIdentityPubKeyB64
    }
  }

  private establish(result: ChannelHandshakeConfirmResult, pending: PendingConfirmation): void {
    if (
      result.hostIdentityPubKeyB64 !== pending.hostIdentityPubKeyB64 ||
      !result.sessionId ||
      !result.channelId ||
      !result.memberId
    ) {
      throw new Error('Channel confirmation result is invalid')
    }
    this.pendingConfirmation = null
    this.sessionKeys = pending.keys
    this.sessionId = result.sessionId
    this.channelId = result.channelId
    this.pinnedHostIdentityPubKeyB64 = result.hostIdentityPubKeyB64
    this.nextOutboundSeq = 1
    this.lastInboundSeq = 0
    this.opts.onEstablished?.(result)
  }

  private sendPlainRequest(
    method: 'channel.admission.begin' | 'channel.admission.confirm' | 'channel.reconnect',
    params: unknown
  ): Promise<unknown> {
    this.requireConnected()
    const reqId = randomUUID()
    const promise = this.trackRequest(reqId, method)
    this.socket!.send(JSON.stringify(makeChannelRequest(reqId, method, params)))
    return promise
  }

  private sendEncryptedRequest(
    method: 'channel.log.append' | 'channel.log.resume',
    params: unknown
  ): Promise<unknown> {
    if (!this.sessionKeys || !this.sessionId || !this.socket) {
      return Promise.reject(new Error('Channel session is not established'))
    }
    const reqId = randomUUID()
    const promise = this.trackRequest(reqId, method)
    const frame = sealChannelMessage({
      keys: this.sessionKeys,
      direction: 'memberToHost',
      sessionId: this.sessionId,
      seq: this.nextOutboundSeq++,
      message: makeChannelRequest(reqId, method, params)
    })
    this.socket.send(JSON.stringify(frame))
    return promise
  }

  private trackRequest(reqId: string, method: string): Promise<unknown> {
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId)
        reject(new Error(`Channel ${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRequests.set(reqId, { resolve, reject, timer })
    })
  }

  private handleInbound(data: string): void {
    const message = parseChannelWireMessage(data)
    if (!message) return
    if (message.t === 'channel.res') {
      this.resolveResponse(message.reqId, message.ok, message.result, message.error)
      return
    }
    if (message.t === 'channel.enc') this.handleEncrypted(message)
  }

  private handleEncrypted(frame: ChannelEncryptedFrame): void {
    if (!this.sessionKeys || frame.sessionId !== this.sessionId) return
    if (frame.direction !== 'hostToMember' || frame.seq !== this.lastInboundSeq + 1) {
      this.opts.onError?.(new Error('Channel encrypted frame sequence has a gap'))
      this.clearSession()
      return
    }
    let message
    try {
      message = openChannelFrame({
        keys: this.sessionKeys,
        expectedDirection: 'hostToMember',
        frame
      })
    } catch (error) {
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.clearSession()
      return
    }
    this.lastInboundSeq = frame.seq
    if (message.t === 'channel.res') {
      this.resolveResponse(message.reqId, message.ok, message.result, message.error)
      return
    }
    if (message.t === 'channel.event') this.handleEvent(message)
  }

  private handleEvent(event: ChannelWireEvent): void {
    switch (event.method) {
      case 'channel.members.snapshot':
        this.opts.onMembersSnapshot?.(event.params)
        return
      case 'channel.log.appendResult':
        this.opts.onAppendResult?.(event.params)
        return
      case 'channel.member.revoked':
        this.opts.onRevoked?.(event.params)
        this.clearSession()
        return
      case 'channel.log.batch':
        this.applyBatch(event.params)
        return
    }
  }

  private applyBatch(value: unknown): void {
    const batch = asObject(value)
    if (
      !batch ||
      batch.channelId !== this.channelId ||
      !Array.isArray(batch.records) ||
      !Number.isInteger(batch.highWaterSequence) ||
      typeof batch.live !== 'boolean'
    ) {
      this.opts.onError?.(new Error('Channel replay batch is invalid'))
      return
    }
    const appliedNow: ChannelMessage[] = []
    for (const value of batch.records) {
      const record = parseChannelMessage(value, this.pinnedHostIdentityPubKeyB64)
      if (!record || record.channelId !== this.channelId) {
        this.opts.onError?.(new Error('Channel replay record is invalid'))
        return
      }
      const existing = this.applied.get(record.sequence)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          this.opts.onError?.(new Error('Channel replay conflicts with an applied sequence'))
          return
        }
        continue
      }
      if (record.sequence <= this.cursor) continue
      if (record.sequence !== this.cursor + 1) {
        this.opts.onError?.(new Error('Channel replay sequence is not contiguous'))
        return
      }
      this.applied.set(record.sequence, record)
      this.cursor = record.sequence
      appliedNow.push(record)
      this.opts.onCursor?.(this.cursor)
    }
    this.opts.onRecords?.(appliedNow, {
      highWaterSequence: batch.highWaterSequence as number,
      live: batch.live
    })
  }

  private resolveResponse(
    reqId: string,
    ok: boolean,
    result: unknown,
    error?: { code: string; message: string }
  ): void {
    const pending = this.pendingRequests.get(reqId)
    if (!pending) return
    this.pendingRequests.delete(reqId)
    clearTimeout(pending.timer)
    if (ok) pending.resolve(result)
    else {
      pending.reject(
        new ChannelRemoteError(
          error?.code ?? 'protocol_unsupported',
          error?.message ?? 'Channel request rejected'
        )
      )
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private clearSession(): void {
    this.sessionId = ''
    this.sessionKeys = null
    this.pendingConfirmation = null
    this.nextOutboundSeq = 1
    this.lastInboundSeq = 0
  }

  private requireConnected(): void {
    if (!this.socket || !this.connected) {
      throw new Error('Channel transport is not connected')
    }
  }

  private settleConnectWaiters(error: Error | null): void {
    const waiters = this.connectWaiters
    this.connectWaiters = []
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    if (value) this.settleConnectWaiters(null)
    this.opts.onConnectionChange?.(value)
  }
}
