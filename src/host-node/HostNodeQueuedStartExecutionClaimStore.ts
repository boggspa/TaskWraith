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
 * durable absence coverage. A later receipt-bound recovery-head contract must
 * add that authority before lifecycle reopen may classify work unclaimed. This
 * module is deliberately not wired into production yet.
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
  type Stats,
  unlinkSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import type {
  HostQueuedStartExecutionClaim,
  HostQueuedStartExecutionClaimStore
} from './HostNodeQueuedStartLifecycle'

export const HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME =
  'host-queued-start-execution-claims-v1.jsonl'

const SCHEMA_VERSION = 1
const OWNER_FILE_MODE = 0o600
const MAX_FIELD_CHARS = 512
const MAX_LINE_BYTES = 4 * 1024
const EPOCH_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

type JournalFileIdentity = {
  readonly dev: string
  readonly ino: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

type HeaderBody = {
  readonly kind: 'header'
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly coverageEpoch: string
}

type ClaimBody = HostQueuedStartExecutionClaim & {
  readonly kind: 'claim'
  readonly schemaVersion: typeof SCHEMA_VERSION
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
}

export interface HostNodeQueuedStartExecutionClaimStoreOptions {
  /** Existing canonical non-root Host data directory. */
  readonly dataDir: string
  /** Expected writer epoch; a mismatched existing journal is read-only. */
  readonly expectedCoverageEpoch?: string
  /** Creation seam; output must be lowercase 64-hex. */
  readonly createCoverageEpoch?: () => string
  /** Narrow fault-injection seam; omitted in production. */
  readonly journalIo?: HostNodeQueuedStartExecutionClaimJournalIo
}

export interface HostNodeQueuedStartExecutionClaimStore extends HostQueuedStartExecutionClaimStore {
  /** Writer epoch for future receipt + recovery-head binding; not absence proof alone. */
  readonly coverageEpoch: string
  /** Absolute journal path, exposed for diagnostics and focused recovery tests. */
  readonly path: string
}

const DEFAULT_JOURNAL_IO: HostNodeQueuedStartExecutionClaimJournalIo = {
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncFile: (fd) => fsyncSync(fd)
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
    !exactKeys(value, ['kind', 'schemaVersion', 'coverageEpoch', 'digest']) ||
    value.kind !== 'header' ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !validEpoch(value.coverageEpoch) ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new Error('Invalid queued-start execution claim journal header')
  }
  const body: HeaderBody = {
    kind: 'header',
    schemaVersion: SCHEMA_VERSION,
    coverageEpoch: value.coverageEpoch
  }
  if (digestBody(body) !== value.digest) {
    throw new Error('Invalid queued-start execution claim journal header digest')
  }
  return { ...body, digest: value.digest }
}

function parseClaim(raw: unknown, sequence: number, previousDigest: string): ClaimLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid queued-start execution claim journal record')
  }
  const value = raw as Record<string, unknown>
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
    value.schemaVersion !== SCHEMA_VERSION ||
    value.sequence !== sequence ||
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
    schemaVersion: SCHEMA_VERSION,
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
  readonly coverageEpoch: string
  readonly lastDigest: string
  readonly nextSequence: number
  readonly claims: Map<string, HostQueuedStartExecutionClaim>
}

function loadJournal(path: string): LoadedJournal {
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
    const header = parseHeader(JSON.parse(lines[0]))
    const claims = new Map<string, HostQueuedStartExecutionClaim>()
    let previousDigest = header.digest
    for (let index = 1; index < lines.length; index += 1) {
      const record = parseClaim(JSON.parse(lines[index]), index, previousDigest)
      if (claims.has(record.commandId)) {
        throw new Error('Queued-start execution claim journal repeats a command identity')
      }
      claims.set(record.commandId, {
        commandId: record.commandId,
        threadId: record.threadId,
        fingerprint: record.fingerprint,
        claimedAt: record.claimedAt
      })
      previousDigest = record.digest
    }
    const after = lstatSync(path)
    assertSafeFileStat(after)
    if (!sameFile(beforeIdentity, fileIdentity(after))) {
      throw new Error('Queued-start execution claim journal changed during read')
    }
    return {
      identity: beforeIdentity,
      coverageEpoch: header.coverageEpoch,
      lastDigest: previousDigest,
      nextSequence: lines.length,
      claims
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
  const header: HeaderBody = { kind: 'header', schemaVersion: SCHEMA_VERSION, coverageEpoch }
  const temp = join(
    dataDir,
    `.${HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  )
  let fd: number | null = null
  try {
    fd = openSync(temp, 'wx', OWNER_FILE_MODE)
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
  private readonly io: HostNodeQueuedStartExecutionClaimJournalIo
  private readonly writeAllowed: boolean
  private claims: Map<string, HostQueuedStartExecutionClaim>
  private identity: JournalFileIdentity
  private lastDigest: string
  private nextSequence: number
  private poisoned = false

  constructor(input: {
    path: string
    io: HostNodeQueuedStartExecutionClaimJournalIo
    loaded: LoadedJournal
    writeAllowed: boolean
  }) {
    this.path = input.path
    this.io = input.io
    this.coverageEpoch = input.loaded.coverageEpoch
    this.writeAllowed = input.writeAllowed
    this.claims = input.loaded.claims
    this.identity = input.loaded.identity
    this.lastDigest = input.loaded.lastDigest
    this.nextSequence = input.loaded.nextSequence
  }

  get declaresDurableCoverage(): boolean {
    // A matching epoch cannot reveal rollback to an older valid prefix.
    return false
  }

  record(claim: HostQueuedStartExecutionClaim): void {
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
        return
      }
      throw new Error('Queued-start execution claim identity conflict')
    }

    const body: ClaimBody = {
      kind: 'claim',
      schemaVersion: SCHEMA_VERSION,
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
      this.claims.set(claim.commandId, { ...claim })
    } catch (error) {
      this.poisoned = true
      throw error
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  list(): readonly HostQueuedStartExecutionClaim[] {
    if (this.poisoned) {
      throw new Error('Queued-start execution claim journal is unavailable')
    }
    try {
      const loaded = loadJournal(this.path)
      if (
        loaded.coverageEpoch !== this.coverageEpoch ||
        !sameFile(loaded.identity, this.identity) ||
        loaded.lastDigest !== this.lastDigest ||
        loaded.nextSequence !== this.nextSequence
      ) {
        throw new Error('Queued-start execution claim journal changed before listing')
      }
      this.claims = loaded.claims
      return [...this.claims.values()].map((claim) => ({ ...claim }))
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
  const io = options.journalIo ?? DEFAULT_JOURNAL_IO
  if (!io || typeof io.write !== 'function' || typeof io.fsyncFile !== 'function') {
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
    path,
    io,
    loaded,
    writeAllowed:
      createdByThisOpen || options.expectedCoverageEpoch === undefined || expectedMatches
  })
}
