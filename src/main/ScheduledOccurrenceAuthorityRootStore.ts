import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'

export const SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_FILENAME =
  'scheduled-occurrence-authority-root.json'

const SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_LOCK_FILENAME =
  'scheduled-occurrence-authority-root.lock'
const SCHEDULED_TASKS_FILENAME = 'scheduled-tasks.json'
const SCHEDULED_OCCURRENCE_MUTATION_FILENAME = 'scheduled-occurrence-mutation.json'
const ROOT_PURPOSE = 'taskwraith:scheduled-occurrence-authority-root:v1'
const ROOT_LOCK_PURPOSE = 'taskwraith:scheduled-occurrence-authority-root-initialization:v1'
const ROOT_ID_PREFIX = 'twso-root-v1:'
const ROOT_BYTES = 32
const MAX_AUTHORITY_PATH_LENGTH = 4_096
const ROOT_FILE_MAX_BYTES = 64 * 1024
const LOCK_FILE_MAX_BYTES = 16 * 1024
// Existing task/WAL projections can legitimately contain large prompts and
// attachment metadata. The cap is deliberately generous but still prevents an
// unbounded/sparse file from entering JSON.parse during startup.
const SCHEDULING_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
const FILE_READ_CHUNK_BYTES = 64 * 1024
const LINUX_ENCRYPTED_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6'
])

const SEAL_PAYLOAD_DOMAIN = 'taskwraith:scheduled-occurrence:seal-payload:v1\0'
const WAL_PAYLOAD_DOMAIN = 'taskwraith:scheduled-occurrence:wal-payload:v1\0'
const RUNTIME_PROFILE_SET_DOMAIN = 'taskwraith:runtime-profile-set:v1\0'
const PERMISSION_POSTURE_SET_DOMAIN = 'taskwraith:permission-posture-set:v1\0'
const PROVIDER_LAUNCH_DOMAIN = 'taskwraith:provider-launch-authority:v1\0'
const SCHEDULED_OCCURRENCE_LAUNCH_PROVIDERS = {
  codex: true,
  claude: true,
  kimi: true,
  grok: true,
  cursor: true,
  ollama: true
} as const

const OUTER_KEYS = ['schemaVersion', 'rootId', 'createdAt', 'encryptedRoot'] as const
const INNER_KEYS = ['schemaVersion', 'purpose', 'rootId', 'rootKeyBase64'] as const
const LEGACY_SEAL_KEYS = [
  'schemaVersion',
  'issuedAt',
  'taskAuthorityDigest',
  'compositeWorkflowAuthorityDigest',
  'workspaceRealPath',
  'runtimeProfileSetHmac',
  'permissionPostureSetHmac',
  'sealSignature'
] as const
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const LOWER_HEX_256 = /^[a-f0-9]{64}$/

export interface ScheduledOccurrenceAuthoritySafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

export type ScheduledOccurrenceLaunchProvider =
  keyof typeof SCHEDULED_OCCURRENCE_LAUNCH_PROVIDERS

/**
 * The sole capability accepted by schema-v2 seal/WAL writers. Integration must
 * never accept a caller-authored rootId or MAC in place of this closure: that
 * rule makes successful durable root publication plus exact initialization-lock
 * release the boundary after which any new v2 artifact is necessarily bound to
 * this exact root. Exact schema-v1 seals remain migration-only data and must
 * never authorize a v2 launch.
 */
export interface ScheduledOccurrenceAuthorityRoot {
  readonly rootId: string
  sealPayloadMac(payload: Buffer): string
  verifySealPayloadMac(payload: Buffer, mac: string): boolean
  walPayloadMac(payload: Buffer): string
  verifyWalPayloadMac(payload: Buffer, mac: string): boolean
  runtimeProfileSetHmac(payload: Buffer): string
  permissionPostureSetHmac(payload: Buffer): string
  providerLaunchHmac(provider: ScheduledOccurrenceLaunchProvider, payload: Buffer): string
  verifyProviderLaunchHmac(
    provider: ScheduledOccurrenceLaunchProvider,
    payload: Buffer,
    mac: string
  ): boolean
  dispose(): void
}

export interface ScheduledOccurrenceAuthorityRootStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: ScheduledOccurrenceAuthoritySafeStorage
}

interface PersistedAuthorityRootEnvelope {
  readonly schemaVersion: 1
  readonly rootId: string
  readonly createdAt: string
  readonly encryptedRoot: string
}

interface PersistedAuthorityRootSecret {
  readonly schemaVersion: 1
  readonly purpose: typeof ROOT_PURPOSE
  readonly rootId: string
  readonly rootKeyBase64: string
}

interface PersistedAuthorityRootLock {
  readonly schemaVersion: 1
  readonly purpose: typeof ROOT_LOCK_PURPOSE
  readonly pid: number
  readonly createdAt: string
  readonly nonce: string
}

interface PreparedAuthorityRoot {
  readonly root: Buffer
  readonly rootId: string
  readonly serialized: string
}

interface OwnedInitializationLock {
  readonly serialized: string
  readonly identity: FileIdentity
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

interface PublishedFile {
  readonly identity: FileIdentity
}

/**
 * Owns the durable, safeStorage-encrypted root for scheduled-occurrence
 * authority. Construct this store only after Electron's app-ready boundary so
 * safeStorage has selected its final platform backend.
 */
export class ScheduledOccurrenceAuthorityRootStore {
  private readonly rootPath: string
  private readonly lockPath: string
  private readonly safeStorage: ScheduledOccurrenceAuthoritySafeStorage
  private readonly platform: NodeJS.Platform

  constructor(options: ScheduledOccurrenceAuthorityRootStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Scheduled occurrence authority root options are required.')
    }
    if (typeof options.userDataPath !== 'string' || options.userDataPath.length === 0) {
      throw new TypeError('A userData path is required for scheduled occurrence authority.')
    }
    this.rootPath = join(options.userDataPath, SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_FILENAME)
    this.lockPath = join(
      options.userDataPath,
      SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_LOCK_FILENAME
    )
    this.safeStorage = options.safeStorage
    // Neither filesystem durability nor safeStorage backend enforcement is
    // caller-selectable. Both are bound to the actual process platform.
    this.platform = process.platform
  }

  loadOrCreate(): ScheduledOccurrenceAuthorityRoot {
    this.assertDurableFilesystemPlatform()
    this.assertSecureStorageAvailable()
    if (pathEntryExists(this.rootPath)) {
      // A hard-linked root is visible before directory fsync completes. The
      // owned lock is the durable-ready barrier: never expose a closure while
      // any lock remains, even if the root envelope itself is valid.
      if (pathEntryExists(this.lockPath)) {
        throw new Error(
          'The scheduled occurrence authority root is not ready because an initialization ' +
            'lock remains; refusing root access or automatic lock recovery.'
        )
      }
      return this.loadExisting()
    }

    const lock = this.acquireInitializationLock()
    if (pathEntryExists(this.rootPath)) {
      // A cooperating initializer may have completed after our first root
      // observation but before this process acquired the now-free lock. This
      // process owns only its newly published lock, so release that exact lock
      // and perform one bounded, non-creating load of the durable winner.
      try {
        releaseInitializationLock(this.lockPath, lock, this.platform)
      } catch (error) {
        throw authorityRootError(
          'A durable authority root appeared before initialization, but this process could not ' +
            'release its exact initialization lock',
          error
        )
      }
      if (!pathEntryExists(this.rootPath)) {
        throw new Error(
          'The durable authority root disappeared after the late-initializer race; refusing to ' +
            'generate a replacement.'
        )
      }
      if (pathEntryExists(this.lockPath)) {
        throw new Error(
          'The scheduled occurrence authority root is not ready because an initialization ' +
            'lock appeared during late-initializer recovery.'
        )
      }
      return this.loadExisting()
    }

    let candidate: PreparedAuthorityRoot | null = null
    let operationError: unknown = null
    let preserveLock = false
    let candidateRootVisible = false

    try {
      this.assertNoOrphanedAuthorityArtifacts()
      candidate = this.prepareAuthorityRoot()

      // safeStorage encryption and unrelated synchronous callbacks happen
      // after the first scan. Revalidate immediately before publication.
      this.assertNoOrphanedAuthorityArtifacts()
      const published = publishNoClobber(
        this.rootPath,
        candidate.serialized,
        this.platform
      )
      if (!published) {
        preserveLock = true
        throw new Error(
          'An unproven authority root won publication despite this process owning the ' +
            'initialization lock; preserving the lock and refusing to adopt it.'
        )
      } else {
        candidateRootVisible = true
        // No cooperating reader can access the visible candidate until the
        // exact lock is released. Revalidate once more after durable root
        // publication, while rollback is still safe.
        this.assertNoOrphanedAuthorityArtifacts()
        const verification = verifyExactPublishedRegularFile(
          this.rootPath,
          candidate.serialized,
          published.identity
        )
        if (verification !== 'exact') {
          preserveLock = true
          throw new Error(
            `The published authority root lost its exact file identity or content ` +
              `(${verification}); preserving the initialization lock.`
          )
        }
      }
    } catch (error) {
      operationError = error
      const windowsRootIsVisible =
        this.platform === 'win32' &&
        (candidateRootVisible ||
          (error instanceof VisibleFilePublicationError && error.path === this.rootPath))
      if (windowsRootIsVisible) {
        // On Windows the target inode itself is opened with O_EXCL and becomes
        // visible before fsyncSync completes its FlushFileBuffers call. The exact lock is
        // therefore the recovery barrier: never unlink an uncertain visible
        // root or expose a closure after any subsequent failure.
        preserveLock = true
        operationError = authorityRootError(
          'Scheduled occurrence authority initialization failed after its Windows root became ' +
            'visible; preserving the root and initialization lock for explicit recovery',
          error
        )
      } else if (candidate && !preserveLock) {
        const rollback = rollbackCandidateRoot(
          this.rootPath,
          candidate.serialized,
          this.platform
        )
        if (rollback === 'unsafe') {
          preserveLock = true
          operationError = authorityRootError(
            'Scheduled occurrence authority initialization failed and its candidate root could ' +
              'not be rolled back safely; preserving the initialization lock',
            error
          )
        }
      }
    }

    if (!preserveLock) {
      try {
        releaseInitializationLock(this.lockPath, lock, this.platform)
      } catch (error) {
        operationError ??= authorityRootError(
          'The scheduled occurrence authority initialization lock could not be released',
          error
        )
      }
    }

    if (operationError !== null) {
      candidate?.root.fill(0)
      throw operationError
    }
    if (!candidate) {
      throw new Error('Scheduled occurrence authority initialization produced no root.')
    }
    return createAuthorityRoot(candidate.root, candidate.rootId)
  }

  private assertDurableFilesystemPlatform(): void {
    if (
      this.platform === 'darwin' ||
      this.platform === 'linux' ||
      this.platform === 'win32'
    ) {
      return
    }
    throw new Error(
      `Scheduled occurrence authority is unavailable on ${this.platform}: no reviewed ` +
        'durable no-clobber publication protocol is defined for this platform.'
    )
  }

  private assertSecureStorageAvailable(): void {
    let encryptionAvailable = false
    try {
      encryptionAvailable = this.safeStorage.isEncryptionAvailable() === true
    } catch (error) {
      throw authorityRootError('Electron safeStorage availability could not be determined', error)
    }
    if (!encryptionAvailable) {
      throw new Error(
        'Electron safeStorage encryption is unavailable; refusing to load or create the ' +
          'scheduled occurrence authority root.'
      )
    }

    if (this.platform !== 'linux') return
    let backend: string | undefined
    try {
      backend = this.safeStorage.getSelectedStorageBackend?.()
    } catch (error) {
      throw authorityRootError('The Linux safeStorage backend could not be determined', error)
    }
    if (!backend || !LINUX_ENCRYPTED_BACKENDS.has(backend)) {
      throw new Error(
        `Electron safeStorage selected unsupported Linux backend ${backend ?? 'unknown'}; ` +
          'scheduled occurrence authority requires gnome_libsecret or a supported kwallet backend.'
      )
    }
  }

  private loadExisting(): ScheduledOccurrenceAuthorityRoot {
    let outer: PersistedAuthorityRootEnvelope
    let persisted: BoundedRegularFile
    try {
      persisted = readBoundedRegularFile(
        this.rootPath,
        ROOT_FILE_MAX_BYTES,
        'scheduled occurrence authority root'
      )
      outer = parseOuterEnvelope(persisted.text)
    } catch (error) {
      throw authorityRootError(
        'The scheduled occurrence authority root exists but cannot be read; refusing to replace it',
        error
      )
    }

    let root: Buffer | null = null
    try {
      const encrypted = decodeCanonicalBase64(outer.encryptedRoot, 'encryptedRoot')
      const plaintext = this.safeStorage.decryptString(encrypted)
      const inner = parseInnerSecret(plaintext)
      root = decodeCanonicalBase64(inner.rootKeyBase64, 'rootKeyBase64')
      if (root.byteLength !== ROOT_BYTES) {
        throw new Error(`rootKeyBase64 must decode to exactly ${ROOT_BYTES} bytes`)
      }
      const derivedRootId = rootIdFor(root)
      if (outer.rootId !== inner.rootId || inner.rootId !== derivedRootId) {
        throw new Error('persisted rootId does not match the encrypted authority root')
      }
      const verification = verifyExactPublishedRegularFile(
        this.rootPath,
        persisted.text,
        persisted.identity
      )
      if (verification !== 'exact') {
        throw new Error(
          `persisted authority root changed while it was being loaded (${verification})`
        )
      }
      const authority = createAuthorityRoot(root, derivedRootId)
      root = null
      return authority
    } catch (error) {
      throw authorityRootError(
        'The scheduled occurrence authority root exists but cannot be decrypted or verified; ' +
          'refusing to replace it',
        error
      )
    } finally {
      root?.fill(0)
    }
  }

  private prepareAuthorityRoot(): PreparedAuthorityRoot {
    const root = randomBytes(ROOT_BYTES)
    try {
      const rootId = rootIdFor(root)
      const inner: PersistedAuthorityRootSecret = {
        schemaVersion: 1,
        purpose: ROOT_PURPOSE,
        rootId,
        rootKeyBase64: root.toString('base64')
      }
      const encrypted = this.safeStorage.encryptString(JSON.stringify(inner))
      if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
        throw new Error('safeStorage returned an invalid encrypted authority root')
      }
      const outer: PersistedAuthorityRootEnvelope = {
        schemaVersion: 1,
        rootId,
        createdAt: new Date().toISOString(),
        encryptedRoot: encrypted.toString('base64')
      }
      return { root, rootId, serialized: JSON.stringify(outer) + '\n' }
    } catch (error) {
      root.fill(0)
      throw authorityRootError('The scheduled occurrence authority root could not be created', error)
    }
  }

  private acquireInitializationLock(): OwnedInitializationLock {
    const record: PersistedAuthorityRootLock = {
      schemaVersion: 1,
      purpose: ROOT_LOCK_PURPOSE,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: randomBytes(16).toString('base64')
    }
    const serialized = JSON.stringify(record) + '\n'
    const published = publishNoClobber(this.lockPath, serialized, this.platform)
    if (published) {
      return { serialized, identity: published.identity }
    }

    // A dead-PID lock is not removed here. read/compare/unlink cannot provide
    // inode-atomic compare-and-delete, so two recovery contenders could remove
    // one another's newly acquired lock. Explicit serialized/manual recovery
    // is required for every pre-existing lock, regardless of apparent age.
    throw new Error(
      'A scheduled occurrence authority initialization lock already exists; refusing root ' +
        'access or automatic stale-lock recovery.'
    )
  }

  private assertNoOrphanedAuthorityArtifacts(): void {
    const directory = dirname(this.rootPath)
    const tasksPath = join(directory, SCHEDULED_TASKS_FILENAME)
    const mutationPath = join(directory, SCHEDULED_OCCURRENCE_MUTATION_FILENAME)
    if (artifactPathExists(tasksPath, SCHEDULED_TASKS_FILENAME)) {
      scanScheduledTasksForSeals(tasksPath)
    }
    if (artifactPathExists(mutationPath, SCHEDULED_OCCURRENCE_MUTATION_FILENAME)) {
      scanScheduledOccurrenceMutationForSeals(mutationPath)
    }
  }
}

class VisibleFilePublicationError extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `A no-clobber file became visible at ${path} before publication completed (${detail}).`,
      { cause }
    )
    this.name = 'VisibleFilePublicationError'
    this.path = path
  }
}

function publishNoClobber(
  targetPath: string,
  serialized: string,
  platform: NodeJS.Platform
): PublishedFile | null {
  if (platform === 'win32') return publishNoClobberWindows(targetPath, serialized)
  return publishNoClobberPosix(targetPath, serialized)
}

/**
 * Write and fsync a same-directory temporary inode, then publish it with an
 * atomic hard-link. link(2) is deliberately used instead of rename(2): it
 * fails with EEXIST rather than replacing a concurrently published file.
 */
function publishNoClobberPosix(targetPath: string, serialized: string): PublishedFile | null {
  const directory = dirname(targetPath)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
  )
  let temporaryFd: number | null = null
  let temporaryExists = false
  let identity: FileIdentity | null = null
  try {
    temporaryFd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    temporaryExists = true
    fchmodSync(temporaryFd, 0o600)
    writeFileSync(temporaryFd, serialized, 'utf8')
    fsyncSync(temporaryFd)
    identity = requireRegularFileIdentity(
      fstatSync(temporaryFd, { bigint: true }),
      'temporary no-clobber publication file'
    )
    const completedFd = temporaryFd
    temporaryFd = null
    closeSync(completedFd)

    try {
      linkSync(temporaryPath, targetPath)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
      unlinkSync(temporaryPath)
      temporaryExists = false
      fsyncDirectory(directory)
      return null
    }

    unlinkSync(temporaryPath)
    temporaryExists = false
    fsyncDirectory(directory)
    return { identity }
  } finally {
    if (temporaryFd !== null) closeSync(temporaryFd)
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // Preserve the original durability failure. An unpredictable temp
        // name is never treated as the lock or authority root.
      }
    }
  }
}

/**
 * libuv maps fsync to FlushFileBuffers on Windows. O_EXCL supplies the
 * no-clobber decision, while the initialization lock is the visibility barrier
 * for the target inode during its write and explicit flush. Once open succeeds,
 * any failure preserves the visible file for explicit recovery rather than
 * pretending it was never published.
 */
function publishNoClobberWindows(
  targetPath: string,
  serialized: string
): PublishedFile | null {
  mkdirSync(dirname(targetPath), { recursive: true })
  let fd: number | null = null
  let visible = false
  let identity: FileIdentity | null = null
  try {
    try {
      fd = openSync(
        targetPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      )
      visible = true
    } catch (error) {
      if (isAlreadyExistsError(error)) return null
      throw error
    }

    writeFileSync(fd, serialized, 'utf8')
    fsyncSync(fd)
    identity = requireRegularFileIdentity(
      fstatSync(fd, { bigint: true }),
      'Windows no-clobber publication file'
    )
    const completedFd = fd
    fd = null
    closeSync(completedFd)
    return { identity }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The first write/flush/close error remains authoritative. The visible
        // file and initialization lock are intentionally preserved.
      }
    }
    if (visible) throw new VisibleFilePublicationError(targetPath, error)
    throw error
  }
}

type ExactFileRemoval = 'removed' | 'absent' | 'different' | 'unsafe'
type ExactPublishedFileVerification = 'exact' | 'different' | 'unsafe'

function verifyExactPublishedRegularFile(
  path: string,
  expected: string,
  expectedIdentity: FileIdentity
): ExactPublishedFileVerification {
  try {
    const opened = readBoundedRegularFile(path, ROOT_FILE_MAX_BYTES, 'published authority root')
    if (
      opened.text !== expected ||
      opened.identity.dev !== expectedIdentity.dev ||
      opened.identity.ino !== expectedIdentity.ino
    ) {
      return 'different'
    }
    return 'exact'
  } catch {
    return 'unsafe'
  }
}

function removeExactRegularFile(
  path: string,
  expected: string,
  maxBytes: number,
  platform: NodeJS.Platform,
  expectedIdentity?: FileIdentity
): ExactFileRemoval {
  try {
    const opened = readBoundedRegularFile(path, maxBytes, 'exact authority file')
    if (
      opened.text !== expected ||
      (expectedIdentity !== undefined &&
        (opened.identity.dev !== expectedIdentity.dev ||
          opened.identity.ino !== expectedIdentity.ino))
    ) {
      return 'different'
    }
    const current = lstatSync(path, { bigint: true })
    if (
      !current.isFile() ||
      current.dev !== opened.identity.dev ||
      current.ino !== opened.identity.ino
    ) {
      return 'different'
    }
    unlinkSync(path)
    // Windows has no Node directory-handle FlushFileBuffers primitive. A
    // resurrected initialization lock is nevertheless fail-closed: every
    // reader refuses a root while any lock entry exists.
    if (platform !== 'win32') fsyncDirectory(dirname(path))
    return 'removed'
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return 'absent'
    return 'unsafe'
  }
}

function releaseInitializationLock(
  path: string,
  lock: OwnedInitializationLock,
  platform: NodeJS.Platform
): void {
  const removal = removeExactRegularFile(
    path,
    lock.serialized,
    LOCK_FILE_MAX_BYTES,
    platform,
    lock.identity
  )
  if (removal !== 'removed') {
    throw new Error(`Initialization lock ownership was lost (${removal}).`)
  }
}

function rollbackCandidateRoot(
  path: string,
  serialized: string,
  platform: NodeJS.Platform
): 'safe' | 'unsafe' {
  const removal = removeExactRegularFile(path, serialized, ROOT_FILE_MAX_BYTES, platform)
  return removal === 'removed' || removal === 'absent' ? 'safe' : 'unsafe'
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

function createAuthorityRoot(root: Buffer, rootId: string): ScheduledOccurrenceAuthorityRoot {
  let key: Buffer | null = root

  const fixedDomainHmac = (domain: string, payload: Buffer): string => {
    if (key === null) throw new Error('The scheduled occurrence authority root is disposed.')
    if (!Buffer.isBuffer(payload)) throw new TypeError('Authority payload must be a Buffer.')
    return createHmac('sha256', key).update(domain).update(payload).digest('hex')
  }
  const verifyFixedDomainHmac = (domain: string, payload: Buffer, mac: string): boolean => {
    if (key === null) throw new Error('The scheduled occurrence authority root is disposed.')
    if (!Buffer.isBuffer(payload)) throw new TypeError('Authority payload must be a Buffer.')
    if (typeof mac !== 'string' || !LOWER_HEX_256.test(mac)) return false
    const expected = Buffer.from(fixedDomainHmac(domain, payload), 'hex')
    return timingSafeEqual(expected, Buffer.from(mac, 'hex'))
  }

  return Object.freeze({
    rootId,
    sealPayloadMac: (payload: Buffer) => fixedDomainHmac(SEAL_PAYLOAD_DOMAIN, payload),
    verifySealPayloadMac: (payload: Buffer, mac: string) =>
      verifyFixedDomainHmac(SEAL_PAYLOAD_DOMAIN, payload, mac),
    walPayloadMac: (payload: Buffer) => fixedDomainHmac(WAL_PAYLOAD_DOMAIN, payload),
    verifyWalPayloadMac: (payload: Buffer, mac: string) =>
      verifyFixedDomainHmac(WAL_PAYLOAD_DOMAIN, payload, mac),
    runtimeProfileSetHmac: (payload: Buffer) =>
      fixedDomainHmac(RUNTIME_PROFILE_SET_DOMAIN, payload),
    permissionPostureSetHmac: (payload: Buffer) =>
      fixedDomainHmac(PERMISSION_POSTURE_SET_DOMAIN, payload),
    providerLaunchHmac: (provider: ScheduledOccurrenceLaunchProvider, payload: Buffer) =>
      fixedDomainHmac(providerLaunchDomain(provider), payload),
    verifyProviderLaunchHmac: (
      provider: ScheduledOccurrenceLaunchProvider,
      payload: Buffer,
      mac: string
    ) => verifyFixedDomainHmac(providerLaunchDomain(provider), payload, mac),
    dispose: () => {
      if (key === null) return
      key.fill(0)
      key = null
    }
  })
}

function providerLaunchDomain(provider: ScheduledOccurrenceLaunchProvider): string {
  if (
    typeof provider !== 'string' ||
    !Object.prototype.hasOwnProperty.call(SCHEDULED_OCCURRENCE_LAUNCH_PROVIDERS, provider)
  ) {
    throw new TypeError('Scheduled occurrence provider launch authority requires a runnable provider.')
  }
  return `${PROVIDER_LAUNCH_DOMAIN}${provider}\0`
}

function parseOuterEnvelope(serialized: string): PersistedAuthorityRootEnvelope {
  const value = parseJsonObject(serialized, 'authority root envelope')
  assertExactKeys(value, OUTER_KEYS, 'authority root envelope')
  if (value.schemaVersion !== 1) throw new Error('authority root envelope schemaVersion must be 1')
  const rootId = requireRootId(value.rootId)
  const createdAt = requireCanonicalIso(value.createdAt, 'createdAt')
  const encryptedRoot = requireCanonicalBase64(value.encryptedRoot, 'encryptedRoot')
  return { schemaVersion: 1, rootId, createdAt, encryptedRoot }
}

function parseInnerSecret(serialized: string): PersistedAuthorityRootSecret {
  const value = parseJsonObject(serialized, 'encrypted authority root')
  assertExactKeys(value, INNER_KEYS, 'encrypted authority root')
  if (value.schemaVersion !== 1) throw new Error('encrypted authority root schemaVersion must be 1')
  if (value.purpose !== ROOT_PURPOSE) throw new Error('encrypted authority root purpose is invalid')
  const rootId = requireRootId(value.rootId)
  const rootKeyBase64 = requireCanonicalBase64(value.rootKeyBase64, 'rootKeyBase64')
  return { schemaVersion: 1, purpose: ROOT_PURPOSE, rootId, rootKeyBase64 }
}

function scanScheduledTasksForSeals(path: string): void {
  const value = parseArtifactJson(path, SCHEDULED_TASKS_FILENAME)
  if (!Array.isArray(value)) {
    throw missingRootBarrier(`${SCHEDULED_TASKS_FILENAME} is not an array`)
  }
  for (const [index, task] of value.entries()) {
    if (!isPlainObject(task)) {
      throw missingRootBarrier(`${SCHEDULED_TASKS_FILENAME}[${index}] is malformed`)
    }
    if (Object.prototype.hasOwnProperty.call(task, 'occurrenceSeal')) {
      validateLegacyOccurrenceSeal(
        task.occurrenceSeal,
        `${SCHEDULED_TASKS_FILENAME}[${index}]`
      )
    }
  }
}

function scanScheduledOccurrenceMutationForSeals(path: string): void {
  const value = parseArtifactJson(path, SCHEDULED_OCCURRENCE_MUTATION_FILENAME)
  // The paired-WAL store persists JSON null after a clean replay/settlement.
  if (value === null) return
  if (!isPlainObject(value)) {
    throw missingRootBarrier(`${SCHEDULED_OCCURRENCE_MUTATION_FILENAME} is malformed`)
  }
  if (value.schemaVersion !== 1) {
    throw missingRootBarrier(
      `${SCHEDULED_OCCURRENCE_MUTATION_FILENAME} has an unsupported authority schema`
    )
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'taskBefore')) {
    throw missingRootBarrier(`${SCHEDULED_OCCURRENCE_MUTATION_FILENAME} has no taskBefore image`)
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'taskAfter')) {
    throw missingRootBarrier(`${SCHEDULED_OCCURRENCE_MUTATION_FILENAME} has no taskAfter image`)
  }
  scanMutationTaskImage(value.taskBefore, 'taskBefore', true)
  scanMutationTaskImage(value.taskAfter, 'taskAfter', false)
}

function scanMutationTaskImage(value: unknown, label: string, nullable: boolean): void {
  if (nullable && value === null) return
  if (!isPlainObject(value)) {
    throw missingRootBarrier(`${SCHEDULED_OCCURRENCE_MUTATION_FILENAME}.${label} is malformed`)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'occurrenceSeal')) {
    validateLegacyOccurrenceSeal(value.occurrenceSeal, `${SCHEDULED_OCCURRENCE_MUTATION_FILENAME}.${label}`)
  }
}

function parseArtifactJson(path: string, label: string): unknown {
  try {
    return JSON.parse(
      readBoundedRegularFile(path, SCHEDULING_ARTIFACT_MAX_BYTES, label).text
    ) as unknown
  } catch (error) {
    throw missingRootBarrier(
      `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
}

function artifactPathExists(path: string, label: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false
    }
    throw missingRootBarrier(
      `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
}

function validateLegacyOccurrenceSeal(value: unknown, label: string): void {
  try {
    if (!isPlainObject(value)) throw new Error('occurrenceSeal must be a plain object')
    assertExactKeys(value, LEGACY_SEAL_KEYS, `${label}.occurrenceSeal`)
    if (value.schemaVersion !== 1) {
      throw new Error('only the exact legacy schemaVersion 1 seal is migration-safe')
    }
    requireCanonicalIso(value.issuedAt, `${label}.occurrenceSeal.issuedAt`)
    requireLowerHex256(value.taskAuthorityDigest, `${label}.occurrenceSeal.taskAuthorityDigest`)
    if (value.compositeWorkflowAuthorityDigest !== null) {
      requireLowerHex256(
        value.compositeWorkflowAuthorityDigest,
        `${label}.occurrenceSeal.compositeWorkflowAuthorityDigest`
      )
    }
    requireCanonicalWorkspacePath(
      value.workspaceRealPath,
      `${label}.occurrenceSeal.workspaceRealPath`
    )
    requireLowerHex256(
      value.runtimeProfileSetHmac,
      `${label}.occurrenceSeal.runtimeProfileSetHmac`
    )
    requireLowerHex256(
      value.permissionPostureSetHmac,
      `${label}.occurrenceSeal.permissionPostureSetHmac`
    )
    requireLowerHex256(value.sealSignature, `${label}.occurrenceSeal.sealSignature`)
  } catch (error) {
    throw missingRootBarrier(`${label} contains an unsupported or malformed occurrenceSeal`, error)
  }
}

function parseJsonObject(serialized: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a plain JSON object`)
  return parsed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error(`${label} does not match its exact schema`)
  }
}

function rootIdFor(root: Buffer): string {
  return `${ROOT_ID_PREFIX}${createHash('sha256').update(root).digest('hex')}`
}

function requireRootId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(ROOT_ID_PREFIX) ||
    !LOWER_HEX_256.test(value.slice(ROOT_ID_PREFIX.length))
  ) {
    throw new Error('rootId is invalid')
  }
  return value
}

function requireLowerHex256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWER_HEX_256.test(value)) {
    throw new Error(`${label} must be 64-character lowercase hexadecimal`)
  }
  return value
}

function requireCanonicalWorkspacePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_AUTHORITY_PATH_LENGTH ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    parse(value).root === value
  ) {
    throw new Error(`${label} must be a canonical absolute non-root path`)
  }
  return value
}

function requireCanonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a canonical ISO timestamp`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return value
}

function requireCanonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    throw new Error(`${label} must be non-empty canonical base64`)
  }
  return value
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  return Buffer.from(requireCanonicalBase64(value, label), 'base64')
}

interface BoundedRegularFile {
  readonly text: string
  readonly identity: FileIdentity
}

function requireRegularFileIdentity(
  stat: { isFile(): boolean; dev: bigint; ino: bigint },
  label: string
): FileIdentity {
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`)
  if (!usableFileIdentity(stat.dev, stat.ino)) {
    throw new Error(`${label} filesystem does not expose a stable descriptor identity`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string
): BoundedRegularFile {
  const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const nonBlock = (constants as unknown as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
  let fd: number | null = null
  try {
    // O_NONBLOCK prevents a FIFO swapped into place before open from hanging
    // startup indefinitely. It does not change regular-file read semantics.
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock)
    const descriptorStat = fstatSync(fd, { bigint: true })
    const identity = requireRegularFileIdentity(descriptorStat, label)
    if (
      descriptorStat.size < 0n ||
      descriptorStat.size > BigInt(maxBytes)
    ) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte authority read limit`)
    }

    // O_NOFOLLOW is not available on every supported platform. Pinning the
    // descriptor and comparing its identity to lstat still rejects a symlink
    // (and any path swap that occurred between open and this check).
    const pathStat = lstatSync(path, { bigint: true })
    if (
      !pathStat.isFile() ||
      !usableFileIdentity(pathStat.dev, pathStat.ino) ||
      pathStat.dev !== descriptorStat.dev ||
      pathStat.ino !== descriptorStat.ino
    ) {
      throw new Error(`${label} path does not identify the opened regular file`)
    }

    const chunks: Buffer[] = []
    let byteLength = 0
    while (byteLength <= maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_BYTES, maxBytes + 1 - byteLength)
      )
      const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes}-byte authority read limit`)
      }
      chunks.push(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead))
    }
    return {
      text: Buffer.concat(chunks, byteLength).toString('utf8'),
      identity
    }
  } catch (error) {
    throw authorityRootError(`${label} cannot be read safely`, error)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function usableFileIdentity(dev: bigint, ino: bigint): boolean {
  return dev >= 0n && ino > 0n
}

function hasErrnoCode(error: unknown, code: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return false
    if ('code' in current && (current as NodeJS.ErrnoException).code === code) return true
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function authorityRootError(message: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${message} (${detail}).`, { cause })
}

function missingRootBarrier(message: string, cause?: unknown): Error {
  return new Error(
    'The scheduled occurrence authority root is missing while durable scheduling artifacts ' +
      `cannot be proven authority-free (${message}). Refusing to generate a replacement root.`,
    cause === undefined ? undefined : { cause }
  )
}
