import { randomBytes } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isPathInsideWorkspace } from '../AgenticPolicy'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import { isEphemeralFleetChildSettled } from '../SubThreadEphemeralFleet'
import { getSubThreadResumeSessionId as defaultGetSubThreadResumeSessionId } from '../SubThreadRecall'
import { summarizeSubThreadMailbox, type SubThreadMailbox } from '../SubThreadMailbox'
import {
  summarizeFleetWaveClaim,
  type FleetWaveClaimMap
} from '../SubThreadWaveClaims'
import {
  cancelPendingSubThreadWorkerEvents,
  summarizeSubThreadWorkerControl
} from '../SubThreadWorkerControl'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  ChatScope,
  ProviderId,
  RunEventFilter,
  RunEventRecord,
  RunQueueJob,
  TranscriptMediaRef,
  TranscriptMediaThumbnail
} from '../store/types'
import { sanitizeBlackboardMediaRefs } from '../blackboard/BlackboardMedia'
import {
  isTranscriptRasterImageMime,
  isTranscriptThumbnailMime,
  sniffImageMime
} from '../services/TranscriptMediaService'
import { GitService, type GitCiStatusInput } from '../services/GitService'
import {
  TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES,
  type TranscriptMediaAssetReadResult
} from '../services/TranscriptMediaAssetStore'
import { readScopedRegularFile } from '../ScopedPathAccess'
import type { McpToolExecutionResult } from './McpBridgeRuntime'
import {
  releaseScriptBlockReason,
  type ReleaseCommandApprovalSource,
  type ReleaseCommandCheckOptions
} from '../ReleaseCommandPolicy'
import type {
  ExternalPublishReceipt,
  ExternalPublishReceiptInput,
  ExternalPublishReceiptWriter
} from '../ExternalPublishReceiptLedger'
import { resolveToolDispatchContractStrict } from '../../shared/providerActionTaxonomy'
import {
  assertCommittedPathsCovered,
  nulSeparatedPaths,
  parseGitCommitSliceRequest,
  repoRelativePaths,
  resolveGitReportedPaths,
  type GitCommitSliceMode
} from './GitCommitSlice'

export interface HostCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
  timedOut: boolean
  durationMs: number
}

export interface HostCommandRunOptions {
  timeoutMs?: number
  releaseApproval?: ReleaseCommandCheckOptions
  /** Internal-only environment additions constructed by a governed executor. */
  environment?: Readonly<Record<string, string>>
}

export type HostCommandRunArgument = number | HostCommandRunOptions

export type BackgroundProcessSignal = 'SIGTERM' | 'SIGKILL'
export type BackgroundProcessStream = 'stdout' | 'stderr' | 'both'

export interface BackgroundProcessStartOptions {
  name?: string
  appChatId: string
  initialWaitMs: number
  maxInitialChars: number
  releaseApproval?: ReleaseCommandCheckOptions
}

export interface BackgroundProcessReadOptions {
  appChatId: string
  stdoutOffset?: number
  stderrOffset?: number
  maxChars: number
  stream: BackgroundProcessStream
}

export interface BackgroundProcessKillOptions {
  appChatId: string
  signal: BackgroundProcessSignal
}

export interface WorkspaceToolContext {
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appChatId?: string
  /** Re-check exact run + lock/path authority at the final mutation boundary. */
  assertMutationAuthorized?: () => void | Promise<void>
  /** Cheap post-verification cancellation/history check between mutation phases. */
  assertMutationStillLive?: () => void
}

export interface WorkspaceToolHostDependencies {
  runHostCommand: (
    command: string | string[],
    cwd: string,
    options?: HostCommandRunArgument
  ) => Promise<HostCommandResult>
  startBackgroundProcess?: (
    command: string,
    cwd: string,
    options: BackgroundProcessStartOptions
  ) => Promise<Record<string, unknown>>
  listBackgroundProcesses?: (filter: { appChatId: string }) => Record<string, unknown>
  readBackgroundProcess?: (
    processId: string,
    options: BackgroundProcessReadOptions
  ) => Record<string, unknown>
  killBackgroundProcess?: (
    processId: string,
    options: BackgroundProcessKillOptions
  ) => Promise<Record<string, unknown>>
  getTempDir: () => string
}

export interface WorkspaceToolStoreDependencies {
  getChat: (chatId: string) => ChatRecord | undefined
  getChildChats: (parentChatId: string) => ChatRecord[]
  getSubThreadMailbox: (parentChatId: string) => SubThreadMailbox
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
  externalPublishReceipts?: Pick<ExternalPublishReceiptWriter, 'begin' | 'complete'>
  /**
   * Resolve a session release lease into an approval for a release-class
   * command on this route. Absent (or returning undefined) leaves the release
   * gate closed exactly as before.
   */
  releaseApprovalFor?: (input: {
    command?: unknown
    commandClass?: string
    source: ReleaseCommandApprovalSource
    workspacePath?: string
  }) => ReleaseCommandCheckOptions | undefined
  gitService?: Pick<GitService, 'ciStatus'>
  media?: {
    readTranscriptMediaAsset: (input: {
      sha256: string
      mimeType: string
      /** Canonical main-owned active chat whose grant must authorize this read. */
      appChatId: string
      maxBytes?: number
    }) => TranscriptMediaAssetReadResult
  }
}

type AgentExternalPublishReceiptInput = Omit<
  ExternalPublishReceiptInput,
  'origin' | 'decision' | 'reason'
>

type BeginAgentExternalPublishReceiptResult =
  | { ok: true; receipt: ExternalPublishReceipt | null }
  | { ok: false; error: string }

async function beginAgentExternalPublishReceipt(
  deps: WorkspaceToolExecutorDependencies,
  input: AgentExternalPublishReceiptInput
): Promise<BeginAgentExternalPublishReceiptResult> {
  if (!deps.externalPublishReceipts) return { ok: true, receipt: null }
  try {
    const receipt = await deps.externalPublishReceipts.begin({
      ...input,
      origin: 'agent',
      decision: 'allowed',
      reason: 'Agent external publishing passed TaskWraith external-publish policy.'
    })
    if (receipt.decision === 'denied') {
      return {
        ok: false,
        error: receipt.reason || 'External publishing is blocked by policy.'
      }
    }
    return { ok: true, receipt }
  } catch (err) {
    return {
      ok: false,
      error: `External publishing receipt could not be recorded: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }
}

async function completeAgentExternalPublishReceipt(
  deps: WorkspaceToolExecutorDependencies,
  receipt: ExternalPublishReceipt | null,
  input: Omit<Parameters<ExternalPublishReceiptWriter['complete']>[0], 'id'>
): Promise<void> {
  if (!deps.externalPublishReceipts || !receipt?.id) return
  try {
    await deps.externalPublishReceipts.complete({ id: receipt.id, ...input })
  } catch {
    // Best effort after the side effect has already completed. The initial
    // begin() receipt is fail-closed above.
  }
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
  'github_ci_status',
  'run_task',
  'start_background_process',
  'list_background_processes',
  'read_background_process',
  'kill_background_process',
  'get_diagnostics',
  'list_active_runs',
  'cancel_active_run',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'list_subthreads',
  'read_subthread_result',
  'cancel_subthread',
  'workspace_symbols'
] as const

export type WorkspaceMcpToolName = (typeof WORKSPACE_MCP_TOOL_NAMES)[number]

export interface WorkspaceMcpToolExecution {
  result: unknown
  isError: boolean
  richResult?: McpToolExecutionResult
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
  executeGitCommit: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitPush: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeGitCreatePr: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeGithubCiStatus: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeRunTask: (args: Record<string, any>, cwd: string) => Promise<unknown>
  executeStartBackgroundProcess: (
    args: Record<string, any>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeListBackgroundProcesses: (
    context: WorkspaceToolContext
  ) => unknown
  executeReadBackgroundProcess: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => unknown
  executeKillBackgroundProcess: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<unknown>
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
  executeListChatAttachments: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => unknown
  executeInspectChatAttachment: (
    args: Record<string, any>,
    context: WorkspaceToolContext
  ) => Promise<McpToolExecutionResult>
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
type ChatAttachmentKind = 'image' | 'audio' | 'video' | 'file' | 'folder'
type ChatAttachmentSource =
  | 'message_image_path'
  | 'message_attachment'
  | 'message_media_ref'
  | 'blackboard_media_ref'
  | 'run_attachment'
type ChatAttachmentPathScope =
  | 'workspace'
  | 'external'
  | 'transcript_asset'
  | 'thumbnail_only'
  | 'missing'

interface ChatAttachmentEntry {
  attachmentId: string
  kind: ChatAttachmentKind
  source: ChatAttachmentSource
  name: string
  messageId?: string
  messageIndex?: number
  role?: ChatMessage['role']
  timestamp?: string
  runId?: string
  blackboardEntryId?: string
  blackboardKey?: string
  mimeType?: string
  status?: string
  path?: string
  workspaceRelativePath?: string
  pathScope: ChatAttachmentPathScope
  byteLength?: number
  sha256?: string
  assetId?: string
  hasThumbnail: boolean
  thumbnail?: TranscriptMediaThumbnail
  mediaRef?: TranscriptMediaRef
}

const CHAT_ATTACHMENT_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif'
])
const CHAT_ATTACHMENT_AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.flac'
])
const CHAT_ATTACHMENT_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv'
])

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
  'ollama',
  'antigravity',
  'pi',
  'mistral'
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
    executeGitCommit: (args, context, cwd) => executeGitCommit(deps, args, cwd, context),
    executeGitPush: (args, cwd) => executeGitPush(deps, args, cwd),
    executeGitCreatePr: (args, cwd) => executeGitCreatePr(deps, args, cwd),
    executeGithubCiStatus: (args, cwd) => executeGithubCiStatus(deps, args, cwd),
    executeRunTask: (args, cwd) => executeRunTask(deps, args, cwd),
    executeStartBackgroundProcess: (args, context, cwd) =>
      executeStartBackgroundProcess(deps, args, context, cwd),
    executeListBackgroundProcesses: (context) => executeListBackgroundProcesses(deps, context),
    executeReadBackgroundProcess: (args, context) =>
      executeReadBackgroundProcess(deps, args, context),
    executeKillBackgroundProcess: (args, context) =>
      executeKillBackgroundProcess(deps, args, context),
    executeGetDiagnostics: (args, context, cwd) =>
      executeGetDiagnostics(deps, args, context, cwd),
    executeListActiveRuns: (args, context) => executeListActiveRuns(deps, args, context),
    executeCancelActiveRun: (args, context) => executeCancelActiveRun(deps, args, context),
    executeListChatAttachments: (args, context) =>
      executeListChatAttachments(deps, args, context),
    executeInspectChatAttachment: (args, context) =>
      executeInspectChatAttachment(deps, args, context),
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
  const dispatchContract = resolveToolDispatchContractStrict(toolName, args)
  if (
    dispatchContract.ok &&
    (dispatchContract.lock === 'workspace-paths' ||
      dispatchContract.lock === 'workspace-repository' ||
      dispatchContract.lock === 'workspace-runtime')
  ) {
    await context.assertMutationAuthorized?.()
  }
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
    const result = await executeGitCommit(deps, args, cwd, context)
    return { result, isError: result.exitCode !== 0 || result.timedOut === true }
  }
  if (toolName === 'git_push') {
    const result = await executeGitPush(deps, args, cwd, context)
    return {
      result,
      isError: result.ok === false || result.exitCode !== 0 || result.timedOut === true
    }
  }
  if (toolName === 'git_create_pr') {
    const result = await executeGitCreatePr(deps, args, cwd, context)
    return {
      result,
      isError: result.ok === false || result.exitCode !== 0 || result.timedOut === true
    }
  }
  if (toolName === 'github_ci_status') {
    const result = await executeGithubCiStatus(deps, args, cwd)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'run_task') {
    const result = await executeRunTask(deps, args, cwd, undefined, context)
    return {
      result,
      isError: (result.exitCode !== null && result.exitCode !== 0) || result.timedOut === true
    }
  }
  if (toolName === 'start_background_process') {
    const result = await executeStartBackgroundProcess(deps, args, context, cwd)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'list_background_processes') {
    return { result: executeListBackgroundProcesses(deps, context), isError: false }
  }
  if (toolName === 'read_background_process') {
    const result = executeReadBackgroundProcess(deps, args, context)
    return { result, isError: result.ok === false }
  }
  if (toolName === 'kill_background_process') {
    const result = await executeKillBackgroundProcess(deps, args, context)
    return { result, isError: result.ok === false }
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
  if (toolName === 'list_chat_attachments') {
    return { result: executeListChatAttachments(deps, args, context), isError: false }
  }
  if (toolName === 'inspect_chat_attachment') {
    const richResult = await executeInspectChatAttachment(deps, args, context)
    return {
      result: richResult.structuredContent ?? { ok: richResult.isError !== true },
      isError: richResult.isError === true,
      richResult
    }
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

export type WorkspaceSearchContextLine = {
  line: number | undefined
  text: string
}

export type WorkspaceSearchMatch = {
  path: string
  line: number | undefined
  column: number | undefined
  text: string
  submatches: unknown[]
  /** Present when contextLines > 0; adjacent non-matching lines before this hit. */
  contextBefore?: WorkspaceSearchContextLine[]
  /** Present when contextLines > 0; adjacent non-matching lines after this hit. */
  contextAfter?: WorkspaceSearchContextLine[]
}

/**
 * Parse rg --json stdout into structured matches, attaching --context lines when present.
 * rg emits separate `match` and `context` events; only collecting `match` drops adjacency.
 */
export function parseWorkspaceSearchRgJson(
  stdout: string,
  context: WorkspaceToolContext,
  options: { maxResults: number; contextLines: number }
): WorkspaceSearchMatch[] {
  const matches: WorkspaceSearchMatch[] = []
  let pendingBefore: WorkspaceSearchContextLine[] = []
  let openMatch: WorkspaceSearchMatch | null = null
  const wantContext = options.contextLines > 0

  const resetGroup = () => {
    openMatch = null
    pendingBefore = []
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'begin' || event.type === 'end') {
        resetGroup()
        continue
      }
      if (event.type === 'context') {
        if (!wantContext) continue
        const contextLine: WorkspaceSearchContextLine = {
          line: event.data?.line_number,
          text: String(event.data?.lines?.text || '').replace(/\r?\n$/, '')
        }
        if (openMatch) {
          openMatch.contextAfter = openMatch.contextAfter || []
          openMatch.contextAfter.push(contextLine)
        } else {
          pendingBefore.push(contextLine)
        }
        continue
      }
      if (event.type !== 'match') continue
      if (matches.length >= options.maxResults) break
      const match: WorkspaceSearchMatch = {
        path: workspaceRelativeForContext(context, String(event.data?.path?.text || '')),
        line: event.data?.line_number,
        column:
          typeof event.data?.submatches?.[0]?.start === 'number'
            ? event.data.submatches[0].start + 1
            : undefined,
        text: String(event.data?.lines?.text || '').replace(/\r?\n$/, ''),
        submatches: Array.isArray(event.data?.submatches) ? event.data.submatches : []
      }
      if (wantContext) {
        match.contextBefore = pendingBefore
        match.contextAfter = []
      }
      matches.push(match)
      openMatch = match
      pendingBefore = []
    } catch {
      // Ignore malformed rg JSON lines; stderr is returned separately.
    }
  }
  return matches
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
  const matches = parseWorkspaceSearchRgJson(result.stdout, context, {
    maxResults,
    contextLines
  })
  return {
    query,
    cwd,
    target: workspaceRelativeForContext(context, targetPath),
    contextLines,
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

/**
 * Prefer an actionable hint when agents send a Codex-style envelope
 * (`*** Begin Patch`) instead of a real git unified diff. Fail-closed: no write.
 */
export function applyPatchFailureMessage(
  patch: string,
  check: Pick<HostCommandResult, 'stderr' | 'stdout' | 'error'>
): string {
  const detail = `${check.stderr || ''}\n${check.stdout || ''}\n${check.error || ''}`
  const noValidPatches = /No valid patches/i.test(detail)
  const looksLikeCodexEnvelope =
    /^\*\*\*\s*(Begin Patch|Update File|Add File|Delete File|End Patch)/m.test(patch) ||
    patch.includes('*** Begin Patch')
  const looksLikeUnifiedDiff =
    /^(diff --git |--- |\+\+\+ |@@ )/m.test(patch) || /^Index:\s/m.test(patch)

  if (looksLikeCodexEnvelope && !looksLikeUnifiedDiff) {
    return (
      'Patch does not apply cleanly. apply_patch expects a real git unified diff ' +
      '(diff --git / --- a/ +++ b/ with @@ -old,count +new,count @@ hunk headers). ' +
      'Codex-style "*** Begin Patch" envelopes are not accepted — convert to unified diff first. ' +
      'No partial write was performed.'
    )
  }
  if (noValidPatches) {
    return (
      'Patch does not apply cleanly: no valid unified-diff hunks found. ' +
      'Use git unified diff format with numbered hunk headers (@@ -a,b +c,d @@) and a/ b/ paths. ' +
      'No partial write was performed.'
    )
  }
  return 'Patch does not apply cleanly.'
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
        message: applyPatchFailureMessage(patch, check)
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
    await context.assertMutationAuthorized?.()
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
    await context.assertMutationAuthorized?.()
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
    await context.assertMutationAuthorized?.()
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
  await context.assertMutationAuthorized?.()
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
      await context.assertMutationAuthorized?.()
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
  await context.assertMutationAuthorized?.()
  const result = await runCommandArgs(deps, gitArgs, cwd, 30_000)
  const status = await executeGitStatus(deps, cwd)
  return { command: gitArgs, result, status }
}

export async function executeGitCommit(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string,
  context: WorkspaceToolContext
) {
  const request = parseGitCommitSliceRequest(args)
  const declaredAbsolutePaths = request.paths.map((path) => resolveMcpScopedPath(context, path))
  await context.assertMutationAuthorized?.()

  const baseHeadResult = await runCommandArgs(deps, ['git', 'rev-parse', 'HEAD'], cwd, 30_000)
  if (hostCommandFailed(baseHeadResult)) {
    return failedGitCommitSlice(request.mode, 'read_head', baseHeadResult)
  }
  const baseHead = baseHeadResult.stdout.trim()
  const repoRootResult = await runCommandArgs(
    deps,
    ['git', 'rev-parse', '--show-toplevel'],
    cwd,
    30_000
  )
  if (hostCommandFailed(repoRootResult)) {
    return failedGitCommitSlice(request.mode, 'resolve_repository', repoRootResult)
  }
  const repoRoot = await canonicalizeCommitSlicePath(resolve(repoRootResult.stdout.trim()))
  const declaredCoveragePaths = await Promise.all(
    declaredAbsolutePaths.map((path) => canonicalizeCommitSlicePath(path))
  )

  if (request.mode === 'pathspec') {
    context.assertMutationStillLive?.()
    const result = await runCommandArgs(
      deps,
      ['git', 'commit', '--only', '-m', request.message, '--', ...declaredAbsolutePaths],
      cwd,
      60_000
    )
    if (hostCommandFailed(result)) return failedGitCommitSlice(request.mode, 'commit', result)
    return successfulGitCommitSlice(
      deps,
      request.mode,
      cwd,
      repoRoot,
      declaredCoveragePaths,
      result
    )
  }

  const tempRoot = await fs.mkdtemp(join(deps.host.getTempDir(), 'taskwraith-git-commit-'))
  const privateIndexPath = join(tempRoot, 'index')
  const patchPath = join(tempRoot, 'slice.patch')
  const environment = { GIT_INDEX_FILE: privateIndexPath }
  try {
    await fs.writeFile(patchPath, request.patch!, { encoding: 'utf8', mode: 0o600 })
    const readTree = await runCommandArgs(
      deps,
      ['git', 'read-tree', baseHead],
      cwd,
      30_000,
      undefined,
      environment
    )
    if (hostCommandFailed(readTree)) {
      return failedGitCommitSlice(request.mode, 'prepare_private_index', readTree)
    }
    const check = await runCommandArgs(
      deps,
      ['git', 'apply', '--cached', '--check', '--binary', '--', patchPath],
      cwd,
      30_000,
      undefined,
      environment
    )
    if (hostCommandFailed(check)) {
      return failedGitCommitSlice(request.mode, 'check_patch', check)
    }
    context.assertMutationStillLive?.()
    const apply = await runCommandArgs(
      deps,
      ['git', 'apply', '--cached', '--binary', '--', patchPath],
      cwd,
      30_000,
      undefined,
      environment
    )
    if (hostCommandFailed(apply)) {
      return failedGitCommitSlice(request.mode, 'apply_patch', apply)
    }
    const privateNames = await runCommandArgs(
      deps,
      ['git', 'diff', '--cached', '--name-only', '-z', '--'],
      cwd,
      30_000,
      undefined,
      environment
    )
    if (hostCommandFailed(privateNames)) {
      return failedGitCommitSlice(request.mode, 'inspect_private_index', privateNames)
    }
    const actualAbsolutePaths = resolveGitReportedPaths(
      repoRoot,
      nulSeparatedPaths(privateNames.stdout)
    )
    assertCommittedPathsCovered(declaredCoveragePaths, actualAbsolutePaths)

    const currentHead = await runCommandArgs(deps, ['git', 'rev-parse', 'HEAD'], cwd, 30_000)
    if (hostCommandFailed(currentHead)) {
      return failedGitCommitSlice(request.mode, 'recheck_head', currentHead)
    }
    if (currentHead.stdout.trim() !== baseHead) {
      throw new Error('Repository HEAD changed while the private commit slice was being prepared.')
    }

    context.assertMutationStillLive?.()
    const commit = await runCommandArgs(
      deps,
      ['git', 'commit', '-m', request.message],
      cwd,
      60_000,
      undefined,
      environment
    )
    if (hostCommandFailed(commit)) return failedGitCommitSlice(request.mode, 'commit', commit)

    // A private index advances HEAD without updating the shared index. Reset
    // only the paths that this slice actually committed; unrelated staged work
    // remains byte-for-byte owned by its original session.
    const resync = await runCommandArgs(
      deps,
      ['git', 'reset', '-q', 'HEAD', '--', ...actualAbsolutePaths],
      cwd,
      30_000
    )
    if (hostCommandFailed(resync)) {
      return failedGitCommitSlice(request.mode, 'resync_shared_index', resync, {
        committed: true
      })
    }
    return successfulGitCommitSlice(
      deps,
      request.mode,
      cwd,
      repoRoot,
      declaredCoveragePaths,
      commit
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function canonicalizeCommitSlicePath(path: string): Promise<string> {
  const missingSegments: string[] = []
  let cursor = resolve(path)
  while (true) {
    try {
      return resolve(await fs.realpath(cursor), ...missingSegments)
    } catch (error) {
      if (!isNodeErrnoException(error) || error.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missingSegments.unshift(basename(cursor))
      cursor = parent
    }
  }
}

function hostCommandFailed(result: HostCommandResult): boolean {
  return Boolean(
    result.error || result.timedOut || result.exitCode === null || result.exitCode !== 0
  )
}

function failedGitCommitSlice(
  mode: GitCommitSliceMode,
  stage: string,
  result: HostCommandResult,
  extra: Record<string, unknown> = {}
) {
  return {
    ok: false,
    mode,
    stage,
    ...extra,
    command: ['git', 'commit', '[slice]'],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr || result.error || '',
    timedOut: result.timedOut
  }
}

async function successfulGitCommitSlice(
  deps: WorkspaceToolExecutorDependencies,
  mode: GitCommitSliceMode,
  cwd: string,
  repoRoot: string,
  declaredAbsolutePaths: readonly string[],
  commitResult: HostCommandResult
) {
  const head = await runCommandArgs(deps, ['git', 'rev-parse', 'HEAD'], cwd, 30_000)
  if (hostCommandFailed(head)) return failedGitCommitSlice(mode, 'read_committed_head', head)
  const commit = head.stdout.trim()
  const names = await runCommandArgs(
    deps,
    ['git', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit],
    cwd,
    30_000
  )
  if (hostCommandFailed(names)) return failedGitCommitSlice(mode, 'inspect_commit', names)
  const actualAbsolutePaths = resolveGitReportedPaths(repoRoot, nulSeparatedPaths(names.stdout))
  assertCommittedPathsCovered(declaredAbsolutePaths, actualAbsolutePaths)
  return {
    ok: true,
    mode,
    commit,
    paths: repoRelativePaths(repoRoot, actualAbsolutePaths),
    command: ['git', 'commit', '[slice]'],
    exitCode: commitResult.exitCode,
    stdout: commitResult.stdout,
    stderr: commitResult.stderr,
    timedOut: commitResult.timedOut
  }
}

/**
 * Resolve the force flag. `--force-with-lease` is the safe default for a
 * branch, but it leases against the remote-tracking ref, and a tag normally has
 * none — so a tag force-move needs plain `--force` or it fails to lock the ref.
 * An explicit `forceMode` always wins; the resolved mode is reported back in the
 * result and the publish receipt so the escalation is never silent.
 */
function resolveGitPushForceMode(args: Record<string, any>, targetsTag: boolean): 'lease' | 'force' | null {
  const explicit = optionalString(args.forceMode)
  if (explicit === 'lease' || explicit === 'force') return explicit
  if (explicit) throw new Error("git_push forceMode must be 'lease' or 'force'.")
  if (args.force !== true) return null
  return targetsTag ? 'force' : 'lease'
}

export async function executeGitPush(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string,
  context?: WorkspaceToolContext
) {
  // An explicit refspec is what makes tag pushes and force-moves reachable at
  // all. Without one this reads the current branch and pushes that, which is
  // the historical behaviour — and the reason a release could not move a tag
  // through the receipt-minting path and fell back to a blocked raw shell.
  const requestedTag = optionalString(args.tag)
  const requestedRefspec = requestedTag
    ? `refs/tags/${requestedTag}`
    : optionalString(args.refspec || args.ref)
  const targetsTag = Boolean(requestedTag) || /^\+?refs\/tags\//.test(requestedRefspec || '')
  const forceMode = resolveGitPushForceMode(args, targetsTag)
  const remote = optionalString(args.remote) ? sanitizeGitRemote(args.remote) : undefined

  const forceArgs = forceMode === 'force' ? ['--force'] : forceMode === 'lease' ? ['--force-with-lease'] : []

  let safeBranch = ''
  let safeRefspec = ''
  let hasUpstream = false
  let upstreamText = ''
  let setUpstream = false
  let command: string[]

  if (requestedRefspec) {
    // A refspec push does not need a checked-out branch, so the detached-HEAD
    // refusal below deliberately does not apply to this path.
    safeRefspec = sanitizeGitRef(requestedRefspec)
    command = ['git', 'push', ...forceArgs, remote || 'origin', safeRefspec]
  } else {
    const branchResult = await runCommandArgs(deps, ['git', 'branch', '--show-current'], cwd, 30_000)
    const branch = branchResult.stdout.trim()
    if (branchResult.exitCode !== 0 || !branch) {
      return {
        ok: false,
        command: ['git', 'branch', '--show-current'],
        exitCode: branchResult.exitCode,
        timedOut: branchResult.timedOut,
        stderr: truncateText(branchResult.stderr, 20_000),
        error:
          branchResult.error ||
          'Cannot push from a detached HEAD. Create or switch to a branch first, or pass an explicit refspec/tag.'
      }
    }

    const upstreamResult = await runCommandArgs(
      deps,
      ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      cwd,
      30_000
    )
    hasUpstream = upstreamResult.exitCode === 0 && upstreamResult.stdout.trim().length > 0
    upstreamText = hasUpstream ? upstreamResult.stdout.trim() : ''
    setUpstream =
      args.setUpstream === true || args.upstream === true || !hasUpstream || Boolean(remote)
    safeBranch = sanitizeGitRef(branch)
    command = setUpstream
      ? ['git', 'push', ...forceArgs, '-u', remote || 'origin', safeBranch]
      : ['git', 'push', ...forceArgs]
  }

  const receiptResult = await beginAgentExternalPublishReceipt(deps, {
    action: 'gitPush',
    workspacePath: cwd,
    repoPath: cwd,
    remote: remote || (setUpstream || safeRefspec ? 'origin' : undefined),
    setUpstream,
    metadata: {
      branch: safeBranch,
      refspec: safeRefspec,
      targetsTag,
      forceMode: forceMode || 'none',
      upstream: upstreamText
    }
  })
  if (!receiptResult.ok) {
    return {
      ok: false,
      command,
      branch: safeBranch,
      upstream: upstreamText || undefined,
      refspec: safeRefspec || undefined,
      forceMode: forceMode || undefined,
      setUpstream,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: receiptResult.error
    }
  }
  await context?.assertMutationAuthorized?.()
  const result = await runCommandArgs(deps, command, cwd, 120_000, {
    allowReleaseCommand: true,
    approvalSource: 'externalPublishReceipt'
  })
  await completeAgentExternalPublishReceipt(deps, receiptResult.receipt, {
    outcome: result.exitCode === 0 && result.timedOut !== true && !result.error ? 'completed' : 'failed',
    ...(result.error || result.exitCode !== 0 || result.timedOut === true
      ? { error: result.error || result.stderr || `git push exited ${result.exitCode}` }
      : {})
  })
  const status = await executeGitStatus(deps, cwd)
  return {
    ok: result.exitCode === 0 && result.timedOut !== true && !result.error,
    command,
    branch: safeBranch,
    upstream: upstreamText || undefined,
    refspec: safeRefspec || undefined,
    forceMode: forceMode || undefined,
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
  cwd: string,
  context?: WorkspaceToolContext
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

  const redactedCommand = redactGitCreatePrCommand(command)
  const receiptResult = await beginAgentExternalPublishReceipt(deps, {
    action: 'githubCreatePr',
    workspacePath: cwd,
    repoPath: cwd,
    title,
    draft: args.draft === true,
    metadata: {
      base: base ? sanitizeGitRef(base) : '',
      head: head ? sanitizeGitRef(head) : '',
      fill: !title && !body && args.fill !== false
    }
  })
  if (!receiptResult.ok) {
    return {
      ok: false,
      command: redactedCommand,
      url: undefined,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: receiptResult.error
    }
  }
  await context?.assertMutationAuthorized?.()
  const result = await runCommandArgs(deps, command, cwd, 120_000, {
    allowReleaseCommand: true,
    approvalSource: 'externalPublishReceipt'
  })
  const url = result.stdout.match(/https?:\/\/[^\s]+/)?.[0]
  await completeAgentExternalPublishReceipt(deps, receiptResult.receipt, {
    outcome: result.exitCode === 0 && result.timedOut !== true && !result.error ? 'completed' : 'failed',
    ...(url ? { prUrl: url } : {}),
    ...(result.error || result.exitCode !== 0 || result.timedOut === true
      ? { error: result.error || result.stderr || `gh pr create exited ${result.exitCode}` }
      : {})
  })
  return {
    ok: result.exitCode === 0 && result.timedOut !== true && !result.error,
    command: redactedCommand,
    url,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr, 20_000),
    error: result.error
  }
}

export async function executeGithubCiStatus(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string
) {
  const pr = args.pr ?? args.pullRequest ?? args.pullRequestNumber
  const input: GitCiStatusInput = {
    repoPath: cwd,
    pr: typeof pr === 'number' ? pr : optionalString(pr),
    branch: optionalString(args.branch || args.headBranch || args.head),
    commitSha: optionalString(args.commitSha || args.sha || args.headSha),
    includeFailedLogs: args.includeFailedLogs === true || args.failedLogs === true,
    maxRuns: args.maxRuns ?? args.limit,
    maxFailedLogs: args.maxFailedLogs,
    maxLogChars: args.maxLogChars,
    repairAttempt: args.repairAttempt ?? args.attempt,
    maxRepairPushes: args.maxRepairPushes
  }
  const service = deps.gitService || new GitService()
  const result = await service.ciStatus(input)
  if (!result.ok) {
    return {
      ok: false,
      status: 'blocked',
      error: result.error,
      stderr: result.stderr
    }
  }
  return { ok: true, ...result.data }
}

export async function executeRunTask(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  cwd: string,
  releaseApproval?: ReleaseCommandCheckOptions,
  context?: WorkspaceToolContext
) {
  const task = requireNonEmptyString(args.task || args.script || args.name, 'Task')
  const taskArgs = toStringArray(args.args)
  const packageJson = await readJsonFile(join(cwd, 'package.json'))
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : null
  let command: string[]
  let effectiveApproval = releaseApproval
  if (scripts && task in scripts) {
    command = ['npm', 'run', task]
    const script = String(scripts[task] || '')
    // A release-class package script blocks on its NAME as well as its body, so
    // ask the lease about both: the caller-named script class first, then the
    // script body itself. An explicit approval from the caller still wins.
    effectiveApproval =
      effectiveApproval ||
      deps.releaseApprovalFor?.({
        commandClass: `package script ${task}`,
        source: 'approvedMcpTask',
        workspacePath: cwd
      }) ||
      deps.releaseApprovalFor?.({
        command: script,
        source: 'approvedMcpTask',
        workspacePath: cwd
      })
    const blockedReleaseScript = releaseScriptBlockReason(task, script, effectiveApproval)
    if (blockedReleaseScript) {
      return {
        task,
        command,
        cwd,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: blockedReleaseScript,
        error: blockedReleaseScript,
        summary: blockedReleaseScript
      }
    }
    const isVitestTestScript = task === 'test' && /\bvitest\b/.test(script)
    const scriptAlreadyRunsVitest =
      /\bvitest\b[^\n|;&]*\brun\b/.test(script) || /\s--run\b/.test(script)
    if (isVitestTestScript) {
      if (!scriptAlreadyRunsVitest) {
        command.push('--', '--run')
      } else if (taskArgs.length > 0) {
        command.push('--')
      }
    } else if (taskArgs.length > 0) {
      command.push('--')
    }
  } else if (task === 'test' && fsSync.existsSync(join(cwd, 'Package.swift'))) {
    command = ['swift', 'test']
  } else if (task === 'build' && fsSync.existsSync(join(cwd, 'Package.swift'))) {
    command = ['swift', 'build']
  } else {
    throw new Error(`No known task "${task}" in this workspace.`)
  }
  command.push(...taskArgs)
  const timeoutMs = clampInteger(args.timeoutMs, 600_000, 1_000, 30 * 60_000)
  await context?.assertMutationAuthorized?.()
  const result = await runCommandArgs(deps, command, cwd, timeoutMs, effectiveApproval)
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

export async function executeStartBackgroundProcess(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  cwd: string,
  releaseApproval?: ReleaseCommandCheckOptions
) {
  const startBackgroundProcess = deps.host.startBackgroundProcess
  if (!startBackgroundProcess) throw new Error('Background process host is not configured.')
  const appChatId = requireActiveChatIdForBackgroundTool(context, 'start_background_process')
  const command = requireNonEmptyString(args.command, 'Command')
  const processCwd = args.cwd
    ? resolveMcpWorkspacePath(context, String(args.cwd), { allowWorkspaceRoot: true })
    : cwd
  const initialWaitMs = clampInteger(args.initialWaitMs, 500, 0, 3000)
  const maxInitialChars = clampInteger(args.maxInitialChars ?? args.maxChars, 20_000, 1000, 100_000)
  await context.assertMutationAuthorized?.()
  return startBackgroundProcess(command, processCwd, {
    name: optionalString(args.name),
    appChatId,
    initialWaitMs,
    maxInitialChars,
    ...(releaseApproval ? { releaseApproval } : {})
  })
}

export function executeListBackgroundProcesses(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext
) {
  const listBackgroundProcesses = deps.host.listBackgroundProcesses
  if (!listBackgroundProcesses) throw new Error('Background process host is not configured.')
  const appChatId = requireActiveChatIdForBackgroundTool(context, 'list_background_processes')
  return listBackgroundProcesses({ appChatId })
}

export function executeReadBackgroundProcess(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const readBackgroundProcess = deps.host.readBackgroundProcess
  if (!readBackgroundProcess) throw new Error('Background process host is not configured.')
  const appChatId = requireActiveChatIdForBackgroundTool(context, 'read_background_process')
  const processId = requireNonEmptyString(args.processId || args.id, 'Process id')
  return readBackgroundProcess(processId, {
    appChatId,
    stdoutOffset: optionalNumber(args.stdoutOffset),
    stderrOffset: optionalNumber(args.stderrOffset),
    maxChars: clampInteger(args.maxChars ?? args.limit, 40_000, 1000, 120_000),
    stream: normalizeBackgroundProcessStream(args.stream)
  })
}

export async function executeKillBackgroundProcess(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const killBackgroundProcess = deps.host.killBackgroundProcess
  if (!killBackgroundProcess) throw new Error('Background process host is not configured.')
  const appChatId = requireActiveChatIdForBackgroundTool(context, 'kill_background_process')
  const processId = requireNonEmptyString(args.processId || args.id, 'Process id')
  return killBackgroundProcess(processId, {
    appChatId,
    signal: normalizeBackgroundProcessSignal(args.signal)
  })
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

export function executeListChatAttachments(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const chat = requireActiveChatForAttachmentTool(deps, context, 'list_chat_attachments')
  const includePaths = args.includePaths === true
  const limit = clampInteger(args.limit, 100, 1, 500)
  const kindFilter = normalizeAttachmentKindFilter(args.kind || args.kinds)
  const allEntries = collectChatAttachmentEntries(chat, context)
    .filter((entry) => kindFilter.size === 0 || kindFilter.has(entry.kind))
  const entries = allEntries.slice(0, limit)
  return {
    ok: true,
    tool: 'list_chat_attachments',
    chatId: chat.appChatId,
    title: chat.title,
    count: entries.length,
    totalAttachments: allEntries.length,
    truncated: allEntries.length > entries.length,
    attachments: entries.map((entry) => summarizeChatAttachmentEntry(entry, includePaths))
  }
}

export async function executeInspectChatAttachment(
  deps: WorkspaceToolExecutorDependencies,
  args: Record<string, any>,
  context: WorkspaceToolContext
): Promise<McpToolExecutionResult> {
  const chat = requireActiveChatForAttachmentTool(deps, context, 'inspect_chat_attachment')
  const attachmentId = requireNonEmptyString(args.attachmentId || args.id, 'Attachment id')
  const includeImage = args.includeImage !== false
  const includePath = args.includePath === true || args.includePaths === true
  const maxBytes = clampInteger(
    args.maxBytes,
    TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES,
    1,
    TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES
  )
  const entry = collectChatAttachmentEntries(chat, context).find(
    (candidate) => candidate.attachmentId === attachmentId
  )
  if (!entry) {
    return chatAttachmentRichJson({
      ok: false,
      tool: 'inspect_chat_attachment',
      error: `No attachment with id "${attachmentId}" was found in the active chat.`,
      attachmentId
    }, true)
  }

  const metadata = summarizeChatAttachmentEntry(entry, includePath)
  if (entry.kind !== 'image' || !includeImage) {
    return chatAttachmentRichJson({
      ok: true,
      tool: 'inspect_chat_attachment',
      attachment: metadata,
      imageReturned: false
    })
  }

  const image = await readChatAttachmentImage(
    deps,
    chat.appChatId,
    entry,
    maxBytes,
    canonicalChatAttachmentWorkspace(chat, context)
  )
  if (!image.ok) {
    return chatAttachmentRichJson({
      ok: false,
      tool: 'inspect_chat_attachment',
      attachment: metadata,
      error: image.reason,
      imageReturned: false
    }, true)
  }

  const structured = {
    ok: true,
    tool: 'inspect_chat_attachment',
    attachment: {
      ...metadata,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      variant: image.variant
    },
    imageReturned: true
  }
  return {
    text: JSON.stringify(structured, null, 2),
    structuredContent: structured,
    content: [{ type: 'image', mimeType: image.mimeType, data: image.dataBase64 }]
  }
}

function summarizeSubThreadCache(chat: ChatRecord) {
  const generation = chat.seatGeneration
  if (!generation) return undefined
  return {
    generationId: generation.id,
    ordinal: generation.ordinal,
    guaranteeTier: generation.guaranteeTier,
    transport: generation.config.transport,
    createdAt: generation.createdAt,
    updatedAt: generation.updatedAt,
    evidence: generation.cacheEvidence
      ? {
          state: generation.cacheEvidence.state,
          observedAt: generation.cacheEvidence.observedAt,
          runId: generation.cacheEvidence.runId,
          guaranteeTier: generation.cacheEvidence.guaranteeTier,
          cacheReadInputTokens: generation.cacheEvidence.cacheReadInputTokens,
          cacheCreationInputTokens: generation.cacheEvidence.cacheCreationInputTokens
        }
      : null
  }
}

function summarizeSubThreadWorkerActions(
  chat: ChatRecord,
  blocked: number,
  lifecycle: { canRecall: boolean; canCancel: boolean }
) {
  return {
    inspect: {
      tool: 'read_subthread_result',
      subThreadId: chat.appChatId,
      depth: 'events-only'
    },
    retry: {
      tool: 'delegate_to_subthread',
      subThreadId: chat.appChatId,
      available:
        blocked > 0 && !chat.archived && (lifecycle.canRecall || lifecycle.canCancel),
      requiresNewPrompt: true
    }
  }
}

/**
 * Per-wave settled rollup across ALL children, archived included. A
 * die-on-return fleet archives its finished workers, so an unarchived-only
 * listing cannot distinguish "wave finished" from "no wave ever ran"; the
 * rollup keeps settled waves visible to the polling parent agent.
 */
function summarizeSubThreadWaves(
  deps: WorkspaceToolExecutorDependencies,
  children: readonly ChatRecord[],
  options: { waveId?: string; nowMs?: number; claims?: FleetWaveClaimMap } = {}
) {
  const nowMs = options.nowMs ?? Date.now()
  const byWave = new Map<
    string,
    {
      waveId: string
      lifecycle: 'ephemeral' | 'durable'
      deadlineAt?: string
      total: number
      settled: number
      returned: number
      completed: number
      running: number
      failed: number
      cancelled: number
      live: boolean
    }
  >()
  for (const chat of children) {
    const groupId = chat.delegationContext?.joinPolicy?.groupId?.trim()
    if (!groupId) continue
    if (options.waveId && groupId !== options.waveId) continue
    const entry = byWave.get(groupId) ?? {
      waveId: groupId,
      lifecycle:
        chat.delegationContext?.lifecycle === 'ephemeral'
          ? ('ephemeral' as const)
          : ('durable' as const),
      deadlineAt: chat.delegationContext?.joinPolicy?.deadlineAt,
      total: 0,
      settled: 0,
      returned: 0,
      completed: 0,
      running: 0,
      failed: 0,
      cancelled: 0,
      live: false
    }
    entry.total += 1
    if (isEphemeralFleetChildSettled(chat)) {
      entry.settled += 1
    } else {
      // Same fail-open deadline reading as findLiveEphemeralFleetWave: an
      // unparseable deadline claims nothing, so a crashed wave reads settled-
      // pending rather than live forever.
      const deadlineMs = Date.parse(chat.delegationContext?.joinPolicy?.deadlineAt || '')
      if (Number.isFinite(deadlineMs) && deadlineMs > nowMs) entry.live = true
    }
    const state = subThreadLifecycle(deps, chat).state
    if (state === 'returned') entry.returned += 1
    else if (state === 'completed') entry.completed += 1
    else if (state === 'running') entry.running += 1
    else if (state === 'failed') entry.failed += 1
    else if (state === 'cancelled') entry.cancelled += 1
    byWave.set(groupId, entry)
  }
  return [...byWave.values()].map((wave) => {
    // Advisory only — a claim never gates a read here. An unclaimed wave is
    // reported as such so a peer can tell "free to pick up" from "someone is
    // already on it" without a second call.
    const claim = summarizeFleetWaveClaim(options.claims, wave.waveId, nowMs)
    return {
      ...wave,
      allSettled: wave.settled >= wave.total,
      claimed: Boolean(claim),
      ...(claim ? { claim } : {})
    }
  })
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
  const waveIdFilter = optionalString(args.waveId)
  // A waveId poll is a completion question — die-on-return fleets archive
  // their finished workers, so the poll must see archived returns.
  const includeArchived = args.includeArchived === true || Boolean(waveIdFilter)
  const includePrompt = args.includePrompt === true
  const parentMailboxState = deps.store.getSubThreadMailbox(parentChatId)
  const parentMailbox = summarizeSubThreadMailbox(parentMailboxState)
  const allChildren = deps.store.getChildChats(parentChatId)
  const scopedChildren = waveIdFilter
    ? allChildren.filter((chat) => chat.delegationContext?.joinPolicy?.groupId === waveIdFilter)
    : allChildren
  const visibleChildren = scopedChildren.filter((chat) => includeArchived || !chat.archived)
  const archivedHidden = scopedChildren.length - visibleChildren.length
  const parentClaims = deps.store.getChat(parentChatId)?.fleetWaveClaims
  const waves = summarizeSubThreadWaves(deps, allChildren, {
    waveId: waveIdFilter,
    claims: parentClaims
  })
  const subthreads = visibleChildren
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((chat) => {
      const lifecycle = subThreadLifecycle(deps, chat)
      const latestAssistant = latestAssistantMessage(chat)
      const workerControl = chat.delegationContext?.workerControl
        ? summarizeSubThreadWorkerControl(chat.delegationContext.workerControl)
        : undefined
      const mailbox = summarizeSubThreadMailbox(parentMailboxState, {
        subThreadId: chat.appChatId
      })
      const cache = summarizeSubThreadCache(chat)
      const workerActions = workerControl
        ? summarizeSubThreadWorkerActions(chat, workerControl.blocked, lifecycle)
        : undefined
      return {
        id: chat.appChatId,
        title: chat.title,
        provider: chat.provider,
        status: lifecycle.state,
        lifecycle,
        ...(chat.delegationContext?.joinPolicy?.groupId
          ? { waveId: chat.delegationContext.joinPolicy.groupId }
          : {}),
        ...(chat.delegationContext?.role ? { role: chat.delegationContext.role } : {}),
        ...(chat.delegationContext?.spawnedBy
          ? { spawnedBy: chat.delegationContext.spawnedBy }
          : {}),
        ...(chat.delegationContext?.label ? { label: chat.delegationContext.label } : {}),
        readyToRead:
          lifecycle.resultAvailable &&
          (lifecycle.state === 'completed' || lifecycle.state === 'returned'),
        archived: chat.archived,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        workspaceId: chat.workspaceId,
        workspacePath: chat.workspacePath,
        workerControl,
        ...(mailbox.retainedEvents > 0 ? { mailbox } : {}),
        ...(workerActions ? { workerActions } : {}),
        ...(cache ? { cache } : {}),
        delegationContext: chat.delegationContext
          ? {
              createdAt: chat.delegationContext.createdAt,
              parentProvider: chat.delegationContext.parentProvider,
              returnResultToParent: chat.delegationContext.returnResultToParent,
              resultReturnedAt: chat.delegationContext.resultReturnedAt,
              dispatchError: chat.delegationContext.dispatchError,
              lifecycle: chat.delegationContext.lifecycle,
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
    workerCount: subthreads.filter((subthread) => Boolean(subthread.workerControl)).length,
    blockedWorkerCount: subthreads.filter(
      (subthread) => (subthread.workerControl?.blocked || 0) > 0
    ).length,
    ...(archivedHidden > 0 ? { archivedHidden } : {}),
    ...(waves.length > 0 ? { waves } : {}),
    ...(parentMailbox.retainedEvents > 0 ? { mailbox: parentMailbox } : {}),
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
  const safeAssistant = assistant ? sanitizeSubthreadMessageForAgent(assistant) : undefined
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
  const workerControl = chat.delegationContext?.workerControl
    ? summarizeSubThreadWorkerControl(chat.delegationContext.workerControl)
    : undefined
  const mailbox = summarizeSubThreadMailbox(
    deps.store.getSubThreadMailbox(chat.parentChatId || context.appChatId || ''),
    { subThreadId: chat.appChatId }
  )
  const cache = summarizeSubThreadCache(chat)
  const workerActions = workerControl
    ? summarizeSubThreadWorkerActions(chat, workerControl.blocked, lifecycle)
    : undefined
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
    ...(chat.delegationContext?.joinPolicy?.groupId
      ? { waveId: chat.delegationContext.joinPolicy.groupId }
      : {}),
    ...(chat.delegationContext?.role ? { role: chat.delegationContext.role } : {}),
    ...(chat.delegationContext?.label ? { label: chat.delegationContext.label } : {}),
    depth,
    readyToRead:
      lifecycle.resultAvailable &&
      (lifecycle.state === 'completed' || lifecycle.state === 'returned'),
    archived: chat.archived,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    workerControl,
    ...(mailbox.retainedEvents > 0 ? { mailbox } : {}),
    ...(workerActions ? { workerActions } : {}),
    ...(cache ? { cache } : {}),
    delegationContext: chat.delegationContext
      ? {
          createdAt: chat.delegationContext.createdAt,
          parentProvider: chat.delegationContext.parentProvider,
          returnResultToParent: chat.delegationContext.returnResultToParent,
          resultReturnedAt: chat.delegationContext.resultReturnedAt,
          dispatchError: chat.delegationContext.dispatchError,
          lifecycle: chat.delegationContext.lifecycle
        }
      : undefined,
    latestRun: summarizeChatRun(latestChatRun(chat)),
    latestAssistantMessage:
      includeResult && safeAssistant
        ? safeAssistant
        : safeAssistant
          ? {
              id: safeAssistant.id,
              role: safeAssistant.role,
              timestamp: safeAssistant.timestamp,
              runId: safeAssistant.runId,
              metadata: safeAssistant.metadata,
              contentPreview: safeAssistant.content.slice(0, 500)
            }
          : null,
    result: includeResult ? assistant?.content || null : undefined,
    resultPreview: assistant?.content?.slice(0, 500) || null,
    messageCount: chat.messages?.length || 0,
    runCount: chat.runs?.length || 0,
    runs: includeRuns ? (chat.runs || []).map((run) => summarizeChatRun(run)) : undefined,
    messages: includeMessages
      ? (chat.messages || [])
          .filter((message) => !isRetiredExternalChannelInboundMessage(message))
          .slice(-messageLimit)
          .map((message) => {
            const safeMessage = sanitizeSubthreadMessageForAgent(message)
            return {
              id: safeMessage.id,
              role: safeMessage.role,
              timestamp: safeMessage.timestamp,
              runId: safeMessage.runId,
              metadata: safeMessage.metadata,
              content: safeMessage.content
            }
          })
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
  const cancellationReason = optionalString(args.reason) || 'Sub-thread cancellation requested.'
  const queuedCancellation = chat.delegationContext?.workerControl
    ? cancelPendingSubThreadWorkerEvents(chat.delegationContext.workerControl, {
        reason: cancellationReason
      })
    : null
  const chatWithQueueCancelled: ChatRecord = queuedCancellation?.cancelledEventIds.length
    ? {
        ...chat,
        delegationContext: chat.delegationContext
          ? {
              ...chat.delegationContext,
              workerControl: queuedCancellation.control
            }
          : chat.delegationContext,
        updatedAt: Date.now()
      }
    : chat
  if (chatWithQueueCancelled !== chat) {
    deps.runs.saveAndBroadcastChat(chatWithQueueCancelled)
  }
  const provider = chatWithQueueCancelled.provider || 'gemini'
  const activeSession = deps.runs
    .getActiveByProvider(provider)
    .find((session) => session.appChatId === chatWithQueueCancelled.appChatId)
  const activeQueueJob = deps.store.getRunQueueJobs({ chatId: chatWithQueueCancelled.appChatId }).find(
    (job) =>
      job.status === 'queued' ||
      job.status === 'paused' ||
      job.status === 'starting' ||
      job.status === 'active'
  )
  const activeRun = [...(chatWithQueueCancelled.runs || [])]
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
    if (queuedCancellation?.cancelledEventIds.length) {
      return {
        ok: true,
        message: 'Cancelled queued sub-thread follow-ups; there was no live provider turn to stop.',
        subThreadId: chatWithQueueCancelled.appChatId,
        cancelledQueuedFollowUps: queuedCancellation.cancelledEventIds.length
      }
    }
    return {
      ok: false,
      message: 'Sub-thread has no active running run.',
      subThreadId: chatWithQueueCancelled.appChatId,
      cancelledQueuedFollowUps: 0
    }
  }
  const ok = await deps.runs.cancelProviderRun(provider, runId)
  if (ok) {
    const endedAt = new Date().toISOString()
    const updated: ChatRecord = {
      ...chatWithQueueCancelled,
      runs: (chatWithQueueCancelled.runs || []).map((run) =>
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
    subThreadId: chatWithQueueCancelled.appChatId,
    runId,
    provider,
    previousStatus: activeSession?.status || activeQueueJob?.status || activeRun?.status || 'unknown',
    cancelledQueuedFollowUps: queuedCancellation?.cancelledEventIds.length || 0
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
  let mutationAuthorized = false
  const authorizeMutationPhase = async (): Promise<void> => {
    if (!mutationAuthorized) {
      await context.assertMutationAuthorized?.()
      mutationAuthorized = true
      return
    }
    context.assertMutationStillLive?.()
  }
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
    await authorizeMutationPhase()
    await fs.mkdir(destinationParent, { recursive: true })
  } else {
    await assertDirectoryInsideWorkspace(context, destinationParent)
  }
  const destinationExists = await pathExists(destinationPath)
  let removedEmptyDestinationDirectory = false
  if (destinationExists) {
    if (!overwrite) throw new Error(`${tool} destination already exists.`)
    const destinationStat = await fs.lstat(destinationPath)
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`${tool} will not overwrite a symbolic link.`)
    }
    if (!destinationStat.isDirectory() && !destinationStat.isFile()) {
      throw new Error(`${tool} destination is not a file or directory.`)
    }
    if (destinationStat.isDirectory()) {
      const entries = await fs.readdir(destinationPath)
      if (entries.length > 0) {
        throw new Error(`${tool} destination directory is not empty.`)
      }
      await authorizeMutationPhase()
      await fs.rmdir(destinationPath)
      removedEmptyDestinationDirectory = true
    }
  }
  try {
    await authorizeMutationPhase()
    await fs.rename(sourcePath, destinationPath)
  } catch (error) {
    if (removedEmptyDestinationDirectory) {
      try {
        await fs.mkdir(destinationPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${tool} failed and the empty destination directory could not be restored.`
        )
      }
    }
    throw error
  }
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
    const isPassingLine = /^\s*(?:\u2713|PASS\b)/.test(line)
    if (
      !isPassingLine &&
      (/\bFAIL\b/.test(line) ||
        /^\s*[\u00d7\u2717]\s+/.test(line) ||
        /AssertionError|XCTAssert/.test(line))
    ) {
      const location = line.match(
        /([A-Za-z0-9_./~ -]+\.(?:ts|tsx|js|jsx|swift|py|rs|go|java|kt|m|mm)):(\d+)(?::(\d+))?/
      )
      failures.push({
        line: index + 1,
        text: line.trim(),
        file: location?.[1]?.trim(),
        fileLine: location ? Number(location[2]) : undefined,
        column: location?.[3] ? Number(location[3]) : undefined,
        excerpt: lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join('\n')
      })
    }
    if (failures.length >= 50) break
  }
  const failedCountMatch = output.match(/(\d+)\s+(?:failed|failures?|failing)/i)
  const parsedFailedCount = failedCountMatch ? Number(failedCountMatch[1]) : undefined
  const totals = {
    failed: failures.length,
    failedCount: parsedFailedCount ?? failures.length,
    passedCount: Number(output.match(/(\d+)\s+(?:passed|passing)/i)?.[1] || 0),
    passedMentions: lines.filter((line) => /\b(pass|passed|\u2713)\b/i.test(line)).length
  }
  const status =
    totals.failed > 0 || (parsedFailedCount !== undefined && parsedFailedCount > 0)
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

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined
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

function requireActiveChatIdForBackgroundTool(
  context: WorkspaceToolContext,
  tool: string
): string {
  if (context.scope !== 'workspace') {
    throw new Error(`${tool} requires an active workspace.`)
  }
  if (!context.appChatId) {
    throw new Error(`${tool} requires an active chat.`)
  }
  return context.appChatId
}

function normalizeBackgroundProcessStream(value: unknown): BackgroundProcessStream {
  return value === 'stdout' || value === 'stderr' ? value : 'both'
}

function normalizeBackgroundProcessSignal(value: unknown): BackgroundProcessSignal {
  return value === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
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
  // eslint-disable-next-line no-control-regex -- ANSI escape bytes are exactly what this strips.
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
  timeoutMs = 600_000,
  releaseApproval?: ReleaseCommandCheckOptions,
  environment?: Readonly<Record<string, string>>
): Promise<HostCommandResult> {
  return deps.host.runHostCommand(
    command,
    cwd,
    releaseApproval || environment ? { timeoutMs, releaseApproval, environment } : timeoutMs
  )
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

function sanitizeSubthreadMessageMetadataForAgent(
  metadata: ChatMessage['metadata']
): ChatMessage['metadata'] | undefined {
  if (!metadata || typeof metadata !== 'object' || !('feedback' in metadata)) return metadata
  const next = { ...metadata }
  delete next.feedback
  return Object.keys(next).length > 0 ? next : undefined
}

function sanitizeSubthreadMessageForAgent(message: ChatMessage): ChatMessage {
  const metadata = sanitizeSubthreadMessageMetadataForAgent(message.metadata)
  const next = { ...message }
  if (metadata) {
    next.metadata = metadata
  } else {
    delete next.metadata
  }
  return next
}

function requireActiveChatForAttachmentTool(
  deps: WorkspaceToolExecutorDependencies,
  context: WorkspaceToolContext,
  tool: 'list_chat_attachments' | 'inspect_chat_attachment'
): ChatRecord {
  if (!context.appChatId) {
    throw new Error(`${tool} can only read attachments for the active chat.`)
  }
  const chat = deps.store.getChat(context.appChatId)
  if (!chat) throw new Error(`Active chat ${context.appChatId} was not found.`)
  if (chat.appChatId !== context.appChatId) {
    throw new Error(`Active chat ${context.appChatId} did not match its canonical record.`)
  }
  return chat
}

function normalizeAttachmentKindFilter(value: unknown): Set<ChatAttachmentKind> {
  const raw = Array.isArray(value) ? value : value ? [value] : []
  const allowed = new Set<ChatAttachmentKind>(['image', 'audio', 'video', 'file', 'folder'])
  return new Set(
    raw
      .map((item) => optionalString(item))
      .filter((item): item is ChatAttachmentKind => !!item && allowed.has(item as ChatAttachmentKind))
  )
}

function collectChatAttachmentEntries(
  chat: ChatRecord,
  context: WorkspaceToolContext
): ChatAttachmentEntry[] {
  const workspacePath = canonicalChatAttachmentWorkspace(chat, context)
  const entries: ChatAttachmentEntry[] = []
  const seen = new Set<string>()
  const pushEntry = (entry: ChatAttachmentEntry, aliasScoped = false) => {
    const key = aliasScoped
      ? `alias:${entry.attachmentId}`
      : entry.sha256 ||
        entry.assetId ||
        (entry.path ? `${entry.source}:${entry.path}` : entry.attachmentId)
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  ;(chat.messages || []).forEach((message, messageIndex) => {
    const metadata = message.metadata || {}
    const imageThumbnails = Array.isArray(metadata.imageThumbnails)
      ? metadata.imageThumbnails.map(normalizeAttachmentThumbnail)
      : []
    const imagePaths = Array.isArray(metadata.imagePaths) ? metadata.imagePaths : []
    imagePaths.forEach((value, index) => {
      const path = optionalString(value)
      if (!path) return
      const thumbnail = imageThumbnails[index]
      pushEntry({
        attachmentId: `${message.id || `message-${messageIndex}`}:image-path:${index}`,
        kind: 'image',
        source: 'message_image_path',
        name: basename(path) || `Image ${index + 1}`,
        messageId: message.id,
        messageIndex,
        role: message.role,
        timestamp: message.timestamp,
        path,
        pathScope: pathScopeForAttachment(path, workspacePath),
        hasThumbnail: Boolean(thumbnail),
        thumbnail
      })
    })
    if (imagePaths.length === 0) {
      imageThumbnails.forEach((thumbnail, index) => {
        if (!thumbnail) return
        pushEntry({
          attachmentId: `${message.id || `message-${messageIndex}`}:thumbnail:${index}`,
          kind: 'image',
          source: 'message_image_path',
          name: `Image ${index + 1}`,
          messageId: message.id,
          messageIndex,
          role: message.role,
          timestamp: message.timestamp,
          mimeType: thumbnail.mimeType,
          pathScope: 'thumbnail_only',
          hasThumbnail: true,
          thumbnail
        })
      })
    }
    for (const candidate of [metadata.imageAttachments, metadata.attachments]) {
      if (!Array.isArray(candidate)) continue
      candidate.forEach((raw, index) => {
        const attachment = normalizeAttachmentObject(raw)
        if (!attachment?.path) return
        const kind = normalizeAttachmentKind(attachment.kind, attachment.path, attachment.mimeType)
        pushEntry({
          attachmentId:
            attachment.id || `${message.id || `message-${messageIndex}`}:attachment:${index}`,
          kind,
          source: 'message_attachment',
          name: attachment.name || basename(attachment.path) || `${kind} attachment`,
          messageId: message.id,
          messageIndex,
          role: message.role,
          timestamp: message.timestamp,
          mimeType: attachment.mimeType,
          path: attachment.path,
          pathScope: pathScopeForAttachment(attachment.path, workspacePath),
          hasThumbnail: false
        })
      })
    }
    const mediaRefs = Array.isArray(metadata.mediaRefs) ? metadata.mediaRefs : []
    mediaRefs.forEach((raw, index) => {
      const ref = normalizeMediaRef(raw)
      if (!ref) return
      const path = optionalString(ref.path)
      pushEntry({
        attachmentId: ref.id || `${message.id || `message-${messageIndex}`}:media:${index}`,
        kind: ref.kind,
        source: 'message_media_ref',
        name: ref.name || (path ? basename(path) : `${ref.kind} media`),
        messageId: message.id,
        messageIndex,
        role: message.role,
        timestamp: message.timestamp,
        mimeType: ref.mimeType,
        status: ref.status,
        path,
        workspaceRelativePath: optionalString(ref.workspaceRelativePath),
        pathScope: path
          ? pathScopeForAttachment(path, workspacePath)
          : ref.sha256 || ref.assetId
            ? 'transcript_asset'
            : ref.thumbnail
              ? 'thumbnail_only'
              : 'missing',
        byteLength: typeof ref.byteLength === 'number' ? ref.byteLength : undefined,
        sha256: optionalString(ref.sha256),
        assetId: optionalString(ref.assetId),
        hasThumbnail: Boolean(ref.thumbnail),
        thumbnail: ref.thumbnail,
        mediaRef: ref
      })
    })
  })

  ;(chat.ensemble?.blackboard || []).forEach((blackboardEntry) => {
    sanitizeBlackboardMediaRefs(blackboardEntry.mediaRefs).forEach((ref) => {
      pushEntry(
        {
          attachmentId: ref.id,
          kind: 'image',
          source: 'blackboard_media_ref',
          name: ref.name,
          blackboardEntryId: blackboardEntry.id,
          blackboardKey: blackboardEntry.key,
          timestamp: blackboardEntry.createdAt,
          mimeType: ref.mimeType,
          status: ref.status,
          pathScope: ref.sha256 || ref.assetId ? 'transcript_asset' : 'thumbnail_only',
          byteLength: ref.byteLength,
          sha256: ref.sha256,
          assetId: ref.assetId,
          hasThumbnail: Boolean(ref.thumbnail),
          thumbnail: ref.thumbnail,
          mediaRef: ref
        },
        true
      )
    })
  })

  ;(chat.runs || []).forEach((run, runIndex) => {
    for (const candidate of runAttachmentCandidates(run)) {
      const attachments = Array.isArray(candidate?.imageAttachments)
        ? candidate.imageAttachments
        : []
      attachments.forEach((raw, index) => {
        const attachment = normalizeAttachmentObject(raw)
        if (!attachment?.path) return
        pushEntry({
          attachmentId:
            attachment.id || `${run.runId || `run-${runIndex}`}:image-attachment:${index}`,
          kind: 'image',
          source: 'run_attachment',
          name: attachment.name || basename(attachment.path) || `Image ${index + 1}`,
          runId: run.runId,
          mimeType: attachment.mimeType,
          path: attachment.path,
          pathScope: pathScopeForAttachment(attachment.path, workspacePath),
          hasThumbnail: false
        })
      })
    }
  })

  return entries
}

function summarizeChatAttachmentEntry(entry: ChatAttachmentEntry, includePath: boolean) {
  const workspaceRelativePath = safeAttachmentWorkspaceRelativePath(entry)
  return {
    attachmentId: entry.attachmentId,
    kind: entry.kind,
    source: entry.source,
    name: entry.name,
    messageId: entry.messageId,
    messageIndex: entry.messageIndex,
    role: entry.role,
    timestamp: entry.timestamp,
    runId: entry.runId,
    blackboardEntryId: entry.blackboardEntryId,
    blackboardKey: entry.blackboardKey,
    mimeType: entry.mimeType,
    status: entry.status,
    pathScope: entry.pathScope,
    ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    assetId: entry.assetId,
    hasThumbnail: entry.hasThumbnail,
    hasPath: Boolean(entry.path),
    ...(includePath && entry.path && entry.pathScope === 'workspace' ? { path: entry.path } : {})
  }
}

function safeAttachmentWorkspaceRelativePath(entry: ChatAttachmentEntry): string | undefined {
  if (entry.pathScope !== 'workspace' && entry.pathScope !== 'transcript_asset') return undefined
  const candidate = entry.workspaceRelativePath?.trim()
  if (
    !candidate ||
    isAbsolute(candidate) ||
    /^[a-z]:[\\/]/i.test(candidate) ||
    candidate.startsWith('\\\\') ||
    candidate.includes('\0')
  ) {
    return undefined
  }
  const segments = candidate.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined
  return candidate
}

function chatAttachmentRichJson(
  structuredContent: Record<string, unknown>,
  isError = false
): McpToolExecutionResult {
  return {
    text: JSON.stringify(structuredContent, null, 2),
    structuredContent,
    ...(isError ? { isError: true } : {})
  }
}

async function readChatAttachmentImage(
  deps: WorkspaceToolExecutorDependencies,
  appChatId: string,
  entry: ChatAttachmentEntry,
  maxBytes: number,
  workspacePath?: string
): Promise<
  | { ok: true; dataBase64: string; mimeType: string; byteLength: number; variant: 'full' | 'thumbnail' }
  | { ok: false; reason: string }
> {
  if (entry.mediaRef?.sha256) {
    if (deps.media?.readTranscriptMediaAsset) {
      const read = deps.media.readTranscriptMediaAsset({
        sha256: entry.mediaRef.sha256,
        mimeType: entry.mediaRef.mimeType,
        appChatId,
        maxBytes
      })
      if (read.ok) {
        return {
          ok: true,
          dataBase64: read.buffer.toString('base64'),
          mimeType: entry.mediaRef.mimeType,
          byteLength: read.byteLength,
          variant: 'full'
        }
      }
    }
    // A content-addressed transcript asset is readable only through the
    // host-authorized chat grant above. Never fall through to a persisted path
    // that could bypass cross-chat ownership checks.
    if (entry.thumbnail?.dataBase64 && isTranscriptThumbnailMime(entry.thumbnail.mimeType)) {
      return {
        ok: true,
        dataBase64: entry.thumbnail.dataBase64,
        mimeType: entry.thumbnail.mimeType,
        byteLength: Buffer.byteLength(entry.thumbnail.dataBase64, 'base64'),
        variant: 'thumbnail'
      }
    }
    return { ok: false, reason: 'Attachment image bytes are unavailable.' }
  }
  if (entry.path && entry.pathScope === 'workspace' && workspacePath) {
    const read = await readRasterImagePath(entry.path, workspacePath, maxBytes)
    if (read.ok) return read
  }
  if (entry.thumbnail?.dataBase64 && isTranscriptThumbnailMime(entry.thumbnail.mimeType)) {
    return {
      ok: true,
      dataBase64: entry.thumbnail.dataBase64,
      mimeType: entry.thumbnail.mimeType,
      byteLength: Buffer.byteLength(entry.thumbnail.dataBase64, 'base64'),
      variant: 'thumbnail'
    }
  }
  return { ok: false, reason: 'Attachment image bytes are unavailable.' }
}

async function readRasterImagePath(
  path: string,
  workspacePath: string,
  maxBytes: number
): Promise<
  | { ok: true; dataBase64: string; mimeType: string; byteLength: number; variant: 'full' }
  | { ok: false; reason: string }
> {
  let targetPath: string
  try {
    // macOS temp paths commonly cross the /var -> /private/var alias. Resolve
    // the existing leaf once for a common lexical root, then let
    // readScopedRegularFile perform the authoritative directory snapshots,
    // O_NOFOLLOW open, and path/descriptor identity checks before returning.
    targetPath = await fs.realpath(path)
  } catch {
    return { ok: false, reason: 'Attachment file is missing.' }
  }
  let buffer: Buffer
  try {
    const read = await readScopedRegularFile(
      { rootPath: workspacePath, targetPath },
      {
        maxBytes,
        regularFileErrorMessage: 'Attachment path is not a regular file.',
        sizeLimitErrorMessage: 'Attachment is too large to inline.'
      }
    )
    buffer = read.buffer
  } catch {
    return { ok: false, reason: 'Attachment file could not be read.' }
  }
  if (buffer.length === 0) return { ok: false, reason: 'Attachment file is empty.' }
  const mimeType = sniffImageMime(buffer)
  if (!isTranscriptRasterImageMime(mimeType)) {
    return { ok: false, reason: 'Attachment is not a supported raster image.' }
  }
  return {
    ok: true,
    dataBase64: buffer.toString('base64'),
    mimeType: mimeType || 'image/png',
    byteLength: buffer.length,
    variant: 'full'
  }
}

function normalizeAttachmentObject(value: unknown): {
  id?: string
  path: string
  name?: string
  kind?: string
  mimeType?: string
} | null {
  if (!isRecord(value)) return null
  const path = optionalString(value.path)
  if (!path) return null
  return {
    id: optionalString(value.id),
    path,
    name: optionalString(value.name || value.filename),
    kind: optionalString(value.kind),
    mimeType: optionalString(value.mimeType)
  }
}

function normalizeMediaRef(value: unknown): TranscriptMediaRef | null {
  if (!isRecord(value)) return null
  const id = optionalString(value.id)
  const kind = optionalString(value.kind)
  const source = optionalString(value.source)
  const name = optionalString(value.name)
  const mimeType = optionalString(value.mimeType)
  if (!id || (kind !== 'image' && kind !== 'audio' && kind !== 'video') || !source || !name || !mimeType) {
    return null
  }
  return value as unknown as TranscriptMediaRef
}

function normalizeAttachmentThumbnail(value: unknown): TranscriptMediaThumbnail | undefined {
  if (!isRecord(value)) return undefined
  const dataBase64 = optionalString(value.dataBase64)
  const mimeType = optionalString(value.mimeType)
  if (!dataBase64 || !mimeType || !isTranscriptThumbnailMime(mimeType)) return undefined
  return {
    dataBase64,
    mimeType,
    ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: value.width } : {}),
    ...(typeof value.height === 'number' && Number.isFinite(value.height) ? { height: value.height } : {})
  }
}

function normalizeAttachmentKind(
  declaredKind: string | undefined,
  path: string,
  mimeType?: string
): ChatAttachmentKind {
  if (declaredKind === 'folder' || declaredKind === 'file' || declaredKind === 'image') {
    return declaredKind
  }
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  const ext = extname(path).toLowerCase()
  if (CHAT_ATTACHMENT_IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (CHAT_ATTACHMENT_AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (CHAT_ATTACHMENT_VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

function canonicalChatAttachmentWorkspace(
  chat: ChatRecord,
  context: WorkspaceToolContext
): string | undefined {
  if (
    chat.scope === 'global' ||
    !chat.workspacePath ||
    context.scope !== 'workspace' ||
    !context.workspacePath
  ) {
    return undefined
  }
  try {
    const chatWorkspace = fsSync.realpathSync.native(chat.workspacePath)
    const runWorkspace = fsSync.realpathSync.native(context.workspacePath)
    return chatWorkspace === runWorkspace ? chatWorkspace : undefined
  } catch {
    return undefined
  }
}

function pathScopeForAttachment(
  path: string | undefined,
  workspacePath?: string
): ChatAttachmentPathScope {
  if (!path) return 'missing'
  if (workspacePath && isAbsolute(path) && isPathInsideWorkspace(workspacePath, path)) {
    return 'workspace'
  }
  return 'external'
}

function runAttachmentCandidates(run: ChatRun): Record<string, unknown>[] {
  return [run, (run as any).request, (run as any).snapshot, (run as any).requestSnapshot]
    .filter(isRecord)
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
    approvalId: event.approvalId,
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
