import { statSync } from 'node:fs'
import * as nodePath from 'node:path'

import type { TaskWraithMcpToolName } from '../../shared/taskWraithMcpCatalog'
import type {
  WorkspaceLockMutationCapability,
  WorkspaceLockClaimKind
} from '../workLocks/WorkspaceLockTypes'
import type {
  CanonicalWorkspaceLockPathFlavor,
  ResolvedCanonicalWorkspaceLockPath
} from '../workLocks/CanonicalWorkspaceLockPath'
import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from '../workLocks/CanonicalWorkspaceLockPath'

export type VerifiedWorkspaceMutationHandoffRefusalReason =
  | 'missing_capability'
  | 'invalid_capability'
  | 'mixed_capability_scope'
  | 'unsupported_tool'
  | 'invalid_arguments'
  | 'path_mismatch'
  | 'ambiguous_path'
  | 'capability_count_mismatch'
  | 'cwd_mismatch'
  | 'unsafe_patch'

export interface VerifiedWorkspaceMutationExecutionContext {
  /**
   * Fresh canonical cwd. This preserves a requested subdirectory while
   * replacing every lexical/root alias with a physical in-workspace path.
   */
  cwd: string
  /** Fresh canonical workspace root from the verified capability evidence. */
  workspacePath: string
  mode: 'precise-targets' | 'verified-workspace'
  executableTargetPaths: readonly string[]
  capabilityLeaseIds: readonly string[]
  /** Fresh subdirectory evidence when cwd is below the workspace root. */
  cwdPathEvidence?: ResolvedCanonicalWorkspaceLockPath
  /**
   * A structural assertion for downstream code and tests: no provider path
   * argument survives a precise-target handoff.
   */
  rawPrecisePathsForwarded: false
}

export type VerifiedWorkspaceMutationHandoffResult =
  | {
      ok: true
      mode: 'precise-targets' | 'verified-workspace'
      args: Record<string, unknown>
      executionContext: VerifiedWorkspaceMutationExecutionContext
    }
  | {
      ok: false
      reason: VerifiedWorkspaceMutationHandoffRefusalReason
      message: string
    }

export type VerifiedWorkspaceMutationCwdRecheckResult =
  | { ok: true }
  | {
      ok: false
      reason: 'cwd_mismatch'
      message: string
    }

export interface VerifiedWorkspaceMutationHandoffInput {
  toolName: TaskWraithMcpToolName | string
  args: Readonly<Record<string, unknown>>
  capabilities: readonly WorkspaceLockMutationCapability[]
  /**
   * Raw cwd selector used during the original argument preflight. Empty means
   * the workspace root.
   */
  requestedCwd?: string | null
  /**
   * Preflight's effective absolute cwd. Supplying both values lets this
   * boundary prove that the selected subdirectory did not change.
   */
  effectiveCwd?: string | null
}

interface VerifiedTarget {
  key: string
  executableTargetPath: string
  kind: WorkspaceLockClaimKind
  evidence: ResolvedCanonicalWorkspaceLockPath
  leaseIds: string[]
}

interface ValidatedCapabilities {
  rootPath: string
  executionCwd: string
  cwdPathEvidence?: ResolvedCanonicalWorkspaceLockPath
  targets: VerifiedTarget[]
  workspaceOnly: boolean
  leaseIds: string[]
}

interface InternalFailure {
  ok: false
  reason: VerifiedWorkspaceMutationHandoffRefusalReason
  message: string
}

type InternalResult<T> = { ok: true; value: T } | InternalFailure

const PRECISE_TOOL_NAMES = new Set([
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'apply_patch'
])

const VERIFIED_WORKSPACE_TOOL_NAMES = new Set([
  'run_shell_command',
  'git_commit',
  'run_task',
  'start_background_process',
  'kill_background_process',
  'get_diagnostics',
  'launch_start',
  'launch_stop',
  'video_probe',
  'video_encode_clip',
  'video_concat_clips',
  'audio_extract',
  'transcode_audio',
  'audio_mix',
  'transcode_video'
])

const SINGLE_PATH_ALIASES = [
  'path',
  'file_path',
  'filePath',
  'file',
  'directory',
  'dir',
  'folder',
  'target',
  'targetPath'
] as const

const MOVE_SOURCE_ALIASES = ['from', 'source', 'sourcePath', 'old_path', 'oldPath', 'path'] as const

const MOVE_DESTINATION_ALIASES = [
  'to',
  'destination',
  'destinationPath',
  'new_path',
  'newPath',
  'target',
  'targetPath'
] as const

const RENAME_SOURCE_ALIASES = [
  'path',
  'source',
  'sourcePath',
  'old_path',
  'oldPath',
  'from'
] as const

const RENAME_NAME_ALIASES = ['newName', 'new_name', 'name'] as const

const GIT_PATH_ALIASES = ['paths', 'path', 'files', 'file'] as const
const CWD_ALIASES = ['cwd', 'working_directory', 'workdir'] as const

function fail(
  reason: VerifiedWorkspaceMutationHandoffRefusalReason,
  message: string
): InternalFailure {
  return { ok: false, reason, message }
}

function pathApi(flavor: CanonicalWorkspaceLockPathFlavor): typeof nodePath.posix {
  return flavor === 'win32' ? nodePath.win32 : nodePath.posix
}

function comparisonValue(value: string, evidence: ResolvedCanonicalWorkspaceLockPath): string {
  const normalized = pathApi(evidence.pathFlavor).resolve(value)
  return evidence.caseSensitive ? normalized : normalized.toLocaleLowerCase('en-US')
}

function samePath(
  left: string,
  right: string,
  evidence: ResolvedCanonicalWorkspaceLockPath
): boolean {
  return comparisonValue(left, evidence) === comparisonValue(right, evidence)
}

function targetGroupKey(capability: WorkspaceLockMutationCapability): string {
  const evidence = capability.verifiedPathEvidence
  return [
    evidence.pathFlavor,
    evidence.caseSensitive ? 'sensitive' : 'folded',
    comparisonValue(evidence.lexicalTargetPath, evidence),
    comparisonValue(capability.executableTargetPath, evidence)
  ].join('\u0000')
}

function validateCapabilities(
  capabilities: readonly WorkspaceLockMutationCapability[]
): InternalResult<ValidatedCapabilities> {
  if (capabilities.length === 0) {
    return fail('missing_capability', 'Mutation execution requires a verified lock capability.')
  }

  const leaseIds = new Set<string>()
  const lexicalTargets = new Map<string, string>()
  const targets = new Map<string, VerifiedTarget>()
  let rootComparison: string | undefined
  let rootPath: string | undefined
  let hasWorkspace = false
  let hasPrecise = false
  let acquisitionSignature: string | undefined

  for (const capability of capabilities) {
    if (
      !capability.leaseId ||
      capability.token.leaseId !== capability.leaseId ||
      leaseIds.has(capability.leaseId)
    ) {
      return fail('invalid_capability', 'Mutation capabilities contain a duplicate or empty lease.')
    }
    leaseIds.add(capability.leaseId)

    const nextAcquisitionSignature = [
      capability.token.acquiredTransitionId,
      capability.token.authorityInstanceId,
      capability.token.authorityGeneration,
      capability.token.ownerRunId
    ].join('\u0000')
    if (acquisitionSignature !== undefined && acquisitionSignature !== nextAcquisitionSignature) {
      return fail(
        'invalid_capability',
        'Mutation capabilities do not belong to one verified acquisition.'
      )
    }
    acquisitionSignature = nextAcquisitionSignature

    if (
      (capability.kind === 'hunk' &&
        (!capability.hunk ||
          !capability.hunk.baseline ||
          !Number.isSafeInteger(capability.hunk.startLine) ||
          !Number.isSafeInteger(capability.hunk.endLine) ||
          capability.hunk.startLine < 0 ||
          capability.hunk.endLine < capability.hunk.startLine)) ||
      (capability.kind !== 'hunk' && capability.hunk !== undefined)
    ) {
      return fail('invalid_capability', 'Mutation capability hunk metadata is inconsistent.')
    }

    const evidence = capability.verifiedPathEvidence
    if (
      !evidence ||
      capability.executableTargetPath !== evidence.canonicalPath ||
      evidence.canonicalPath !== evidence.containment.canonicalTargetPath ||
      evidence.comparisonPath !== evidence.containment.comparisonTargetPath
    ) {
      return fail(
        'invalid_capability',
        'A mutation capability is not bound to its fresh verified path evidence.'
      )
    }

    const nextRootComparison = evidence.containment.comparisonRootPath
    if (rootComparison !== undefined && rootComparison !== nextRootComparison) {
      return fail('invalid_capability', 'Mutation capabilities span different verified roots.')
    }
    rootComparison = nextRootComparison
    rootPath = evidence.containment.canonicalRootPath

    const relativeTarget = pathApi(evidence.pathFlavor).relative(
      evidence.containment.canonicalRootPath,
      capability.executableTargetPath
    )
    if (
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${pathApi(evidence.pathFlavor).sep}`) ||
      pathApi(evidence.pathFlavor).isAbsolute(relativeTarget)
    ) {
      return fail(
        'invalid_capability',
        'A mutation capability target is outside its verified root.'
      )
    }

    if (capability.kind === 'workspace') {
      hasWorkspace = true
      if (
        relativeTarget !== '' ||
        !samePath(capability.executableTargetPath, evidence.containment.canonicalRootPath, evidence)
      ) {
        return fail(
          'invalid_capability',
          'A workspace capability must execute at its verified workspace root.'
        )
      }
    } else {
      hasPrecise = true
      if (relativeTarget === '') {
        return fail('invalid_capability', 'A precise capability cannot target the workspace root.')
      }
    }

    const lexicalKey = [
      evidence.pathFlavor,
      evidence.caseSensitive ? 'sensitive' : 'folded',
      comparisonValue(evidence.lexicalTargetPath, evidence)
    ].join('\u0000')
    const priorExecutable = lexicalTargets.get(lexicalKey)
    if (
      priorExecutable !== undefined &&
      !samePath(priorExecutable, capability.executableTargetPath, evidence)
    ) {
      return fail(
        'ambiguous_path',
        'Two mutation capabilities bind the same requested path to different executable targets.'
      )
    }
    lexicalTargets.set(lexicalKey, capability.executableTargetPath)

    const key = targetGroupKey(capability)
    const existing = targets.get(key)
    if (existing) {
      if (existing.kind !== 'hunk' || capability.kind !== 'hunk') {
        return fail(
          'invalid_capability',
          'Only distinct hunk capabilities may share one verified executable target.'
        )
      }
      existing.leaseIds.push(capability.leaseId)
    } else {
      targets.set(key, {
        key,
        executableTargetPath: capability.executableTargetPath,
        kind: capability.kind,
        evidence,
        leaseIds: [capability.leaseId]
      })
    }
  }

  if (hasWorkspace && hasPrecise) {
    return fail(
      'mixed_capability_scope',
      'Workspace-wide and precise mutation capabilities cannot share one executor handoff.'
    )
  }
  if (!rootPath) {
    return fail('invalid_capability', 'Mutation capabilities lack a verified workspace root.')
  }

  return {
    ok: true,
    value: {
      rootPath,
      executionCwd: rootPath,
      targets: [...targets.values()],
      workspaceOnly: hasWorkspace,
      leaseIds: [...leaseIds]
    }
  }
}

function firstDefined(
  args: Readonly<Record<string, unknown>>,
  aliases: readonly string[]
): unknown {
  for (const alias of aliases) {
    if (args[alias] !== undefined) return args[alias]
  }
  return undefined
}

function requirePathArgument(
  args: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
  label: string
): InternalResult<string> {
  const value = firstDefined(args, aliases)
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('invalid_arguments', `${label} must be a non-empty string.`)
  }
  return { ok: true, value }
}

function withoutKeys(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, unknown> {
  const result = { ...args }
  for (const key of keys) delete result[key]
  return result
}

function matchesRawPath(target: VerifiedTarget, rawPath: string): boolean {
  const evidence = target.evidence
  const api = pathApi(evidence.pathFlavor)
  const resolved = api.isAbsolute(rawPath)
    ? api.resolve(rawPath)
    : api.resolve(evidence.lexicalRootPath, rawPath)
  return (
    samePath(resolved, evidence.lexicalTargetPath, evidence) ||
    samePath(resolved, target.executableTargetPath, evidence)
  )
}

function matchTarget(
  rawPath: string,
  targets: readonly VerifiedTarget[],
  label: string
): InternalResult<VerifiedTarget> {
  const matches = targets.filter((target) => matchesRawPath(target, rawPath))
  if (matches.length === 0) {
    return fail('path_mismatch', `${label} is not represented by a verified mutation capability.`)
  }
  if (matches.length !== 1) {
    return fail('ambiguous_path', `${label} maps to more than one verified mutation capability.`)
  }
  return { ok: true, value: matches[0] }
}

function requireEveryTargetUsed(
  targets: readonly VerifiedTarget[],
  used: ReadonlySet<string>
): InternalFailure | undefined {
  if (targets.some((target) => !used.has(target.key))) {
    return fail(
      'capability_count_mismatch',
      'The verified mutation capabilities do not exactly match the executor path arguments.'
    )
  }
  return undefined
}

function preciseContext(
  capabilities: ValidatedCapabilities,
  targets: readonly VerifiedTarget[]
): VerifiedWorkspaceMutationExecutionContext {
  return {
    cwd: capabilities.executionCwd,
    workspacePath: capabilities.rootPath,
    mode: 'precise-targets',
    executableTargetPaths: targets.map((target) => target.executableTargetPath),
    capabilityLeaseIds: capabilities.leaseIds,
    ...(capabilities.cwdPathEvidence ? { cwdPathEvidence: capabilities.cwdPathEvidence } : {}),
    rawPrecisePathsForwarded: false
  }
}

function workspaceContext(
  capabilities: ValidatedCapabilities
): VerifiedWorkspaceMutationExecutionContext {
  return {
    cwd: capabilities.executionCwd,
    workspacePath: capabilities.rootPath,
    mode: 'verified-workspace',
    executableTargetPaths: [capabilities.rootPath],
    capabilityLeaseIds: capabilities.leaseIds,
    ...(capabilities.cwdPathEvidence ? { cwdPathEvidence: capabilities.cwdPathEvidence } : {}),
    rawPrecisePathsForwarded: false
  }
}

function relativeInside(
  rootPath: string,
  targetPath: string,
  evidence: ResolvedCanonicalWorkspaceLockPath
): string | undefined {
  const api = pathApi(evidence.pathFlavor)
  const relative = api.relative(rootPath, targetPath)
  if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
    return undefined
  }
  return relative
}

function normalizedRelative(value: string, evidence: ResolvedCanonicalWorkspaceLockPath): string {
  const api = pathApi(evidence.pathFlavor)
  const normalized = api.normalize(value || '.')
  const rootRelative = normalized === '.' ? '' : normalized
  return evidence.caseSensitive ? rootRelative : rootRelative.toLocaleLowerCase('en-US')
}

function cwdRelativeSelector(
  value: string | null | undefined,
  evidence: ResolvedCanonicalWorkspaceLockPath,
  label: string,
  requireAbsolute: boolean
): InternalResult<string> {
  if (value === null || value === undefined) {
    return { ok: true, value: '' }
  }
  if (typeof value !== 'string') {
    return fail('cwd_mismatch', `${label} must be a string.`)
  }
  if (value.trim().length === 0) {
    return { ok: true, value: '' }
  }
  const api = pathApi(evidence.pathFlavor)
  if (requireAbsolute && !api.isAbsolute(value)) {
    return fail('cwd_mismatch', `${label} must be the absolute preflight cwd.`)
  }

  if (!api.isAbsolute(value)) {
    const target = api.resolve(evidence.lexicalRootPath, value)
    const relative = relativeInside(evidence.lexicalRootPath, target, evidence)
    return relative === undefined
      ? fail('cwd_mismatch', `${label} escapes the verified workspace.`)
      : { ok: true, value: relative }
  }

  const absolute = api.resolve(value)
  const relative =
    relativeInside(evidence.lexicalRootPath, absolute, evidence) ??
    relativeInside(evidence.containment.canonicalRootPath, absolute, evidence)
  return relative === undefined
    ? fail(
        'cwd_mismatch',
        `${label} is neither under the verified lexical root nor its canonical root.`
      )
    : { ok: true, value: relative }
}

function resolveExecutionCwd(
  input: Pick<VerifiedWorkspaceMutationHandoffInput, 'requestedCwd' | 'effectiveCwd'>,
  capabilities: ValidatedCapabilities
): InternalResult<{
  cwd: string
  evidence?: ResolvedCanonicalWorkspaceLockPath
}> {
  if (input.requestedCwd === undefined && input.effectiveCwd === undefined) {
    return { ok: true, value: { cwd: capabilities.rootPath } }
  }
  const rootEvidence = capabilities.targets[0]?.evidence
  if (!rootEvidence) {
    return fail('cwd_mismatch', 'Verified capabilities do not contain cwd root evidence.')
  }

  const requested = cwdRelativeSelector(input.requestedCwd, rootEvidence, 'Requested cwd', false)
  if (!requested.ok) return requested
  const effective = cwdRelativeSelector(input.effectiveCwd, rootEvidence, 'Effective cwd', true)
  if (!effective.ok) return effective

  if (
    input.requestedCwd !== undefined &&
    input.effectiveCwd !== undefined &&
    normalizedRelative(requested.value, rootEvidence) !==
      normalizedRelative(effective.value, rootEvidence)
  ) {
    return fail('cwd_mismatch', 'Requested cwd and effective preflight cwd select different paths.')
  }
  const selectedRelative = input.effectiveCwd !== undefined ? effective.value : requested.value
  if (!selectedRelative) {
    return { ok: true, value: { cwd: capabilities.rootPath } }
  }

  const api = pathApi(rootEvidence.pathFlavor)
  const candidate = api.resolve(capabilities.rootPath, selectedRelative)
  try {
    const resolution = resolveCanonicalWorkspaceLockPath({
      rootPath: capabilities.rootPath,
      targetPath: candidate,
      pathFlavor: rootEvidence.pathFlavor,
      caseSensitive: rootEvidence.caseSensitive
    })
    if (
      resolution.containment.rootIdentity.key !== rootEvidence.containment.rootIdentity.key ||
      !samePath(resolution.containment.canonicalRootPath, capabilities.rootPath, rootEvidence)
    ) {
      return fail('cwd_mismatch', 'Workspace root identity changed while verifying the cwd.')
    }
    if (!resolution.targetExists || !statSync(resolution.canonicalPath).isDirectory()) {
      return fail('cwd_mismatch', 'Effective cwd is not an existing workspace directory.')
    }
    const canonicalRelative = api.relative(capabilities.rootPath, resolution.canonicalPath)
    if (
      normalizedRelative(canonicalRelative, rootEvidence) !==
      normalizedRelative(selectedRelative, rootEvidence)
    ) {
      return fail(
        'cwd_mismatch',
        'Effective cwd traverses a filesystem alias instead of the selected workspace subdirectory.'
      )
    }
    return {
      ok: true,
      value: {
        cwd: resolution.canonicalPath,
        evidence: resolution
      }
    }
  } catch {
    return fail(
      'cwd_mismatch',
      'Effective cwd could not be verified as an existing directory under the workspace root.'
    )
  }
}

function rewriteWorkspaceScopedPath(
  rawPath: string,
  workspaceTarget: VerifiedTarget,
  label: string
): InternalResult<string> {
  if (!rawPath.trim()) {
    return fail('invalid_arguments', `${label} must be a non-empty string.`)
  }
  const evidence = workspaceTarget.evidence
  const api = pathApi(evidence.pathFlavor)
  const canonicalRoot = workspaceTarget.executableTargetPath
  let relative: string | undefined
  if (api.isAbsolute(rawPath)) {
    const absolute = api.resolve(rawPath)
    relative =
      relativeInside(evidence.lexicalRootPath, absolute, evidence) ??
      relativeInside(canonicalRoot, absolute, evidence)
  } else {
    relative = relativeInside(canonicalRoot, api.resolve(canonicalRoot, rawPath), evidence)
  }
  if (relative === undefined) {
    return fail('path_mismatch', `${label} escapes the verified workspace capability.`)
  }
  return { ok: true, value: api.resolve(canonicalRoot, relative) }
}

function handoffSinglePath(
  args: Readonly<Record<string, unknown>>,
  capabilities: ValidatedCapabilities,
  aliases: readonly string[],
  outputKey: string,
  label: string
): VerifiedWorkspaceMutationHandoffResult {
  if (capabilities.workspaceOnly || capabilities.targets.length !== 1) {
    return fail(
      'capability_count_mismatch',
      `${label} requires exactly one precise mutation capability.`
    )
  }
  const raw = requirePathArgument(args, aliases, label)
  if (!raw.ok) return raw
  const target = matchTarget(raw.value, capabilities.targets, label)
  if (!target.ok) return target
  const rewritten = withoutKeys(args, SINGLE_PATH_ALIASES)
  rewritten[outputKey] = target.value.executableTargetPath
  return {
    ok: true,
    mode: 'precise-targets',
    args: rewritten,
    executionContext: preciseContext(capabilities, [target.value])
  }
}

function handoffMove(
  args: Readonly<Record<string, unknown>>,
  capabilities: ValidatedCapabilities
): VerifiedWorkspaceMutationHandoffResult {
  if (capabilities.workspaceOnly || capabilities.targets.length !== 2) {
    return fail(
      'capability_count_mismatch',
      'move_path requires exactly two precise mutation capabilities.'
    )
  }
  const rawSource = requirePathArgument(args, MOVE_SOURCE_ALIASES, 'Move source')
  if (!rawSource.ok) return rawSource
  const rawDestination = requirePathArgument(args, MOVE_DESTINATION_ALIASES, 'Move destination')
  if (!rawDestination.ok) return rawDestination
  const source = matchTarget(rawSource.value, capabilities.targets, 'Move source')
  if (!source.ok) return source
  const destination = matchTarget(rawDestination.value, capabilities.targets, 'Move destination')
  if (!destination.ok) return destination
  if (source.value.key === destination.value.key) {
    return fail('path_mismatch', 'Move source and destination require distinct capabilities.')
  }

  const used = new Set([source.value.key, destination.value.key])
  const unused = requireEveryTargetUsed(capabilities.targets, used)
  if (unused) return unused
  const rewritten = withoutKeys(args, [...MOVE_SOURCE_ALIASES, ...MOVE_DESTINATION_ALIASES])
  rewritten.from = source.value.executableTargetPath
  rewritten.to = destination.value.executableTargetPath
  return {
    ok: true,
    mode: 'precise-targets',
    args: rewritten,
    executionContext: preciseContext(capabilities, [source.value, destination.value])
  }
}

function handoffRename(
  args: Readonly<Record<string, unknown>>,
  capabilities: ValidatedCapabilities
): VerifiedWorkspaceMutationHandoffResult {
  if (capabilities.workspaceOnly || capabilities.targets.length !== 2) {
    return fail(
      'capability_count_mismatch',
      'rename_path requires exactly two precise mutation capabilities.'
    )
  }
  const rawSource = requirePathArgument(args, RENAME_SOURCE_ALIASES, 'Rename source')
  if (!rawSource.ok) return rawSource
  const rawName = requirePathArgument(args, RENAME_NAME_ALIASES, 'Rename destination name')
  if (!rawName.ok) return rawName

  const source = matchTarget(rawSource.value, capabilities.targets, 'Rename source')
  if (!source.ok) return source
  const api = pathApi(source.value.evidence.pathFlavor)
  if (
    rawName.value === '.' ||
    rawName.value === '..' ||
    api.basename(rawName.value) !== rawName.value
  ) {
    return fail('invalid_arguments', 'Rename destination name must be a basename.')
  }
  const lexicalSource = api.isAbsolute(rawSource.value)
    ? api.resolve(rawSource.value)
    : api.resolve(source.value.evidence.lexicalRootPath, rawSource.value)
  const rawDestination = api.resolve(api.dirname(lexicalSource), rawName.value)
  const destination = matchTarget(rawDestination, capabilities.targets, 'Rename destination')
  if (!destination.ok) return destination
  if (source.value.key === destination.value.key) {
    return fail('path_mismatch', 'Rename source and destination require distinct capabilities.')
  }

  const executableName = api.basename(destination.value.executableTargetPath)
  const executableDestination = api.resolve(
    api.dirname(source.value.executableTargetPath),
    executableName
  )
  if (
    !samePath(
      executableDestination,
      destination.value.executableTargetPath,
      destination.value.evidence
    )
  ) {
    return fail(
      'path_mismatch',
      'Verified rename destination is not a sibling of the verified source.'
    )
  }

  const used = new Set([source.value.key, destination.value.key])
  const unused = requireEveryTargetUsed(capabilities.targets, used)
  if (unused) return unused
  const rewritten = withoutKeys(args, [
    ...RENAME_SOURCE_ALIASES,
    ...MOVE_DESTINATION_ALIASES,
    ...RENAME_NAME_ALIASES
  ])
  rewritten.path = source.value.executableTargetPath
  rewritten.newName = executableName
  return {
    ok: true,
    mode: 'precise-targets',
    args: rewritten,
    executionContext: preciseContext(capabilities, [source.value, destination.value])
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) return [value]
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  ) {
    return [...value]
  }
  return undefined
}

function handoffGitStage(
  args: Readonly<Record<string, unknown>>,
  capabilities: ValidatedCapabilities
): VerifiedWorkspaceMutationHandoffResult {
  const patch = firstDefined(args, ['patch', 'diff'])
  const requestedPaths = stringArray(firstDefined(args, GIT_PATH_ALIASES))

  if (patch !== undefined) {
    if (typeof patch !== 'string' || !patch.trim()) {
      return fail('invalid_arguments', 'git_stage patch must be a non-empty string.')
    }
    return handoffPatch(args, capabilities, 'git_stage')
  }

  if (requestedPaths) {
    if (capabilities.workspaceOnly) {
      if (capabilities.targets.length !== 1) {
        return fail(
          'capability_count_mismatch',
          'Path-bearing git_stage requires one verified workspace capability.'
        )
      }
      const rewrittenPaths: string[] = []
      for (const [index, rawPath] of requestedPaths.entries()) {
        const rewrittenPath = rewriteWorkspaceScopedPath(
          rawPath,
          capabilities.targets[0],
          `git_stage path ${index + 1}`
        )
        if (!rewrittenPath.ok) return rewrittenPath
        rewrittenPaths.push(rewrittenPath.value)
      }
      const rewritten = withoutKeys(args, GIT_PATH_ALIASES)
      rewritten.paths = rewrittenPaths
      return {
        ok: true,
        mode: 'verified-workspace',
        args: rewritten,
        executionContext: workspaceContext(capabilities)
      }
    }
    const used = new Set<string>()
    const orderedTargets: VerifiedTarget[] = []
    for (const [index, rawPath] of requestedPaths.entries()) {
      const target = matchTarget(rawPath, capabilities.targets, `git_stage path ${index + 1}`)
      if (!target.ok) return target
      used.add(target.value.key)
      orderedTargets.push(target.value)
    }
    const unused = requireEveryTargetUsed(capabilities.targets, used)
    if (unused) return unused
    const rewritten = withoutKeys(args, GIT_PATH_ALIASES)
    rewritten.paths = orderedTargets.map((target) => target.executableTargetPath)
    return {
      ok: true,
      mode: 'precise-targets',
      args: rewritten,
      executionContext: preciseContext(capabilities, orderedTargets)
    }
  }

  if (args.all !== true && args.update !== true) {
    return fail('invalid_arguments', 'git_stage requires paths, patch, all=true, or update=true.')
  }
  if (!capabilities.workspaceOnly || capabilities.targets.length !== 1) {
    return fail(
      'capability_count_mismatch',
      'Repository-wide git_stage requires one verified workspace capability.'
    )
  }
  return {
    ok: true,
    mode: 'verified-workspace',
    args: withoutKeys(args, [...GIT_PATH_ALIASES, 'patch', 'diff']),
    executionContext: workspaceContext(capabilities)
  }
}

function patchRelativePath(target: VerifiedTarget, rootPath: string): InternalResult<string> {
  const api = pathApi(target.evidence.pathFlavor)
  const relative = api.relative(rootPath, target.executableTargetPath)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${api.sep}`) ||
    api.isAbsolute(relative) ||
    /[\r\n\t]/.test(relative)
  ) {
    return fail('unsafe_patch', 'A verified patch target cannot be represented under its root.')
  }
  return { ok: true, value: relative.replaceAll(api.sep, '/') }
}

function patchRawPath(value: string): InternalResult<string | null> {
  if (value === '/dev/null') return { ok: true, value: null }
  if (
    !value ||
    value.startsWith('"') ||
    value.endsWith('"') ||
    nodePath.posix.isAbsolute(value) ||
    nodePath.win32.isAbsolute(value) ||
    value.split(/[\\/]+/).includes('..') ||
    /\s/.test(value)
  ) {
    return fail('unsafe_patch', 'Patch paths must be unquoted, relative, and whitespace-free.')
  }
  return { ok: true, value: value.replace(/^[ab]\//, '') }
}

function rewritePatchPath(
  rawValue: string,
  prefix: 'a/' | 'b/' | '',
  capabilities: ValidatedCapabilities,
  used: Set<string>,
  label: string
): InternalResult<string> {
  const raw = patchRawPath(rawValue)
  if (!raw.ok) return raw
  if (raw.value === null) return { ok: true, value: '/dev/null' }
  if (capabilities.workspaceOnly) {
    if (capabilities.targets.length !== 1) {
      return fail(
        'capability_count_mismatch',
        'Workspace patch execution requires one verified workspace capability.'
      )
    }
    const exactPath = rewriteWorkspaceScopedPath(raw.value, capabilities.targets[0], label)
    if (!exactPath.ok) return exactPath
    const relative = patchRelativePath(
      {
        ...capabilities.targets[0],
        executableTargetPath: exactPath.value
      },
      capabilities.rootPath
    )
    if (!relative.ok) return relative
    return { ok: true, value: `${prefix}${relative.value}` }
  }
  const target = matchTarget(raw.value, capabilities.targets, label)
  if (!target.ok) return target
  const relative = patchRelativePath(target.value, capabilities.rootPath)
  if (!relative.ok) return relative
  used.add(target.value.key)
  return { ok: true, value: `${prefix}${relative.value}` }
}

function rewriteUnifiedPatch(
  patch: string,
  capabilities: ValidatedCapabilities
): InternalResult<string> {
  if (
    !patch.trim() ||
    /^\*\*\*\s*(?:Begin Patch|Update File|Add File|Delete File|End Patch)/m.test(patch) ||
    /^(?:GIT binary patch|Binary files .+ differ)$/m.test(patch)
  ) {
    return fail('unsafe_patch', 'Only textual git unified patches can use precise capabilities.')
  }

  const lines = patch.split(/\r?\n/)
  const rewritten: string[] = []
  const used = new Set<string>()
  let pathHeaderCount = 0
  let activeHunk: { oldRemaining: number; newRemaining: number } | undefined

  for (const line of lines) {
    if (activeHunk) {
      if (line.startsWith('\\')) {
        rewritten.push(line)
        continue
      }
      const prefix = line[0]
      if (prefix === ' ') {
        activeHunk.oldRemaining -= 1
        activeHunk.newRemaining -= 1
      } else if (prefix === '-') {
        activeHunk.oldRemaining -= 1
      } else if (prefix === '+') {
        activeHunk.newRemaining -= 1
      } else {
        return fail('unsafe_patch', 'Patch hunk body does not match its declared line counts.')
      }
      if (activeHunk.oldRemaining < 0 || activeHunk.newRemaining < 0) {
        return fail('unsafe_patch', 'Patch hunk body exceeds its declared line counts.')
      }
      rewritten.push(line)
      if (activeHunk.oldRemaining === 0 && activeHunk.newRemaining === 0) {
        activeHunk = undefined
      }
      continue
    }

    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
    if (hunk) {
      const oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      const newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (
        !Number.isSafeInteger(oldRemaining) ||
        !Number.isSafeInteger(newRemaining) ||
        oldRemaining < 0 ||
        newRemaining < 0
      ) {
        return fail('unsafe_patch', 'Patch hunk has invalid line counts.')
      }
      if (oldRemaining !== 0 || newRemaining !== 0) {
        activeHunk = { oldRemaining, newRemaining }
      }
      rewritten.push(line)
      continue
    }

    const diffHeader = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line)
    if (diffHeader) {
      const oldPath = rewritePatchPath(diffHeader[1], 'a/', capabilities, used, 'Patch old path')
      if (!oldPath.ok) return oldPath
      const newPath = rewritePatchPath(diffHeader[2], 'b/', capabilities, used, 'Patch new path')
      if (!newPath.ok) return newPath
      rewritten.push(`diff --git ${oldPath.value} ${newPath.value}`)
      pathHeaderCount += 2
      continue
    }
    if (line.startsWith('diff --git ')) {
      return fail('unsafe_patch', 'Patch diff headers must use unquoted a/ and b/ paths.')
    }

    const fileHeader = /^(---|\+\+\+) ([^\t]+)(\t.*)?$/.exec(line)
    if (fileHeader) {
      const mapped = rewritePatchPath(
        fileHeader[2],
        fileHeader[1] === '---' ? 'a/' : 'b/',
        capabilities,
        used,
        fileHeader[1] === '---' ? 'Patch old path' : 'Patch new path'
      )
      if (!mapped.ok) return mapped
      rewritten.push(`${fileHeader[1]} ${mapped.value}${fileHeader[3] || ''}`)
      pathHeaderCount += mapped.value === '/dev/null' ? 0 : 1
      continue
    }

    const metadataPath = /^(rename from|rename to|copy from|copy to) (.+)$/.exec(line)
    if (metadataPath) {
      const mapped = rewritePatchPath(
        metadataPath[2],
        '',
        capabilities,
        used,
        `Patch ${metadataPath[1]}`
      )
      if (!mapped.ok || mapped.value === '/dev/null') {
        return mapped.ok
          ? fail('unsafe_patch', 'Patch rename/copy metadata cannot target /dev/null.')
          : mapped
      }
      rewritten.push(`${metadataPath[1]} ${mapped.value}`)
      pathHeaderCount += 1
      continue
    }

    if (/^(Index:|--- |\+\+\+ |rename from |rename to |copy from |copy to )/.test(line)) {
      return fail('unsafe_patch', 'Patch contains an unsupported or malformed path header.')
    }
    rewritten.push(line)
  }

  if (activeHunk || pathHeaderCount === 0) {
    return fail('unsafe_patch', 'Patch is incomplete or contains no verified file paths.')
  }
  if (!capabilities.workspaceOnly) {
    const unused = requireEveryTargetUsed(capabilities.targets, used)
    if (unused) return unused
  }
  return { ok: true, value: rewritten.join('\n') }
}

function handoffPatch(
  args: Readonly<Record<string, unknown>>,
  capabilities: ValidatedCapabilities,
  toolName: 'apply_patch' | 'git_stage'
): VerifiedWorkspaceMutationHandoffResult {
  if (capabilities.workspaceOnly && toolName !== 'git_stage') {
    return fail(
      'capability_count_mismatch',
      `${toolName} requires precise capabilities for every patch path.`
    )
  }
  const patchValue = firstDefined(args, ['patch', 'diff'])
  if (typeof patchValue !== 'string') {
    return fail('invalid_arguments', `${toolName} patch must be a string.`)
  }
  const patch = rewriteUnifiedPatch(patchValue, capabilities)
  if (!patch.ok) return patch
  const rewritten = withoutKeys(args, ['patch', 'diff'])
  rewritten.patch = patch.value
  return {
    ok: true,
    mode: capabilities.workspaceOnly ? 'verified-workspace' : 'precise-targets',
    args: rewritten,
    executionContext: capabilities.workspaceOnly
      ? workspaceContext(capabilities)
      : preciseContext(capabilities, capabilities.targets)
  }
}

/**
 * Convert fresh workspace-lock mutation capabilities into the only paths an
 * executor may consume.
 *
 * This function never trusts capability ordering. It matches provider paths
 * against acquisition-time lexical evidence, then substitutes the fresh
 * canonical `executableTargetPath`. Workspace-wide operations receive a
 * separate canonical-root context. Calls that cannot be mapped exactly refuse
 * execution instead of returning their raw precise paths.
 */
function prepareVerifiedWorkspaceMutationHandoffUnfinalized(
  input: VerifiedWorkspaceMutationHandoffInput
): VerifiedWorkspaceMutationHandoffResult {
  const validated = validateCapabilities(input.capabilities)
  if (!validated.ok) return validated
  const capabilities = validated.value
  const executionCwd = resolveExecutionCwd(input, capabilities)
  if (!executionCwd.ok) return executionCwd
  capabilities.executionCwd = executionCwd.value.cwd
  capabilities.cwdPathEvidence = executionCwd.value.evidence

  switch (input.toolName) {
    case 'write_file':
      return handoffSinglePath(
        input.args,
        capabilities,
        ['path', 'file_path', 'filePath'],
        'path',
        'write_file path'
      )
    case 'replace':
      return handoffSinglePath(
        input.args,
        capabilities,
        ['path', 'file_path', 'filePath'],
        'path',
        'replace path'
      )
    case 'create_directory':
      return handoffSinglePath(
        input.args,
        capabilities,
        ['path', 'directory'],
        'path',
        'create_directory path'
      )
    case 'delete_path':
      return handoffSinglePath(
        input.args,
        capabilities,
        ['path', 'file_path', 'filePath'],
        'path',
        'delete_path path'
      )
    case 'move_path':
      return handoffMove(input.args, capabilities)
    case 'rename_path':
      return handoffRename(input.args, capabilities)
    case 'apply_patch':
      return handoffPatch(input.args, capabilities, 'apply_patch')
    case 'git_stage':
      return handoffGitStage(input.args, capabilities)
    default:
      break
  }

  if (PRECISE_TOOL_NAMES.has(input.toolName)) {
    return fail('unsupported_tool', `No strict path handoff exists for ${input.toolName}.`)
  }
  if (!VERIFIED_WORKSPACE_TOOL_NAMES.has(input.toolName)) {
    return fail(
      'unsupported_tool',
      `No verified workspace execution strategy exists for ${input.toolName}.`
    )
  }
  if (!capabilities.workspaceOnly || capabilities.targets.length !== 1) {
    return fail(
      'capability_count_mismatch',
      `${input.toolName} requires exactly one verified workspace capability.`
    )
  }
  return {
    ok: true,
    mode: 'verified-workspace',
    args: { ...input.args },
    executionContext: workspaceContext(capabilities)
  }
}

export function prepareVerifiedWorkspaceMutationHandoff(
  input: VerifiedWorkspaceMutationHandoffInput
): VerifiedWorkspaceMutationHandoffResult {
  const handoff = prepareVerifiedWorkspaceMutationHandoffUnfinalized(input)
  if (!handoff.ok || !CWD_ALIASES.some((alias) => input.args[alias] !== undefined)) {
    return handoff
  }
  return {
    ...handoff,
    args: {
      ...withoutKeys(handoff.args, CWD_ALIASES),
      cwd: handoff.executionContext.cwd
    }
  }
}

/**
 * Recheck a preserved subcwd immediately before process launch or another
 * executor boundary that occurs after asynchronous work. Root-only contexts
 * are already covered by the workspace capability's ordinary revalidation.
 */
export function reverifyWorkspaceMutationExecutionCwd(
  context: Pick<
    VerifiedWorkspaceMutationExecutionContext,
    'cwd' | 'workspacePath' | 'cwdPathEvidence'
  >
): VerifiedWorkspaceMutationCwdRecheckResult {
  if (!context.cwdPathEvidence) {
    return context.cwd === context.workspacePath
      ? { ok: true }
      : {
          ok: false,
          reason: 'cwd_mismatch',
          message: 'A non-root mutation cwd is missing verified path evidence.'
        }
  }
  const verification = verifyCanonicalWorkspaceLockPath(context.cwdPathEvidence)
  if (
    !verification.ok ||
    verification.resolution.canonicalPath !== context.cwd ||
    verification.resolution.containment.canonicalRootPath !== context.workspacePath
  ) {
    return {
      ok: false,
      reason: 'cwd_mismatch',
      message: 'Mutation cwd identity or containment changed after capability handoff.'
    }
  }
  try {
    if (!statSync(context.cwd).isDirectory()) {
      return {
        ok: false,
        reason: 'cwd_mismatch',
        message: 'Mutation cwd is no longer a directory.'
      }
    }
  } catch {
    return {
      ok: false,
      reason: 'cwd_mismatch',
      message: 'Mutation cwd is no longer available.'
    }
  }
  return { ok: true }
}
