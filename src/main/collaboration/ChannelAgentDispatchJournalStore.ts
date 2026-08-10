import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { isAbsolute, join } from 'path'

import type { SignedChannelAgentPost } from '../../shared/collaboration/ChannelAgentProtocol'
import type { ChannelAgentDispatchConsumption } from './ChannelAgentAuthorityState'
import type {
  ChannelAgentDispatchPlan,
  ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchAbandonReason,
  type ChannelAgentDispatchJournalEvent,
  type ChannelAgentDispatchJournalSnapshot,
  type ChannelAgentDispatchTerminalInput
} from './ChannelAgentDispatchJournalState'
import type { AgentChannelMessage } from './ChannelMessageLog'

export const CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION = 1 as const
export const CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX = '.dispatch.json' as const
export const CHANNEL_AGENT_DISPATCH_JOURNAL_MAX_FILE_BYTES = 256 * 1024

const CHANNEL_FILE_HASH_DOMAIN = 'taskwraith.channel.agent-dispatch-channel-file.v1\0'
const DISPATCH_FILE_HASH_DOMAIN = 'taskwraith.channel.agent-dispatch-record-file.v1\0'
const SNAPSHOT_HASH_DOMAIN = 'taskwraith.channel.agent-dispatch-snapshot.v1\0'
const MUTATION_LOCK_TOKEN_DOMAIN = 'taskwraith.channel.agent-dispatch-mutation-lock.v1\0'
const MAX_IDENTIFIER_LENGTH = 512
const MAX_MUTATION_ATTEMPTS = 4

export type ChannelAgentDispatchJournalValidationResult = 'valid' | 'unavailable' | 'invalid'

export type ChannelAgentDispatchJournalStoreErrorCode =
  | 'concurrent_update'
  | 'idempotency_conflict'
  | 'invalid_identifier'
  | 'not_terminal'
  | 'persistence_failed'
  | 'recovery_blocked'

export class ChannelAgentDispatchJournalStoreError extends Error {
  constructor(
    readonly code: ChannelAgentDispatchJournalStoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentDispatchJournalStoreError'
  }
}

export interface ChannelAgentDispatchJournalStoreOptions {
  readonly storageDirectory: string
  /**
   * Rebind recovered bytes to canonical member/authority state. `unavailable`
   * preserves evidence without quarantine; `invalid` quarantines tampering.
   */
  readonly validateSnapshot: (
    snapshot: ChannelAgentDispatchJournalSnapshot
  ) => ChannelAgentDispatchJournalValidationResult
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly randomId?: () => string
  readonly logger?: (line: string) => void
}

export interface ChannelAgentDispatchReservationResult {
  readonly created: boolean
  readonly snapshot: ChannelAgentDispatchJournalSnapshot
}

interface StoredChannelAgentDispatchJournalEnvelope {
  readonly schemaVersion: typeof CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION
  readonly channelIdHash: string
  readonly dispatchIdHash: string
  readonly snapshotHash: string
  readonly snapshot: ChannelAgentDispatchJournalSnapshot
}

interface JournalRecord {
  readonly state: ChannelAgentDispatchJournalState
  readonly rawEnvelope: string
  readonly path: string
}

interface MutationLockEnvelope {
  readonly schemaVersion: typeof CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION
  readonly pid: number
  readonly createdAt: number
  readonly token: string
}

function storeError(
  code: ChannelAgentDispatchJournalStoreErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentDispatchJournalStoreError {
  // Filesystem/provider callbacks may contain paths or secrets. Public errors
  // remain bounded to static store-owned copy.
  return new ChannelAgentDispatchJournalStoreError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== expected.length) return false
  const keys = new Set(expected)
  return actual.every((key) => keys.has(key))
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function domainHash(domain: string, value: string): string {
  return createHash('sha256').update(domain).update(value, 'utf8').digest('hex')
}

export function channelAgentDispatchJournalChannelFileHash(channelId: string): string {
  if (!isIdentifier(channelId)) {
    throw storeError('invalid_identifier', 'Channel id is invalid for dispatch journal storage')
  }
  return domainHash(CHANNEL_FILE_HASH_DOMAIN, channelId)
}

export function channelAgentDispatchJournalRecordFileHash(dispatchId: string): string {
  if (!isIdentifier(dispatchId)) {
    throw storeError('invalid_identifier', 'Dispatch id is invalid for journal storage')
  }
  return domainHash(DISPATCH_FILE_HASH_DOMAIN, dispatchId)
}

export function hashChannelAgentDispatchJournalSnapshot(
  snapshot: ChannelAgentDispatchJournalSnapshot
): string {
  return createHash('sha256')
    .update(SNAPSHOT_HASH_DOMAIN)
    .update(JSON.stringify(snapshot), 'utf8')
    .digest('hex')
}

function parseEnvelope(
  value: unknown,
  expectedChannelHash: string,
  expectedDispatchHash: string
): StoredChannelAgentDispatchJournalEnvelope | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'channelIdHash',
      'dispatchIdHash',
      'snapshotHash',
      'snapshot'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION ||
    value.channelIdHash !== expectedChannelHash ||
    value.dispatchIdHash !== expectedDispatchHash ||
    !isHash(value.channelIdHash) ||
    !isHash(value.dispatchIdHash) ||
    !isHash(value.snapshotHash) ||
    !isPlainObject(value.snapshot)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION,
    channelIdHash: value.channelIdHash,
    dispatchIdHash: value.dispatchIdHash,
    snapshotHash: value.snapshotHash,
    snapshot: value.snapshot as unknown as ChannelAgentDispatchJournalSnapshot
  }
}

export class ChannelAgentDispatchJournalStore {
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly logger: (line: string) => void
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: ChannelAgentDispatchJournalStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw storeError('persistence_failed', 'Channel agent dispatch store options are required')
    }
    if (typeof options.storageDirectory !== 'string' || !isAbsolute(options.storageDirectory)) {
      throw storeError(
        'persistence_failed',
        'Channel agent dispatch storage requires an absolute directory'
      )
    }
    if (typeof options.validateSnapshot !== 'function') {
      throw storeError(
        'persistence_failed',
        'Channel agent dispatch authority validator is required'
      )
    }
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.logger = options.logger ?? (() => {})
    this.platform = options.platform ?? process.platform
  }

  reserve(plan: ChannelAgentDispatchPlan, at: number): ChannelAgentDispatchReservationResult {
    const candidate = ChannelAgentDispatchJournalState.reserve(plan, at)
    const candidateSnapshot = candidate.snapshot()
    const binding = candidate.binding()
    this.requireValidForWrite(candidateSnapshot)
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const existing = this.readRecord(binding.channelId, binding.dispatchId)
      if (existing) {
        const expected = ChannelAgentDispatchJournalState.reserve(
          plan,
          existing.state.binding().reservedAt
        ).binding()
        if (!sameJson(existing.state.binding(), expected)) {
          throw storeError(
            'idempotency_conflict',
            'Channel agent dispatch reservation conflicts with durable state'
          )
        }
        return { created: false, snapshot: existing.state.snapshot() }
      }
      if (this.persist(candidateSnapshot, null)) {
        return { created: true, snapshot: candidateSnapshot }
      }
    }
    throw storeError(
      'concurrent_update',
      'Channel agent dispatch changed during every reservation attempt'
    )
  }

  snapshot(channelId: string, dispatchId: string): ChannelAgentDispatchJournalSnapshot | null {
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      try {
        return this.readRecord(channelId, dispatchId)?.state.snapshot() ?? null
      } catch (error) {
        if (
          error instanceof ChannelAgentDispatchJournalStoreError &&
          error.code === 'concurrent_update'
        ) {
          continue
        }
        throw error
      }
    }
    throw storeError('concurrent_update', 'Channel agent dispatch changed during every read')
  }

  listChannel(channelId: string): ChannelAgentDispatchJournalSnapshot[] {
    const channelHash = channelAgentDispatchJournalChannelFileHash(channelId)
    if (!existsSync(this.options.storageDirectory)) return []
    this.assertExistingDirectory()
    this.assertNoChannelQuarantine(channelHash)
    const pattern = new RegExp(`^${channelHash}\\.([a-f0-9]{64})\\.dispatch\\.json$`)
    const snapshots: ChannelAgentDispatchJournalSnapshot[] = []
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      const match = pattern.exec(entry.name)
      if (!match) continue
      if (!entry.isFile() || entry.isSymbolicLink()) {
        this.quarantine(
          join(this.options.storageDirectory, entry.name),
          channelHash,
          'dispatch journal path is not a private regular file'
        )
      }
      const record = this.readPath(
        join(this.options.storageDirectory, entry.name),
        channelHash,
        match[1]
      )
      if (!record || record.state.binding().channelId !== channelId) {
        throw storeError('recovery_blocked', 'Channel agent dispatch listing changed during read')
      }
      snapshots.push(record.state.snapshot())
    }
    return snapshots.sort(
      (left, right) =>
        left.binding.reservedAt - right.binding.reservedAt ||
        left.binding.dispatchId.localeCompare(right.binding.dispatchId)
    )
  }

  beginConsumption(
    channelId: string,
    dispatchId: string,
    plan: ChannelAgentDispatchPlan,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'consumption.intent', (state) =>
      state.beginConsumption(plan, at)
    )
  }

  commitConsumption(
    channelId: string,
    dispatchId: string,
    consumption: ChannelAgentDispatchConsumption
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'consumption.committed', (state) =>
      state.commitConsumption(consumption)
    )
  }

  beginLaunch(
    channelId: string,
    dispatchId: string,
    seal: ChannelAgentRunAuthoritySeal
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'launch.intent', (state) =>
      state.beginLaunch(seal)
    )
  }

  confirmLaunch(
    channelId: string,
    dispatchId: string,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'launch.confirmed', (state) =>
      state.confirmLaunch(at)
    )
  }

  recordTerminal(
    channelId: string,
    dispatchId: string,
    input: ChannelAgentDispatchTerminalInput
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'run.terminal', (state) =>
      state.recordTerminal(input)
    )
  }

  recordSignedPost(
    channelId: string,
    dispatchId: string,
    signedPost: SignedChannelAgentPost
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'post.signed', (state) =>
      state.recordSignedPost(signedPost)
    )
  }

  recordPosted(
    channelId: string,
    dispatchId: string,
    record: AgentChannelMessage,
    deduplicated: boolean
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'post.committed', (state) =>
      state.recordPosted(record, deduplicated)
    )
  }

  abandon(
    channelId: string,
    dispatchId: string,
    reason: ChannelAgentDispatchAbandonReason,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    return this.transition(channelId, dispatchId, 'dispatch.abandoned', (state) =>
      state.abandon(reason, at)
    )
  }

  /** Remove only a proven terminal journal. Channel authority/logs retain the evidence. */
  complete(channelId: string, dispatchId: string): boolean {
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const record = this.readRecord(channelId, dispatchId)
      if (!record) return false
      const phase = record.state.phase()
      if (phase !== 'posted' && phase !== 'abandoned') {
        throw storeError('not_terminal', 'Channel agent dispatch journal is not complete')
      }
      let currentRaw: string
      try {
        currentRaw = readFileSync(record.path, 'utf8')
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw storeError('recovery_blocked', 'Channel agent dispatch cannot be completed', error)
      }
      if (currentRaw !== record.rawEnvelope) continue
      try {
        unlinkSync(record.path)
        this.syncDirectory()
        return true
      } catch (error) {
        if (isMissingPathError(error)) return false
        throw storeError('persistence_failed', 'Channel agent dispatch completion failed', error)
      }
    }
    throw storeError('concurrent_update', 'Channel agent dispatch changed during completion')
  }

  /** Explicit recovery/privacy erasure for one dispatch, including temp/quarantine files. */
  eraseDispatch(channelId: string, dispatchId: string): number {
    const channelHash = channelAgentDispatchJournalChannelFileHash(channelId)
    const dispatchHash = channelAgentDispatchJournalRecordFileHash(dispatchId)
    return this.eraseOwned((name) => this.isOwnedDispatchFile(name, channelHash, dispatchHash))
  }

  /** Explicit Channel erasure. Human Channel storage remains outside this directory. */
  eraseChannel(channelId: string): number {
    const channelHash = channelAgentDispatchJournalChannelFileHash(channelId)
    return this.eraseOwned((name) => this.isOwnedChannelFile(name, channelHash))
  }

  /** Global collaboration erasure removes only this store's exact owned files. */
  purgeAll(): number {
    return this.eraseOwned((name) => this.isOwnedJournalFile(name))
  }

  private transition<TEvent extends ChannelAgentDispatchJournalEvent>(
    channelId: string,
    dispatchId: string,
    kind: TEvent['kind'],
    apply: (state: ChannelAgentDispatchJournalState) => TEvent
  ): ChannelAgentDispatchJournalSnapshot {
    channelAgentDispatchJournalChannelFileHash(channelId)
    channelAgentDispatchJournalRecordFileHash(dispatchId)
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const record = this.readRecord(channelId, dispatchId)
      if (!record) {
        throw storeError('recovery_blocked', 'Channel agent dispatch journal is unavailable')
      }
      const snapshot = record.state.snapshot()
      const existingIndex = snapshot.events.findIndex((event) => event.kind === kind)
      if (existingIndex >= 0) {
        const prefix = ChannelAgentDispatchJournalState.restore({
          ...snapshot,
          events: snapshot.events.slice(0, existingIndex)
        })
        let expected: TEvent
        try {
          expected = apply(prefix)
        } catch {
          throw storeError(
            'idempotency_conflict',
            'Channel agent dispatch transition conflicts with durable state'
          )
        }
        if (!sameJson(expected, snapshot.events[existingIndex])) {
          throw storeError(
            'idempotency_conflict',
            'Channel agent dispatch transition conflicts with durable state'
          )
        }
        return snapshot
      }
      const event = apply(record.state)
      if (event.kind !== kind) {
        throw storeError('persistence_failed', 'Channel agent dispatch transition is invalid')
      }
      const next = record.state.snapshot()
      this.requireValidForWrite(next)
      if (this.persist(next, record.rawEnvelope)) return next
    }
    throw storeError(
      'concurrent_update',
      'Channel agent dispatch changed during every transition attempt'
    )
  }

  private readRecord(channelId: string, dispatchId: string): JournalRecord | null {
    const channelHash = channelAgentDispatchJournalChannelFileHash(channelId)
    const dispatchHash = channelAgentDispatchJournalRecordFileHash(dispatchId)
    this.assertExistingDirectory()
    this.assertNoChannelQuarantine(channelHash)
    const record = this.readPath(
      this.journalPath(channelHash, dispatchHash),
      channelHash,
      dispatchHash
    )
    if (!record) return null
    const binding = record.state.binding()
    if (binding.channelId !== channelId || binding.dispatchId !== dispatchId) {
      return this.quarantine(
        record.path,
        channelHash,
        'dispatch journal belongs to another authority root'
      )
    }
    return record
  }

  private readPath(path: string, channelHash: string, dispatchHash: string): JournalRecord | null {
    let before: ReturnType<typeof lstatSync>
    try {
      before = lstatSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw storeError('recovery_blocked', 'Channel agent dispatch cannot be inspected', error)
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return this.quarantine(path, channelHash, 'dispatch journal is not a private regular file')
    }
    if (before.size > CHANNEL_AGENT_DISPATCH_JOURNAL_MAX_FILE_BYTES) {
      return this.quarantine(path, channelHash, 'dispatch journal exceeds its size limit')
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent dispatch cannot be read', error)
    }
    if (Buffer.byteLength(raw, 'utf8') > CHANNEL_AGENT_DISPATCH_JOURNAL_MAX_FILE_BYTES) {
      return this.quarantine(path, channelHash, 'dispatch journal exceeds its size limit')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch (error) {
      return this.quarantine(path, channelHash, 'dispatch journal is not valid JSON', error)
    }
    const envelope = parseEnvelope(decoded, channelHash, dispatchHash)
    if (!envelope)
      return this.quarantine(path, channelHash, 'dispatch journal envelope is malformed')
    if (hashChannelAgentDispatchJournalSnapshot(envelope.snapshot) !== envelope.snapshotHash) {
      return this.quarantine(path, channelHash, 'dispatch journal snapshot hash is invalid')
    }
    let state: ChannelAgentDispatchJournalState
    try {
      state = ChannelAgentDispatchJournalState.restore(envelope.snapshot)
    } catch (error) {
      return this.quarantine(path, channelHash, 'dispatch journal history is invalid', error)
    }
    const canonical = state.snapshot()
    const binding = state.binding()
    if (
      !sameJson(canonical, envelope.snapshot) ||
      channelAgentDispatchJournalChannelFileHash(binding.channelId) !== channelHash ||
      channelAgentDispatchJournalRecordFileHash(binding.dispatchId) !== dispatchHash
    ) {
      return this.quarantine(path, channelHash, 'dispatch journal root is invalid')
    }
    const validation = this.validate(canonical)
    if (validation === 'unavailable') {
      throw storeError(
        'recovery_blocked',
        'Channel agent dispatch authority is unavailable; journal was preserved'
      )
    }
    if (validation === 'invalid') {
      return this.quarantine(path, channelHash, 'dispatch journal authority is invalid')
    }
    try {
      const after = lstatSync(path)
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        readFileSync(path, 'utf8') !== raw
      ) {
        throw storeError('concurrent_update', 'Channel agent dispatch changed during validation')
      }
    } catch (error) {
      if (error instanceof ChannelAgentDispatchJournalStoreError) throw error
      throw storeError(
        'concurrent_update',
        'Channel agent dispatch could not be revalidated',
        error
      )
    }
    this.repairPermissions(path)
    return { state, rawEnvelope: raw, path }
  }

  private persist(
    snapshot: ChannelAgentDispatchJournalSnapshot,
    expectedRaw: string | null
  ): boolean {
    this.requireValidForWrite(snapshot)
    const binding = snapshot.binding
    const channelHash = channelAgentDispatchJournalChannelFileHash(binding.channelId)
    const dispatchHash = channelAgentDispatchJournalRecordFileHash(binding.dispatchId)
    const envelope: StoredChannelAgentDispatchJournalEnvelope = {
      schemaVersion: CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION,
      channelIdHash: channelHash,
      dispatchIdHash: dispatchHash,
      snapshotHash: hashChannelAgentDispatchJournalSnapshot(snapshot),
      snapshot
    }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > CHANNEL_AGENT_DISPATCH_JOURNAL_MAX_FILE_BYTES) {
      throw storeError(
        'persistence_failed',
        'Channel agent dispatch journal exceeds its size limit'
      )
    }
    this.prepareDirectory()
    this.assertNoChannelQuarantine(channelHash)
    const path = this.journalPath(channelHash, dispatchHash)
    const temporaryPath = `${path}.tmp-${process.pid}-${this.randomId()}`
    const mutationLock = expectedRaw === null ? null : this.acquireMutationLock(path)
    if (expectedRaw !== null && !mutationLock) return false
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      this.syncFile(temporaryPath)
      if (expectedRaw === null) {
        try {
          linkSync(temporaryPath, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            unlinkSync(temporaryPath)
            return false
          }
          throw error
        }
        unlinkSync(temporaryPath)
      } else {
        let currentRaw: string
        try {
          currentRaw = readFileSync(path, 'utf8')
        } catch (error) {
          if (isMissingPathError(error)) {
            unlinkSync(temporaryPath)
            return false
          }
          throw error
        }
        if (currentRaw !== expectedRaw) {
          unlinkSync(temporaryPath)
          return false
        }
        renameSync(temporaryPath, path)
      }
      chmodSync(path, 0o600)
      this.syncDirectory()
      return true
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      } catch {
        // Preserve the original failure; explicit erasure removes stale temps.
      }
      if (error instanceof ChannelAgentDispatchJournalStoreError) throw error
      throw storeError('persistence_failed', 'Channel agent dispatch persistence failed', error)
    } finally {
      if (mutationLock) this.releaseMutationLock(mutationLock.path, mutationLock.raw)
    }
  }

  /**
   * Serialize the compare-and-rename window. The lock contains no Channel data,
   * and a dead owner is reclaimed without changing the last durable snapshot.
   */
  private acquireMutationLock(path: string): { path: string; raw: string } | null {
    const lockPath = `${path}.lock`
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      const lock: MutationLockEnvelope = {
        schemaVersion: CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION,
        pid: process.pid,
        createdAt: this.requireNow(),
        token: domainHash(MUTATION_LOCK_TOKEN_DOMAIN, this.randomId())
      }
      const raw = `${JSON.stringify(lock)}\n`
      try {
        writeFileSync(lockPath, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        this.syncFile(lockPath)
        return { path: lockPath, raw }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw storeError(
            'persistence_failed',
            'Channel agent dispatch mutation lock could not be created',
            error
          )
        }
      }
      const owner = this.readMutationLock(lockPath)
      if (this.isProcessAlive(owner.pid)) return null
      try {
        if (readFileSync(lockPath, 'utf8') !== owner.raw) continue
        unlinkSync(lockPath)
        this.syncDirectory()
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw storeError(
          'recovery_blocked',
          'Channel agent dispatch stale mutation lock could not be reclaimed',
          error
        )
      }
    }
    return null
  }

  private readMutationLock(path: string): MutationLockEnvelope & { raw: string } {
    let metadata: ReturnType<typeof lstatSync>
    let raw: string
    try {
      metadata = lstatSync(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error('unsafe mutation lock')
      }
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent dispatch mutation lock is unsafe', error)
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw storeError(
        'recovery_blocked',
        'Channel agent dispatch mutation lock is malformed',
        error
      )
    }
    if (
      !isPlainObject(value) ||
      !hasExactKeys(value, ['schemaVersion', 'pid', 'createdAt', 'token']) ||
      value.schemaVersion !== CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      !isHash(value.token)
    ) {
      throw storeError('recovery_blocked', 'Channel agent dispatch mutation lock is malformed')
    }
    return {
      schemaVersion: CHANNEL_AGENT_DISPATCH_JOURNAL_STORE_VERSION,
      pid: value.pid as number,
      createdAt: value.createdAt,
      token: value.token,
      raw
    }
  }

  private releaseMutationLock(path: string, expectedRaw: string): void {
    try {
      if (readFileSync(path, 'utf8') !== expectedRaw) {
        throw storeError(
          'recovery_blocked',
          'Channel agent dispatch mutation lock changed before release'
        )
      }
      unlinkSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return
      if (error instanceof ChannelAgentDispatchJournalStoreError) throw error
      throw storeError(
        'persistence_failed',
        'Channel agent dispatch mutation lock could not be released',
        error
      )
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private requireValidForWrite(snapshot: ChannelAgentDispatchJournalSnapshot): void {
    const result = this.validate(snapshot)
    if (result !== 'valid') {
      throw storeError(
        'recovery_blocked',
        'Channel agent dispatch authority could not validate the journal write'
      )
    }
  }

  private validate(
    snapshot: ChannelAgentDispatchJournalSnapshot
  ): ChannelAgentDispatchJournalValidationResult {
    try {
      const result = this.options.validateSnapshot(clone(snapshot))
      return result === 'valid' || result === 'unavailable' || result === 'invalid'
        ? result
        : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  private eraseOwned(predicate: (name: string) => boolean): number {
    if (!existsSync(this.options.storageDirectory)) return 0
    this.assertExistingDirectory()
    let removed = 0
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !predicate(entry.name)) continue
      unlinkSync(join(this.options.storageDirectory, entry.name))
      removed += 1
    }
    if (removed > 0) this.syncDirectory()
    return removed
  }

  private assertNoChannelQuarantine(channelHash: string): void {
    if (!existsSync(this.options.storageDirectory)) return
    const blocked = readdirSync(this.options.storageDirectory, { withFileTypes: true }).some(
      (entry) =>
        entry.name.startsWith(`${channelHash}.`) &&
        entry.name.includes(`${CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX}.corrupt-`)
    )
    if (blocked) {
      throw storeError(
        'recovery_blocked',
        'Channel agent dispatch journal is quarantined; explicit erasure is required'
      )
    }
  }

  private quarantine(path: string, channelHash: string, reason: string, _cause?: unknown): never {
    const quarantinePath = `${path}.corrupt-${this.requireNow()}-${this.randomId()}`
    try {
      renameSync(path, quarantinePath)
      this.syncDirectory()
    } catch (error) {
      this.logger(`[channel-agent-dispatch] quarantine failed: ${reason}`)
      throw storeError('recovery_blocked', `${reason}; quarantine failed`, error)
    }
    this.logger(`[channel-agent-dispatch] ${channelHash.slice(0, 12)} quarantined: ${reason}`)
    throw storeError('recovery_blocked', reason)
  }

  private prepareDirectory(): void {
    try {
      mkdirSync(this.options.storageDirectory, { recursive: true, mode: 0o700 })
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('dispatch journal path is not a private directory')
      }
      chmodSync(this.options.storageDirectory, 0o700)
    } catch (error) {
      throw storeError('persistence_failed', 'Channel agent dispatch directory is unsafe', error)
    }
  }

  private assertExistingDirectory(): void {
    if (!existsSync(this.options.storageDirectory)) return
    try {
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('dispatch journal path is not a private directory')
      }
      if ((directory.mode & 0o077) !== 0) chmodSync(this.options.storageDirectory, 0o700)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent dispatch directory is unsafe', error)
    }
  }

  private repairPermissions(path: string): void {
    try {
      if ((lstatSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent dispatch permissions are unsafe', error)
    }
  }

  private isOwnedDispatchFile(name: string, channelHash: string, dispatchHash: string): boolean {
    const base = `${channelHash}.${dispatchHash}${CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX}`
    return (
      name === base ||
      name === `${base}.lock` ||
      name.startsWith(`${base}.tmp-`) ||
      name.startsWith(`${base}.corrupt-`)
    )
  }

  private isOwnedChannelFile(name: string, channelHash: string): boolean {
    return name.startsWith(`${channelHash}.`) && this.isOwnedJournalFile(name)
  }

  private isOwnedJournalFile(name: string): boolean {
    return /^[a-f0-9]{64}\.[a-f0-9]{64}\.dispatch\.json(?:\.lock|\.(?:tmp|corrupt)-.+)?$/.test(name)
  }

  private journalPath(channelHash: string, dispatchHash: string): string {
    return join(
      this.options.storageDirectory,
      `${channelHash}.${dispatchHash}${CHANNEL_AGENT_DISPATCH_JOURNAL_FILE_SUFFIX}`
    )
  }

  private requireNow(): number {
    const value = this.now()
    if (!isTimestamp(value)) {
      throw storeError('persistence_failed', 'Channel agent dispatch clock is invalid')
    }
    return value
  }

  private syncFile(path: string): void {
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  private syncDirectory(): void {
    try {
      const descriptor = openSync(this.options.storageDirectory, 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        this.platform === 'win32' &&
        (code === 'EACCES' || code === 'EBADF' || code === 'EINVAL' || code === 'EPERM')
      ) {
        return
      }
      throw storeError('persistence_failed', 'Dispatch directory could not be synchronized', error)
    }
  }
}
