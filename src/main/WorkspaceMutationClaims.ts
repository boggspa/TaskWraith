import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

import {
  resolveCatalogActionStrict,
  resolveProviderNativeActionStrict,
  type ProviderNativeActionContext,
  type ResolvedProviderAction
} from '../shared/providerActionTaxonomy'
import { isPromptFreeReadOnlyShellCommand } from './PromptFreeReadOnlyShell'
import { isReadOnlyShellCommand } from './grok/GrokReadOnlyShell'
import type { ProviderId } from './store/types'
import type { WorkspaceLockClaimRequest, WorkspaceLockHunk } from './workLocks/WorkspaceLockTypes'

export type WorkspaceMutationCallSource = 'taskwraith-catalog' | 'provider-native'
export type WorkspaceMutationExecutionMode = 'execute' | 'dry-run'

export interface WorkspaceMutationCall {
  workspacePath: string
  worktreePath?: string
  worktreeName?: string
  branch?: string
  source?: WorkspaceMutationCallSource
  provider?: ProviderId
  action: string
  args?: Record<string, unknown>
  /** Stable provider wire metadata; never a human-readable title. */
  nativeContext?: ProviderNativeActionContext
  /**
   * This is an executor-owned fact, not an inference from a suggestive tool
   * name. A verified dry-run cannot mutate the checkout and therefore needs no
   * write claim.
   */
  executionMode?: WorkspaceMutationExecutionMode
}

export interface WorkspaceMutationClaimStat {
  isDirectory(): boolean
  isFile(): boolean
}

export interface WorkspaceMutationClaimDependencies {
  readFile(path: string): Promise<Buffer>
  lstat(path: string): Promise<WorkspaceMutationClaimStat>
  stat(path: string): Promise<WorkspaceMutationClaimStat>
}

const NODE_WORKSPACE_MUTATION_CLAIM_DEPENDENCIES: WorkspaceMutationClaimDependencies = {
  readFile: (path) => fs.readFile(path),
  lstat: (path) => fs.lstat(path),
  stat: (path) => fs.stat(path)
}

export type WorkspaceMutationClaimDerivationErrorCode =
  | 'invalid-call'
  | 'path-escape'
  | 'unmapped-action'

export class WorkspaceMutationClaimDerivationError extends Error {
  readonly code: WorkspaceMutationClaimDerivationErrorCode

  constructor(code: WorkspaceMutationClaimDerivationErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceMutationClaimDerivationError'
    this.code = code
  }
}

interface ClaimContext {
  workspacePath: string
  worktreePath: string
  worktreeName?: string
  branch?: string
}

interface ParsedPatchHunk {
  startLine: number
  endLine: number
}

interface ParsedPatchFile {
  oldPath?: string | null
  newPath?: string | null
  hunks: ParsedPatchHunk[]
  invalid: boolean
  binary: boolean
}

interface ParsedPatch {
  files: ParsedPatchFile[]
  invalid: boolean
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceMutationClaimDerivationError('invalid-call', `${label} is required.`)
  }
  return value
}

function normalizedCallArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      'Workspace mutation arguments must be an object.'
    )
  }
  return value as Record<string, unknown>
}

function resolveStrictAction(input: WorkspaceMutationCall): ResolvedProviderAction {
  const source = input.source || 'taskwraith-catalog'
  if (source === 'provider-native') {
    if (!input.provider) {
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        'provider is required for a provider-native action.'
      )
    }
    const result = resolveProviderNativeActionStrict(
      input.provider,
      input.action,
      input.nativeContext
    )
    if (!result.ok) {
      throw new WorkspaceMutationClaimDerivationError('unmapped-action', result.reason)
    }
    return result
  }

  const result = resolveCatalogActionStrict(input.action)
  if (!result.ok) {
    throw new WorkspaceMutationClaimDerivationError('unmapped-action', result.reason)
  }
  return result
}

function normalizedRoot(value: string, label: string): string {
  return resolve(requireNonEmptyString(value, label))
}

function claimContext(input: WorkspaceMutationCall): ClaimContext {
  const workspacePath = normalizedRoot(input.workspacePath, 'workspacePath')
  return {
    workspacePath,
    worktreePath: input.worktreePath
      ? normalizedRoot(input.worktreePath, 'worktreePath')
      : workspacePath,
    ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
    ...(input.branch ? { branch: input.branch } : {})
  }
}

function resolveTargetPath(context: ClaimContext, value: unknown, label: string): string {
  const rawPath = requireNonEmptyString(value, label)
  const targetPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(context.worktreePath, rawPath)
  const relativePath = relative(context.worktreePath, targetPath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new WorkspaceMutationClaimDerivationError(
      'path-escape',
      `${label} must stay inside the selected worktree.`
    )
  }
  return targetPath
}

function baseClaim(context: ClaimContext): Omit<WorkspaceLockClaimRequest, 'kind'> {
  return {
    workspacePath: context.workspacePath,
    worktreePath: context.worktreePath,
    ...(context.worktreeName ? { worktreeName: context.worktreeName } : {}),
    ...(context.branch ? { branch: context.branch } : {}),
    mode: 'write'
  }
}

function pathClaim(context: ClaimContext, targetPath: string): WorkspaceLockClaimRequest {
  return { ...baseClaim(context), kind: 'file', targetPath }
}

function hunkClaim(
  context: ClaimContext,
  targetPath: string,
  hunk: WorkspaceLockHunk
): WorkspaceLockClaimRequest {
  return { ...baseClaim(context), kind: 'hunk', targetPath, hunk }
}

function promoteNativeHunkClaims(
  input: WorkspaceMutationCall,
  context: ClaimContext,
  claims: readonly WorkspaceLockClaimRequest[]
): WorkspaceLockClaimRequest[] {
  // Provider-native writes are observed at preflight but do not execute inside
  // TaskWraith's brokered file-write critical section. Keep their exact paths,
  // but never grant concurrency on coordinates the provider can invalidate
  // outside that section.
  if (input.source !== 'provider-native') return [...claims]
  return uniqueClaims(
    claims.map((claim) =>
      claim.kind === 'hunk' && claim.targetPath ? pathClaim(context, claim.targetPath) : claim
    )
  )
}

function uniqueClaims(claims: readonly WorkspaceLockClaimRequest[]): WorkspaceLockClaimRequest[] {
  const seen = new Set<string>()
  return claims.filter((claim) => {
    const key = JSON.stringify([
      claim.kind,
      claim.targetPath || '',
      claim.hunk?.baseline || '',
      claim.hunk?.startLine ?? -1,
      claim.hunk?.endLine ?? -1
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function firstArgument(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name]
  }
  return undefined
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function missingDirectoryEntryClaims(
  context: ClaimContext,
  targetDirectory: string,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const missing: string[] = []
  let cursor = targetDirectory
  while (cursor !== context.worktreePath) {
    const relativePath = relative(context.worktreePath, cursor)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new WorkspaceMutationClaimDerivationError(
        'path-escape',
        'Planned parent directory must stay inside the selected worktree.'
      )
    }
    let lexicalStat: WorkspaceMutationClaimStat
    try {
      lexicalStat = await dependencies.lstat(cursor)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new WorkspaceMutationClaimDerivationError(
          'invalid-call',
          'Planned parent directory could not be verified before mutation.'
        )
      }
      missing.push(cursor)
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new WorkspaceMutationClaimDerivationError(
          'path-escape',
          'Planned parent directory has no verified workspace ancestor.'
        )
      }
      cursor = parent
      continue
    }

    let resolvedStat = lexicalStat
    if (!lexicalStat.isDirectory()) {
      try {
        resolvedStat = await dependencies.stat(cursor)
      } catch {
        // lstat already proved that an entry occupies this path. A failed
        // follow means it is dangling or otherwise unusable as a parent, not a
        // missing directory entry this mutation may safely create.
        throw new WorkspaceMutationClaimDerivationError(
          'invalid-call',
          'Planned parent path must resolve to a directory before mutation.'
        )
      }
    }
    if (!resolvedStat.isDirectory()) {
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        'Planned parent path must resolve to a directory before mutation.'
      )
    }
    // The runtime canonicalizer resolves and fingerprints this directory or
    // in-workspace directory symlink before acquisition, then re-verifies
    // that identity at commit.
    break
  }
  missing.reverse()
  return missing.map((targetPath) => pathClaim(context, targetPath))
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

async function readTextBaseline(
  dependencies: WorkspaceMutationClaimDependencies,
  targetPath: string
): Promise<{ baseline: string; text: string } | null> {
  try {
    const buffer = await dependencies.readFile(targetPath)
    const text = decodeText(buffer)
    return text === null ? null : { baseline: sha256(buffer), text }
  } catch {
    return null
  }
}

function lineIndexAt(text: string, offset: number): number {
  let line = 0
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

function replacementHunk(text: string, startOffset: number, oldString: string): ParsedPatchHunk {
  const startLine = lineIndexAt(text, startOffset)
  const newlineCount = oldString.split('\n').length - 1
  const lineSpan = Math.max(1, newlineCount + (oldString.endsWith('\n') ? 0 : 1))
  return { startLine, endLine: startLine + lineSpan }
}

function allOccurrences(text: string, needle: string): number[] {
  const matches: number[] = []
  let offset = 0
  while (offset <= text.length - needle.length) {
    const match = text.indexOf(needle, offset)
    if (match < 0) break
    matches.push(match)
    offset = match + needle.length
  }
  return matches
}

async function deriveReplaceClaims(
  context: ClaimContext,
  args: Record<string, unknown>,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const targetPath = resolveTargetPath(
    context,
    firstArgument(args, ['path', 'file_path', 'filePath']),
    'replace path'
  )
  const fallback = [pathClaim(context, targetPath)]
  const oldStringValue = firstArgument(args, ['old_string', 'oldString', 'old_text', 'oldText'])
  if (typeof oldStringValue !== 'string' || oldStringValue.length === 0) return fallback

  const baseline = await readTextBaseline(dependencies, targetPath)
  if (!baseline) return fallback
  const matches = allOccurrences(baseline.text, oldStringValue)
  const replaceAll = args.replace_all === true || args.replaceAll === true
  if (matches.length === 0 || (!replaceAll && matches.length !== 1)) return fallback

  const selectedMatches = replaceAll ? matches : matches.slice(0, 1)
  return uniqueClaims(
    selectedMatches.map((startOffset) => {
      const hunk = replacementHunk(baseline.text, startOffset, oldStringValue)
      return hunkClaim(context, targetPath, { baseline: baseline.baseline, ...hunk })
    })
  )
}

async function assertExactPathMutation(
  dependencies: WorkspaceMutationClaimDependencies,
  targetPath: string,
  operation: string,
  options: { allowEmptyDirectory?: boolean } = {}
): Promise<void> {
  try {
    const stat = await dependencies.lstat(targetPath)
    if (stat.isDirectory() && !options.allowEmptyDirectory) {
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        `${operation} cannot mutate a directory under exact file/hunk locking.`
      )
    }
  } catch (error) {
    if (error instanceof WorkspaceMutationClaimDerivationError) throw error
    // Missing destinations are exact planned paths. Executor validation owns
    // every other filesystem error and runs inside the acquired transaction.
  }
}

async function deriveDeleteClaims(
  context: ClaimContext,
  args: Record<string, unknown>,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const targetPath = resolveTargetPath(
    context,
    firstArgument(args, ['path', 'file_path', 'filePath']),
    'delete path'
  )
  // delete_path only removes empty directories. Treating that directory entry
  // as one exact path is safe: a concurrent child creation makes rmdir fail
  // rather than deleting data.
  await assertExactPathMutation(dependencies, targetPath, 'delete_path', {
    allowEmptyDirectory: true
  })
  return [pathClaim(context, targetPath)]
}

async function deriveMoveClaims(
  context: ClaimContext,
  args: Record<string, unknown>,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const sourcePath = resolveTargetPath(
    context,
    firstArgument(args, ['from', 'source', 'sourcePath', 'old_path', 'oldPath']),
    'move source'
  )
  const destinationPath = resolveTargetPath(
    context,
    firstArgument(args, ['to', 'destination', 'destinationPath', 'new_path', 'newPath']),
    'move destination'
  )
  await Promise.all([
    assertExactPathMutation(dependencies, sourcePath, 'move_path'),
    assertExactPathMutation(dependencies, destinationPath, 'move_path', {
      allowEmptyDirectory: true
    })
  ])
  const createdParentClaims =
    args.createParents === true
      ? await missingDirectoryEntryClaims(context, dirname(destinationPath), dependencies)
      : []
  return uniqueClaims([
    pathClaim(context, sourcePath),
    pathClaim(context, destinationPath),
    ...createdParentClaims
  ])
}

async function deriveRenameClaims(
  context: ClaimContext,
  args: Record<string, unknown>,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const sourcePath = resolveTargetPath(
    context,
    firstArgument(args, ['path', 'source', 'sourcePath', 'old_path', 'oldPath']),
    'rename source'
  )
  const newName = requireNonEmptyString(
    firstArgument(args, ['newName', 'new_name', 'name']),
    'rename newName'
  )
  if (newName === '.' || newName === '..' || basename(newName) !== newName) {
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      'rename newName must be a basename, not a path.'
    )
  }
  const destinationPath = resolveTargetPath(
    context,
    resolve(dirname(sourcePath), newName),
    'rename destination'
  )
  await Promise.all([
    assertExactPathMutation(dependencies, sourcePath, 'rename_path'),
    assertExactPathMutation(dependencies, destinationPath, 'rename_path', {
      allowEmptyDirectory: true
    })
  ])
  return uniqueClaims([pathClaim(context, sourcePath), pathClaim(context, destinationPath)])
}

function patchPath(rawValue: string): string | null | undefined {
  const value = rawValue.split('\t')[0]
  if (value === '/dev/null') return null
  if (!value.trim() || value.startsWith('"') || value.endsWith('"')) return undefined
  return value.replace(/^[ab]\//, '')
}

function beginPatchFile(oldPath?: string | null, newPath?: string | null): ParsedPatchFile {
  return { oldPath, newPath, hunks: [], invalid: false, binary: false }
}

function parseUnifiedPatch(patch: string): ParsedPatch {
  if (
    !patch.trim() ||
    /^\*\*\*\s*(?:Begin Patch|Update File|Add File|Delete File|End Patch)/m.test(patch)
  ) {
    return { files: [], invalid: true }
  }

  const files: ParsedPatchFile[] = []
  let current: ParsedPatchFile | null = null
  let invalid = false
  let activeHunk: { oldRemaining: number; newRemaining: number } | null = null

  const finishCurrent = (): void => {
    if (!current) return
    if (activeHunk && (activeHunk.oldRemaining !== 0 || activeHunk.newRemaining !== 0)) {
      current.invalid = true
    }
    files.push(current)
    current = null
    activeHunk = null
  }

  for (const line of patch.split(/\r?\n/)) {
    if (activeHunk) {
      if (line.startsWith('\\')) continue
      const prefix = line[0]
      if (prefix === ' ') {
        activeHunk.oldRemaining -= 1
        activeHunk.newRemaining -= 1
      } else if (prefix === '-') {
        activeHunk.oldRemaining -= 1
      } else if (prefix === '+') {
        activeHunk.newRemaining -= 1
      } else {
        if (current) current.invalid = true
        activeHunk = null
      }
      if (activeHunk) {
        if (activeHunk.oldRemaining < 0 || activeHunk.newRemaining < 0) {
          if (current) current.invalid = true
          activeHunk = null
        } else if (activeHunk.oldRemaining === 0 && activeHunk.newRemaining === 0) {
          activeHunk = null
        }
        continue
      }
    }

    if (line.startsWith('diff --git ')) {
      finishCurrent()
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      if (!match) {
        invalid = true
        continue
      }
      current = beginPatchFile(patchPath(`a/${match[1]}`), patchPath(`b/${match[2]}`))
      if (current.oldPath === undefined || current.newPath === undefined) current.invalid = true
      continue
    }

    if (line.startsWith('--- ')) {
      if (!current) current = beginPatchFile()
      else if (current.hunks.length > 0) {
        finishCurrent()
        current = beginPatchFile()
      }
      current.oldPath = patchPath(line.slice(4))
      if (current.oldPath === undefined) current.invalid = true
      continue
    }

    if (line.startsWith('+++ ')) {
      if (!current) current = beginPatchFile()
      current.newPath = patchPath(line.slice(4))
      if (current.newPath === undefined) current.invalid = true
      continue
    }

    if (line.startsWith('rename from ')) {
      if (!current) current = beginPatchFile()
      current.oldPath = patchPath(line.slice('rename from '.length))
      if (current.oldPath === undefined) current.invalid = true
      continue
    }

    if (line.startsWith('rename to ')) {
      if (!current) current = beginPatchFile()
      current.newPath = patchPath(line.slice('rename to '.length))
      if (current.newPath === undefined) current.invalid = true
      continue
    }

    if (line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line)) {
      if (!current) invalid = true
      else current.binary = true
      continue
    }

    if (line.startsWith('@@')) {
      if (!current) {
        invalid = true
        continue
      }
      const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
      if (!match) {
        current.invalid = true
        continue
      }
      const oldStart = Number(match[1])
      const oldCount = match[2] === undefined ? 1 : Number(match[2])
      const newCount = match[4] === undefined ? 1 : Number(match[4])
      if (
        !Number.isSafeInteger(oldStart) ||
        !Number.isSafeInteger(oldCount) ||
        !Number.isSafeInteger(newCount) ||
        oldCount < 0 ||
        newCount < 0 ||
        (oldStart === 0 && oldCount !== 0)
      ) {
        current.invalid = true
        continue
      }
      const startLine = oldCount === 0 ? oldStart : oldStart - 1
      current.hunks.push({ startLine, endLine: startLine + oldCount })
      if (oldCount !== 0 || newCount !== 0) {
        activeHunk = { oldRemaining: oldCount, newRemaining: newCount }
      }
    }
  }

  finishCurrent()
  if (files.length === 0) invalid = true
  return { files, invalid }
}

async function derivePatchClaims(
  context: ClaimContext,
  args: Record<string, unknown>,
  dependencies: WorkspaceMutationClaimDependencies
): Promise<WorkspaceLockClaimRequest[]> {
  const patchValue = firstArgument(args, ['patch', 'diff'])
  if (typeof patchValue !== 'string') {
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      'apply_patch requires a complete unified diff before an edit scope can be acquired.'
    )
  }
  const parsed = parseUnifiedPatch(patchValue)
  if (parsed.invalid) {
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      'apply_patch must be a valid unified diff before an edit scope can be acquired.'
    )
  }

  const claims: WorkspaceLockClaimRequest[] = []
  for (const file of parsed.files) {
    const rawPaths = [file.oldPath, file.newPath].filter(
      (value): value is string => typeof value === 'string'
    )
    if (rawPaths.length === 0) {
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        'apply_patch contains a file entry without an exact path.'
      )
    }
    const targetPaths = rawPaths.map((path) => resolveTargetPath(context, path, 'patch path'))
    const createdDestinationPaths =
      typeof file.newPath === 'string' && file.newPath !== file.oldPath
        ? await missingDirectoryEntryClaims(
            context,
            dirname(resolveTargetPath(context, file.newPath, 'patch destination path')),
            dependencies
          )
        : []
    // Unified patches can be applied with offset/fuzz semantics by the
    // executor, so the header's old-side line range is not proof of the
    // coordinates that will actually change. Keep exact-string `replace`
    // eligible for hunk concurrency, but serialize every path named by
    // `apply_patch` at whole-file scope. A new or renamed destination may also
    // create parent directory entries, so include those exact entries in the
    // same atomic proposal.
    claims.push(
      ...createdDestinationPaths,
      ...targetPaths.map((targetPath) => pathClaim(context, targetPath))
    )
  }
  return uniqueClaims(claims)
}

function isDeclaredPatchDryRun(
  action: ResolvedProviderAction,
  args: Record<string, unknown>
): boolean {
  return (
    action.catalogTool === 'apply_patch' &&
    (args.dryRun === true || args.check === true || args.preview === true)
  )
}

const HOST_ASSET_MEDIA_TOOLS = new Set([
  'video_encode_clip',
  'video_concat_clips',
  'audio_extract',
  'transcode_audio',
  'audio_mix',
  'transcode_video'
])

/**
 * Convert one already-authorized canonical MCP/native action into the complete
 * atomic set of write claims required before dispatch.
 *
 * Unknown actions fail explicitly through the strict taxonomy resolver.
 * Checkout paths are lexically contained here; the lock authority performs
 * the final filesystem-aware canonicalization and symlink/worktree identity
 * checks when it acquires the returned set.
 */
export async function deriveWorkspaceMutationClaims(
  input: WorkspaceMutationCall,
  dependencies: WorkspaceMutationClaimDependencies = NODE_WORKSPACE_MUTATION_CLAIM_DEPENDENCIES
): Promise<WorkspaceLockClaimRequest[]> {
  const action = resolveStrictAction(input)
  const args = normalizedCallArgs(input.args)
  if (
    input.executionMode === 'dry-run' ||
    isDeclaredPatchDryRun(action, args) ||
    action.metadata.mutation === 'none'
  ) {
    return []
  }

  const lock = action.metadata.lock
  if (
    lock === 'none' ||
    lock === 'host-resource' ||
    lock === 'external-resource' ||
    lock === 'application-resource'
  ) {
    return []
  }

  const context = claimContext(input)
  if (lock === 'workspace-repository') {
    // Git staging and commit share one exact metadata mutex per effective
    // checkout. It serializes repository metadata without excluding unrelated
    // file edits or reads for the lifetime of a participant run.
    return [pathClaim(context, resolve(context.worktreePath, '.git'))]
  }

  if (lock === 'workspace-runtime') {
    if (
      action.metadata.operation === 'workspace.read' ||
      action.metadata.operation === 'media.read'
    ) {
      return []
    }
    if (action.catalogTool === 'run_shell_command') {
      const command = firstArgument(args, [
        'command',
        'cmd',
        'CommandLine',
        'commandLine',
        'script',
        'input'
      ])
      if (
        command !== undefined &&
        (isPromptFreeReadOnlyShellCommand(command) ||
          (typeof command === 'string' && isReadOnlyShellCommand(command)))
      ) {
        return []
      }
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        'run_shell_command has opaque process side effects, so caller-declared paths cannot prove an exact file/hunk mutation scope. Use exact TaskWraith file tools or request one explicitly approved, auditable host execution.'
      )
    }
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      `${action.catalogTool} cannot prove an exact file/hunk mutation scope; use exact TaskWraith file tools or a read-only command.`
    )
  }

  if (lock !== 'workspace-paths') {
    throw new WorkspaceMutationClaimDerivationError(
      'invalid-call',
      `Unsupported workspace lock semantics for ${action.catalogTool}: ${lock}.`
    )
  }

  switch (action.catalogTool) {
    case 'write_file': {
      const targetPath = resolveTargetPath(
        context,
        firstArgument(args, ['path', 'file_path', 'filePath']),
        'write path'
      )
      // Claim only directory entries this call may create, stopping at the
      // nearest existing ancestor, plus the exact file leaf. Existing
      // parents and the workspace root are never reserved.
      return uniqueClaims([
        ...(await missingDirectoryEntryClaims(context, dirname(targetPath), dependencies)),
        pathClaim(context, targetPath)
      ])
    }
    case 'replace':
      return promoteNativeHunkClaims(
        input,
        context,
        await deriveReplaceClaims(context, args, dependencies)
      )
    case 'create_directory': {
      const targetPath = resolveTargetPath(
        context,
        firstArgument(args, ['path', 'directory']),
        'directory path'
      )
      const parentClaims =
        args.recursive === false
          ? []
          : await missingDirectoryEntryClaims(context, dirname(targetPath), dependencies)
      return uniqueClaims([...parentClaims, pathClaim(context, targetPath)])
    }
    case 'delete_path':
      return deriveDeleteClaims(context, args, dependencies)
    case 'move_path':
      return deriveMoveClaims(context, args, dependencies)
    case 'rename_path':
      return deriveRenameClaims(context, args, dependencies)
    case 'apply_patch':
      return promoteNativeHunkClaims(
        input,
        context,
        await derivePatchClaims(context, args, dependencies)
      )
    default:
      if (HOST_ASSET_MEDIA_TOOLS.has(action.catalogTool)) {
        // These tools read workspace inputs but write only TaskWraith-owned
        // staging/asset-store files, so there is no workspace mutation to lock.
        return []
      }
      throw new WorkspaceMutationClaimDerivationError(
        'invalid-call',
        `${action.catalogTool} has no exact file/hunk claim derivation.`
      )
  }
}
