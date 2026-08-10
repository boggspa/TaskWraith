import { createHash, randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join, resolve } from 'path'

export const CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION = 1
export const CHANNEL_HUMAN_REVIEW_FILENAME = 'human-reviews.json'
export const CHANNEL_HUMAN_REVIEW_TTL_MS = 24 * 60 * 60 * 1_000
export const CHANNEL_HUMAN_REVIEW_RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_CHANNEL_HUMAN_REVIEW_BYTES = 8 * 1_024 * 1_024
export const MAX_CHANNEL_HUMAN_REVIEW_CONTENT_BYTES = 8_000
export const MAX_CHANNEL_HUMAN_REVIEWS = 512
export const MAX_CHANNEL_HUMAN_REVIEW_TOMBSTONES = 4_096
export const MAX_QUEUED_CHANNEL_HUMAN_REVIEWS_PER_MEMBER = 20

export type ChannelHumanReviewState = 'queued' | 'approved' | 'denied' | 'lapsed' | 'materialized'

export type ChannelHumanReviewLapseReason = 'expired' | 'member_revoked' | 'channel_closed'

export interface ChannelHumanReviewEntry {
  schemaVersion: typeof CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION
  reviewId: string
  channelId: string
  memberId: string
  identityPublicKeyB64: string
  roomId: string
  clientMessageId: string
  content: string
  contentBytes: number
  contentHash: string
  state: ChannelHumanReviewState
  enqueuedAt: number
  expiresAt: number
  resolvedAt: number | null
  resolutionReason: string | null
  materializedSequence: number | null
  materializedMessageId: string | null
}

interface ChannelHumanReviewTombstone {
  channelId: string
  dedupeHash: string
}

interface ChannelHumanReviewSnapshot {
  schemaVersion: typeof CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION
  entries: ChannelHumanReviewEntry[]
  tombstones: ChannelHumanReviewTombstone[]
}

export type ChannelHumanReviewEnqueueResult =
  | { outcome: 'queued' | 'duplicate'; entry: ChannelHumanReviewEntry }
  | { outcome: 'duplicate_terminal'; entry: null }

export type ChannelHumanReviewErrorCode =
  | 'recovery_blocked'
  | 'invalid'
  | 'idempotency_conflict'
  | 'quota_exceeded'
  | 'not_found'
  | 'invalid_state'

export class ChannelHumanReviewError extends Error {
  constructor(
    readonly code: ChannelHumanReviewErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelHumanReviewError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ROOT_KEYS = new Set(['schemaVersion', 'entries', 'tombstones'])
const ENTRY_KEYS = new Set([
  'schemaVersion',
  'reviewId',
  'channelId',
  'memberId',
  'identityPublicKeyB64',
  'roomId',
  'clientMessageId',
  'content',
  'contentBytes',
  'contentHash',
  'state',
  'enqueuedAt',
  'expiresAt',
  'resolvedAt',
  'resolutionReason',
  'materializedSequence',
  'materializedMessageId'
])
const TOMBSTONE_KEYS = new Set(['channelId', 'dedupeHash'])
const STATES = new Set<ChannelHumanReviewState>([
  'queued',
  'approved',
  'denied',
  'lapsed',
  'materialized'
])

function fail(code: ChannelHumanReviewErrorCode, message: string): never {
  throw new ChannelHumanReviewError(code, message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function identifier(value: unknown, maximum = 512): value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function positiveSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function reviewKey(channelId: string, memberId: string, clientMessageId: string): string {
  return JSON.stringify([channelId, memberId, clientMessageId])
}

function dedupeHash(channelId: string, memberId: string, clientMessageId: string): string {
  return createHash('sha256')
    .update(reviewKey(channelId, memberId, clientMessageId), 'utf8')
    .digest('hex')
}

function stateFieldsAreValid(entry: Record<string, unknown>): boolean {
  const state = entry.state as ChannelHumanReviewState
  const resolved = entry.resolvedAt
  const reason = entry.resolutionReason
  const sequence = entry.materializedSequence
  const messageId = entry.materializedMessageId
  if (state === 'queued') {
    return resolved === null && reason === null && sequence === null && messageId === null
  }
  if (!timestamp(resolved) || resolved < (entry.enqueuedAt as number)) return false
  if (state === 'materialized') {
    return reason === null && positiveSequence(sequence) && identifier(messageId)
  }
  if (sequence !== null || messageId !== null) return false
  if (state === 'approved') return reason === null
  return typeof reason === 'string' && reason.length > 0 && reason.length <= 240
}

function parseEntry(value: unknown): ChannelHumanReviewEntry | null {
  const raw = objectRecord(value)
  if (
    !raw ||
    !exactKeys(raw, ENTRY_KEYS) ||
    raw.schemaVersion !== CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION ||
    !identifier(raw.reviewId) ||
    !identifier(raw.channelId) ||
    !identifier(raw.memberId) ||
    !identifier(raw.identityPublicKeyB64) ||
    !identifier(raw.roomId) ||
    !identifier(raw.clientMessageId, 200) ||
    typeof raw.content !== 'string' ||
    !raw.content.trim() ||
    Buffer.byteLength(raw.content, 'utf8') !== raw.contentBytes ||
    !positiveSequence(raw.contentBytes) ||
    raw.contentBytes > MAX_CHANNEL_HUMAN_REVIEW_CONTENT_BYTES ||
    !digest(raw.contentHash) ||
    raw.contentHash !== hashContent(raw.content) ||
    !STATES.has(raw.state as ChannelHumanReviewState) ||
    !timestamp(raw.enqueuedAt) ||
    !timestamp(raw.expiresAt) ||
    raw.expiresAt <= raw.enqueuedAt ||
    !stateFieldsAreValid(raw)
  ) {
    return null
  }
  return clone(raw) as unknown as ChannelHumanReviewEntry
}

function parseTombstone(value: unknown): ChannelHumanReviewTombstone | null {
  const raw = objectRecord(value)
  if (
    !raw ||
    !exactKeys(raw, TOMBSTONE_KEYS) ||
    !identifier(raw.channelId) ||
    !digest(raw.dedupeHash)
  ) {
    return null
  }
  return { channelId: raw.channelId, dedupeHash: raw.dedupeHash }
}

function parseSnapshot(value: unknown): ChannelHumanReviewSnapshot | null {
  const raw = objectRecord(value)
  if (
    !raw ||
    !exactKeys(raw, ROOT_KEYS) ||
    raw.schemaVersion !== CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.tombstones) ||
    raw.entries.length > MAX_CHANNEL_HUMAN_REVIEWS ||
    raw.tombstones.length > MAX_CHANNEL_HUMAN_REVIEW_TOMBSTONES
  ) {
    return null
  }
  const entries = raw.entries.map(parseEntry)
  const tombstones = raw.tombstones.map(parseTombstone)
  if (entries.some((entry) => entry === null) || tombstones.some((entry) => entry === null)) {
    return null
  }
  const completeEntries = entries as ChannelHumanReviewEntry[]
  const completeTombstones = tombstones as ChannelHumanReviewTombstone[]
  const reviewIds = completeEntries.map((entry) => entry.reviewId)
  const entryKeys = completeEntries.map((entry) =>
    reviewKey(entry.channelId, entry.memberId, entry.clientMessageId)
  )
  const tombstoneKeys = completeTombstones.map((entry) => entry.dedupeHash)
  if (
    new Set(reviewIds).size !== reviewIds.length ||
    new Set(entryKeys).size !== entryKeys.length ||
    new Set(tombstoneKeys).size !== tombstoneKeys.length ||
    completeEntries.some((entry) =>
      completeTombstones.some(
        (tombstone) =>
          tombstone.dedupeHash ===
          dedupeHash(entry.channelId, entry.memberId, entry.clientMessageId)
      )
    )
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION,
    entries: completeEntries,
    tombstones: completeTombstones
  }
}

function emptySnapshot(): ChannelHumanReviewSnapshot {
  return {
    schemaVersion: CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION,
    entries: [],
    tombstones: []
  }
}

function normalizeReason(value: string | undefined, fallback: string): string {
  const reason = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return (reason || fallback).slice(0, 240)
}

function sortEntries(entries: ChannelHumanReviewEntry[]): ChannelHumanReviewEntry[] {
  return entries.sort(
    (left, right) =>
      left.enqueuedAt - right.enqueuedAt ||
      (left.reviewId < right.reviewId ? -1 : left.reviewId > right.reviewId ? 1 : 0)
  )
}

export function channelHumanReviewPath(userDataPath: string): string {
  if (
    typeof userDataPath !== 'string' ||
    !userDataPath.trim() ||
    userDataPath.trim() !== userDataPath
  ) {
    fail('invalid', 'Channel human review store requires userDataPath')
  }
  return join(resolve(userDataPath), 'channels', CHANNEL_HUMAN_REVIEW_FILENAME)
}

/** Main-owned durable queue for migrated Channel contributions requiring review. */
export class ChannelHumanReviewStore {
  private snapshot = emptySnapshot()
  private recoveryBlocked = false

  constructor(private readonly storagePath?: string) {
    this.snapshot = this.load()
  }

  enqueue(input: {
    channelId: string
    memberId: string
    identityPublicKeyB64: string
    roomId: string
    clientMessageId: string
    content: string
    now?: number
    ttlMs?: number
  }): ChannelHumanReviewEnqueueResult {
    this.assertHealthy()
    const now = this.safeNow(input.now ?? Date.now())
    const ttlMs = input.ttlMs ?? CHANNEL_HUMAN_REVIEW_TTL_MS
    const contentBytes =
      typeof input.content === 'string' ? Buffer.byteLength(input.content, 'utf8') : 0
    if (
      !identifier(input.channelId) ||
      !identifier(input.memberId) ||
      !identifier(input.identityPublicKeyB64) ||
      !identifier(input.roomId) ||
      !identifier(input.clientMessageId, 200) ||
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      contentBytes < 1 ||
      contentBytes > MAX_CHANNEL_HUMAN_REVIEW_CONTENT_BYTES ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 7 * CHANNEL_HUMAN_REVIEW_TTL_MS
    ) {
      fail('invalid', 'Channel human review request is invalid')
    }

    const next = this.compact(clone(this.snapshot), now, 1)
    const existing = next.entries.find(
      (entry) =>
        entry.channelId === input.channelId &&
        entry.memberId === input.memberId &&
        entry.clientMessageId === input.clientMessageId
    )
    if (existing) {
      if (
        existing.identityPublicKeyB64 !== input.identityPublicKeyB64 ||
        existing.roomId !== input.roomId ||
        existing.contentHash !== hashContent(input.content)
      ) {
        fail('idempotency_conflict', 'Channel human review idempotency key conflicts')
      }
      return { outcome: 'duplicate', entry: clone(existing) }
    }
    const requestedDedupeHash = dedupeHash(input.channelId, input.memberId, input.clientMessageId)
    if (next.tombstones.some((entry) => entry.dedupeHash === requestedDedupeHash)) {
      return { outcome: 'duplicate_terminal', entry: null }
    }
    const queuedForMember = next.entries.filter(
      (entry) =>
        entry.channelId === input.channelId &&
        entry.memberId === input.memberId &&
        entry.state === 'queued'
    ).length
    if (queuedForMember >= MAX_QUEUED_CHANNEL_HUMAN_REVIEWS_PER_MEMBER) {
      fail('quota_exceeded', 'Channel human review queue is full for this member')
    }
    if (next.entries.length >= MAX_CHANNEL_HUMAN_REVIEWS) {
      fail('quota_exceeded', 'Channel human review store is full')
    }
    const entry: ChannelHumanReviewEntry = {
      schemaVersion: CHANNEL_HUMAN_REVIEW_SCHEMA_VERSION,
      reviewId: randomUUID(),
      channelId: input.channelId,
      memberId: input.memberId,
      identityPublicKeyB64: input.identityPublicKeyB64,
      roomId: input.roomId,
      clientMessageId: input.clientMessageId,
      content: input.content,
      contentBytes,
      contentHash: hashContent(input.content),
      state: 'queued',
      enqueuedAt: now,
      expiresAt: now + ttlMs,
      resolvedAt: null,
      resolutionReason: null,
      materializedSequence: null,
      materializedMessageId: null
    }
    next.entries.push(entry)
    sortEntries(next.entries)
    this.commit(next)
    return { outcome: 'queued', entry: clone(entry) }
  }

  get(reviewId: string): ChannelHumanReviewEntry | null {
    this.assertHealthy()
    if (!identifier(reviewId)) fail('invalid', 'Channel human review id is invalid')
    const entry = this.snapshot.entries.find((candidate) => candidate.reviewId === reviewId)
    return entry ? clone(entry) : null
  }

  findByClientMessageId(
    channelId: string,
    memberId: string,
    clientMessageId: string
  ): ChannelHumanReviewEntry | 'retired' | null {
    this.assertHealthy()
    if (!identifier(channelId) || !identifier(memberId) || !identifier(clientMessageId, 200)) {
      fail('invalid', 'Channel human review identity is invalid')
    }
    const entry = this.snapshot.entries.find(
      (candidate) =>
        candidate.channelId === channelId &&
        candidate.memberId === memberId &&
        candidate.clientMessageId === clientMessageId
    )
    if (entry) return clone(entry)
    return this.snapshot.tombstones.some(
      (candidate) => candidate.dedupeHash === dedupeHash(channelId, memberId, clientMessageId)
    )
      ? 'retired'
      : null
  }

  list(channelId?: string): ChannelHumanReviewEntry[] {
    this.assertHealthy()
    if (channelId !== undefined && !identifier(channelId)) {
      fail('invalid', 'Channel human review channel id is invalid')
    }
    return this.snapshot.entries
      .filter((entry) => channelId === undefined || entry.channelId === channelId)
      .map(clone)
  }

  listQueued(channelId?: string): ChannelHumanReviewEntry[] {
    return this.list(channelId).filter((entry) => entry.state === 'queued')
  }

  listAwaitingMaterialization(): ChannelHumanReviewEntry[] {
    return this.list()
      .filter((entry) => entry.state === 'approved')
      .sort(
        (left, right) =>
          (left.resolvedAt ?? left.enqueuedAt) - (right.resolvedAt ?? right.enqueuedAt) ||
          left.enqueuedAt - right.enqueuedAt ||
          (left.reviewId < right.reviewId ? -1 : left.reviewId > right.reviewId ? 1 : 0)
      )
  }

  approve(reviewId: string, now = Date.now()): ChannelHumanReviewEntry {
    this.assertHealthy()
    const at = this.safeNow(now)
    const next = clone(this.snapshot)
    const entry = this.requireEntry(next, reviewId)
    if (entry.state === 'approved' || entry.state === 'materialized') return clone(entry)
    if (entry.state !== 'queued') {
      fail('invalid_state', 'Channel human review can no longer be approved')
    }
    if (at >= entry.expiresAt) {
      entry.state = 'lapsed'
      entry.resolvedAt = Math.max(at, entry.enqueuedAt)
      entry.resolutionReason = 'expired'
      this.commit(next)
      fail('invalid_state', 'Channel human review has expired')
    }
    entry.state = 'approved'
    entry.resolvedAt = Math.max(at, entry.enqueuedAt)
    this.commit(next)
    return clone(entry)
  }

  deny(reviewId: string, reason?: string, now = Date.now()): ChannelHumanReviewEntry {
    this.assertHealthy()
    const at = this.safeNow(now)
    const next = clone(this.snapshot)
    const entry = this.requireEntry(next, reviewId)
    if (entry.state === 'denied') return clone(entry)
    if (entry.state !== 'queued') {
      fail('invalid_state', 'Channel human review can no longer be denied')
    }
    entry.state = 'denied'
    entry.resolvedAt = Math.max(at, entry.enqueuedAt)
    entry.resolutionReason = normalizeReason(reason, 'denied_by_host')
    this.commit(next)
    return clone(entry)
  }

  markMaterialized(
    reviewId: string,
    materialized: { sequence: number; messageId: string },
    now = Date.now()
  ): ChannelHumanReviewEntry {
    this.assertHealthy()
    this.safeNow(now)
    if (!positiveSequence(materialized.sequence) || !identifier(materialized.messageId)) {
      fail('invalid', 'Channel human review materialization is invalid')
    }
    const next = clone(this.snapshot)
    const entry = this.requireEntry(next, reviewId)
    if (entry.state === 'materialized') {
      if (
        entry.materializedSequence !== materialized.sequence ||
        entry.materializedMessageId !== materialized.messageId
      ) {
        fail('idempotency_conflict', 'Channel human review materialization conflicts')
      }
      return clone(entry)
    }
    if (entry.state !== 'approved') {
      fail('invalid_state', 'Channel human review is not approved')
    }
    entry.state = 'materialized'
    entry.materializedSequence = materialized.sequence
    entry.materializedMessageId = materialized.messageId
    this.commit(next)
    return clone(entry)
  }

  lapse(
    filter: { channelId: string; memberId?: string },
    reason: Exclude<ChannelHumanReviewLapseReason, 'expired'>,
    now = Date.now()
  ): ChannelHumanReviewEntry[] {
    this.assertHealthy()
    const at = this.safeNow(now)
    if (
      !identifier(filter.channelId) ||
      (filter.memberId !== undefined && !identifier(filter.memberId))
    ) {
      fail('invalid', 'Channel human review lapse scope is invalid')
    }
    const next = clone(this.snapshot)
    const affected: ChannelHumanReviewEntry[] = []
    for (const entry of next.entries) {
      if (entry.channelId !== filter.channelId) continue
      if (filter.memberId !== undefined && entry.memberId !== filter.memberId) continue
      // Durable approval is an irreversible host release. Revocation/closure
      // lapses only work the host has not decided; callers flush approvals first.
      if (entry.state !== 'queued') continue
      entry.state = 'lapsed'
      entry.resolvedAt = Math.max(at, entry.enqueuedAt)
      entry.resolutionReason = reason
      affected.push(clone(entry))
    }
    if (affected.length) this.commit(next)
    return affected
  }

  sweep(now = Date.now()): ChannelHumanReviewEntry[] {
    this.assertHealthy()
    const at = this.safeNow(now)
    const next = clone(this.snapshot)
    const lapsed: ChannelHumanReviewEntry[] = []
    let changed = false
    for (const entry of next.entries) {
      if (entry.state !== 'queued') continue
      if (at < entry.enqueuedAt) {
        const ttl = entry.expiresAt - entry.enqueuedAt
        entry.enqueuedAt = at
        entry.expiresAt = at + ttl
        changed = true
        continue
      }
      if (at < entry.expiresAt) continue
      entry.state = 'lapsed'
      entry.resolvedAt = at
      entry.resolutionReason = 'expired'
      lapsed.push(clone(entry))
      changed = true
    }
    const compacted = this.compact(next, at)
    if (changed || JSON.stringify(compacted) !== JSON.stringify(this.snapshot)) {
      this.commit(compacted)
    }
    return lapsed
  }

  purgeChannels(channelIds: readonly string[]): number {
    this.assertHealthy()
    const ids = new Set(channelIds)
    for (const channelId of ids) {
      if (!identifier(channelId)) fail('invalid', 'Channel human review purge scope is invalid')
    }
    const next = clone(this.snapshot)
    const before = next.entries.length
    next.entries = next.entries.filter((entry) => !ids.has(entry.channelId))
    next.tombstones = next.tombstones.filter((entry) => !ids.has(entry.channelId))
    const removed = before - next.entries.length
    if (
      removed > 0 ||
      JSON.stringify(next.tombstones) !== JSON.stringify(this.snapshot.tombstones)
    ) {
      this.commit(next)
    }
    return removed
  }

  /** Explicit global erasure also recovers a corrupt store by deleting it. */
  purgeAll(): void {
    if (this.storagePath && existsSync(this.storagePath)) {
      unlinkSync(this.storagePath)
      this.syncDirectory()
    }
    this.snapshot = emptySnapshot()
    this.recoveryBlocked = false
  }

  private requireEntry(
    snapshot: ChannelHumanReviewSnapshot,
    reviewId: string
  ): ChannelHumanReviewEntry {
    if (!identifier(reviewId)) fail('invalid', 'Channel human review id is invalid')
    const entry = snapshot.entries.find((candidate) => candidate.reviewId === reviewId)
    if (!entry) fail('not_found', 'Channel human review was not found')
    return entry
  }

  private compact(
    snapshot: ChannelHumanReviewSnapshot,
    now: number,
    reserveEntries = 0
  ): ChannelHumanReviewSnapshot {
    const terminal = snapshot.entries
      .filter(
        (entry) =>
          entry.state === 'materialized' || entry.state === 'denied' || entry.state === 'lapsed'
      )
      .sort(
        (left, right) =>
          (left.resolvedAt ?? left.enqueuedAt) - (right.resolvedAt ?? right.enqueuedAt)
      )
    const expired = terminal.filter(
      (entry) =>
        now - (entry.resolvedAt ?? entry.enqueuedAt) > CHANNEL_HUMAN_REVIEW_RESOLVED_RETENTION_MS
    )
    const expiredIds = new Set(expired.map((entry) => entry.reviewId))
    const overflow = Math.max(
      0,
      snapshot.entries.length - expired.length + reserveEntries - MAX_CHANNEL_HUMAN_REVIEWS
    )
    const evicted = [
      ...expired,
      ...terminal.filter((entry) => !expiredIds.has(entry.reviewId)).slice(0, overflow)
    ]
    if (evicted.length === 0) return snapshot
    const evictedIds = new Set(evicted.map((entry) => entry.reviewId))
    for (const entry of evicted) {
      const tombstone: ChannelHumanReviewTombstone = {
        channelId: entry.channelId,
        dedupeHash: dedupeHash(entry.channelId, entry.memberId, entry.clientMessageId)
      }
      if (!snapshot.tombstones.some((candidate) => candidate.dedupeHash === tombstone.dedupeHash)) {
        snapshot.tombstones.push(tombstone)
      }
    }
    snapshot.entries = snapshot.entries.filter((entry) => !evictedIds.has(entry.reviewId))
    snapshot.tombstones = snapshot.tombstones.slice(-MAX_CHANNEL_HUMAN_REVIEW_TOMBSTONES)
    return snapshot
  }

  private safeNow(value: number): number {
    if (!timestamp(value)) fail('invalid', 'Channel human review time is invalid')
    return value
  }

  private assertHealthy(): void {
    if (this.recoveryBlocked) {
      fail('recovery_blocked', 'Channel human review authority is recovery-blocked')
    }
  }

  private load(): ChannelHumanReviewSnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) return emptySnapshot()
    try {
      const stat = lstatSync(this.storagePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHANNEL_HUMAN_REVIEW_BYTES) {
        throw new Error('unsafe')
      }
      const parsed = parseSnapshot(JSON.parse(readFileSync(this.storagePath, 'utf8')))
      if (!parsed) throw new Error('invalid')
      return parsed
    } catch {
      this.recoveryBlocked = true
      return emptySnapshot()
    }
  }

  private commit(snapshot: ChannelHumanReviewSnapshot): void {
    this.persist(snapshot)
    this.snapshot = snapshot
  }

  private persist(snapshot: ChannelHumanReviewSnapshot): void {
    if (!this.storagePath) return
    const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
    if (bytes.length > MAX_CHANNEL_HUMAN_REVIEW_BYTES) {
      fail('quota_exceeded', 'Channel human review store exceeds its byte bound')
    }
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, this.storagePath)
      this.syncDirectory()
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the original persistence failure.
        }
      }
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary)
        } catch {
          // Preserve the original persistence failure.
        }
      }
      throw error
    }
  }

  private syncDirectory(): void {
    if (!this.storagePath) return
    try {
      const descriptor = openSync(dirname(this.storagePath), 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      // Some supported platforms do not permit directory fsync.
    }
  }
}
