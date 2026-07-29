import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockClaimKind,
  WorkspaceLockClaimRequest,
  WorkspaceLockHunk
} from './WorkspaceLockTypes'
import type { ResolvedCanonicalWorkspaceLockPath } from './CanonicalWorkspaceLockPath'

/**
 * Validation intentionally happens before a claim reaches the authority's
 * state.  The authority is durable; accepting a malformed target and trying
 * to interpret it later would make recovery non-deterministic.
 */
export type WorkspaceLockClaimValidation = { ok: true } | { ok: false; errors: readonly string[] }

export type CanonicalizeWorkspaceLockPath = (inputPath: string) => string

export interface WorkspaceLockClaimPathCanonicalizer {
  canonicalizePath: CanonicalizeWorkspaceLockPath
  resolveTargetPath: (rootPath: string, targetPath: string) => ResolvedCanonicalWorkspaceLockPath
}

const claimKinds: readonly WorkspaceLockClaimKind[] = ['workspace', 'tree', 'file', 'hunk']
const kindOrder: Record<WorkspaceLockClaimKind, number> = {
  workspace: 0,
  tree: 1,
  file: 2,
  hunk: 3
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isClaimKind(value: unknown): value is WorkspaceLockClaimKind {
  return typeof value === 'string' && claimKinds.includes(value as WorkspaceLockClaimKind)
}

function validHunk(value: unknown): value is WorkspaceLockHunk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const hunk = value as Partial<WorkspaceLockHunk>
  return (
    nonEmptyString(hunk.baseline) &&
    Number.isSafeInteger(hunk.startLine) &&
    Number.isSafeInteger(hunk.endLine) &&
    (hunk.startLine as number) >= 0 &&
    (hunk.endLine as number) >= (hunk.startLine as number)
  )
}

/**
 * Validate only the request shape. Path canonicalization is deliberately a
 * separate step because it must happen at the authority boundary with the
 * authority's filesystem-aware canonicalizer.
 */
export function validateWorkspaceLockClaimRequest(input: unknown): WorkspaceLockClaimValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Lock claim must be an object.'] }
  }

  const claim = input as Partial<WorkspaceLockClaimRequest>
  const errors: string[] = []
  if (!nonEmptyString(claim.workspacePath)) errors.push('workspacePath is required.')
  if (claim.worktreePath !== undefined && !nonEmptyString(claim.worktreePath)) {
    errors.push('worktreePath must be a non-empty string when provided.')
  }
  if (!isClaimKind(claim.kind)) errors.push('kind must be workspace, tree, file, or hunk.')
  if (claim.mode !== undefined && claim.mode !== 'read' && claim.mode !== 'write') {
    errors.push('mode must be read or write when provided.')
  }
  if (claim.globalFilesystem !== undefined && typeof claim.globalFilesystem !== 'boolean') {
    errors.push('globalFilesystem must be a boolean when provided.')
  }
  if (claim.globalFilesystem === true && (claim.kind !== 'workspace' || claim.mode === 'read')) {
    errors.push('globalFilesystem is valid only for a write-mode workspace claim.')
  }

  if (claim.kind === 'workspace') {
    if (claim.hunk !== undefined) errors.push('workspace claims cannot include a hunk.')
  } else if (isClaimKind(claim.kind)) {
    if (!nonEmptyString(claim.targetPath)) errors.push(`${claim.kind} claims require targetPath.`)
    if (claim.kind === 'hunk') {
      if (!validHunk(claim.hunk)) {
        errors.push(
          'hunk claims require a non-empty baseline and safe, zero-based half-open line boundaries.'
        )
      }
    } else if (claim.hunk !== undefined) {
      errors.push(`${claim.kind} claims cannot include a hunk.`)
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

function assertValidRequest(input: WorkspaceLockClaimRequest): void {
  const validation = validateWorkspaceLockClaimRequest(input)
  if (!validation.ok)
    throw new Error(`Invalid workspace lock claim: ${validation.errors.join(' ')}`)
}

function canonicalPath(
  value: string,
  label: string,
  canonicalizePath: CanonicalizeWorkspaceLockPath
): string {
  let canonical: string
  try {
    canonical = canonicalizePath(value)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`Could not canonicalize ${label}${detail}`)
  }
  if (!nonEmptyString(canonical)) throw new Error(`Canonical ${label} must be a non-empty string.`)
  return stripTrailingSeparators(canonical)
}

function stripTrailingSeparators(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  // Keep filesystem roots (including a Windows drive root) meaningful.
  if (normalized) return normalized
  return path[0] === '\\' ? '\\' : '/'
}

function pathForComparison(path: string): string {
  return stripTrailingSeparators(path).replace(/\\/g, '/')
}

function relativeTargetPath(worktreeIdentity: string, physicalTargetIdentity: string): string {
  const worktree = pathForComparison(worktreeIdentity)
  const target = pathForComparison(physicalTargetIdentity)
  if (target === worktree) return '.'
  return target.slice(worktree.length + 1)
}

/** True when a canonical candidate is the root itself or a descendant. */
export function workspaceLockPathContains(rootPath: string, candidatePath: string): boolean {
  const root = pathForComparison(rootPath)
  const candidate = pathForComparison(candidatePath)
  if (root === candidate) return true
  if (root === '/') return candidate.startsWith('/')
  return candidate.startsWith(`${root}/`)
}

/**
 * Canonical identities are derived only through the injected authority
 * canonicalizer. `targetPath` is intentionally a physical path: callers
 * first resolve relative provider input beneath the selected worktree, then
 * this model refuses paths that escape that worktree.
 */
export function canonicalizeWorkspaceLockClaim(
  request: WorkspaceLockClaimRequest,
  canonicalizer: CanonicalizeWorkspaceLockPath | WorkspaceLockClaimPathCanonicalizer
): CanonicalWorkspaceLockClaim {
  assertValidRequest(request)
  const canonicalizePath =
    typeof canonicalizer === 'function' ? canonicalizer : canonicalizer.canonicalizePath

  const workspaceIdentity = canonicalPath(request.workspacePath, 'workspacePath', canonicalizePath)
  let worktreeIdentity = canonicalPath(
    request.worktreePath || request.workspacePath,
    'worktreePath',
    canonicalizePath
  )
  const mode = request.mode || 'write'

  if (request.kind === 'workspace') {
    const rootResolution =
      typeof canonicalizer === 'function'
        ? undefined
        : canonicalizer.resolveTargetPath(
            request.worktreePath || request.workspacePath,
            request.worktreePath || request.workspacePath
          )
    if (rootResolution) worktreeIdentity = rootResolution.containment.comparisonRootPath
    const worktreeCanonicalPath = rootResolution?.containment.canonicalRootPath || worktreeIdentity
    return {
      workspaceIdentity,
      worktreeCanonicalPath,
      worktreeIdentity,
      ...(rootResolution
        ? { worktreeObjectIdentity: rootResolution.containment.rootIdentity.key }
        : {}),
      targetCanonicalPath: rootResolution?.canonicalPath || worktreeCanonicalPath,
      comparisonTargetPath: worktreeIdentity,
      ...(rootResolution ? { objectIdentity: rootResolution.physicalIdentity } : {}),
      physicalTargetIdentity: worktreeIdentity,
      displayWorkspacePath: request.workspacePath,
      displayWorktreePath: request.worktreePath || request.workspacePath,
      ...(request.worktreeName ? { worktreeName: request.worktreeName } : {}),
      ...(request.branch ? { branch: request.branch } : {}),
      kind: 'workspace',
      mode,
      ...(request.globalFilesystem === true ? { globalFilesystem: true as const } : {}),
      ...(rootResolution ? { pathEvidence: clonePathEvidence(rootResolution) } : {})
    }
  }

  const resolution =
    typeof canonicalizer === 'function'
      ? undefined
      : canonicalizer.resolveTargetPath(
          request.worktreePath || request.workspacePath,
          request.targetPath as string
        )
  if (resolution) worktreeIdentity = resolution.containment.comparisonRootPath
  const comparisonTargetPath = resolution
    ? resolution.comparisonPath
    : canonicalPath(request.targetPath as string, 'targetPath', canonicalizePath)
  if (!workspaceLockPathContains(worktreeIdentity, comparisonTargetPath)) {
    throw new Error('Lock target must be inside the selected worktree.')
  }
  const worktreeCanonicalPath = resolution?.containment.canonicalRootPath || worktreeIdentity
  const targetCanonicalPath = resolution?.canonicalPath || comparisonTargetPath

  if (request.kind !== 'hunk') {
    return {
      workspaceIdentity,
      worktreeCanonicalPath,
      worktreeIdentity,
      ...(resolution ? { worktreeObjectIdentity: resolution.containment.rootIdentity.key } : {}),
      targetCanonicalPath,
      comparisonTargetPath,
      ...(resolution ? { objectIdentity: resolution.physicalIdentity } : {}),
      physicalTargetIdentity: comparisonTargetPath,
      displayWorkspacePath: request.workspacePath,
      displayWorktreePath: request.worktreePath || request.workspacePath,
      relativeTargetPath:
        resolution?.containment.relativeTargetPath ||
        relativeTargetPath(worktreeIdentity, comparisonTargetPath),
      ...(request.worktreeName ? { worktreeName: request.worktreeName } : {}),
      ...(request.branch ? { branch: request.branch } : {}),
      kind: request.kind,
      mode,
      ...(resolution ? { pathEvidence: clonePathEvidence(resolution) } : {})
    }
  }

  const hunk = request.hunk as WorkspaceLockHunk
  return {
    workspaceIdentity,
    worktreeCanonicalPath,
    worktreeIdentity,
    ...(resolution ? { worktreeObjectIdentity: resolution.containment.rootIdentity.key } : {}),
    targetCanonicalPath,
    comparisonTargetPath,
    ...(resolution ? { objectIdentity: resolution.physicalIdentity } : {}),
    physicalTargetIdentity: comparisonTargetPath,
    displayWorkspacePath: request.workspacePath,
    displayWorktreePath: request.worktreePath || request.workspacePath,
    relativeTargetPath:
      resolution?.containment.relativeTargetPath ||
      relativeTargetPath(worktreeIdentity, comparisonTargetPath),
    ...(request.worktreeName ? { worktreeName: request.worktreeName } : {}),
    ...(request.branch ? { branch: request.branch } : {}),
    kind: 'hunk',
    mode,
    hunk: {
      baseline: hunk.baseline,
      startLine: hunk.startLine,
      endLine: hunk.endLine
    },
    ...(resolution ? { pathEvidence: clonePathEvidence(resolution) } : {})
  }
}

function sameLockDomain(
  left: CanonicalWorkspaceLockClaim,
  right: CanonicalWorkspaceLockClaim
): boolean {
  return (
    left.worktreeIdentity === right.worktreeIdentity ||
    (!!left.worktreeObjectIdentity && left.worktreeObjectIdentity === right.worktreeObjectIdentity)
  )
}

function sameOrAncestorPath(left: string, right: string): boolean {
  return workspaceLockPathContains(left, right)
}

function targetsSharePath(
  left: CanonicalWorkspaceLockClaim,
  right: CanonicalWorkspaceLockClaim
): boolean {
  if (left.kind === 'workspace' || right.kind === 'workspace') return true
  const compareRelative =
    left.worktreeIdentity !== right.worktreeIdentity &&
    !!left.worktreeObjectIdentity &&
    left.worktreeObjectIdentity === right.worktreeObjectIdentity
  const leftPath = compareRelative ? hierarchyRelativePath(left) : left.comparisonTargetPath
  const rightPath = compareRelative ? hierarchyRelativePath(right) : right.comparisonTargetPath
  if (left.kind === 'tree' && right.kind === 'tree') {
    return sameOrAncestorPath(leftPath, rightPath) || sameOrAncestorPath(rightPath, leftPath)
  }
  if (left.kind === 'tree') return sameOrAncestorPath(leftPath, rightPath)
  if (right.kind === 'tree') return sameOrAncestorPath(rightPath, leftPath)
  if (left.objectIdentity && right.objectIdentity && left.objectIdentity === right.objectIdentity) {
    return true
  }
  return leftPath === rightPath
}

function hierarchyRelativePath(claim: CanonicalWorkspaceLockClaim): string {
  const relative = claim.relativeTargetPath || '.'
  return claim.pathEvidence && !claim.pathEvidence.caseSensitive
    ? relative.toLocaleLowerCase('en-US')
    : relative
}

function hunkRangesConflict(left: WorkspaceLockHunk, right: WorkspaceLockHunk): boolean {
  // Hunk coordinates from different file snapshots cannot safely be compared.
  if (left.baseline !== right.baseline) return true

  const leftInsertion = left.startLine === left.endLine
  const rightInsertion = right.startLine === right.endLine
  if (leftInsertion && rightInsertion) return left.startLine === right.startLine
  if (leftInsertion) return left.startLine >= right.startLine && left.startLine <= right.endLine
  if (rightInsertion) return right.startLine >= left.startLine && right.startLine <= left.endLine
  return left.startLine < right.endLine && right.startLine < left.endLine
}

/**
 * Reader-reader claims never contend. A writer conflicts with every
 * overlapping target. Hunk ranges refine only two hunk claims over the same
 * physical file; a file/tree/workspace claim intentionally covers all hunks.
 */
export function workspaceLockClaimsConflict(
  left: CanonicalWorkspaceLockClaim,
  right: CanonicalWorkspaceLockClaim
): boolean {
  if (left.mode === 'read' && right.mode === 'read') return false
  if (left.globalFilesystem || right.globalFilesystem) return true
  if (
    left.kind !== 'workspace' &&
    right.kind !== 'workspace' &&
    left.objectIdentity &&
    left.objectIdentity === right.objectIdentity
  ) {
    if (left.kind !== 'hunk' || right.kind !== 'hunk') return true
    return hunkRangesConflict(left.hunk as WorkspaceLockHunk, right.hunk as WorkspaceLockHunk)
  }
  if (!sameLockDomain(left, right)) return false
  if (!targetsSharePath(left, right)) return false
  if (left.kind !== 'hunk' || right.kind !== 'hunk') return true
  return hunkRangesConflict(left.hunk as WorkspaceLockHunk, right.hunk as WorkspaceLockHunk)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable deterministic ordering for snapshots, journals, and conflict output. */
export function compareWorkspaceLockClaims(
  left: CanonicalWorkspaceLockClaim,
  right: CanonicalWorkspaceLockClaim
): number {
  const fields: readonly [string, string][] = [
    [left.workspaceIdentity, right.workspaceIdentity],
    [left.worktreeIdentity, right.worktreeIdentity],
    [left.worktreeCanonicalPath, right.worktreeCanonicalPath],
    [left.comparisonTargetPath, right.comparisonTargetPath],
    [left.objectIdentity || '', right.objectIdentity || ''],
    [left.globalFilesystem ? '1' : '0', right.globalFilesystem ? '1' : '0']
  ]
  for (const [leftField, rightField] of fields) {
    const comparison = compareText(leftField, rightField)
    if (comparison) return comparison
  }
  if (kindOrder[left.kind] !== kindOrder[right.kind])
    return kindOrder[left.kind] - kindOrder[right.kind]
  if (left.mode !== right.mode) return left.mode === 'read' ? -1 : 1

  const leftHunk = left.hunk
  const rightHunk = right.hunk
  if (!leftHunk || !rightHunk) return leftHunk ? 1 : rightHunk ? -1 : 0
  return (
    compareText(leftHunk.baseline, rightHunk.baseline) ||
    leftHunk.startLine - rightHunk.startLine ||
    leftHunk.endLine - rightHunk.endLine
  )
}

export function sortWorkspaceLockClaims(
  claims: readonly CanonicalWorkspaceLockClaim[]
): CanonicalWorkspaceLockClaim[] {
  return [...claims].sort(compareWorkspaceLockClaims)
}

function clonePathEvidence(
  evidence: ResolvedCanonicalWorkspaceLockPath
): ResolvedCanonicalWorkspaceLockPath {
  return {
    ...evidence,
    targetIdentity:
      evidence.targetIdentity.kind === 'existing'
        ? {
            ...evidence.targetIdentity,
            file: { ...evidence.targetIdentity.file }
          }
        : {
            ...evidence.targetIdentity,
            existingAncestor: { ...evidence.targetIdentity.existingAncestor }
          },
    containment: {
      ...evidence.containment,
      rootIdentity: { ...evidence.containment.rootIdentity },
      existingAncestorIdentity: { ...evidence.containment.existingAncestorIdentity }
    }
  }
}
