import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  gitCommandEnvironment,
  hardenedGitCommandArgs,
  LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS,
  isSafeGitRemoteName,
  repositoryLocalGitFilterError,
  repositoryLocalGitFilterKeys
} from './services/GitCommandSecurity'
import type {
  DiffFileSummary,
  DiffFileStatus,
  DiffPreviewKind,
  WorkspaceSnapshot,
  RunDiffResult,
  FileSnapshot
} from './store/types'
import {
  parseNumstatByPath,
  type WorkspaceChurnFileStat,
  type WorkspaceChurnSample
} from './WorkspaceChurn'

const NOISE_PATHS = ['.DS_Store', 'Thumbs.db', 'node_modules', 'dist', 'build', '.vite']
const SENSITIVE_PATTERNS = [/\.env$/i, /\.pem$/i, /\.key$/i, /secret/i, /password/i, /token/i]
const MAX_PREVIEW_SIZE = 1024 * 100 // 100KB
const MAX_GIT_DIFF_PREVIEW_BYTES = 256 * 1024
const MAX_GIT_DIFF_PREVIEW_LINES = 5000
const MAX_GIT_DIFF_PREVIEW_LINE_CHARS = 1200
const GIT_DIFF_PREVIEW_CONTEXT_LINES = 8
const GIT_DIFF_PREVIEW_MAX_BUFFER = MAX_GIT_DIFF_PREVIEW_BYTES + 64 * 1024
const COMMIT_FILE_PREVIEW_MAX_FILES = 30
const REVISION_DIFF_MAX_FILES = 120

function isNoiseFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  return NOISE_PATHS.some((n) => basename === n || filePath.includes(`/${n}/`))
}

function isSensitiveFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return SENSITIVE_PATTERNS.some((p) => p.test(lower))
}

function isBinaryFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath)
    for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return true
  }
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const rel = path.relative(basePath, candidatePath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveWorkspacePath(workspace: string, filePath: string): string | null {
  const workspaceRoot = path.resolve(workspace)
  const resolved = path.resolve(workspaceRoot, filePath)
  if (!isPathInside(workspaceRoot, resolved)) return null
  if (!fs.existsSync(resolved)) return resolved
  try {
    const realWorkspace = fs.realpathSync.native(workspaceRoot)
    const realFile = fs.realpathSync.native(resolved)
    if (!isPathInside(realWorkspace, realFile)) return null
  } catch {
    return null
  }
  return resolved
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

type SpawnGitResult = { stdout: string; stderr: string; code: number; truncated?: boolean }

function gitCommandMayApplyRepositoryFilters(args: readonly string[]): boolean {
  return args[0] === 'status' || args[0] === 'diff'
}

function repositoryLocalFilterFailure(result: SpawnGitResult): string | null {
  if (result.code === 1 && !result.stdout.trim()) return null
  if (result.code !== 0) {
    return (
      result.stderr.trim() ||
      result.stdout.trim() ||
      'Repository-local Git filter configuration could not be inspected safely.'
    )
  }
  const keys = repositoryLocalGitFilterKeys(result.stdout)
  return keys.length > 0 ? repositoryLocalGitFilterError(keys) : null
}

async function spawnGitRaw(
  cwd: string,
  args: readonly string[]
): Promise<SpawnGitResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', hardenedGitCommandArgs('git', args), {
      cwd,
      shell: false,
      env: gitCommandEnvironment('git', undefined)
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 })
    })
    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: -1 })
    })
  })
}

async function spawnGit(cwd: string, args: readonly string[]): Promise<SpawnGitResult> {
  if (gitCommandMayApplyRepositoryFilters(args)) {
    const filterCheck = await spawnGitRaw(cwd, LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS)
    const filterFailure = repositoryLocalFilterFailure(filterCheck)
    if (filterFailure) return { stdout: '', stderr: filterFailure, code: -1 }
  }
  return spawnGitRaw(cwd, args)
}

function spawnGitSyncRaw(
  cwd: string,
  args: readonly string[],
  options: { maxBuffer?: number } = {}
): SpawnGitResult {
  const result = spawnSync('git', hardenedGitCommandArgs('git', args), {
    cwd,
    shell: false,
    encoding: 'utf-8',
    env: gitCommandEnvironment('git', undefined),
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {})
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status ?? 0,
    truncated:
      Boolean(result.error && 'code' in result.error && result.error.code === 'ENOBUFS') ||
      (options.maxBuffer !== undefined && (result.stdout || '').length >= options.maxBuffer)
  }
}

function spawnGitSync(
  cwd: string,
  args: readonly string[],
  options: { maxBuffer?: number } = {}
): SpawnGitResult {
  if (gitCommandMayApplyRepositoryFilters(args)) {
    const filterCheck = spawnGitSyncRaw(cwd, LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS)
    const filterFailure = repositoryLocalFilterFailure(filterCheck)
    if (filterFailure) return { stdout: '', stderr: filterFailure, code: -1 }
  }
  return spawnGitSyncRaw(cwd, args, options)
}

async function resolveGitWorkspaceScope(
  workspace: string
): Promise<{ workspaceRoot: string; repoRoot: string; workspacePrefix: string } | null> {
  const workspaceRoot = fs.realpathSync.native(path.resolve(workspace))
  const repoResult = await spawnGit(workspaceRoot, ['rev-parse', '--show-toplevel'])
  if (repoResult.code !== 0) return null
  const repoRoot = fs.realpathSync.native(path.resolve(repoResult.stdout.trim()))
  const relativePrefix = path.relative(repoRoot, workspaceRoot)
  if (
    relativePrefix === '..' ||
    relativePrefix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePrefix)
  ) {
    return null
  }
  return {
    workspaceRoot,
    repoRoot,
    workspacePrefix: relativePrefix ? toGitPath(relativePrefix) : ''
  }
}

function workspacePathspec(workspacePrefix: string): string[] {
  return workspacePrefix ? ['--', workspacePrefix] : []
}

export interface CommitFilePreviewEntry {
  path: string
  additions?: number
  deletions?: number
}

export type CommitFilePreviewResult =
  | { ok: true; files: CommitFilePreviewEntry[]; totalFiles: number }
  | { ok: false; error: string }

export type GitRevisionDiffTarget =
  | { kind: 'commit'; commitHash: string }
  | {
      kind: 'pull-request'
      headHash: string
      baseRefName: string
      remoteName?: string
    }

export interface GitRevisionDiffResult {
  type: 'changes' | 'no_changes' | 'not_repo' | 'error'
  text?: string
  summaries?: DiffFileSummary[]
  totalFiles?: number
  truncated?: boolean
  resolvedHeadHash?: string
  resolvedBaseHash?: string
}

/**
 * Resolve a bounded, read-only file list for a historical commit. Task Complete
 * tombstones created before per-file receipt capture only retain the hash, so
 * the renderer uses this path lazily on hover instead of inflating every stored
 * close-out message. The hash is deliberately restricted to a Git object id;
 * argv remains separated and the workspace pathspec prevents ancestor-repo
 * widening for workspaces registered below the repository root.
 */
export async function getCommitFilePreview(
  workspace: string,
  commitHash: string
): Promise<CommitFilePreviewResult> {
  const hash = commitHash.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return { ok: false, error: 'Commit hash must be a 7–40 character hexadecimal object id.' }
  }

  try {
    const scope = await resolveGitWorkspaceScope(workspace)
    if (!scope) return { ok: false, error: 'This workspace is not a Git repository.' }
    const result = await spawnGit(scope.repoRoot, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--numstat',
      '--no-renames',
      '-r',
      '-z',
      hash,
      ...workspacePathspec(scope.workspacePrefix)
    ])
    if (result.code !== 0) {
      return {
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || 'Commit files could not be read.'
      }
    }

    const files: CommitFilePreviewEntry[] = []
    let totalFiles = 0
    for (const record of result.stdout.split('\0')) {
      if (!record) continue
      const [rawAdditions, rawDeletions, ...pathParts] = record.split('\t')
      const repoPath = pathParts.join('\t')
      if (!repoPath) continue
      const workspacePath = repoPathToWorkspacePath(repoPath, scope.workspacePrefix)
      if (workspacePath === null || !workspacePath) continue
      totalFiles += 1
      if (files.length >= COMMIT_FILE_PREVIEW_MAX_FILES) continue
      const additions = Number(rawAdditions)
      const deletions = Number(rawDeletions)
      files.push({
        path: workspacePath,
        ...(Number.isFinite(additions) ? { additions } : {}),
        ...(Number.isFinite(deletions) ? { deletions } : {})
      })
    }
    return { ok: true, files, totalFiles }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function validGitObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value)
}

function validGitBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 244 &&
    !value.startsWith('-') &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    !value.endsWith('/') &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !/[\0-\x20\x7f~^:?*[\\]/.test(value) &&
    value
      .split('/')
      .every((part) => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'))
  )
}

async function resolveCommitObject(repoRoot: string, value: string): Promise<string | null> {
  const candidate = value.trim()
  if (!validGitObjectId(candidate)) return null
  const result = await spawnGit(repoRoot, ['rev-parse', '--verify', `${candidate}^{commit}`])
  const resolved = result.stdout.trim()
  return result.code === 0 && /^[0-9a-f]{40,64}$/i.test(resolved) ? resolved : null
}

async function resolvePullRequestBase(
  repoRoot: string,
  baseRefName: string,
  remoteName?: string
): Promise<string | null> {
  const branch = baseRefName.trim()
  if (!validGitBranchName(branch)) return null
  const remote = remoteName?.trim()
  if (remote && !isSafeGitRemoteName(remote)) return null
  const candidates = [
    `refs/remotes/${remote || 'origin'}/${branch}`,
    `refs/heads/${branch}`
  ]
  for (const candidate of candidates) {
    const result = await spawnGit(repoRoot, ['rev-parse', '--verify', `${candidate}^{commit}`])
    const resolved = result.stdout.trim()
    if (result.code === 0 && /^[0-9a-f]{40,64}$/i.test(resolved)) return resolved
  }
  return null
}

function parseGitNameStatusZ(
  output: string
): Array<{ statusCode: string; repoPath: string }> {
  const parts = output.split('\0')
  const files: Array<{ statusCode: string; repoPath: string }> = []
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab >= 0) {
      const statusCode = record.slice(0, tab)
      const repoPath = record.slice(tab + 1)
      if (statusCode && repoPath) files.push({ statusCode, repoPath })
      continue
    }
    const repoPath = parts[index + 1]
    if (repoPath) {
      files.push({ statusCode: record, repoPath })
      index += 1
    }
  }
  return files
}

function buildRevisionFileSummary(
  repoRoot: string,
  repoPath: string,
  displayPath: string,
  statusCode: string,
  diffArgs: string[]
): DiffFileSummary {
  const status = classifyStatus(statusCode)
  const baseSummary: DiffFileSummary = {
    path: displayPath,
    status,
    previewKind: 'none',
    isNoise: isNoiseFile(displayPath),
    isSensitive: isSensitiveFile(displayPath)
  }
  if (baseSummary.isSensitive) return { ...baseSummary, previewKind: 'hidden' }

  const preview = readGitDiffPreview(repoRoot, [...diffArgs, '--', repoPath])
  if (!preview.text.trim()) return baseSummary
  if (/^Binary files /m.test(preview.text) || /^GIT binary patch$/m.test(preview.text)) {
    return { ...baseSummary, previewKind: 'binary', isBinary: true }
  }
  const counts = countDiffLines(preview.text)
  return {
    ...baseSummary,
    ...counts,
    previewKind: 'git_diff',
    diffText: preview.text,
    diffTextTruncated: preview.truncated || undefined,
    diffTextOmittedLines: preview.omittedLines,
    ...(!preview.truncated
      ? { diffTextOriginalBytes: Buffer.byteLength(preview.text, 'utf8') }
      : {})
  }
}

/**
 * Load a bounded, read-only historical diff for Diff Studio. Commit reviews
 * compare against the first parent (or the empty tree for a root commit). PR
 * reviews prefer the named remote base over the local branch, because the
 * checkout branch commonly contains the very commits being proposed.
 */
export async function getGitRevisionDiff(
  workspace: string,
  target: GitRevisionDiffTarget
): Promise<GitRevisionDiffResult> {
  if (target.kind === 'commit' && !validGitObjectId(target.commitHash.trim())) {
    return { type: 'error', text: 'Commit hash must be a hexadecimal object id.' }
  }
  if (
    target.kind === 'pull-request' &&
    (!validGitObjectId(target.headHash.trim()) ||
      !validGitBranchName(target.baseRefName.trim()) ||
      (target.remoteName !== undefined && !isSafeGitRemoteName(target.remoteName.trim())))
  ) {
    return { type: 'error', text: 'Pull request revision identifiers are invalid.' }
  }

  try {
    const scope = await resolveGitWorkspaceScope(workspace)
    if (!scope) {
      return {
        type: 'not_repo',
        text: 'This folder is not a git repository. Run git init if you want diff tracking.'
      }
    }

    const requestedHead = target.kind === 'commit' ? target.commitHash : target.headHash
    const headHash = await resolveCommitObject(scope.repoRoot, requestedHead)
    if (!headHash) return { type: 'error', text: 'The selected revision is not available locally.' }

    let baseHash: string | undefined
    let rootCommit = false
    if (target.kind === 'commit') {
      const parents = await spawnGit(scope.repoRoot, ['rev-list', '--parents', '-n', '1', headHash])
      if (parents.code !== 0) {
        return { type: 'error', text: parents.stderr.trim() || 'The commit parent could not be read.' }
      }
      baseHash = parents.stdout.trim().split(/\s+/)[1]
      rootCommit = !baseHash
    } else {
      const branchBase = await resolvePullRequestBase(
        scope.repoRoot,
        target.baseRefName,
        target.remoteName
      )
      if (!branchBase) {
        return { type: 'error', text: 'The pull request base branch is not available locally.' }
      }
      const mergeBase = await spawnGit(scope.repoRoot, ['merge-base', branchBase, headHash])
      const resolved = mergeBase.stdout.trim()
      if (mergeBase.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(resolved)) {
        return { type: 'error', text: 'The pull request merge base could not be resolved.' }
      }
      baseHash = resolved
    }

    const pathspec = workspacePathspec(scope.workspacePrefix)
    const listArgs = rootCommit
      ? [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '--no-renames',
          '-r',
          '-z',
          headHash,
          ...pathspec
        ]
      : ['diff', '--name-status', '--no-renames', '-z', baseHash!, headHash, ...pathspec]
    const listed = await spawnGit(scope.repoRoot, listArgs)
    if (listed.code !== 0) {
      return {
        type: 'error',
        text: listed.stderr.trim() || listed.stdout.trim() || 'The revision diff could not be read.'
      }
    }

    const files = parseGitNameStatusZ(listed.stdout).flatMap((file) => {
      const displayPath = repoPathToWorkspacePath(file.repoPath, scope.workspacePrefix)
      return displayPath ? [{ ...file, displayPath }] : []
    })
    if (files.length === 0) {
      return {
        type: 'no_changes',
        text: 'The selected revision has no changes in this workspace.',
        totalFiles: 0,
        resolvedHeadHash: headHash,
        ...(baseHash ? { resolvedBaseHash: baseHash } : {})
      }
    }

    const diffArgs = rootCommit
      ? [
          'show',
          '--format=',
          '--first-parent',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${GIT_DIFF_PREVIEW_CONTEXT_LINES}`,
          headHash
        ]
      : [
          'diff',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          `--unified=${GIT_DIFF_PREVIEW_CONTEXT_LINES}`,
          baseHash!,
          headHash
        ]
    const summaries = files
      .slice(0, REVISION_DIFF_MAX_FILES)
      .map((file) =>
        buildRevisionFileSummary(
          scope.repoRoot,
          file.repoPath,
          file.displayPath,
          file.statusCode,
          diffArgs
        )
      )
    return {
      type: 'changes',
      summaries,
      totalFiles: files.length,
      truncated: files.length > summaries.length || undefined,
      resolvedHeadHash: headHash,
      ...(baseHash ? { resolvedBaseHash: baseHash } : {})
    }
  } catch (error) {
    return { type: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

function repoPathToWorkspacePath(repoPath: string, workspacePrefix: string): string | null {
  if (!workspacePrefix) return repoPath
  if (repoPath === workspacePrefix) return ''
  const prefix = `${workspacePrefix}/`
  if (!repoPath.startsWith(prefix)) return null
  return repoPath.slice(prefix.length)
}

function countDiffLines(diffText: string): { additions?: number; deletions?: number } {
  if (!diffText.trim()) return {}
  let additions = 0
  let deletions = 0
  let index = 0
  while (index <= diffText.length) {
    const nextBreak = diffText.indexOf('\n', index)
    const lineEnd = nextBreak === -1 ? diffText.length : nextBreak
    const line = diffText.slice(index, lineEnd)
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    if (nextBreak === -1) break
    index = nextBreak + 1
  }
  return { additions, deletions }
}

function parseNumstat(stdout: string): { additions?: number; deletions?: number } {
  let additions = 0
  let deletions = 0
  let sawTextStats = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [rawAdditions, rawDeletions] = line.split(/\s+/, 2)
    const nextAdditions = Number(rawAdditions)
    const nextDeletions = Number(rawDeletions)
    if (!Number.isFinite(nextAdditions) || !Number.isFinite(nextDeletions)) continue
    additions += nextAdditions
    deletions += nextDeletions
    sawTextStats = true
  }
  return sawTextStats ? { additions, deletions } : {}
}

function countGitFileDiffLines(
  gitCwd: string,
  gitPath: string
): { additions?: number; deletions?: number } {
  const unstaged = parseNumstat(
    spawnGitSync(gitCwd, [
      'diff',
      '--numstat',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      gitPath
    ]).stdout
  )
  const staged = parseNumstat(
    spawnGitSync(gitCwd, [
      'diff',
      '--cached',
      '--numstat',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      gitPath
    ]).stdout
  )
  const additions =
    unstaged.additions !== undefined || staged.additions !== undefined
      ? (unstaged.additions ?? 0) + (staged.additions ?? 0)
      : undefined
  const deletions =
    unstaged.deletions !== undefined || staged.deletions !== undefined
      ? (unstaged.deletions ?? 0) + (staged.deletions ?? 0)
      : undefined
  return { additions, deletions }
}

function capDiffPreviewText(text: string): {
  text: string
  truncated: boolean
  omittedLines?: number
} {
  if (!text) return { text, truncated: false }
  const output: string[] = []
  let omittedLines = 0
  let truncated = false
  let usedBytes = 0
  let index = 0

  while (index <= text.length) {
    const nextBreak = text.indexOf('\n', index)
    const lineEnd = nextBreak === -1 ? text.length : nextBreak
    const rawLine = text.slice(index, lineEnd)
    const clippedLine =
      rawLine.length > MAX_GIT_DIFF_PREVIEW_LINE_CHARS
        ? rawLine.slice(0, MAX_GIT_DIFF_PREVIEW_LINE_CHARS)
        : rawLine
    if (clippedLine.length < rawLine.length) truncated = true
    const nextBytes = Buffer.byteLength(clippedLine, 'utf8') + 1
    if (
      output.length >= MAX_GIT_DIFF_PREVIEW_LINES ||
      usedBytes + nextBytes > MAX_GIT_DIFF_PREVIEW_BYTES
    ) {
      truncated = true
      omittedLines += 1
    } else {
      output.push(clippedLine)
      usedBytes += nextBytes
    }
    if (nextBreak === -1) break
    index = nextBreak + 1
  }

  if (omittedLines === 0) return { text: output.join('\n'), truncated }
  return { text: output.join('\n'), truncated, omittedLines }
}

function readGitDiffPreview(
  gitCwd: string,
  args: string[]
): { text: string; truncated: boolean; omittedLines?: number } {
  const result = spawnGitSync(gitCwd, args, { maxBuffer: GIT_DIFF_PREVIEW_MAX_BUFFER })
  const capped = capDiffPreviewText(result.stdout)
  return {
    text: capped.text,
    truncated: Boolean(result.truncated || capped.truncated),
    omittedLines: capped.omittedLines
  }
}

export function parseGitStatusZ(
  statusOutput: string
): Array<{ statusCode: string; filePath: string; staged: boolean; unstaged: boolean }> {
  const entries: Array<{
    statusCode: string
    filePath: string
    staged: boolean
    unstaged: boolean
  }> = []
  const parts = statusOutput.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry || entry.length < 3) {
      i++
      continue
    }
    const rawStatusCode = entry.substring(0, 2)
    const index = rawStatusCode[0] || ' '
    const workingTree = rawStatusCode[1] || ' '
    const filePath = entry.substring(3)
    // For renames, porcelain v1 -z emits the current path, then the original path.
    if (rawStatusCode.startsWith('R') && i + 1 < parts.length) {
      i += 2
    } else {
      i++
    }
    entries.push({
      statusCode: rawStatusCode.trim(),
      filePath,
      staged: index !== ' ' && index !== '?' && index !== '!',
      unstaged: workingTree !== ' ' || index === '?' || index === '!'
    })
  }
  return entries
}

export function classifyStatus(statusCode: string): DiffFileStatus {
  if (statusCode === '??') return 'untracked'
  if (statusCode === '!!') return 'noise'
  if (statusCode === 'A') return 'created'
  if (statusCode === 'D') return 'deleted'
  if (statusCode.startsWith('R')) return 'renamed'
  if (statusCode.startsWith('M') || statusCode.endsWith('M')) return 'modified'
  return 'modified'
}

export function generateSyntheticNewFileDiff(filePath: string, content: string): string {
  const lines = content.split('\n')
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@`
  const body = lines.map((l) => '+' + l).join('\n')
  return header + '\n' + body
}

function buildCurrentFileSummary(
  workspace: string | undefined,
  repoRoot: string | undefined,
  repoPath: string,
  displayPath: string,
  status: DiffFileStatus,
  stageState?: Pick<DiffFileSummary, 'staged' | 'unstaged'>,
  /**
   * Per-path churn already read in ONE `diff --numstat HEAD` for the whole
   * workspace. When it carries this file, the two per-file subprocesses below
   * are skipped. Omitted by single-file callers, where batching buys nothing.
   */
  churnByPath?: Readonly<Record<string, WorkspaceChurnFileStat>>
): DiffFileSummary {
  const baseSummary: DiffFileSummary = {
    path: displayPath,
    status,
    previewKind: 'none',
    isNoise: isNoiseFile(displayPath),
    isSensitive: isSensitiveFile(displayPath),
    ...(stageState?.staged !== undefined ? { staged: stageState.staged } : {}),
    ...(stageState?.unstaged !== undefined ? { unstaged: stageState.unstaged } : {})
  }

  if (!workspace) {
    return baseSummary
  }

  const fullPath = resolveWorkspacePath(workspace, displayPath)
  if (!fullPath) {
    return baseSummary
  }

  const exists = fs.existsSync(fullPath)
  const sizeBytes = exists ? fs.statSync(fullPath).size : 0
  let previewKind: DiffPreviewKind = 'none'
  let diffText: string | undefined
  let diffTextTruncated: boolean | undefined
  let diffTextOmittedLines: number | undefined
  let diffTextOriginalBytes: number | undefined
  let isBinary = false
  let additions: number | undefined
  let deletions: number | undefined

  if (baseSummary.isSensitive) {
    previewKind = 'hidden'
  } else if (
    (status === 'created' || status === 'untracked') &&
    exists &&
    !fs.statSync(fullPath).isDirectory()
  ) {
    isBinary = isBinaryFile(fullPath)
    if (isBinary) {
      previewKind = 'binary'
    } else if (sizeBytes <= MAX_PREVIEW_SIZE) {
      const content = fs.readFileSync(fullPath, 'utf-8')
      diffText = generateSyntheticNewFileDiff(displayPath, content)
      previewKind = 'synthetic_new_file'
      additions = content.split('\n').length
      deletions = 0
    }
  } else if (status === 'modified' || status === 'deleted' || status === 'renamed') {
    const gitCwd = repoRoot || workspace
    const gitPath = repoRoot ? repoPath : displayPath
    // `diff HEAD` collapses index and worktree into one number, which is
    // exactly the sum `countGitFileDiffLines` builds from its two subprocesses
    // — so a batched hit is the same answer for two fewer spawns. A path the
    // batch does not carry falls back to the pair rather than guessing zero:
    // renames key the NEW path, git quotes paths with special or non-ASCII
    // characters, and an unborn HEAD yields no batch at all. Slower, never wrong.
    const batchedChurn = churnByPath?.[gitPath]
    const exactCounts = batchedChurn
      ? batchedChurn.binary
        ? { additions: undefined, deletions: undefined }
        : { additions: batchedChurn.additions, deletions: batchedChurn.deletions }
      : countGitFileDiffLines(gitCwd, gitPath)
    additions = exactCounts.additions
    deletions = exactCounts.deletions
    const unstagedDiff = readGitDiffPreview(gitCwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      `--unified=${GIT_DIFF_PREVIEW_CONTEXT_LINES}`,
      '--',
      gitPath
    ])
    const stagedDiff = readGitDiffPreview(gitCwd, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      `--unified=${GIT_DIFF_PREVIEW_CONTEXT_LINES}`,
      '--',
      gitPath
    ])
    const currentDiff = [stagedDiff.text, unstagedDiff.text].filter((text) => text.trim()).join('\n')
    if (currentDiff.trim()) {
      if (/^Binary files /m.test(currentDiff) || /^GIT binary patch$/m.test(currentDiff)) {
        isBinary = true
        previewKind = 'binary'
      } else {
        diffText = currentDiff
        diffTextTruncated = Boolean(stagedDiff.truncated || unstagedDiff.truncated)
        diffTextOmittedLines = [stagedDiff.omittedLines, unstagedDiff.omittedLines].reduce(
          (sum: number, count) => sum + (count ?? 0),
          0
        )
        if (diffTextOmittedLines === 0) diffTextOmittedLines = undefined
        if (!diffTextTruncated) {
          diffTextOriginalBytes = Buffer.byteLength(currentDiff, 'utf8')
        }
        previewKind = 'git_diff'
        if (additions === undefined || deletions === undefined) {
          const counts = countDiffLines(currentDiff)
          additions = counts.additions
          deletions = counts.deletions
        }
      }
    }
  }

  return {
    ...baseSummary,
    additions,
    deletions,
    isBinary,
    previewKind,
    diffText,
    diffTextTruncated,
    diffTextOmittedLines,
    diffTextOriginalBytes,
    sizeBytes
  }
}

function buildRunFileSummary(
  workspace: string | undefined,
  filePath: string,
  status: DiffFileStatus
): DiffFileSummary {
  return buildCurrentFileSummary(workspace, workspace, filePath, filePath, status)
}

export async function getWorkspaceDiff(workspace: string): Promise<{
  type: string
  text?: string
  statusText?: string
  diffText?: string
  summaries?: DiffFileSummary[]
}> {
  const scope = await resolveGitWorkspaceScope(workspace)
  if (!scope) {
    return {
      type: 'not_repo',
      text: 'This folder is not a git repository. Run git init if you want diff tracking.'
    }
  }

  const pathspec = workspacePathspec(scope.workspacePrefix)
  const { stdout: statusOut, stderr: statusErr, code: statusCode } = await spawnGit(scope.repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...pathspec
  ])
  if (statusErr.includes('not a git repository')) {
    return {
      type: 'not_repo',
      text: 'This folder is not a git repository. Run git init if you want diff tracking.'
    }
  }
  if (statusCode !== 0) {
    return {
      type: 'error',
      text: statusErr.trim() || 'Git status could not be inspected safely.'
    }
  }

  if (!statusOut.trim()) {
    return { type: 'no_changes', text: 'No changes were made.' }
  }

  const statusEntries = parseGitStatusZ(statusOut)

  // ONE numstat read for every tracked file, hoisted out of the per-file path.
  // The pair it replaces cost two subprocesses PER FILE, measured 2026-08-20 at
  // ~50 ms of blocked main thread per file on this repo (6400 tracked files) —
  // and the clean-tree floor matched the with-content cost, so the expense is
  // git process STARTUP, not diff work. Fewer spawns is the only lever that
  // moves it. `sampleWorkspaceChurn` below already reads churn exactly this way
  // and documents the same reasoning; this brings the per-file path in line.
  // Measured end to end: getWorkspaceDiff over 20 modified files 1879 -> 1006 ms.
  const batchedChurn = await spawnGit(scope.repoRoot, [
    'diff',
    '--numstat',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    ...pathspec
  ])
  // Failure — most often an unborn HEAD with nothing to diff against — leaves
  // this undefined, and every file falls back to its own pair. The batch is an
  // optimisation; the per-file path stays the correctness path.
  const churnByPath = batchedChurn.code === 0 ? parseNumstatByPath(batchedChurn.stdout) : undefined

  const summaries = statusEntries.flatMap((entry) => {
    const displayPath = repoPathToWorkspacePath(entry.filePath, scope.workspacePrefix)
    if (!displayPath) return []
    return [
      buildCurrentFileSummary(
        scope.workspaceRoot,
        scope.repoRoot,
        entry.filePath,
        displayPath,
        classifyStatus(entry.statusCode),
        { staged: entry.staged, unstaged: entry.unstaged },
        churnByPath
      )
    ]
  })

  return {
    type: 'changes',
    statusText: statusOut,
    summaries
  }
}

export async function captureWorkspaceSnapshot(workspace: string): Promise<WorkspaceSnapshot> {
  // Detect the repository before the hardened status path probes `git config
  // --local`. Plain directories reject that probe with a different message
  // from `git status`, and must take the non-Git file-tree fallback instead of
  // failing an otherwise valid run.
  const gitScope = await resolveGitWorkspaceScope(workspace)
  if (!gitScope) {
    const files: FileSnapshot[] = []
    function walk(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (isNoiseFile(entry.name)) continue
        const rel = path.relative(workspace, path.join(dir, entry.name))
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name))
        } else {
          const stat = fs.statSync(path.join(dir, entry.name))
          files.push({
            path: rel,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs
          })
        }
      }
    }
    try {
      walk(workspace)
    } catch {
      /* ignore */
    }

    return {
      capturedAt: new Date().toISOString(),
      isGitRepo: false,
      workspacePath: workspace,
      files
    }
  }

  const { stdout: statusOut, stderr: statusErr, code: statusCode } = await spawnGit(workspace, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ])
  if (statusCode !== 0) {
    throw new Error(statusErr.trim() || 'Git status could not be captured safely.')
  }

  return {
    capturedAt: new Date().toISOString(),
    isGitRepo: true,
    workspacePath: workspace,
    gitStatus: statusOut
  }
}

/**
 * Sample tree-derived per-file churn for `WorkspaceChurn`.
 *
 * Two reads, both scoped to the workspace prefix so a workspace bound to a
 * subdirectory of a larger repository never reports its siblings:
 *   1. `diff --numstat HEAD` — churn for TRACKED files. Diffing against HEAD
 *      (rather than the two-call staged/unstaged pair `countGitFileDiffLines`
 *      uses) collapses index and worktree into one number in one subprocess,
 *      which matters because this runs per dispatch rather than per file.
 *   2. `status --porcelain=v1 -z -uall` — UNTRACKED paths, which numstat cannot
 *      see at all. Their lines are counted directly (bounded, noise-filtered),
 *      because a name-only entry made a new file invisible after the turn it
 *      first appeared — a seat could keep growing it unseen.
 *
 * Returns `null` — never a partial or zeroed sample — when the workspace is not
 * a repository, has no commit to diff against, or git errors. A missing stanza
 * is honest; a stanza reading `+0/-0` because git failed is a lie the panel
 * would act on.
 */
export async function sampleWorkspaceChurn(
  workspace: string
): Promise<WorkspaceChurnSample | null> {
  let scope: Awaited<ReturnType<typeof resolveGitWorkspaceScope>>
  try {
    scope = await resolveGitWorkspaceScope(workspace)
  } catch {
    return null
  }
  if (!scope) return null
  const pathspec = workspacePathspec(scope.workspacePrefix)

  const numstat = await spawnGit(scope.repoRoot, [
    'diff',
    '--numstat',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    ...pathspec
  ])
  // An unborn HEAD (no commits yet) fails here rather than reporting the whole
  // tree as additions. Nothing to baseline against, so decline the sample.
  if (numstat.code !== 0) return null

  const status = await spawnGit(scope.repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...pathspec
  ])
  const untracked: WorkspaceChurnSample['untracked'] = {}
  if (status.code === 0) {
    for (const entry of parseGitStatusZ(status.stdout)) {
      if (classifyStatus(entry.statusCode) !== 'untracked') continue
      if (!entry.filePath || isNoiseFile(entry.filePath)) continue
      untracked[entry.filePath] = countUntrackedFileLines(path.join(scope.repoRoot, entry.filePath))
    }
  }

  return { tracked: parseNumstatByPath(numstat.stdout), untracked }
}

/** Bound on untracked files we will read to count lines. */
const UNTRACKED_LINE_COUNT_MAX_BYTES = 512 * 1024

/**
 * Line count for a file git is not tracking, expressed as `additions` so it
 * subtracts cleanly against a later sample.
 *
 * Anything unreadable, oversized, or binary comes back flagged `binary` rather
 * than as a zero: a real zero means "empty file", and conflating the two would
 * let an unreadable 10k-line file read as no work at all. Binary detection is
 * the usual NUL-in-the-first-chunk heuristic, which keeps a newly added PNG from
 * being reported as a few thousand stray lines.
 */
function countUntrackedFileLines(absolutePath: string): {
  additions: number
  deletions: number
  binary?: boolean
} {
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) return { additions: 0, deletions: 0, binary: true }
    if (stat.size > UNTRACKED_LINE_COUNT_MAX_BYTES) {
      return { additions: 0, deletions: 0, binary: true }
    }
    const buffer = fs.readFileSync(absolutePath)
    if (buffer.subarray(0, 8192).includes(0)) {
      return { additions: 0, deletions: 0, binary: true }
    }
    if (buffer.length === 0) return { additions: 0, deletions: 0 }
    let lines = 0
    for (const byte of buffer) {
      if (byte === 0x0a) lines += 1
    }
    // A trailing byte that is not a newline still terminates a line.
    if (buffer[buffer.length - 1] !== 0x0a) lines += 1
    return { additions: lines, deletions: 0 }
  } catch {
    return { additions: 0, deletions: 0, binary: true }
  }
}

// ── Bounded workspace diff (iOS Diff Studio) ─────────────────────────────────
// The `workspaceDiff` bridge action projects the same safe per-file previews
// desktop Diff Studio receives (`get-diff` IPC → getWorkspaceDiff), then applies
// tighter mobile caps so the ack stays inside the relay frame budget: ≤40 files,
// ≤200 hunk lines per file, line text clipped to 400 chars. Anything dropped is
// flagged with `truncated` (per file and on the total).

export const BOUNDED_DIFF_MAX_FILES = 40
export const BOUNDED_DIFF_MAX_LINES_PER_FILE = 200
export const BOUNDED_DIFF_MAX_LINE_CHARS = 400

export interface BoundedDiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

export interface BoundedDiffHunk {
  header: string
  lines: BoundedDiffLine[]
}

export interface BoundedDiffFile {
  path: string
  kind: 'created' | 'modified' | 'deleted'
  status: DiffFileStatus
  additions: number
  deletions: number
  hunks: BoundedDiffHunk[]
  previewKind: DiffFileSummary['previewKind']
  isBinary?: boolean
  isSensitive?: boolean
  canOpenInEditor: boolean
  staged?: boolean
  unstaged?: boolean
  truncated?: boolean
}

export interface BoundedWorkspaceDiff {
  files: BoundedDiffFile[]
  /** Non-noise changed files BEFORE the file cap — lets the phone render
   * "showing 40 of N". */
  totalFiles: number
  truncated: boolean
}

function boundedDiffKind(status: DiffFileStatus): BoundedDiffFile['kind'] {
  if (status === 'created' || status === 'untracked') return 'created'
  if (status === 'deleted') return 'deleted'
  return 'modified'
}

function isUnifiedDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('similarity index') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline')
  )
}

function boundDiffFile(summary: DiffFileSummary): BoundedDiffFile {
  const file: BoundedDiffFile = {
    path: summary.path,
    kind: boundedDiffKind(summary.status),
    status: summary.status,
    additions: summary.additions ?? 0,
    deletions: summary.deletions ?? 0,
    hunks: [],
    previewKind: summary.previewKind,
    isBinary: summary.isBinary,
    isSensitive: summary.isSensitive,
    canOpenInEditor:
      summary.status !== 'deleted' &&
      summary.status !== 'binary' &&
      summary.status !== 'hidden_sensitive' &&
      summary.previewKind !== 'binary' &&
      summary.previewKind !== 'hidden',
    staged: summary.staged,
    unstaged: summary.unstaged
  }
  // Sensitive previews stay hidden on the phone exactly as on the desktop;
  // binary files have no renderable hunks either way.
  if (!summary.diffText || summary.isBinary || summary.isSensitive) return file

  let usedLines = 0
  let oldCounter: number | undefined
  let newCounter: number | undefined
  let current: BoundedDiffHunk | null = null
  for (const rawLine of summary.diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('@@')) {
      if (usedLines >= BOUNDED_DIFF_MAX_LINES_PER_FILE) {
        file.truncated = true
        break
      }
      const header =
        rawLine.length > BOUNDED_DIFF_MAX_LINE_CHARS
          ? rawLine.slice(0, BOUNDED_DIFF_MAX_LINE_CHARS)
          : rawLine
      current = { header, lines: [] }
      file.hunks.push(current)
      const parsed = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      oldCounter = parsed ? Number(parsed[1]) : undefined
      newCounter = parsed ? Number(parsed[2]) : undefined
      continue
    }
    if (!current || isUnifiedDiffMetadataLine(rawLine)) continue
    if (usedLines >= BOUNDED_DIFF_MAX_LINES_PER_FILE) {
      file.truncated = true
      break
    }
    const marker = rawLine[0]
    const body = rawLine.length > 0 ? rawLine.slice(1) : ''
    const text =
      body.length > BOUNDED_DIFF_MAX_LINE_CHARS ? body.slice(0, BOUNDED_DIFF_MAX_LINE_CHARS) : body
    if (body.length > BOUNDED_DIFF_MAX_LINE_CHARS) file.truncated = true
    const line: BoundedDiffLine = {
      type: marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx',
      text
    }
    if (line.type === 'add') {
      if (newCounter !== undefined && newCounter > 0) line.newLine = newCounter
      if (newCounter !== undefined) newCounter += 1
    } else if (line.type === 'del') {
      if (oldCounter !== undefined && oldCounter > 0) line.oldLine = oldCounter
      if (oldCounter !== undefined) oldCounter += 1
    } else {
      if (oldCounter !== undefined && oldCounter > 0) line.oldLine = oldCounter
      if (newCounter !== undefined && newCounter > 0) line.newLine = newCounter
      if (oldCounter !== undefined) oldCounter += 1
      if (newCounter !== undefined) newCounter += 1
    }
    current.lines.push(line)
    usedLines += 1
  }
  return file
}

/** Project `getWorkspaceDiff` summaries into the bounded shape the phone's
 * Diff Studio renders. Noise files are dropped (the desktop's "Hide noise"
 * default); sensitive and binary files keep their row but ship no hunks. */
export function buildBoundedWorkspaceDiff(summaries: DiffFileSummary[]): BoundedWorkspaceDiff {
  const eligible = summaries.filter((summary) => !summary.isNoise)
  const files = eligible.slice(0, BOUNDED_DIFF_MAX_FILES).map(boundDiffFile)
  return {
    files,
    totalFiles: eligible.length,
    truncated: eligible.length > BOUNDED_DIFF_MAX_FILES || files.some((file) => file.truncated)
  }
}

export function computeRunDiff(
  pre: WorkspaceSnapshot,
  post: WorkspaceSnapshot,
  runId: string
): RunDiffResult {
  const createdFiles: DiffFileSummary[] = []
  const modifiedFiles: DiffFileSummary[] = []
  const deletedFiles: DiffFileSummary[] = []
  const preExistingFiles: DiffFileSummary[] = []
  const workspace = post.workspacePath || pre.workspacePath

  if (
    pre.isGitRepo &&
    post.isGitRepo &&
    typeof pre.gitStatus === 'string' &&
    typeof post.gitStatus === 'string'
  ) {
    const preEntries = parseGitStatusZ(pre.gitStatus)
    const postEntries = parseGitStatusZ(post.gitStatus)

    const preMap = new Map(preEntries.map((e) => [e.filePath, e]))
    const postMap = new Map(postEntries.map((e) => [e.filePath, e]))

    for (const [filePath, postEntry] of postMap) {
      const status = classifyStatus(postEntry.statusCode)
      const preEntry = preMap.get(filePath)

      if (!preEntry) {
        // Didn't exist before run
        if (status === 'untracked' || status === 'created') {
          createdFiles.push(buildRunFileSummary(workspace, filePath, 'created'))
        } else if (status === 'deleted') {
          deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
        } else {
          modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
        }
      } else {
        const preStatus = classifyStatus(preEntry.statusCode)
        if (preStatus === status) {
          // Unchanged status: pre-existing
          preExistingFiles.push({ path: filePath, status, previewKind: 'none' })
        } else if (status === 'deleted') {
          deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
        } else {
          // Changed during run
          modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
        }
      }
    }

    for (const [filePath] of preMap) {
      if (!postMap.has(filePath)) {
        const preStatus = classifyStatus(preMap.get(filePath)?.statusCode ?? '')
        if (preStatus === 'untracked' || preStatus === 'created') {
          deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
        } else {
          modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
        }
      }
    }
  } else if (!pre.isGitRepo && !post.isGitRepo && pre.files && post.files) {
    const preMap = new Map(pre.files.map((f) => [f.path, f]))
    const postMap = new Map(post.files.map((f) => [f.path, f]))

    for (const [filePath, postFile] of postMap) {
      const preFile = preMap.get(filePath)
      if (!preFile) {
        createdFiles.push(buildRunFileSummary(workspace, filePath, 'created'))
      } else if (preFile.mtimeMs !== postFile.mtimeMs || preFile.sizeBytes !== postFile.sizeBytes) {
        modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
      }
    }

    for (const [filePath] of preMap) {
      if (!postMap.has(filePath)) {
        deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
      }
    }
  }

  return {
    runId,
    preSnapshot: pre,
    postSnapshot: post,
    createdFiles,
    modifiedFiles,
    deletedFiles,
    preExistingFiles
  }
}
