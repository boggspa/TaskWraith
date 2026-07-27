import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import { createConnection, createServer, type Server as NetServer, type Socket } from 'net'
import os from 'os'
import { dirname, join, resolve } from 'path'
import type { WebContents } from 'electron'
import {
  canonicalTaskWraithToolName,
  isPortableEnsembleControlToolName,
  normalizePortableEnsembleControlArguments,
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'
import {
  isPlanAdvertisedTool,
  isReadOnlyAdvertisedTool
} from './McpAutoAllowedTools'
import { isExactReviewerVerdictInvocation } from '../ReviewerVerdictInvocation'
import {
  gatewayToolDefinitions,
  isCapabilityGatewayToolName,
  type CapabilityGatewayToolName
} from './McpToolGateway'
import {
  isCoreMcpAdvertisedTool,
  isGatewayMcpAdvertisedTool
} from './McpToolProfiles'
import type { McpCallerContext } from './McpRouteGuards'
import { MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE } from './McpInternalError'
import { sanitizeCanvasEvalProviderText } from '../canvas/CanvasEvalAudit'
import type { CanvasEvalApprovalReceipt } from '../canvas/canvasTypes'
import type { PendingToolMediaPersistence } from '../services/ToolMediaPersistenceGate'
// Audit MCP tool definitions — advertised ONLY to audit role-runs (the bridge
// child carries TASKWRAITH_MCP_AUDIT=1, set per-run at the provider spawn site).
// AuditToolExecutors imports McpToolDefinition from here as `import type` (erased
// at runtime), so this value import introduces no runtime require cycle.
import { AUDIT_MCP_TOOL_NAMES, auditToolDefinitions } from './AuditToolExecutors'
import type {
  AppSettings,
  ChatScope,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ExternalPathGrant,
  GeminiMcpBridgeStatus,
  GeminiWorktreeLaunchOption,
  ProviderId,
  RuntimeProfile,
  TranscriptMediaRef
} from '../store/types'

export const GEMINI_MCP_SERVER_NAME = 'TaskWraith' as const
export const GEMINI_MCP_SERVER_NAME_LOWER = GEMINI_MCP_SERVER_NAME.toLowerCase()
export const GEMINI_MCP_BRIDGE_ARG = '--taskwraith-gemini-mcp-bridge'
// Mirrors geminiMcpConstants.GEMINI_MCP_BRIDGE_ENV — the second bridge-child
// signal (set on self-test spawns) so a lost argv flag can't trigger a full-app
// boot + recursive self-spawn. Keep the literal identical across both files.
export const GEMINI_MCP_BRIDGE_ENV = 'TASKWRAITH_GEMINI_MCP_BRIDGE'
// Mirrors geminiMcpConstants.GEMINI_MCP_BRIDGE_ARG_SUFFIX — used to prune stale
// pre-rebrand registrations (entries whose bridge flag ends with this suffix but
// isn't the current GEMINI_MCP_BRIDGE_ARG). Keep identical across both files.
export const GEMINI_MCP_BRIDGE_ARG_SUFFIX = '-gemini-mcp-bridge'
export const GEMINI_MCP_SOCKET_ARG = '--socket'
export const GEMINI_MCP_TOKEN_ARG = '--token'
/** Durable bridge-log generation captured when the provider seat is launched. */
export const GEMINI_MCP_LOG_EPOCH_ARG = '--bridge-log-epoch'
// Fail-closed read-only scope flag. Carried in the bridge ARGV (not env) so it
// is atomic with the spawn: a bridge launched with these args is scoped, full
// stop. The bootstrap translates it to TASKWRAITH_MCP_SAFE_SUBSET=1 (the env the
// tools/list + tools/call guard reads). Used by the Grok read-only seat, which
// auto-runs MCP tools with NO host gate — so the advertised list + the call
// reject ARE the entire safety boundary, and the scope must travel with the spawn.
export const GEMINI_MCP_SAFE_SUBSET_ARG = '--safe-subset'
// Plan-tier scope flag. Layered ON TOP of --safe-subset for a `plan` (not
// read_only) bridge seat: the advertised/allowed set widens from the read-only
// safe subset to ALSO include the plan instruments (canvas actuation + media),
// which remain host-gated on the main side (they are not auto-allowed). Carried
// in ARGV like --safe-subset so it is atomic with the spawn; the bootstrap
// translates it to TASKWRAITH_MCP_PLAN_SUBSET=1 (read by the tools/list + call
// guard). Absent → the seat stays scoped to the strict read-only subset.
export const GEMINI_MCP_PLAN_SUBSET_ARG = '--plan-subset'
// Model-capability scope flag. Cursor's Grok 4.5 catalogue currently rejects
// the full TaskWraith MCP surface before a turn starts, so write-capable Grok
// 4.5 seats advertise the explicit general-purpose core profile instead.
// Carried in argv so each transient bridge process owns its immutable profile.
export const GEMINI_MCP_CORE_SUBSET_ARG = '--core-subset'
// Progressive-disclosure profile flag. A bridge launched with this flag has an
// immutable, cache-stable direct catalogue plus the two virtual capability
// gateway tools. Hidden first-party tools remain reachable only through the
// gateway and retain their underlying host-side approval and routing policy.
export const GEMINI_MCP_GATEWAY_SUBSET_ARG = '--gateway-subset'
// Portable Bossman-control profile flag. The compact `ensemble_control` tool
// is deliberately gated independently from the generic gateway flag so a
// receipted v1–v5 session cannot gain a new visible tool mid-session.
export const GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG = '--portable-ensemble-control'
// Audit scope flag. Carried in the bridge ARGV (atomic with the spawn, like
// safe-subset) AND/OR inherited via env: a bridge launched for an audit role-run
// also advertises the audit_* tool namespace. The bootstrap translates this arg
// to TASKWRAITH_MCP_AUDIT=1 (the env tools/list reads); for stdio providers the
// CLI sets the env directly and the bridge child inherits it. Unlike safe-subset
// this does NOT restrict tools/call — audit tools route through the registered
// audit context, and non-audit runs never set the flag.
export const GEMINI_MCP_AUDIT_SUBSET_ARG = '--audit-subset'

/**
 * Translate immutable bridge launch flags into the environment read by the
 * JSON-RPC catalogue/call guard. Keeping this pure and exported lets tests prove
 * that a provider cannot launch a gateway-profile child which accidentally
 * serves the full catalogue because an argv flag was forgotten at bootstrap.
 */
export function applyMcpBridgeProfileArgvToEnv(
  argv: readonly string[],
  env: Record<string, string | undefined>
): void {
  if (argv.includes(GEMINI_MCP_SAFE_SUBSET_ARG)) env.TASKWRAITH_MCP_SAFE_SUBSET = '1'
  if (argv.includes(GEMINI_MCP_PLAN_SUBSET_ARG)) env.TASKWRAITH_MCP_PLAN_SUBSET = '1'
  if (argv.includes(GEMINI_MCP_CORE_SUBSET_ARG)) env.TASKWRAITH_MCP_CORE_SUBSET = '1'
  if (argv.includes(GEMINI_MCP_GATEWAY_SUBSET_ARG)) env.TASKWRAITH_MCP_GATEWAY_SUBSET = '1'
  if (argv.includes(GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG)) {
    env.TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL = '1'
  }
  if (argv.includes(GEMINI_MCP_AUDIT_SUBSET_ARG)) env.TASKWRAITH_MCP_AUDIT = '1'
}

export const GEMINI_MCP_ALLOWED_TOOL_NAMES = [
  ...TASKWRAITH_MCP_TOOLS,
  ...TASKWRAITH_MCP_TOOLS.map((tool) => `${GEMINI_MCP_SERVER_NAME}__${tool}`)
]

export type GeminiMcpRegistrationScope = 'user' | 'project'
export type GeminiCapabilityKind = 'mcp' | 'extensions' | 'skills' | 'agents'
export type GeminiCapabilityFormat = 'json' | 'raw' | 'error'
export type McpResponseTransport = 'framed' | 'line'

export interface GeminiCapabilityItem {
  id: string
  name: string
  status?: string
  detail?: string
  raw: string
}

export interface GeminiCapabilitySection {
  kind: GeminiCapabilityKind
  command: string[]
  format: GeminiCapabilityFormat
  items: GeminiCapabilityItem[]
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
  error?: string
  parsingError?: string
  truncated?: boolean
}

export interface GeminiCapabilityProcessResult {
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  error?: string
  truncated?: boolean
}

export interface ResolvedProviderBinary {
  provider: ProviderId
  binaryPath: string | null
  source: 'runtime_profile' | 'settings' | 'path' | 'common' | 'missing'
  error?: string
}

export type McpToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export interface McpToolExecutionResult {
  text: string
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: McpToolContentBlock[]
  /** Main-only execution/approval join; never projected by the MCP transport. */
  canvasEvalApproval?: CanvasEvalApprovalReceipt
  /** Main-only produced-media rollback authority; stripped before provider projection. */
  pendingToolMediaPersistence?: PendingToolMediaPersistence
  // S1b-3: main-built AV media refs on a TRUSTED channel — injected straight into run
  // state by the host, bypassing the image-only provider sanitizer (kind!=='image' is
  // hard-dropped). Un-forgeable: only main-side executor code constructs this result.
  trustedMediaRefs?: TranscriptMediaRef[]
  // Per-image-block presentation hints carried alongside `content` image blocks for the
  // SANITIZED image lane (createToolResultMediaRefs). `labels[i]` becomes the caption of
  // the ref built from the i-th image block (in content order); `groupKind` lets the
  // renderer group a contiguous run of refs (e.g. `video_frames` → an NLE filmstrip).
  // `maxRefs` raises the per-MESSAGE ref cap for THIS result only (a trusted main-side
  // hint, ceiling-clamped at the dispatch seam) so e.g. a 24-frame filmstrip isn't cut to
  // the global default of 8. Purely cosmetic — the bytes still ride the sniffed, size-capped
  // image spine. MUST stay in sync with the mirror on index.types.ts's McpToolExecutionResult.
  mediaRefHints?: { groupKind?: string; labels?: string[]; maxRefs?: number }
}

export interface McpToolDefinition {
  name: string
  description?: string
  annotations?: Record<string, unknown>
  inputSchema?: Record<string, unknown>
}

export interface McpBridgeAgentRunRoute {
  appRunId?: string
  appChatId?: string
}

export interface McpBridgeAgentRunPayload {
  provider: ProviderId
  scope: ChatScope
  workspace?: string
  prompt: string
  appRunId?: string
  appChatId?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  approvalMode?: string
  imagePaths?: string[]
  providerSessionId?: string | null
  externalPathGrants?: ExternalPathGrant[]
  sessionTrust?: boolean
  geminiWorktree?: GeminiWorktreeLaunchOption
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  runtimeProfile?: RuntimeProfile
  effectivePermissions?: EffectiveRunPermissions
  ensembleRun?: EnsembleRunIdentity
}

export interface InstallGeminiToolContextOptions {
  runPayload?: McpBridgeAgentRunPayload
  providerSessionId?: string | null
}

export interface CaptureProcessOutputResult {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut: boolean
}

export interface McpBridgeRuntimeDeps {
  getSettings: () => Pick<AppSettings, 'geminiMcpBridgeEnabled' | 'geminiMcpBridgeLastStatus'>
  updateSettings: (patch: Partial<AppSettings>) => void
  getGeminiMcpSocketPath: () => string
  getGeminiMcpBrokerToken: () => string
  getGeminiUserSettingsPath: () => string
  getAppPath: () => string
  getAppVersion: () => string
  isDev: () => boolean
  isPackaged: () => boolean
  getProcessExecPath?: () => string
  resolveCliProviderBinary: (provider: ProviderId) => Promise<ResolvedProviderBinary>
  captureProcessOutput: (
    command: string,
    args: string[],
    cwd?: string,
    timeoutMs?: number
  ) => Promise<CaptureProcessOutputResult>
  resolveBrokerParentProviderFromRunId?: (appRunId: string) => ProviderId | undefined
  readGeminiCapabilitySection: (
    kind: GeminiCapabilityKind,
    cwd?: string
  ) => Promise<GeminiCapabilitySection>
  runGeminiCapabilityCommand: (
    args: string[],
    cwd?: string
  ) => Promise<GeminiCapabilityProcessResult>
  parseCapabilityRawItems: (stdout: string, kind: GeminiCapabilityKind) => GeminiCapabilityItem[]
  createCliEnv: (extra: Record<string, string>, binaryPath?: string | null) => Record<string, string>
  appendLimitedOutput?: (current: string, chunk: Buffer) => { value: string; truncated: boolean }
  executeGeminiMcpTool: (
    toolName: TaskWraithMcpToolName | CapabilityGatewayToolName,
    args: unknown,
    route: McpBridgeAgentRunRoute,
    parentProvider: ProviderId,
    callerContext?: McpCallerContext
  ) => Promise<McpToolExecutionResult>
  installGeminiToolContextForRun: (
    sender: WebContents,
    cwd: string,
    route?: McpBridgeAgentRunRoute | null,
    scope?: ChatScope,
    sessionTrust?: boolean,
    options?: InstallGeminiToolContextOptions
  ) => McpBridgeAgentRunRoute | Promise<McpBridgeAgentRunRoute>
  sendAgentCompatLine: (
    sender: WebContents,
    provider: ProviderId,
    payload: unknown,
    route?: McpBridgeAgentRunRoute | null
  ) => void
}

export interface GeminiMcpBridgePrepareOptions {
  requireWriteTools?: boolean
  runPayload?: McpBridgeAgentRunPayload
  /** Run-scoped setup cancellation; shared broker state itself remains reusable. */
  setupSignal?: AbortSignal
  /** Revalidates exact run/history authority after every awaited setup boundary. */
  isRunAuthorized?: () => boolean
  /**
   * Compensates only the exact run-context install when authority is revoked
   * while that final install is in flight. Shared broker/registration repair is
   * deliberately retained because another live run may be using it.
   */
  cleanupInstalledRunContextOnRevocation?: (route: McpBridgeAgentRunRoute) => void
}

export type GeminiMcpBridgePreparationBoundary =
  | 'initial'
  | 'bridge-enable-warning'
  | 'bridge-enable-setting'
  | 'broker-start'
  | 'bridge-repair'
  | 'bridge-status'
  | 'bridge-self-test'
  | 'run-context-install'

export interface GeminiMcpBridgePreparationRevocationReceipt {
  kind: 'run-authority-revoked'
  boundary: GeminiMcpBridgePreparationBoundary
  sharedBridgeState: 'retained-for-other-runs'
  runContextCleanup: 'not-required' | 'completed' | 'unavailable' | 'failed'
  cleanupError?: string
}

export class GeminiMcpBridgePreparationAbortedError extends Error {
  constructor(readonly receipt: GeminiMcpBridgePreparationRevocationReceipt) {
    super(`Gemini MCP bridge preparation lost run lifecycle authority at ${receipt.boundary}.`)
    this.name = 'GeminiMcpBridgePreparationAbortedError'
  }
}

export interface GeminiMcpBridgeProcessDeps {
  getDefaultSocketPath: () => string
  getAppVersion: () => string
  getMcpToolDefinitions: () => McpToolDefinition[]
  brokerRequest?: (socketPath: string, request: unknown) => Promise<unknown>
  mcpToolCallResponseFromBrokerResult?: typeof mcpToolCallResponseFromBrokerResult
  argv?: string[]
  env?: NodeJS.ProcessEnv
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  exit?: (code?: number) => void
  cwd?: () => string
  pid?: () => number
}

const VALID_BROKER_PARENT_PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  // Grok reaches the broker through its provider-native MCP registration.
  'grok',
  // Cursor ensemble seats stamp taskwraith-broker with parentProvider=cursor.
  'cursor',
  // AntiGravity's gemini-api lane runs the in-process agentic runtime whose
  // tool calls resolve their parent from the run session; without this entry
  // resolveBrokerParentProvider would coerce those calls back to 'gemini'
  // and the session-keyed context/authority lookups would miss.
  'antigravity',
  'mistral'
])
const BRIDGE_LOG_MAX_BYTES = 1_048_576
const BRIDGE_LOG_MAX_LINE_CHARS = 32_768
const BRIDGE_LOG_DIRECTORY_MODE = 0o700
const BRIDGE_LOG_FILE_MODE = 0o600
const BRIDGE_LOG_LOCK_WAIT_MS = 5_000
const BRIDGE_LOG_LOCK_POLL_MS = 10
const DEFAULT_MAX_CAPTURE_OUTPUT_CHARS = 200_000

let bridgeLogPath: string | null = null
let bridgeLogResolved = false
let bridgeLogHistoryClearHolds = 0
let bridgeLogEpochPath: string | null = null
let bridgeLogProcessEpoch: number | null = null
let bridgeLogEpochPinnedByLaunch = false
const bridgeLogDirectoryIdentities = new Map<string, BridgeFsIdentity>()
const bridgeLogFileIdentities = new Map<string, BridgeFsIdentity>()
const bridgeLogSensitiveValues = new Map<string, '<redacted>' | '<redacted-path>'>()

interface BridgeFsIdentity {
  dev: number
  ino: number
}

interface BridgeLogLock {
  path: string
  fd: number | null
  stat: fsSync.Stats
}

export interface BridgeLogHistoryPurgeResult {
  status: 'cleared' | 'missing'
  epoch: number
}

function bridgeFsIdentity(stat: fsSync.Stats): BridgeFsIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameBridgeFsIdentity(
  left: Pick<fsSync.Stats, 'dev' | 'ino'> | BridgeFsIdentity,
  right: Pick<fsSync.Stats, 'dev' | 'ino'> | BridgeFsIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertBridgeOwned(stat: fsSync.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user.`)
  }
}

function assertBridgePrivateMode(stat: fsSync.Stats, mode: number, label: string): void {
  // Windows does not expose POSIX owner/group/other mode authority. The no-link,
  // regular-file, and fd/path identity checks still apply there.
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== mode) {
    throw new Error(`${label} permissions are not private.`)
  }
}

function assertBridgeDirectoryStat(stat: fsSync.Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a trusted directory.`)
  }
  assertBridgeOwned(stat, label)
}

function assertBridgeFileStat(stat: fsSync.Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file.`)
  }
  if (stat.nlink !== 1) throw new Error(`${label} has an unsafe link count.`)
  assertBridgeOwned(stat, label)
}

function assertExpectedBridgeIdentity(
  expected: BridgeFsIdentity | undefined,
  actual: Pick<fsSync.Stats, 'dev' | 'ino'>,
  label: string
): void {
  if (expected && !sameBridgeFsIdentity(expected, actual)) {
    throw new Error(`${label} identity changed.`)
  }
}

/**
 * Platform-native bridge diagnostic log directory under the process home.
 * Darwin keeps the historical ~/Library/Logs path; Windows uses
 * %USERPROFILE%\AppData\Local\TaskWraith\logs (homedir-relative so HOME/
 * USERPROFILE test pins work); Linux uses XDG state under ~/.local/state.
 */
export function canonicalBridgeLogDirectory(home: string = os.homedir()): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Logs', 'TaskWraith')
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'TaskWraith', 'logs')
  }
  return join(home, '.local', 'state', 'TaskWraith', 'logs')
}

function ensurePrivateBridgeLogDirectory(path: string): BridgeFsIdentity {
  fsSync.mkdirSync(path, { recursive: true, mode: BRIDGE_LOG_DIRECTORY_MODE })
  const before = fsSync.lstatSync(path)
  assertBridgeDirectoryStat(before, 'Bridge log directory')
  assertExpectedBridgeIdentity(
    bridgeLogDirectoryIdentities.get(path),
    before,
    'Bridge log directory'
  )

  if (process.platform === 'win32') {
    const after = fsSync.lstatSync(path)
    assertBridgeDirectoryStat(after, 'Bridge log directory')
    if (!sameBridgeFsIdentity(before, after)) {
      throw new Error('Bridge log directory changed during validation.')
    }
    const identity = bridgeFsIdentity(after)
    bridgeLogDirectoryIdentities.set(path, identity)
    return identity
  }

  let fd: number | null = null
  try {
    fd = fsSync.openSync(
      path,
      fsSync.constants.O_RDONLY |
        (fsSync.constants.O_DIRECTORY ?? 0) |
        (fsSync.constants.O_NOFOLLOW ?? 0)
    )
    const opened = fsSync.fstatSync(fd)
    assertBridgeDirectoryStat(opened, 'Bridge log directory')
    if (!sameBridgeFsIdentity(before, opened)) {
      throw new Error('Bridge log directory changed while it was opened.')
    }
    if ((opened.mode & 0o777) !== BRIDGE_LOG_DIRECTORY_MODE) {
      // The legacy bridge created its own canonical leaf with the process
      // umask. Repair that one owned directory in place, but never chmod an
      // arbitrary parent supplied to the focused purge seam (for example
      // /tmp).
      if (path !== canonicalBridgeLogDirectory()) {
        throw new Error('Bridge log directory permissions are not private.')
      }
      fsSync.fchmodSync(fd, BRIDGE_LOG_DIRECTORY_MODE)
    }
    const privateStat = fsSync.fstatSync(fd)
    assertBridgeDirectoryStat(privateStat, 'Bridge log directory')
    assertBridgePrivateMode(
      privateStat,
      BRIDGE_LOG_DIRECTORY_MODE,
      'Bridge log directory'
    )
    const after = fsSync.lstatSync(path)
    assertBridgeDirectoryStat(after, 'Bridge log directory')
    if (!sameBridgeFsIdentity(privateStat, after)) {
      throw new Error('Bridge log directory changed during validation.')
    }
    const identity = bridgeFsIdentity(privateStat)
    bridgeLogDirectoryIdentities.set(path, identity)
    return identity
  } finally {
    if (fd !== null) fsSync.closeSync(fd)
  }
}

function lstatBridgeFile(path: string, label: string): fsSync.Stats | null {
  try {
    const stat = fsSync.lstatSync(path)
    assertBridgeFileStat(stat, label)
    assertExpectedBridgeIdentity(bridgeLogFileIdentities.get(path), stat, label)
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function openPrivateBridgeFile(
  path: string,
  flags: number,
  options: { create: boolean; missingOk?: boolean; label: string }
): { fd: number; stat: fsSync.Stats } | null {
  const directoryPath = dirname(path)
  const directoryIdentity = ensurePrivateBridgeLogDirectory(directoryPath)
  const before = lstatBridgeFile(path, options.label)
  if (!before && !options.create && options.missingOk) return null

  let fd: number | null = null
  try {
    fd = fsSync.openSync(
      path,
      flags |
        (options.create ? fsSync.constants.O_CREAT : 0) |
        (fsSync.constants.O_NOFOLLOW ?? 0),
      BRIDGE_LOG_FILE_MODE
    )
    const opened = fsSync.fstatSync(fd)
    assertBridgeFileStat(opened, options.label)
    if (before && !sameBridgeFsIdentity(before, opened)) {
      throw new Error(`${options.label} changed while it was opened.`)
    }
    assertExpectedBridgeIdentity(bridgeLogFileIdentities.get(path), opened, options.label)

    const pathStat = fsSync.lstatSync(path)
    assertBridgeFileStat(pathStat, options.label)
    if (!sameBridgeFsIdentity(opened, pathStat)) {
      throw new Error(`${options.label} path does not identify the opened file.`)
    }
    if (!sameBridgeFsIdentity(directoryIdentity, ensurePrivateBridgeLogDirectory(directoryPath))) {
      throw new Error('Bridge log directory changed while opening a file.')
    }

    if (process.platform !== 'win32') fsSync.fchmodSync(fd, BRIDGE_LOG_FILE_MODE)
    const privateStat = fsSync.fstatSync(fd)
    assertBridgeFileStat(privateStat, options.label)
    assertBridgePrivateMode(privateStat, BRIDGE_LOG_FILE_MODE, options.label)
    const finalPathStat = fsSync.lstatSync(path)
    assertBridgeFileStat(finalPathStat, options.label)
    if (!sameBridgeFsIdentity(privateStat, finalPathStat)) {
      throw new Error(`${options.label} changed during validation.`)
    }
    bridgeLogFileIdentities.set(path, bridgeFsIdentity(privateStat))
    const result = { fd, stat: privateStat }
    fd = null
    return result
  } catch (error) {
    if (!options.create && options.missingOk && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  } finally {
    if (fd !== null) fsSync.closeSync(fd)
  }
}

function revalidatePrivateBridgeFile(
  path: string,
  opened: { fd: number; stat: fsSync.Stats },
  label: string
): fsSync.Stats {
  const fdStat = fsSync.fstatSync(opened.fd)
  assertBridgeFileStat(fdStat, label)
  assertBridgePrivateMode(fdStat, BRIDGE_LOG_FILE_MODE, label)
  if (!sameBridgeFsIdentity(opened.stat, fdStat)) {
    throw new Error(`${label} opened-file identity changed.`)
  }
  const pathStat = fsSync.lstatSync(path)
  assertBridgeFileStat(pathStat, label)
  if (!sameBridgeFsIdentity(fdStat, pathStat)) {
    throw new Error(`${label} path identity changed.`)
  }
  ensurePrivateBridgeLogDirectory(dirname(path))
  return fdStat
}

function bridgeLogLockPath(logPath: string): string {
  return `${logPath}.lock`
}

function validateBridgeLogLock(lock: BridgeLogLock): void {
  if (lock.fd !== null) {
    const fdStat = fsSync.fstatSync(lock.fd)
    assertBridgeDirectoryStat(fdStat, 'Bridge log transaction lock')
    assertBridgePrivateMode(fdStat, BRIDGE_LOG_DIRECTORY_MODE, 'Bridge log transaction lock')
    if (!sameBridgeFsIdentity(lock.stat, fdStat)) {
      throw new Error('Bridge log transaction lock identity changed.')
    }
  }
  const pathStat = fsSync.lstatSync(lock.path)
  assertBridgeDirectoryStat(pathStat, 'Bridge log transaction lock')
  assertBridgePrivateMode(pathStat, BRIDGE_LOG_DIRECTORY_MODE, 'Bridge log transaction lock')
  if (!sameBridgeFsIdentity(lock.stat, pathStat)) {
    throw new Error('Bridge log transaction lock path identity changed.')
  }
  ensurePrivateBridgeLogDirectory(dirname(lock.path))
}

function validateContendedBridgeLogLock(path: string): boolean {
  try {
    const stat = fsSync.lstatSync(path)
    assertBridgeDirectoryStat(stat, 'Bridge log transaction lock')
    assertBridgePrivateMode(stat, BRIDGE_LOG_DIRECTORY_MODE, 'Bridge log transaction lock')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function tryAcquireBridgeLogLock(logPath: string): BridgeLogLock | null {
  const parentPath = dirname(logPath)
  ensurePrivateBridgeLogDirectory(parentPath)
  const path = bridgeLogLockPath(logPath)
  try {
    fsSync.mkdirSync(path, { mode: BRIDGE_LOG_DIRECTORY_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    validateContendedBridgeLogLock(path)
    return null
  }

  let fd: number | null = null
  let openedStat: fsSync.Stats | null = null
  try {
    if (process.platform === 'win32') {
      openedStat = fsSync.lstatSync(path)
      const lock = { path, fd: null, stat: openedStat }
      validateBridgeLogLock(lock)
      return lock
    }
    fd = fsSync.openSync(
      path,
      fsSync.constants.O_RDONLY |
        (fsSync.constants.O_DIRECTORY ?? 0) |
        (fsSync.constants.O_NOFOLLOW ?? 0)
    )
    openedStat = fsSync.fstatSync(fd)
    const lock = { path, fd, stat: openedStat }
    validateBridgeLogLock(lock)
    fd = null
    return lock
  } catch (error) {
    if (fd !== null) fsSync.closeSync(fd)
    try {
      const pathStat = fsSync.lstatSync(path)
      if (
        openedStat &&
        pathStat.isDirectory() &&
        !pathStat.isSymbolicLink() &&
        sameBridgeFsIdentity(openedStat, pathStat)
      ) {
        fsSync.rmdirSync(path)
      }
    } catch {
      // Preserve a substituted lock path; strict callers will surface the
      // original validation failure and never enter the clear transaction.
    }
    throw error
  }
}

async function acquireBridgeLogLockStrict(logPath: string): Promise<BridgeLogLock> {
  const deadline = Date.now() + BRIDGE_LOG_LOCK_WAIT_MS
  while (true) {
    const lock = tryAcquireBridgeLogLock(logPath)
    if (lock) return lock
    if (Date.now() >= deadline) {
      throw new Error('Bridge log transaction lock remained busy.')
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, BRIDGE_LOG_LOCK_POLL_MS))
  }
}

function releaseBridgeLogLock(lock: BridgeLogLock): void {
  const fdOpen = lock.fd !== null
  try {
    validateBridgeLogLock(lock)
    fsSync.rmdirSync(lock.path)
  } finally {
    if (fdOpen && lock.fd !== null) fsSync.closeSync(lock.fd)
  }
}

function readBridgeLogEpochStrict(path: string): number {
  let opened: { fd: number; stat: fsSync.Stats } | null = null
  try {
    opened = openPrivateBridgeFile(path, fsSync.constants.O_RDWR, {
      create: false,
      missingOk: true,
      label: 'Bridge log epoch'
    })
    if (!opened) return 0
    revalidatePrivateBridgeFile(path, opened, 'Bridge log epoch')
    const raw = fsSync.readFileSync(opened.fd, 'utf8').trim()
    if (!/^\d+$/.test(raw)) {
      throw new Error('Bridge log epoch is invalid.')
    }
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed)) throw new Error('Bridge log epoch is invalid.')
    revalidatePrivateBridgeFile(path, opened, 'Bridge log epoch')
    return parsed
  } finally {
    if (opened) fsSync.closeSync(opened.fd)
  }
}

function readBridgeLogEpoch(path: string): number | null {
  try {
    return readBridgeLogEpochStrict(path)
  } catch {
    return null
  }
}

function writeBridgeLogEpoch(path: string, epoch: number): void {
  let opened: { fd: number; stat: fsSync.Stats } | null = null
  try {
    opened = openPrivateBridgeFile(path, fsSync.constants.O_RDWR, {
      create: true,
      label: 'Bridge log epoch'
    })
    if (!opened) throw new Error('Bridge log epoch could not be opened.')
    // Do not truncate until link, owner, mode, fd/path, and directory identity
    // have all been verified. This keeps a prepositioned victim untouched.
    revalidatePrivateBridgeFile(path, opened, 'Bridge log epoch')
    fsSync.ftruncateSync(opened.fd, 0)
    fsSync.writeFileSync(opened.fd, String(epoch), 'utf8')
    fsSync.fsyncSync(opened.fd)
    revalidatePrivateBridgeFile(path, opened, 'Bridge log epoch')
  } finally {
    if (opened) fsSync.closeSync(opened.fd)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBridgeAuditMcpToolName(value: string): boolean {
  return (AUDIT_MCP_TOOL_NAMES as readonly string[]).includes(value)
}

function isCoreMcpAdvertisedForSeat(name: string, portableEnsembleControl = false): boolean {
  return (
    (isCoreMcpAdvertisedTool(name) &&
      (!portableEnsembleControl || name !== 'ensemble_bossman_control')) ||
    (portableEnsembleControl && name === 'ensemble_control')
  )
}

function isGatewayMcpAdvertisedForSeat(name: string, portableEnsembleControl = false): boolean {
  return (
    (isGatewayMcpAdvertisedTool(name) &&
      (!portableEnsembleControl || name !== 'ensemble_bossman_control')) ||
    (portableEnsembleControl && name === 'ensemble_control')
  )
}

type GatewayInvocationTarget =
  | { ok: true; name: TaskWraithMcpToolName }
  | { ok: false; error: string }

/**
 * Resolve only the wrapped target identity needed by the bridge's catalogue and
 * permission ceilings. Argument-schema validation and execution stay on the
 * main side so capability_invoke cannot become a second, blanket-approved
 * execution path.
 */
function resolveBridgeGatewayInvocationTarget(args: unknown): GatewayInvocationTarget {
  if (!isRecord(args) || typeof args.name !== 'string' || !args.name.trim()) {
    return { ok: false, error: 'capability_invoke requires a non-empty tool name.' }
  }
  const name = canonicalTaskWraithToolName(args.name)
  if (isCapabilityGatewayToolName(name)) {
    return { ok: false, error: 'Capability gateway tools cannot invoke themselves.' }
  }
  if (!isTaskWraithMcpToolName(name)) {
    return { ok: false, error: `Unknown TaskWraith MCP capability: ${args.name}` }
  }
  return { ok: true, name }
}

function defaultAppendLimitedOutput(
  current: string,
  chunk: Buffer
): { value: string; truncated: boolean } {
  const next = current + chunk.toString('utf8')
  if (next.length <= DEFAULT_MAX_CAPTURE_OUTPUT_CHARS) {
    return { value: next, truncated: false }
  }
  return {
    value: `${next.slice(0, DEFAULT_MAX_CAPTURE_OUTPUT_CHARS)}\n[output truncated]`,
    truncated: true
  }
}

export function isTaskWraithMcpToolName(value: unknown): value is TaskWraithMcpToolName {
  return TASKWRAITH_MCP_TOOLS.includes(value as TaskWraithMcpToolName)
}

export function normalizeBrokerParentProvider(value: unknown): ProviderId {
  if (typeof value === 'string' && VALID_BROKER_PARENT_PROVIDERS.has(value as ProviderId)) {
    return value as ProviderId
  }
  return 'gemini'
}

/**
 * Prefer the run-session provider when an appRunId is present so a wrong
 * stamped TASKWRAITH_PARENT_PROVIDER (e.g. Cursor leftover on a Grok run)
 * cannot bind the wrong agent tool context.
 */
export function resolveBrokerParentProvider(
  stamped: unknown,
  runSessionProvider?: ProviderId | null
): ProviderId {
  if (
    typeof runSessionProvider === 'string' &&
    VALID_BROKER_PARENT_PROVIDERS.has(runSessionProvider)
  ) {
    return runSessionProvider
  }
  return normalizeBrokerParentProvider(stamped)
}

export function normalizeRunRoute(route?: McpBridgeAgentRunRoute | null): McpBridgeAgentRunRoute {
  return {
    ...(route?.appRunId ? { appRunId: String(route.appRunId) } : {}),
    ...(route?.appChatId ? { appChatId: String(route.appChatId) } : {})
  }
}

export function createFallbackRunId(provider: ProviderId): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function routeWithRunId(
  provider: ProviderId,
  route?: McpBridgeAgentRunRoute | null
): McpBridgeAgentRunRoute {
  const normalized = normalizeRunRoute(route)
  return {
    ...normalized,
    appRunId: normalized.appRunId || createFallbackRunId(provider)
  }
}

export function mcpToolCallResponseFromBrokerResult(result: unknown): {
  content: McpToolContentBlock[]
  structuredContent?: Record<string, unknown>
  isError: boolean
} {
  const record = isRecord(result) ? result : {}
  const resultContent = Array.isArray(record.content)
    ? record.content.filter(isMcpToolContentBlock)
    : []
  const fallbackText =
    typeof record.text === 'string'
      ? record.text
      : typeof record.error === 'string'
        ? record.error
        : ''
  const content =
    resultContent.length > 0 ? resultContent : [{ type: 'text' as const, text: fallbackText }]
  const structuredContent = isRecord(record.structuredContent)
    ? record.structuredContent
    : undefined
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    isError: record.ok === false || record.isError === true
  }
}

function isMcpToolContentBlock(value: unknown): value is McpToolContentBlock {
  if (!isRecord(value)) return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'image')
    return typeof value.mimeType === 'string' && typeof value.data === 'string'
  return false
}

export function brokerRequest(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolveRequest) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (result: unknown) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveRequest(result)
    }
    const timeout = setTimeout(
      () => finish({ ok: false, error: 'TaskWraith MCP broker timed out.' }),
      130_000
    )
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      safeMcpStreamWrite(socket, `${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lineEnd = buffer.indexOf('\n')
      if (lineEnd < 0) return
      clearTimeout(timeout)
      const line = buffer.slice(0, lineEnd).trim()
      try {
        finish(JSON.parse(line))
      } catch {
        finish({ ok: false, error: 'TaskWraith MCP broker returned malformed JSON.' })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timeout)
      bridgeLog(`broker client connection-failed ${bridgeFailureMetadata(error)}`)
      finish({ ok: false, error: MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE })
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      if (!settled) finish({ ok: false, error: 'TaskWraith MCP broker closed before responding.' })
    })
  })
}

export function parseBridgeSocketArg(
  argv: string[] = process.argv,
  defaultSocketPath = ''
): string {
  const index = argv.indexOf(GEMINI_MCP_SOCKET_ARG)
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1]
  }
  return defaultSocketPath
}

export function parseBridgeTokenArg(argv: string[] = process.argv): string {
  const index = argv.indexOf(GEMINI_MCP_TOKEN_ARG)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : ''
}

export function parseBridgeLogEpochArg(argv: string[] = process.argv): number | null {
  const index = argv.indexOf(GEMINI_MCP_LOG_EPOCH_ARG)
  if (index < 0 || !argv[index + 1]) return null
  const parsed = Number(argv[index + 1])
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

const BRIDGE_SECRET_ARG_NAMES = new Set([
  GEMINI_MCP_TOKEN_ARG,
  '--api-key',
  '--auth-token',
  '--broker-token',
  '--password',
  '--secret'
])
const BRIDGE_PATH_ARG_NAMES = new Set([
  GEMINI_MCP_SOCKET_ARG,
  '--config',
  '--config-path',
  '--cwd',
  '--dir',
  '--directory',
  '--home',
  '--mcp-config',
  '--path',
  '--user-data-dir',
  '--workdir',
  '--workspace',
  '--workspace-path'
])
const BRIDGE_STRUCTURAL_FLAG_ARG_NAMES = new Set([
  GEMINI_MCP_BRIDGE_ARG,
  GEMINI_MCP_SAFE_SUBSET_ARG,
  GEMINI_MCP_PLAN_SUBSET_ARG,
  GEMINI_MCP_CORE_SUBSET_ARG,
  GEMINI_MCP_GATEWAY_SUBSET_ARG,
  GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG,
  GEMINI_MCP_AUDIT_SUBSET_ARG
])

type BridgeLogRedaction = '<redacted>' | '<redacted-path>'

function bridgeArgNameAndInlineValue(arg: string): { name: string; value?: string } {
  const equals = arg.indexOf('=')
  if (equals <= 0) return { name: arg.toLowerCase() }
  return {
    name: arg.slice(0, equals).toLowerCase(),
    value: arg.slice(equals + 1)
  }
}

function bridgeArgRedaction(name: string): BridgeLogRedaction | null {
  if (BRIDGE_SECRET_ARG_NAMES.has(name)) return '<redacted>'
  if (BRIDGE_PATH_ARG_NAMES.has(name)) return '<redacted-path>'
  return null
}

function looksLikeBridgePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('file:') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  )
}

function bridgeStartupSensitiveArgValues(
  argv: readonly string[]
): Array<{ value: string; replacement: BridgeLogRedaction }> {
  const sensitive: Array<{ value: string; replacement: BridgeLogRedaction }> = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    const parsed = bridgeArgNameAndInlineValue(arg)
    const replacement = bridgeArgRedaction(parsed.name)
    if (replacement) {
      if (parsed.value !== undefined) {
        if (parsed.value) sensitive.push({ value: parsed.value, replacement })
      } else if (index + 1 < argv.length) {
        const value = String(argv[index + 1] ?? '')
        if (value) sensitive.push({ value, replacement })
        index += 1
      }
      continue
    }
    if (looksLikeBridgePath(arg)) {
      sensitive.push({ value: arg, replacement: '<redacted-path>' })
    }
  }
  return sensitive
}

/**
 * Return a diagnostic-only argv projection. Broker credentials and all known
 * path-bearing values are represented by fixed markers rather than persisted.
 */
export function sanitizeBridgeStartupArgvForLog(argv: readonly string[]): string[] {
  const sanitized: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    const parsed = bridgeArgNameAndInlineValue(arg)
    const replacement = bridgeArgRedaction(parsed.name)
    if (replacement) {
      if (parsed.value !== undefined) {
        sanitized.push(`${arg.slice(0, arg.indexOf('='))}=${replacement}`)
      } else {
        sanitized.push(arg, replacement)
        if (index + 1 < argv.length) index += 1
      }
      continue
    }
    if (parsed.name === GEMINI_MCP_LOG_EPOCH_ARG) {
      if (parsed.value !== undefined) {
        sanitized.push(`${GEMINI_MCP_LOG_EPOCH_ARG}=<epoch>`)
      } else {
        sanitized.push(GEMINI_MCP_LOG_EPOCH_ARG, '<epoch>')
        if (index + 1 < argv.length) index += 1
      }
      continue
    }
    if (BRIDGE_STRUCTURAL_FLAG_ARG_NAMES.has(parsed.name)) {
      sanitized.push(parsed.name)
      continue
    }
    if (looksLikeBridgePath(arg)) {
      sanitized.push('<redacted-path>')
      continue
    }
    sanitized.push(arg.startsWith('--') ? '<option>' : '<arg>')
  }
  return sanitized
}

function registerBridgeLogSensitiveValues(
  values: Array<{ value: string | undefined; replacement: BridgeLogRedaction }>
): void {
  for (const { value, replacement } of values) {
    if (!value) continue
    bridgeLogSensitiveValues.set(value, replacement)
  }
}

function sanitizeBridgeLogMessage(message: string): string {
  let sanitized = sanitizeCanvasEvalProviderText(message)
  const sensitive = [...bridgeLogSensitiveValues.entries()].sort(
    ([left], [right]) => right.length - left.length
  )
  for (const [value, replacement] of sensitive) {
    sanitized = sanitized.split(value).join(replacement)
  }
  return sanitized.slice(0, BRIDGE_LOG_MAX_LINE_CHARS)
}

function bridgeStructuralKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Error) return 'error'
  return typeof value
}

function bridgeToolArgumentsMetadata(args: unknown): string {
  const kind = bridgeStructuralKind(args)
  const fieldCount = isRecord(args) ? Object.keys(args).length : 0
  const itemCount = Array.isArray(args) ? args.length : 0
  let byteLength = 0
  try {
    const serialized = JSON.stringify(args)
    if (serialized !== undefined) byteLength = Buffer.byteLength(serialized, 'utf8')
  } catch {
    // Parsed JSON normally cannot reach this path; retain only a zero length if
    // a focused test or host shim supplies an unserializable value.
  }
  return `args.kind=${kind} args.fields=${fieldCount} args.items=${itemCount} args.bytes=${byteLength}`
}

function bridgeFailureMetadata(value: unknown): string {
  return `failure.kind=${bridgeStructuralKind(value)}`
}

function bridgeToolLogName(
  name: unknown,
  gatewayTarget?: GatewayInvocationTarget | null
): string {
  const canonical = String(name || '')
  const outerKnown =
    isTaskWraithMcpToolName(canonical) ||
    isCapabilityGatewayToolName(canonical) ||
    isBridgeAuditMcpToolName(canonical)
  const outer = outerKnown ? canonical : 'unknown'
  if (gatewayTarget?.ok) return `${outer}->${gatewayTarget.name}`
  return outer
}

export function buildBridgeStartupLogMessage(input: {
  argv: readonly string[]
  cwd: string
  runId?: string
  parentProvider?: string
  workspacePath?: string
}): string {
  const parentProvider = VALID_BROKER_PARENT_PROVIDERS.has(input.parentProvider as ProviderId)
    ? input.parentProvider
    : input.parentProvider
      ? 'unknown'
      : ''
  return (
    `spawn argv=${JSON.stringify(sanitizeBridgeStartupArgvForLog(input.argv))}` +
    ` cwd=<redacted-path>` +
    ` env.TASKWRAITH_RUN_ID.present=${String(Boolean(input.runId))}` +
    ` env.TASKWRAITH_PARENT_PROVIDER=${parentProvider}` +
    ` env.TASKWRAITH_WORKSPACE_PATH=${input.workspacePath ? '<redacted-path>' : ''}`
  )
}

/** Pin the child to the generation its parent captured before any log access. */
export function configureBridgeLogProcessEpochFromLaunch(argv: string[] = process.argv): void {
  bridgeLogEpochPinnedByLaunch = true
  bridgeLogProcessEpoch = parseBridgeLogEpochArg(argv)
}

type SafeWritable = {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown
}

function isWritableClosed(stream: unknown): boolean {
  const record = stream && typeof stream === 'object' ? (stream as Record<string, unknown>) : {}
  return (
    record.destroyed === true ||
    record.closed === true ||
    record.writableEnded === true ||
    record.writableDestroyed === true
  )
}

export function safeMcpStreamWrite(stream: SafeWritable | null | undefined, chunk: string): void {
  if (!stream || isWritableClosed(stream)) return
  try {
    stream.write(chunk, () => {
      // Best-effort protocol write. EPIPE / write-after-end is expected when a
      // provider closes stdio during bridge shutdown or self-test teardown.
    })
  } catch {
    // Best-effort: the peer has gone away or the stream is already terminal.
  }
}

export function writeMcpFrame(payload: unknown, stdout: NodeJS.WriteStream = process.stdout): void {
  const body = JSON.stringify(payload)
  safeMcpStreamWrite(stdout, `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

export function writeMcpPayload(
  payload: unknown,
  transport: McpResponseTransport,
  stdout: NodeJS.WriteStream = process.stdout
): void {
  if (transport === 'line') {
    safeMcpStreamWrite(stdout, `${JSON.stringify(payload)}\n`)
    return
  }
  writeMcpFrame(payload, stdout)
}

export function writeMcpResponse(
  id: unknown,
  result: unknown,
  transport: McpResponseTransport = 'framed',
  stdout: NodeJS.WriteStream = process.stdout
): void {
  writeMcpPayload({ jsonrpc: '2.0', id, result }, transport, stdout)
}

export function writeMcpError(
  id: unknown,
  code: number,
  message: string,
  transport: McpResponseTransport = 'framed',
  stdout: NodeJS.WriteStream = process.stdout
): void {
  writeMcpPayload({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, transport, stdout)
}

function resolveBridgeLogPathStrict(): string {
  const logsDir = canonicalBridgeLogDirectory()
  ensurePrivateBridgeLogDirectory(logsDir)
  const path = join(logsDir, 'bridge-subprocess.log')
  const epochPath = `${path}.epoch`
  const durableEpoch = readBridgeLogEpochStrict(epochPath)
  if (!bridgeLogEpochPinnedByLaunch) bridgeLogProcessEpoch = durableEpoch
  if (bridgeLogProcessEpoch === null) {
    throw new Error('Bridge log launch epoch is invalid.')
  }

  let opened: { fd: number; stat: fsSync.Stats } | null = null
  try {
    opened = openPrivateBridgeFile(path, fsSync.constants.O_RDWR, {
      create: false,
      missingOk: true,
      label: 'Bridge subprocess log'
    })
  } finally {
    if (opened) fsSync.closeSync(opened.fd)
  }

  bridgeLogPath = path
  bridgeLogEpochPath = epochPath
  return path
}

export function resolveBridgeLogPath(): string | null {
  if (bridgeLogResolved) return bridgeLogPath
  bridgeLogResolved = true
  try {
    return resolveBridgeLogPathStrict()
  } catch {
    bridgeLogPath = null
    bridgeLogEpochPath = null
    return null
  }
}

export function bridgeLog(message: string, pid: number = process.pid): void {
  if (bridgeLogHistoryClearHolds > 0) return
  let opened: { fd: number; stat: fsSync.Stats } | null = null
  let lock: BridgeLogLock | null = null
  try {
    const path = resolveBridgeLogPath()
    if (!path) return
    lock = tryAcquireBridgeLogLock(path)
    if (!lock) return
    validateBridgeLogLock(lock)
    if (
      !bridgeLogEpochPath ||
      bridgeLogProcessEpoch === null ||
      readBridgeLogEpochStrict(bridgeLogEpochPath) !== bridgeLogProcessEpoch
    ) {
      // The process was alive before a global history clear. It must never
      // repopulate the new generation's diagnostic log after the clear returns.
      return
    }
    opened = openPrivateBridgeFile(
      path,
      fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND,
      { create: true, label: 'Bridge subprocess log' }
    )
    if (!opened) return
    validateBridgeLogLock(lock)
    revalidatePrivateBridgeFile(path, opened, 'Bridge subprocess log')
    if (opened.stat.size > BRIDGE_LOG_MAX_BYTES) {
      fsSync.ftruncateSync(opened.fd, 0)
      fsSync.fsyncSync(opened.fd)
      revalidatePrivateBridgeFile(path, opened, 'Bridge subprocess log')
    }
    // Clear holds the same cross-process lock while it advances the epoch and
    // truncates. A child that checked the old epoch can therefore only finish
    // its append before clear acquires the lock; it can never publish after a
    // successful clear returns.
    validateBridgeLogLock(lock)
    if (
      !bridgeLogEpochPath ||
      bridgeLogProcessEpoch === null ||
      readBridgeLogEpochStrict(bridgeLogEpochPath) !== bridgeLogProcessEpoch
    ) {
      return
    }
    const line = `[${new Date().toISOString()}] pid=${pid} ${sanitizeBridgeLogMessage(message)}\n`
    fsSync.writeSync(opened.fd, line)
    revalidatePrivateBridgeFile(path, opened, 'Bridge subprocess log')
  } catch {
    // Runtime diagnostics are deliberately best-effort. Privacy-critical user
    // history clears use the strict path below and propagate every failure.
  } finally {
    if (opened) {
      try {
        fsSync.closeSync(opened.fd)
      } catch {
        // best-effort
      }
    }
    if (lock) {
      try {
        releaseBridgeLogLock(lock)
      } catch {
        // A failed diagnostic append/lock release is best-effort. Strict clear
        // validates and waits on the lock path before committing history.
      }
    }
  }
}

function purgeBridgeSubprocessLogHistoryStrict(targetPath: string): 'cleared' | 'missing' {
  let opened: { fd: number; stat: fsSync.Stats } | null = null
  try {
    opened = openPrivateBridgeFile(targetPath, fsSync.constants.O_RDWR, {
      create: false,
      missingOk: true,
      label: 'Bridge subprocess log'
    })
    if (!opened) return 'missing'
    // Never add O_TRUNC to open: validate the path, fd, owner, mode, directory,
    // and link count first, then mutate only the already-verified descriptor.
    revalidatePrivateBridgeFile(targetPath, opened, 'Bridge subprocess log')
    fsSync.ftruncateSync(opened.fd, 0)
    fsSync.fsyncSync(opened.fd)
    revalidatePrivateBridgeFile(targetPath, opened, 'Bridge subprocess log')
    return 'cleared'
  } finally {
    if (opened) fsSync.closeSync(opened.fd)
  }
}

/** Truncate and suspend bridge diagnostics for a global clear transaction. */
export async function beginBridgeSubprocessLogHistoryClear(
  targetPath?: string | null
): Promise<BridgeLogHistoryPurgeResult> {
  // This executes before the async function returns its Promise, so log
  // admission is fenced synchronously even when strict validation later fails.
  bridgeLogHistoryClearHolds += 1
  const path =
    targetPath === undefined ? resolveBridgeLogPathStrict() : targetPath
  if (!path) return { status: 'missing', epoch: bridgeLogProcessEpoch ?? 0 }

  const lock = await acquireBridgeLogLockStrict(path)
  try {
    validateBridgeLogLock(lock)
    const epochPath = `${path}.epoch`
    const current = readBridgeLogEpochStrict(epochPath)
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Bridge log epoch cannot be advanced safely.')
    }
    const next = current + 1
    writeBridgeLogEpoch(epochPath, next)
    // The process that owns the clear joins the new generation; already-running
    // subprocesses retain their old process-local epoch and fail closed.
    if (path === bridgeLogPath) {
      bridgeLogEpochPath = epochPath
      bridgeLogProcessEpoch = next
    }
    validateBridgeLogLock(lock)
    const status = purgeBridgeSubprocessLogHistoryStrict(path)
    validateBridgeLogLock(lock)
    return { status, epoch: next }
  } finally {
    releaseBridgeLogLock(lock)
  }
}

/** Release one global clear hold after old provider transports are quiescent. */
export function endBridgeSubprocessLogHistoryClear(): void {
  if (bridgeLogHistoryClearHolds > 0) bridgeLogHistoryClearHolds -= 1
}

/** Best-effort runtime rotation; user history deletion uses the strict begin path. */
export function clearBridgeSubprocessLogHistory(targetPath?: string | null): void {
  const path = targetPath === undefined ? resolveBridgeLogPath() : targetPath
  if (!path) return
  let lock: BridgeLogLock | null = null
  try {
    lock = tryAcquireBridgeLogLock(path)
    if (!lock) return
    purgeBridgeSubprocessLogHistoryStrict(path)
  } catch {
    // A diagnostic rotation must not crash a provider runtime.
  } finally {
    if (lock) {
      try {
        releaseBridgeLogLock(lock)
      } catch {
        // best-effort
      }
    }
  }
}

export function handleMcpJsonRpcMessage(
  deps: GeminiMcpBridgeProcessDeps,
  socketPath: string,
  brokerToken: string,
  message: unknown,
  transport: McpResponseTransport = 'framed'
): void {
  const stdout = deps.stdout || process.stdout
  const request = isRecord(message) ? message : {}
  const id = request.id
  const method = String(request.method || '')
  if (!method) {
    writeMcpError(id, -32600, 'Invalid MCP request.', transport, stdout)
    return
  }
  if (method.startsWith('notifications/')) {
    return
  }
  if (method === 'initialize') {
    writeMcpResponse(
      id,
      {
        protocolVersion: isRecord(request.params)
          ? request.params.protocolVersion || '2024-11-05'
          : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'TaskWraith MCP Bridge', version: deps.getAppVersion() || '1.0.0' }
      },
      transport,
      stdout
    )
    return
  }
  if (method === 'ping') {
    writeMcpResponse(id, {}, transport, stdout)
    return
  }
  if (method === 'tools/list') {
    // Read-only scoped bridge (TASKWRAITH_MCP_SAFE_SUBSET=1): advertise ONLY the
    // non-mutating safe subset to a read-only seat (e.g. read-only Grok). The
    // tools/call gate below is the matching enforcement.
    const safeSubsetOnly =
      (deps.env?.TASKWRAITH_MCP_SAFE_SUBSET ?? process.env.TASKWRAITH_MCP_SAFE_SUBSET) === '1'
    // Plan-tier bridge seat (TASKWRAITH_MCP_PLAN_SUBSET=1, layered on safe-subset):
    // widen the advertised set from the strict read-only subset to ALSO include the
    // plan instruments (canvas actuation + media), which stay host-gated on the main
    // side. A read_only seat (flag absent) keeps the strict subset.
    const planSubset =
      (deps.env?.TASKWRAITH_MCP_PLAN_SUBSET ?? process.env.TASKWRAITH_MCP_PLAN_SUBSET) === '1'
    const isAdvertisedForSeat = planSubset ? isPlanAdvertisedTool : isReadOnlyAdvertisedTool
    // Tool-count constrained model profile (currently Cursor/Grok 4.5). Unlike
    // the read-only scope this includes mutating coding tools, which still pass
    // through the normal main-side approvals and path/workspace guards.
    const coreSubsetOnly =
      (deps.env?.TASKWRAITH_MCP_CORE_SUBSET ?? process.env.TASKWRAITH_MCP_CORE_SUBSET) === '1'
    // Progressive-disclosure profile. The direct catalogue stays fixed while
    // hidden first-party tools are discovered/invoked through the two virtual
    // gateway tools appended below.
    const gatewaySubsetOnly =
      (deps.env?.TASKWRAITH_MCP_GATEWAY_SUBSET ??
        process.env.TASKWRAITH_MCP_GATEWAY_SUBSET) === '1'
    const portableEnsembleControl =
      (deps.env?.TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL ??
        process.env.TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL) === '1'
    // Audit role-run bridge (TASKWRAITH_MCP_AUDIT=1): additionally advertise the
    // audit_* tool namespace so the role-run can record findings/verdicts/profile.
    // The flag is set per-run at the provider spawn site and never on a normal
    // run, so non-audit runs never see these tools. tools/call is NOT gated here
    // (audit tools route via the registered audit context in the broker).
    const auditSubset = (deps.env?.TASKWRAITH_MCP_AUDIT ?? process.env.TASKWRAITH_MCP_AUDIT) === '1'
    const allTools = deps.getMcpToolDefinitions().filter((tool) =>
      portableEnsembleControl
        ? tool.name !== 'ensemble_bossman_control'
        : tool.name !== 'ensemble_control'
    )
    const directTools =
      safeSubsetOnly || coreSubsetOnly || gatewaySubsetOnly
        ? allTools.filter(
            (tool) =>
              (!safeSubsetOnly || isAdvertisedForSeat(tool.name)) &&
              (!coreSubsetOnly || isCoreMcpAdvertisedForSeat(tool.name, portableEnsembleControl)) &&
              (!gatewaySubsetOnly ||
                isGatewayMcpAdvertisedForSeat(tool.name, portableEnsembleControl))
          )
        : allTools
    const baseTools = gatewaySubsetOnly
      ? [...directTools, ...gatewayToolDefinitions()]
      : directTools
    const tools = auditSubset ? [...baseTools, ...auditToolDefinitions()] : baseTools
    writeMcpResponse(id, { tools }, transport, stdout)
    return
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {}
    const rawName = params.name
    const rawArgs = params.arguments || {}
    const name = canonicalTaskWraithToolName(String(rawName || ''))
    const args =
      name === 'capability_invoke' &&
      isRecord(rawArgs) &&
      isPortableEnsembleControlToolName(String(rawArgs.name || ''))
        ? {
            ...rawArgs,
            arguments: normalizePortableEnsembleControlArguments(
              String(rawArgs.name),
              rawArgs.arguments
            )
          }
        : normalizePortableEnsembleControlArguments(String(rawName || ''), rawArgs)
    const portableEnsembleControlRequested =
      isPortableEnsembleControlToolName(String(rawName || '')) ||
      (name === 'capability_invoke' &&
        isRecord(rawArgs) &&
        isPortableEnsembleControlToolName(String(rawArgs.name || '')))
    const gatewaySubsetOnly =
      (deps.env?.TASKWRAITH_MCP_GATEWAY_SUBSET ??
        process.env.TASKWRAITH_MCP_GATEWAY_SUBSET) === '1'
    const portableEnsembleControl =
      (deps.env?.TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL ??
        process.env.TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL) === '1'
    if (portableEnsembleControlRequested && !portableEnsembleControl) {
      writeMcpError(
        id,
        -32601,
        `Tool '${String(rawName || 'ensemble_control')}' is available only in a fresh TaskWraith MCP profile. Use ensemble_bossman_control in this session.`,
        transport,
        stdout
      )
      return
    }
    const advertisedToolName = portableEnsembleControlRequested ? 'ensemble_control' : String(name)
    const gatewayToolRequested = isCapabilityGatewayToolName(name)
    const gatewayInvocationTarget =
      name === 'capability_invoke' ? resolveBridgeGatewayInvocationTarget(args) : null
    if (gatewayInvocationTarget && !gatewayInvocationTarget.ok) {
      bridgeLog(
        `tools/call rejected scope=gateway-target tool=${bridgeToolLogName(name)} ` +
          'reason=invalid-target'
      )
      writeMcpError(id, -32602, gatewayInvocationTarget.error, transport, stdout)
      return
    }
    const policyToolName = gatewayInvocationTarget?.ok ? gatewayInvocationTarget.name : name
    const canvasEvalLogEnvelope = policyToolName === 'canvas_eval'
    const safeLogName = bridgeToolLogName(name, gatewayInvocationTarget)
    if (gatewayToolRequested && !gatewaySubsetOnly) {
      writeMcpError(
        id,
        -32601,
        `Tool '${canvasEvalLogEnvelope ? safeLogName : String(rawName || name)}' is available only in the TaskWraith gateway MCP profile.`,
        transport,
        stdout
      )
      return
    }
    const auditSubset =
      (deps.env?.TASKWRAITH_MCP_AUDIT ?? process.env.TASKWRAITH_MCP_AUDIT) === '1'
    const auditToolRequested = auditSubset && isBridgeAuditMcpToolName(String(name))
    // Read-only scoped bridge (TASKWRAITH_MCP_SAFE_SUBSET=1): refuse any tool
    // outside the non-mutating safe subset rather than routing it to the broker.
    // This is the ENFORCEMENT — a read-only Grok seat auto-runs MCP tools with no
    // host gate, so a non-advertised (mutating) tool must be rejected right here.
    const safeSubsetOnly =
      (deps.env?.TASKWRAITH_MCP_SAFE_SUBSET ?? process.env.TASKWRAITH_MCP_SAFE_SUBSET) === '1'
    // Plan seats widen the allowed set to the plan instruments (canvas actuation +
    // media), which are still host-gated in the broker (they are not auto-allowed).
    // read_only seats stay on the strict read-only subset. The main-side host gate
    // remains the enforcement for the instruments; this reject just keeps
    // write/shell tools out for BOTH seats.
    const planSubset =
      (deps.env?.TASKWRAITH_MCP_PLAN_SUBSET ?? process.env.TASKWRAITH_MCP_PLAN_SUBSET) === '1'
    const isAdvertisedForSeat = planSubset ? isPlanAdvertisedTool : isReadOnlyAdvertisedTool
    // C2b-ii-c (G-SINGLE / G-ADVERTISE) — arg-scoped exact reviewer-verdict exception.
    // The ONLY ensemble_bossman_control invocation a read-only/plan bridge seat may run
    // through tools/call is the EXACT {action:'submit_review_verdict', gateId, verdict}
    // payload, delegated to the ONE shared classifier (never re-inlined). It is NEVER
    // added to any advertised / auto-allowed / tools-list / derived membership set — this
    // is a per-invocation ARG check, not an advertise change (advertise != execute). A
    // DIRECT call classifies the OUTER arguments; a capability_invoke classifies the
    // INNER target arguments (args.arguments). Absent/malformed inner args ⇒ the
    // classifier sees a non-object ⇒ FALSE ⇒ fail-closed (rejected below). Every other
    // bossman action / extra key / near-miss stays name-only-rejected exactly as before.
    const reviewerVerdictArgs = gatewayInvocationTarget?.ok
      ? isRecord(args)
        ? (args as Record<string, unknown>).arguments
        : undefined
      : args
    const isExactReviewerVerdictCall = isExactReviewerVerdictInvocation(
      String(policyToolName),
      reviewerVerdictArgs
    )
    const safeScopedToolAllowed =
      name === 'capability_search' ||
      isAdvertisedForSeat(String(policyToolName)) ||
      isExactReviewerVerdictCall
    if (safeSubsetOnly && !safeScopedToolAllowed && !auditToolRequested) {
      bridgeLog(
        `tools/call rejected scope=${planSubset ? 'plan' : 'read-only'} tool=${safeLogName}`
      )
      writeMcpError(
        id,
        -32601,
        `Tool '${canvasEvalLogEnvelope ? safeLogName : String(rawName || name)}' is not available to a read-only TaskWraith seat.`,
        transport,
        stdout
      )
      return
    }
    // A gateway-profile seat may call its compact direct catalogue normally.
    // Hidden tools are reachable only through capability_invoke; importantly,
    // the broker payload below remains the OUTER gateway call so main can
    // resolve route hints and execute the target through its normal approval,
    // guard, lock, budget, transcript, and audit seams.
    if (
      gatewaySubsetOnly &&
      !gatewayToolRequested &&
      !isGatewayMcpAdvertisedForSeat(advertisedToolName, portableEnsembleControl) &&
      !auditToolRequested
    ) {
      bridgeLog(`tools/call rejected scope=gateway tool=${safeLogName}`)
      writeMcpError(
        id,
        -32601,
        `Tool '${canvasEvalLogEnvelope ? safeLogName : String(rawName || name)}' is not directly available in the TaskWraith gateway MCP profile. Use capability_search and capability_invoke.`,
        transport,
        stdout
      )
      return
    }
    // Keep direct tools/call requests inside the same model-constrained profile
    // advertised by tools/list. This is defense-in-depth and prevents a stale
    // model/tool cache from reaching a capability omitted from the current run.
    const coreSubsetOnly =
      (deps.env?.TASKWRAITH_MCP_CORE_SUBSET ?? process.env.TASKWRAITH_MCP_CORE_SUBSET) === '1'
    if (
      coreSubsetOnly &&
      !isCoreMcpAdvertisedForSeat(advertisedToolName, portableEnsembleControl) &&
      !auditToolRequested
    ) {
      bridgeLog(`tools/call rejected scope=core tool=${safeLogName}`)
      writeMcpError(
        id,
        -32601,
        `Tool '${canvasEvalLogEnvelope ? safeLogName : String(rawName || name)}' is not available in the TaskWraith core MCP profile.`,
        transport,
        stdout
      )
      return
    }
    bridgeLog(`tools/call started tool=${safeLogName} ${bridgeToolArgumentsMetadata(args)}`)
    const requestBroker = deps.brokerRequest || brokerRequest
    requestBroker(socketPath, {
      id: id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      token: brokerToken,
      tool: name,
      arguments: args,
      appRunId: deps.env?.TASKWRAITH_RUN_ID ?? process.env.TASKWRAITH_RUN_ID,
      appChatId: deps.env?.TASKWRAITH_CHAT_ID ?? process.env.TASKWRAITH_CHAT_ID,
      callerCwd: deps.cwd?.() || process.cwd(),
      callerWorkspacePath:
        deps.env?.TASKWRAITH_WORKSPACE_PATH ?? process.env.TASKWRAITH_WORKSPACE_PATH ?? '',
      parentProvider:
        deps.env?.TASKWRAITH_PARENT_PROVIDER || process.env.TASKWRAITH_PARENT_PROVIDER || 'gemini'
    })
      .then((result) => {
        const responseFromResult =
          deps.mcpToolCallResponseFromBrokerResult || mcpToolCallResponseFromBrokerResult
        const resultRecord = isRecord(result) ? result : {}
        const outcome =
          resultRecord.ok === true ? 'ok' : resultRecord.ok === false ? 'error' : 'unknown'
        const resultText =
          typeof resultRecord.text === 'string'
            ? resultRecord.text
            : typeof resultRecord.error === 'string'
              ? resultRecord.error
              : ''
        const contentBlocks = Array.isArray(resultRecord.content)
          ? resultRecord.content.length
          : 0
        bridgeLog(
          `tools/call completed tool=${safeLogName} outcome=${outcome} ` +
            `result.bytes=${Buffer.byteLength(resultText, 'utf8')} content.blocks=${contentBlocks}`
        )
        try {
          writeMcpResponse(id, responseFromResult(result), transport, stdout)
        } catch (writeError) {
          bridgeLog(`tools/call response-write-failed ${bridgeFailureMetadata(writeError)}`)
        }
      })
      .catch((rejection) => {
        bridgeLog(`tools/call broker-rejected ${bridgeFailureMetadata(rejection)}`)
        try {
          writeMcpResponse(
            id,
            {
              content: [{ type: 'text', text: MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE }],
              isError: true
            },
            transport,
            stdout
          )
        } catch {
          // If even the error response cannot be written, the transport is already dead.
        }
      })
    return
  }
  writeMcpError(id, -32601, `Unsupported MCP method: ${method}`, transport, stdout)
}

export function startGeminiMcpBridgeProcess(deps: GeminiMcpBridgeProcessDeps): void {
  const argv = deps.argv || process.argv
  const env = deps.env || process.env
  const stdin = deps.stdin || process.stdin
  const stdout = deps.stdout || process.stdout
  const exit = deps.exit || ((code?: number) => process.exit(code))
  const socketPath = parseBridgeSocketArg(argv, deps.getDefaultSocketPath())
  const brokerToken = parseBridgeTokenArg(argv)
  const cwd = deps.cwd?.() || process.cwd()
  const workspacePath = env.TASKWRAITH_WORKSPACE_PATH || ''
  registerBridgeLogSensitiveValues([
    { value: brokerToken, replacement: '<redacted>' },
    { value: socketPath, replacement: '<redacted-path>' },
    { value: cwd, replacement: '<redacted-path>' },
    { value: workspacePath, replacement: '<redacted-path>' },
    ...bridgeStartupSensitiveArgValues(argv.slice(1))
  ])
  configureBridgeLogProcessEpochFromLaunch(argv)
  bridgeLog(
    buildBridgeStartupLogMessage({
      argv: argv.slice(1),
      cwd,
      runId: env.TASKWRAITH_RUN_ID,
      parentProvider: env.TASKWRAITH_PARENT_PROVIDER,
      workspacePath
    }),
    deps.pid?.() || process.pid
  )

  process.on('uncaughtException', (error) => {
    bridgeLog(`uncaughtException ${bridgeFailureMetadata(error)}`, deps.pid?.() || process.pid)
  })
  process.on('unhandledRejection', (reason) => {
    bridgeLog(`unhandledRejection ${bridgeFailureMetadata(reason)}`, deps.pid?.() || process.pid)
  })

  let buffer = Buffer.alloc(0)

  const parseMessages = () => {
    while (buffer.length > 0) {
      const text = buffer.toString('utf8')
      if (text.startsWith('Content-Length:')) {
        const headerEnd = text.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const header = text.slice(0, headerEnd)
        const lengthMatch = header.match(/Content-Length:\s*(\d+)/i)
        const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0
        if (!Number.isFinite(contentLength) || contentLength <= 0) {
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), 'utf8')
        if (buffer.length < bodyStart + contentLength) return
        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
        buffer = buffer.subarray(bodyStart + contentLength)
        try {
          handleMcpJsonRpcMessage(deps, socketPath, brokerToken, JSON.parse(body), 'framed')
        } catch {
          bridgeLog('parse FAILED (framed): malformed JSON', deps.pid?.() || process.pid)
          writeMcpError(
            null,
            -32700,
            'Malformed MCP JSON request.',
            'framed',
            stdout
          )
        }
        continue
      }

      const lineEnd = text.indexOf('\n')
      if (lineEnd < 0) return
      const lineBytes = Buffer.byteLength(text.slice(0, lineEnd + 1), 'utf8')
      const line = text.slice(0, lineEnd).trim()
      buffer = buffer.subarray(lineBytes)
      if (!line) continue
      try {
        handleMcpJsonRpcMessage(deps, socketPath, brokerToken, JSON.parse(line), 'line')
      } catch {
        bridgeLog('parse FAILED (line): malformed JSON', deps.pid?.() || process.pid)
        writeMcpError(
          null,
          -32700,
          'Malformed MCP JSON request.',
          'line',
          stdout
        )
      }
    }
  }

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    parseMessages()
  })
  stdin.on('end', () => {
    bridgeLog('stdin end - exiting', deps.pid?.() || process.pid)
    exit(0)
  })
  stdin.on('close', () => {
    bridgeLog('stdin close - exiting', deps.pid?.() || process.pid)
    exit(0)
  })
  stdin.on('error', (error) => {
    bridgeLog(`stdin error ${bridgeFailureMetadata(error)}`)
  })
  stdout.on('error', (error) => {
    bridgeLog(`stdout error ${bridgeFailureMetadata(error)}`)
  })
  process.on('exit', (code) => {
    bridgeLog(`process exit code=${code ?? 'unknown'}`, deps.pid?.() || process.pid)
  })
  stdin.resume()
}

export class McpBridgeRuntime {
  private geminiMcpBroker: NetServer | null = null
  private geminiMcpBrokerStartPromise: Promise<void> | null = null
  private geminiMcpBridgeRepairPromise: Promise<GeminiMcpBridgeStatus> | null = null
  // Self-test concurrency guard + short result cache. Without these, a burst of
  // status checks while the bridge reads as disconnected each spawn a fresh
  // Electron self-test process → hundreds of procs. In-flight callers share the
  // one running test, and a recent result is reused so rapid sequential calls
  // don't re-spawn either.
  private geminiMcpSelfTestPromise: Promise<{ ok: boolean; error?: string }> | null = null
  private geminiMcpSelfTestCache: {
    at: number
    result: { ok: boolean; error?: string }
  } | null = null
  private geminiMcpBridgeInstalledForCurrentToken = false
  private kimiMcpBridgeInstalledForCurrentToken = false

  constructor(private readonly deps: McpBridgeRuntimeDeps) {}

  private processExecPath(): string {
    return this.deps.getProcessExecPath?.() || process.execPath
  }

  taskwraithMcpBridgeCommandStatus(): { command: string; available: boolean; error?: string } {
    const command = this.processExecPath()
    try {
      fsSync.accessSync(command, fsSync.constants.X_OK)
      return { command, available: true }
    } catch (error) {
      return {
        command,
        available: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private taskwraithMcpBridgeCommandUnavailableMessage(
    status: { command: string; available: boolean; error?: string } = this.taskwraithMcpBridgeCommandStatus()
  ): string {
    return `TaskWraith MCP bridge executable is not available at ${status.command}: ${status.error || 'not executable'}`
  }

  private assertTaskWraithMcpBridgeCommandAvailable(): void {
    const status = this.taskwraithMcpBridgeCommandStatus()
    if (!status.available) {
      throw new Error(this.taskwraithMcpBridgeCommandUnavailableMessage(status))
    }
  }

  taskwraithMcpBridgeArgs(
    socketPath: string = this.deps.getGeminiMcpSocketPath(),
    safeSubset = false,
    planSubset = false,
    coreSubset = false,
    gatewaySubset = false,
    portableEnsembleControl = false
  ): string[] {
    const logEpochPath = join(
      os.homedir(),
      'Library',
      'Logs',
      'TaskWraith',
      'bridge-subprocess.log.epoch'
    )
    const logEpoch = readBridgeLogEpoch(logEpochPath)
    return [
      ...(this.deps.isDev() ? [this.deps.getAppPath()] : []),
      GEMINI_MCP_BRIDGE_ARG,
      GEMINI_MCP_SOCKET_ARG,
      socketPath,
      GEMINI_MCP_TOKEN_ARG,
      this.deps.getGeminiMcpBrokerToken(),
      // Pin logging generation before the bridge child can emit its first line.
      // An invalid/missing epoch fails closed inside the child.
      GEMINI_MCP_LOG_EPOCH_ARG,
      logEpoch === null ? 'invalid' : String(logEpoch),
      // Read-only seat (Grok): append the scope flag after the fixed launch
      // authority fields so socket/token index-based parsing is unaffected.
      // bridgeArgsMatchCurrentLaunch compares the epoch-stamped argv exactly.
      ...(safeSubset ? [GEMINI_MCP_SAFE_SUBSET_ARG] : []),
      // Plan-tier seat: widen the safe-subset to the plan instruments. Appended
      // after --safe-subset and remains index-safe. Default false omits only this
      // optional profile flag; every launch still carries its log epoch.
      ...(planSubset ? [GEMINI_MCP_PLAN_SUBSET_ARG] : []),
      // Tool-count constrained model seat: advertise the explicit coding/core
      // profile while retaining normal write approvals. Appended last so the
      // socket/token index parsing remains unchanged.
      ...(coreSubset ? [GEMINI_MCP_CORE_SUBSET_ARG] : []),
      // Progressive-disclosure profile. Kept in argv so the child process owns
      // a fixed profile for its entire lifetime; provider env forwarding is not
      // part of the profile boundary.
      ...(gatewaySubset ? [GEMINI_MCP_GATEWAY_SUBSET_ARG] : []),
      // The compact Bossman front door is independently profile-fenced so
      // old receipted gateway sessions retain their original tool list.
      ...(portableEnsembleControl ? [GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG] : [])
    ]
  }

  bridgeArgsMatchCurrentLaunch(args: string[], socketPath: string): boolean {
    const expected = this.taskwraithMcpBridgeArgs(socketPath)
    return expected.length === args.length && expected.every((arg, index) => args[index] === arg)
  }

  isValidGeminiMcpBrokerToken(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const expected = Buffer.from(this.deps.getGeminiMcpBrokerToken(), 'utf8')
    const actual = Buffer.from(value, 'utf8')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async handleGeminiMcpBrokerRequest(request: unknown): Promise<unknown> {
    const brokerRequestRecord = isRecord(request) ? request : {}
    if (!this.isValidGeminiMcpBrokerToken(brokerRequestRecord.token)) {
      return { ok: false, error: 'TaskWraith MCP broker authentication failed.' }
    }
    const rawToolName = brokerRequestRecord.tool || brokerRequestRecord.name
    const toolName = canonicalTaskWraithToolName(String(rawToolName || ''))
    if (
      !isTaskWraithMcpToolName(toolName) &&
      !isCapabilityGatewayToolName(toolName) &&
      !isBridgeAuditMcpToolName(toolName)
    ) {
      return { ok: false, error: `Unknown TaskWraith MCP tool: ${String(rawToolName || 'unknown')}` }
    }
    const route = normalizeRunRoute(brokerRequestRecord)
    const routeProvider = route.appRunId
      ? this.deps.resolveBrokerParentProviderFromRunId?.(route.appRunId)
      : undefined
    const parentProvider = resolveBrokerParentProvider(
      brokerRequestRecord.parentProvider,
      routeProvider
    )
    const callerContext: McpCallerContext = {
      ...(typeof brokerRequestRecord.callerCwd === 'string'
        ? { callerCwd: brokerRequestRecord.callerCwd }
        : {}),
      ...(typeof brokerRequestRecord.callerWorkspacePath === 'string'
        ? { callerWorkspacePath: brokerRequestRecord.callerWorkspacePath }
        : {})
    }
    const result = await this.deps.executeGeminiMcpTool(
      // Audit tools are a deliberately run-scoped extension to the canonical
      // catalog. The main executor validates the active audit registry/role.
      toolName as TaskWraithMcpToolName | CapabilityGatewayToolName,
      brokerRequestRecord.arguments ?? brokerRequestRecord.args ?? brokerRequestRecord.input,
      route,
      parentProvider,
      callerContext
    )
    return { ok: !result.isError, ...result }
  }

  async startGeminiMcpBroker(): Promise<void> {
    if (this.geminiMcpBrokerStartPromise) return this.geminiMcpBrokerStartPromise

    if (this.geminiMcpBroker) {
      const broker = this.geminiMcpBroker
      const socketPath = this.deps.getGeminiMcpSocketPath()
      // Windows AF_UNIX socket identity is unreliable across runners (listen may
      // use path forms that isSocket() does not report). Treat a live broker as
      // present on win32; on POSIX, EACCES on the path means the socket is not
      // usable and must be recreated (common after a path-permission race).
      const socketPresent =
        process.platform === 'win32'
          ? true
          : await fs
              .stat(socketPath)
              .then((stat) => stat.isSocket())
              .catch((error) => {
                if ((error as NodeJS.ErrnoException).code === 'EACCES') return false
                return false
              })
      if (this.geminiMcpBroker === broker && broker.listening && socketPresent) return
      // A Unix server can remain `listening` after its pathname is unlinked.
      // In that state every new provider bridge gets ENOENT while this field
      // still looks healthy. Retire the unreachable listener and rebind below.
      if (this.geminiMcpBroker === broker) this.geminiMcpBroker = null
      try {
        broker.close()
      } catch {
        // An already-closed stale listener is safe to replace.
      }
    }

    // Another caller may have repaired the broker while the socket stat above
    // was in flight. Share its startup rather than unlinking its fresh socket.
    if (this.geminiMcpBrokerStartPromise) return this.geminiMcpBrokerStartPromise
    if (this.geminiMcpBroker) return

    this.geminiMcpBrokerStartPromise = (async () => {
      const socketPath = this.deps.getGeminiMcpSocketPath()
      await fs.mkdir(dirname(socketPath), { recursive: true }).catch(() => {})
      await fs.unlink(socketPath).catch(() => {})

      const server = createServer((socket: Socket) => {
        let buffer = ''
        socket.setEncoding('utf8')
        socket.on('error', () => {
          // Broker clients may disconnect while a response is being written.
        })
        socket.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let parsed: unknown
            try {
              parsed = JSON.parse(trimmed)
            } catch {
              safeMcpStreamWrite(
                socket,
                `${JSON.stringify({ ok: false, error: 'Malformed broker JSON request.' })}\n`
              )
              continue
            }
            const parsedRecord = isRecord(parsed) ? parsed : {}
            this.handleGeminiMcpBrokerRequest(parsed)
              .then((result) =>
                safeMcpStreamWrite(
                  socket,
                  `${JSON.stringify({ id: parsedRecord.id, ...coerceRecord(result) })}\n`
                )
              )
              .catch((error) => {
                bridgeLog(`broker execution-rejected ${bridgeFailureMetadata(error)}`)
                safeMcpStreamWrite(
                  socket,
                  `${JSON.stringify({ id: parsedRecord.id, ok: false, error: MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE })}\n`
                )
              })
          }
        })
      })

      this.geminiMcpBroker = server
      server.once('close', () => {
        if (this.geminiMcpBroker === server) this.geminiMcpBroker = null
      })
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const handleError = (error: Error) => {
            server.off('listening', handleListening)
            rejectListen(error)
          }
          const handleListening = () => {
            server.off('error', handleError)
            resolveListen()
          }
          server.once('error', handleError)
          server.once('listening', handleListening)
          server.listen(socketPath)
        })
      } catch (error) {
        if (this.geminiMcpBroker === server) {
          this.geminiMcpBroker = null
        }
        try {
          server.close()
        } catch {
          // Best effort: preserve the original broker startup error.
        }
        throw error
      }
    })().finally(() => {
      this.geminiMcpBrokerStartPromise = null
    })

    return this.geminiMcpBrokerStartPromise
  }

  closeGeminiMcpBroker(): void {
    if (!this.geminiMcpBroker) return
    this.geminiMcpBroker.close()
    this.geminiMcpBroker = null
  }

  async selfTestGeminiMcpBridgeProcess(
    socketPath: string
  ): Promise<{ ok: boolean; error?: string }> {
    // Coalesce concurrent self-tests and reuse a recent result, so a flood of
    // status checks (e.g. autoRepair on every IPC query while the bridge reads
    // disconnected) can never spawn a flood of Electron self-test processes.
    if (this.geminiMcpSelfTestPromise) return this.geminiMcpSelfTestPromise
    const cached = this.geminiMcpSelfTestCache
    if (cached && Date.now() - cached.at < 3000) return cached.result
    this.geminiMcpSelfTestPromise = this.runSelfTestGeminiMcpBridgeProcess(socketPath)
      .then((result) => {
        this.geminiMcpSelfTestCache = { at: Date.now(), result }
        return result
      })
      .finally(() => {
        this.geminiMcpSelfTestPromise = null
      })
    return this.geminiMcpSelfTestPromise
  }

  private async runSelfTestGeminiMcpBridgeProcess(
    socketPath: string
  ): Promise<{ ok: boolean; error?: string }> {
    const bridgeCommandStatus = this.taskwraithMcpBridgeCommandStatus()
    if (!bridgeCommandStatus.available) {
      return { ok: false, error: this.taskwraithMcpBridgeCommandUnavailableMessage(bridgeCommandStatus) }
    }
    return new Promise((resolveSelfTest) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let initialized = false
      let proc: ChildProcess | undefined
      const appendLimitedOutput = this.deps.appendLimitedOutput || defaultAppendLimitedOutput

      const finish = (result: { ok: boolean; error?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        try {
          proc?.stdin?.end()
        } catch {
          // Best effort: the bridge process may have already closed stdin.
        }
        if (proc && !proc.killed) {
          proc.kill()
        }
        resolveSelfTest(result)
      }

      const timeout = setTimeout(() => {
        finish({ ok: false, error: 'Timed out waiting for TaskWraith MCP bridge self-test.' })
      }, 5_000)

      try {
        proc = spawn(this.processExecPath(), this.taskwraithMcpBridgeArgs(socketPath), {
          shell: false,
          env: this.deps.createCliEnv(
            { FORCE_COLOR: '0', NO_COLOR: '1', [GEMINI_MCP_BRIDGE_ENV]: '1' },
            this.processExecPath()
          )
        })
      } catch (error) {
        clearTimeout(timeout)
        resolveSelfTest({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }

      proc.stderr?.on('data', (data: Buffer) => {
        stderr = appendLimitedOutput(stderr, data).value
      })

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
        while (true) {
          const lineEnd = stdout.indexOf('\n')
          if (lineEnd < 0) break
          const line = stdout.slice(0, lineEnd).trim()
          stdout = stdout.slice(lineEnd + 1)
          if (!line) continue
          let message: unknown
          try {
            message = JSON.parse(line)
          } catch (error) {
            finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
            return
          }
          const messageRecord = isRecord(message) ? message : {}
          if (messageRecord.id === 1) {
            if (messageRecord.error) {
              finish({
                ok: false,
                error:
                  (isRecord(messageRecord.error) && String(messageRecord.error.message || '')) ||
                  'Initialize failed.'
              })
              return
            }
            initialized = true
            safeMcpStreamWrite(
              proc?.stdin,
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`
            )
            continue
          }
          if (messageRecord.id === 2) {
            if (messageRecord.error) {
              finish({
                ok: false,
                error:
                  (isRecord(messageRecord.error) && String(messageRecord.error.message || '')) ||
                  'Ping failed.'
              })
              return
            }
            safeMcpStreamWrite(
              proc?.stdin,
              `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`
            )
            continue
          }
          if (messageRecord.id === 3) {
            if (messageRecord.error) {
              finish({
                ok: false,
                error:
                  (isRecord(messageRecord.error) && String(messageRecord.error.message || '')) ||
                  'Tool listing failed.'
              })
              return
            }
            const result = isRecord(messageRecord.result) ? messageRecord.result : {}
            const tools = Array.isArray(result.tools) ? result.tools : []
            const names = new Set(
              tools
                .map((tool) => (isRecord(tool) ? String(tool.name || '') : ''))
                .filter(Boolean)
            )
            const missing = TASKWRAITH_MCP_TOOLS.filter((name) => !names.has(name))
            if (missing.length > 0) {
              finish({
                ok: false,
                error: `TaskWraith MCP bridge is connected but missing tools: ${missing.join(', ')}.`
              })
              return
            }
            finish({ ok: true })
            return
          }
        }
      })

      proc.stdin?.on('error', () => {
        // The self-test bridge can exit between status writes; the close handler
        // or timeout will produce the structured status result.
      })
      proc.on('error', (error) => finish({ ok: false, error: error.message }))
      proc.on('close', (code) => {
        if (!settled) {
          finish({
            ok: false,
            error:
              stderr.trim() ||
              `TaskWraith MCP bridge exited before ${initialized ? 'ping completed' : 'initializing'} with code ${code ?? 'unknown'}.`
          })
        }
      })

      safeMcpStreamWrite(
        proc.stdin,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'TaskWraith-self-test', version: this.deps.getAppVersion() || '1.0.0' }
          }
        })}\n`
      )
    })
  }

  async getGeminiMcpBridgeStatus(
    options: {
      autoRepairIfEnabled?: boolean
      cwd?: string
      allowSessionTrustBypass?: boolean
    } = {}
  ): Promise<GeminiMcpBridgeStatus> {
    const settings = this.deps.getSettings()
    const socketPath = this.deps.getGeminiMcpSocketPath()
    if (settings.geminiMcpBridgeEnabled) {
      // Surface broker start failures instead of swallowing them — a dead
      // broker is exactly why participants report "MCP socket is down".
      await this.startGeminiMcpBroker().catch((error) => {
        console.error('[mcp-bridge] broker failed to start during status check', error)
      })
      await this.repairKnownStaleGeminiMcpBridgeConfigs(options.cwd)
    }
    let section = await this.deps.readGeminiCapabilitySection('mcp', options.cwd)
    if (
      !section.items.length &&
      ![section.stdout, section.stderr]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(GEMINI_MCP_SERVER_NAME_LOWER)
    ) {
      const debugResult = await this.deps.runGeminiCapabilityCommand(
        ['mcp', 'list', '--debug'],
        options.cwd
      )
      if (
        debugResult.exitCode === 0 &&
        `${debugResult.stdout}\n${debugResult.stderr}`
          .toLowerCase()
          .includes(GEMINI_MCP_SERVER_NAME_LOWER)
      ) {
        section = {
          kind: 'mcp',
          command: ['gemini', ...debugResult.args],
          format: 'raw',
          items: this.deps.parseCapabilityRawItems(debugResult.stdout, 'mcp'),
          stdout: debugResult.stdout,
          stderr: debugResult.stderr,
          status: debugResult.exitCode,
          timedOut: debugResult.timedOut,
          error: debugResult.error,
          truncated: debugResult.truncated
        }
      }
    }
    const raw = [section.stdout, section.stderr].filter(Boolean).join('\n')
    const staleRegistration = this.hasStaleGeminiMcpBridgeRegistration(raw, socketPath)
    const bridgeItem = section.items.find((item) => {
      const haystack = `${item.id} ${item.name} ${item.detail || ''} ${item.raw || ''}`.toLowerCase()
      return haystack.includes(GEMINI_MCP_SERVER_NAME_LOWER)
    })
    const installed = Boolean(bridgeItem || raw.toLowerCase().includes(GEMINI_MCP_SERVER_NAME_LOWER))
    const disabled = Boolean(
      bridgeItem &&
        /disabled|inactive|off/i.test(`${bridgeItem.status || ''} ${bridgeItem.raw || ''}`)
    )
    const disconnected =
      /disconnected|connection\s+refused|failed\s+to\s+connect|not\s+connected|unavailable|error/i.test(
        `${bridgeItem?.status || ''}\n${bridgeItem?.raw || ''}\n${raw}`
      )
    const bridgeSelfTest =
      installed && disconnected && settings.geminiMcpBridgeEnabled
        ? await this.selfTestGeminiMcpBridgeProcess(socketPath)
        : null
    const available = Boolean(
      installed &&
        !disabled &&
        !staleRegistration &&
        section.status === 0 &&
        !section.error &&
        !section.timedOut &&
        (!disconnected || bridgeSelfTest?.ok)
    )
    const status: GeminiMcpBridgeStatus = {
      checkedAt: new Date().toISOString(),
      enabled: Boolean(settings.geminiMcpBridgeEnabled),
      installed,
      available,
      serverName: GEMINI_MCP_SERVER_NAME,
      socketPath,
      command: ['gemini', 'mcp', 'list'],
      raw,
      ...(section.error || section.parsingError
        ? { error: section.error || section.parsingError }
        : {}),
      message: available
        ? bridgeSelfTest?.ok
          ? 'TaskWraith MCP bridge is installed; direct bridge self-test passed.'
          : 'TaskWraith MCP bridge is installed and enabled.'
        : installed && staleRegistration
          ? 'TaskWraith MCP bridge registration points at an old app bundle or socket and needs repair.'
          : installed && disabled
            ? 'TaskWraith MCP bridge is installed but disabled.'
            : installed && disconnected
              ? bridgeSelfTest?.error
                ? `TaskWraith MCP bridge is installed but disconnected: ${bridgeSelfTest.error}`
                : 'TaskWraith MCP bridge is installed but disconnected.'
              : installed
                ? 'TaskWraith MCP bridge is installed but did not report as available.'
                : 'TaskWraith MCP bridge is not installed.'
    }
    if (options.autoRepairIfEnabled && settings.geminiMcpBridgeEnabled && !status.available) {
      try {
        return await this.repairGeminiMcpBridge(options.cwd)
      } catch (error) {
        const repairMessage = error instanceof Error ? error.message : String(error)
        const repairedStatus: GeminiMcpBridgeStatus = {
          ...status,
          checkedAt: new Date().toISOString(),
          enabled: true,
          available: false,
          error: repairMessage,
          message: `TaskWraith MCP bridge auto-repair failed: ${repairMessage}`
        }
        this.deps.updateSettings({ geminiMcpBridgeLastStatus: repairedStatus })
        return repairedStatus
      }
    }
    this.deps.updateSettings({ geminiMcpBridgeLastStatus: status })
    return status
  }

  buildGeminiMcpBridgeAddArgs(scope: GeminiMcpRegistrationScope, socketPath: string): string[] {
    return [
      'mcp',
      'add',
      GEMINI_MCP_SERVER_NAME,
      this.processExecPath(),
      ...this.taskwraithMcpBridgeArgs(socketPath),
      '--scope',
      scope,
      '--trust',
      ...TASKWRAITH_MCP_TOOLS.map((tool) => `--include-tools=${tool}`)
    ]
  }

  redactGeminiMcpBridgeArgs(args: string[]): string[] {
    return args.map((arg, index) =>
      args[index - 1] === GEMINI_MCP_TOKEN_ARG ? '[redacted-token]' : arg
    )
  }

  async addGeminiMcpBridgeRegistration(
    geminiBinaryPath: string,
    scope: GeminiMcpRegistrationScope,
    socketPath: string,
    cwd?: string
  ): Promise<void> {
    this.assertTaskWraithMcpBridgeCommandAvailable()
    // Remove orphaned pre-rebrand registrations (old --*-gemini-mcp-bridge flag)
    // before adding ours, so `gemini mcp list` probes don't keep spawning a stale
    // binary on every status check. Best-effort; never blocks registration.
    await this.pruneStaleGeminiMcpBridgeRegistrations(geminiBinaryPath, cwd)
    const addArgs = this.buildGeminiMcpBridgeAddArgs(scope, socketPath)
    const addResult = await this.deps.captureProcessOutput(geminiBinaryPath, addArgs, cwd, 15_000)
    if (addResult.code !== 0) {
      const output = (
        addResult.stderr ||
        addResult.stdout ||
        addResult.error ||
        'gemini mcp add failed.'
      ).trim()
      const safeArgs = this.redactGeminiMcpBridgeArgs(addArgs)
      throw new Error(
        `TaskWraith MCP bridge ${scope} registration failed for Gemini CLI (exit ${addResult.code ?? 'unknown'}): gemini ${safeArgs.join(' ')}\n${output}`
      )
    }
  }

  /**
   * Prune orphaned pre-rebrand bridge registrations from the gemini user
   * settings. Across a rebrand the bridge CLI flag changes
   * (--agentbench-gemini-mcp-bridge → --taskwraith-gemini-mcp-bridge); the old
   * registration lingers pointing at THIS binary with the OLD flag. The gate now
   * routes such a spawn to bridge-mode (it exits cleanly), but the entry still
   * makes `gemini mcp list` spawn a doomed process on every probe, so remove any
   * entry (other than ours) carrying a legacy bridge flag.
   */
  async pruneStaleGeminiMcpBridgeRegistrations(
    geminiBinaryPath: string,
    cwd?: string
  ): Promise<string[]> {
    let settings: unknown
    try {
      settings = JSON.parse(fsSync.readFileSync(this.deps.getGeminiUserSettingsPath(), 'utf-8'))
    } catch {
      return []
    }
    const servers = isRecord(settings) && isRecord(settings.mcpServers) ? settings.mcpServers : {}
    const removed: string[] = []
    for (const [name, server] of Object.entries(servers)) {
      if (name === GEMINI_MCP_SERVER_NAME) continue
      const args = isRecord(server) && Array.isArray(server.args) ? server.args.map(String) : []
      const hasStaleBridgeArg = args.some(
        (arg) => arg.endsWith(GEMINI_MCP_BRIDGE_ARG_SUFFIX) && arg !== GEMINI_MCP_BRIDGE_ARG
      )
      if (!hasStaleBridgeArg) continue
      try {
        await this.deps.captureProcessOutput(geminiBinaryPath, ['mcp', 'remove', name], cwd, 10_000)
        removed.push(name)
      } catch {
        // best-effort — a failed prune must never block (re)registration
      }
    }
    return removed
  }

  geminiMcpBridgeServerNeedsRepair(server: unknown, socketPath: string): boolean {
    if (!isRecord(server)) {
      return false
    }
    const args = Array.isArray(server.args) ? server.args.map(String) : []
    const includeTools = Array.isArray(server.includeTools) ? server.includeTools.map(String) : []
    return (
      server.command !== this.processExecPath() ||
      server.trust !== true ||
      !this.bridgeArgsMatchCurrentLaunch(args, socketPath) ||
      !TASKWRAITH_MCP_TOOLS.every((tool) => includeTools.includes(tool))
    )
  }

  userGeminiMcpBridgeNeedsRepair(socketPath: string): boolean {
    try {
      const raw = fsSync.readFileSync(this.deps.getGeminiUserSettingsPath(), 'utf-8')
      const settings = JSON.parse(raw)
      return this.geminiMcpBridgeServerNeedsRepair(
        settings?.mcpServers?.[GEMINI_MCP_SERVER_NAME],
        socketPath
      )
    } catch {
      return false
    }
  }

  async repairKnownStaleGeminiMcpBridgeConfigs(cwd?: string): Promise<void> {
    if (!this.deps.getSettings().geminiMcpBridgeEnabled) {
      return
    }
    const resolved = await this.deps.resolveCliProviderBinary('gemini')
    if (!resolved.binaryPath) {
      return
    }
    const socketPath = this.deps.getGeminiMcpSocketPath()
    if (this.userGeminiMcpBridgeNeedsRepair(socketPath)) {
      await this.addGeminiMcpBridgeRegistration(resolved.binaryPath, 'user', socketPath)
      this.geminiMcpBridgeInstalledForCurrentToken = true
    }
    if (cwd) {
      await this.repairProjectGeminiMcpBridgeIfNeeded(resolved.binaryPath, cwd, socketPath)
    }
  }

  hasStaleGeminiMcpBridgeRegistration(raw: string, socketPath: string): boolean {
    if (!raw.toLowerCase().includes(GEMINI_MCP_SERVER_NAME_LOWER)) {
      return false
    }
    if (/\/Applications\/TaskWraith\.app\//i.test(raw)) {
      return true
    }
    if (
      /Application Support\/taskwraith\//i.test(raw) &&
      !socketPath.includes('/Application Support/taskwraith/')
    ) {
      return true
    }
    if (this.deps.isDev() && raw.includes(GEMINI_MCP_BRIDGE_ARG) && !raw.includes(this.deps.getAppPath())) {
      return true
    }
    return this.deps.isPackaged() && !raw.includes(this.processExecPath())
  }

  projectGeminiMcpBridgeNeedsRepair(cwd: string, socketPath: string): boolean {
    const settingsPath = join(resolve(cwd), '.gemini', 'settings.json')
    try {
      const raw = fsSync.readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      return this.geminiMcpBridgeServerNeedsRepair(
        settings?.mcpServers?.[GEMINI_MCP_SERVER_NAME],
        socketPath
      )
    } catch {
      return false
    }
  }

  async repairProjectGeminiMcpBridgeIfNeeded(
    geminiBinaryPath: string,
    cwd: string,
    socketPath: string
  ): Promise<void> {
    if (!this.projectGeminiMcpBridgeNeedsRepair(cwd, socketPath)) {
      return
    }
    await this.addGeminiMcpBridgeRegistration(geminiBinaryPath, 'project', socketPath, cwd)
  }

  async installGeminiMcpBridge(cwd?: string): Promise<GeminiMcpBridgeStatus> {
    await this.startGeminiMcpBroker()
    const resolved = await this.deps.resolveCliProviderBinary('gemini')
    if (!resolved.binaryPath) {
      throw new Error(resolved.error || 'Gemini CLI is not configured.')
    }
    const socketPath = this.deps.getGeminiMcpSocketPath()
    await this.addGeminiMcpBridgeRegistration(resolved.binaryPath, 'user', socketPath)
    if (cwd) {
      await this.repairProjectGeminiMcpBridgeIfNeeded(resolved.binaryPath, cwd, socketPath)
    }
    await this.deps.captureProcessOutput(
      resolved.binaryPath,
      ['mcp', 'enable', GEMINI_MCP_SERVER_NAME],
      undefined,
      8_000
    )
    this.geminiMcpBridgeInstalledForCurrentToken = true
    this.deps.updateSettings({ geminiMcpBridgeEnabled: true })
    return this.getGeminiMcpBridgeStatus(cwd ? { cwd } : undefined)
  }

  async repairGeminiMcpBridge(cwd?: string): Promise<GeminiMcpBridgeStatus> {
    if (!this.geminiMcpBridgeRepairPromise) {
      this.geminiMcpBridgeRepairPromise = this.installGeminiMcpBridge(cwd).finally(() => {
        this.geminiMcpBridgeRepairPromise = null
      })
    }
    const status = await this.geminiMcpBridgeRepairPromise
    if (!cwd) {
      return status
    }
    const resolved = await this.deps.resolveCliProviderBinary('gemini')
    if (!resolved.binaryPath) {
      return status
    }
    const socketPath = this.deps.getGeminiMcpSocketPath()
    await this.repairProjectGeminiMcpBridgeIfNeeded(resolved.binaryPath, cwd, socketPath)
    return this.getGeminiMcpBridgeStatus({ cwd })
  }

  async setGeminiMcpBridgeEnabled(enabled: boolean): Promise<GeminiMcpBridgeStatus> {
    this.deps.updateSettings({ geminiMcpBridgeEnabled: Boolean(enabled) })
    if (enabled) {
      return this.repairGeminiMcpBridge()
    }
    this.geminiMcpBridgeInstalledForCurrentToken = false
    const statusBefore = await this.getGeminiMcpBridgeStatus()
    if (statusBefore.installed) {
      const resolved = await this.deps.resolveCliProviderBinary('gemini')
      if (resolved.binaryPath) {
        await this.deps.captureProcessOutput(
          resolved.binaryPath,
          ['mcp', enabled ? 'enable' : 'disable', GEMINI_MCP_SERVER_NAME],
          undefined,
          8_000
        )
      }
    }
    const status = await this.getGeminiMcpBridgeStatus()
    this.deps.updateSettings({
      geminiMcpBridgeEnabled: Boolean(enabled),
      geminiMcpBridgeLastStatus: status
    })
    return { ...status, enabled: Boolean(enabled) }
  }

  async prepareGeminiMcpBridgeForRun(
    sender: WebContents,
    cwd: string,
    route?: McpBridgeAgentRunRoute | null,
    scope: ChatScope = 'workspace',
    sessionTrust = false,
    options: GeminiMcpBridgePrepareOptions = {}
  ): Promise<McpBridgeAgentRunRoute> {
    const routed = routeWithRunId('gemini', route)
    const settings = this.deps.getSettings()
    const resolvedCwd = resolve(cwd)
    const requireWriteTools = Boolean(options.requireWriteTools && scope !== 'global')
    let runContextInstallAttempted = false
    let cleanupAttempted = false
    const assertRunAuthorized = (
      boundary: GeminiMcpBridgePreparationBoundary
    ): void => {
      if (options.setupSignal?.aborted || options.isRunAuthorized?.() === false) {
        let runContextCleanup: GeminiMcpBridgePreparationRevocationReceipt['runContextCleanup'] =
          runContextInstallAttempted ? 'unavailable' : 'not-required'
        let cleanupError: string | undefined
        if (
          runContextInstallAttempted &&
          !cleanupAttempted &&
          options.cleanupInstalledRunContextOnRevocation
        ) {
          cleanupAttempted = true
          try {
            options.cleanupInstalledRunContextOnRevocation(routed)
            runContextCleanup = 'completed'
          } catch (error) {
            runContextCleanup = 'failed'
            cleanupError = error instanceof Error ? error.message : String(error)
          }
        }
        throw new GeminiMcpBridgePreparationAbortedError({
          kind: 'run-authority-revoked',
          boundary,
          sharedBridgeState: 'retained-for-other-runs',
          runContextCleanup,
          ...(cleanupError ? { cleanupError } : {})
        })
      }
    }
    assertRunAuthorized('initial')
    if (settings.geminiMcpBridgeEnabled || requireWriteTools) {
      assertRunAuthorized('initial')
      if (requireWriteTools && !settings.geminiMcpBridgeEnabled) {
        this.deps.sendAgentCompatLine(
          sender,
          'gemini',
          {
            type: 'provider_warning',
            provider: 'gemini',
            severity: 'warning',
            title: 'TaskWraith MCP bridge auto-repair',
            message:
              'Write-capable Gemini runs require the TaskWraith MCP bridge. TaskWraith is enabling and repairing it before launch.'
          },
          routed
        )
        assertRunAuthorized('bridge-enable-warning')
        this.deps.updateSettings({ geminiMcpBridgeEnabled: true })
        assertRunAuthorized('bridge-enable-setting')
      }
      await this.startGeminiMcpBroker()
      assertRunAuthorized('broker-start')
      if (!this.geminiMcpBridgeInstalledForCurrentToken) {
        await this.repairGeminiMcpBridge(resolvedCwd)
        assertRunAuthorized('bridge-repair')
      }
      const status = await this.getGeminiMcpBridgeStatus({
        autoRepairIfEnabled: true,
        cwd: resolvedCwd,
        allowSessionTrustBypass: sessionTrust
      })
      assertRunAuthorized('bridge-status')
      if (!status.available) {
        throw new Error(
          `TaskWraith MCP bridge repair failed: ${status.message || status.error || 'unknown status'}. Gemini write-capable mode was not launched because it would start without file-edit tools.`
        )
      }
      if (requireWriteTools) {
        const toolSelfTest = await this.selfTestGeminiMcpBridgeProcess(
          this.deps.getGeminiMcpSocketPath()
        )
        assertRunAuthorized('bridge-self-test')
        if (!toolSelfTest.ok) {
          throw new Error(
            `TaskWraith MCP bridge repair failed: ${toolSelfTest.error || 'write tools were not advertised by the bridge'}. Gemini write-capable mode was not launched because it would start without file-edit tools.`
          )
        }
      }
    }

    assertRunAuthorized('run-context-install')
    runContextInstallAttempted = true
    let installedRoute: McpBridgeAgentRunRoute
    try {
      installedRoute = await this.deps.installGeminiToolContextForRun(
        sender,
        resolvedCwd,
        routed,
        scope,
        sessionTrust,
        options
      )
    } catch (error) {
      assertRunAuthorized('run-context-install')
      throw error
    }
    assertRunAuthorized('run-context-install')
    return installedRoute
  }

  async addKimiMcpBridgeRegistration(
    _kimiBinaryPath: string,
    _socketPath: string
  ): Promise<void> {
    throw new Error(
      'Global Kimi MCP registration is retired; managed Kimi uses a per-run authenticated HTTP gateway.'
    )
  }

  async removeKimiMcpBridgeRegistration(
    _kimiBinaryPath: string,
    _serverName: string
  ): Promise<boolean> {
    return false
  }

  async pruneLegacyKimiMcpBridgeRegistrations(_kimiBinaryPath: string): Promise<string[]> {
    return []
  }

  async installKimiMcpBridge(): Promise<void> {
    throw new Error(
      'Global Kimi MCP repair is retired; managed Kimi requires its per-run HTTP gateway.'
    )
  }

  async repairKimiMcpBridge(): Promise<void> {
    await this.installKimiMcpBridge()
  }

  async prepareKimiMcpBridgeForRun(_sender: WebContents): Promise<boolean> {
    // Legacy Wire/print repair is inert. Production ACP starts an authenticated
    // per-run HTTP gateway inside its launch composition instead.
    return false
  }

  getGeminiMcpBridgeInstalledForCurrentToken(): boolean {
    return this.geminiMcpBridgeInstalledForCurrentToken
  }

  getKimiMcpBridgeInstalledForCurrentToken(): boolean {
    return this.kimiMcpBridgeInstalledForCurrentToken
  }
}

function coerceRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function createMcpBridgeRuntime(deps: McpBridgeRuntimeDeps): McpBridgeRuntime {
  return new McpBridgeRuntime(deps)
}
