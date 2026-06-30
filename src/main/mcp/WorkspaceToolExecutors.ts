import { randomBytes } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isPathInsideWorkspace } from '../AgenticPolicy'
import { getSubThreadResumeSessionId as defaultGetSubThreadResumeSessionId } from '../SubThreadRecall'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  ChatScope,
  ProviderId,
  RunEventFilter,
  RunEventRecord,
  RunQueueJob
} from '../store/types'

export interface HostCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
  timedOut: boolean
  durationMs: number
}

export interface WorkspaceToolContext {
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appChatId?: string
}

export interface WorkspaceToolHostDependencies {
  runHostCommand: (
    command: string | string[],
    cwd: string,
    timeoutMs?: number
  ) => Promise<HostCommandResult>
  getTempDir: () => string
}

export interface WorkspaceToolStoreDependencies {
  getChat: (chatId: string) => ChatRecord | undefined
  getChildChats: (parentChatId: string) => ChatRecord[]
  getRunQueueJobs: (filter?: { chatId?: string }) => RunQueueJob[]
}

export interface WorkspaceToolActiveRun {
  appChatId?: string
  runId?: string
  status?: string
}

export interface WorkspaceToolRunDependencies {
  getActiveByProvider: (provider: ProviderId) => WorkspaceToolActiveRun[]
  getRunEvents: (filter?: RunEventFilter) => RunEventRecord[]
  cancelProviderRun: (provider: ProviderId, runId?: string) => Promise<boolean>
  saveAndBroadcastChat: (chat: ChatRecord) => void
  getSubThreadResumeSessionId?: (chat: ChatRecord) => string | undefined
}

export interface WorkspaceToolExecutorDependencies {
  host: WorkspaceToolHostDependencies
  store: WorkspaceToolStoreDependencies
  runs: WorkspaceToolRunDependencies
}

export const WORKSPACE_MCP_TOOL_NAMES = [
  'find_files',
  'workspace_search',
  'apply_patch',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_stage',
  'git_commit',
  'git_push',
  'git_create_pr',
  'run_task',
  'get_diagnostics',
  'list_active_runs',
  'cancel_active_run',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  'workspace_symbols'
] as const

export type WorkspaceMcpToolName = (typeof WORKSPACE_MCP_TOOL_NAMES)[number]

export interface WorkspaceMcpToolExecution {
  result: unknown
  isError: boolean
}

export interface WorkspaceToolExecutors {
  executeFindFiles: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeWorkspaceSearch: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeApplyPatch: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeCreateDirectory: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
  executeDeletePath: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
  executeMovePath: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
  executeRenamePath: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
  executeGitStatus: (cwd: string) => Promise<unknown>
  executeGitDiff: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitLog: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitShow: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitBlame: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitStage: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitCommit: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeGitPush: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeGitCreatePr: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeRunTask: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeGetDiagnostics: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeListActiveRuns: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => unknown
  executeCancelActiveRun: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
  executeListSubthreads: (context: WorkspaceToolContext, args: Record<string, any>) => unknown
  executeReadSubthreadResult: (
    context: WorkspaceToolContext,
    args: Record<string, any>
  ) => unknown
  executeCancelSubthread: (
    context: WorkspaceToolContext,
    args: Record<string, any>
  ) => Promise<unknown>
  executeWorkspaceSymbols: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeWorkspaceMcpTool: (
    toolName: WorkspaceMcpToolName,
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<WorkspaceMcpToolExecution>
}

const MAX_MCP_TEXT_CHARS = 200_000
const GIT_FIELD_SEPARATOR = '\x1f'
const GIT_COMMIT_FORMAT = `%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s`
const FIND_FILES_DEFAULT_EXCLUDE_GLOBS = [
  '!.git/**',
  '!node_modules/**',
  '!vendor/**',
  '!Pods/**',
  '!DerivedData/**',
  '!dist/**',
  '!build/**',
  '!coverage/**',
  '!.next/**',
  '!out/**'
] as const
const DIAGNOSTIC_DEFAULT_TSCONFIGS = [
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json'
] as const

type DiagnosticSource = 'typescript' | 'eslint'
type DiagnosticSourceMode = DiagnosticSource | 'all'
type DiagnosticSeverity = 'error' | 'warning' | 'info'

interface WorkspaceDiagnostic {
  source: DiagnosticSource
  severity: DiagnosticSeverity
  path?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  message: string
  code?: string
}

interface DiagnosticRunSummary {
  source: DiagnosticSource
  command?: string[]
  cwd: string
  project?: string
  target?: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  diagnosticCount: number
  ok: boolean
  skipped?: boolean
  error?: string
  stderr?: string
}

interface DiagnosticsPathFilter {
  targetPath: string
  displayPath: string
  isDirectory: boolean
}

type SubThreadLifecycleState =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'returned'

const RUN_CONTROL_PROVIDER_IDS: readonly ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

export function createWorkspaceToolExecutors(
  deps: WorkspaceToolExecutorDependencies
): WorkspaceToolExecutors {
  return {
    executeFindFiles: (args, context, cwd) => executeFindFiles(deps, args, context, cwd),
    executeWorkspaceSearch: (args, context, cwd) => executeWorkspaceSearch(deps, args, context, cwd),
    executeApplyPatch: (args, context, cwd) => executeApplyPatch(deps, args, context, cwd),
    executeCreateDirectory: (args, context) => executeCreateDirectory(args, context),
    executeDeletePath: (args, context) => executeDeletePath(args, context),
    executeMovePath: (args, context) => executeMovePath(args, context),
    executeRenamePath: (args, context) => executeRenamePath(args, context),
    executeGitStatus: (cwd) => executeGitStatus(deps, cwd),
    executeGitDiff: (args, context, cwd) => executeGitDiff(deps, args, context, cwd),
    executeGitLog: (args, context, cwd) => executeGitLog(deps, args, context, cwd),
    executeGitShow: (args, context, cwd) => executeGitShow(deps, args, context, cwd),
    executeGitBlame: (args, context, cwd) => executeGitBlame(deps, args, context, cwd),
    executeGitStage: (args, context, cwd) => executeGitStage(deps, args, context, cwd),
    executeGitCommit: (args, cwd) => executeGitCommit(deps, args, cwd),
    executeGitPush: (args, cwd) => executeGitPush(deps, args, cwd),
    executeGitCreatePr: (args, cwd) => executeGitCreatePr(deps, args, cwd),
    executeRunTask: (args, cwd) => executeRunTask(deps, args, cwd),
    executeGetDiagnostics: (args, context, cwd) =>
      executeGetDiagnostics(deps, args, context, cwd),
    executeListActiveRuns: (args, context) => executeListActiveRuns(deps, args, context),
    executeCancelActiveRun: (args, context) => executeCancelActiveRun(deps, args, context),
    executeListSubthreads: (context, args) => executeListSubthreads(deps, context, args),
    executeReadSubthreadResult: (context, args) => executeReadSubthreadResult(deps, context, args),
    executeCancelSubthread: (context, args) => executeCancelSubthread(deps, context, args),
    executeWorkspaceSymbols: (args, context, cwd) =>
      executeWorkspaceSymbols(deps, args, context, cwd),
    executeWorkspaceMcpTool: (toolName, args, context, cwd) =>
      executeWorkspaceMcpTool(deps, toolName, args, context, cwd)
  }
}

export async function executeWorkspaceMcpTool(
  deps: WorkspaceToolExecutorDependencies,
  toolName: WorkspaceMcpToolName,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
): Promise<WorkspaceMcpToolExecution> {
  if (toolName === 'find_files') {
    const result = await executeFindFiles(deps, args, context, cwd)
    return { result, isError: result.ok === false || Boolean(result.timedOut || result.error) }
  }
  if (toolName === 'workspace_search') {
    const result = await executeWorkspaceSearch(deps, args, context, cwd)
    return { result, isError: result.ok === false || Boolean(result.timedOut || result.error) }
  }
  if (toolName === 'apply_patch') {
    const result = await executeApplyPatch(deps, args, context, cwd)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'create_directory') {
    const result = await executeCreateDirectory(args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'delete_path') {
    const result = await executeDeletePath(args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'move_path') {
    const result = await executeMovePath(args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'rename_path') {
    const result = await executeRenamePath(args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'git_status') {
    const result = await executeGitStatus(deps, cwd)
    return { result, isError: result.exitCode !== 0 }
  }
  if (toolName === 'git_diff') {
    const result = await executeGitDiff(deps, args, context, cwd)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_log') {
    const result = await executeGitLog(deps, args, context, cwd)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_show') {
    const result = await executeGitShow(deps, args, context, cwd)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_blame') {
    const result = await executeGitBlame(deps, args, context, cwd)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_stage') {
    const result = await executeGitStage(deps, args, context, cwd)
    const stageExitCode = commandResultExitCode(result.result)
    return {
      result,
      isError: result.ok === false || (stageExitCode !== null && stageExitCode !== 0)
    }
  }
  if (toolName === 'git_commit') {
    const result = await executeGitCommit(deps, args, cwd)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_push') {
    const result = await executeGitPush(deps, args, cwd)
    return {
      result,
      isError: result.ok === false || result.exitCode !== 0 || result.timedOut === true
    }
  }
  if (toolName === 'git_create_pr') {
    const result = await executeGitCreatePr(deps, args, cwd)
    return {
      result,
      isError: result.ok === false || result.exitCode !== 0 || result.timedOut === true
    }
  }
  if (toolName === 'run_task') {
    const result = await executeRunTask(deps, args, cwd)
    return {
      result,
      isError: (result.exitCode !== null && result.exitCode !== 0) || result.timedOut === true
    }
  }
  if (toolName === 'get_diagnostics') {
    const result = await executeGetDiagnostics(deps, args, context, cwd)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'list_active_runs') {
    return { result: executeListActiveRuns(deps, args, context), isError: false }
  }
  if (toolName === 'cancel_active_run') {
    const result = await executeCancelActiveRun(deps, args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'list_subthreads') {
    return { result: executeListSubthreads(deps, context, args), isError: false }
  }
  if (toolName === 'read_subthread_result') {
    return { result: executeReadSubthreadResult(deps, context, args), isError: false }
  }
  if (toolName === 'cancel_subthread') {
    const result = await executeCancelSubthread(deps, context, args)
    return { result, isError: result.ok === false }
  }

  return {
    result: await executeWorkspaceSymbols(deps, args, context, cwd),
    isError: false
  }
}

export async function executeFindFiles(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const patterns = dedupeStrings([
    ...toStringArray(args.pattern),
    ...toStringArray(args.patterns),
    ...toStringArray(args.glob),
    ...toStringArray(args.globs)
  ]).slice(0, 20)
  if (patterns.length === 0) {
    throw new Error('find_files requires at least one filename glob pattern.')
  }
  const target = args.path || args.directory || '.'
  const targetPath = resolveMcpScopedPath(context, String(target), { allowWorkspaceRoot: true })
  const maxResults = clampInteger(args.maxResults ?? args.limit, 100, 1, 1000)
  const includeHidden = args.includeHidden === true || args.hidden === true
  const rgArgs = [
    '--files',
    ...(includeHidden ? ['--hidden'] : []),
    ...FIND_FILES_DEFAULT_EXCLUDE_GLOBS.flatMap((glob) => ['--glob', glob]),
    ...patterns.flatMap((glob) => ['--glob', glob]),
    '--',
    targetPath
  ]
  const result = await runCommandArgs(deps, ['rg', ...rgArgs], cwd, 60_000)
  const allFiles = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const files = allFiles
    .slice(0, maxResults)
    .map((filePath) => workspaceRelativeForContext(context, filePath))
  return {
    ok: result.exitCode === 0 || result.exitCode === 1,
    cwd,
    target: workspaceRelativeForContext(context, targetPath),
    patterns,
    includeHidden,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    count: files.length,
    totalMatches: allFiles.length,
    truncated: allFiles.length > files.length,
    files,
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeWorkspaceSearch(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const query = requireNonEmptyString(args.query || args.pattern, 'Search query')
  const target = args.path || args.directory || '.'
  const targetPath = resolveMcpScopedPath(context, String(target), { allowWorkspaceRoot: true })
  const maxResults = clampInteger(args.maxResults ?? args.limit, 100, 1, 500)
  const contextLines = clampInteger(args.contextLines ?? args.context, 0, 0, 5)
  const rgArgs = [
    '--json',
    '--line-number',
    '--column',
    '--hidden',
    '--glob',
    '!.git/**',
    '--glob',
    '!node_modules/**',
    ...(contextLines > 0 ? ['--context', String(contextLines)] : []),
    ...toStringArray(args.globs || args.glob).flatMap((glob) => ['--glob', glob]),
    '--',
    query,
    targetPath
  ]
  const result = await runCommandArgs(deps, ['rg', ...rgArgs], cwd, 60_000)
  const matches: any[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type !== 'match') continue
      matches.push({
        path: workspaceRelativeForContext(context, String(event.data?.path?.text || '')),
        line: event.data?.line_number,
        column: event.data?.submatches?.[0]?.start + 1,
        text: String(event.data?.lines?.text || '').replace(/\r?\n$/, ''),
        submatches: Array.isArray(event.data?.submatches) ? event.data.submatches : []
      })
      if (matches.length >= maxResults) break
    } catch {
      // Ignore malformed rg JSON lines; stderr is returned separately.
    }
  }
  return {
    query,
    cwd,
    target: workspaceRelativeForContext(context, targetPath),
    ok: result.exitCode === 0 || result.exitCode === 1,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    count: matches.length,
    truncated: matches.length >= maxResults,
    matches,
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeApplyPatch(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const patch = requireNonEmptyString(args.patch || args.diff, 'Patch')
  const patchPaths = assertPatchPathsInScope(context, cwd, patch)
  const dryRun = args.dryRun === true || args.check === true || args.preview === true
  const patchPath = join(
    deps.host.getTempDir(),
    `taskwraith-mcp-${Date.now()}-${randomBytes(4).toString('hex')}.patch`
  )
  await fs.writeFile(patchPath, patch, 'utf8')
  try {
    const check = await runCommandArgs(deps, ['git', 'apply', '--check', patchPath], cwd, 30_000)
    if (check.exitCode !== 0) {
      return {
        ok: false,
        dryRun,
        paths: patchPaths,
        check,
        message: 'Patch does not apply cleanly.'
      }
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        paths: patchPaths,
        message: 'Patch applies cleanly.',
        check
      }
    }
    const applied = await runCommandArgs(deps, ['git', 'apply', patchPath], cwd, 30_000)
    return {
      ok: applied.exitCode === 0,
      dryRun: false,
      paths: patchPaths,
      applied,
      message: applied.exitCode === 0 ? 'Patch applied.' : 'Patch apply failed after check.'
    }
  } finally {
    await fs.rm(patchPath, { force: true }).catch(() => {})
  }
}

export async function executeCreateDirectory(
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const targetPath = resolveMcpWorkspacePath(
    context,
    requireNonEmptyString(args.path || args.directory, 'Path')
  )
  const recursive = args.recursive !== false
  await assertNearestExistingParentInsideWorkspace(context, targetPath)
  const existedBefore = await pathExists(targetPath)
  if (existedBefore) {
    const lstat = await fs.lstat(targetPath)
    if (lstat.isSymbolicLink()) throw new Error('Symbolic links cannot be managed by create_directory.')
    if (!lstat.isDirectory()) throw new Error('Target path exists and is not a directory.')
  } else {
    await fs.mkdir(targetPath, { recursive })
  }
  return {
    ok: true,
    tool: 'create_directory',
    path: workspaceRelativeForContext(context, targetPath),
    created: !existedBefore,
    recursive
  }
}

export async function executeDeletePath(args: Record<string, any>, context: WorkspaceToolContext) {
  const targetPath = resolveMcpWorkspacePath(
    context,
    requireNonEmptyString(args.path || args.file || args.directory, 'Path')
  )
  const lstat = await fs.lstat(targetPath)
  if (lstat.isSymbolicLink()) throw new Error('Symbolic links cannot be deleted by delete_path.')
  if (lstat.isDirectory()) {
    await fs.rmdir(targetPath)
    return {
      ok: true,
      tool: 'delete_path',
      path: workspaceRelativeForContext(context, targetPath),
      kind: 'directory',
      deleted: true
    }
  }
  if (!lstat.isFile()) throw new Error('Selected path is not a file or directory.')
  await fs.unlink(targetPath)
  return {
    ok: true,
    tool: 'delete_path',
    path: workspaceRelativeForContext(context, targetPath),
    kind: 'file',
    deleted: true
  }
}

export async function executeMovePath(args: Record<string, any>, context: WorkspaceToolContext) {
  const sourcePath = resolveMcpWorkspacePath(
    context,
    requireNonEmptyString(args.from || args.source || args.sourcePath || args.path, 'Source path')
  )
  const destinationPath = resolveMcpWorkspacePath(
    context,
    requireNonEmptyString(
      args.to || args.destination || args.destinationPath || args.target,
      'Destination path'
    )
  )
  return moveWorkspacePath({
    context,
    sourcePath,
    destinationPath,
    overwrite: args.overwrite === true,
    createParents: args.createParents === true,
    tool: 'move_path'
  })
}

export async function executeRenamePath(args: Record<string, any>, context: WorkspaceToolContext) {
  const sourcePath = resolveMcpWorkspacePath(
    context,
    requireNonEmptyString(args.path || args.from || args.source, 'Path')
  )
  const newName = requireNonEmptyString(args.newName || args.name, 'New name')
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
    throw new Error('rename_path newName must be a basename, not a path.')
  }
  const destinationPath = resolve(dirname(sourcePath), newName)
  assertPathInsideWorkspaceContext(context, destinationPath)
  return moveWorkspacePath({
    context,
    sourcePath,
    destinationPath,
    overwrite: args.overwrite === true,
    createParents: false,
    tool: 'rename_path'
  })
}

export async function executeGitStatus(deps: WorkspaceToolExecutorDependencies, cwd: string) {
  const [shortStatus, branchStatus] = await Promise.all([
    runCommandArgs(deps, ['git', 'status', '--short', '--branch'], cwd, 30_000),
    runCommandArgs(deps, ['git', 'branch', '--show-current'], cwd, 30_000)
  ])
  return {
    cwd,
    branch: branchStatus.stdout.trim(),
    exitCode: shortStatus.exitCode,
    stdout: shortStatus.stdout,
    stderr: shortStatus.stderr,
    clean:
      shortStatus.exitCode === 0 &&
      shortStatus.stdout
        .trim()
        .split(/\r?\n/)
        .every((line) => line.startsWith('##'))
  }
}

export async function executeGitDiff(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const diffArgs = ['git', 'diff']
  if (args.cached === true || args.staged === true) diffArgs.push('--cached')
  if (args.stat === true) diffArgs.push('--stat')
  const paths = toStringArray(args.paths || (args.path ? [args.path] : []))
  if (paths.length) {
    diffArgs.push('--', ...paths.map((pathArg) => resolveMcpScopedPath(context, pathArg)))
  }
  const result = await runCommandArgs(deps, diffArgs, cwd, 60_000)
  return {
    cwd,
    command: diffArgs,
    exitCode: result.exitCode,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr, 20_000),
    timedOut: result.timedOut
  }
}

export async function executeGitLog(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const maxCount = clampInteger(args.maxCount ?? args.limit, 20, 1, 100)
  const ref = optionalString(args.ref || args.rev || args.revision)
  const gitArgs = [
    'git',
    'log',
    `--max-count=${maxCount}`,
    '--date=iso-strict',
    `--pretty=format:${GIT_COMMIT_FORMAT}`
  ]
  if (args.grep) gitArgs.push('--grep', String(args.grep).slice(0, 200))
  if (args.author) gitArgs.push('--author', String(args.author).slice(0, 200))
  if (ref) gitArgs.push(sanitizeGitRef(ref))
  const paths = toStringArray(args.paths || (args.path ? [args.path] : []))
  if (paths.length) {
    gitArgs.push(
      '--',
      ...paths.map((pathArg) =>
        resolveMcpScopedPath(context, pathArg, { allowWorkspaceRoot: true })
      )
    )
  }
  const result = await runCommandArgs(deps, gitArgs, cwd, 60_000)
  const commits = parseGitLogEntries(result.stdout)
  return {
    cwd,
    command: redactGitLogCommand(gitArgs),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    count: commits.length,
    commits,
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeGitShow(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const ref = sanitizeGitRef(args.ref || args.commit || args.revision)
  const includePatch = args.includePatch === true || args.patch === true
  const includeStat = args.stat !== false
  const gitArgs = ['git', 'show', '--no-ext-diff', '--date=iso-strict', `--format=${GIT_COMMIT_FORMAT}`]
  if (includePatch) {
    gitArgs.push('--patch', '--unified=3')
  } else if (includeStat) {
    gitArgs.push('--stat')
  } else {
    gitArgs.push('--no-patch')
  }
  gitArgs.push(ref)
  const pathArg = optionalString(args.path || args.file)
  if (pathArg) {
    gitArgs.push('--', resolveMcpScopedPath(context, pathArg, { allowWorkspaceRoot: true }))
  }
  const result = await runCommandArgs(deps, gitArgs, cwd, 60_000)
  const stdout = truncateText(result.stdout)
  return {
    cwd,
    command: gitArgs,
    ref,
    includePatch,
    includeStat,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    commit: parseGitCommitLine(firstNonEmptyLine(result.stdout)),
    stdout,
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeGitBlame(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const targetPath = resolveMcpScopedPath(
    context,
    requireNonEmptyString(args.path || args.file, 'Path')
  )
  const startLine = clampInteger(args.startLine ?? args.lineStart, 1, 1, 1_000_000)
  const maxLines = clampInteger(args.maxLines ?? args.limit, 120, 1, 500)
  const requestedEnd = clampInteger(args.endLine ?? args.lineEnd, startLine + maxLines - 1, 1, 1_000_000)
  const endLine = Math.max(startLine, Math.min(requestedEnd, startLine + maxLines - 1))
  const gitArgs = [
    'git',
    'blame',
    '--line-porcelain',
    '-L',
    `${startLine},${endLine}`,
    '--',
    targetPath
  ]
  const result = await runCommandArgs(deps, gitArgs, cwd, 60_000)
  const entries = parseGitBlamePorcelain(result.stdout, context)
  return {
    cwd,
    command: gitArgs,
    path: workspaceRelativeForContext(context, targetPath),
    startLine,
    endLine,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    count: entries.length,
    entries,
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeGitStage(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const patch = optionalString(args.patch)
  if (patch) {
    const patchPaths = assertPatchPathsInScope(context, cwd, patch)
    const patchPath = join(
      deps.host.getTempDir(),
      `taskwraith-mcp-stage-${Date.now()}-${randomBytes(4).toString('hex')}.patch`
    )
    await fs.writeFile(patchPath, patch, 'utf8')
    try {
      const check = await runCommandArgs(
        deps,
        ['git', 'apply', '--cached', '--check', patchPath],
        cwd,
        30_000
      )
      if (check.exitCode !== 0) {
        return {
          ok: false,
          mode: 'patch',
          paths: patchPaths,
          check,
          message: 'Patch does not stage cleanly.'
        }
      }
      const result = await runCommandArgs(
        deps,
        ['git', 'apply', '--cached', patchPath],
        cwd,
        30_000
      )
      const status = await executeGitStatus(deps, cwd)
      return { ok: result.exitCode === 0, mode: 'patch', paths: patchPaths, result, status }
    } finally {
      await fs.rm(patchPath, { force: true }).catch(() => {})
    }
  }

  const all = args.all === true || args.update === true
  const paths = toStringArray(args.paths || (args.path ? [args.path] : []))
  if (!all && paths.length === 0) {
    throw new Error('git_stage requires paths, patch, or all=true.')
  }
  const gitArgs = ['git', 'add']
  if (all) gitArgs.push(args.update === true ? '-u' : '-A')
  if (paths.length) {
    gitArgs.push('--', ...paths.map((pathArg) => resolveMcpScopedPath(context, pathArg)))
  }
  const result = await runCommandArgs(deps, gitArgs, cwd, 30_000)
  const status = await executeGitStatus(deps, cwd)
  return { command: gitArgs, result, status }
}

export async function executeGitCommit(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string
) {
  const message = requireNonEmptyString(args.message, 'Commit message')
  const gitArgs = ['git', 'commit', '-m', message]
  const result = await runCommandArgs(deps, gitArgs, cwd, 60_000)
  return {
    command: ['git', 'commit', '-m', '[message]'],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}

export async function executeGitPush(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string
) {
  const branchResult = await runCommandArgs(deps, ['git', 'branch', '--show-current'], cwd, 30_000)
  const branch = branchResult.stdout.trim()
  if (branchResult.exitCode !== 0 || !branch) {
    return {
      ok: false,
      command: ['git', 'branch', '--show-current'],
      exitCode: branchResult.exitCode,
      timedOut: branchResult.timedOut,
      stderr: truncateText(branchResult.stderr, 20_000),
      error: branchResult.error || 'Cannot push from a detached HEAD. Create or switch to a branch first.'
    }
  }

  const upstreamResult = await runCommandArgs(
    deps,
    ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    cwd,
    30_000
  )
  const hasUpstream = upstreamResult.exitCode === 0 && upstreamResult.stdout.trim().length > 0
  const remote = optionalString(args.remote) ? sanitizeGitRemote(args.remote) : undefined
  const setUpstream =
    args.setUpstream === true || args.upstream === true || !hasUpstream || Boolean(remote)
  const safeBranch = sanitizeGitRef(branch)
  const command = setUpstream
    ? ['git', 'push', '-u', remote || 'origin', safeBranch]
    : ['git', 'push']
  const result = await runCommandArgs(deps, command, cwd, 120_000)
  const status = await executeGitStatus(deps, cwd)
  return {
    ok: result.exitCode === 0 && result.timedOut !== true && !result.error,
    command,
    branch: safeBranch,
    upstream: hasUpstream ? upstreamResult.stdout.trim() : undefined,
    setUpstream,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr, 20_000),
    error: result.error,
    status
  }
}

export async function executeGitCreatePr(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string
) {
  const title = optionalString(args.title)
  const body = optionalString(args.body || args.description)
  const base = optionalString(args.base)
  const head = optionalString(args.head)
  const command = ['gh', 'pr', 'create']
  if (title) command.push('--title', title)
  if (body) command.push('--body', body)
  if (!title && !body && args.fill !== false) command.push('--fill')
  if (args.draft === true) command.push('--draft')
  if (base) command.push('--base', sanitizeGitRef(base))
  if (head) command.push('--head', sanitizeGitRef(head))

  const result = await runCommandArgs(deps, command, cwd, 120_000)
  const url = result.stdout.match(/https?:\/\/[^\s]+/)?.[0]
  return {
    ok: result.exitCode === 0 && result.timedOut !== true && !result.error,
    command: redactGitCreatePrCommand(command),
    url,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeRunTask(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string
) {
  const task = requireNonEmptyString(args.task || args.script || args.name, 'Task')
  const packageJson = await readJsonFile(join(cwd, 'package.json'))
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : null
  let command: string[]
  if (scripts && task in scripts) {
    command = ['npm', 'run', task]
    const script = String(scripts[task] || '')
    if (task === 'test' && /\bvitest\b/.test(script) && !/\s--run\b/.test(script)) {
      command.push('--', '--run')
    }
  } else if (task === 'test' && fsSync.existsSync(join(cwd, 'Package.swift'))) {
    command = ['swift', 'test']
  } else if (task === 'build' && fsSync.existsSync(join(cwd, 'Package.swift'))) {
    command = ['swift', 'build']
  } else {
    throw new Error(`No known task "${task}" in this workspace.`)
  }
  command.push(...toStringArray(args.args))
  const timeoutMs = clampInteger(args.timeoutMs, 600_000, 1_000, 30 * 60_000)
  const result = await runCommandArgs(deps, command, cwd, timeoutMs)
  return {
    task,
    command,
    cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr),
    summary: summarizeTestOutput(`${result.stdout}\n${result.stderr}`)
  }
}

export async function executeGetDiagnostics(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  if (context.scope !== 'workspace') {
    throw new Error('This tool requires an active workspace.')
  }
  const workspaceRoot = resolve(context.workspacePath || cwd)
  const source = normalizeDiagnosticSourceMode(args.source || args.kind || args.tool, args)
  const maxDiagnostics = clampInteger(args.maxDiagnostics ?? args.maxResults ?? args.limit, 100, 1, 500)
  const timeoutMs = clampInteger(args.timeoutMs, 120_000, 5_000, 10 * 60_000)
  const pathFilter = await resolveDiagnosticsPathFilter(context, args.path || args.file)
  const requestedSources: DiagnosticSource[] =
    source === 'all' ? ['typescript', 'eslint'] : [source]
  const runs: DiagnosticRunSummary[] = []
  const diagnostics: WorkspaceDiagnostic[] = []

  if (requestedSources.includes('typescript')) {
    const projects = resolveDiagnosticTsconfigs(context, args.project || args.tsconfig)
    if (projects.length === 0) {
      runs.push({
        source: 'typescript',
        cwd: workspaceRoot,
        diagnosticCount: 0,
        ok: source === 'all',
        skipped: true,
        error: 'No TypeScript project file found.'
      })
    }
    for (const projectPath of projects) {
      const command = [
        'npx',
        '--no-install',
        'tsc',
        '--noEmit',
        '--pretty',
        'false',
        '--project',
        projectPath
      ]
      const result = await runCommandArgs(deps, command, workspaceRoot, timeoutMs)
      const parsed = parseTypeScriptDiagnostics(
        `${result.stdout || ''}\n${result.stderr || ''}`,
        context
      )
      const filtered = filterDiagnosticsByPath(parsed, context, pathFilter)
      diagnostics.push(...filtered)
      runs.push({
        source: 'typescript',
        command: redactDiagnosticCommand(command, context),
        cwd: workspaceRoot,
        project: workspaceRelativeForContext(context, projectPath),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        diagnosticCount: filtered.length,
        ok:
          result.timedOut !== true &&
          !result.error &&
          (result.exitCode === 0 || parsed.length > 0),
        error: result.error,
        stderr:
          result.exitCode !== 0 && parsed.length === 0
            ? truncateText(result.stderr || result.stdout || '', 4000)
            : undefined
      })
    }
  }

  if (requestedSources.includes('eslint')) {
    const targetPath = pathFilter?.targetPath || workspaceRoot
    const command = [
      'npx',
      '--no-install',
      'eslint',
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      targetPath
    ]
    const result = await runCommandArgs(deps, command, workspaceRoot, timeoutMs)
    const parsed = parseEslintDiagnostics(result.stdout || '', context)
    const filtered = filterDiagnosticsByPath(parsed, context, pathFilter)
    diagnostics.push(...filtered)
    runs.push({
      source: 'eslint',
      command: redactDiagnosticCommand(command, context),
      cwd: workspaceRoot,
      target: pathFilter?.displayPath || '.',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      diagnosticCount: filtered.length,
      ok:
        result.timedOut !== true &&
        !result.error &&
        (result.exitCode === 0 || parsed.length > 0),
      error: result.error,
      stderr:
        result.exitCode !== 0 && parsed.length === 0
          ? truncateText(result.stderr || result.stdout || '', 4000)
          : undefined
    })
  }

  const deduped = dedupeDiagnostics(diagnostics)
  const limited = deduped.slice(0, maxDiagnostics)
  const ranSuccessfully = runs.some((run) => !run.skipped && run.ok)
  const ok = ranSuccessfully && runs.every((run) => run.ok || run.skipped)
  return {
    ok,
    tool: 'get_diagnostics',
    status: ok ? (deduped.length > 0 ? 'problems' : 'clean') : 'failed',
    hasProblems: deduped.length > 0,
    source,
    path: pathFilter?.displayPath,
    count: limited.length,
    totalDiagnostics: deduped.length,
    truncated: deduped.length > limited.length,
    diagnostics: limited,
    runs
  }
}

export function executeListActiveRuns(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  void context
  const providers = resolveRunControlProviders(args.provider)
  const chatIdFilter = optionalString(args.chatId || args.appChatId)
  const includeEvents = args.includeEvents === true
  const eventLimit = clampInteger(args.eventLimit ?? args.limit, 10, 1, 50)
  const activeQueueStatuses = new Set(['queued', 'steer_promoting', 'starting', 'active', 'paused', 'cancelling'])
  const queueJobs = deps.store
    .getRunQueueJobs(chatIdFilter ? { chatId: chatIdFilter } : undefined)
    .filter((job) => providers.includes(job.provider))
    .filter((job) => activeQueueStatuses.has(job.status))
  const sessions = providers.flatMap((provider) =>
    deps.runs.getActiveByProvider(provider).map((session) => ({
      provider,
      runId: session.runId,
      appChatId: session.appChatId,
      status: session.status
    }))
  ).filter((session) => !chatIdFilter || session.appChatId === chatIdFilter)

  const chatIds = new Set<string>([
    ...sessions.map((session) => session.appChatId).filter(Boolean) as string[],
    ...queueJobs.map((job) => job.chatId).filter(Boolean) as string[]
  ])
  const chats = [...chatIds].map((chatId) => summarizeRunControlChat(deps, chatId))
  const runIds = new Set<string>([
    ...sessions.map((session) => session.runId).filter(Boolean) as string[],
    ...queueJobs.map((job) => job.runId).filter(Boolean)
  ])
  const events = includeEvents
    ? [...runIds].flatMap((runId) =>
        deps.runs
          .getRunEvents({ runId })
          .slice(-eventLimit)
          .map((event) => summarizeRunControlEvent(event))
      )
    : undefined

  return {
    ok: true,
    providers,
    counts: {
      activeSessions: sessions.length,
      activeQueueJobs: queueJobs.length,
      chats: chats.length
    },
    activeSessions: sessions,
    queueJobs: queueJobs.map(summarizeRunControlQueueJob),
    chats,
    events
  }
}

export async function executeCancelActiveRun(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const provider = requireSelectableProvider(args.provider)
  requireNonEmptyString(args.intent, 'Intent')
  const runId = optionalString(args.runId || args.appRunId)
  const chatId = optionalString(args.chatId || args.appChatId) || context.appChatId
  const activeSessions = deps.runs
    .getActiveByProvider(provider)
    .filter((session) => !runId || session.runId === runId)
    .filter((session) => !chatId || session.appChatId === chatId)
  const queueJobs = deps.store
    .getRunQueueJobs(chatId ? { chatId } : undefined)
    .filter((job) => job.provider === provider)
    .filter((job) => !runId || job.runId === runId)
    .filter((job) => isActiveRunQueueStatus(job.status))
  const candidates = dedupeRunControlTargets([
    ...activeSessions.map((session) => ({
      provider,
      runId: session.runId,
      appChatId: session.appChatId,
      source: 'active_session' as const
    })),
    ...queueJobs.map((job) => ({
      provider,
      runId: job.runId,
      appChatId: job.chatId,
      source: 'queue_job' as const
    }))
  ])

  if (candidates.length === 0) {
    return {
      ok: false,
      provider,
      runId,
      chatId,
      message: 'No matching active TaskWraith run was found.'
    }
  }
  if (candidates.length > 1 && !runId) {
    return {
      ok: false,
      provider,
      chatId,
      matches: candidates,
      message: 'Multiple active runs match. Pass runId to cancel exactly one run.'
    }
  }

  const target = candidates[0]
  const ok = await deps.runs.cancelProviderRun(provider, target.runId)
  return {
    ok,
    provider,
    runId: target.runId,
    chatId: target.appChatId,
    source: target.source,
    message: ok ? 'Cancellation requested.' : 'TaskWraith could not cancel the matched run.'
  }
}

export function executeListSubthreads(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext,
  args: Record<string, any>
) {
  const parentChatId = optionalString(args.parentChatId) || context.appChatId
  if (!parentChatId || parentChatId !== context.appChatId) {
    throw new Error('list_subthreads can only read sub-threads for the active parent chat.')
  }
  const includeArchived = args.includeArchived === true
  const includePrompt = args.includePrompt === true
  const subthreads = deps.store
    .getChildChats(parentChatId)
    .filter((chat) => includeArchived || !chat.archived)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((chat) => {
      const lifecycle = subThreadLifecycle(deps, chat)
      const latestAssistant = latestAssistantMessage(chat)
      return {
        id: chat.appChatId,
        title: chat.title,
        provider: chat.provider,
        status: lifecycle.state,
        lifecycle,
        readyToRead:
          lifecycle.resultAvailable &&
          (lifecycle.state === 'completed' || lifecycle.state === 'returned'),
        archived: chat.archived,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        workspaceId: chat.workspaceId,
        workspacePath: chat.workspacePath,
        delegationContext: chat.delegationContext
          ? {
              createdAt: chat.delegationContext.createdAt,
              parentProvider: chat.delegationContext.parentProvider,
              returnResultToParent: chat.delegationContext.returnResultToParent,
              resultReturnedAt: chat.delegationContext.resultReturnedAt,
              dispatchError: chat.delegationContext.dispatchError,
              delegationPromptPreview: chat.delegationContext.delegationPrompt.slice(0, 500),
              ...(includePrompt
                ? { delegationPrompt: chat.delegationContext.delegationPrompt }
                : {})
            }
          : undefined,
        latestRun: summarizeChatRun(latestChatRun(chat)),
        latestAssistantPreview: latestAssistant?.content?.slice(0, 500),
        messageCount: chat.messages?.length || 0,
        runCount: chat.runs?.length || 0
      }
    })
  return {
    parentChatId,
    count: subthreads.length,
    subthreads
  }
}

export function executeReadSubthreadResult(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext,
  args: Record<string, any>
) {
  const chat = assertOwnedSubThread(deps, context, String(args.subThreadId || args.id || ''))
  const assistant = latestAssistantMessage(chat)
  const messageLimit = clampInteger(args.messageLimit ?? args.maxMessages, 20, 1, 200)
  const requestedDepth = optionalString(args.depth) || 'final-only'
  const depth = ['summary', 'final-only', 'full', 'events-only'].includes(requestedDepth)
    ? requestedDepth
    : 'final-only'
  const includeRuns = args.includeRuns === true || depth === 'full'
  const includeMessages = args.includeMessages === true || depth === 'full'
  const includeEvents = args.includeEvents === true || depth === 'full' || depth === 'events-only'
  const includeResult = depth !== 'summary' && depth !== 'events-only'
  const eventLimit = clampInteger(args.eventLimit, 50, 1, 500)
  const lifecycle = subThreadLifecycle(deps, chat)
  const runEvents = includeEvents
    ? (chat.runs || [])
        .flatMap((run) => deps.runs.getRunEvents({ runId: run.runId, limit: eventLimit }))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-eventLimit)
    : undefined
  return {
    id: chat.appChatId,
    title: chat.title,
    provider: chat.provider,
    status: lifecycle.state,
    lifecycle,
    depth,
    readyToRead:
      lifecycle.resultAvailable &&
      (lifecycle.state === 'completed' || lifecycle.state === 'returned'),
    archived: chat.archived,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    delegationContext: chat.delegationContext
      ? {
          createdAt: chat.delegationContext.createdAt,
          parentProvider: chat.delegationContext.parentProvider,
          returnResultToParent: chat.delegationContext.returnResultToParent,
          resultReturnedAt: chat.delegationContext.resultReturnedAt,
          dispatchError: chat.delegationContext.dispatchError
        }
      : undefined,
    latestRun: summarizeChatRun(latestChatRun(chat)),
    latestAssistantMessage:
      includeResult && assistant
        ? assistant
        : assistant
          ? {
              id: assistant.id,
              role: assistant.role,
              timestamp: assistant.timestamp,
              runId: assistant.runId,
              metadata: assistant.metadata,
              contentPreview: assistant.content.slice(0, 500)
            }
          : null,
    result: includeResult ? assistant?.content || null : undefined,
    resultPreview: assistant?.content?.slice(0, 500) || null,
    messageCount: chat.messages?.length || 0,
    runCount: chat.runs?.length || 0,
    runs: includeRuns ? (chat.runs || []).map((run) => summarizeChatRun(run)) : undefined,
    messages: includeMessages
      ? (chat.messages || []).slice(-messageLimit).map((message) => ({
          id: message.id,
          role: message.role,
          timestamp: message.timestamp,
          runId: message.runId,
          metadata: message.metadata,
          content: message.content
        }))
      : undefined,
    runEvents
  }
}

export async function executeCancelSubthread(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext,
  args: Record<string, any>
) {
  const chat = assertOwnedSubThread(deps, context, String(args.subThreadId || args.id || ''))
  const provider = chat.provider || 'gemini'
  const activeSession = deps.runs
    .getActiveByProvider(provider)
    .find((session) => session.appChatId === chat.appChatId)
  const activeQueueJob = deps.store.getRunQueueJobs({ chatId: chat.appChatId }).find(
    (job) =>
      job.status === 'queued' ||
      job.status === 'paused' ||
      job.status === 'starting' ||
      job.status === 'active'
  )
  const activeRun = [...(chat.runs || [])]
    .reverse()
    .find(
      (run) =>
        run.status === 'running' ||
        run.status === 'queued' ||
        run.status === 'starting' ||
        run.status === 'active'
    )
  const runId = activeSession?.runId || activeQueueJob?.runId || activeRun?.runId
  if (!runId) {
    return {
      ok: false,
      message: 'Sub-thread has no active running run.',
      subThreadId: chat.appChatId
    }
  }
  const ok = await deps.runs.cancelProviderRun(provider, runId)
  if (ok) {
    const endedAt = new Date().toISOString()
    const updated: ChatRecord = {
      ...chat,
      runs: (chat.runs || []).map((run) =>
        run.runId === runId
          ? { ...run, status: 'cancelled', cancelled: true, endedAt: run.endedAt || endedAt }
          : run
      ),
      updatedAt: Date.now()
    }
    deps.runs.saveAndBroadcastChat(updated)
  }
  return {
    ok,
    subThreadId: chat.appChatId,
    runId,
    provider,
    previousStatus: activeSession?.status || activeQueueJob?.status || activeRun?.status || 'unknown'
  }
}

export async function executeWorkspaceSymbols(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string
) {
  const query = String(args.query || '')
    .trim()
    .toLowerCase()
  const targetPath = resolveMcpScopedPath(context, String(args.path || '.'), {
    allowWorkspaceRoot: true
  })
  const pattern =
    '^\\s*(?:(?:export|public|private|internal|open|final|static)\\s+)*(class|function|interface|type|enum|const|let|var|struct|actor|protocol|func)\\s+[A-Za-z_][A-Za-z0-9_]*'
  const result = await runCommandArgs(
    deps,
    [
      'rg',
      '--line-number',
      '--column',
      '--hidden',
      '--glob',
      '!.git/**',
      '--glob',
      '!node_modules/**',
      pattern,
      targetPath
    ],
    cwd,
    60_000
  )
  const symbols = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 1000)
    .map((line) => {
      const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/)
      const text = match?.[4]?.trim() || line
      const name = text.match(
        /\b(?:class|function|interface|type|enum|const|let|var|struct|actor|protocol|func)\s+([A-Za-z_][A-Za-z0-9_]*)/
      )?.[1]
      return {
        path: match ? workspaceRelativeForContext(context, match[1]) : '',
        line: match ? Number(match[2]) : undefined,
        column: match ? Number(match[3]) : undefined,
        name,
        text
      }
    })
    .filter(
      (symbol) =>
        !query ||
        symbol.name?.toLowerCase().includes(query) ||
        symbol.text.toLowerCase().includes(query)
    )
  return {
    count: symbols.length,
    symbols: symbols.slice(0, clampInteger(args.maxResults ?? args.limit, 200, 1, 1000)),
    stderr: result.stderr
  }
}

export function resolveWorkspaceDirectory(
  workspacePath: string,
  requestedCwd?: string | null
): string {
  const workspaceRoot = resolve(workspacePath)
  const cwd =
    requestedCwd && requestedCwd.trim()
      ? isAbsolute(requestedCwd)
        ? resolve(requestedCwd)
        : resolve(workspaceRoot, requestedCwd)
      : workspaceRoot
  if (!isPathInsideWorkspace(workspaceRoot, cwd)) {
    throw new Error('Command cwd is outside the workspace.')
  }
  return cwd
}

export function resolveHostDirectory(baseCwd: string, requestedCwd?: string | null): string {
  return requestedCwd && requestedCwd.trim()
    ? isAbsolute(requestedCwd)
      ? resolve(requestedCwd)
      : resolve(baseCwd, requestedCwd)
    : resolve(baseCwd)
}

export function resolveScopedDirectory(
  scope: ChatScope,
  baseCwd: string,
  workspacePath: string | undefined,
  requestedCwd?: string | null
): string {
  return scope === 'global'
    ? resolveHostDirectory(baseCwd, requestedCwd)
    : resolveWorkspaceDirectory(workspacePath || baseCwd, requestedCwd)
}

export function resolveWorkspaceTarget(workspace: string, filePath: string): string {
  const workspaceRoot = resolve(workspace)
  const targetPath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath)
  if (!isPathInsideWorkspace(workspaceRoot, targetPath)) {
    throw new Error('Path is outside the workspace.')
  }
  return targetPath
}

export function resolveWorkspaceChild(workspace: string, filePath: string): string {
  const workspaceRoot = resolve(workspace)
  const targetPath = resolveWorkspaceTarget(workspaceRoot, filePath)
  const rel = relative(workspaceRoot, targetPath)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error('Path is outside the workspace.')
  }
  return targetPath
}

export function toWorkspaceRelativePath(workspace: string, targetPath: string): string {
  return relative(resolve(workspace), resolve(targetPath)).replace(/\\/g, '/')
}

export function resolveMcpPath(
  workspacePath: string,
  filePath: string,
  options: { allowWorkspaceRoot?: boolean } = {}
): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('A workspace path is required.')
  }
  return options.allowWorkspaceRoot
    ? resolveWorkspaceTarget(workspacePath, filePath)
    : resolveWorkspaceChild(workspacePath, filePath)
}

export function resolveMcpScopedPath(
  context: WorkspaceToolContext,
  filePath: string,
  options: { allowWorkspaceRoot?: boolean } = {}
): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(
      context.scope === 'global' ? 'A host path is required.' : 'A workspace path is required.'
    )
  }
  if (context.scope === 'global') {
    return isAbsolute(filePath) ? resolve(filePath) : resolve(context.cwd, filePath)
  }
  return resolveMcpPath(context.workspacePath || context.cwd, filePath, options)
}

export function resolveMcpWorkspacePath(
  context: WorkspaceToolContext,
  filePath: string,
  options: { allowWorkspaceRoot?: boolean } = {}
): string {
  if (context.scope !== 'workspace') {
    throw new Error('This tool requires an active workspace.')
  }
  return resolveMcpScopedPath(context, filePath, options)
}

export function formatScopedPath(context: WorkspaceToolContext, targetPath: string): string {
  if (context.scope === 'global') return resolve(targetPath)
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  return isPathInsideWorkspace(workspaceRoot, targetPath)
    ? toWorkspaceRelativePath(workspaceRoot, targetPath)
    : resolve(targetPath)
}

export function workspaceRelativeForContext(
  context: WorkspaceToolContext,
  filePath: string
): string {
  if (!filePath) return ''
  try {
    return formatScopedPath(context, resolve(filePath))
  } catch {
    return filePath
  }
}

async function moveWorkspacePath(input: {
  context: WorkspaceToolContext
  sourcePath: string
  destinationPath: string
  overwrite: boolean
  createParents: boolean
  tool: 'move_path' | 'rename_path'
}) {
  const { context, sourcePath, destinationPath, overwrite, createParents, tool } = input
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw new Error(`${tool} source and destination must be different.`)
  }
  const sourceStat = await fs.lstat(sourcePath)
  if (sourceStat.isSymbolicLink()) throw new Error(`Symbolic links cannot be moved by ${tool}.`)
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw new Error(`${tool} source must be a file or directory.`)
  }
  const destinationParent = dirname(destinationPath)
  if (createParents) {
    await assertNearestExistingParentInsideWorkspace(context, destinationParent)
    await fs.mkdir(destinationParent, { recursive: true })
  } else {
    await assertDirectoryInsideWorkspace(context, destinationParent)
  }
  const destinationExists = await pathExists(destinationPath)
  if (destinationExists) {
    if (!overwrite) throw new Error(`${tool} destination already exists.`)
    const destinationStat = await fs.lstat(destinationPath)
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`${tool} will not overwrite a symbolic link.`)
    }
    if (destinationStat.isDirectory()) {
      await fs.rmdir(destinationPath)
    } else if (destinationStat.isFile()) {
      await fs.unlink(destinationPath)
    } else {
      throw new Error(`${tool} destination is not a file or directory.`)
    }
  }
  await fs.rename(sourcePath, destinationPath)
  return {
    ok: true,
    tool,
    from: workspaceRelativeForContext(context, sourcePath),
    to: workspaceRelativeForContext(context, destinationPath),
    kind: sourceStat.isDirectory() ? 'directory' : 'file',
    overwritten: destinationExists,
    createParents
  }
}

async function assertDirectoryInsideWorkspace(
  context: WorkspaceToolContext,
  directoryPath: string
): Promise<void> {
  assertPathInsideWorkspaceContext(context, directoryPath, { allowWorkspaceRoot: true })
  const lstat = await fs.lstat(directoryPath)
  if (lstat.isSymbolicLink()) throw new Error('Destination parent is a symbolic link.')
  if (!lstat.isDirectory()) throw new Error('Destination parent is not a directory.')
  await assertRealPathInsideWorkspace(context, directoryPath)
}

async function assertNearestExistingParentInsideWorkspace(
  context: WorkspaceToolContext,
  targetPath: string
): Promise<void> {
  assertPathInsideWorkspaceContext(context, targetPath, { allowWorkspaceRoot: true })
  let cursor = dirname(targetPath)
  while (true) {
    assertPathInsideWorkspaceContext(context, cursor, { allowWorkspaceRoot: true })
    try {
      const lstat = await fs.lstat(cursor)
      if (lstat.isSymbolicLink()) throw new Error('Path parent is a symbolic link.')
      if (!lstat.isDirectory()) throw new Error('Path parent is not a directory.')
      await assertRealPathInsideWorkspace(context, cursor)
      return
    } catch (error) {
      if (!isNodeErrnoException(error) || error.code !== 'ENOENT') throw error
      const next = dirname(cursor)
      if (next === cursor) throw error
      cursor = next
    }
  }
}

async function assertRealPathInsideWorkspace(
  context: WorkspaceToolContext,
  targetPath: string
): Promise<void> {
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  const [realWorkspace, realTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(targetPath)
  ])
  if (!isPathInsideWorkspace(realWorkspace, realTarget)) {
    throw new Error('Path resolves outside the workspace.')
  }
}

function assertPathInsideWorkspaceContext(
  context: WorkspaceToolContext,
  targetPath: string,
  options: { allowWorkspaceRoot?: boolean } = {}
): void {
  if (context.scope !== 'workspace') {
    throw new Error('This tool requires an active workspace.')
  }
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  const resolvedTarget = resolve(targetPath)
  if (
    !options.allowWorkspaceRoot &&
    (resolvedTarget === workspaceRoot || !isPathInsideWorkspace(workspaceRoot, resolvedTarget))
  ) {
    throw new Error('Path is outside the workspace.')
  }
  if (
    options.allowWorkspaceRoot &&
    resolvedTarget !== workspaceRoot &&
    !isPathInsideWorkspace(workspaceRoot, resolvedTarget)
  ) {
    throw new Error('Path is outside the workspace.')
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath)
    return true
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return false
    throw error
  }
}

export function extractUnifiedPatchPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (gitMatch) {
      paths.add(gitMatch[1])
      paths.add(gitMatch[2])
      continue
    }
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) continue
    const rawPath = line.slice(4).trim().split('\t')[0]
    if (!rawPath || rawPath === '/dev/null') continue
    paths.add(rawPath.replace(/^[ab]\//, ''))
  }
  return [...paths].filter(Boolean)
}

export function assertPatchPathsInScope(
  context: WorkspaceToolContext,
  cwd: string,
  patch: string
): string[] {
  const patchPaths = extractUnifiedPatchPaths(patch)
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  for (const patchPath of patchPaths) {
    if (isAbsolute(patchPath) || patchPath.split(/[\\/]+/).includes('..')) {
      throw new Error(`Patch path must stay inside the workspace: ${patchPath}`)
    }
    const resolvedPath = resolve(cwd, patchPath)
    if (context.scope !== 'global' && !isPathInsideWorkspace(workspaceRoot, resolvedPath)) {
      throw new Error(`Patch path is outside the workspace: ${patchPath}`)
    }
  }
  return patchPaths
}

export function summarizeTestOutput(output: string) {
  const lines = output.split(/\r?\n/)
  const failures: any[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (
      /\bFAIL\b/.test(line) ||
      /^\s*[\u00d7\u2717]\s+/.test(line) ||
      /AssertionError|XCTAssert|failed|Failure/i.test(line)
    ) {
      const location = line.match(
        /([A-Za-z0-9_./~ -]+\.(?:ts|tsx|js|jsx|swift|py|rs|go|java|kt|m|mm)):(\d+)(?::(\d+))?/
      )
      failures.push({
        line: index + 1,
        text: line.trim(),
        file: location?.[1],
        fileLine: location ? Number(location[2]) : undefined,
        column: location?.[3] ? Number(location[3]) : undefined,
        excerpt: lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join('\n')
      })
    }
    if (failures.length >= 50) break
  }
  const totals = {
    failed: failures.length,
    failedCount: Number(
      output.match(/(\d+)\s+(?:failed|failures?|failing)/i)?.[1] || failures.length || 0
    ),
    passedCount: Number(output.match(/(\d+)\s+(?:passed|passing)/i)?.[1] || 0),
    passedMentions: lines.filter((line) => /\b(pass|passed|\u2713)\b/i.test(line)).length
  }
  const status =
    totals.failed > 0 || totals.failedCount > 0
      ? 'failed'
      : totals.passedCount > 0 || totals.passedMentions > 0
        ? 'passed'
        : 'unknown'
  return {
    status,
    totals,
    failures,
    summary:
      status === 'failed'
        ? `${totals.failedCount || totals.failed} test failure(s) detected.`
        : status === 'passed'
          ? `${totals.passedCount || 'Some'} test(s) passed.`
          : 'No clear test result summary found.'
  }
}

export function mcpJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= MAX_MCP_TEXT_CHARS) return text
  return JSON.stringify(
    {
      truncated: true,
      originalLength: text.length,
      preview: text.slice(0, MAX_MCP_TEXT_CHARS)
    },
    null,
    2
  )
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function truncateText(value: string, max = MAX_MCP_TEXT_CHARS): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n...truncated ${value.length - max} chars`
}

function normalizeDiagnosticSourceMode(value: unknown, args: Record<string, any>): DiagnosticSourceMode {
  if (args.includeLint === true) return 'all'
  const source = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (source === 'eslint' || source === 'lint') return 'eslint'
  if (source === 'all' || source === 'both') return 'all'
  return 'typescript'
}

async function resolveDiagnosticsPathFilter(
  context: WorkspaceToolContext,
  value: unknown
): Promise<DiagnosticsPathFilter | undefined> {
  const rawPath = optionalString(value)
  if (!rawPath) return undefined
  const targetPath = resolveMcpWorkspacePath(context, rawPath, { allowWorkspaceRoot: true })
  const stat = await fs.stat(targetPath)
  return {
    targetPath,
    displayPath: formatScopedPath(context, targetPath),
    isDirectory: stat.isDirectory()
  }
}

function resolveDiagnosticTsconfigs(
  context: WorkspaceToolContext,
  projectValue: unknown
): string[] {
  const project = optionalString(projectValue)
  if (project) return [resolveMcpWorkspacePath(context, project)]
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  return DIAGNOSTIC_DEFAULT_TSCONFIGS.map((name) => join(workspaceRoot, name)).filter((path) =>
    fsSync.existsSync(path)
  )
}

function parseTypeScriptDiagnostics(
  output: string,
  context: WorkspaceToolContext
): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = []
  let current: WorkspaceDiagnostic | null = null
  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine)
    if (!line.trim()) continue
    const fileMatch = line.match(
      /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/
    )
    if (fileMatch) {
      current = {
        source: 'typescript',
        severity: fileMatch[4] === 'warning' ? 'warning' : 'error',
        path: normalizeDiagnosticPath(context, fileMatch[1]),
        line: Number(fileMatch[2]),
        column: Number(fileMatch[3]),
        code: `TS${fileMatch[5]}`,
        message: fileMatch[6].trim()
      }
      diagnostics.push(current)
      continue
    }
    const globalMatch = line.match(/^(error|warning)\s+TS(\d+):\s+(.*)$/)
    if (globalMatch) {
      current = {
        source: 'typescript',
        severity: globalMatch[1] === 'warning' ? 'warning' : 'error',
        code: `TS${globalMatch[2]}`,
        message: globalMatch[3].trim()
      }
      diagnostics.push(current)
      continue
    }
    if (current && /^\s+/.test(rawLine)) {
      current.message = `${current.message}\n${line.trim()}`
    }
  }
  return diagnostics
}

function parseEslintDiagnostics(output: string, context: WorkspaceToolContext): WorkspaceDiagnostic[] {
  const text = stripAnsi(output).trim()
  if (!text) return []
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const diagnostics: WorkspaceDiagnostic[] = []
  for (const fileResult of rows) {
    if (!isRecord(fileResult) || !Array.isArray(fileResult.messages)) continue
    const filePath = optionalString(fileResult.filePath)
    for (const message of fileResult.messages) {
      if (!isRecord(message)) continue
      const severityNumber = Number(message.severity || 0)
      diagnostics.push({
        source: 'eslint',
        severity: severityNumber >= 2 ? 'error' : severityNumber === 1 ? 'warning' : 'info',
        path: filePath ? normalizeDiagnosticPath(context, filePath) : undefined,
        line: finitePositiveInteger(message.line),
        column: finitePositiveInteger(message.column),
        endLine: finitePositiveInteger(message.endLine),
        endColumn: finitePositiveInteger(message.endColumn),
        code: optionalString(message.ruleId),
        message: String(message.message || '').trim() || 'ESLint reported a problem.'
      })
    }
  }
  return diagnostics
}

function filterDiagnosticsByPath(
  diagnostics: WorkspaceDiagnostic[],
  context: WorkspaceToolContext,
  filter?: DiagnosticsPathFilter
): WorkspaceDiagnostic[] {
  if (!filter) return diagnostics
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  return diagnostics.filter((diagnostic) => {
    if (!diagnostic.path) return false
    const diagnosticPath = isAbsolute(diagnostic.path)
      ? resolve(diagnostic.path)
      : resolve(workspaceRoot, diagnostic.path)
    if (filter.isDirectory) {
      const rel = relative(filter.targetPath, diagnosticPath)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    }
    return resolve(diagnosticPath) === resolve(filter.targetPath)
  })
}

function dedupeDiagnostics(diagnostics: WorkspaceDiagnostic[]): WorkspaceDiagnostic[] {
  const seen = new Set<string>()
  const deduped: WorkspaceDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.path || '',
      diagnostic.line || '',
      diagnostic.column || '',
      diagnostic.code || '',
      diagnostic.message
    ].join('\0')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(diagnostic)
  }
  return deduped
}

function normalizeDiagnosticPath(context: WorkspaceToolContext, rawPath: string): string | undefined {
  const trimmed = rawPath.trim()
  if (!trimmed) return undefined
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed)
  if (isPathInsideWorkspace(workspaceRoot, resolvedPath)) {
    return toWorkspaceRelativePath(workspaceRoot, resolvedPath)
  }
  const home = process.env.HOME ? resolve(process.env.HOME) : ''
  if (home && isPathInsideWorkspace(home, resolvedPath)) {
    return `~/${relative(home, resolvedPath).replace(/\\/g, '/')}`
  }
  return trimmed
}

function redactDiagnosticCommand(command: string[], context: WorkspaceToolContext): string[] {
  return command.map((part) => {
    if (!isAbsolute(part)) return part
    return formatScopedPath(context, part) || '.'
  })
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function finitePositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

function sanitizeGitRef(value: unknown): string {
  const ref = requireNonEmptyString(value, 'Git ref')
  if (
    ref.startsWith('-') ||
    ref.includes('\0') ||
    /\s/.test(ref) ||
    ref.length > 160 ||
    !/^[A-Za-z0-9._/@:+~^-]+$/.test(ref)
  ) {
    throw new Error('Git ref contains unsupported characters.')
  }
  return ref
}

function sanitizeGitRemote(value: unknown): string {
  const remote = requireNonEmptyString(value, 'Git remote')
  if (
    remote.startsWith('-') ||
    remote.includes('\0') ||
    /\s/.test(remote) ||
    remote.length > 120 ||
    !/^[A-Za-z0-9._/-]+$/.test(remote)
  ) {
    throw new Error('Git remote contains unsupported characters.')
  }
  return remote
}

function redactGitCreatePrCommand(command: string[]): string[] {
  const redacted: string[] = []
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index]
    redacted.push(part)
    if (part === '--title' || part === '--body') {
      index += 1
      redacted.push(part === '--title' ? '[title]' : '[body]')
    }
  }
  return redacted
}

function parseGitCommitLine(line: string): Record<string, unknown> | null {
  if (!line.includes(GIT_FIELD_SEPARATOR)) return null
  const [hash, shortHash, authorName, authorEmail, date, ...subjectParts] =
    line.split(GIT_FIELD_SEPARATOR)
  if (!hash) return null
  return {
    hash,
    shortHash,
    authorName,
    authorEmail,
    date,
    subject: subjectParts.join(GIT_FIELD_SEPARATOR)
  }
}

function parseGitLogEntries(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseGitCommitLine(line.trim()))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || ''
}

function redactGitLogCommand(command: string[]): string[] {
  return command.map((part, index) => {
    const previous = command[index - 1]
    if (previous === '--grep') return '[grep]'
    if (previous === '--author') return '[author]'
    return part
  })
}

function parseGitBlamePorcelain(
  stdout: string,
  context: WorkspaceToolContext
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  let current: Record<string, unknown> | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const header = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+\d+)?$/i)
    if (header) {
      current = {
        hash: header[1],
        originalLine: Number(header[2]),
        finalLine: Number(header[3])
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('author ')) {
      current.author = line.slice('author '.length)
      continue
    }
    if (line.startsWith('author-mail ')) {
      current.authorMail = line.slice('author-mail '.length).replace(/^<|>$/g, '')
      continue
    }
    if (line.startsWith('author-time ')) {
      current.authorTime = Number(line.slice('author-time '.length))
      continue
    }
    if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length)
      continue
    }
    if (line.startsWith('filename ')) {
      const filename = line.slice('filename '.length)
      const filenamePath = isAbsolute(filename)
        ? filename
        : resolve(context.workspacePath || context.cwd, filename)
      current.path = workspaceRelativeForContext(context, filenamePath)
      continue
    }
    if (line.startsWith('\t')) {
      entries.push({
        ...current,
        content: line.slice(1)
      })
      current = null
    }
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(value && typeof value === 'object' && 'code' in value)
}

async function runCommandArgs(
  deps: WorkspaceToolExecutorDependencies,
  command: string[],
  cwd: string,
  timeoutMs = 600_000
): Promise<HostCommandResult> {
  return deps.host.runHostCommand(command, cwd, timeoutMs)
}

async function readJsonFile(filePath: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

function commandResultExitCode(value: unknown): number | null {
  if (!isRecord(value)) return null
  return typeof value.exitCode === 'number' || value.exitCode === null ? value.exitCode : null
}

function latestAssistantMessage(chat: ChatRecord): ChatMessage | undefined {
  return [...(chat.messages || [])].reverse().find((message) => message.role === 'assistant')
}

function latestChatRun(chat: ChatRecord): ChatRun | undefined {
  return [...(chat.runs || [])].reverse()[0]
}

function summarizeChatRun(run?: ChatRun) {
  if (!run) return null
  return {
    runId: run.runId,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    requestedModel: run.requestedModel,
    actualModel: run.actualModel,
    approvalMode: run.approvalMode,
    providerThreadId: run.providerThreadId,
    providerRunId: run.providerRunId,
    cancelled: run.cancelled === true,
    runtimeProfileId: run.runtimeProfileId,
    geminiAuthProfileId: run.geminiAuthProfileId
  }
}

function resolveRunControlProviders(value: unknown): ProviderId[] {
  const raw = optionalString(value)
  if (!raw) return [...RUN_CONTROL_PROVIDER_IDS]
  return [requireSelectableProvider(raw)]
}

function requireSelectableProvider(value: unknown): ProviderId {
  const provider = optionalString(value)
  if (provider && RUN_CONTROL_PROVIDER_IDS.includes(provider as ProviderId)) {
    return provider as ProviderId
  }
  throw new Error('Provider is required and must be a known TaskWraith provider.')
}

function isActiveRunQueueStatus(status: RunQueueJob['status']): boolean {
  return (
    status === 'queued' ||
    status === 'steer_promoting' ||
    status === 'starting' ||
    status === 'active' ||
    status === 'paused' ||
    status === 'cancelling'
  )
}

function summarizeRunControlQueueJob(job: RunQueueJob) {
  return {
    id: job.id,
    runId: job.runId,
    provider: job.provider,
    status: job.status,
    source: job.source,
    scope: job.scope,
    chatId: job.chatId,
    workspaceId: job.workspaceId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    pausedAt: job.pausedAt,
    processPid: job.processPid,
    runtimeProfileId: job.runtimeProfileId,
    promptPreview: job.promptPreview,
    statusReason: job.statusReason,
    lastError: job.lastError
  }
}

function summarizeRunControlChat(
  deps: WorkspaceToolExecutorDependencies,
  chatId: string
) {
  const chat = deps.store.getChat(chatId)
  if (!chat) return { chatId, found: false }
  return {
    chatId,
    found: true,
    title: chat.title,
    provider: chat.provider,
    scope: chat.scope,
    chatKind: chat.chatKind,
    workspaceId: chat.workspaceId,
    latestRun: summarizeChatRun(latestChatRun(chat))
  }
}

function summarizeRunControlEvent(event: RunEventRecord) {
  return {
    id: event.id,
    sequence: event.sequence,
    runId: event.runId,
    chatId: event.chatId,
    provider: event.provider,
    kind: event.kind,
    phase: event.phase,
    source: event.source,
    timestamp: event.timestamp,
    summary: event.summary
  }
}

function dedupeRunControlTargets<T extends { runId?: string; appChatId?: string; source: string }>(
  targets: T[]
): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const target of targets) {
    const key = `${target.runId || ''}\u0000${target.appChatId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(target)
  }
  return result
}

function isActiveSubThreadRunStatus(status: unknown): boolean {
  return (
    status === 'running' ||
    status === 'queued' ||
    status === 'starting' ||
    status === 'active' ||
    status === 'paused'
  )
}

function isCompletedSubThreadRunStatus(status: unknown): boolean {
  return status === 'success' || status === 'success_with_warnings' || status === 'completed'
}

function subThreadLifecycle(
  deps: WorkspaceToolExecutorDependencies,
  chat: ChatRecord
): {
  state: SubThreadLifecycleState
  runStatus: string
  activeRunId?: string
  latestRunId?: string
  returnedAt?: number
  resultAvailable: boolean
  canRecall: boolean
  canCancel: boolean
  reason?: string
} {
  const assistant = latestAssistantMessage(chat)
  const activeSession = (chat.provider ? deps.runs.getActiveByProvider(chat.provider) : []).find(
    (session) => session.appChatId === chat.appChatId
  )
  const activeQueueJob = deps.store.getRunQueueJobs({ chatId: chat.appChatId }).find((job) =>
    isActiveSubThreadRunStatus(job.status)
  )
  const latestRun = latestChatRun(chat)
  const rawStatus = activeSession?.status || activeQueueJob?.status || latestRun?.status || 'idle'
  const returnedAt = chat.delegationContext?.resultReturnedAt
  const assistantTimestamp = assistant ? Date.parse(assistant.timestamp) : NaN
  const latestAssistantReturned = Boolean(
    returnedAt &&
      assistant &&
      (!Number.isFinite(assistantTimestamp) || assistantTimestamp <= returnedAt)
  )
  const resultAvailable = Boolean(assistant?.content?.trim())
  const canCancel = Boolean(
    activeSession || activeQueueJob || isActiveSubThreadRunStatus(latestRun?.status)
  )
  const getSubThreadResumeSessionId =
    deps.runs.getSubThreadResumeSessionId || defaultGetSubThreadResumeSessionId
  const canRecall = Boolean(getSubThreadResumeSessionId(chat) && !canCancel && !chat.archived)

  if (canCancel) {
    return {
      state: 'running',
      runStatus: rawStatus,
      activeRunId: activeSession?.runId || activeQueueJob?.runId || latestRun?.runId,
      latestRunId: latestRun?.runId,
      resultAvailable,
      canRecall: false,
      canCancel
    }
  }
  if (latestAssistantReturned) {
    return {
      state: 'returned',
      runStatus: rawStatus,
      activeRunId: activeSession?.runId || activeQueueJob?.runId,
      latestRunId: latestRun?.runId,
      returnedAt,
      resultAvailable,
      canRecall,
      canCancel
    }
  }
  if (chat.delegationContext?.dispatchError) {
    return {
      state: 'failed',
      runStatus: rawStatus,
      latestRunId: latestRun?.runId,
      resultAvailable,
      canRecall,
      canCancel: false,
      reason: chat.delegationContext.dispatchError.message
    }
  }
  if (latestRun?.cancelled || latestRun?.status === 'cancelled') {
    return {
      state: 'cancelled',
      runStatus: rawStatus,
      latestRunId: latestRun.runId,
      resultAvailable,
      canRecall,
      canCancel: false
    }
  }
  if (latestRun?.status === 'failed' || latestRun?.status === 'error') {
    return {
      state: 'failed',
      runStatus: rawStatus,
      latestRunId: latestRun.runId,
      resultAvailable,
      canRecall,
      canCancel: false
    }
  }
  if (isCompletedSubThreadRunStatus(latestRun?.status)) {
    return {
      state: 'completed',
      runStatus: rawStatus,
      latestRunId: latestRun?.runId,
      resultAvailable,
      canRecall,
      canCancel: false
    }
  }
  return {
    state: 'created',
    runStatus: rawStatus,
    latestRunId: latestRun?.runId,
    resultAvailable,
    canRecall,
    canCancel: false
  }
}

function assertOwnedSubThread(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext,
  subThreadId: string
): ChatRecord {
  const chat = deps.store.getChat(requireNonEmptyString(subThreadId, 'Sub-thread id'))
  if (!chat || chat.parentChatId !== context.appChatId) {
    throw new Error('Sub-thread was not found under this parent chat.')
  }
  return chat
}
