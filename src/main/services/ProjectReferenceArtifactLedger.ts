import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { isSafeChatId } from '../ChatPath'

export const PROJECT_REFERENCE_OWNERSHIP_FILE = 'ownership-v1.json'
export const PROJECT_REFERENCE_PURGE_JOURNAL_FILE = '.purge-v1.json'

const LEDGER_VERSION = 1
const JOURNAL_VERSION = 1
const LEDGER_MAX_BYTES = 8 * 1024 * 1024
const JOURNAL_MAX_BYTES = 16 * 1024 * 1024
const MAX_ARTIFACTS = 50_000
// The serialized 8 MiB ledger is the effective bound. A low per-SHA cap would
// reject a legitimate long-lived reference reused across many durable runs.
const MAX_OWNERS_PER_ARTIFACT = 50_000
const MAX_ID_BYTES = 512
const SHA256_HEX = /^[0-9a-f]{64}$/
const SNAPSHOT_NAME = /^([0-9a-f]{64})\.snapshot$/

export interface ProjectReferenceArtifactOwner {
  appChatId: string
  runId: string
}

export interface ProjectReferenceArtifactPurgeScope {
  appChatIds: Iterable<string>
  runIds: Iterable<string>
}

export interface ProjectReferenceArtifactPurgeSummary {
  revokedOwners: number
  deletedArtifacts: number
}

export type ProjectReferenceArtifactGrantResult =
  | { ok: true; addedAssets: string[] }
  | { ok: false; reason: 'invalid_owner' | 'invalid_asset' | 'missing' | 'limit' | 'persistence_failed' }

interface LedgerOwner {
  appChatId: string
  runId: string
}

interface LedgerSnapshot {
  version: 1
  artifacts: Array<{ sha256: string; owners: LedgerOwner[] }>
}

interface FileIdentity {
  dev: string
  ino: string
  size: number
}

interface FileRecord {
  original: string
  quarantine: string
  identity: FileIdentity
}

interface PurgeJournal {
  version: 1
  transactionId: string
  mode: 'scoped' | 'global'
  rootIdentity: { dev: string; ino: string }
  oldLedgerDigest: string | null
  newLedgerDigest: string | null
  files: FileRecord[]
  ledger: FileRecord | null
  newLedgerTemp?: FileRecord
}

type StrictFile = { path: string; stat: fs.Stats; identity: FileIdentity; buffer?: Buffer }

type LedgerState =
  | { status: 'missing' }
  | ({ status: 'present'; digest: string } & StrictFile)
  | { status: 'unsafe' }

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('base64url')
}

function safeOpaqueId(value: unknown): value is string {
  return isSafeChatId(value) && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
}

function safeOwner(owner: ProjectReferenceArtifactOwner): boolean {
  return Boolean(owner && safeOpaqueId(owner.appChatId) && safeOpaqueId(owner.runId))
}

function ownerKey(owner: ProjectReferenceArtifactOwner): string {
  return `${owner.appChatId}\0${owner.runId}`
}

function ownerFromKey(key: string): LedgerOwner | null {
  const separator = key.indexOf('\0')
  if (separator <= 0 || key.indexOf('\0', separator + 1) !== -1) return null
  const owner = { appChatId: key.slice(0, separator), runId: key.slice(separator + 1) }
  return safeOwner(owner) ? owner : null
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.ino !== right.ino) return false
  return process.platform === 'win32' || left.dev === right.dev
}

function identity(stat: fs.Stats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size }
}

function matchesIdentity(stat: fs.Stats, expected: FileIdentity): boolean {
  return (
    String(stat.dev) === expected.dev &&
    String(stat.ino) === expected.ino &&
    stat.size === expected.size
  )
}

function isMainOwned(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (
    (uid === null || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0)
  )
}

function strictRoot(root: string, create: boolean): { path: string; identity: { dev: string; ino: string } } | null {
  try {
    if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const before = fs.lstatSync(root)
    if (before.isSymbolicLink() || !before.isDirectory()) return null
    const canonical = fs.realpathSync.native(root)
    const after = fs.statSync(canonical)
    if (!after.isDirectory() || !sameIdentity(before, after) || !isMainOwned(after)) return null
    return { path: canonical, identity: { dev: String(after.dev), ino: String(after.ino) } }
  } catch {
    return null
  }
}

function safeFlatName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    path.basename(value) === value
  )
}

function strictFile(filePath: string, expected?: FileIdentity, maxBytes?: number): StrictFile | null {
  let fd: number | null = null
  try {
    const before = fs.lstatSync(filePath)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      !isMainOwned(before) ||
      (expected && !matchesIdentity(before, expected)) ||
      (maxBytes !== undefined && (before.size <= 0 || before.size > maxBytes))
    ) {
      return null
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    const after = fs.lstatSync(filePath)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      !sameIdentity(before, opened) ||
      !sameIdentity(opened, after) ||
      opened.size !== before.size ||
      after.size !== before.size ||
      !isMainOwned(opened)
    ) {
      return null
    }
    let buffer: Buffer | undefined
    if (maxBytes !== undefined) {
      buffer = Buffer.allocUnsafe(opened.size)
      let offset = 0
      while (offset < buffer.length) {
        const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
        if (read <= 0) return null
        offset += read
      }
    }
    return { path: filePath, stat: opened, identity: identity(opened), ...(buffer ? { buffer } : {}) }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // A later strict identity check fails closed if descriptor state is ambiguous.
      }
    }
  }
}

function pathMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
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

function writeStrictFile(filePath: string, buffer: Buffer): StrictFile {
  let fd: number | null = null
  let created: fs.Stats | null = null
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(fd, 0o600)
    created = fs.fstatSync(fd)
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
      if (written <= 0) throw new Error('short_write')
      offset += written
    }
    fs.fsyncSync(fd)
    const finalStat = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(filePath)
    if (
      !finalStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      finalStat.nlink !== 1 ||
      pathStat.nlink !== 1 ||
      finalStat.size !== buffer.length ||
      !sameIdentity(finalStat, created) ||
      !sameIdentity(pathStat, created)
    ) {
      throw new Error('Strict project-reference file publication was redirected.')
    }
    fs.closeSync(fd)
    fd = null
    return { path: filePath, stat: finalStat, identity: identity(finalStat), buffer }
  } catch (error) {
    if (created) {
      try {
        const current = fs.lstatSync(filePath)
        if (!current.isSymbolicLink() && sameIdentity(current, created)) fs.unlinkSync(filePath)
      } catch {
        // Preserve an ambiguous file for startup recovery rather than following it.
      }
    }
    throw error
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original failure.
      }
    }
  }
}

function serialize(ownership: Map<string, Set<string>>): Buffer | null {
  const snapshot: LedgerSnapshot = {
    version: 1,
    artifacts: Array.from(ownership, ([sha256, ownerKeys]) => ({
      sha256,
      owners: Array.from(ownerKeys)
        .map(ownerFromKey)
        .filter((owner): owner is LedgerOwner => Boolean(owner))
        .sort((left, right) =>
          left.appChatId.localeCompare(right.appChatId) || left.runId.localeCompare(right.runId)
        )
    })).sort((left, right) => left.sha256.localeCompare(right.sha256))
  }
  if (snapshot.artifacts.some((artifact) => artifact.owners.length === 0)) return null
  const buffer = Buffer.from(JSON.stringify(snapshot), 'utf8')
  return buffer.length <= LEDGER_MAX_BYTES ? buffer : null
}

function ledgerState(root: string): LedgerState {
  const filePath = path.join(root, PROJECT_REFERENCE_OWNERSHIP_FILE)
  if (pathMissing(filePath)) return { status: 'missing' }
  const file = strictFile(filePath, undefined, LEDGER_MAX_BYTES)
  return file?.buffer
    ? { status: 'present', ...file, digest: digest(file.buffer) }
    : { status: 'unsafe' }
}

function loadLedger(root: string): { ok: true; ownership: Map<string, Set<string>> } | { ok: false } {
  const state = ledgerState(root)
  if (state.status === 'missing') return { ok: true, ownership: new Map() }
  if (state.status !== 'present' || !state.buffer) return { ok: false }
  try {
    const parsed = JSON.parse(state.buffer.toString('utf8')) as Partial<LedgerSnapshot>
    if (
      parsed.version !== LEDGER_VERSION ||
      !Array.isArray(parsed.artifacts) ||
      parsed.artifacts.length > MAX_ARTIFACTS
    ) {
      return { ok: false }
    }
    const ownership = new Map<string, Set<string>>()
    for (const artifact of parsed.artifacts) {
      if (
        !artifact ||
        !SHA256_HEX.test(artifact.sha256) ||
        !Array.isArray(artifact.owners) ||
        artifact.owners.length === 0 ||
        artifact.owners.length > MAX_OWNERS_PER_ARTIFACT ||
        ownership.has(artifact.sha256)
      ) {
        return { ok: false }
      }
      const owners = new Set<string>()
      for (const owner of artifact.owners) {
        if (!safeOwner(owner)) return { ok: false }
        owners.add(ownerKey(owner))
      }
      if (owners.size !== artifact.owners.length) return { ok: false }
      ownership.set(artifact.sha256, owners)
    }
    return { ok: true, ownership }
  } catch {
    return { ok: false }
  }
}

function persistLedger(root: string, next: Map<string, Set<string>>): boolean {
  const serialized = serialize(next)
  if (!serialized) return false
  const old = ledgerState(root)
  if (old.status === 'unsafe' || (old.status === 'present' && !old.buffer)) return false
  const ledgerPath = path.join(root, PROJECT_REFERENCE_OWNERSHIP_FILE)
  const tempPath = path.join(root, `.ownership-${process.pid}-${randomUUID()}.tmp`)
  const rollbackPath = path.join(root, `.ownership-${process.pid}-${randomUUID()}.rollback.tmp`)
  let replaced = false
  try {
    writeStrictFile(tempPath, serialized)
    fs.renameSync(tempPath, ledgerPath)
    replaced = true
    const current = ledgerState(root)
    if (current.status !== 'present' || current.digest !== digest(serialized)) {
      throw new Error('Project-reference ownership replacement was redirected.')
    }
    fsyncDirectoryStrict(root)
    return true
  } catch {
    if (replaced) {
      try {
        const current = ledgerState(root)
        if (current.status !== 'present' || current.digest !== digest(serialized)) {
          throw new Error('Project-reference ownership rollback is ambiguous.')
        }
        if (old.status === 'present') {
          writeStrictFile(rollbackPath, old.buffer!)
          fs.renameSync(rollbackPath, ledgerPath)
        } else {
          fs.unlinkSync(ledgerPath)
        }
        fsyncDirectoryStrict(root)
      } catch {
        // The owning instance permanently closes mutation after this false result.
      }
    }
    return false
  } finally {
    for (const candidate of [tempPath, rollbackPath]) {
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate)
      } catch {
        // Stale private temps are removed by strict global history clear.
      }
    }
  }
}

function fileRecord(root: string, original: string, transactionId: string, index: number): FileRecord {
  if (!safeFlatName(original)) throw new Error('Unsafe project-reference purge source name.')
  const file = strictFile(path.join(root, original))
  if (!file) throw new Error(`Unsafe project-reference purge source: ${original}`)
  return {
    original,
    quarantine: `.purge-${transactionId}-${String(index).padStart(6, '0')}.tmp`,
    identity: file.identity
  }
}

function journalBuffer(journal: PurgeJournal): Buffer {
  const buffer = Buffer.from(JSON.stringify(journal), 'utf8')
  if (buffer.length <= 0 || buffer.length > JOURNAL_MAX_BYTES) {
    throw new Error('Project-reference purge journal exceeds its cap.')
  }
  return buffer
}

function publishJournal(root: string, journal: PurgeJournal): FileIdentity {
  const finalPath = path.join(root, PROJECT_REFERENCE_PURGE_JOURNAL_FILE)
  if (!pathMissing(finalPath)) throw new Error('A project-reference purge journal already exists.')
  const tempPath = path.join(root, `.purge-journal-${process.pid}-${randomUUID()}.tmp`)
  const temp = writeStrictFile(tempPath, journalBuffer(journal))
  try {
    fs.renameSync(tempPath, finalPath)
    const published = strictFile(finalPath, temp.identity, JOURNAL_MAX_BYTES)
    if (!published) throw new Error('Project-reference purge journal publication changed.')
    fsyncDirectoryStrict(root)
    return published.identity
  } catch (error) {
    try {
      const current = strictFile(tempPath, temp.identity)
      if (current) fs.unlinkSync(tempPath)
    } catch {
      // A surviving journal temp blocks global cleanup until inspected.
    }
    throw error
  }
}

function moveToQuarantine(root: string, record: FileRecord): void {
  const original = strictFile(path.join(root, record.original), record.identity)
  if (!original) throw new Error(`Project-reference purge source changed: ${record.original}`)
  if (!pathMissing(path.join(root, record.quarantine))) {
    throw new Error('Project-reference purge quarantine already exists.')
  }
  fs.renameSync(path.join(root, record.original), path.join(root, record.quarantine))
  const moved = strictFile(path.join(root, record.quarantine), record.identity)
  if (!moved || !pathMissing(path.join(root, record.original))) {
    throw new Error(`Project-reference purge move was redirected: ${record.original}`)
  }
}

function validateJournal(value: unknown): value is PurgeJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const journal = value as Partial<PurgeJournal>
  if (
    journal.version !== JOURNAL_VERSION ||
    typeof journal.transactionId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(journal.transactionId) ||
    (journal.mode !== 'scoped' && journal.mode !== 'global') ||
    !journal.rootIdentity ||
    typeof journal.rootIdentity.dev !== 'string' ||
    typeof journal.rootIdentity.ino !== 'string' ||
    !Array.isArray(journal.files) ||
    journal.files.length > MAX_ARTIFACTS + 1024
  ) {
    return false
  }
  const records = [...journal.files, ...(journal.ledger ? [journal.ledger] : []), ...(journal.newLedgerTemp ? [journal.newLedgerTemp] : [])]
  const names = new Set<string>()
  for (const record of records) {
    if (
      !record ||
      !safeFlatName(record.original) ||
      !safeFlatName(record.quarantine) ||
      names.has(record.original) ||
      names.has(record.quarantine) ||
      !record.identity ||
      typeof record.identity.dev !== 'string' ||
      typeof record.identity.ino !== 'string' ||
      !Number.isSafeInteger(record.identity.size) ||
      record.identity.size < 0
    ) {
      return false
    }
    names.add(record.original)
    names.add(record.quarantine)
  }
  return true
}

function readJournal(root: string): { journal: PurgeJournal; identity: FileIdentity } | null {
  const journalPath = path.join(root, PROJECT_REFERENCE_PURGE_JOURNAL_FILE)
  if (pathMissing(journalPath)) return null
  const file = strictFile(journalPath, undefined, JOURNAL_MAX_BYTES)
  if (!file?.buffer) throw new Error('Project-reference purge journal is unsafe.')
  const parsed = JSON.parse(file.buffer.toString('utf8')) as unknown
  if (!validateJournal(parsed)) throw new Error('Project-reference purge journal is invalid.')
  return { journal: parsed, identity: file.identity }
}

function unlinkStrict(root: string, name: string, expected: FileIdentity): void {
  const target = path.join(root, name)
  if (pathMissing(target)) return
  const current = strictFile(target, expected)
  if (!current) throw new Error(`Project-reference cleanup target changed: ${name}`)
  fs.unlinkSync(target)
}

function finishCommitted(root: string, journal: PurgeJournal, journalIdentity: FileIdentity): void {
  for (const record of [...journal.files, ...(journal.ledger ? [journal.ledger] : [])]) {
    unlinkStrict(root, record.quarantine, record.identity)
  }
  if (journal.newLedgerTemp) {
    unlinkStrict(root, journal.newLedgerTemp.original, journal.newLedgerTemp.identity)
  }
  unlinkStrict(root, PROJECT_REFERENCE_PURGE_JOURNAL_FILE, journalIdentity)
  fsyncDirectoryStrict(root)
}

function restoreRolledBack(root: string, journal: PurgeJournal, journalIdentity: FileIdentity): void {
  if (journal.mode === 'scoped') {
    const current = ledgerState(root)
    if (current.status === 'present' && current.digest === journal.newLedgerDigest) {
      throw new Error('Cannot roll back a committed project-reference purge.')
    }
    if (current.status === 'present' && current.digest !== journal.oldLedgerDigest) {
      throw new Error('Project-reference ledger changed during rollback.')
    }
  }
  const records = [...journal.files, ...(journal.ledger ? [journal.ledger] : [])].reverse()
  for (const record of records) {
    const originalPath = path.join(root, record.original)
    const quarantinePath = path.join(root, record.quarantine)
    const original = pathMissing(originalPath) ? null : strictFile(originalPath, record.identity)
    const quarantine = pathMissing(quarantinePath) ? null : strictFile(quarantinePath, record.identity)
    if (original && !quarantine) continue
    if (!original && quarantine) {
      fs.renameSync(quarantinePath, originalPath)
      if (!strictFile(originalPath, record.identity)) {
        throw new Error(`Project-reference rollback changed: ${record.original}`)
      }
      continue
    }
    throw new Error(`Project-reference rollback is ambiguous: ${record.original}`)
  }
  if (journal.newLedgerTemp) {
    unlinkStrict(root, journal.newLedgerTemp.original, journal.newLedgerTemp.identity)
  }
  unlinkStrict(root, PROJECT_REFERENCE_PURGE_JOURNAL_FILE, journalIdentity)
  fsyncDirectoryStrict(root)
}

function recover(rootInput: string): boolean {
  let root: ReturnType<typeof strictRoot>
  try {
    root = strictRoot(rootInput, false)
  } catch {
    return false
  }
  if (!root) {
    try {
      return (fs.lstatSync(rootInput), false)
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    }
  }
  try {
    const entry = readJournal(root.path)
    if (!entry) return true
    const { journal, identity: journalIdentity } = entry
    if (
      journal.rootIdentity.dev !== root.identity.dev ||
      journal.rootIdentity.ino !== root.identity.ino
    ) {
      return false
    }
    const ledger = ledgerState(root.path)
    if (
      journal.mode === 'scoped' &&
      ledger.status === 'present' &&
      ledger.digest === journal.newLedgerDigest
    ) {
      finishCommitted(root.path, journal, journalIdentity)
      return true
    }
    if (journal.mode === 'global' && ledger.status === 'missing') {
      finishCommitted(root.path, journal, journalIdentity)
      return true
    }
    if (
      ledger.status === 'missing' ||
      (ledger.status === 'present' && ledger.digest === journal.oldLedgerDigest)
    ) {
      restoreRolledBack(root.path, journal, journalIdentity)
      return true
    }
    return false
  } catch {
    return false
  }
}

export class ProjectReferenceArtifactLedger {
  private ownership: Map<string, Set<string>>
  private unavailable: boolean
  private purgeInProgress = false
  private reconciliationRequired: boolean

  constructor(private readonly rootInput: string) {
    const recovered = recover(rootInput)
    const root = strictRoot(rootInput, false)
    const loaded = root ? loadLedger(root.path) : { ok: true as const, ownership: new Map<string, Set<string>>() }
    this.ownership = loaded.ok ? loaded.ownership : new Map()
    this.unavailable = !recovered || !loaded.ok
    this.reconciliationRequired = Boolean(
      root &&
      (ledgerState(root.path).status === 'present' ||
        fs.readdirSync(root.path).some((entry) => SNAPSHOT_NAME.test(entry)))
    )
  }

  needsLegacyReconciliation(): boolean {
    return this.reconciliationRequired
  }

  reconcileLegacyOwnership(
    ownership: ReadonlyMap<string, ReadonlySet<ProjectReferenceArtifactOwner>>
  ): { referencedArtifacts: number; deletedOrphans: number } {
    if (this.unavailable) throw new Error('Project-reference artifact ownership is unavailable.')
    const root = strictRoot(this.rootInput, true)
    if (!root) throw new Error('Project-reference artifact root is unsafe.')
    const next = new Map<string, Set<string>>()
    for (const [sha256, owners] of ownership) {
      if (!SHA256_HEX.test(sha256) || owners.size === 0 || owners.size > MAX_OWNERS_PER_ARTIFACT) {
        throw new Error('Project-reference legacy ownership input is invalid.')
      }
      const keys = new Set<string>()
      for (const owner of owners) {
        if (!safeOwner(owner)) throw new Error('Project-reference legacy owner is invalid.')
        keys.add(ownerKey(owner))
      }
      if (keys.size === 0 || keys.size > MAX_OWNERS_PER_ARTIFACT) {
        throw new Error('Project-reference legacy owner count is invalid.')
      }
      next.set(sha256, keys)
    }
    if (next.size > MAX_ARTIFACTS) {
      throw new Error('Project-reference legacy artifact count exceeds its cap.')
    }
    const snapshotEntries = fs.readdirSync(root.path).filter((entry) => SNAPSHOT_NAME.test(entry))
    for (const sha256 of next.keys()) {
      if (!strictFile(path.join(root.path, `${sha256}.snapshot`))) {
        throw new Error(`Project-reference legacy artifact ${sha256} is missing or unsafe.`)
      }
    }
    // Durable event reachability is authoritative on every startup. Publish the
    // exact owner map first; a crash during subsequent orphan cleanup can only
    // leave unowned bytes, which the same reconciliation removes on restart.
    this.reconciliationRequired = true
    if (!persistLedger(root.path, next)) {
      this.unavailable = true
      throw new Error('Project-reference legacy ownership could not persist.')
    }
    this.ownership = next
    let deletedOrphans = 0
    for (const entry of snapshotEntries) {
      const match = SNAPSHOT_NAME.exec(entry)
      const sha256 = match?.[1]
      if (!sha256 || next.has(sha256)) continue
      const file = strictFile(path.join(root.path, entry))
      if (!file) throw new Error(`Project-reference legacy orphan ${entry} is unsafe.`)
      fs.unlinkSync(file.path)
      deletedOrphans += 1
    }
    if (deletedOrphans > 0) fsyncDirectoryStrict(root.path)
    this.reconciliationRequired = false
    return { referencedArtifacts: next.size, deletedOrphans }
  }

  owns(sha256: string, owner: ProjectReferenceArtifactOwner): boolean {
    return SHA256_HEX.test(sha256) && safeOwner(owner)
      ? this.ownership.get(sha256)?.has(ownerKey(owner)) === true
      : false
  }

  hasOwners(sha256: string): boolean {
    return (this.ownership.get(sha256)?.size ?? 0) > 0
  }

  isDurablyUnowned(sha256: string): boolean {
    const root = strictRoot(this.rootInput, false)
    if (!root) return false
    const loaded = loadLedger(root.path)
    return loaded.ok && (loaded.ownership.get(sha256)?.size ?? 0) === 0
  }

  grantAssets(sha256s: readonly string[], owner: ProjectReferenceArtifactOwner): ProjectReferenceArtifactGrantResult {
    if (this.unavailable || this.reconciliationRequired) {
      return { ok: false, reason: 'persistence_failed' }
    }
    if (!safeOwner(owner)) return { ok: false, reason: 'invalid_owner' }
    const root = strictRoot(this.rootInput, true)
    if (!root) return { ok: false, reason: 'persistence_failed' }
    const assets = [...new Set(sha256s)]
    if (assets.some((sha256) => !SHA256_HEX.test(sha256))) {
      return { ok: false, reason: 'invalid_asset' }
    }
    for (const sha256 of assets) {
      if (!strictFile(path.join(root.path, `${sha256}.snapshot`))) {
        return { ok: false, reason: 'missing' }
      }
    }
    const key = ownerKey(owner)
    const next = new Map(this.ownership)
    const addedAssets: string[] = []
    for (const sha256 of assets) {
      const current = this.ownership.get(sha256)
      if (current?.has(key)) continue
      if (!current && next.size >= MAX_ARTIFACTS) return { ok: false, reason: 'limit' }
      if ((current?.size ?? 0) >= MAX_OWNERS_PER_ARTIFACT) return { ok: false, reason: 'limit' }
      const owners = new Set(current ?? [])
      owners.add(key)
      next.set(sha256, owners)
      addedAssets.push(sha256)
    }
    if (addedAssets.length === 0) return { ok: true, addedAssets }
    if (!persistLedger(root.path, next)) {
      this.unavailable = true
      return { ok: false, reason: 'persistence_failed' }
    }
    this.ownership = next
    return { ok: true, addedAssets }
  }

  revokeExactAssetsStrict(
    sha256s: readonly string[],
    owner: ProjectReferenceArtifactOwner
  ): ProjectReferenceArtifactPurgeSummary {
    if (!safeOwner(owner)) throw new Error('Project-reference rollback owner is invalid.')
    const targets = new Set(sha256s)
    return this.mutateStrict((sha256, candidate) => targets.has(sha256) && candidate === ownerKey(owner))
  }

  revokeOwnershipStrict(scope: ProjectReferenceArtifactPurgeScope): ProjectReferenceArtifactPurgeSummary {
    const appChatIds = new Set<string>()
    const runIds = new Set<string>()
    for (const appChatId of scope.appChatIds) {
      if (!safeOpaqueId(appChatId)) throw new Error('Project-reference purge chat id is invalid.')
      appChatIds.add(appChatId)
    }
    for (const runId of scope.runIds) {
      if (!safeOpaqueId(runId)) throw new Error('Project-reference purge run id is invalid.')
      runIds.add(runId)
    }
    return this.mutateStrict((_sha256, candidate) => {
      const owner = ownerFromKey(candidate)
      return Boolean(owner && (appChatIds.has(owner.appChatId) || runIds.has(owner.runId)))
    })
  }

  private mutateStrict(shouldRevoke: (sha256: string, ownerKey: string) => boolean): ProjectReferenceArtifactPurgeSummary {
    if (this.purgeInProgress) throw new Error('A project-reference artifact purge is already running.')
    if (this.unavailable || this.reconciliationRequired) {
      throw new Error('Project-reference artifact ownership is unavailable.')
    }
    const next = new Map<string, Set<string>>()
    const doomed: string[] = []
    let revokedOwners = 0
    for (const [sha256, current] of this.ownership) {
      const surviving = new Set(current)
      for (const candidate of current) {
        if (shouldRevoke(sha256, candidate) && surviving.delete(candidate)) revokedOwners += 1
      }
      if (surviving.size > 0) next.set(sha256, surviving)
      else if (surviving.size !== current.size) doomed.push(sha256)
    }
    if (revokedOwners === 0) return { revokedOwners: 0, deletedArtifacts: 0 }
    const root = strictRoot(this.rootInput, false)
    if (!root) throw new Error('Project-reference artifact root is unsafe.')
    this.purgeInProgress = true
    try {
      const oldLedger = ledgerState(root.path)
      if (oldLedger.status !== 'present') throw new Error('Project-reference ownership ledger is unsafe.')
      const serialized = serialize(next)
      if (!serialized) throw new Error('Project-reference ownership replacement exceeds limits.')
      const transactionId = randomUUID()
      const files = doomed.map((sha256, index) =>
        fileRecord(root.path, `${sha256}.snapshot`, transactionId, index)
      )
      const ledger = fileRecord(root.path, PROJECT_REFERENCE_OWNERSHIP_FILE, transactionId, files.length)
      const newLedgerName = `.purge-ledger-${process.pid}-${transactionId}.tmp`
      const newLedgerFile = writeStrictFile(path.join(root.path, newLedgerName), serialized)
      const newLedgerTemp: FileRecord = {
        original: newLedgerName,
        quarantine: `.unused-${transactionId}`,
        identity: newLedgerFile.identity
      }
      const journal: PurgeJournal = {
        version: 1,
        transactionId,
        mode: 'scoped',
        rootIdentity: root.identity,
        oldLedgerDigest: oldLedger.digest,
        newLedgerDigest: digest(serialized),
        files,
        ledger,
        newLedgerTemp
      }
      const journalIdentity = publishJournal(root.path, journal)
      try {
        for (const record of files) moveToQuarantine(root.path, record)
        moveToQuarantine(root.path, ledger)
        fs.renameSync(path.join(root.path, newLedgerName), path.join(root.path, PROJECT_REFERENCE_OWNERSHIP_FILE))
        const published = ledgerState(root.path)
        if (published.status !== 'present' || published.digest !== journal.newLedgerDigest) {
          throw new Error('Project-reference ownership commit changed.')
        }
        fsyncDirectoryStrict(root.path)
        this.ownership = next
        finishCommitted(root.path, journal, journalIdentity)
      } catch (error) {
        const current = ledgerState(root.path)
        if (current.status === 'present' && current.digest === journal.newLedgerDigest) {
          this.unavailable = true
        } else {
          try {
            restoreRolledBack(root.path, journal, journalIdentity)
          } catch {
            this.unavailable = true
          }
        }
        throw new Error('Project-reference artifact purge failed before history commit.', { cause: error })
      }
      return { revokedOwners, deletedArtifacts: files.length }
    } finally {
      this.purgeInProgress = false
    }
  }

  clearAllStrict(): ProjectReferenceArtifactPurgeSummary {
    if (this.purgeInProgress) throw new Error('A project-reference artifact purge is already running.')
    const root = strictRoot(this.rootInput, false)
    if (!root) {
      try {
        fs.lstatSync(this.rootInput)
        throw new Error('Project-reference artifact root is unsafe.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          this.ownership = new Map()
          this.unavailable = false
          this.reconciliationRequired = false
          return { revokedOwners: 0, deletedArtifacts: 0 }
        }
        throw error
      }
    }
    this.purgeInProgress = true
    try {
      let oldLedger = ledgerState(root.path)
      if (oldLedger.status === 'missing') {
        const empty = serialize(new Map())
        if (!empty) throw new Error('Project-reference empty ownership ledger could not serialize.')
        writeStrictFile(path.join(root.path, PROJECT_REFERENCE_OWNERSHIP_FILE), empty)
        fsyncDirectoryStrict(root.path)
        oldLedger = ledgerState(root.path)
      }
      if (oldLedger.status !== 'present') {
        throw new Error('Project-reference ownership ledger is unsafe.')
      }
      const revokedOwners = Array.from(this.ownership.values()).reduce(
        (sum, owners) => sum + owners.size,
        0
      )
      const entries = fs.readdirSync(root.path).sort()
      const ordinary = entries.filter((entry) =>
        entry !== PROJECT_REFERENCE_PURGE_JOURNAL_FILE && entry !== PROJECT_REFERENCE_OWNERSHIP_FILE
      )
      const transactionId = randomUUID()
      const files = ordinary.map((entry, index) => fileRecord(root.path, entry, transactionId, index))
      const ledger = fileRecord(
        root.path,
        PROJECT_REFERENCE_OWNERSHIP_FILE,
        transactionId,
        files.length
      )
      const journal: PurgeJournal = {
        version: 1,
        transactionId,
        mode: 'global',
        rootIdentity: root.identity,
        oldLedgerDigest: oldLedger.digest,
        newLedgerDigest: null,
        files,
        ledger
      }
      const journalIdentity = publishJournal(root.path, journal)
      try {
        for (const record of files) moveToQuarantine(root.path, record)
        moveToQuarantine(root.path, ledger)
        fsyncDirectoryStrict(root.path)
        this.ownership = new Map()
        finishCommitted(root.path, journal, journalIdentity)
      } catch (error) {
        const current = ledgerState(root.path)
        if (current.status === 'missing') this.unavailable = true
        else {
          try {
            restoreRolledBack(root.path, journal, journalIdentity)
          } catch {
            this.unavailable = true
          }
        }
        throw new Error('Project-reference global artifact purge failed before history commit.', { cause: error })
      }
      this.ownership = new Map()
      this.unavailable = false
      this.reconciliationRequired = false
      return { revokedOwners, deletedArtifacts: files.filter((record) => SNAPSHOT_NAME.test(record.original)).length }
    } finally {
      this.purgeInProgress = false
    }
  }
}
