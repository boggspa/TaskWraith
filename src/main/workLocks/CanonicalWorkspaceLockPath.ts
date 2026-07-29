import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

export type CanonicalWorkspaceLockPathFlavor = 'posix' | 'win32'

export interface CanonicalWorkspaceLockPathStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
}

/**
 * Minimal synchronous filesystem seam used by the lock authority. BigInt
 * stats are requested in production so a 64-bit inode is never rounded before
 * becoming part of a durable identity.
 */
export interface CanonicalWorkspaceLockPathFs {
  realpathSync(path: string): string
  lstatSync(path: string, options: { bigint: true }): CanonicalWorkspaceLockPathStat
}

export interface CanonicalWorkspaceLockFileIdentity {
  /** Decimal strings preserve the exact values returned by BigInt stats. */
  device: string
  inode: string
  /** Stable equality key shared by hard-link aliases. */
  key: string
}

export type CanonicalWorkspaceLockTargetIdentity =
  | {
      kind: 'existing'
      file: CanonicalWorkspaceLockFileIdentity
      key: string
    }
  | {
      kind: 'planned'
      existingAncestor: CanonicalWorkspaceLockFileIdentity
      /**
       * Forward-slash path below the physical ancestor. It is case-folded only
       * when the configured filesystem is case-insensitive.
       */
      normalizedSuffix: string
      key: string
    }

export interface CanonicalWorkspaceLockContainmentEvidence {
  canonicalRootPath: string
  canonicalTargetPath: string
  comparisonRootPath: string
  comparisonTargetPath: string
  relativeTargetPath: string
  rootIdentity: CanonicalWorkspaceLockFileIdentity
  existingAncestorCanonicalPath: string
  existingAncestorIdentity: CanonicalWorkspaceLockFileIdentity
}

/**
 * Durable path evidence captured at lock acquisition/preflight. Call
 * verifyCanonicalWorkspaceLockPath immediately before a commit and use the
 * returned fresh resolution for any subsequent durable record.
 */
export interface ResolvedCanonicalWorkspaceLockPath {
  requestedRootPath: string
  requestedTargetPath: string
  lexicalRootPath: string
  lexicalTargetPath: string
  pathFlavor: CanonicalWorkspaceLockPathFlavor
  caseSensitive: boolean
  targetExists: boolean
  canonicalPath: string
  comparisonPath: string
  physicalIdentity: string
  targetIdentity: CanonicalWorkspaceLockTargetIdentity
  containment: CanonicalWorkspaceLockContainmentEvidence
}

export interface ResolveCanonicalWorkspaceLockPathOptions {
  rootPath: string
  targetPath: string
  fs?: CanonicalWorkspaceLockPathFs
  /**
   * Defaults to the host path flavor. Inject this when resolving paths for a
   * different platform or when using a synthetic filesystem in tests.
   */
  pathFlavor?: CanonicalWorkspaceLockPathFlavor
  /**
   * Defaults to false on Windows and macOS, true elsewhere. Filesystems that
   * differ from their platform convention must inject the actual behavior.
   */
  caseSensitive?: boolean
  platform?: NodeJS.Platform
}

export interface VerifyCanonicalWorkspaceLockPathOptions {
  fs?: CanonicalWorkspaceLockPathFs
}

export type CanonicalWorkspaceLockPathVerification =
  | {
      ok: true
      resolution: ResolvedCanonicalWorkspaceLockPath
    }
  | {
      ok: false
      reason: 'changed' | 'outside_root' | 'unresolvable'
      message: string
      changedFields?: readonly string[]
      resolution?: ResolvedCanonicalWorkspaceLockPath
      error?: unknown
    }

export type CanonicalWorkspaceLockPathErrorCode =
  | 'invalid_path'
  | 'root_unavailable'
  | 'outside_root'
  | 'identity_unavailable'
  | 'filesystem_error'

export class CanonicalWorkspaceLockPathError extends Error {
  readonly code: CanonicalWorkspaceLockPathErrorCode
  readonly cause?: unknown

  constructor(
    code: CanonicalWorkspaceLockPathErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message)
    this.name = 'CanonicalWorkspaceLockPathError'
    this.code = code
    this.cause = options?.cause
  }
}

interface ExistingPathResolution {
  canonicalPath: string
  identity: CanonicalWorkspaceLockFileIdentity
}

interface DeepestExistingResolution extends ExistingPathResolution {
  lexicalPath: string
}

const productionFs: CanonicalWorkspaceLockPathFs = {
  realpathSync: (path) => {
    const realpath =
      typeof nodeFs.realpathSync.native === 'function'
        ? nodeFs.realpathSync.native
        : nodeFs.realpathSync
    return realpath(path)
  },
  lstatSync: (path, options) => nodeFs.lstatSync(path, options)
}

export function resolveCanonicalWorkspaceLockPath(
  options: ResolveCanonicalWorkspaceLockPathOptions
): ResolvedCanonicalWorkspaceLockPath {
  const requestedRootPath = requirePath(options.rootPath, 'rootPath')
  const requestedTargetPath = requirePath(options.targetPath, 'targetPath')
  const platform = options.platform || process.platform
  const pathFlavor = options.pathFlavor || (platform === 'win32' ? 'win32' : 'posix')
  const pathApi = pathFlavor === 'win32' ? nodePath.win32 : nodePath.posix
  const caseSensitive =
    options.caseSensitive === undefined
      ? platform !== 'win32' && platform !== 'darwin'
      : options.caseSensitive
  const fs = options.fs || productionFs

  const lexicalRootPath = pathApi.resolve(requestedRootPath)
  const relativeRequest = !pathApi.isAbsolute(requestedTargetPath)
  const lexicalTargetPath = relativeRequest
    ? pathApi.resolve(lexicalRootPath, requestedTargetPath)
    : pathApi.resolve(requestedTargetPath)

  if (
    relativeRequest &&
    !pathContains(lexicalRootPath, lexicalTargetPath, pathFlavor, caseSensitive)
  ) {
    throw new CanonicalWorkspaceLockPathError(
      'outside_root',
      'Workspace lock target escapes the selected root.'
    )
  }

  const root = resolveRequiredExistingPath(
    lexicalRootPath,
    fs,
    pathApi,
    'root_unavailable',
    'Workspace lock root'
  )
  const target = resolveTarget(lexicalTargetPath, fs, pathApi, pathFlavor, caseSensitive)
  const canonicalTargetPath = target.targetExists
    ? target.deepestExisting.canonicalPath
    : pathApi.resolve(
        target.deepestExisting.canonicalPath,
        pathApi.relative(target.deepestExisting.lexicalPath, lexicalTargetPath)
      )

  if (!pathContains(root.canonicalPath, canonicalTargetPath, pathFlavor, caseSensitive)) {
    throw new CanonicalWorkspaceLockPathError(
      'outside_root',
      'Workspace lock target resolves outside the selected root.'
    )
  }

  const comparisonRootPath = comparisonPath(root.canonicalPath, pathFlavor, caseSensitive)
  const comparisonTargetPath = comparisonPath(canonicalTargetPath, pathFlavor, caseSensitive)
  const relativeTargetPath = containedRelativePath(
    root.canonicalPath,
    canonicalTargetPath,
    pathFlavor,
    caseSensitive
  )
  const targetIdentity: CanonicalWorkspaceLockTargetIdentity = target.targetExists
    ? {
        kind: 'existing',
        file: target.deepestExisting.identity,
        key: target.deepestExisting.identity.key
      }
    : plannedTargetIdentity(target.deepestExisting, canonicalTargetPath, pathFlavor, caseSensitive)

  return {
    requestedRootPath,
    requestedTargetPath,
    lexicalRootPath,
    lexicalTargetPath,
    pathFlavor,
    caseSensitive,
    targetExists: target.targetExists,
    canonicalPath: canonicalTargetPath,
    comparisonPath: comparisonTargetPath,
    physicalIdentity: targetIdentity.key,
    targetIdentity,
    containment: {
      canonicalRootPath: root.canonicalPath,
      canonicalTargetPath,
      comparisonRootPath,
      comparisonTargetPath,
      relativeTargetPath,
      rootIdentity: root.identity,
      existingAncestorCanonicalPath: target.deepestExisting.canonicalPath,
      existingAncestorIdentity: target.deepestExisting.identity
    }
  }
}

/**
 * Re-resolve every security-relevant fact immediately before mutation. This
 * detects ancestor symlink swaps, root replacement, target replacement, and a
 * planned target appearing after the original resolution.
 */
export function verifyCanonicalWorkspaceLockPath(
  expected: ResolvedCanonicalWorkspaceLockPath,
  options: VerifyCanonicalWorkspaceLockPathOptions = {}
): CanonicalWorkspaceLockPathVerification {
  let resolution: ResolvedCanonicalWorkspaceLockPath
  try {
    resolution = resolveCanonicalWorkspaceLockPath({
      rootPath: expected.requestedRootPath,
      targetPath: expected.requestedTargetPath,
      pathFlavor: expected.pathFlavor,
      caseSensitive: expected.caseSensitive,
      fs: options.fs
    })
  } catch (error) {
    const reason =
      error instanceof CanonicalWorkspaceLockPathError && error.code === 'outside_root'
        ? 'outside_root'
        : 'unresolvable'
    return {
      ok: false,
      reason,
      message:
        reason === 'outside_root'
          ? 'Workspace lock path no longer resolves inside its root.'
          : 'Workspace lock path could not be re-resolved.',
      error
    }
  }

  const changedFields = changedResolutionFields(expected, resolution)
  if (changedFields.length > 0) {
    return {
      ok: false,
      reason: 'changed',
      message: `Workspace lock path changed before commit: ${changedFields.join(', ')}.`,
      changedFields,
      resolution
    }
  }
  return { ok: true, resolution }
}

export function assertCanonicalWorkspaceLockPathUnchanged(
  expected: ResolvedCanonicalWorkspaceLockPath,
  options: VerifyCanonicalWorkspaceLockPathOptions = {}
): ResolvedCanonicalWorkspaceLockPath {
  const verification = verifyCanonicalWorkspaceLockPath(expected, options)
  if (verification.ok) return verification.resolution
  throw new CanonicalWorkspaceLockPathError(
    verification.reason === 'outside_root' ? 'outside_root' : 'filesystem_error',
    verification.message,
    { cause: verification.error }
  )
}

function resolveTarget(
  lexicalTargetPath: string,
  fs: CanonicalWorkspaceLockPathFs,
  pathApi: typeof nodePath.posix,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): { targetExists: boolean; deepestExisting: DeepestExistingResolution } {
  let cursor = lexicalTargetPath
  let targetExists = true
  while (true) {
    try {
      const existing = resolveRequiredExistingPath(
        cursor,
        fs,
        pathApi,
        'filesystem_error',
        'Workspace lock target'
      )
      return {
        targetExists:
          targetExists && pathEqual(cursor, lexicalTargetPath, pathFlavor, caseSensitive),
        deepestExisting: { lexicalPath: cursor, ...existing }
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      try {
        fs.lstatSync(cursor, { bigint: true })
        throw new CanonicalWorkspaceLockPathError(
          'filesystem_error',
          'Workspace lock target contains a dangling or unresolvable filesystem entry.',
          { cause: error }
        )
      } catch (lstatError) {
        if (!isMissingFsError(lstatError)) throw lstatError
      }
      targetExists = false
      const parent = pathApi.dirname(cursor)
      if (parent === cursor) {
        throw new CanonicalWorkspaceLockPathError(
          'filesystem_error',
          'Workspace lock target has no resolvable existing ancestor.',
          { cause: error }
        )
      }
      cursor = parent
    }
  }
}

function resolveRequiredExistingPath(
  path: string,
  fs: CanonicalWorkspaceLockPathFs,
  pathApi: typeof nodePath.posix,
  errorCode: CanonicalWorkspaceLockPathErrorCode,
  label: string
): ExistingPathResolution {
  let canonicalPath: string
  try {
    canonicalPath = pathApi.normalize(fs.realpathSync(path))
  } catch (error) {
    if (isMissingFsError(error)) throw error
    throw new CanonicalWorkspaceLockPathError(errorCode, `${label} could not be resolved.`, {
      cause: error
    })
  }

  let stat: CanonicalWorkspaceLockPathStat
  try {
    stat = fs.lstatSync(canonicalPath, { bigint: true })
  } catch (error) {
    if (isMissingFsError(error)) throw error
    throw new CanonicalWorkspaceLockPathError(errorCode, `${label} identity could not be read.`, {
      cause: error
    })
  }
  return { canonicalPath, identity: fileIdentity(stat) }
}

function fileIdentity(stat: CanonicalWorkspaceLockPathStat): CanonicalWorkspaceLockFileIdentity {
  const device = exactInteger(stat.dev, 'device')
  const inode = exactInteger(stat.ino, 'inode')
  return { device, inode, key: `dev:${device}:ino:${inode}` }
}

function exactInteger(value: number | bigint, label: string): string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new CanonicalWorkspaceLockPathError(
        'identity_unavailable',
        `Workspace lock ${label} identity is invalid.`
      )
    }
    return value.toString(10)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalWorkspaceLockPathError(
      'identity_unavailable',
      `Workspace lock ${label} identity is not an exact integer.`
    )
  }
  return String(value)
}

function plannedTargetIdentity(
  ancestor: DeepestExistingResolution,
  canonicalTargetPath: string,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): CanonicalWorkspaceLockTargetIdentity {
  const suffix = containedRelativePath(
    ancestor.canonicalPath,
    canonicalTargetPath,
    pathFlavor,
    caseSensitive
  )
  const normalizedSuffix = caseSensitive ? suffix : suffix.toLocaleLowerCase('en-US')
  return {
    kind: 'planned',
    existingAncestor: ancestor.identity,
    normalizedSuffix,
    key: `planned:${ancestor.identity.key}:${normalizedSuffix}`
  }
}

function changedResolutionFields(
  expected: ResolvedCanonicalWorkspaceLockPath,
  actual: ResolvedCanonicalWorkspaceLockPath
): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ['lexicalRootPath', expected.lexicalRootPath, actual.lexicalRootPath],
    ['lexicalTargetPath', expected.lexicalTargetPath, actual.lexicalTargetPath],
    [
      'canonicalRootPath',
      expected.containment.comparisonRootPath,
      actual.containment.comparisonRootPath
    ],
    ['rootIdentity', expected.containment.rootIdentity.key, actual.containment.rootIdentity.key],
    ['canonicalTargetPath', expected.comparisonPath, actual.comparisonPath],
    ['targetExists', expected.targetExists, actual.targetExists],
    ['physicalIdentity', expected.physicalIdentity, actual.physicalIdentity],
    [
      'existingAncestorCanonicalPath',
      comparisonPath(
        expected.containment.existingAncestorCanonicalPath,
        expected.pathFlavor,
        expected.caseSensitive
      ),
      comparisonPath(
        actual.containment.existingAncestorCanonicalPath,
        actual.pathFlavor,
        actual.caseSensitive
      )
    ],
    [
      'existingAncestorIdentity',
      expected.containment.existingAncestorIdentity.key,
      actual.containment.existingAncestorIdentity.key
    ],
    [
      'relativeTargetPath',
      normalizedRelative(expected.containment.relativeTargetPath, expected.caseSensitive),
      normalizedRelative(actual.containment.relativeTargetPath, actual.caseSensitive)
    ]
  ]
  return fields
    .filter(([, expectedValue, actualValue]) => expectedValue !== actualValue)
    .map(([field]) => field)
}

function pathContains(
  rootPath: string,
  candidatePath: string,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): boolean {
  const root = comparisonPath(rootPath, pathFlavor, caseSensitive)
  const candidate = comparisonPath(candidatePath, pathFlavor, caseSensitive)
  if (root === candidate) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return candidate.startsWith(prefix)
}

function pathEqual(
  left: string,
  right: string,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): boolean {
  return (
    comparisonPath(left, pathFlavor, caseSensitive) ===
    comparisonPath(right, pathFlavor, caseSensitive)
  )
}

function comparisonPath(
  path: string,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): string {
  const pathApi = pathFlavor === 'win32' ? nodePath.win32 : nodePath.posix
  let normalized = pathApi.normalize(path).replace(/\\/g, '/')
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }
  return caseSensitive ? normalized : normalized.toLocaleLowerCase('en-US')
}

function containedRelativePath(
  rootPath: string,
  candidatePath: string,
  pathFlavor: CanonicalWorkspaceLockPathFlavor,
  caseSensitive: boolean
): string {
  const normalizedRoot = comparisonPath(rootPath, pathFlavor, true)
  const normalizedCandidate = comparisonPath(candidatePath, pathFlavor, true)
  const comparedRoot = caseSensitive ? normalizedRoot : normalizedRoot.toLocaleLowerCase('en-US')
  const comparedCandidate = caseSensitive
    ? normalizedCandidate
    : normalizedCandidate.toLocaleLowerCase('en-US')
  if (comparedRoot === comparedCandidate) return '.'
  const prefixLength = normalizedRoot.endsWith('/')
    ? normalizedRoot.length
    : normalizedRoot.length + 1
  return normalizedCandidate.slice(prefixLength)
}

function normalizedRelative(path: string, caseSensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/')
  return caseSensitive ? normalized : normalized.toLocaleLowerCase('en-US')
}

function requirePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CanonicalWorkspaceLockPathError(
      'invalid_path',
      `Workspace lock ${label} must be a non-empty string.`
    )
  }
  if (value.includes('\0')) {
    throw new CanonicalWorkspaceLockPathError(
      'invalid_path',
      `Workspace lock ${label} cannot contain a null byte.`
    )
  }
  return value
}

function isMissingPathError(error: unknown): boolean {
  return (
    isMissingFsError(error) ||
    (error instanceof CanonicalWorkspaceLockPathError &&
      error.cause !== undefined &&
      isMissingFsError(error.cause))
  )
}

function isMissingFsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
