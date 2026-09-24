/**
 * Durable execution-claim journal for the queued-start lifecycle.
 *
 * A claim is body-free evidence that a Host run may have crossed the first
 * provider-side-effect boundary. This store never retains the queued command
 * payload and exposes no replay operation. `record` returns only after the
 * append is fsynced; any append uncertainty poisons that store instance so a
 * later start cannot proceed through it.
 *
 * Absence is stronger than presence. A caller-pinned epoch governs which
 * existing journal may accept new claims, but the epoch alone cannot detect a
 * rollback to an older valid prefix. This store therefore never declares
 * durable absence coverage. `list` may stop at an optional recovery-head
 * sequence so a later receipt contract can bound the read; the truncated
 * prefix is still not absence proof. The standalone HostNodeProductionServer
 * opens this journal only behind the default-OFF queued-start gate and passes
 * it through HostNodeDomainPorts; lifecycle `claim` awaits the fsynced record
 * before provider side effects. Restart recovery reopens the journal lazily
 * only for receipt-bound cursors and authenticates all requested positions in
 * one unbounded read. Receipt-authorized compaction rewrites only after a
 * bounded threshold, preserves original claim cursors and the monotonic append
 * sequence, and never upgrades absence into proof. `declaresDurableCoverage`
 * therefore remains false.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import type {
  HostQueuedStartExecutionClaim,
  HostQueuedStartExecutionClaimCursor,
  HostQueuedStartExecutionClaimStore
} from './HostNodeQueuedStartLifecycle'

export const HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME =
  'host-queued-start-execution-claims-v1.jsonl'

const LEGACY_SCHEMA_VERSION = 1
const COMPACTED_SCHEMA_VERSION = 2
const OWNER_FILE_MODE = 0o600
const MAX_FIELD_CHARS = 512
const MAX_LINE_BYTES = 4 * 1024
const DEFAULT_COMPACT_AFTER_RECORDS = 4096
const EPOCH_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

type JournalSchemaVersion = typeof LEGACY_SCHEMA_VERSION | typeof COMPACTED_SCHEMA_VERSION

type JournalFileIdentity = {
  readonly dev: string
  readonly ino: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

type LegacyHeaderBody = {
  readonly kind: 'header'
  readonly schemaVersion: typeof LEGACY_SCHEMA_VERSION
  readonly coverageEpoch: string
}

type CompactedHeaderBody = {
  readonly kind: 'header'
  readonly schemaVersion: typeof COMPACTED_SCHEMA_VERSION
  readonly coverageEpoch: string
  /** First sequence available to a post-compaction append. */
  readonly nextSequence: number
}

type HeaderBody = LegacyHeaderBody | CompactedHeaderBody

type ClaimBody = HostQueuedStartExecutionClaim & {
  readonly kind: 'claim'
  readonly schemaVersion: JournalSchemaVersion
  readonly sequence: number
  readonly previousDigest: string
}

type HeaderLine = HeaderBody & { readonly digest: string }
type ClaimLine = ClaimBody & { readonly digest: string }

export interface HostNodeQueuedStartExecutionClaimJournalIo {
  /** Test seam for partial writes; production uses writeSync until complete. */
  write(fd: number, buffer: Uint8Array, offset: number, length: number): number
  /** Test seam for a file-fsync refusal. */
  fsyncFile(fd: number): void
  /** Test seam for an atomic same-directory replacement refusal. */
  rename?: (source: string, destination: string) => void
  /** Test seam for a directory-fsync refusal. */
  fsyncDirectory?: (path: string) => void
}

export interface HostNodeQueuedStartExecutionClaimStoreOptions {
  /** Existing canonical non-root Host data directory. */
  readonly dataDir: string
  /** Expected writer epoch; a mismatched existing journal is read-only. */
  readonly expectedCoverageEpoch?: string
  /** Creation seam; output must be lowercase 64-hex. */
  readonly createCoverageEpoch?: () => string
  /** Rewrite only after this many physical claim rows; defaults to 4096. */
  readonly compactAfterRecords?: number
  /** Narrow fault-injection seam; omitted in production. */
  readonly journalIo?: HostNodeQueuedStartExecutionClaimJournalIo
}

export type HostNodeQueuedStartExecutionClaimCompactionResult =
  | {
      readonly kind: 'unchanged'
      readonly physicalClaims: number
      readonly retainedClaims: number
    }
  | {
      readonly kind: 'compacted'
      readonly physicalClaims: number
      readonly retainedClaims: number
      readonly nextSequence: number
    }

export interface HostQueuedStartExecutionClaimListOptions {
  /**
   * Inclusive claim sequence to stop at. `0` returns no claims (header only).
   * Omit to read and verify the whole journal. The bound truncates the read;
   * it does not make absence decidable.
   */
  readonly recoveryHeadSequence?: number
}

export interface HostNodeQueuedStartExecutionClaimStore extends HostQueuedStartExecutionClaimStore {
  /** Writer epoch for future receipt + recovery-head binding; not absence proof alone. */
  readonly coverageEpoch: string
  /** Absolute journal path, exposed for diagnostics and focused recovery tests. */
  readonly path: string
  list(options?: HostQueuedStartExecutionClaimListOptions): readonly HostQueuedStartExecutionClaim[]
  /**
   * Rewrite durable evidence to the receipt store's retained command set.
   * Original claim sequences and the monotonic append cursor are preserved.
   */
  compact?(
    retainedCommandIds: ReadonlySet<string>
  ): HostNodeQueuedStartExecutionClaimCompactionResult
}

const DEFAULT_JOURNAL_IO: HostNodeQueuedStartExecutionClaimJournalIo = {
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncFile: (fd) => fsyncSync(fd),
  rename: (source, destination) => renameSync(source, destination),
  fsyncDirectory: (path) => syncDirectory(path)
}

function digestBody(body: HeaderBody | ClaimBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function encodeLine(body: HeaderBody | ClaimBody): {
  readonly bytes: Buffer
  readonly digest: string
} {
  const digest = digestBody(body)
  const bytes = Buffer.from(`${JSON.stringify({ ...body, digest })}\n`, 'utf8')
  if (bytes.byteLength > MAX_LINE_BYTES) {
    throw new Error('Queued-start execution claim journal line exceeds its bound')
  }
  return { bytes, digest }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validOpaque(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FIELD_CHARS &&
    value.trim().length > 0
  )
}

function validClaim(value: HostQueuedStartExecutionClaim): boolean {
  return (
    validOpaque(value.commandId) &&
    validOpaque(value.threadId) &&
    validOpaque(value.fingerprint) &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt) &&
    value.claimedAt >= 0
  )
}

function validEpoch(value: unknown): value is string {
  return typeof value === 'string' && EPOCH_PATTERN.test(value)
}

function sameFile(left: JournalFileIdentity, right: JournalFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function fileIdentity(stat: Stats): JournalFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  }
}

function assertSafeFileStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Unsafe queued-start execution claim journal')
  }
}

function parseHeader(raw: unknown): HeaderLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid queued-start execution claim journal header')
  }
  const value = raw as Record<string, unknown>
  if (
    value.kind !== 'header' ||
    !validEpoch(value.coverageEpoch) ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new Error('Invalid queued-start execution claim journal header')
  }
  let body: HeaderBody
  if (
    value.schemaVersion === LEGACY_SCHEMA_VERSION &&
    exactKeys(value, ['kind', 'schemaVersion', 'coverageEpoch', 'digest'])
  ) {
    body = {
      kind: 'header',
      schemaVersion: LEGACY_SCHEMA_VERSION,
      coverageEpoch: value.coverageEpoch
    }
  } else if (
    value.schemaVersion === COMPACTED_SCHEMA_VERSION &&
    exactKeys(value, ['kind', 'schemaVersion', 'coverageEpoch', 'nextSequence', 'digest']) &&
    typeof value.nextSequence === 'number' &&
    Number.isSafeInteger(value.nextSequence) &&
    value.nextSequence >= 1
  ) {
    body = {
      kind: 'header',
      schemaVersion: COMPACTED_SCHEMA_VERSION,
      coverageEpoch: value.coverageEpoch,
      nextSequence: value.nextSequence
    }
  } else {
    throw new Error('Invalid queued-start execution claim journal header')
  }
  if (digestBody(body) !== value.digest) {
    throw new Error('Invalid queued-start execution claim journal header digest')
  }
  return { ...body, digest: value.digest }
}

function parseClaim(
  raw: unknown,
  schemaVersion: JournalSchemaVersion,
  legacySequence: number,
  previousSequence: number,
  previousDigest: string
): ClaimLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid queued-start execution claim journal record')
  }
  const value = raw as Record<string, unknown>
  const sequence = value.sequence
  if (
    !exactKeys(value, [
      'kind',
      'schemaVersion',
      'sequence',
      'previousDigest',
      'commandId',
      'threadId',
      'fingerprint',
      'claimedAt',
      'digest'
    ]) ||
    value.kind !== 'claim' ||
    value.schemaVersion !== schemaVersion ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    (schemaVersion === LEGACY_SCHEMA_VERSION
      ? sequence !== legacySequence
      : sequence <= previousSequence) ||
    value.previousDigest !== previousDigest ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new Error('Invalid queued-start execution claim journal record')
  }
  const claim: HostQueuedStartExecutionClaim = {
    commandId: value.commandId as string,
    threadId: value.threadId as string,
    fingerprint: value.fingerprint as string,
    claimedAt: value.claimedAt as number
  }
  if (!validClaim(claim)) {
    throw new Error('Invalid queued-start execution claim journal identity')
  }
  const body: ClaimBody = {
    kind: 'claim',
    schemaVersion,
    sequence,
    previousDigest,
    ...claim
  }
  if (digestBody(body) !== value.digest) {
    throw new Error('Invalid queued-start execution claim journal record digest')
  }
  return { ...body, digest: value.digest }
}

type LoadedJournal = {
  readonly identity: JournalFileIdentity
  readonly schemaVersion: JournalSchemaVersion
  readonly coverageEpoch: string
  readonly lastDigest: string
  readonly nextSequence: number
  readonly physicalClaimCount: number
  readonly claims: Map<string, HostQueuedStartExecutionClaim>
  readonly claimSequences: Map<string, number>
}

function resolveRecoveryHeadSequence(
  options: HostQueuedStartExecutionClaimListOptions | undefined
): number | undefined {
  if (options === undefined) return undefined
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid queued-start execution claim list options')
  }
  const keys = Object.keys(options)
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'recoveryHeadSequence')) {
    throw new Error('Invalid queued-start execution claim list options')
  }
  if (options.recoveryHeadSequence === undefined) return undefined
  if (
    typeof options.recoveryHeadSequence !== 'number' ||
    !Number.isSafeInteger(options.recoveryHeadSequence) ||
    options.recoveryHeadSequence < 0
  ) {
    throw new Error('Invalid queued-start recovery-head sequence')
  }
  return options.recoveryHeadSequence
}

function journalLinesForRead(source: string, recoveryHeadSequence: number | undefined): string[] {
  if (recoveryHeadSequence === undefined) {
    if (!source.endsWith('\n')) {
      throw new Error('Queued-start execution claim journal has a torn tail')
    }
    const lines = source.slice(0, -1).split('\n')
    if (
      lines.length === 0 ||
      lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
    ) {
      throw new Error('Queued-start execution claim journal line is invalid')
    }
    return lines
  }

  // Header is line 0; claim sequences are 1-based. Bound 0 reads the header only.
  const needed = recoveryHeadSequence + 1
  const completeLines = source.endsWith('\n')
    ? source.slice(0, -1).split('\n')
    : source.split('\n').slice(0, -1)
  if (completeLines.length === 0) {
    throw new Error('Queued-start execution claim journal line is invalid')
  }
  if (!source.endsWith('\n') && completeLines.length < needed) {
    throw new Error('Queued-start execution claim journal has a torn tail')
  }
  const lines = completeLines.slice(0, Math.min(completeLines.length, needed))
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)) {
    throw new Error('Queued-start execution claim journal line is invalid')
  }
  return lines
}

function loadJournal(
  path: string,
  options?: { readonly recoveryHeadSequence?: number }
): LoadedJournal {
  const before = lstatSync(path)
  assertSafeFileStat(before)
  const beforeIdentity = fileIdentity(before)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    assertSafeFileStat(opened)
    if (!sameFile(beforeIdentity, fileIdentity(opened))) {
      throw new Error('Queued-start execution claim journal changed before read')
    }
    const source = readFileSync(fd, 'utf8')
    const firstLineEnd = source.indexOf('\n')
    if (firstLineEnd < 0 || firstLineEnd > MAX_LINE_BYTES) {
      throw new Error('Queued-start execution claim journal header is invalid')
    }
    const sourceHeader = parseHeader(JSON.parse(source.slice(0, firstLineEnd)))
    // Legacy journals retain the original prefix-read behavior. Compacted
    // journals can contain sparse logical sequences, so they are authenticated
    // in full and filtered by sequence rather than physical line number.
    const lines =
      sourceHeader.schemaVersion === LEGACY_SCHEMA_VERSION
        ? journalLinesForRead(source, options?.recoveryHeadSequence)
        : journalLinesForRead(source, undefined)
    const header = parseHeader(JSON.parse(lines[0]))
    const claims = new Map<string, HostQueuedStartExecutionClaim>()
    const claimSequences = new Map<string, number>()
    const seenCommandIds = new Set<string>()
    let previousDigest = header.digest
    let previousSequence = 0
    let nextSequence =
      header.schemaVersion === COMPACTED_SCHEMA_VERSION ? header.nextSequence : lines.length
    for (let index = 1; index < lines.length; index += 1) {
      const record = parseClaim(
        JSON.parse(lines[index]),
        header.schemaVersion,
        index,
        previousSequence,
        previousDigest
      )
      if (seenCommandIds.has(record.commandId)) {
        throw new Error('Queued-start execution claim journal repeats a command identity')
      }
      seenCommandIds.add(record.commandId)
      if (header.schemaVersion === COMPACTED_SCHEMA_VERSION) {
        if (record.sequence >= header.nextSequence) {
          if (record.sequence !== nextSequence) {
            throw new Error('Queued-start execution claim journal append sequence is invalid')
          }
          nextSequence += 1
        }
      }
      if (
        options?.recoveryHeadSequence === undefined ||
        record.sequence <= options.recoveryHeadSequence
      ) {
        claims.set(record.commandId, {
          commandId: record.commandId,
          threadId: record.threadId,
          fingerprint: record.fingerprint,
          claimedAt: record.claimedAt
        })
        claimSequences.set(record.commandId, record.sequence)
      }
      previousSequence = record.sequence
      previousDigest = record.digest
    }
    const after = lstatSync(path)
    assertSafeFileStat(after)
    if (!sameFile(beforeIdentity, fileIdentity(after))) {
      throw new Error('Queued-start execution claim journal changed during read')
    }
    return {
      identity: beforeIdentity,
      schemaVersion: header.schemaVersion,
      coverageEpoch: header.coverageEpoch,
      lastDigest: previousDigest,
      nextSequence,
      physicalClaimCount: lines.length - 1,
      claims,
      claimSequences
    }
  } finally {
    closeSync(fd)
  }
}

function writeAll(
  io: HostNodeQueuedStartExecutionClaimJournalIo,
  fd: number,
  bytes: Uint8Array
): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = io.write(fd, bytes, offset, bytes.byteLength - offset)
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw new Error('Queued-start execution claim journal write made no progress')
    }
    offset += written
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function createJournal(
  dataDir: string,
  path: string,
  coverageEpoch: string,
  io: HostNodeQueuedStartExecutionClaimJournalIo
): void {
  const header: HeaderBody = {
    kind: 'header',
    schemaVersion: LEGACY_SCHEMA_VERSION,
    coverageEpoch
  }
  const temp = join(
    dataDir,
    `.${HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  )
  let fd: number | null = null
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      OWNER_FILE_MODE
    )
    writeAll(io, fd, encodeLine(header).bytes)
    io.fsyncFile(fd)
    closeSync(fd)
    fd = null
    linkSync(temp, path)
    unlinkSync(temp)
    syncDirectory(dataDir)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // Only our private temporary path is eligible for cleanup.
    }
    throw error
  }
}

class FileBackedQueuedStartExecutionClaimStore implements HostNodeQueuedStartExecutionClaimStore {
  readonly coverageEpoch: string
  readonly path: string
  private readonly dataDir: string
  private readonly io: HostNodeQueuedStartExecutionClaimJournalIo
  private readonly writeAllowed: boolean
  private readonly compactAfterRecords: number
  private schemaVersion: JournalSchemaVersion
  private claims: Map<string, HostQueuedStartExecutionClaim>
  private claimSequences: Map<string, number>
  private identity: JournalFileIdentity
  private lastDigest: string
  private nextSequence: number
  private physicalClaimCount: number
  private poisoned = false

  constructor(input: {
    dataDir: string
    path: string
    io: HostNodeQueuedStartExecutionClaimJournalIo
    loaded: LoadedJournal
    writeAllowed: boolean
    compactAfterRecords: number
  }) {
    this.dataDir = input.dataDir
    this.path = input.path
    this.io = input.io
    this.coverageEpoch = input.loaded.coverageEpoch
    this.writeAllowed = input.writeAllowed
    this.compactAfterRecords = input.compactAfterRecords
    this.schemaVersion = input.loaded.schemaVersion
    this.claims = input.loaded.claims
    this.claimSequences = input.loaded.claimSequences
    this.identity = input.loaded.identity
    this.lastDigest = input.loaded.lastDigest
    this.nextSequence = input.loaded.nextSequence
    this.physicalClaimCount = input.loaded.physicalClaimCount
  }

  get declaresDurableCoverage(): boolean {
    // A matching epoch cannot reveal rollback to an older valid prefix.
    return false
  }

  record(claim: HostQueuedStartExecutionClaim): HostQueuedStartExecutionClaimCursor {
    if (this.poisoned) {
      throw new Error('Queued-start execution claim journal is unavailable')
    }
    if (!this.writeAllowed) {
      throw new Error('Queued-start execution claim journal epoch does not match its writer')
    }
    if (!validClaim(claim)) {
      throw new Error('Invalid queued-start execution claim')
    }
    const existing = this.claims.get(claim.commandId)
    if (existing) {
      if (existing.threadId === claim.threadId && existing.fingerprint === claim.fingerprint) {
        // Idempotence cannot bless an exact-file loss that happened after the
        // first call. Re-verify before reporting the prior claim as durable.
        this.list()
        const sequence = this.claimSequences.get(claim.commandId)
        if (!sequence) throw new Error('Queued-start execution claim sequence is unavailable')
        return { coverageEpoch: this.coverageEpoch, sequence }
      }
      throw new Error('Queued-start execution claim identity conflict')
    }

    const body: ClaimBody = {
      kind: 'claim',
      schemaVersion: this.schemaVersion,
      sequence: this.nextSequence,
      previousDigest: this.lastDigest,
      commandId: claim.commandId,
      threadId: claim.threadId,
      fingerprint: claim.fingerprint,
      claimedAt: claim.claimedAt
    }
    const encoded = encodeLine(body)
    let fd: number | null = null
    try {
      const before = lstatSync(this.path)
      assertSafeFileStat(before)
      if (!sameFile(this.identity, fileIdentity(before))) {
        throw new Error('Queued-start execution claim journal changed before append')
      }
      fd = openSync(
        this.path,
        constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0)
      )
      const opened = fstatSync(fd)
      assertSafeFileStat(opened)
      if (!sameFile(this.identity, fileIdentity(opened))) {
        throw new Error('Queued-start execution claim journal changed before append')
      }
      writeAll(this.io, fd, encoded.bytes)
      this.io.fsyncFile(fd)
      const durable = fstatSync(fd)
      assertSafeFileStat(durable)
      const expectedSize = this.identity.size + encoded.bytes.byteLength
      const durableIdentity = fileIdentity(durable)
      if (
        durableIdentity.dev !== this.identity.dev ||
        durableIdentity.ino !== this.identity.ino ||
        durableIdentity.size !== expectedSize
      ) {
        throw new Error('Queued-start execution claim journal append was not durable')
      }
      closeSync(fd)
      fd = null
      const after = lstatSync(this.path)
      assertSafeFileStat(after)
      const nextIdentity = fileIdentity(after)
      if (!sameFile(durableIdentity, nextIdentity)) {
        throw new Error('Queued-start execution claim journal changed after append')
      }
      this.identity = nextIdentity
      this.lastDigest = encoded.digest
      this.nextSequence += 1
      this.physicalClaimCount += 1
      this.claims.set(claim.commandId, { ...claim })
      this.claimSequences.set(claim.commandId, body.sequence)
      return { coverageEpoch: this.coverageEpoch, sequence: body.sequence }
    } catch (error) {
      this.poisoned = true
      throw error
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  readClaims(
    cursors: readonly HostQueuedStartExecutionClaimCursor[]
  ): readonly (HostQueuedStartExecutionClaim | null)[] {
    if (this.poisoned) {
      throw new Error('Queued-start execution claim journal is unavailable')
    }
    if (!Array.isArray(cursors)) {
      throw new Error('Invalid queued-start execution claim cursor batch')
    }
    try {
      // Authenticate the complete current journal exactly once. This both
      // detects a valid-prefix rollback after open and avoids O(receipts ×
      // journal) startup work when receipt retention reaches its bound.
      const loaded = loadJournal(this.path)
      if (
        loaded.coverageEpoch !== this.coverageEpoch ||
        !sameFile(loaded.identity, this.identity) ||
        loaded.lastDigest !== this.lastDigest ||
        loaded.nextSequence !== this.nextSequence
      ) {
        throw new Error('Queued-start execution claim journal changed before cursor read')
      }
      const commandIdsBySequence = new Map<number, string>()
      for (const [commandId, sequence] of loaded.claimSequences) {
        commandIdsBySequence.set(sequence, commandId)
      }
      return cursors.map((cursor) => {
        if (
          !cursor ||
          typeof cursor !== 'object' ||
          !validEpoch(cursor.coverageEpoch) ||
          cursor.coverageEpoch !== loaded.coverageEpoch ||
          !Number.isSafeInteger(cursor.sequence) ||
          cursor.sequence < 1 ||
          cursor.sequence >= loaded.nextSequence
        ) {
          return null
        }
        const commandId = commandIdsBySequence.get(cursor.sequence)
        const claim = commandId ? loaded.claims.get(commandId) : undefined
        return claim ? { ...claim } : null
      })
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }

  compact(
    retainedCommandIds: ReadonlySet<string>
  ): HostNodeQueuedStartExecutionClaimCompactionResult {
    if (this.poisoned) {
      throw new Error('Queued-start execution claim journal is unavailable')
    }
    if (!this.writeAllowed) {
      throw new Error('Queued-start execution claim journal epoch does not match its writer')
    }
    if (
      !retainedCommandIds ||
      typeof retainedCommandIds !== 'object' ||
      typeof retainedCommandIds[Symbol.iterator] !== 'function'
    ) {
      throw new Error('Invalid queued-start execution claim retention set')
    }
    const retainedIds = new Set<string>()
    for (const commandId of retainedCommandIds) {
      if (!validOpaque(commandId)) {
        throw new Error('Invalid queued-start execution claim retention identity')
      }
      retainedIds.add(commandId)
    }
    const retainedCount = [...this.claims.keys()].filter((commandId) =>
      retainedIds.has(commandId)
    ).length
    if (this.physicalClaimCount < this.compactAfterRecords || retainedCount === this.claims.size) {
      return {
        kind: 'unchanged',
        physicalClaims: this.physicalClaimCount,
        retainedClaims: retainedCount
      }
    }

    const temp = join(
      this.dataDir,
      `.${HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME}.${process.pid}.${randomUUID()}.compact`
    )
    let fd: number | null = null
    let durableTempIdentity: JournalFileIdentity | null = null
    try {
      const loaded = loadJournal(this.path)
      if (
        loaded.coverageEpoch !== this.coverageEpoch ||
        !sameFile(loaded.identity, this.identity) ||
        loaded.lastDigest !== this.lastDigest ||
        loaded.nextSequence !== this.nextSequence
      ) {
        throw new Error('Queued-start execution claim journal changed before compaction')
      }
      const retained = [...loaded.claimSequences.entries()]
        .filter(([commandId]) => retainedIds.has(commandId))
        .sort((left, right) => left[1] - right[1])
        .map(([commandId, sequence]) => ({
          claim: loaded.claims.get(commandId)!,
          sequence
        }))
      if (retained.length === loaded.claims.size) {
        return {
          kind: 'unchanged',
          physicalClaims: loaded.physicalClaimCount,
          retainedClaims: retained.length
        }
      }

      const header: CompactedHeaderBody = {
        kind: 'header',
        schemaVersion: COMPACTED_SCHEMA_VERSION,
        coverageEpoch: this.coverageEpoch,
        nextSequence: loaded.nextSequence
      }
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        OWNER_FILE_MODE
      )
      let expectedSize = 0
      const encodedHeader = encodeLine(header)
      writeAll(this.io, fd, encodedHeader.bytes)
      expectedSize += encodedHeader.bytes.byteLength
      let previousDigest = encodedHeader.digest
      for (const entry of retained) {
        const body: ClaimBody = {
          kind: 'claim',
          schemaVersion: COMPACTED_SCHEMA_VERSION,
          sequence: entry.sequence,
          previousDigest,
          ...entry.claim
        }
        const encoded = encodeLine(body)
        writeAll(this.io, fd, encoded.bytes)
        expectedSize += encoded.bytes.byteLength
        previousDigest = encoded.digest
      }
      this.io.fsyncFile(fd)
      const durable = fstatSync(fd)
      assertSafeFileStat(durable)
      durableTempIdentity = fileIdentity(durable)
      if (durable.size !== expectedSize) {
        throw new Error('Queued-start execution claim compaction was not durable')
      }
      closeSync(fd)
      fd = null

      const beforeReplace = lstatSync(this.path)
      assertSafeFileStat(beforeReplace)
      if (
        !sameFile(loaded.identity, fileIdentity(beforeReplace)) ||
        realpathSync(this.path) !== this.path
      ) {
        throw new Error('Queued-start execution claim journal changed before replacement')
      }
      ;(this.io.rename ?? renameSync)(temp, this.path)
      const published = lstatSync(this.path)
      assertSafeFileStat(published)
      const publishedIdentity = fileIdentity(published)
      if (
        !durableTempIdentity ||
        publishedIdentity.dev !== durableTempIdentity.dev ||
        publishedIdentity.ino !== durableTempIdentity.ino ||
        publishedIdentity.size !== durableTempIdentity.size
      ) {
        // A valid rename can update ctime, so continuity is dev+ino+size.
        // Content equality alone cannot prove the fsynced inode was published.
        throw new Error('Queued-start execution claim compaction published a substituted file')
      }
      ;(this.io.fsyncDirectory ?? syncDirectory)(this.dataDir)
      if (realpathSync(this.path) !== this.path) {
        throw new Error('Queued-start execution claim journal replacement is not canonical')
      }

      const compacted = loadJournal(this.path)
      if (
        compacted.schemaVersion !== COMPACTED_SCHEMA_VERSION ||
        compacted.coverageEpoch !== this.coverageEpoch ||
        compacted.nextSequence !== loaded.nextSequence ||
        compacted.claims.size !== retained.length ||
        retained.some(
          ({ claim, sequence }) =>
            compacted.claimSequences.get(claim.commandId) !== sequence ||
            compacted.claims.get(claim.commandId)?.threadId !== claim.threadId ||
            compacted.claims.get(claim.commandId)?.fingerprint !== claim.fingerprint ||
            compacted.claims.get(claim.commandId)?.claimedAt !== claim.claimedAt
        )
      ) {
        throw new Error('Queued-start execution claim compaction verification failed')
      }
      this.schemaVersion = compacted.schemaVersion
      this.identity = compacted.identity
      this.lastDigest = compacted.lastDigest
      this.nextSequence = compacted.nextSequence
      this.physicalClaimCount = compacted.physicalClaimCount
      this.claims = compacted.claims
      this.claimSequences = compacted.claimSequences
      return {
        kind: 'compacted',
        physicalClaims: loaded.physicalClaimCount,
        retainedClaims: retained.length,
        nextSequence: compacted.nextSequence
      }
    } catch (error) {
      this.poisoned = true
      throw error
    } finally {
      if (fd !== null) closeSync(fd)
      try {
        unlinkSync(temp)
      } catch {
        // Only our private temporary path is eligible for cleanup. After a
        // successful rename it no longer exists; every other case removes it.
      }
    }
  }

  list(
    options?: HostQueuedStartExecutionClaimListOptions
  ): readonly HostQueuedStartExecutionClaim[] {
    const recoveryHeadSequence = resolveRecoveryHeadSequence(options)
    if (this.poisoned) {
      throw new Error('Queued-start execution claim journal is unavailable')
    }
    try {
      const loaded = loadJournal(
        this.path,
        recoveryHeadSequence === undefined ? undefined : { recoveryHeadSequence }
      )
      if (loaded.coverageEpoch !== this.coverageEpoch) {
        throw new Error('Queued-start execution claim journal changed before listing')
      }
      if (recoveryHeadSequence === undefined) {
        if (
          !sameFile(loaded.identity, this.identity) ||
          loaded.lastDigest !== this.lastDigest ||
          loaded.nextSequence !== this.nextSequence
        ) {
          throw new Error('Queued-start execution claim journal changed before listing')
        }
        this.schemaVersion = loaded.schemaVersion
        this.claims = loaded.claims
        this.claimSequences = loaded.claimSequences
        this.physicalClaimCount = loaded.physicalClaimCount
        return [...this.claims.values()].map((claim) => ({ ...claim }))
      }
      // A prefix read must not replace the writer cursor or require the tail
      // to match this instance's identity. The bound is not absence proof.
      return [...loaded.claims.values()].map((claim) => ({ ...claim }))
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }
}

/**
 * Open or create the claim journal without ever replacing an existing file.
 * A journal created by this call never establishes past coverage, and creation
 * is refused when its epoch equals the caller's expected historical epoch.
 */
export function openHostNodeQueuedStartExecutionClaimStore(
  options: HostNodeQueuedStartExecutionClaimStoreOptions
): HostNodeQueuedStartExecutionClaimStore {
  if (!options || typeof options !== 'object') {
    throw new Error('Queued-start execution claim store requires options')
  }
  if (
    !isAbsolute(options.dataDir) ||
    resolve(options.dataDir) === parse(resolve(options.dataDir)).root ||
    realpathSync(resolve(options.dataDir)) !== options.dataDir
  ) {
    throw new Error('Queued-start execution claim store requires a canonical non-root dataDir')
  }
  if (options.expectedCoverageEpoch !== undefined && !validEpoch(options.expectedCoverageEpoch)) {
    throw new Error('Invalid expected queued-start claim coverage epoch')
  }
  const compactAfterRecords = options.compactAfterRecords ?? DEFAULT_COMPACT_AFTER_RECORDS
  if (!Number.isSafeInteger(compactAfterRecords) || compactAfterRecords < 1) {
    throw new Error('Invalid queued-start execution claim compaction threshold')
  }
  const io = options.journalIo ?? DEFAULT_JOURNAL_IO
  if (
    !io ||
    typeof io.write !== 'function' ||
    typeof io.fsyncFile !== 'function' ||
    (io.rename !== undefined && typeof io.rename !== 'function') ||
    (io.fsyncDirectory !== undefined && typeof io.fsyncDirectory !== 'function')
  ) {
    throw new Error('Queued-start execution claim store requires valid journal I/O')
  }
  const path = join(options.dataDir, HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME)
  let loaded: LoadedJournal
  let existedBeforeOpen = true
  let createdByThisOpen = false
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    existedBeforeOpen = false
  }
  if (existedBeforeOpen) {
    // An ENOENT after this probe means a known file vanished during validation.
    // It is not authority to create a replacement.
    loaded = loadJournal(path)
  } else {
    const coverageEpoch = options.createCoverageEpoch?.() ?? randomBytes(32).toString('hex')
    if (!validEpoch(coverageEpoch)) {
      throw new Error('Invalid generated queued-start claim coverage epoch')
    }
    if (coverageEpoch === options.expectedCoverageEpoch) {
      throw new Error('Recreated queued-start claim coverage epoch must differ from expected')
    }
    try {
      createJournal(options.dataDir, path, coverageEpoch, io)
      createdByThisOpen = true
    } catch (creationError) {
      if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError
      // Another authority published first. Read it exactly; never replace it.
    }
    loaded = loadJournal(path)
  }

  const expectedMatches =
    options.expectedCoverageEpoch !== undefined &&
    options.expectedCoverageEpoch === loaded.coverageEpoch
  if (!existedBeforeOpen && expectedMatches) {
    throw new Error('Recreated queued-start claim coverage epoch must differ from expected')
  }

  return new FileBackedQueuedStartExecutionClaimStore({
    dataDir: options.dataDir,
    path,
    io,
    loaded,
    compactAfterRecords,
    writeAllowed:
      createdByThisOpen || options.expectedCoverageEpoch === undefined || expectedMatches
  })
}
