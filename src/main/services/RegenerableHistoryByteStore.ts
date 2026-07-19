import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const JOURNAL_VERSION = 1
const JOURNAL_MAX_BYTES = 16 * 1024
const GENERATION_PREFIX = 'g-'

export type RegenerableHistoryByteKind = 'media' | 'pdf'

export type RegenerableHistoryByteStoreTestStep =
  | 'after_journal_write'
  | 'after_journal_bytes_read'
  | 'after_root_rename'
  | 'after_root_purge'
  | 'after_content_purge'
  | 'after_generation_create'
  | 'before_file_unlink'
  | 'before_journal_unlink'

export interface RegenerableHistoryByteStoreOptions {
  roots: Readonly<Record<RegenerableHistoryByteKind, string>>
  journalPath: string
  testHook?: (
    step: RegenerableHistoryByteStoreTestStep,
    detail: { kind?: RegenerableHistoryByteKind; operationId: string; filePath?: string }
  ) => void | Promise<void>
}

declare const regenerableHistoryByteReservationBrand: unique symbol

export type RegenerableHistoryByteReservation = Readonly<{
  id: string
  kind: RegenerableHistoryByteKind
  generationId: string
  root: string
  [regenerableHistoryByteReservationBrand]: true
}>

declare const regenerableHistoryByteHoldBrand: unique symbol

export type RegenerableHistoryByteHistoryHold = Readonly<{
  id: string
  operationId: string
  [regenerableHistoryByteHoldBrand]: true
}>

interface PurgeJournal {
  version: 1
  operationId: string
  state: 'pending' | 'purged'
  roots: Readonly<Record<RegenerableHistoryByteKind, DurableManagedRootIdentity | null>>
}

interface DurableFileIdentity {
  dev: string
  ino: string
}

interface JournalFileSnapshot {
  identity: DurableFileIdentity
  size: bigint
  mode: bigint
  nlink: bigint
  uid: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface OpenJournalFile {
  fd: number
  raw: Buffer
  digest: string
  snapshot: JournalFileSnapshot
}

interface JournalReceipt {
  operationId: string
  digest: string
  snapshot: JournalFileSnapshot
}

interface DurableManagedRootIdentity {
  base: DurableFileIdentity
  phase: 'present' | 'quarantined' | 'purged'
  generation?: {
    name: string
    identity: DurableFileIdentity
  }
}

interface ActiveReservation {
  token: RegenerableHistoryByteReservation
  done: Promise<void>
  resolve: () => void
}

interface ActiveGeneration {
  id: string
  roots: Readonly<Record<RegenerableHistoryByteKind, string>>
  baseIdentities: Readonly<Record<RegenerableHistoryByteKind, DurableFileIdentity>>
  rootIdentities: Readonly<Record<RegenerableHistoryByteKind, DurableFileIdentity>>
}

interface TreeEntry {
  filePath: string
  stat: fs.BigIntStats
  directory: boolean
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  if (left.ino !== right.ino) return false
  return process.platform === 'win32' || left.dev === right.dev
}

function durableFileIdentity(stat: fs.BigIntStats): DurableFileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function journalFileSnapshot(stat: fs.BigIntStats): JournalFileSnapshot {
  return {
    identity: durableFileIdentity(stat),
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  }
}

function sameJournalFileSnapshot(left: JournalFileSnapshot, right: JournalFileSnapshot): boolean {
  return (
    left.identity.ino === right.identity.ino &&
    (process.platform === 'win32' || left.identity.dev === right.identity.dev) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function serializeJournal(journal: PurgeJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8')
}

function digestBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function statMatchesDurableIdentity(stat: fs.BigIntStats, identity: DurableFileIdentity): boolean {
  return (
    String(stat.ino) === identity.ino &&
    (process.platform === 'win32' || String(stat.dev) === identity.dev)
  )
}

function currentUid(): bigint | null {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
}

function pathExistsNoFollow(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

function assertOwnedDirectory(filePath: string, stat: fs.BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Regenerable history-byte directory is unsafe: ${filePath}`)
  }
  const uid = currentUid()
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Regenerable history-byte directory has the wrong owner: ${filePath}`)
  }
  if (process.platform !== 'win32' && (stat.mode & 0o022n) !== 0n) {
    throw new Error(`Regenerable history-byte directory is group/world writable: ${filePath}`)
  }
}

function lstatOwnedDirectory(filePath: string): fs.BigIntStats {
  const before = fs.lstatSync(filePath, { bigint: true })
  assertOwnedDirectory(filePath, before)
  const canonical = fs.realpathSync.native(filePath)
  const after = fs.statSync(canonical, { bigint: true })
  assertOwnedDirectory(filePath, after)
  if (!sameFileIdentity(before, after)) {
    throw new Error(`Regenerable history-byte directory changed during validation: ${filePath}`)
  }
  return before
}

function assertOwnedRegularFile(filePath: string, stat: fs.BigIntStats): void {
  const uid = currentUid()
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Regenerable history-byte entry is not a regular file: ${filePath}`)
  }
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Regenerable history-byte file has the wrong owner: ${filePath}`)
  }
  if (stat.nlink !== 1n) {
    throw new Error(`Regenerable history-byte file has multiple hard links: ${filePath}`)
  }
}

function assertOwnedJournalFile(filePath: string, stat: fs.BigIntStats): void {
  assertOwnedRegularFile(filePath, stat)
  if (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) {
    throw new Error(`Regenerable history-byte journal permissions are unsafe: ${filePath}`)
  }
}

function fsyncDirectoryStrict(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32') throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EINVAL') throw error
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
    if (written <= 0) throw new Error('Regenerable history-byte journal write was short.')
    offset += written
  }
}

function validateOperationId(operationId: string): string {
  const normalized = operationId.trim()
  if (!normalized || normalized.length > 512 || normalized.includes('\0')) {
    throw new Error('Regenerable history-byte mutation has an invalid operation id.')
  }
  return normalized
}

function parseDurableFileIdentity(value: unknown): DurableFileIdentity | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.dev !== 'string' ||
    typeof record.ino !== 'string' ||
    !/^\d{1,32}$/.test(record.dev) ||
    !/^\d{1,32}$/.test(record.ino)
  ) {
    return undefined
  }
  return { dev: record.dev, ino: record.ino }
}

function parseDurableManagedRootIdentity(
  value: unknown
): DurableManagedRootIdentity | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const base = parseDurableFileIdentity(record.base)
  if (
    !base ||
    (record.phase !== 'present' && record.phase !== 'quarantined' && record.phase !== 'purged')
  ) {
    return undefined
  }
  if (record.generation === undefined) {
    return { base, phase: record.phase }
  }
  if (
    !record.generation ||
    typeof record.generation !== 'object' ||
    Array.isArray(record.generation)
  ) {
    return undefined
  }
  const generation = record.generation as Record<string, unknown>
  const identity = parseDurableFileIdentity(generation.identity)
  if (
    typeof generation.name !== 'string' ||
    !/^g-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      generation.name
    ) ||
    !identity
  ) {
    return undefined
  }
  return {
    base,
    phase: record.phase,
    generation: { name: generation.name, identity }
  }
}

function validateConfiguredPath(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new Error(`${label} must be an absolute local path.`)
  }
  return path.resolve(filePath)
}

/**
 * Owns short-lived, regenerable bytes which are still part of the user's
 * history boundary: rendered PDF pages and media/recording staging files.
 *
 * The store never reuses a generation path. Destructive history work closes
 * admission synchronously, joins every admitted operation, then renames each
 * root to an operation-qualified quarantine before validating and unlinking
 * it without following links. A small fsynced journal makes an interrupted
 * rename/purge recoverable before startup admission reopens.
 */
export class RegenerableHistoryByteStore {
  private readonly roots: Readonly<Record<RegenerableHistoryByteKind, string>>
  private readonly journalPath: string
  private readonly journalParent: string
  private readonly testHook?: RegenerableHistoryByteStoreOptions['testHook']
  private initialized = false
  private initializationError: unknown = null
  private admissionBlocked = true
  private activeGeneration: ActiveGeneration | null = null
  private activeOperationId: string | null = null
  private activeHold: RegenerableHistoryByteHistoryHold | null = null
  private activeOperationPurged = false
  private activePurgeInProgress = false
  private activeRootIdentities: Readonly<
    Record<RegenerableHistoryByteKind, DurableManagedRootIdentity | null>
  > | null = null
  private activeJournalReceipt: JournalReceipt | null = null
  private readonly reservations = new Map<string, ActiveReservation>()

  constructor(options: RegenerableHistoryByteStoreOptions) {
    const media = validateConfiguredPath(options.roots.media, 'Media staging root')
    const pdf = validateConfiguredPath(options.roots.pdf, 'PDF cache root')
    if (
      media === pdf ||
      media.startsWith(`${pdf}${path.sep}`) ||
      pdf.startsWith(`${media}${path.sep}`)
    ) {
      throw new Error('Regenerable history-byte roots must be distinct and non-nested.')
    }
    const journalPath = validateConfiguredPath(options.journalPath, 'History-byte journal path')
    if (
      journalPath === media ||
      journalPath === pdf ||
      journalPath.startsWith(`${media}${path.sep}`) ||
      journalPath.startsWith(`${pdf}${path.sep}`)
    ) {
      throw new Error('Regenerable history-byte journal must live outside managed roots.')
    }
    this.roots = { media, pdf }
    this.journalPath = journalPath
    this.journalParent = path.dirname(journalPath)
    this.testHook = options.testHook
  }

  /**
   * Purges every legacy/current generation before admitting the first startup
   * operation. When an outer deletion is pending, the recovered admission
   * fence remains closed for that exact operation until its coordinator
   * reacquires and releases a process-local hold.
   */
  async initializeStrict(pendingOuterOperationId?: string): Promise<void> {
    if (this.initialized || this.initializationError) {
      throw new Error('Regenerable history-byte store was already initialized.')
    }
    this.admissionBlocked = true
    try {
      lstatOwnedDirectory(this.journalParent)
      this.removeAbandonedJournalTempsStrict()
      const existing = this.readJournalStrict()
      const pending = pendingOuterOperationId ? validateOperationId(pendingOuterOperationId) : null
      if (existing && pending && existing.operationId !== pending) {
        throw new Error(
          `History-byte journal belongs to ${existing.operationId}, not pending deletion ${pending}.`
        )
      }
      const operationId = existing?.operationId ?? pending ?? `startup-${randomUUID()}`
      const rootIdentities = existing?.roots ?? this.captureManagedRootIdentitiesStrict()
      if (!existing) {
        this.writeJournalStrict({
          version: 1,
          operationId,
          state: 'pending',
          roots: rootIdentities
        })
      }
      this.activeOperationId = operationId
      this.activeOperationPurged = false
      this.activeRootIdentities = rootIdentities
      await this.purgeAllRootsStrict(operationId)
      this.assertAllRootsPurgedStrict(operationId)
      this.writeActiveJournalStrict('purged')
      this.activeOperationPurged = true

      if (pending) {
        this.initialized = true
        return
      }

      this.removeJournalStrict()
      this.createFreshGenerationRootsStrict()
      this.activeOperationId = null
      this.activeOperationPurged = false
      this.activeRootIdentities = null
      this.admissionBlocked = false
      this.initialized = true
    } catch (error) {
      this.initializationError = error
      this.activeGeneration = null
      this.admissionBlocked = true
      throw error
    }
  }

  begin(kind: RegenerableHistoryByteKind): RegenerableHistoryByteReservation {
    this.assertAvailable()
    if (this.admissionBlocked || !this.activeGeneration) {
      throw new Error('Regenerable history-byte admission is closed for history deletion.')
    }
    const root = this.activeGeneration.roots[kind]
    this.assertActiveGenerationIdentity(kind)
    const id = randomUUID()
    const token = {
      id,
      kind,
      generationId: this.activeGeneration.id,
      root
    } as RegenerableHistoryByteReservation
    let resolve!: () => void
    const done = new Promise<void>((settle) => {
      resolve = settle
    })
    this.reservations.set(id, { token, done, resolve })
    return token
  }

  isCurrent(reservation: RegenerableHistoryByteReservation): boolean {
    const active = this.reservations.get(reservation.id)
    const current = Boolean(
      active &&
      active.token === reservation &&
      !this.admissionBlocked &&
      this.activeGeneration?.id === reservation.generationId &&
      this.activeGeneration.roots[reservation.kind] === reservation.root
    )
    if (!current) return false
    try {
      this.assertActiveGenerationIdentity(reservation.kind)
      return true
    } catch {
      return false
    }
  }

  end(reservation: RegenerableHistoryByteReservation): boolean {
    const active = this.reservations.get(reservation.id)
    if (!active || active.token !== reservation) return false
    this.reservations.delete(reservation.id)
    active.resolve()
    return true
  }

  beginHistoryMutation(operationIdRaw: string): RegenerableHistoryByteHistoryHold {
    this.assertAvailable()
    const operationId = validateOperationId(operationIdRaw)
    if (this.activeHold) {
      throw new Error('Regenerable history-byte history mutation already has an active hold.')
    }
    if (this.activeOperationId && this.activeOperationId !== operationId) {
      throw new Error(
        `Regenerable history-byte mutation ${this.activeOperationId} is still pending.`
      )
    }

    const adoptingStartupFence = this.activeOperationId === operationId
    this.admissionBlocked = true
    let validateActiveGeneration = false
    if (!adoptingStartupFence) {
      this.activeOperationId = operationId
      this.activeOperationPurged = false
      // Snapshot the already-pinned identities without touching the live path.
      // They must reach the journal before live validation can fail, otherwise
      // a restart could mistake a replacement root for the deleted original.
      this.activeRootIdentities = this.snapshotActiveGenerationRootIdentitiesStrict()
      validateActiveGeneration = true
    } else if (!this.activeRootIdentities) {
      this.activeRootIdentities = this.activeGeneration
        ? this.snapshotActiveGenerationRootIdentitiesStrict()
        : this.captureManagedRootIdentitiesStrict()
      validateActiveGeneration = Boolean(this.activeGeneration)
    } else {
      validateActiveGeneration = Boolean(this.activeGeneration)
    }
    // The write may reach rename before a directory-fsync failure. The outer
    // deletion intent is already durable, so failure deliberately leaves byte
    // admission fenced; every exact-operation retry rewrites this journal.
    this.writeJournalStrict({
      version: 1,
      operationId,
      state: this.activeOperationPurged ? 'purged' : 'pending',
      roots: this.activeRootIdentities
    })
    if (validateActiveGeneration) {
      for (const kind of ['media', 'pdf'] as const) this.assertActiveGenerationIdentity(kind)
    }
    const hold = { id: randomUUID(), operationId } as RegenerableHistoryByteHistoryHold
    this.activeHold = hold
    return hold
  }

  async purgeStrict(hold: RegenerableHistoryByteHistoryHold): Promise<void> {
    this.assertActiveHold(hold)
    if (this.activePurgeInProgress) {
      throw new Error('Regenerable history-byte strict purge is already in progress.')
    }
    this.activePurgeInProgress = true
    try {
      await Promise.all([...this.reservations.values()].map((reservation) => reservation.done))
      this.assertActiveHold(hold)
      if (this.reservations.size !== 0) {
        throw new Error('Regenerable history-byte operations did not quiesce exactly.')
      }
      this.activeOperationPurged = false
      await this.purgeAllRootsStrict(hold.operationId)
      this.assertActiveHold(hold)
      this.assertAllRootsPurgedStrict(hold.operationId)
      this.writeActiveJournalStrict('purged')
      this.activeOperationPurged = true
    } finally {
      this.activePurgeInProgress = false
    }
  }

  /** Release only after the durable outer history deletion has committed. */
  endHistoryMutation(hold: RegenerableHistoryByteHistoryHold): boolean {
    this.assertActiveHold(hold)
    if (!this.activeOperationPurged) {
      throw new Error('Regenerable history-byte mutation was released before strict purge.')
    }
    this.removeJournalStrict()
    if (!this.activeGeneration) this.createFreshGenerationRootsStrict()
    this.activeHold = null
    this.activeOperationId = null
    this.activeOperationPurged = false
    this.activeRootIdentities = null
    this.admissionBlocked = false
    return true
  }

  /**
   * Relinquish only this process-local hold when a wider synchronous hold
   * acquisition fails. The durable outer deletion still exists, so admission
   * and its correlated journal remain fenced for a same-operation retry.
   */
  cancelHistoryMutation(hold: RegenerableHistoryByteHistoryHold): boolean {
    this.assertActiveHold(hold)
    if (this.activePurgeInProgress) {
      throw new Error('Regenerable history-byte purge cannot be cancelled while in progress.')
    }
    this.activeHold = null
    return true
  }

  private assertAvailable(): void {
    if (this.initializationError) {
      throw new Error('Regenerable history-byte startup recovery failed.', {
        cause: this.initializationError
      })
    }
    if (!this.initialized) {
      throw new Error('Regenerable history-byte store is not initialized.')
    }
  }

  private assertActiveHold(hold: RegenerableHistoryByteHistoryHold): void {
    this.assertAvailable()
    if (
      !this.activeHold ||
      this.activeHold !== hold ||
      this.activeOperationId !== hold.operationId ||
      !this.admissionBlocked
    ) {
      throw new Error('Regenerable history-byte history hold is not active.')
    }
  }

  private quarantinePath(kind: RegenerableHistoryByteKind, operationId: string): string {
    const root = this.roots[kind]
    const digest = createHash('sha256').update(operationId).digest('hex').slice(0, 32)
    return path.join(path.dirname(root), `.${path.basename(root)}.history-purge-${digest}`)
  }

  private captureManagedRootIdentitiesStrict(): Readonly<
    Record<RegenerableHistoryByteKind, DurableManagedRootIdentity | null>
  > {
    const captured: Record<RegenerableHistoryByteKind, DurableManagedRootIdentity | null> = {
      media: null,
      pdf: null
    }
    for (const kind of ['media', 'pdf'] as const) {
      try {
        captured[kind] = {
          base: durableFileIdentity(lstatOwnedDirectory(this.roots[kind])),
          phase: 'present'
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
    }
    return captured
  }

  private snapshotActiveGenerationRootIdentitiesStrict(): Readonly<
    Record<RegenerableHistoryByteKind, DurableManagedRootIdentity>
  > {
    const generation = this.activeGeneration
    if (!generation) {
      throw new Error('Regenerable history-byte generation is unavailable for deletion.')
    }
    const captured = {} as Record<RegenerableHistoryByteKind, DurableManagedRootIdentity>
    for (const kind of ['media', 'pdf'] as const) {
      captured[kind] = {
        base: generation.baseIdentities[kind],
        phase: 'present',
        generation: {
          name: path.basename(generation.roots[kind]),
          identity: generation.rootIdentities[kind]
        }
      }
    }
    return captured
  }

  private updateRootPhase(
    kind: RegenerableHistoryByteKind,
    phase: DurableManagedRootIdentity['phase']
  ): void {
    const identities = this.activeRootIdentities
    const current = identities?.[kind]
    if (!identities || !current) {
      throw new Error(`Regenerable history-byte ${kind} root has no journaled identity.`)
    }
    this.activeRootIdentities = {
      ...identities,
      [kind]: { ...current, phase }
    }
  }

  private writeActiveJournalStrict(state: PurgeJournal['state']): void {
    if (!this.activeOperationId || !this.activeRootIdentities) {
      throw new Error('Regenerable history-byte purge lost its active journal state.')
    }
    this.writeJournalStrict({
      version: 1,
      operationId: this.activeOperationId,
      state,
      roots: this.activeRootIdentities
    })
  }

  private assertActiveGenerationIdentity(kind: RegenerableHistoryByteKind): void {
    const generation = this.activeGeneration
    if (!generation) {
      throw new Error('Regenerable history-byte generation is unavailable.')
    }
    const baseStat = lstatOwnedDirectory(this.roots[kind])
    if (!statMatchesDurableIdentity(baseStat, generation.baseIdentities[kind])) {
      throw new Error(`Regenerable history-byte base identity changed: ${this.roots[kind]}`)
    }
    const rootStat = lstatOwnedDirectory(generation.roots[kind])
    if (!statMatchesDurableIdentity(rootStat, generation.rootIdentities[kind])) {
      throw new Error(
        `Regenerable history-byte generation identity changed: ${generation.roots[kind]}`
      )
    }
  }

  private assertManagedRootIdentity(
    root: string,
    expected: DurableManagedRootIdentity,
    options: { requireGeneration: boolean; label: 'root' | 'quarantine' }
  ): void {
    const rootStat = lstatOwnedDirectory(root)
    if (!statMatchesDurableIdentity(rootStat, expected.base)) {
      throw new Error(`Regenerable history-byte ${options.label} identity changed: ${root}`)
    }
    if (!options.requireGeneration || !expected.generation) return
    const generationPath = path.join(root, expected.generation.name)
    const generationStat = lstatOwnedDirectory(generationPath)
    if (!statMatchesDurableIdentity(generationStat, expected.generation.identity)) {
      throw new Error(`Regenerable history-byte generation identity changed: ${generationPath}`)
    }
  }

  private async purgeAllRootsStrict(operationId: string): Promise<void> {
    if (!this.activeRootIdentities) {
      throw new Error('Regenerable history-byte purge has no durable root identities.')
    }
    this.activeGeneration = null
    for (const kind of ['media', 'pdf'] as const) {
      await this.purgeRootStrict(kind, operationId)
    }
  }

  private assertAllRootsPurgedStrict(operationId: string): void {
    const identities = this.activeRootIdentities
    if (!identities) {
      throw new Error('Regenerable history-byte purge has no terminal identity state.')
    }
    for (const kind of ['media', 'pdf'] as const) {
      const expected = identities[kind]
      const root = this.roots[kind]
      const quarantine = this.quarantinePath(kind, operationId)
      if (expected && expected.phase !== 'purged') {
        throw new Error(`Regenerable history-byte ${kind} root is not durably purged.`)
      }
      if (pathExistsNoFollow(root) || pathExistsNoFollow(quarantine)) {
        throw new Error(`Regenerable history-byte ${kind} path reappeared before completion.`)
      }
    }
  }

  private async purgeRootStrict(
    kind: RegenerableHistoryByteKind,
    operationId: string
  ): Promise<void> {
    const root = this.roots[kind]
    const parent = path.dirname(root)
    const quarantine = this.quarantinePath(kind, operationId)
    let expected = this.activeRootIdentities?.[kind] ?? null
    lstatOwnedDirectory(parent)

    if (!expected) {
      if (pathExistsNoFollow(root) || pathExistsNoFollow(quarantine)) {
        throw new Error(
          `Regenerable history-byte ${kind} path appeared without a journaled identity.`
        )
      }
      return
    }

    if (expected.phase === 'purged') {
      if (pathExistsNoFollow(root)) {
        throw new Error(`Regenerable history-byte root reappeared after purge: ${root}`)
      }
      if (pathExistsNoFollow(quarantine)) {
        this.assertManagedRootIdentity(quarantine, expected, {
          requireGeneration: false,
          label: 'quarantine'
        })
        this.removePreservedGenerationDirectoryStrict(quarantine, expected)
        if (fs.readdirSync(quarantine).length !== 0) {
          throw new Error(`Regenerable history-byte purged quarantine is not empty: ${quarantine}`)
        }
        fs.rmdirSync(quarantine)
        fsyncDirectoryStrict(parent)
      }
      return
    }

    const rootExists = pathExistsNoFollow(root)
    const quarantineExists = pathExistsNoFollow(quarantine)
    if (expected.phase === 'present') {
      if (quarantineExists) {
        this.assertManagedRootIdentity(quarantine, expected, {
          requireGeneration: true,
          label: 'quarantine'
        })
      }
      if (rootExists && quarantineExists) {
        throw new Error(`Regenerable history-byte root and quarantine both exist for ${kind}.`)
      }
      if (rootExists) {
        this.assertManagedRootIdentity(root, expected, {
          requireGeneration: true,
          label: 'root'
        })
        fs.renameSync(root, quarantine)
        fsyncDirectoryStrict(parent)
        await this.testHook?.('after_root_rename', { kind, operationId })
      } else if (!quarantineExists) {
        throw new Error(`Regenerable history-byte journaled root disappeared before purge: ${root}`)
      }
      if (!quarantineExists) {
        this.assertManagedRootIdentity(quarantine, expected, {
          requireGeneration: true,
          label: 'quarantine'
        })
      }
      this.updateRootPhase(kind, 'quarantined')
      this.writeActiveJournalStrict('pending')
      expected = this.activeRootIdentities![kind]!
    }

    if (pathExistsNoFollow(root)) {
      throw new Error(`Regenerable history-byte root reappeared during purge: ${root}`)
    }
    if (!pathExistsNoFollow(quarantine)) {
      throw new Error(`Regenerable history-byte quarantine disappeared before purge: ${quarantine}`)
    }
    this.assertManagedRootIdentity(quarantine, expected, {
      requireGeneration: true,
      label: 'quarantine'
    })
    this.removeTreeContentsStrict(quarantine, expected, kind, operationId)
    if (expected.generation) {
      fsyncDirectoryStrict(path.join(quarantine, expected.generation.name))
    }
    fsyncDirectoryStrict(quarantine)
    fsyncDirectoryStrict(parent)
    await this.testHook?.('after_content_purge', { kind, operationId })
    this.updateRootPhase(kind, 'purged')
    this.writeActiveJournalStrict('pending')
    await this.testHook?.('after_root_purge', { kind, operationId })

    const purgedExpected = this.activeRootIdentities![kind]!
    this.assertManagedRootIdentity(quarantine, purgedExpected, {
      requireGeneration: false,
      label: 'quarantine'
    })
    this.removePreservedGenerationDirectoryStrict(quarantine, purgedExpected)
    if (fs.readdirSync(quarantine).length !== 0) {
      throw new Error(`Regenerable history-byte quarantine repopulated after purge: ${quarantine}`)
    }
    fs.rmdirSync(quarantine)
    fsyncDirectoryStrict(parent)
  }

  private removeTreeContentsStrict(
    root: string,
    expectedRootIdentity: DurableManagedRootIdentity,
    kind: RegenerableHistoryByteKind,
    operationId: string
  ): void {
    const rootStat = fs.lstatSync(root, { bigint: true })
    assertOwnedDirectory(root, rootStat)
    if (!statMatchesDurableIdentity(rootStat, expectedRootIdentity.base)) {
      throw new Error(`Regenerable history-byte quarantine identity changed: ${root}`)
    }
    const entries: TreeEntry[] = []
    const preservedGenerationPath = expectedRootIdentity.generation
      ? path.join(root, expectedRootIdentity.generation.name)
      : null
    const pending: Array<{ filePath: string; visited: boolean }> = fs
      .readdirSync(root)
      .sort()
      .reverse()
      .map((name) => ({ filePath: path.join(root, name), visited: false }))
    while (pending.length > 0) {
      const next = pending.pop()!
      const stat = fs.lstatSync(next.filePath, { bigint: true })
      if (next.visited) {
        assertOwnedDirectory(next.filePath, stat)
        if (next.filePath !== preservedGenerationPath) {
          entries.push({ filePath: next.filePath, stat, directory: true })
        }
        continue
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Regenerable history-byte purge refused a symlink: ${next.filePath}`)
      }
      if (stat.isDirectory()) {
        assertOwnedDirectory(next.filePath, stat)
        pending.push({ filePath: next.filePath, visited: true })
        const children = fs.readdirSync(next.filePath).sort().reverse()
        for (const child of children) {
          pending.push({ filePath: path.join(next.filePath, child), visited: false })
        }
      } else {
        assertOwnedRegularFile(next.filePath, stat)
        entries.push({ filePath: next.filePath, stat, directory: false })
      }
    }

    // Validate the complete tree before removing its first entry, then repeat
    // identity checks at each unlink/rmdir boundary. Regular-file descriptors
    // also expose most late replacements after unlink. Node does not provide a
    // portable parent-fd-relative unlink/rmdir primitive, however, so a
    // same-UID process can still win the final pathname-check race. Observed
    // identity changes fail closed, but portable Node cannot prevent or reliably
    // detect that final substitution. This code does not claim race-free
    // deletion against another process which already controls this user's data
    // directory.
    for (const entry of entries) {
      const current = fs.lstatSync(entry.filePath, { bigint: true })
      if (!sameFileIdentity(current, entry.stat)) {
        throw new Error(`Regenerable history-byte entry changed during purge: ${entry.filePath}`)
      }
      if (entry.directory) {
        assertOwnedDirectory(entry.filePath, current)
        fs.rmdirSync(entry.filePath)
      } else {
        assertOwnedRegularFile(entry.filePath, current)
        this.unlinkRegularFileStrict(entry, kind, operationId)
      }
    }
  }

  private removePreservedGenerationDirectoryStrict(
    quarantine: string,
    expected: DurableManagedRootIdentity
  ): void {
    if (!expected.generation) return
    const generationPath = path.join(quarantine, expected.generation.name)
    if (!pathExistsNoFollow(generationPath)) return
    const generationStat = lstatOwnedDirectory(generationPath)
    if (!statMatchesDurableIdentity(generationStat, expected.generation.identity)) {
      throw new Error(
        `Regenerable history-byte preserved generation identity changed: ${generationPath}`
      )
    }
    if (fs.readdirSync(generationPath).length !== 0) {
      throw new Error(
        `Regenerable history-byte preserved generation is not empty: ${generationPath}`
      )
    }
    fs.rmdirSync(generationPath)
    fsyncDirectoryStrict(quarantine)
  }

  private unlinkRegularFileStrict(
    entry: TreeEntry,
    kind: RegenerableHistoryByteKind,
    operationId: string
  ): void {
    const fd = fs.openSync(entry.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      assertOwnedRegularFile(entry.filePath, opened)
      if (!sameFileIdentity(opened, entry.stat)) {
        throw new Error(
          `Regenerable history-byte file changed before descriptor open: ${entry.filePath}`
        )
      }
      const hookResult = this.testHook?.('before_file_unlink', {
        kind,
        operationId,
        filePath: entry.filePath
      })
      if (hookResult && typeof (hookResult as Promise<void>).then === 'function') {
        throw new Error('Regenerable history-byte unlink test hook must be synchronous.')
      }
      const beforeUnlink = fs.lstatSync(entry.filePath, { bigint: true })
      assertOwnedRegularFile(entry.filePath, beforeUnlink)
      if (!sameFileIdentity(beforeUnlink, opened)) {
        throw new Error(
          `Regenerable history-byte file changed immediately before unlink: ${entry.filePath}`
        )
      }
      fs.unlinkSync(entry.filePath)
      const afterUnlink = fs.fstatSync(fd, { bigint: true })
      if (!sameFileIdentity(afterUnlink, opened) || afterUnlink.nlink !== 0n) {
        throw new Error(
          `Regenerable history-byte file retained a link after unlink: ${entry.filePath}`
        )
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  private createFreshGenerationRootsStrict(): void {
    if (this.activeGeneration) return
    const generationId = `${GENERATION_PREFIX}${randomUUID()}`
    const createdRoots: Partial<Record<RegenerableHistoryByteKind, string>> = {}
    const baseIdentities: Partial<Record<RegenerableHistoryByteKind, DurableFileIdentity>> = {}
    const rootIdentities: Partial<Record<RegenerableHistoryByteKind, DurableFileIdentity>> = {}
    for (const kind of ['media', 'pdf'] as const) {
      const base = this.roots[kind]
      if (pathExistsNoFollow(base)) {
        throw new Error(
          `Regenerable history-byte root reappeared before generation creation: ${base}`
        )
      }
      fs.mkdirSync(base, { mode: 0o700 })
      const baseStat = lstatOwnedDirectory(base)
      const generationRoot = path.join(base, generationId)
      fs.mkdirSync(generationRoot, { mode: 0o700 })
      const generationStat = lstatOwnedDirectory(generationRoot)
      fsyncDirectoryStrict(base)
      fsyncDirectoryStrict(path.dirname(base))
      createdRoots[kind] = generationRoot
      baseIdentities[kind] = durableFileIdentity(baseStat)
      rootIdentities[kind] = durableFileIdentity(generationStat)
    }
    this.activeGeneration = {
      id: generationId,
      roots: {
        media: createdRoots.media!,
        pdf: createdRoots.pdf!
      },
      baseIdentities: {
        media: baseIdentities.media!,
        pdf: baseIdentities.pdf!
      },
      rootIdentities: {
        media: rootIdentities.media!,
        pdf: rootIdentities.pdf!
      }
    }
    const hookResult = this.testHook?.('after_generation_create', {
      operationId: this.activeOperationId ?? 'startup-generation'
    })
    if (hookResult && typeof (hookResult as Promise<void>).then === 'function') {
      throw new Error('Regenerable history-byte generation test hook must be synchronous.')
    }
  }

  private openJournalFileStrict(): OpenJournalFile | null {
    let before: fs.BigIntStats
    try {
      before = fs.lstatSync(this.journalPath, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
    assertOwnedJournalFile(this.journalPath, before)
    const fd = fs.openSync(this.journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      assertOwnedJournalFile(this.journalPath, opened)
      const beforeSnapshot = journalFileSnapshot(before)
      const openedSnapshot = journalFileSnapshot(opened)
      if (!sameJournalFileSnapshot(openedSnapshot, beforeSnapshot)) {
        throw new Error('Regenerable history-byte journal changed before read.')
      }
      if (opened.size <= 0n || opened.size > BigInt(JOURNAL_MAX_BYTES)) {
        throw new Error('Regenerable history-byte journal has an invalid size.')
      }
      const raw = Buffer.alloc(Number(opened.size))
      let offset = 0
      while (offset < raw.length) {
        const bytesRead = fs.readSync(fd, raw, offset, raw.length - offset, offset)
        if (bytesRead <= 0) {
          throw new Error('Regenerable history-byte journal ended before its exact size.')
        }
        offset += bytesRead
      }
      const overflow = Buffer.allocUnsafe(1)
      if (fs.readSync(fd, overflow, 0, 1, raw.length) !== 0) {
        throw new Error('Regenerable history-byte journal grew during read.')
      }
      const hookResult = this.testHook?.('after_journal_bytes_read', {
        operationId: 'journal-read'
      })
      if (hookResult && typeof (hookResult as Promise<void>).then === 'function') {
        throw new Error('Regenerable history-byte journal-read test hook must be synchronous.')
      }
      const finalStat = fs.fstatSync(fd, { bigint: true })
      const pathStat = fs.lstatSync(this.journalPath, { bigint: true })
      assertOwnedJournalFile(this.journalPath, finalStat)
      assertOwnedJournalFile(this.journalPath, pathStat)
      if (
        !sameJournalFileSnapshot(journalFileSnapshot(finalStat), openedSnapshot) ||
        !sameJournalFileSnapshot(journalFileSnapshot(pathStat), openedSnapshot)
      ) {
        throw new Error('Regenerable history-byte journal changed during read.')
      }
      return {
        fd,
        raw,
        digest: digestBytes(raw),
        snapshot: openedSnapshot
      }
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
  }

  private readJournalStrict(): PurgeJournal | null {
    const opened = this.openJournalFileStrict()
    if (!opened) return null
    try {
      const parsed = JSON.parse(opened.raw.toString('utf8')) as Partial<PurgeJournal>
      const parsedRoots =
        parsed.roots && typeof parsed.roots === 'object' && !Array.isArray(parsed.roots)
          ? (parsed.roots as Record<string, unknown>)
          : null
      const mediaIdentity = parseDurableManagedRootIdentity(parsedRoots?.media)
      const pdfIdentity = parseDurableManagedRootIdentity(parsedRoots?.pdf)
      if (
        parsed.version !== JOURNAL_VERSION ||
        (parsed.state !== 'pending' && parsed.state !== 'purged') ||
        typeof parsed.operationId !== 'string' ||
        mediaIdentity === undefined ||
        pdfIdentity === undefined ||
        (parsed.state === 'purged' &&
          [mediaIdentity, pdfIdentity].some(
            (identity) => identity !== null && identity.phase !== 'purged'
          ))
      ) {
        throw new Error('Regenerable history-byte journal is malformed.')
      }
      const operationId = validateOperationId(parsed.operationId)
      const journal: PurgeJournal = {
        version: 1,
        operationId,
        state: parsed.state,
        roots: { media: mediaIdentity, pdf: pdfIdentity }
      }
      this.activeJournalReceipt = {
        operationId,
        digest: opened.digest,
        snapshot: opened.snapshot
      }
      return journal
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Regenerable history-byte journal is malformed.', { cause: error })
      }
      throw error
    } finally {
      fs.closeSync(opened.fd)
    }
  }

  private writeJournalStrict(journal: PurgeJournal): void {
    lstatOwnedDirectory(this.journalParent)
    try {
      const existing = fs.lstatSync(this.journalPath, { bigint: true })
      assertOwnedJournalFile(this.journalPath, existing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const tempPath = path.join(
      this.journalParent,
      `.${path.basename(this.journalPath)}.tmp-${randomUUID()}`
    )
    const buffer = serializeJournal(journal)
    let fd: number | null = null
    try {
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      )
      writeAll(fd, buffer)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tempPath, this.journalPath)
      fsyncDirectoryStrict(this.journalParent)
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Preserve the original durable-write failure.
        }
      }
      try {
        const temp = fs.lstatSync(tempPath, { bigint: true })
        assertOwnedRegularFile(tempPath, temp)
        fs.unlinkSync(tempPath)
      } catch {
        // Recovery validates exact temp names before removing them.
      }
      throw error
    }
    const persisted = this.openJournalFileStrict()
    if (!persisted) {
      throw new Error('Regenerable history-byte journal disappeared after durable write.')
    }
    try {
      const expectedDigest = digestBytes(buffer)
      if (persisted.digest !== expectedDigest || !persisted.raw.equals(buffer)) {
        throw new Error('Regenerable history-byte journal changed after durable write.')
      }
      this.activeJournalReceipt = {
        operationId: journal.operationId,
        digest: expectedDigest,
        snapshot: persisted.snapshot
      }
    } finally {
      fs.closeSync(persisted.fd)
    }
    void this.testHook?.('after_journal_write', { operationId: journal.operationId })
  }

  private removeJournalStrict(): void {
    if (!this.activeOperationId || !this.activeRootIdentities || !this.activeJournalReceipt) {
      throw new Error('Regenerable history-byte journal retirement lost its expected receipt.')
    }
    const expectedJournal: PurgeJournal = {
      version: 1,
      operationId: this.activeOperationId,
      state: 'purged',
      roots: this.activeRootIdentities
    }
    const expectedBytes = serializeJournal(expectedJournal)
    const expectedDigest = digestBytes(expectedBytes)
    if (
      this.activeJournalReceipt.operationId !== expectedJournal.operationId ||
      this.activeJournalReceipt.digest !== expectedDigest
    ) {
      throw new Error('Regenerable history-byte journal receipt does not match this operation.')
    }
    const hookResult = this.testHook?.('before_journal_unlink', {
      operationId: expectedJournal.operationId,
      filePath: this.journalPath
    })
    if (hookResult && typeof (hookResult as Promise<void>).then === 'function') {
      throw new Error('Regenerable history-byte journal-unlink test hook must be synchronous.')
    }
    const opened = this.openJournalFileStrict()
    if (!opened) {
      throw new Error('Regenerable history-byte journal disappeared before retirement.')
    }
    try {
      if (
        !sameJournalFileSnapshot(opened.snapshot, this.activeJournalReceipt.snapshot) ||
        opened.digest !== expectedDigest ||
        !opened.raw.equals(expectedBytes)
      ) {
        throw new Error(
          'Regenerable history-byte journal changed before operation-bound retirement.'
        )
      }
      const beforeUnlink = fs.lstatSync(this.journalPath, { bigint: true })
      assertOwnedJournalFile(this.journalPath, beforeUnlink)
      if (!sameJournalFileSnapshot(journalFileSnapshot(beforeUnlink), opened.snapshot)) {
        throw new Error('Regenerable history-byte journal changed immediately before retirement.')
      }
      fs.unlinkSync(this.journalPath)
      const afterUnlink = fs.fstatSync(opened.fd, { bigint: true })
      if (!sameFileIdentity(afterUnlink, beforeUnlink) || afterUnlink.nlink !== 0n) {
        throw new Error('Regenerable history-byte journal retained a link after retirement.')
      }
      fsyncDirectoryStrict(this.journalParent)
      this.activeJournalReceipt = null
    } finally {
      fs.closeSync(opened.fd)
    }
  }

  private removeAbandonedJournalTempsStrict(): void {
    const prefix = `.${path.basename(this.journalPath)}.tmp-`
    for (const name of fs.readdirSync(this.journalParent)) {
      if (!name.startsWith(prefix)) continue
      const suffix = name.slice(prefix.length)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix)) {
        continue
      }
      const filePath = path.join(this.journalParent, name)
      const stat = fs.lstatSync(filePath, { bigint: true })
      assertOwnedRegularFile(filePath, stat)
      fs.unlinkSync(filePath)
    }
    fsyncDirectoryStrict(this.journalParent)
  }
}
