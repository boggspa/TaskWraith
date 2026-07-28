import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import { isAbsolute, parse, relative, resolve } from 'path'
import {
  isValidPackagedIsolatedInstanceId,
  PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME
} from './InstanceLaunchPosture'

const PRIVATE_DIRECTORY_MODE = 0o700

export interface InstanceProfileDirectoryStat {
  uid: number | bigint
  mode: number | bigint
  dev?: number | bigint
  ino?: number | bigint
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface InstanceProfileDirectoryHandle {
  stat(): Promise<InstanceProfileDirectoryStat>
  chmod(mode: number): Promise<unknown>
  close(): Promise<void>
}

export interface InstanceProfileDirectoryHandleSync {
  statSync(): InstanceProfileDirectoryStat
  chmodSync(mode: number): unknown
  closeSync(): void
}

export interface InstanceProfileAdmissionFileSystem {
  mkdir(path: string, options: { mode: number }): Promise<unknown>
  lstat(path: string): Promise<InstanceProfileDirectoryStat>
  /**
   * Optional only to preserve the injectable test seam. Admission refuses an
   * implementation without this no-follow descriptor primitive.
   */
  openDirectory?(path: string): Promise<InstanceProfileDirectoryHandle>
}

export interface InstanceProfileAdmissionSyncFileSystem {
  mkdirSync(path: string, options: { mode: number }): unknown
  lstatSync(path: string): InstanceProfileDirectoryStat
  /** See InstanceProfileAdmissionFileSystem.openDirectory. */
  openDirectorySync?(path: string): InstanceProfileDirectoryHandleSync
}

export interface AdmitPackagedIsolatedProfileInput {
  appDataPath: string
  instanceId: string
  fileSystem?: InstanceProfileAdmissionFileSystem
  getCurrentUid?: () => number | undefined
}

export interface AdmitPackagedIsolatedProfileSyncInput {
  appDataPath: string
  instanceId: string
  fileSystem?: InstanceProfileAdmissionSyncFileSystem
  getCurrentUid?: () => number | undefined
}

export interface PackagedIsolatedProfileAdmission {
  profileParentPath: string
  profileRootPath: string
  parentCreated: boolean
  profileCreated: boolean
}

function defaultCurrentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

const nodeFileSystem: InstanceProfileAdmissionFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  lstat: async (path) =>
    (await fs.lstat(path, { bigint: true })) as unknown as InstanceProfileDirectoryStat,
  openDirectory: async (path) => {
    const handle = await fs.open(path, privateDirectoryOpenFlags())
    return {
      stat: async () =>
        (await handle.stat({ bigint: true })) as unknown as InstanceProfileDirectoryStat,
      chmod: (mode) => handle.chmod(mode),
      close: () => handle.close()
    }
  }
}

const nodeSyncFileSystem: InstanceProfileAdmissionSyncFileSystem = {
  mkdirSync: (path, options) => fsSync.mkdirSync(path, options),
  lstatSync: (path) =>
    fsSync.lstatSync(path, { bigint: true }) as unknown as InstanceProfileDirectoryStat,
  openDirectorySync: (path) => {
    const descriptor = fsSync.openSync(path, privateDirectoryOpenFlags())
    return {
      statSync: () =>
        fsSync.fstatSync(descriptor, { bigint: true }) as unknown as InstanceProfileDirectoryStat,
      chmodSync: (mode) => fsSync.fchmodSync(descriptor, mode),
      closeSync: () => fsSync.closeSync(descriptor)
    }
  }
}

function privateDirectoryOpenFlags(): number {
  const noFollow = fsSync.constants.O_NOFOLLOW
  const directoryOnly = fsSync.constants.O_DIRECTORY
  if (
    typeof noFollow !== 'number' ||
    noFollow === 0 ||
    typeof directoryOnly !== 'number' ||
    directoryOnly === 0
  ) {
    // A path check alone cannot pin a directory against a concurrent
    // replacement. Packaged isolation is unavailable rather than silently
    // falling back to a pathname chmod on a platform without these guards.
    throw new Error('Packaged isolated profile admission is unavailable.')
  }
  return fsSync.constants.O_RDONLY | noFollow | directoryOnly
}

function isUsableAbsoluteDirectory(value: string): boolean {
  if (!isAbsolute(value)) return false
  const resolved = resolve(value)
  return resolved !== parse(resolved).root
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return (
    Boolean(relation) &&
    relation !== '..' &&
    !relation.startsWith('../') &&
    !relation.startsWith('..\\') &&
    !isAbsolute(relation)
  )
}

function resolveControlledProfilePaths(
  appDataPath: string,
  instanceId: string
): { profileParentPath: string; profileRootPath: string } | null {
  if (!isUsableAbsoluteDirectory(appDataPath) || !isValidPackagedIsolatedInstanceId(instanceId)) {
    return null
  }
  const appData = resolve(appDataPath)
  const profileParentPath = resolve(appData, PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME)
  const profileRootPath = resolve(profileParentPath, instanceId)
  if (
    !isStrictDescendant(appData, profileParentPath) ||
    !isStrictDescendant(profileParentPath, profileRootPath)
  ) {
    return null
  }
  return { profileParentPath, profileRootPath }
}

function validateAdmissionInput(input: {
  appDataPath: string
  instanceId: string
  getCurrentUid?: () => number | undefined
}): { paths: { profileParentPath: string; profileRootPath: string }; currentUid: number } {
  const paths = resolveControlledProfilePaths(input.appDataPath, input.instanceId)
  const uid = (input.getCurrentUid || defaultCurrentUid)()
  if (!paths || typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Packaged isolated profile admission is unavailable.')
  }
  return { paths, currentUid: uid }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST'
  )
}

function toExactNonNegativeInteger(value: number | bigint | undefined): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }
  return null
}

function isExpectedDirectoryOwner(stat: InstanceProfileDirectoryStat, uid: number): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    toExactNonNegativeInteger(stat.uid) === BigInt(uid)
  )
}

function hasPrivateDirectoryMode(stat: InstanceProfileDirectoryStat): boolean {
  const mode = toExactNonNegativeInteger(stat.mode)
  return mode !== null && (mode & 0o777n) === 0o700n
}

interface DirectoryIdentity {
  dev: bigint
  ino: bigint
}

function directoryIdentity(stat: InstanceProfileDirectoryStat): DirectoryIdentity | null {
  const dev = toExactNonNegativeInteger(stat.dev)
  const ino = toExactNonNegativeInteger(stat.ino)
  return dev === null || ino === null ? null : { dev, ino }
}

function assertExpectedDirectory(
  stat: InstanceProfileDirectoryStat,
  uid: number,
  requirePrivateMode: boolean
): void {
  if (
    !isExpectedDirectoryOwner(stat, uid) ||
    directoryIdentity(stat) === null ||
    (requirePrivateMode && !hasPrivateDirectoryMode(stat))
  ) {
    throw new Error('Packaged isolated profile directory admission was rejected.')
  }
}

function assertSameDirectoryIdentity(
  expected: InstanceProfileDirectoryStat,
  actual: InstanceProfileDirectoryStat
): void {
  const expectedIdentity = directoryIdentity(expected)
  const actualIdentity = directoryIdentity(actual)
  if (
    !expectedIdentity ||
    !actualIdentity ||
    expectedIdentity.dev !== actualIdentity.dev ||
    expectedIdentity.ino !== actualIdentity.ino
  ) {
    throw new Error('Packaged isolated profile directory admission was rejected.')
  }
}

interface AdmittedPrivateDirectory {
  created: boolean
  handle: InstanceProfileDirectoryHandle
}

interface AdmittedPrivateDirectorySync {
  created: boolean
  handle: InstanceProfileDirectoryHandleSync
}

async function lstatPrivateDirectory(
  path: string,
  uid: number,
  fileSystem: InstanceProfileAdmissionFileSystem,
  requirePrivateMode: boolean
): Promise<InstanceProfileDirectoryStat> {
  let stat: InstanceProfileDirectoryStat
  try {
    stat = await fileSystem.lstat(path)
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
  assertExpectedDirectory(stat, uid, requirePrivateMode)
  return stat
}

function lstatPrivateDirectorySync(
  path: string,
  uid: number,
  fileSystem: InstanceProfileAdmissionSyncFileSystem,
  requirePrivateMode: boolean
): InstanceProfileDirectoryStat {
  let stat: InstanceProfileDirectoryStat
  try {
    stat = fileSystem.lstatSync(path)
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
  assertExpectedDirectory(stat, uid, requirePrivateMode)
  return stat
}

async function inspectPinnedPrivateDirectory(
  path: string,
  uid: number,
  handle: InstanceProfileDirectoryHandle,
  fileSystem: InstanceProfileAdmissionFileSystem,
  requirePrivateMode: boolean
): Promise<InstanceProfileDirectoryStat> {
  let opened: InstanceProfileDirectoryStat
  try {
    opened = await handle.stat()
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
  assertExpectedDirectory(opened, uid, requirePrivateMode)
  const linked = await lstatPrivateDirectory(path, uid, fileSystem, requirePrivateMode)
  assertSameDirectoryIdentity(opened, linked)
  return opened
}

function inspectPinnedPrivateDirectorySync(
  path: string,
  uid: number,
  handle: InstanceProfileDirectoryHandleSync,
  fileSystem: InstanceProfileAdmissionSyncFileSystem,
  requirePrivateMode: boolean
): InstanceProfileDirectoryStat {
  let opened: InstanceProfileDirectoryStat
  try {
    opened = handle.statSync()
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
  assertExpectedDirectory(opened, uid, requirePrivateMode)
  const linked = lstatPrivateDirectorySync(path, uid, fileSystem, requirePrivateMode)
  assertSameDirectoryIdentity(opened, linked)
  return opened
}

async function openPrivateDirectory(
  path: string,
  fileSystem: InstanceProfileAdmissionFileSystem
): Promise<InstanceProfileDirectoryHandle> {
  if (typeof fileSystem.openDirectory !== 'function') {
    throw new Error('Packaged isolated profile admission is unavailable.')
  }
  try {
    return await fileSystem.openDirectory(path)
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
}

function openPrivateDirectorySync(
  path: string,
  fileSystem: InstanceProfileAdmissionSyncFileSystem
): InstanceProfileDirectoryHandleSync {
  if (typeof fileSystem.openDirectorySync !== 'function') {
    throw new Error('Packaged isolated profile admission is unavailable.')
  }
  try {
    return fileSystem.openDirectorySync(path)
  } catch {
    throw new Error('Unable to inspect packaged isolated profile directory.')
  }
}

async function createOrAdmitPrivateDirectory(
  path: string,
  uid: number,
  fileSystem: InstanceProfileAdmissionFileSystem
): Promise<AdmittedPrivateDirectory> {
  let created = false
  try {
    await fileSystem.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
    created = true
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new Error('Unable to create packaged isolated profile directory.')
    }
  }

  // Check before opening for clear static failures, then bind the mutable
  // pathname to a no-follow descriptor. All later chmod operations happen on
  // that descriptor, never on the path which might have been replaced.
  await lstatPrivateDirectory(path, uid, fileSystem, false)
  const handle = await openPrivateDirectory(path, fileSystem)
  try {
    const opened = await inspectPinnedPrivateDirectory(path, uid, handle, fileSystem, false)
    if (!hasPrivateDirectoryMode(opened)) {
      try {
        await handle.chmod(PRIVATE_DIRECTORY_MODE)
      } catch {
        throw new Error('Unable to secure packaged isolated profile directory.')
      }
    }

    // This verifies both the descriptor and the exact path after fchmod. A
    // replacement with a symlink (or another directory) is rejected even if
    // it occurs after the pre-chmod lstat.
    await inspectPinnedPrivateDirectory(path, uid, handle, fileSystem, true)
    return { created, handle }
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // Preserve the safety failure that caused admission to stop.
    }
    throw error
  }
}

function createOrAdmitPrivateDirectorySync(
  path: string,
  uid: number,
  fileSystem: InstanceProfileAdmissionSyncFileSystem
): AdmittedPrivateDirectorySync {
  let created = false
  try {
    fileSystem.mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE })
    created = true
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new Error('Unable to create packaged isolated profile directory.')
    }
  }

  lstatPrivateDirectorySync(path, uid, fileSystem, false)
  const handle = openPrivateDirectorySync(path, fileSystem)
  try {
    const opened = inspectPinnedPrivateDirectorySync(path, uid, handle, fileSystem, false)
    if (!hasPrivateDirectoryMode(opened)) {
      try {
        handle.chmodSync(PRIVATE_DIRECTORY_MODE)
      } catch {
        throw new Error('Unable to secure packaged isolated profile directory.')
      }
    }

    inspectPinnedPrivateDirectorySync(path, uid, handle, fileSystem, true)
    return { created, handle }
  } catch (error) {
    try {
      handle.closeSync()
    } catch {
      // Preserve the safety failure that caused admission to stop.
    }
    throw error
  }
}

async function closePrivateDirectory(handle: InstanceProfileDirectoryHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    throw new Error('Unable to close packaged isolated profile directory.')
  }
}

function closePrivateDirectorySync(handle: InstanceProfileDirectoryHandleSync): void {
  try {
    handle.closeSync()
  } catch {
    throw new Error('Unable to close packaged isolated profile directory.')
  }
}

/**
 * Create or admit the exact appData/TaskWraith Instances/<opaque-id> profile.
 * No recursive creation is used: an unexpected appData ancestor, parent, or
 * leaf causes a generic failure instead of being followed or repaired.
 */
export async function admitPackagedIsolatedProfileRoot(
  input: AdmitPackagedIsolatedProfileInput
): Promise<PackagedIsolatedProfileAdmission> {
  const { paths: resolvedPaths, currentUid } = validateAdmissionInput(input)

  const fileSystem = input.fileSystem || nodeFileSystem
  const parent = await createOrAdmitPrivateDirectory(
    resolvedPaths.profileParentPath,
    currentUid,
    fileSystem
  )
  try {
    // Do not begin a path-based leaf operation until the parent path still
    // names the descriptor-pinned private directory.
    await inspectPinnedPrivateDirectory(
      resolvedPaths.profileParentPath,
      currentUid,
      parent.handle,
      fileSystem,
      true
    )
    const profile = await createOrAdmitPrivateDirectory(
      resolvedPaths.profileRootPath,
      currentUid,
      fileSystem
    )
    try {
      // Revalidate both directory identities at the final boundary. Holding
      // both descriptors means a leaf that is swapped after admission cannot
      // be returned merely because its earlier check succeeded.
      await inspectPinnedPrivateDirectory(
        resolvedPaths.profileParentPath,
        currentUid,
        parent.handle,
        fileSystem,
        true
      )
      await inspectPinnedPrivateDirectory(
        resolvedPaths.profileRootPath,
        currentUid,
        profile.handle,
        fileSystem,
        true
      )
      await inspectPinnedPrivateDirectory(
        resolvedPaths.profileParentPath,
        currentUid,
        parent.handle,
        fileSystem,
        true
      )
      await inspectPinnedPrivateDirectory(
        resolvedPaths.profileRootPath,
        currentUid,
        profile.handle,
        fileSystem,
        true
      )
      return {
        ...resolvedPaths,
        parentCreated: parent.created,
        profileCreated: profile.created
      }
    } finally {
      await closePrivateDirectory(profile.handle)
    }
  } finally {
    await closePrivateDirectory(parent.handle)
  }
}

/**
 * Synchronous startup-safe counterpart for devAppName.ts. Call it only after
 * the private posture has been parsed and before Electron or a transitive main
 * import reads userData. Its validation and admission rules match the async
 * helper exactly.
 */
export function admitPackagedIsolatedProfileRootSync(
  input: AdmitPackagedIsolatedProfileSyncInput
): PackagedIsolatedProfileAdmission {
  const { paths: resolvedPaths, currentUid } = validateAdmissionInput(input)
  const fileSystem = input.fileSystem || nodeSyncFileSystem
  const parent = createOrAdmitPrivateDirectorySync(
    resolvedPaths.profileParentPath,
    currentUid,
    fileSystem
  )
  try {
    inspectPinnedPrivateDirectorySync(
      resolvedPaths.profileParentPath,
      currentUid,
      parent.handle,
      fileSystem,
      true
    )
    const profile = createOrAdmitPrivateDirectorySync(
      resolvedPaths.profileRootPath,
      currentUid,
      fileSystem
    )
    try {
      inspectPinnedPrivateDirectorySync(
        resolvedPaths.profileParentPath,
        currentUid,
        parent.handle,
        fileSystem,
        true
      )
      inspectPinnedPrivateDirectorySync(
        resolvedPaths.profileRootPath,
        currentUid,
        profile.handle,
        fileSystem,
        true
      )
      inspectPinnedPrivateDirectorySync(
        resolvedPaths.profileParentPath,
        currentUid,
        parent.handle,
        fileSystem,
        true
      )
      inspectPinnedPrivateDirectorySync(
        resolvedPaths.profileRootPath,
        currentUid,
        profile.handle,
        fileSystem,
        true
      )
      return {
        ...resolvedPaths,
        parentCreated: parent.created,
        profileCreated: profile.created
      }
    } finally {
      closePrivateDirectorySync(profile.handle)
    }
  } finally {
    closePrivateDirectorySync(parent.handle)
  }
}
