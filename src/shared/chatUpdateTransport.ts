import type { ChatMessage, ChatRecord } from '../main/store/types'

export const CHAT_UPDATE_CHANNEL = 'chat-updated'
export const CHAT_UPDATE_ACK_CHANNEL = 'chat-updated:ack'

/** Legacy wire shape: full non-message record on every patch. */
export const CHAT_UPDATE_PROTOCOL_V1 = 1 as const
/**
 * Compact wire shape: top-level field mask + recordDelta, optional transcript
 * ops, and sub-revision/hash envelopes. Emit remains opt-in (default v1).
 */
export const CHAT_UPDATE_PROTOCOL_V2 = 2 as const
/** Highest protocol the dual-read stack understands. */
export const CHAT_UPDATE_PROTOCOL_VERSION = CHAT_UPDATE_PROTOCOL_V2

export type ChatUpdateProtocolVersion =
  | typeof CHAT_UPDATE_PROTOCOL_V1
  | typeof CHAT_UPDATE_PROTOCOL_V2

export type ChatUpdateRecord = Omit<ChatRecord, 'messages'>

export interface ChatUpdateMessageSplice {
  start: number
  deleteCount: number
  items: ChatMessage[]
}

/** T6b transcript ops — identity-preserving alternatives to a raw splice. */
export type ChatTranscriptOp =
  | { op: 'append'; messages: ChatMessage[] }
  | { op: 'update'; id: string; message: ChatMessage }
  | { op: 'delete'; id: string }

export interface ChatUpdateSubRevisions {
  ensembleRevision: number
  runsRevision: number
  recordHash: string
}

export interface ChatUpdateProducerState extends ChatUpdateSubRevisions {
  chatId: string
  persistenceRevision: number
  retainedBytes: number
}

/**
 * Exact change metadata authored alongside the durable chat mutation.
 *
 * The transport may compose consecutive deltas, but it must never reconstruct
 * one by walking the transcript. A missing/discontinuous delta is a recovery
 * condition and therefore produces one full snapshot.
 */
export interface ChatUpdateProducerDelta extends ChatUpdateProducerState {
  basePersistenceRevision: number
  recordMask: string[]
  recordDelta: Partial<ChatUpdateRecord>
  recordCleared?: string[]
  /** null means the producer observed an edit that append/update/delete cannot express. */
  transcriptOps: ChatTranscriptOp[] | null
  changedMessageCount: number
}

export interface ChatUpdateProducerEnvelope {
  state: ChatUpdateProducerState
  delta: ChatUpdateProducerDelta | null
}

const producerEnvelopeByChat = new WeakMap<ChatRecord, ChatUpdateProducerEnvelope>()

/** Main-process side channel. Weak/non-enumerable by construction: no hint is persisted or cloned. */
export function attachChatUpdateProducerEnvelope(
  chat: ChatRecord,
  envelope: ChatUpdateProducerEnvelope
): ChatRecord {
  producerEnvelopeByChat.set(chat, envelope)
  return chat
}

export function chatUpdateProducerEnvelopeFor(
  chat: ChatRecord
): ChatUpdateProducerEnvelope | undefined {
  return producerEnvelopeByChat.get(chat)
}

export interface ChatUpdateSnapshotDelivery {
  protocolVersion: ChatUpdateProtocolVersion
  kind: 'snapshot'
  deliveryId: string
  chatId: string
  revision: number
  chat: ChatRecord
  ensembleRevision?: number
  runsRevision?: number
  recordHash?: string
}

/** v1 patch: full non-message record (legacy clients / default emit). */
export interface ChatUpdatePatchDeliveryV1 {
  protocolVersion: typeof CHAT_UPDATE_PROTOCOL_V1
  kind: 'patch'
  deliveryId: string
  chatId: string
  baseRevision: number
  revision: number
  record: ChatUpdateRecord
  messages: ChatUpdateMessageSplice
}

/**
 * v2 patch: only changed top-level fields. Message splice is retained during
 * dual-read when transcript ops cannot express the change; both may appear
 * only when ops are present as the preferred path and splice is a safety copy
 * — apply prefers transcriptOps when present.
 */
export interface ChatUpdatePatchDeliveryV2 {
  protocolVersion: typeof CHAT_UPDATE_PROTOCOL_V2
  kind: 'patch'
  deliveryId: string
  chatId: string
  baseRevision: number
  revision: number
  /** Keys whose values changed (set or cleared). */
  recordMask: string[]
  /** Changed top-level fields only (never a full Omit<ChatRecord, messages>). */
  recordDelta: Partial<ChatUpdateRecord>
  /** Keys present on the baseline record that must be deleted. */
  recordCleared?: string[]
  /** Retained for dual-read when transcriptOps is absent or incomplete. */
  messages?: ChatUpdateMessageSplice
  transcriptOps?: ChatTranscriptOp[]
  ensembleRevision?: number
  runsRevision?: number
  recordHash?: string
}

export type ChatUpdatePatchDelivery = ChatUpdatePatchDeliveryV1 | ChatUpdatePatchDeliveryV2

export type ChatUpdateDelivery = ChatUpdateSnapshotDelivery | ChatUpdatePatchDelivery

export interface ChatUpdateAck {
  deliveryId: string
  applied: boolean
  /** Optional T6c-forward fields; ignored by v1 ACK consumers. */
  revision?: number
  recordHash?: string
}

export interface ChatUpdateBaseline {
  revision: number
  chat: ChatRecord
  ensembleRevision?: number
  runsRevision?: number
  recordHash?: string
}

/**
 * Compact main-side ACK baseline (T6c). Retains generation + hashes only —
 * never a full ChatRecord. Used by the delivery coordinator so acknowledged
 * state cannot accumulate a third full-chat ref alongside inFlight/pending.
 */
export interface CompactChatUpdateBaseline {
  revision: number
  recordHash: string
  ensembleRevision?: number
  runsRevision?: number
  /** Cheap retained-byte estimate for statsForTarget meters. */
  retainedBytes: number
}

/**
 * Cheap retained-byte estimate for delivery stats. Prefers message content
 * lengths over JSON.stringify so the hot ACK path stays O(messages).
 */
export function estimateChatMessageBytes(message: ChatMessage): number {
  let bytes = 64
  if (typeof message.content === 'string') bytes += message.content.length
  else if (message.content != null) bytes += 128
  return bytes
}

export function estimateChatRecordBytes(chat: ChatRecord): number {
  let bytes = 256
  for (const message of chat.messages) {
    bytes += estimateChatMessageBytes(message)
  }
  const runs = chat.runs
  if (Array.isArray(runs)) bytes += runs.length * 48
  if (chat.ensemble != null) bytes += 512
  return bytes
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
}

/**
 * Compose latest-wins producer deltas while an earlier delivery is awaiting
 * its ACK. Transcript operations remain in producer order, so applying the
 * result is identical to applying each durable mutation in sequence.
 */
export function composeChatUpdateProducerDeltas(
  first: ChatUpdateProducerDelta,
  second: ChatUpdateProducerDelta
): ChatUpdateProducerDelta | null {
  if (
    first.chatId !== second.chatId ||
    first.persistenceRevision !== second.basePersistenceRevision
  ) {
    return null
  }

  const recordMask = [...first.recordMask]
  const touched = new Set(recordMask)
  const recordDelta = { ...first.recordDelta } as Record<string, unknown>
  const recordCleared = new Set(first.recordCleared ?? [])
  for (const key of second.recordMask) {
    if (!touched.has(key)) {
      touched.add(key)
      recordMask.push(key)
    }
  }
  for (const key of second.recordCleared ?? []) {
    delete recordDelta[key]
    recordCleared.add(key)
  }
  for (const [key, value] of Object.entries(second.recordDelta)) {
    recordDelta[key] = value
    recordCleared.delete(key)
  }

  return {
    chatId: first.chatId,
    basePersistenceRevision: first.basePersistenceRevision,
    persistenceRevision: second.persistenceRevision,
    recordMask,
    recordDelta: recordDelta as Partial<ChatUpdateRecord>,
    ...(recordCleared.size > 0 ? { recordCleared: [...recordCleared] } : {}),
    transcriptOps:
      first.transcriptOps === null || second.transcriptOps === null
        ? null
        : [...first.transcriptOps, ...second.transcriptOps],
    changedMessageCount: first.changedMessageCount + second.changedMessageCount,
    ensembleRevision: second.ensembleRevision,
    runsRevision: second.runsRevision,
    recordHash: second.recordHash,
    retainedBytes: second.retainedBytes
  }
}

export type ApplyChatUpdateResult =
  | { ok: true; baseline: ChatUpdateBaseline }
  | { ok: false; reason: string }

/**
 * Strict structural equality for the persisted plain-data message shape.
 * False negatives only make a patch larger; false positives would corrupt the
 * reconstructed chat, so every structural difference returns false.
 */
function plainDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false
  }
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray || bArray) {
    if (!aArray || !bArray || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!plainDataEqual(a[index], b[index])) return false
    }
    return true
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false
    if (!plainDataEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function fingerprintNumber(value: unknown): number {
  return Number.parseInt(fnv1aHex(stableStringify(value)), 16)
}

export function computeChatSubRevisions(chat: ChatRecord): ChatUpdateSubRevisions {
  const record = chatRecordWithoutMessages(chat)
  return {
    ensembleRevision: fingerprintNumber(record.ensemble ?? null),
    runsRevision: fingerprintNumber(record.runs ?? []),
    recordHash: fnv1aHex(stableStringify(record))
  }
}

export function buildChatUpdateMessageSplice(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatUpdateMessageSplice {
  const sharedLimit = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < sharedLimit && plainDataEqual(previous[prefix], next[prefix])) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < sharedLimit - prefix &&
    plainDataEqual(previous[previous.length - 1 - suffix], next[next.length - 1 - suffix])
  ) {
    suffix += 1
  }

  return {
    start: prefix,
    deleteCount: previous.length - prefix - suffix,
    items: next.slice(prefix, next.length - suffix)
  }
}

/**
 * Express a transcript delta as identity-preserving ops when the change is a
 * pure append, in-place updates by id, and/or deletes by id that preserve the
 * relative order of surviving messages. Returns null when the delta needs a
 * splice (reorder, id collision, insert-before-survivor, etc.).
 */
export function buildChatTranscriptOps(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatTranscriptOp[] | null {
  const prevById = new Map<string, ChatMessage>()
  for (const message of previous) {
    if (!message?.id || prevById.has(message.id)) return null
    prevById.set(message.id, message)
  }
  const nextIds = new Set<string>()
  for (const message of next) {
    if (!message?.id || nextIds.has(message.id)) return null
    nextIds.add(message.id)
  }

  const ops: ChatTranscriptOp[] = []
  for (const message of previous) {
    if (!nextIds.has(message.id)) {
      ops.push({ op: 'delete', id: message.id })
    }
  }

  const survivingPrev = previous.filter((message) => nextIds.has(message.id))
  let survivingIndex = 0
  const appendBatch: ChatMessage[] = []

  for (const message of next) {
    const prior = prevById.get(message.id)
    if (!prior) {
      // New ids are only valid as a trailing append after all survivors.
      if (survivingIndex !== survivingPrev.length) return null
      appendBatch.push(message)
      continue
    }
    if (appendBatch.length > 0) return null
    if (survivingPrev[survivingIndex]?.id !== message.id) return null
    survivingIndex += 1
    if (!plainDataEqual(prior, message)) {
      ops.push({ op: 'update', id: message.id, message })
    }
  }

  if (survivingIndex !== survivingPrev.length) return null
  if (appendBatch.length > 0) {
    ops.push({ op: 'append', messages: appendBatch })
  }
  return ops
}

export function applyChatTranscriptOps(
  messages: readonly ChatMessage[],
  ops: readonly ChatTranscriptOp[]
): ChatMessage[] | null {
  // A v2 patch can carry an empty ops list when only record metadata changed.
  // Preserve the baseline array so metadata-only deliveries do not turn into
  // an O(messages) allocation in the renderer.
  if (ops.length === 0) return messages as ChatMessage[]

  const next = messages.slice()
  const indexById = new Map<string, number>()
  for (let index = 0; index < next.length; index += 1) {
    const id = next[index]?.id
    if (!id || indexById.has(id)) return null
    indexById.set(id, index)
  }

  for (const op of ops) {
    if (op.op === 'append') {
      if (!Array.isArray(op.messages) || op.messages.length === 0) return null
      for (const message of op.messages) {
        if (!message?.id || indexById.has(message.id)) return null
        indexById.set(message.id, next.length)
        next.push(message)
      }
      continue
    }
    if (op.op === 'update') {
      const index = indexById.get(op.id)
      if (index === undefined || !op.message || op.message.id !== op.id) return null
      next[index] = op.message
      continue
    }
    if (op.op === 'delete') {
      const index = indexById.get(op.id)
      if (index === undefined) return null
      next.splice(index, 1)
      indexById.delete(op.id)
      for (let cursor = index; cursor < next.length; cursor += 1) {
        indexById.set(next[cursor].id, cursor)
      }
      continue
    }
    return null
  }
  return next
}

function chatRecordWithoutMessages(chat: ChatRecord): ChatUpdateRecord {
  const { messages: _messages, ...record } = chat
  return record
}

export function buildChatRecordDelta(
  previous: ChatUpdateRecord,
  next: ChatUpdateRecord
): {
  recordMask: string[]
  recordDelta: Partial<ChatUpdateRecord>
  recordCleared: string[]
} {
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  const keySet = new Set([...previousKeys, ...nextKeys])
  const recordMask: string[] = []
  const recordDelta: Partial<ChatUpdateRecord> = {}
  const recordCleared: string[] = []
  const previousRecord = previous as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>

  for (const key of keySet) {
    const had = Object.prototype.hasOwnProperty.call(previousRecord, key)
    const has = Object.prototype.hasOwnProperty.call(nextRecord, key)
    if (had && !has) {
      recordMask.push(key)
      recordCleared.push(key)
      continue
    }
    if (!plainDataEqual(previousRecord[key], nextRecord[key])) {
      recordMask.push(key)
      ;(recordDelta as Record<string, unknown>)[key] = nextRecord[key]
    }
  }

  return { recordMask, recordDelta, recordCleared }
}

function applyRecordDelta(
  baseline: ChatUpdateRecord,
  patch: Pick<ChatUpdatePatchDeliveryV2, 'recordMask' | 'recordDelta' | 'recordCleared'>
): ChatUpdateRecord {
  const next = { ...baseline } as Record<string, unknown>
  for (const key of patch.recordCleared ?? []) {
    delete next[key]
  }
  for (const [key, value] of Object.entries(patch.recordDelta ?? {})) {
    next[key] = value
  }
  // Mask is advisory for meters/debug; delta+cleared are authoritative.
  void patch.recordMask
  return next as ChatUpdateRecord
}

function applyMessageSplice(
  baselineMessages: readonly ChatMessage[],
  splice: ChatUpdateMessageSplice
): ChatMessage[] | null {
  const { start, deleteCount, items } = splice
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(deleteCount) ||
    start < 0 ||
    deleteCount < 0 ||
    start > baselineMessages.length ||
    start + deleteCount > baselineMessages.length ||
    !Array.isArray(items)
  ) {
    return null
  }
  if (deleteCount === 0 && items.length === 0) {
    // Metadata-only patches use an empty splice. Keep the existing array
    // identity so downstream transcript/store consumers can bail out too.
    return baselineMessages as ChatMessage[]
  }
  return [
    ...baselineMessages.slice(0, start),
    ...items,
    ...baselineMessages.slice(start + deleteCount)
  ]
}

function resolveEmitProtocolVersion(
  requested?: ChatUpdateProtocolVersion
): ChatUpdateProtocolVersion {
  if (requested === CHAT_UPDATE_PROTOCOL_V2) return CHAT_UPDATE_PROTOCOL_V2
  return CHAT_UPDATE_PROTOCOL_V1
}

export function buildChatUpdateDelivery(input: {
  deliveryId: string
  revision: number
  chat: ChatRecord
  baseline?: ChatUpdateBaseline
  /** Current producer projection, also lets recovery snapshots avoid re-metering the chat. */
  producerState?: ChatUpdateProducerState
  /** Exact producer-authored delta. Missing/discontinuous v2 input recovers by snapshot. */
  producerDelta?: ChatUpdateProducerDelta
  /** Fall back to a snapshot when a splice replaces this fraction of the list. */
  snapshotReplacementRatio?: number
  /**
   * Emit protocol. Default remains v1 for compatibility; pass 2 (or enable the
   * coordinator flag) to emit compact field-mask patches.
   */
  protocolVersion?: ChatUpdateProtocolVersion
}): ChatUpdateDelivery {
  const { baseline, chat, deliveryId, revision } = input
  const protocolVersion = resolveEmitProtocolVersion(input.protocolVersion)
  const producerDelta = input.producerDelta
  const candidateState = producerDelta ?? input.producerState
  const producerState =
    candidateState?.chatId === chat.appChatId &&
    candidateState.persistenceRevision === persistenceRevision(chat)
      ? candidateState
      : undefined
  const sub: ChatUpdateSubRevisions = producerState
    ? {
        ensembleRevision: producerState.ensembleRevision,
        runsRevision: producerState.runsRevision,
        recordHash: producerState.recordHash
      }
    : computeChatSubRevisions(chat)

  const snapshot = (): ChatUpdateSnapshotDelivery => ({
    protocolVersion,
    kind: 'snapshot',
    deliveryId,
    chatId: chat.appChatId,
    revision,
    chat,
    ...(protocolVersion === CHAT_UPDATE_PROTOCOL_V2 ? sub : {})
  })

  if (!baseline || baseline.chat.appChatId !== chat.appChatId) {
    return snapshot()
  }

  const ratio = Math.min(1, Math.max(0.1, input.snapshotReplacementRatio ?? 0.72))
  const replacementLimit = Math.max(48, Math.ceil(chat.messages.length * ratio))

  if (protocolVersion === CHAT_UPDATE_PROTOCOL_V1) {
    const messages = buildChatUpdateMessageSplice(baseline.chat.messages, chat.messages)
    const replacedRows = messages.deleteCount + messages.items.length
    if (replacedRows > replacementLimit) return snapshot()
    return {
      protocolVersion: CHAT_UPDATE_PROTOCOL_V1,
      kind: 'patch',
      deliveryId,
      chatId: chat.appChatId,
      baseRevision: baseline.revision,
      revision,
      record: chatRecordWithoutMessages(chat),
      messages
    }
  }

  // The v2 hot path is producer-only. If a caller skipped a mutation, revisions
  // do not chain, or an insertion/reorder cannot be represented by the public
  // append/update/delete vocabulary, one full snapshot repairs the baseline.
  // Never rediscover the change by walking every historical message here.
  if (
    !producerDelta ||
    producerDelta.chatId !== chat.appChatId ||
    producerDelta.basePersistenceRevision !== persistenceRevision(baseline.chat) ||
    producerDelta.persistenceRevision !== persistenceRevision(chat) ||
    producerDelta.transcriptOps === null ||
    producerDelta.changedMessageCount > replacementLimit
  ) {
    return snapshot()
  }

  const patch: ChatUpdatePatchDeliveryV2 = {
    protocolVersion: CHAT_UPDATE_PROTOCOL_V2,
    kind: 'patch',
    deliveryId,
    chatId: chat.appChatId,
    baseRevision: baseline.revision,
    revision,
    recordMask: producerDelta.recordMask,
    recordDelta: producerDelta.recordDelta,
    ...(producerDelta.recordCleared?.length ? { recordCleared: producerDelta.recordCleared } : {}),
    transcriptOps: producerDelta.transcriptOps,
    ...sub
  }
  return patch
}

export function applyChatUpdateDelivery(
  delivery: ChatUpdateDelivery,
  baseline?: ChatUpdateBaseline
): ApplyChatUpdateResult {
  if (delivery.kind === 'snapshot') {
    if (delivery.chat.appChatId !== delivery.chatId) {
      return { ok: false, reason: 'Snapshot chat id does not match its envelope.' }
    }
    const nextBaseline: ChatUpdateBaseline = {
      revision: delivery.revision,
      chat: delivery.chat
    }
    if (delivery.ensembleRevision !== undefined) {
      nextBaseline.ensembleRevision = delivery.ensembleRevision
    }
    if (delivery.runsRevision !== undefined) {
      nextBaseline.runsRevision = delivery.runsRevision
    }
    if (delivery.recordHash !== undefined) {
      nextBaseline.recordHash = delivery.recordHash
    }
    return { ok: true, baseline: nextBaseline }
  }

  if (!baseline) return { ok: false, reason: 'Patch has no renderer baseline.' }
  if (baseline.revision !== delivery.baseRevision) {
    return { ok: false, reason: 'Patch base revision is stale.' }
  }
  if (baseline.chat.appChatId !== delivery.chatId) {
    return { ok: false, reason: 'Patch chat id does not match its baseline.' }
  }

  if (delivery.protocolVersion === CHAT_UPDATE_PROTOCOL_V1) {
    if (delivery.record.appChatId !== delivery.chatId) {
      return { ok: false, reason: 'Patch chat id does not match its baseline.' }
    }
    const spliced = applyMessageSplice(baseline.chat.messages, delivery.messages)
    if (!spliced) return { ok: false, reason: 'Patch message splice is invalid.' }
    return {
      ok: true,
      baseline: {
        revision: delivery.revision,
        chat: { ...delivery.record, messages: spliced }
      }
    }
  }

  if (delivery.protocolVersion !== CHAT_UPDATE_PROTOCOL_V2) {
    return { ok: false, reason: 'Unsupported chat-update protocol version.' }
  }

  const record = applyRecordDelta(chatRecordWithoutMessages(baseline.chat), delivery)
  if (record.appChatId !== delivery.chatId) {
    return { ok: false, reason: 'Patch chat id does not match its baseline.' }
  }

  let messages: ChatMessage[] | null = null
  if (delivery.transcriptOps !== undefined) {
    messages = applyChatTranscriptOps(baseline.chat.messages, delivery.transcriptOps)
    if (!messages) return { ok: false, reason: 'Patch transcript ops are invalid.' }
  } else if (delivery.messages) {
    messages = applyMessageSplice(baseline.chat.messages, delivery.messages)
    if (!messages) return { ok: false, reason: 'Patch message splice is invalid.' }
  } else {
    return { ok: false, reason: 'Patch has neither transcript ops nor a message splice.' }
  }

  const chat = { ...record, messages }
  return {
    ok: true,
    baseline: {
      revision: delivery.revision,
      chat,
      ensembleRevision: delivery.ensembleRevision,
      runsRevision: delivery.runsRevision,
      recordHash: delivery.recordHash
    }
  }
}

export function isChatUpdateDelivery(value: unknown): value is ChatUpdateDelivery {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ChatUpdateDelivery>
  const version = candidate.protocolVersion
  if (version !== CHAT_UPDATE_PROTOCOL_V1 && version !== CHAT_UPDATE_PROTOCOL_V2) {
    return false
  }
  return (
    (candidate.kind === 'snapshot' || candidate.kind === 'patch') &&
    typeof candidate.deliveryId === 'string' &&
    candidate.deliveryId.length > 0 &&
    typeof candidate.chatId === 'string' &&
    candidate.chatId.length > 0 &&
    Number.isSafeInteger(candidate.revision)
  )
}

export function normalizeChatUpdateAck(value: unknown): ChatUpdateAck | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ChatUpdateAck>
  if (
    typeof candidate.deliveryId !== 'string' ||
    candidate.deliveryId.length === 0 ||
    candidate.deliveryId.length > 160 ||
    typeof candidate.applied !== 'boolean'
  ) {
    return null
  }
  const ack: ChatUpdateAck = {
    deliveryId: candidate.deliveryId,
    applied: candidate.applied
  }
  if (Number.isSafeInteger(candidate.revision)) {
    ack.revision = candidate.revision
  }
  if (typeof candidate.recordHash === 'string' && candidate.recordHash.length <= 64) {
    ack.recordHash = candidate.recordHash
  }
  return ack
}
