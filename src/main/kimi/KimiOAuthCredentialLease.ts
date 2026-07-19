import { createHash, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { constants, promises as nodeFs } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'

const AUTHORITY_DIRECTORY = '.taskwraith-oauth-authority-v1'
const TRANSITION_LOCK_DIRECTORY = 'transition.lock'
const TRANSITION_RECLAIM_GUARD_DIRECTORY = 'transition.reclaim.lock'
const TRANSITION_OWNER_FILE = 'owner.json'
const LEASE_RECORD_FILE = 'lease.json'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const PRIMARY_CREDENTIAL = 'credentials/kimi-code.json'
const CREDENTIAL_ARTEFACTS = [PRIMARY_CREDENTIAL, 'oauth/kimi-code', 'device_id'] as const

interface TransitionOwner {
  version: 1
  pid: number
  instanceId: string
  createdAt: number
}

interface DurableLeaseRecord {
  version: 1
  leaseId: string
  ownerPid: number
  ownerInstanceId: string
  createdAt: number
  phase: 'claimed' | 'seeded' | 'committed' | 'scrubbed'
  sourceHome: string
  isolatedHome: string
  boundaryRoot: string
  expectedCredentialSha256: string
  providerPid?: number
  providerProcessIdentity?: string
  /** Fsynced before the source credential's atomic expected-old → new rename. */
  pendingCredentialSha256?: string
  pendingOutcome?: 'rotated'
  committedOutcome?: KimiOAuthCredentialLeaseCommit
  committedCredentialSha256?: string
}

export type KimiOAuthCredentialLeaseCommit = 'unchanged' | 'rotated' | 'stale-rejected'

export interface KimiOAuthCredentialLease {
  /** Seed the exact authority snapshot captured while the durable lease was claimed. */
  seedIntoIsolatedHome: () => Promise<void>
  /** Persist the spawned provider identity before the first ACP initialize. */
  noteProviderProcess: (pid: number) => Promise<void>
  /**
   * Compare-and-swap any rotated credential back to the authority and release
   * the durable lease. Idempotent after a successful release.
   */
  commitAndRelease: () => Promise<KimiOAuthCredentialLeaseCommit>
}

export interface KimiOAuthCredentialLeaseRequest {
  sourceHome: string
  isolatedHome: string
  boundaryRoot: string
}

export type KimiOAuthCredentialLeaseAcquireResult =
  | { ok: true; lease: KimiOAuthCredentialLease }
  | { ok: false; reason: 'busy' | 'error'; message: string }

export interface KimiOAuthCredentialAuthorityOptions {
  pid?: number
  instanceId?: string
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  processIdentity?: (pid: number) => Promise<string | null>
  transitionWaitMs?: number
  /** Test-only crash seam at durable state-machine boundaries. */
  onTransition?: (
    point:
      | 'after-primary-commit'
      | 'after-committed-marker'
      | 'after-scrub'
      | 'before-record-remove'
  ) => void | Promise<void>
  /** Test-only barriers for deterministic cross-process lock interleavings. */
  onLockTransition?: (
    point: 'after-stale-observed' | 'after-reclaim-guard-acquired' | 'after-lock-acquired'
  ) => void | Promise<void>
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function credentialExpiry(raw: Buffer): number {
  try {
    const value = (JSON.parse(raw.toString('utf8')) as { expires_at?: unknown }).expires_at
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function parseRecord(raw: string): DurableLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<DurableLeaseRecord>
    const phase = String(value.phase)
    const hasProviderPid = value.providerPid !== undefined
    const hasProviderIdentity = value.providerProcessIdentity !== undefined
    const hasPendingDigest = value.pendingCredentialSha256 !== undefined
    const hasPendingOutcome = value.pendingOutcome !== undefined
    const hasCommittedState = phase === 'committed' || phase === 'scrubbed'
    if (
      value.version !== 1 ||
      typeof value.leaseId !== 'string' ||
      value.leaseId.length === 0 ||
      !Number.isSafeInteger(value.ownerPid) ||
      Number(value.ownerPid) <= 0 ||
      typeof value.ownerInstanceId !== 'string' ||
      value.ownerInstanceId.length === 0 ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      !['claimed', 'seeded', 'committed', 'scrubbed'].includes(phase) ||
      typeof value.sourceHome !== 'string' ||
      !isAbsolute(value.sourceHome) ||
      typeof value.isolatedHome !== 'string' ||
      !isAbsolute(value.isolatedHome) ||
      typeof value.boundaryRoot !== 'string' ||
      !isAbsolute(value.boundaryRoot) ||
      typeof value.expectedCredentialSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.expectedCredentialSha256) ||
      hasProviderPid !== hasProviderIdentity ||
      (hasProviderPid &&
        (!Number.isSafeInteger(value.providerPid) ||
          Number(value.providerPid) <= 0 ||
          typeof value.providerProcessIdentity !== 'string' ||
          value.providerProcessIdentity.length === 0)) ||
      hasPendingDigest !== hasPendingOutcome ||
      (hasPendingDigest &&
        (phase !== 'seeded' ||
          value.pendingOutcome !== 'rotated' ||
          typeof value.pendingCredentialSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.pendingCredentialSha256))) ||
      (hasCommittedState &&
        (!['unchanged', 'rotated', 'stale-rejected'].includes(String(value.committedOutcome)) ||
          typeof value.committedCredentialSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.committedCredentialSha256)))
    ) {
      return null
    }
    return value as DurableLeaseRecord
  } catch {
    return null
  }
}

function defaultProcessLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error, 'EPERM')
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | null = null
  try {
    handle = await nodeFs.open(path, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    if (!isErrno(error, 'EINVAL') && !isErrno(error, 'EPERM') && !isErrno(error, 'EISDIR')) {
      throw error
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function assertPrivateDirectory(path: string): Promise<string> {
  const stat = await nodeFs.lstat(path)
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    throw new Error('Kimi OAuth authority path is not a private real directory.')
  }
  await nodeFs.chmod(path, PRIVATE_DIRECTORY_MODE)
  const privateStat = await nodeFs.lstat(path)
  if ((privateStat.mode & 0o077) !== 0 || privateStat.isSymbolicLink()) {
    throw new Error('Kimi OAuth authority directory is not mode 0700.')
  }
  return nodeFs.realpath(path)
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  try {
    await nodeFs.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
  }
  return assertPrivateDirectory(path)
}

async function readPrivateFileWithin(root: string, path: string): Promise<Buffer> {
  const [rootReal, parentReal] = await Promise.all([
    nodeFs.realpath(root),
    nodeFs.realpath(join(path, '..'))
  ])
  if (!pathIsWithin(rootReal, parentReal)) {
    throw new Error('Kimi OAuth credential artefact escaped its private root.')
  }
  const handle = await nodeFs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const [opened, pathStat] = await Promise.all([handle.stat(), nodeFs.lstat(path)])
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino ||
      !opened.isFile() ||
      pathStat.isSymbolicLink() ||
      opened.nlink !== 1 ||
      (currentUid !== undefined && opened.uid !== currentUid) ||
      (opened.mode & 0o077) !== 0
    ) {
      throw new Error('Kimi OAuth credential artefact is not a private regular file.')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function readOptionalPrivateFileWithin(root: string, path: string): Promise<Buffer | null> {
  try {
    return await readPrivateFileWithin(root, path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
}

async function atomicWritePrivateFile(root: string, path: string, data: Buffer): Promise<void> {
  const rootReal = await nodeFs.realpath(root)
  const parent = join(path, '..')
  const parentReal = await assertPrivateDirectory(parent)
  if (!pathIsWithin(rootReal, parentReal)) {
    throw new Error('Kimi OAuth atomic write escaped its private authority root.')
  }
  try {
    const existing = await nodeFs.lstat(path)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error('Kimi OAuth atomic-write target is not a private regular file.')
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }

  const temporary = join(parent, `.taskwraith-${process.pid}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | null = null
  try {
    handle = await nodeFs.open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE
    )
    await handle.writeFile(data)
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.sync()
    await handle.close()
    handle = null
    await nodeFs.rename(temporary, path)
    await fsyncDirectory(parentReal)
    const committed = await nodeFs.lstat(path)
    if (
      !committed.isFile() ||
      committed.isSymbolicLink() ||
      committed.nlink !== 1 ||
      (committed.mode & 0o077) !== 0
    ) {
      throw new Error('Kimi OAuth atomic write did not commit a private regular file.')
    }
  } finally {
    await handle?.close().catch(() => {})
    await nodeFs.rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Cross-seat and cross-process authority for Kimi Code's single-use OAuth
 * refresh token. A durable record spans seed → provider lifetime → writeback;
 * a short private transition lock serializes claim/recovery/release changes.
 */
export class KimiOAuthCredentialAuthority {
  private readonly pid: number
  private readonly instanceId: string
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly processIdentity: (pid: number) => Promise<string | null>
  private readonly transitionWaitMs: number
  private readonly onTransition?: KimiOAuthCredentialAuthorityOptions['onTransition']
  private readonly onLockTransition?: KimiOAuthCredentialAuthorityOptions['onLockTransition']
  private readonly activeLeaseIds = new Set<string>()

  constructor(options: KimiOAuthCredentialAuthorityOptions = {}) {
    this.pid = options.pid ?? process.pid
    this.instanceId = options.instanceId ?? randomUUID()
    this.now = options.now ?? Date.now
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness
    this.processIdentity = options.processIdentity ?? defaultProcessIdentity
    this.transitionWaitMs = options.transitionWaitMs ?? 10_000
    this.onTransition = options.onTransition
    this.onLockTransition = options.onLockTransition
  }

  async acquire(
    request: KimiOAuthCredentialLeaseRequest
  ): Promise<KimiOAuthCredentialLeaseAcquireResult> {
    try {
      const sourceHome = await nodeFs.realpath(request.sourceHome)
      const boundaryRoot = await assertPrivateDirectory(request.boundaryRoot)
      const isolatedHome = await assertPrivateDirectory(request.isolatedHome)
      if (!pathIsWithin(boundaryRoot, isolatedHome)) {
        throw new Error('Kimi OAuth lease home escaped its private boundary.')
      }
      const authorityRoot = await ensurePrivateDirectory(join(sourceHome, AUTHORITY_DIRECTORY))

      return await this.withTransitionLock(authorityRoot, async () => {
        const leasePath = join(authorityRoot, LEASE_RECORD_FILE)
        const existing = await this.readLeaseRecord(authorityRoot)
        if (existing) {
          const ownedAndActive =
            existing.ownerPid === this.pid &&
            existing.ownerInstanceId === this.instanceId &&
            this.activeLeaseIds.has(existing.leaseId)
          if (ownedAndActive || this.isProcessAlive(existing.ownerPid)) {
            return {
              ok: false,
              reason: 'busy',
              message:
                'Another managed Kimi OAuth seat owns the single-use refresh credential. Wait for that seat to finish, then retry.'
            }
          }
          await this.recoverStaleLease(authorityRoot, sourceHome, existing)
        }

        const snapshots = new Map<string, Buffer>()
        for (const rel of CREDENTIAL_ARTEFACTS) {
          const data = await readOptionalPrivateFileWithin(sourceHome, join(sourceHome, rel))
          if (data) snapshots.set(rel, data)
        }
        const expected = snapshots.get(PRIMARY_CREDENTIAL)
        if (!expected) {
          return {
            ok: false,
            reason: 'error',
            message: 'The current Kimi Code OAuth credential is unavailable or unsafe.'
          }
        }

        const record: DurableLeaseRecord = {
          version: 1,
          leaseId: randomUUID(),
          ownerPid: this.pid,
          ownerInstanceId: this.instanceId,
          createdAt: this.now(),
          phase: 'claimed',
          sourceHome,
          isolatedHome,
          boundaryRoot,
          expectedCredentialSha256: sha256(expected)
        }
        await atomicWritePrivateFile(
          authorityRoot,
          leasePath,
          Buffer.from(JSON.stringify(record), 'utf8')
        )
        this.activeLeaseIds.add(record.leaseId)
        return {
          ok: true,
          lease: this.createLease(authorityRoot, record, snapshots)
        }
      })
    } catch {
      return {
        ok: false,
        reason: 'error',
        message:
          'TaskWraith could not establish the private Kimi OAuth credential authority. Managed OAuth execution was not started.'
      }
    }
  }

  private createLease(
    authorityRoot: string,
    record: DurableLeaseRecord,
    snapshots: Map<string, Buffer>
  ): KimiOAuthCredentialLease {
    let released: KimiOAuthCredentialLeaseCommit | null = null
    return {
      seedIntoIsolatedHome: async () => {
        if (released) throw new Error('Kimi OAuth credential lease is already released.')
        for (const [rel, data] of snapshots) {
          const destination = join(record.isolatedHome, rel)
          const parent = join(destination, '..')
          await ensurePrivateDirectory(parent)
          await atomicWritePrivateFile(record.boundaryRoot, destination, data)
        }
        await this.withTransitionLock(authorityRoot, async () => {
          const current = await this.readLeaseRecord(authorityRoot)
          if (!current || current.leaseId !== record.leaseId) {
            throw new Error('Kimi OAuth credential lease ownership changed before seed commit.')
          }
          current.phase = 'seeded'
          await atomicWritePrivateFile(
            authorityRoot,
            join(authorityRoot, LEASE_RECORD_FILE),
            Buffer.from(JSON.stringify(current), 'utf8')
          )
        })
      },
      noteProviderProcess: async (pid) => {
        if (released) throw new Error('Kimi OAuth credential lease is already released.')
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error('Kimi OAuth provider process identity is invalid.')
        }
        const identity = await this.processIdentity(pid)
        if (!identity) {
          throw new Error('Kimi OAuth provider process birth identity is not observable.')
        }
        await this.withTransitionLock(authorityRoot, async () => {
          const current = await this.readLeaseRecord(authorityRoot)
          if (!current || current.leaseId !== record.leaseId || current.phase !== 'seeded') {
            throw new Error('Kimi OAuth credential lease was not seeded before provider spawn.')
          }
          current.providerPid = pid
          current.providerProcessIdentity = identity
          await atomicWritePrivateFile(
            authorityRoot,
            join(authorityRoot, LEASE_RECORD_FILE),
            Buffer.from(JSON.stringify(current), 'utf8')
          )
        })
      },
      commitAndRelease: async () => {
        if (released) return released
        const outcome = await this.withTransitionLock(authorityRoot, async () => {
          const current = await this.readLeaseRecord(authorityRoot)
          if (!current || current.leaseId !== record.leaseId) {
            throw new Error('Kimi OAuth credential lease ownership changed before writeback.')
          }
          return this.finalizeDurableLease(authorityRoot, current)
        })
        this.activeLeaseIds.delete(record.leaseId)
        released = outcome
        return outcome
      }
    }
  }

  private async commitCandidate(
    authorityRoot: string,
    record: DurableLeaseRecord
  ): Promise<KimiOAuthCredentialLeaseCommit> {
    if (record.phase === 'claimed') {
      // Acquire already replayed any durable predecessor. Anything present in
      // this newly claimed, not-yet-seeded home is untrusted crash residue: it
      // is never eligible for authority writeback and is scrubbed below.
      return 'unchanged'
    }

    const currentPath = join(record.sourceHome, PRIMARY_CREDENTIAL)
    const current = await readPrivateFileWithin(record.sourceHome, currentPath)
    const currentDigest = sha256(current)
    // Recovery after the source's atomic rename does not depend on the
    // isolated candidate still existing. The exact candidate digest was
    // durably committed before that rename; matching descriptor-anchored
    // authority bytes are sufficient proof to finish forward.
    if (record.pendingCredentialSha256 && currentDigest === record.pendingCredentialSha256) {
      return 'rotated'
    }

    const candidatePath = join(record.isolatedHome, PRIMARY_CREDENTIAL)
    const candidate = await readOptionalPrivateFileWithin(record.boundaryRoot, candidatePath)
    if (!candidate) {
      throw new Error('The seeded Kimi OAuth credential disappeared before writeback.')
    }
    const candidateDigest = sha256(candidate)
    if (record.pendingCredentialSha256 && candidateDigest !== record.pendingCredentialSha256) {
      throw new Error('The pending Kimi OAuth rotation candidate changed during recovery.')
    }
    if (candidateDigest === record.expectedCredentialSha256) return 'unchanged'
    // Replay after a crash between the atomic primary rename and the committed
    // marker: the authority already equals this candidate, so finish forward.
    if (currentDigest === candidateDigest) return 'rotated'
    if (currentDigest !== record.expectedCredentialSha256) return 'stale-rejected'
    if (credentialExpiry(candidate) <= credentialExpiry(current)) {
      throw new Error('The rotated Kimi OAuth credential did not advance monotonically.')
    }

    if (!record.pendingCredentialSha256) {
      record = {
        ...record,
        pendingCredentialSha256: candidateDigest,
        pendingOutcome: 'rotated'
      }
      // This fsynced intent is the recovery proof if the provider home or its
      // candidate disappears after the primary authority rename.
      await this.writeLeaseRecord(authorityRoot, record)
    }

    // Commit auxiliary state first and the credential JSON last. The final
    // atomic rename is the expected-old → new authority transition.
    for (const rel of CREDENTIAL_ARTEFACTS) {
      if (rel === PRIMARY_CREDENTIAL) continue
      const data = await readOptionalPrivateFileWithin(
        record.boundaryRoot,
        join(record.isolatedHome, rel)
      )
      if (!data) continue
      const destination = join(record.sourceHome, rel)
      await ensurePrivateDirectory(join(destination, '..'))
      await atomicWritePrivateFile(record.sourceHome, destination, data)
    }
    await atomicWritePrivateFile(record.sourceHome, currentPath, candidate)
    await this.onTransition?.('after-primary-commit')
    return 'rotated'
  }

  private async finalizeDurableLease(
    authorityRoot: string,
    initial: DurableLeaseRecord
  ): Promise<KimiOAuthCredentialLeaseCommit> {
    let record = initial
    if (record.phase === 'claimed' || record.phase === 'seeded') {
      const outcome = await this.commitCandidate(authorityRoot, record)
      const committedCredential = await readPrivateFileWithin(
        record.sourceHome,
        join(record.sourceHome, PRIMARY_CREDENTIAL)
      )
      const {
        pendingCredentialSha256: _pendingCredentialSha256,
        pendingOutcome: _pendingOutcome,
        ...committedRecord
      } = record
      record = {
        ...committedRecord,
        phase: 'committed',
        committedOutcome: outcome,
        committedCredentialSha256: sha256(committedCredential)
      }
      await this.writeLeaseRecord(authorityRoot, record)
      await this.onTransition?.('after-committed-marker')
    }

    if (record.phase === 'committed') {
      await this.scrubLeasedHome(record)
      record = { ...record, phase: 'scrubbed' }
      await this.writeLeaseRecord(authorityRoot, record)
      await this.onTransition?.('after-scrub')
    }

    if (record.phase === 'scrubbed') {
      await this.onTransition?.('before-record-remove')
      await this.removeLeaseRecord(authorityRoot)
    }
    return record.committedOutcome || 'unchanged'
  }

  private async recoverStaleLease(
    authorityRoot: string,
    sourceHome: string,
    record: DurableLeaseRecord
  ): Promise<void> {
    if (record.sourceHome !== sourceHome) {
      throw new Error('Stale Kimi OAuth lease names a different credential authority.')
    }
    const boundaryRoot = await assertPrivateDirectory(record.boundaryRoot)
    const isolatedHome = await assertPrivateDirectory(record.isolatedHome)
    if (!pathIsWithin(boundaryRoot, isolatedHome)) {
      throw new Error('Stale Kimi OAuth lease escaped its private boundary.')
    }
    if (record.phase === 'seeded') {
      if (!record.providerPid || !record.providerProcessIdentity) {
        throw new Error('A stale seeded Kimi OAuth lease has no durable provider process identity.')
      }
      if (this.isProcessAlive(record.providerPid)) {
        const liveIdentity = await this.processIdentity(record.providerPid)
        if (!liveIdentity || liveIdentity === record.providerProcessIdentity) {
          throw new Error('The Kimi OAuth provider child may still be alive; recovery is blocked.')
        }
      }
    }
    await this.finalizeDurableLease(authorityRoot, record)
  }

  private async scrubLeasedHome(record: DurableLeaseRecord): Promise<void> {
    const boundaryRoot = await assertPrivateDirectory(record.boundaryRoot)
    const isolatedHome = await assertPrivateDirectory(record.isolatedHome)
    if (!pathIsWithin(boundaryRoot, isolatedHome)) {
      throw new Error('Recovered Kimi OAuth home escaped its private boundary.')
    }
    const entries = await nodeFs.readdir(isolatedHome)
    for (const entry of entries) {
      if (entry === 'sessions' || entry === 'session_index.jsonl') continue
      const path = join(isolatedHome, entry)
      const stat = await nodeFs.lstat(path)
      if (stat.isSymbolicLink()) {
        await nodeFs.unlink(path)
      } else {
        await nodeFs.rm(path, { recursive: stat.isDirectory(), force: true })
      }
    }
    await fsyncDirectory(isolatedHome)
    const survivors = await nodeFs.readdir(isolatedHome)
    if (survivors.some((entry) => entry !== 'sessions' && entry !== 'session_index.jsonl')) {
      throw new Error('Recovered Kimi OAuth home still contains runtime credential material.')
    }
  }

  private async readLeaseRecord(authorityRoot: string): Promise<DurableLeaseRecord | null> {
    const path = join(authorityRoot, LEASE_RECORD_FILE)
    let raw: Buffer | null
    try {
      raw = await readOptionalPrivateFileWithin(authorityRoot, path)
    } catch {
      throw new Error('Kimi OAuth durable lease record is unsafe.')
    }
    if (!raw) return null
    const record = parseRecord(raw.toString('utf8'))
    if (!record) throw new Error('Kimi OAuth durable lease record is malformed.')
    return record
  }

  private async writeLeaseRecord(authorityRoot: string, record: DurableLeaseRecord): Promise<void> {
    await atomicWritePrivateFile(
      authorityRoot,
      join(authorityRoot, LEASE_RECORD_FILE),
      Buffer.from(JSON.stringify(record), 'utf8')
    )
  }

  private async removeLeaseRecord(authorityRoot: string): Promise<void> {
    await nodeFs.rm(join(authorityRoot, LEASE_RECORD_FILE), { force: true })
    await fsyncDirectory(authorityRoot)
  }

  private async withTransitionLock<T>(authorityRoot: string, work: () => Promise<T>): Promise<T> {
    const lockPath = join(authorityRoot, TRANSITION_LOCK_DIRECTORY)
    const ownerPath = join(lockPath, TRANSITION_OWNER_FILE)
    const reclaimGuardPath = join(authorityRoot, TRANSITION_RECLAIM_GUARD_DIRECTORY)
    const reclaimOwnerPath = join(reclaimGuardPath, TRANSITION_OWNER_FILE)
    const deadline = this.now() + this.transitionWaitMs
    type DirectoryIdentity = { dev: number; ino: number; mtimeMs: number }
    const readDirectoryIdentity = async (
      candidatePath: string,
      label: string
    ): Promise<DirectoryIdentity | null> => {
      const stat = await nodeFs.lstat(candidatePath).catch((error) => {
        if (isErrno(error, 'ENOENT')) return null
        throw error
      })
      if (!stat) return null
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Kimi OAuth ${label} path is unsafe.`)
      }
      return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs }
    }
    const sameIdentity = (
      left: Pick<DirectoryIdentity, 'dev' | 'ino'>,
      right: Pick<DirectoryIdentity, 'dev' | 'ino'>
    ): boolean => left.dev === right.dev && left.ino === right.ino
    const waitForTransition = async (): Promise<void> => {
      if (this.now() >= deadline) {
        throw new Error('Timed out waiting for the Kimi OAuth transition lock.')
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const removeOwnedDirectory = async (
      candidatePath: string,
      identity: Pick<DirectoryIdentity, 'dev' | 'ino'>,
      label: string
    ): Promise<void> => {
      const current = await readDirectoryIdentity(candidatePath, label)
      if (!current || !sameIdentity(current, identity)) {
        throw new Error(`Kimi OAuth ${label} identity changed before release.`)
      }
      await nodeFs.rm(candidatePath, { recursive: true, force: false })
      await fsyncDirectory(authorityRoot)
    }
    let ownedLockIdentity: { dev: number; ino: number } | null = null
    while (true) {
      // A stale-lock reclaimer owns this separate, never-auto-reclaimed guard.
      // Normal creators check it on both sides of mkdir so a reclaimer can
      // never rename a newly created live transition lock by pathname.
      if (await readDirectoryIdentity(reclaimGuardPath, 'transition reclaim guard')) {
        await waitForTransition()
        continue
      }

      let createdLock = false
      try {
        await nodeFs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE })
        createdLock = true
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }

      if (createdLock) {
        const created = await readDirectoryIdentity(lockPath, 'transition lock')
        if (!created) throw new Error('Kimi OAuth transition lock disappeared after creation.')
        try {
          if (await readDirectoryIdentity(reclaimGuardPath, 'transition reclaim guard')) {
            await removeOwnedDirectory(lockPath, created, 'transition lock')
            await waitForTransition()
            continue
          }
          await atomicWritePrivateFile(
            lockPath,
            ownerPath,
            Buffer.from(
              JSON.stringify({
                version: 1,
                pid: this.pid,
                instanceId: this.instanceId,
                createdAt: this.now()
              } satisfies TransitionOwner),
              'utf8'
            )
          )
          const current = await readDirectoryIdentity(lockPath, 'transition lock')
          if (!current || !sameIdentity(current, created)) {
            throw new Error('Kimi OAuth transition lock identity changed during acquisition.')
          }
          if (await readDirectoryIdentity(reclaimGuardPath, 'transition reclaim guard')) {
            await removeOwnedDirectory(lockPath, created, 'transition lock')
            await waitForTransition()
            continue
          }
          ownedLockIdentity = { dev: created.dev, ino: created.ino }
        } catch (error) {
          const current = await readDirectoryIdentity(lockPath, 'transition lock').catch(() => null)
          if (current && sameIdentity(current, created)) {
            await removeOwnedDirectory(lockPath, created, 'transition lock').catch(() => undefined)
          }
          throw error
        }
        break
      }

      const observed = await readDirectoryIdentity(lockPath, 'transition lock')
      if (!observed) continue
      const ownerRaw = await readOptionalPrivateFileWithin(lockPath, ownerPath)
      const owner = ownerRaw
        ? (JSON.parse(ownerRaw.toString('utf8')) as Partial<TransitionOwner>)
        : null
      const ownerIsLive = owner && typeof owner.pid === 'number' && this.isProcessAlive(owner.pid)
      // Allow the creator a short window to publish owner.json before a
      // contender classifies an empty lock directory as crash residue.
      if (ownerIsLive || (!owner && this.now() - observed.mtimeMs < 2_000)) {
        await waitForTransition()
        continue
      }

      await this.onLockTransition?.('after-stale-observed')
      let reclaimGuardIdentity: DirectoryIdentity | null = null
      try {
        try {
          await nodeFs.mkdir(reclaimGuardPath, { mode: PRIVATE_DIRECTORY_MODE })
        } catch (error) {
          if (!isErrno(error, 'EEXIST')) throw error
          await readDirectoryIdentity(reclaimGuardPath, 'transition reclaim guard')
          await waitForTransition()
          continue
        }
        reclaimGuardIdentity = await readDirectoryIdentity(
          reclaimGuardPath,
          'transition reclaim guard'
        )
        if (!reclaimGuardIdentity) {
          throw new Error('Kimi OAuth transition reclaim guard disappeared after creation.')
        }
        await atomicWritePrivateFile(
          reclaimGuardPath,
          reclaimOwnerPath,
          Buffer.from(
            JSON.stringify({
              version: 1,
              pid: this.pid,
              instanceId: this.instanceId,
              createdAt: this.now()
            } satisfies TransitionOwner),
            'utf8'
          )
        )
        await this.onLockTransition?.('after-reclaim-guard-acquired')

        // The identity comparison is the generation check: a delayed contender
        // that observed an old stale directory cannot move a winner's new live
        // directory after eventually acquiring the reclaim guard.
        const current = await readDirectoryIdentity(lockPath, 'transition lock')
        if (!current || !sameIdentity(current, observed)) continue
        const currentOwnerRaw = await readOptionalPrivateFileWithin(lockPath, ownerPath)
        const currentOwner = currentOwnerRaw
          ? (JSON.parse(currentOwnerRaw.toString('utf8')) as Partial<TransitionOwner>)
          : null
        const currentOwnerIsLive =
          currentOwner &&
          typeof currentOwner.pid === 'number' &&
          this.isProcessAlive(currentOwner.pid)
        if (currentOwnerIsLive || (!currentOwner && this.now() - current.mtimeMs < 2_000)) {
          continue
        }
        const quarantine = `${lockPath}.stale-${this.pid}-${randomUUID()}`
        await nodeFs.rename(lockPath, quarantine)
        await nodeFs.rm(quarantine, { recursive: true, force: true })
        await fsyncDirectory(authorityRoot)
      } finally {
        if (reclaimGuardIdentity) {
          await removeOwnedDirectory(
            reclaimGuardPath,
            reclaimGuardIdentity,
            'transition reclaim guard'
          )
        }
      }
    }

    let workCompleted = false
    let workResult: T | undefined
    let workError: unknown
    try {
      await this.onLockTransition?.('after-lock-acquired')
      workResult = await work()
      workCompleted = true
    } catch (error) {
      workError = error
    }

    let releaseError: unknown
    try {
      const current = await readDirectoryIdentity(lockPath, 'transition lock')
      if (
        current &&
        ownedLockIdentity &&
        current.dev === ownedLockIdentity.dev &&
        current.ino === ownedLockIdentity.ino &&
        current.ino === ownedLockIdentity.ino
      ) {
        await nodeFs.rm(lockPath, { recursive: true, force: false })
      } else if (current) {
        throw new Error('Kimi OAuth transition lock identity changed before release.')
      } else {
        throw new Error('Kimi OAuth transition lock disappeared before release.')
      }
      await fsyncDirectory(authorityRoot)
    } catch (error) {
      releaseError = error
    }

    if (!workCompleted) {
      if (releaseError) {
        throw new AggregateError(
          [workError, releaseError],
          'Kimi OAuth authority work and transition-lock release both failed.'
        )
      }
      throw workError
    }
    if (releaseError) throw releaseError
    return workResult as T
  }
}

async function defaultProcessIdentity(pid: number): Promise<string | null> {
  if (!defaultProcessLiveness(pid)) return null
  if (process.platform === 'linux') {
    try {
      const stat = await nodeFs.readFile(`/proc/${pid}/stat`, 'utf8')
      const endName = stat.lastIndexOf(')')
      const fields = stat.slice(endName + 2).split(/\s+/)
      const startTicks = fields[19]
      return startTicks ? sha256(Buffer.from(`linux:${pid}:${startTicks}`)) : null
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolveIdentity) => {
      execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], (error, stdout) => {
        const birth = String(stdout || '').trim()
        resolveIdentity(error || !birth ? null : sha256(Buffer.from(`darwin:${pid}:${birth}`)))
      })
    })
  }
  return null
}

const productionKimiOAuthCredentialAuthority = new KimiOAuthCredentialAuthority()

export function acquireKimiOAuthCredentialLease(
  request: KimiOAuthCredentialLeaseRequest
): Promise<KimiOAuthCredentialLeaseAcquireResult> {
  return productionKimiOAuthCredentialAuthority.acquire(request)
}
