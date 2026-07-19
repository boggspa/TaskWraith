import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import os from 'os'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { isPathInsideWorkspace } from '../AgenticPolicy'
import {
  buildCreativeAppCapabilitySnapshot,
  buildCreativeAppStatusSnapshot,
  buildCreativeProjectSnapshot,
  buildFcpxmlTimelineDiffPlan,
  buildFcpxmlTimelineIr,
  isCreativeAppId,
  listCreativeAppBundleIds,
  serializeFcpxmlTimelineIr,
  validateFcpxml,
  type CreativeAppId,
  type CreativeAttachedWindowMeta,
  type FcpxmlTimelineIr
} from '../CreativeAppAdapters'
import {
  APPLESCRIPT_CLASSES,
  findAppleScriptClass,
  formatAppleScriptClassName
} from '../CreativeAppleScriptClasses'
import {
  BLENDER_CLASSES,
  findBlenderClass,
  formatBlenderClassName
} from '../CreativeBlenderClasses'
import type {
  CreativeApprovalDecision,
  CreativeApprovalRequestDetails
} from '../CreativeApprovalGate'
import {
  buildEditorPositionalArgs,
  findEditorById,
  isEditorId,
  listEditorAdapters,
  listEditorBundleIds,
  type EditorAdapter,
  type EditorId
} from '../EditorAdapters'
import { assertAgenticServiceId } from '../AgenticServiceMessages'
import { redactGeminiProfileForMcp } from '../GeminiAuthRedaction'
import { buildProviderAuthStatusV2 } from '../ProviderAuthStatus'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import { summarizeProviderUsage, type ProviderUsageSummary } from '../ProviderUsageStatus'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../shared/retiredProviders'
import type { NativeCapabilitySnapshot } from '../NativeCapabilities'
import type {
  AppSettings,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  ChatRecord,
  ChatScope,
  GeminiAuthStatus,
  HandoffCard,
  ProviderId,
  RunEventArtifactRef,
  RunEventFilter,
  RunEventRecord,
  RunEventReplay
} from '../store/types'

const MAX_MCP_TEXT_CHARS = 200_000
const MAX_CREATIVE_PROJECT_SNAPSHOT_BYTES = 2_000_000
const CREATIVE_RUNNING_PROBE_TTL_MS = 3_000
const FCPXML_DTD_CACHE_DIR = `${os.tmpdir()}/taskwraith-fcpxml-dtds`

// Structural status/decode allowlist only. Live authority is enforced by each
// operation's canonical provider admission gate.
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
])
export type McpToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export type McpToolExecutionResult = {
  text: string
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: McpToolContentBlock[]
}

export interface DesktopToolContext {
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appRunId?: string
  appChatId?: string
  providerSessionId?: string | null
  approvalMode?: string
  sessionTrust?: boolean
  runtimeProfileId?: string
}

export type AttachedWindowStreamingSnapshot = {
  fps: number
  bufferSeconds: number
  frameCount: number
  startedAt: string
}

export type AttachedWindowSnapshot = {
  handleID: string
  windowMeta: {
    windowID: number
    title: string
    bundleID: string
    applicationName: string
    pid: number
  }
  attachedAt: string
  streaming?: AttachedWindowStreamingSnapshot
}

export interface DesktopBridgeDaemon {
  status(): { running: boolean; startedAt: string | null; pid: number | null }
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

export interface CreativeApprovalGateLike {
  requestApproval(
    className: string,
    details: CreativeApprovalRequestDetails
  ): Promise<CreativeApprovalDecision>
}

export interface DesktopAttachedWindowState {
  get(): AttachedWindowSnapshot | null
  set(snapshot: AttachedWindowSnapshot | null): void
}

export interface DesktopToolStore {
  getSettings(): AppSettings
  getApprovalLedger(filter?: ApprovalLedgerFilter): ApprovalLedgerRecord[]
  getProviderUsageSnapshot(provider: ProviderId): unknown
  getChat(chatId: string): ChatRecord | null
  saveChat(chat: ChatRecord): void
  getHandoffCards(): HandoffCard[]
  saveHandoffCard(
    input: Partial<HandoffCard> &
      Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  ): HandoffCard
}

export interface DesktopRunRepository {
  getRunEventReplay(runId: string): RunEventReplay
  getRunEvents(filter?: RunEventFilter): RunEventRecord[]
}

export interface DesktopShell {
  showItemInFolder(path: string): void
  openPath(path: string): Promise<string>
}

export interface ProviderAuthStatusProbe {
  available: boolean
  authState?: string
  error?: string
  [key: string]: unknown
}

export interface DesktopProviderAuthDeps {
  getGeminiAuthStatusSnapshot(): Promise<GeminiAuthStatus>
  getCliProviderStatus(provider: ProviderId): Promise<ProviderAuthStatusProbe>
  getStoredClaudeApiKey(): unknown
  getStoredKimiApiKey(): unknown
  encryptionAvailable(): boolean
  isCodexClientStarted(): boolean
}

export interface DesktopToolExecutorDeps {
  getBridgeDaemon(): DesktopBridgeDaemon | null
  getNativeCapabilities?: () => NativeCapabilitySnapshot
  getCreativeApprovalGate(): CreativeApprovalGateLike | null
  attachedWindow: DesktopAttachedWindowState
  store: DesktopToolStore
  runRepository: DesktopRunRepository
  shell: DesktopShell
  providerAuth?: DesktopProviderAuthDeps
  notifyRenderer?: (channel: string, payload: unknown) => void
  logger?: Pick<Console, 'warn'>
}

type AgentVisibleRunEventArtifactRef = Omit<RunEventArtifactRef, 'path'>

/**
 * Artifact paths are main-owned implementation details. In particular, a
 * Project reference snapshot lives outside the agent's workspace and must not
 * be re-disclosed through run-history tools.
 */
function redactRunEventArtifactPaths(
  artifacts: RunEventArtifactRef[] | undefined
): AgentVisibleRunEventArtifactRef[] | undefined {
  return artifacts?.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.sequence === undefined ? {} : { sequence: artifact.sequence }),
    ...(artifact.metadata ? { metadata: { ...artifact.metadata } } : {})
  }))
}

export const DESKTOP_MCP_TOOL_NAMES = [
  'attached_window_capture',
  'attached_window_status',
  'appwatch_start',
  'appwatch_stop',
  'appwatch_status',
  'appwatch_latest_frame',
  'appwatch_frames',
  'approval_status',
  'provider_auth_status',
  'provider_usage_status',
  'run_timeline',
  'raw_provider_events',
  'open_workspace_file',
  'creative_app_status',
  'creative_app_capabilities',
  'creative_project_snapshot',
  'creative_timeline_validate',
  'creative_timeline_ir',
  'creative_timeline_diff',
  'creative_timeline_import',
  'creative_applescript_dispatch',
  'creative_blender_python',
  'creative_midi_dispatch',
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'create_handoff_card',
  'agent_delegation_role'
] as const satisfies readonly TaskWraithMcpToolName[]

export type DesktopMcpToolName = (typeof DESKTOP_MCP_TOOL_NAMES)[number]

const DESKTOP_MCP_TOOL_NAME_SET = new Set<string>(DESKTOP_MCP_TOOL_NAMES)
const NATIVE_BRIDGE_TOOL_NAMES = new Set<string>([
  'creative_timeline_import',
  'creative_applescript_dispatch',
  'creative_blender_python',
  'creative_midi_dispatch',
  'open_in_ide',
  'open_in_ide_at_position',
  'reveal_in_finder',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides'
])

export function isDesktopMcpToolName(toolName: string): toolName is DesktopMcpToolName {
  return DESKTOP_MCP_TOOL_NAME_SET.has(toolName)
}

type AttachedWindowDaemonCaptureResult = {
  ok?: boolean
  pngBase64?: string
  byteLength?: number
  width?: number
  height?: number
  windowMeta?: AttachedWindowSnapshot['windowMeta']
  capturedAt?: string
  ocr?: { text?: string; blocks?: unknown[] }
  ocrError?: string
}

type AppwatchStartDaemonResult = {
  ok?: boolean
  handleID?: string
  streaming?: {
    fps?: number
    bufferSeconds?: number
    frameCount?: number
    frameCapacity?: number
    estimatedMemoryMB?: number
    memoryBudgetMB?: number
    startedAt?: string
  }
}
type AppwatchStopDaemonResult = { ok?: boolean; handleID?: string; streaming?: false }
type AppwatchStatusDaemonResult = {
  ok?: boolean
  handleID?: string
  streaming?: boolean
  fps?: number
  bufferSeconds?: number
  frameCount?: number
  frameCapacity?: number
  estimatedMemoryMB?: number
  memoryBudgetMB?: number
  oldestAt?: string
  newestAt?: string
  lastPullAt?: string
  startedAt?: string
}
type AppwatchLatestFrameDaemonResult = {
  ok?: boolean
  handleID?: string
  hasFrame?: boolean
  pngBase64?: string
  byteLength?: number
  width?: number
  height?: number
  capturedAt?: string
}
type AppwatchFrameDaemonResult = {
  index?: number
  capturedAt?: string
  mimeType?: string
  imageBase64?: string
  byteLength?: number
  width?: number
  height?: number
  ocr?: Record<string, unknown>
  ocrError?: string
}
type AppwatchFramesDaemonResult = {
  ok?: boolean
  handleID?: string
  hasFrames?: boolean
  returned?: number
  requested?: number
  count?: number
  format?: 'jpeg' | 'png'
  includeOCR?: boolean
  nextSince?: string
  availableCapturedAt?: string[]
  frames?: AppwatchFrameDaemonResult[]
}

interface FcpxmlDtdPreflightResult {
  status: 'valid' | 'invalid' | 'skipped'
  dtdPath?: string
  stderr?: string
  exitCode?: number
  skipReason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
}

function availableProviderIds(): ProviderId[] {
  // Offer/sweep list for MCP desktop tools — excludes retired Gemini and
  // security-unavailable Cursor so an agent can neither target nor sweep them.
  // `assertProviderId` above still accepts canonical ids for compatibility decode.
  return [...LIVE_SELECTABLE_PROVIDER_IDS]
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : []
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
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

export function mcpStructuredJsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const text = mcpJson(value)
  return {
    text,
    structuredContent: value,
    content: [{ type: 'text', text }, ...extraContent]
  }
}

function resolveWorkspaceChild(workspace: string, filePath: string): string {
  const workspaceRoot = resolve(workspace)
  const targetPath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath)
  const rel = relative(workspaceRoot, targetPath)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !isPathInsideWorkspace(workspaceRoot, targetPath)
  ) {
    throw new Error('Path is outside the workspace.')
  }
  return targetPath
}

function toWorkspaceRelativePath(workspace: string, targetPath: string): string {
  return relative(resolve(workspace), resolve(targetPath)).replace(/\\/g, '/')
}

function resolveMcpPath(workspacePath: string, filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('A workspace path is required.')
  }
  return resolveWorkspaceChild(workspacePath, filePath)
}

function resolveMcpScopedPath(context: DesktopToolContext, filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(
      context.scope === 'global' ? 'A host path is required.' : 'A workspace path is required.'
    )
  }
  if (context.scope === 'global') {
    return isAbsolute(filePath) ? resolve(filePath) : resolve(context.cwd, filePath)
  }
  return resolveMcpPath(context.workspacePath || context.cwd, filePath)
}

function formatScopedPath(context: DesktopToolContext, targetPath: string): string {
  if (context.scope === 'global') return resolve(targetPath)
  const workspaceRoot = resolve(context.workspacePath || context.cwd)
  return isPathInsideWorkspace(workspaceRoot, targetPath)
    ? toWorkspaceRelativePath(workspaceRoot, targetPath)
    : resolve(targetPath)
}

function sanitizeHandoffStatus(value: unknown): HandoffCard['status'] {
  return value === 'dispatched' || value === 'archived' ? value : 'draft'
}

function sanitizeHandoffCardForSave(
  card: unknown
): Partial<HandoffCard> &
  Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'> {
  const input = requireRecord(card, 'Handoff card')
  const sourceChatId = requireNonEmptyString(input.sourceChatId, 'Handoff source chat')
  const sourceProvider = assertProviderId(input.sourceProvider)
  const recommendedProvider =
    input.recommendedProvider === undefined
      ? undefined
      : assertProviderId(input.recommendedProvider)
  return {
    id: optionalString(input.id),
    status: sanitizeHandoffStatus(input.status),
    sourceChatId,
    sourceRunId: optionalString(input.sourceRunId),
    sourceProvider,
    workspaceId: optionalString(input.workspaceId),
    workspacePath: optionalString(input.workspacePath),
    summary: requireNonEmptyString(input.summary, 'Handoff summary'),
    selectedFiles: stringList(input.selectedFiles),
    workspaceChangeSetIds: stringList(input.workspaceChangeSetIds),
    rawEventRunIds: stringList(input.rawEventRunIds),
    recommendedProvider,
    recommendedModel: optionalString(input.recommendedModel),
    recommendedApprovalMode: optionalString(input.recommendedApprovalMode),
    targetChatId: optionalString(input.targetChatId),
    dispatchedRunId: optionalString(input.dispatchedRunId),
    finalPrompt: requireNonEmptyString(input.finalPrompt, 'Handoff prompt'),
    dispatchedAt: optionalString(input.dispatchedAt)
  }
}

function mcpStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function bridgeDaemonErrorCode(error: unknown): number | null {
  return isRecord(error) && typeof error.code === 'number' ? error.code : null
}

function desktopToolJsonResult(value: unknown): McpToolExecutionResult {
  const structuredContent = isRecord(value) ? value : { value }
  return {
    text: mcpJson(value),
    structuredContent,
    content: [{ type: 'text', text: mcpJson(value) }]
  }
}

async function readFilePrefixBytes(targetPath: string, sizeBytes: number): Promise<Buffer> {
  const bytesToRead = Math.min(sizeBytes, MAX_CREATIVE_PROJECT_SNAPSHOT_BYTES)
  const handle = await fs.open(targetPath, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const result = await handle.read(buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function shouldDecodeCreativeProjectText(extension: string, buffer: Buffer): boolean {
  const normalized = extension.toLowerCase()
  if (normalized === '.fcpxml' || normalized === '.musicxml' || normalized === '.xml') {
    return true
  }
  const prefix = buffer.subarray(0, 200).toString('utf8').toLowerCase()
  return prefix.includes('<fcpxml') || prefix.includes('<score-partwise')
}

async function locateFcpxmlDtd(fcpxmlVersion: string): Promise<string | undefined> {
  const dtdDir =
    '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources'
  if (!fsSync.existsSync(dtdDir)) return undefined
  let entries: string[] = []
  try {
    entries = await fs.readdir(dtdDir)
  } catch {
    return undefined
  }
  const dtds = entries
    .map((entry) => {
      const match = entry.match(/^FCPXMLv(\d+)_(\d+)\.dtd$/)
      if (!match) return null
      return { file: entry, major: Number(match[1]), minor: Number(match[2]) }
    })
    .filter((entry): entry is { file: string; major: number; minor: number } => entry !== null)
  if (dtds.length === 0) return undefined
  const targetParts = fcpxmlVersion.split('.').map(Number)
  const targetMajor = targetParts[0] ?? 1
  const targetMinor = targetParts[1] ?? 13
  const sortable = (d: { major: number; minor: number }) => d.major * 1000 + d.minor
  const target = targetMajor * 1000 + targetMinor
  const exact = dtds.find((d) => d.major === targetMajor && d.minor === targetMinor)
  const lowerOrEqual = dtds.filter((d) => sortable(d) <= target)
  const choice =
    exact ||
    (lowerOrEqual.length > 0
      ? lowerOrEqual.reduce((acc, d) => (sortable(d) > sortable(acc) ? d : acc))
      : dtds.reduce((acc, d) => (sortable(d) > sortable(acc) ? d : acc)))
  const sourcePath = `${dtdDir}/${choice.file}`
  await fs.mkdir(FCPXML_DTD_CACHE_DIR, { recursive: true })
  const cachedPath = `${FCPXML_DTD_CACHE_DIR}/${choice.file}`
  try {
    await fs.copyFile(sourcePath, cachedPath)
  } catch {
    return sourcePath
  }
  return cachedPath
}

async function runFcpxmlDtdPreflight(input: {
  filePath: string
  fcpxmlVersion: string
}): Promise<FcpxmlDtdPreflightResult> {
  const dtdPath = await locateFcpxmlDtd(input.fcpxmlVersion)
  if (!dtdPath) {
    return {
      status: 'skipped',
      skipReason:
        'No FCPXML DTD found on disk. Install Final Cut Pro to enable DTD preflight (DTDs ship inside FCP.app).'
    }
  }
  if (!fsSync.existsSync('/usr/bin/xmllint')) {
    return {
      status: 'skipped',
      skipReason: 'xmllint not available at /usr/bin/xmllint.'
    }
  }
  return new Promise<FcpxmlDtdPreflightResult>((resolvePreflight) => {
    const child = spawn('/usr/bin/xmllint', ['--noout', '--dtdvalid', dtdPath, input.filePath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePreflight({ status: 'valid', dtdPath })
      } else if (stderr.length > 0) {
        resolvePreflight({
          status: 'invalid',
          dtdPath,
          stderr: stderr.trim(),
          exitCode: code ?? -1
        })
      } else {
        resolvePreflight({
          status: 'skipped',
          dtdPath,
          exitCode: code ?? -1,
          skipReason: `xmllint exited ${code} with no diagnostic output.`
        })
      }
    })
    child.on('error', (err) => {
      resolvePreflight({
        status: 'skipped',
        dtdPath,
        skipReason: `xmllint spawn failed: ${err.message}`
      })
    })
  })
}

export function createDesktopToolExecutors(deps: DesktopToolExecutorDeps) {
  let creativeRunningProbeCache: { fetchedAt: number; running: Map<string, boolean> } | null = null

  function notifyAttachedWindowChanged(snapshot: AttachedWindowSnapshot | null): void {
    deps.notifyRenderer?.('attached-window-changed', snapshot)
  }

  function setAttachedWindowStreaming(streaming: AttachedWindowStreamingSnapshot | null): void {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) return
    const next: AttachedWindowSnapshot = {
      ...snapshot,
      streaming: streaming ?? undefined
    }
    deps.attachedWindow.set(next)
    notifyAttachedWindowChanged(next)
  }

  function handleAppwatchWindowGone(): void {
    deps.attachedWindow.set(null)
    notifyAttachedWindowChanged(null)
  }

  function unsupportedNativeToolResult(tool: DesktopMcpToolName): McpToolExecutionResult | null {
    const capabilities = deps.getNativeCapabilities?.()
    if (!capabilities) return null
    const feature = tool.startsWith('appwatch_')
      ? capabilities.appwatch
      : tool.startsWith('attached_window_')
        ? capabilities.screenWatch
        : tool === 'creative_applescript_dispatch'
          ? capabilities.appleEvents
          : NATIVE_BRIDGE_TOOL_NAMES.has(tool)
            ? capabilities.bridge
            : { available: true }
    if (feature.available) return null
    return mcpStructuredJsonResult({
      ok: false,
      tool,
      unsupported: true,
      error: feature.reason || 'This native bridge feature is unavailable on this host.',
      nativeCapabilities: capabilities
    })
  }

  function currentCreativeAttachedWindowMeta(): CreativeAttachedWindowMeta | null {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) return null
    return {
      windowID: snapshot.windowMeta.windowID,
      title: snapshot.windowMeta.title,
      bundleID: snapshot.windowMeta.bundleID,
      applicationName: snapshot.windowMeta.applicationName,
      pid: snapshot.windowMeta.pid
    }
  }

  async function bundleIdRunningProbe(): Promise<(bundleId: string) => boolean> {
    const daemon = deps.getBridgeDaemon()
    if (!daemon) return () => false
    const now = Date.now()
    if (
      creativeRunningProbeCache &&
      now - creativeRunningProbeCache.fetchedAt < CREATIVE_RUNNING_PROBE_TTL_MS
    ) {
      const cached = creativeRunningProbeCache.running
      return (bundleId) => cached.get(bundleId) === true
    }
    const bundleIds = [...listCreativeAppBundleIds(), ...listEditorBundleIds()]
    if (bundleIds.length === 0) return () => false
    try {
      const result = await daemon.request<Record<string, boolean>>(
        'creative.runningApplications',
        { bundleIds },
        { timeoutMs: 2_000 }
      )
      const running = new Map<string, boolean>()
      for (const id of bundleIds) running.set(id, result?.[id] === true)
      creativeRunningProbeCache = { fetchedAt: now, running }
      return (bundleId) => running.get(bundleId) === true
    } catch (err) {
      deps.logger?.warn('[bundleIdRunningProbe] daemon probe failed:', (err as Error).message)
      return () => false
    }
  }

  async function creativeAppRunningHint(): Promise<(bundleId: string) => boolean> {
    return bundleIdRunningProbe()
  }

  function creativeAppIdFromArgs(args: Record<string, unknown>): CreativeAppId | undefined {
    const value = optionalString(args.appId || args.app || args.id)
    if (!value) return undefined
    if (!isCreativeAppId(value)) {
      throw new Error('creative app id must be one of final-cut-pro, logic-pro, blender.')
    }
    return value
  }

  function resolveEditorArg(arg: unknown): EditorAdapter | undefined {
    if (typeof arg !== 'string' || arg.length === 0) return undefined
    if (isEditorId(arg)) return findEditorById(arg as EditorId)
    return listEditorAdapters().find((adapter) => adapter.bundleIds.includes(arg))
  }

  function summarizeApprovalRecord(record: ApprovalLedgerRecord, includePreview: boolean) {
    return {
      approvalId: record.approvalId,
      provider: record.provider,
      service: record.service,
      method: record.method,
      title: record.title,
      status: record.status,
      requestedAt: record.requestedAt,
      respondedAt: record.respondedAt,
      decision: record.decision,
      decisionSource: record.decisionSource,
      grantedScope: record.grantedScope,
      expiration: record.expiration,
      runId: record.runId,
      chatId: record.chatId,
      workspaceId: record.workspaceId,
      workspacePath: record.workspacePath,
      ...(includePreview ? { body: record.body, preview: record.preview } : {})
    }
  }

  async function readCreativeTimelineFcpxml(
    rawPath: string,
    context: DesktopToolContext,
    toolName: string
  ): Promise<{ path: string; text: string; truncated: boolean }> {
    const targetPath = resolveMcpScopedPath(context, rawPath)
    const stat = await fs.stat(targetPath)
    if (!stat.isFile()) {
      throw new Error(`${toolName} requires a workspace FCPXML file path.`)
    }
    const extension = extname(targetPath).toLowerCase()
    const buffer = await readFilePrefixBytes(targetPath, stat.size)
    const text = buffer.toString('utf8')
    if (extension !== '.fcpxml' && !text.toLowerCase().includes('<fcpxml')) {
      throw new Error(`${toolName} currently supports FCPXML documents only.`)
    }
    return {
      path: formatScopedPath(context, targetPath),
      text,
      truncated: stat.size > buffer.byteLength
    }
  }

  async function executeAttachedWindowCapture(
    args: Record<string, unknown>
  ): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'attached_window_capture',
        error:
          'No window is attached. Ask the user to click "Attach app" so they can pick a window with the macOS system picker.'
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'attached_window_capture',
        error:
          'TaskWraith bridge daemon is not running. Enable it in Settings -> Bridge Networking.'
      })
    }
    const includeOcr = args.include_ocr !== false && args.includeOCR !== false
    const rawMaxDim = Number(args.max_dimension_px ?? args.maxDimensionPx)
    const maxDimensionPx =
      Number.isFinite(rawMaxDim) && rawMaxDim > 0 ? Math.trunc(rawMaxDim) : 1600
    let result: AttachedWindowDaemonCaptureResult
    try {
      result = await daemon.request<AttachedWindowDaemonCaptureResult>(
        'attachedWindow.capture',
        {
          handleID: snapshot.handleID,
          includeOCR: includeOcr,
          maxDimensionPx
        },
        { timeoutMs: 30_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (bridgeDaemonErrorCode(err) === -32001) {
        deps.attachedWindow.set(null)
        notifyAttachedWindowChanged(null)
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'attached_window_capture',
        error: message
      })
    }
    const pngBase64 = typeof result.pngBase64 === 'string' ? result.pngBase64 : ''
    if (!pngBase64) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'attached_window_capture',
        error: 'Bridge daemon returned no PNG payload.'
      })
    }
    return mcpStructuredJsonResult(
      {
        ok: true,
        tool: 'attached_window_capture',
        mimeType: 'image/png',
        byteLength: result.byteLength ?? 0,
        width: result.width ?? 0,
        height: result.height ?? 0,
        windowMeta: result.windowMeta ?? snapshot.windowMeta,
        capturedAt: result.capturedAt ?? new Date().toISOString(),
        ocrText: result.ocr?.text ?? null,
        ocrBlocks: result.ocr?.blocks ?? null,
        ocrError: result.ocrError ?? null
      },
      [{ type: 'image', mimeType: 'image/png', data: pngBase64 }]
    )
  }

  function executeAttachedWindowStatus(): McpToolExecutionResult {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: true,
        tool: 'attached_window_status',
        attached: false
      })
    }
    return mcpStructuredJsonResult({
      ok: true,
      tool: 'attached_window_status',
      attached: true,
      windowMeta: snapshot.windowMeta,
      attachedAt: snapshot.attachedAt,
      streaming: snapshot.streaming ?? null
    })
  }

  async function executeAppwatchStart(
    args: Record<string, unknown>
  ): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_start',
        error:
          'No window is attached. Ask the user to click "Attach app" so they can pick a window before starting Appwatch.'
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_start',
        error:
          'TaskWraith bridge daemon is not running. Enable it in Settings -> Bridge Networking.'
      })
    }
    const fps = Number(args.fps) > 0 ? Math.trunc(Number(args.fps)) : 5
    const bufferSeconds =
      Number(args.buffer_seconds ?? args.bufferSeconds) > 0
        ? Math.trunc(Number(args.buffer_seconds ?? args.bufferSeconds))
        : 8
    const maxDimensionPx =
      Number(args.max_dimension_px ?? args.maxDimensionPx) > 0
        ? Math.trunc(Number(args.max_dimension_px ?? args.maxDimensionPx))
        : 1280
    let result: AppwatchStartDaemonResult
    try {
      result = await daemon.request<AppwatchStartDaemonResult>(
        'appwatch.start',
        {
          handleID: snapshot.handleID,
          fps,
          bufferSeconds,
          maxDimensionPx
        },
        { timeoutMs: 15_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const daemonCode = bridgeDaemonErrorCode(err)
      if (daemonCode === -32001) {
        handleAppwatchWindowGone()
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_start',
        error: message,
        ...(daemonCode !== null ? { errorCode: daemonCode } : {})
      })
    }
    const streaming = result.streaming
    if (!streaming) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_start',
        error: 'Bridge daemon returned no streaming config.'
      })
    }
    setAttachedWindowStreaming({
      fps: streaming.fps ?? fps,
      bufferSeconds: streaming.bufferSeconds ?? bufferSeconds,
      frameCount: streaming.frameCount ?? 0,
      startedAt: streaming.startedAt ?? new Date().toISOString()
    })
    return mcpStructuredJsonResult({
      ok: true,
      tool: 'appwatch_start',
      handleID: result.handleID ?? snapshot.handleID,
      fps: streaming.fps ?? fps,
      bufferSeconds: streaming.bufferSeconds ?? bufferSeconds,
      frameCapacity: streaming.frameCapacity ?? fps * bufferSeconds,
      estimatedMemoryMB: streaming.estimatedMemoryMB ?? null,
      memoryBudgetMB: streaming.memoryBudgetMB ?? null,
      startedAt: streaming.startedAt ?? new Date().toISOString()
    })
  }

  async function executeAppwatchStop(): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_stop',
        error: 'No window is attached.'
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_stop',
        error: 'TaskWraith bridge daemon is not running.'
      })
    }
    try {
      await daemon.request<AppwatchStopDaemonResult>(
        'appwatch.stop',
        { handleID: snapshot.handleID },
        { timeoutMs: 5_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (bridgeDaemonErrorCode(err) === -32001) {
        handleAppwatchWindowGone()
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_stop',
        error: message
      })
    }
    setAttachedWindowStreaming(null)
    return mcpStructuredJsonResult({
      ok: true,
      tool: 'appwatch_stop',
      handleID: snapshot.handleID,
      streaming: false
    })
  }

  async function executeAppwatchStatus(): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: true,
        tool: 'appwatch_status',
        attached: false,
        streaming: false
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_status',
        error: 'TaskWraith bridge daemon is not running.'
      })
    }
    let result: AppwatchStatusDaemonResult
    try {
      result = await daemon.request<AppwatchStatusDaemonResult>(
        'appwatch.status',
        { handleID: snapshot.handleID },
        { timeoutMs: 5_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (bridgeDaemonErrorCode(err) === -32001) {
        handleAppwatchWindowGone()
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_status',
        error: message
      })
    }
    if (result.streaming && snapshot.streaming) {
      setAttachedWindowStreaming({
        ...snapshot.streaming,
        frameCount: result.frameCount ?? snapshot.streaming.frameCount
      })
    } else if (!result.streaming && snapshot.streaming) {
      setAttachedWindowStreaming(null)
    }
    return mcpStructuredJsonResult({
      ok: true,
      tool: 'appwatch_status',
      attached: true,
      handleID: snapshot.handleID,
      streaming: Boolean(result.streaming),
      fps: result.fps ?? 0,
      bufferSeconds: result.bufferSeconds ?? 0,
      frameCount: result.frameCount ?? 0,
      frameCapacity: result.frameCapacity ?? 0,
      oldestAt: result.oldestAt ?? null,
      newestAt: result.newestAt ?? null,
      lastPullAt: result.lastPullAt ?? null,
      startedAt: result.startedAt ?? null,
      estimatedMemoryMB: result.estimatedMemoryMB ?? null,
      memoryBudgetMB: result.memoryBudgetMB ?? null
    })
  }

  async function executeAppwatchLatestFrame(): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_latest_frame',
        error: 'No window is attached.'
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_latest_frame',
        error: 'TaskWraith bridge daemon is not running.'
      })
    }
    let result: AppwatchLatestFrameDaemonResult
    try {
      result = await daemon.request<AppwatchLatestFrameDaemonResult>(
        'appwatch.latestFrame',
        { handleID: snapshot.handleID },
        { timeoutMs: 10_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (bridgeDaemonErrorCode(err) === -32001) {
        handleAppwatchWindowGone()
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_latest_frame',
        error: message
      })
    }
    if (!result.hasFrame || !result.pngBase64) {
      return mcpStructuredJsonResult({
        ok: true,
        tool: 'appwatch_latest_frame',
        hasFrame: false,
        handleID: snapshot.handleID
      })
    }
    return mcpStructuredJsonResult(
      {
        ok: true,
        tool: 'appwatch_latest_frame',
        hasFrame: true,
        handleID: snapshot.handleID,
        mimeType: 'image/png',
        byteLength: result.byteLength ?? 0,
        width: result.width ?? 0,
        height: result.height ?? 0,
        capturedAt: result.capturedAt ?? new Date().toISOString(),
        windowMeta: snapshot.windowMeta
      },
      [{ type: 'image', mimeType: 'image/png', data: result.pngBase64 }]
    )
  }

  async function executeAppwatchFrames(
    args: Record<string, unknown>
  ): Promise<McpToolExecutionResult> {
    const snapshot = deps.attachedWindow.get()
    if (!snapshot) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_frames',
        error:
          'No window is attached. Ask the user to click "Attach app" so they can pick a window before pulling Appwatch frames.'
      })
    }
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_frames',
        error: 'TaskWraith bridge daemon is not running.'
      })
    }
    const includeOCR = args.include_ocr === true || args.includeOCR === true
    const count = clampInteger(args.count, 5, 1, includeOCR ? 5 : 20)
    const format = args.format === 'png' ? 'png' : 'jpeg'
    let result: AppwatchFramesDaemonResult
    try {
      result = await daemon.request<AppwatchFramesDaemonResult>(
        'appwatch.frames',
        {
          handleID: snapshot.handleID,
          since: optionalString(args.since),
          count,
          format,
          includeOCR
        },
        { timeoutMs: includeOCR ? 30_000 : 15_000 }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (bridgeDaemonErrorCode(err) === -32001) {
        handleAppwatchWindowGone()
      }
      return mcpStructuredJsonResult({
        ok: false,
        tool: 'appwatch_frames',
        error: message
      })
    }

    const frames = Array.isArray(result.frames) ? result.frames : []
    const contentBlocks: McpToolContentBlock[] = []
    const frameMetadata = frames.map((frame, index) => {
      const mimeType = frame.mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
      if (frame.imageBase64) {
        contentBlocks.push({ type: 'image', mimeType, data: frame.imageBase64 })
      }
      return {
        index: typeof frame.index === 'number' ? frame.index : index,
        capturedAt: frame.capturedAt ?? null,
        mimeType,
        byteLength: frame.byteLength ?? 0,
        width: frame.width ?? 0,
        height: frame.height ?? 0,
        ...(frame.ocr ? { ocr: frame.ocr } : {}),
        ...(frame.ocrError ? { ocrError: frame.ocrError } : {})
      }
    })

    return mcpStructuredJsonResult(
      {
        ok: true,
        tool: 'appwatch_frames',
        hasFrames: Boolean(result.hasFrames && frameMetadata.length),
        returned: frameMetadata.length,
        requested: result.requested ?? count,
        count: result.count ?? count,
        format: result.format ?? format,
        includeOCR,
        handleID: snapshot.handleID,
        nextSince: result.nextSince ?? null,
        availableCapturedAt: Array.isArray(result.availableCapturedAt)
          ? result.availableCapturedAt
          : [],
        frames: frameMetadata,
        windowMeta: snapshot.windowMeta
      },
      contentBlocks
    )
  }

  async function executeCreativeAppStatus(args: Record<string, unknown>): Promise<unknown> {
    const runningHint = await creativeAppRunningHint()
    return buildCreativeAppStatusSnapshot({
      appId: creativeAppIdFromArgs(args),
      attachedWindow: currentCreativeAttachedWindowMeta(),
      fileExists: fsSync.existsSync,
      runningHint
    })
  }

  async function executeCreativeAppCapabilities(args: Record<string, unknown>): Promise<unknown> {
    const runningHint = await creativeAppRunningHint()
    return buildCreativeAppCapabilitySnapshot({
      appId: creativeAppIdFromArgs(args),
      attachedWindow: currentCreativeAttachedWindowMeta(),
      fileExists: fsSync.existsSync,
      runningHint
    })
  }

  async function executeCreativeProjectSnapshot(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const rawPath = requireNonEmptyString(args.path || args.file_path || args.projectPath, 'path')
    const targetPath = resolveMcpScopedPath(context, rawPath)
    const stat = await fs.stat(targetPath)
    const extension = extname(targetPath)
    if (stat.isDirectory()) {
      return buildCreativeProjectSnapshot({
        path: formatScopedPath(context, targetPath),
        extension,
        isDirectory: true,
        sizeBytes: stat.size
      })
    }
    if (!stat.isFile()) {
      throw new Error('creative_project_snapshot requires a file or package directory path.')
    }
    const buffer = await readFilePrefixBytes(targetPath, stat.size)
    return buildCreativeProjectSnapshot({
      path: formatScopedPath(context, targetPath),
      extension,
      isDirectory: false,
      sizeBytes: stat.size,
      bytes: buffer,
      text: shouldDecodeCreativeProjectText(extension, buffer) ? buffer.toString('utf8') : undefined
    })
  }

  async function executeCreativeTimelineValidate(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const rawPath = requireNonEmptyString(args.path || args.file_path || args.timelinePath, 'path')
    const fcpxml = await readCreativeTimelineFcpxml(rawPath, context, 'creative_timeline_validate')
    return validateFcpxml({
      path: fcpxml.path,
      text: fcpxml.text,
      truncated: fcpxml.truncated
    })
  }

  async function executeCreativeTimelineIr(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const rawPath = requireNonEmptyString(args.path || args.file_path || args.timelinePath, 'path')
    const fcpxml = await readCreativeTimelineFcpxml(rawPath, context, 'creative_timeline_ir')
    return buildFcpxmlTimelineIr({
      path: fcpxml.path,
      text: fcpxml.text,
      truncated: fcpxml.truncated
    })
  }

  async function executeCreativeTimelineDiff(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const beforeRawPath = requireNonEmptyString(
      args.beforePath || args.before_path || args.basePath || args.base_path,
      'beforePath'
    )
    const afterRawPath = requireNonEmptyString(
      args.afterPath || args.after_path || args.draftPath || args.draft_path,
      'afterPath'
    )
    const before = await readCreativeTimelineFcpxml(
      beforeRawPath,
      context,
      'creative_timeline_diff'
    )
    const after = await readCreativeTimelineFcpxml(afterRawPath, context, 'creative_timeline_diff')
    return buildFcpxmlTimelineDiffPlan({
      beforePath: before.path,
      beforeText: before.text,
      beforeTruncated: before.truncated,
      afterPath: after.path,
      afterText: after.text,
      afterTruncated: after.truncated
    })
  }

  async function executeCreativeTimelineImport(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const gate = deps.getCreativeApprovalGate()
    const daemon = deps.getBridgeDaemon()
    if (!gate) {
      throw new Error('Creative-action approval gate is not yet wired up (main process not ready).')
    }
    if (!daemon) {
      throw new Error('Bridge daemon is not running; creative_timeline_import cannot dispatch.')
    }
    const irArg = args.ir
    if (!irArg || typeof irArg !== 'object') {
      throw new Error('creative_timeline_import expects { ir: object } (FCPXML timeline IR).')
    }
    const bundleId =
      typeof args.bundleId === 'string' && args.bundleId.length > 0
        ? args.bundleId
        : 'com.apple.FinalCut'
    if (!listCreativeAppBundleIds().includes(bundleId)) {
      throw new Error(
        `bundleId "${bundleId}" is not a recognised creative-app target. Allowed: ${listCreativeAppBundleIds().join(', ')}`
      )
    }
    const writer = serializeFcpxmlTimelineIr({ ir: irArg as FcpxmlTimelineIr })
    const outDir = resolveMcpScopedPath(context, '.taskwraith/creative-out')
    await fs.mkdir(outDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `taskwraith-${timestamp}.fcpxml`
    const filePath = `${outDir}/${filename}`
    await fs.writeFile(filePath, writer.text, 'utf8')

    const preflight = await runFcpxmlDtdPreflight({
      filePath,
      fcpxmlVersion:
        typeof (irArg as { version?: unknown }).version === 'string'
          ? (irArg as { version: string }).version
          : '1.13'
    })
    if (preflight.status === 'invalid') {
      return {
        ok: false,
        refused: true,
        reason: 'dtd-invalid',
        filePath,
        summary: writer.summary,
        warnings: writer.warnings,
        dtdPreflight: preflight,
        note: 'FCPXML DTD validation failed; Final Cut Pro would reject the import. The .fcpxml file was written for inspection but not dispatched.'
      }
    }

    const summaryLines = [
      `Resources: ${writer.summary.assetCount} assets - ${writer.summary.formatCount} formats - ${writer.summary.effectCount} effects`,
      `Projects: ${writer.summary.projectCount} - Timeline items: ${writer.summary.timelineItemCount} - Markers: ${writer.summary.markerCount}`,
      `DTD preflight: ${preflight.status}${preflight.dtdPath ? ` (${preflight.dtdPath.split('/').pop()})` : ''}`
    ]
    if (writer.warnings.length > 0) {
      summaryLines.push(
        '',
        'Writer warnings:',
        ...writer.warnings.map((warning) => `  - ${warning}`)
      )
    }
    const decision = await gate.requestApproval('fcp.import-fcpxml', {
      title: 'Import draft into Final Cut Pro',
      description:
        'TaskWraith wrote a fresh .fcpxml from your agent and will hand it to Final Cut Pro via NSWorkspace.open(). FCP will import the timeline as a new project under the chosen event.',
      filePath,
      targetBundleId: bundleId,
      payloadPreview: summaryLines.join('\n')
    })

    if (!decision.approved) {
      return {
        ok: false,
        refused: true,
        reason: decision.reason,
        filePath,
        summary: writer.summary,
        note: 'User did not approve the import. The .fcpxml file was written but not dispatched.'
      }
    }

    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'creative.openWithApp',
      { filePath, bundleId },
      { timeoutMs: 10_000 }
    )

    return {
      ok: true,
      dispatched: true,
      filePath,
      bundleId,
      summary: writer.summary,
      warnings: writer.warnings,
      daemonResult: dispatchResult,
      rememberedForSession: decision.rememberForSession
    }
  }

  async function executeCreativeAppleScriptDispatch(
    args: Record<string, unknown>
  ): Promise<unknown> {
    const gate = deps.getCreativeApprovalGate()
    const daemon = deps.getBridgeDaemon()
    if (!gate) {
      throw new Error('Creative-action approval gate is not yet wired up (main process not ready).')
    }
    if (!daemon) {
      throw new Error(
        'Bridge daemon is not running; creative_applescript_dispatch cannot dispatch.'
      )
    }
    let source: string
    let className: string
    let modalDetails: {
      title: string
      description: string
      targetBundleId?: string
      payloadPreview: string
    }
    if (typeof args.className === 'string' && args.className.length > 0) {
      const entry = findAppleScriptClass(args.className)
      if (!entry) {
        throw new Error(
          `Unknown AppleScript class "${args.className}". Allowed: ${APPLESCRIPT_CLASSES.map((c) => c.id).join(', ')}`
        )
      }
      const params: Record<string, string> =
        args.params && typeof args.params === 'object'
          ? (args.params as Record<string, string>)
          : {}
      for (const spec of entry.params) {
        const raw = params[spec.name]
        if (raw === undefined || raw === '') {
          throw new Error(`AppleScript class ${entry.id} requires param "${spec.name}"`)
        }
        const validationError = spec.validate?.(raw)
        if (validationError) {
          throw new Error(`Invalid ${spec.name} for ${entry.id}: ${validationError}`)
        }
      }
      source = entry.build(params)
      className = formatAppleScriptClassName(entry.id)
      modalDetails = {
        title: entry.label,
        description: entry.description,
        targetBundleId: entry.targetBundleId,
        payloadPreview: source
      }
    } else if (typeof args.source === 'string' && args.source.length > 0) {
      source = args.source
      className = formatAppleScriptClassName('raw')
      modalDetails = {
        title: 'Run raw AppleScript',
        description:
          'TaskWraith will execute the AppleScript source below in-process via OSAKit. Raw scripts are NEVER cached on approval - every invocation prompts.',
        targetBundleId: undefined,
        payloadPreview: source
      }
    } else {
      throw new Error(
        'creative_applescript_dispatch requires either { className, params? } or { source }'
      )
    }
    const decision = await gate.requestApproval(className, modalDetails)
    if (!decision.approved) {
      return {
        ok: false,
        refused: true,
        reason: decision.reason,
        className,
        note: 'User did not approve the AppleScript dispatch.'
      }
    }
    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'creative.runAppleScript',
      { source, timeoutMs: 10_000 },
      { timeoutMs: 12_000 }
    )
    return {
      ok: true,
      dispatched: true,
      className,
      rememberedForSession: decision.rememberForSession,
      daemonResult: dispatchResult
    }
  }

  async function executeCreativeBlenderPython(args: Record<string, unknown>): Promise<unknown> {
    const gate = deps.getCreativeApprovalGate()
    const daemon = deps.getBridgeDaemon()
    if (!gate) {
      throw new Error('Creative-action approval gate is not yet wired up (main process not ready).')
    }
    if (!daemon) {
      throw new Error('Bridge daemon is not running; creative_blender_python cannot dispatch.')
    }
    let pythonSource: string
    let inputBlendPath: string | undefined
    let className: string
    let modalDetails: {
      title: string
      description: string
      targetBundleId?: string
      payloadPreview: string
    }
    if (typeof args.className === 'string' && args.className.length > 0) {
      const entry = findBlenderClass(args.className)
      if (!entry) {
        throw new Error(
          `Unknown Blender class "${args.className}". Allowed: ${BLENDER_CLASSES.map((c) => c.id).join(', ')}`
        )
      }
      const params: Record<string, string> =
        args.params && typeof args.params === 'object'
          ? (args.params as Record<string, string>)
          : {}
      for (const spec of entry.params) {
        const raw = params[spec.name]
        if (raw === undefined || raw === '') {
          throw new Error(`Blender class ${entry.id} requires param "${spec.name}"`)
        }
        const validationError = spec.validate?.(raw)
        if (validationError) {
          throw new Error(`Invalid ${spec.name} for ${entry.id}: ${validationError}`)
        }
      }
      pythonSource = entry.build(params)
      inputBlendPath = entry.resolveInputBlendPath?.(params)
      className = formatBlenderClassName(entry.id)
      modalDetails = {
        title: entry.label,
        description: entry.description,
        targetBundleId: entry.targetBundleId,
        payloadPreview: inputBlendPath
          ? `# Blender input: ${inputBlendPath}\n${pythonSource}`
          : pythonSource
      }
    } else if (typeof args.pythonSource === 'string' && args.pythonSource.length > 0) {
      pythonSource = args.pythonSource
      inputBlendPath = typeof args.inputBlendPath === 'string' ? args.inputBlendPath : undefined
      className = formatBlenderClassName('run-script')
      modalDetails = {
        title: 'Run raw Blender Python',
        description:
          'TaskWraith will execute the Python source below inside `Blender --background --python` in a sandbox tempdir. Raw scripts are NEVER cached on approval - every invocation prompts.',
        targetBundleId: 'org.blenderfoundation.blender',
        payloadPreview: inputBlendPath
          ? `# Blender input: ${inputBlendPath}\n${pythonSource}`
          : pythonSource
      }
    } else {
      throw new Error(
        'creative_blender_python requires either { className, params? } or { pythonSource }'
      )
    }
    const decision = await gate.requestApproval(className, modalDetails)
    if (!decision.approved) {
      return {
        ok: false,
        refused: true,
        reason: decision.reason,
        className,
        note: 'User did not approve the Blender Python dispatch.'
      }
    }
    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'creative.runBlenderPython',
      {
        pythonSource,
        inputBlendPath,
        timeoutMs: 30_000
      },
      { timeoutMs: 35_000 }
    )
    return {
      ok: true,
      dispatched: true,
      className,
      rememberedForSession: decision.rememberForSession,
      daemonResult: dispatchResult
    }
  }

  async function executeCreativeMidiDispatch(args: Record<string, unknown>): Promise<unknown> {
    const gate = deps.getCreativeApprovalGate()
    const daemon = deps.getBridgeDaemon()
    if (!gate) {
      throw new Error('Creative-action approval gate is not yet wired up (main process not ready).')
    }
    if (!daemon) {
      throw new Error('Bridge daemon is not running; creative_midi_dispatch cannot dispatch.')
    }
    const eventType = typeof args.eventType === 'string' ? args.eventType : ''
    if (!eventType) {
      throw new Error('creative_midi_dispatch requires { eventType: string }')
    }
    const className = `midi:${eventType}`
    const preview = JSON.stringify(args, null, 2)
    const decision = await gate.requestApproval(className, {
      title: `Dispatch MIDI ${eventType}`,
      description:
        'TaskWraith will send a MIDI event through its virtual "TaskWraith" Core MIDI source. Logic Pro (or any MIDI listener) can route this source as an input. No destructive disk surface - but you should confirm the agent intends this dispatch.',
      targetBundleId: 'com.apple.logic10',
      payloadPreview: preview
    })
    if (!decision.approved) {
      return {
        ok: false,
        refused: true,
        reason: decision.reason,
        className
      }
    }
    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'creative.dispatchMIDI',
      args,
      { timeoutMs: 2_000 }
    )
    return {
      ok: true,
      dispatched: true,
      className,
      rememberedForSession: decision.rememberForSession,
      daemonResult: dispatchResult
    }
  }

  async function executeOpenInIde(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const daemon = deps.getBridgeDaemon()
    if (!daemon) {
      throw new Error('Bridge daemon is not running; open_in_ide cannot dispatch.')
    }
    const rawPath = requireNonEmptyString(args.path || args.file_path, 'path')
    const filePath = resolveMcpScopedPath(context, rawPath)
    let adapter = resolveEditorArg(args.ide || args.editor)
    if (!adapter) {
      const runningHint = await bundleIdRunningProbe()
      const candidates = listEditorAdapters()
      adapter =
        candidates.find((candidate) => candidate.bundleIds.some((id) => runningHint(id))) ||
        candidates.find((candidate) =>
          candidate.commonAppPaths.some((path) => fsSync.existsSync(path))
        ) ||
        findEditorById('vscode')
    }
    if (!adapter) {
      throw new Error(
        'open_in_ide: no editor could be resolved. Pass `ide` explicitly (e.g. "vscode", "cursor", "zed") or install one of the supported editors.'
      )
    }
    const bundleId = adapter.bundleIds[0]
    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'creative.openWithApp',
      { filePath, bundleId },
      { timeoutMs: 5_000 }
    )
    return {
      ok: true,
      ide: adapter.id,
      label: adapter.label,
      bundleId,
      filePath,
      daemonResult: dispatchResult
    }
  }

  async function executeOpenInIdeAtPosition(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const daemon = deps.getBridgeDaemon()
    if (!daemon) {
      throw new Error('Bridge daemon is not running; open_in_ide_at_position cannot dispatch.')
    }
    const rawPath = requireNonEmptyString(args.path || args.file_path, 'path')
    const filePath = resolveMcpScopedPath(context, rawPath)
    const lineRaw = args.line
    const line =
      typeof lineRaw === 'number' && Number.isFinite(lineRaw) && lineRaw > 0
        ? Math.floor(lineRaw)
        : null
    if (line === null) {
      throw new Error('open_in_ide_at_position: `line` must be a positive integer.')
    }
    const columnRaw = args.column
    const column =
      typeof columnRaw === 'number' && Number.isFinite(columnRaw) && columnRaw > 0
        ? Math.floor(columnRaw)
        : undefined
    let adapter = resolveEditorArg(args.ide || args.editor)
    if (!adapter) {
      const runningHint = await bundleIdRunningProbe()
      const candidates = listEditorAdapters()
      adapter =
        candidates.find((candidate) => candidate.bundleIds.some((id) => runningHint(id))) ||
        candidates.find((candidate) =>
          candidate.commonAppPaths.some((path) => fsSync.existsSync(path))
        ) ||
        findEditorById('vscode')
    }
    if (!adapter) {
      throw new Error(
        'open_in_ide_at_position: no editor could be resolved. Pass `ide` explicitly.'
      )
    }
    const positionalArgs = buildEditorPositionalArgs(adapter, filePath, line, column)
    if (positionalArgs && adapter.cliCommand) {
      try {
        const dispatchResult = await daemon.request<Record<string, unknown>>(
          'editor.openAtPosition',
          { cliCommand: adapter.cliCommand, args: positionalArgs, timeoutMs: 5_000 },
          { timeoutMs: 7_000 }
        )
        return {
          ok: true,
          ide: adapter.id,
          label: adapter.label,
          cliCommand: adapter.cliCommand,
          filePath,
          line,
          column: column || 1,
          positional: true,
          daemonResult: dispatchResult
        }
      } catch (err) {
        const cliMissing = /not found on PATH/.test((err as Error).message)
        if (!cliMissing) throw err
        const fallback = await daemon.request<Record<string, unknown>>(
          'creative.openWithApp',
          { filePath, bundleId: adapter.bundleIds[0] },
          { timeoutMs: 5_000 }
        )
        return {
          ok: true,
          ide: adapter.id,
          label: adapter.label,
          filePath,
          line,
          column: column || 1,
          positional: false,
          cliMissing: true,
          cliCommand: adapter.cliCommand,
          daemonResult: fallback,
          note: `The ${adapter.cliCommand} CLI is not on PATH; fell back to opening the file without positioning. Install the editor's shell command to enable line/column targeting.`
        }
      }
    }
    const fallback = await daemon.request<Record<string, unknown>>(
      'creative.openWithApp',
      { filePath, bundleId: adapter.bundleIds[0] },
      { timeoutMs: 5_000 }
    )
    return {
      ok: true,
      ide: adapter.id,
      label: adapter.label,
      filePath,
      line,
      column: column || 1,
      positional: false,
      daemonResult: fallback,
      note: `${adapter.label} has no positional-open CLI surface; opened without line targeting.`
    }
  }

  async function executeRevealInFinder(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ): Promise<unknown> {
    const daemon = deps.getBridgeDaemon()
    if (!daemon) {
      throw new Error('Bridge daemon is not running; reveal_in_finder cannot dispatch.')
    }
    const rawPath = requireNonEmptyString(args.path || args.file_path, 'path')
    const filePath = resolveMcpScopedPath(context, rawPath)
    const dispatchResult = await daemon.request<Record<string, unknown>>(
      'workspace.revealInFinder',
      { filePath },
      { timeoutMs: 3_000 }
    )
    return { ok: true, filePath, daemonResult: dispatchResult }
  }

  async function executeIdeAppStatus(): Promise<unknown> {
    const runningHint = await bundleIdRunningProbe()
    const adapters = listEditorAdapters()
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      ides: adapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        bundleIds: adapter.bundleIds,
        installedHint: adapter.commonAppPaths.some((path) => fsSync.existsSync(path)),
        runningHint: adapter.bundleIds.some((id) => runningHint(id)),
        cliCommand: adapter.cliCommand,
        positionalSyntax: adapter.positionalSyntax
      }))
    }
  }

  async function executeIdeAppCapabilities(): Promise<unknown> {
    const status = (await executeIdeAppStatus()) as Record<string, unknown>
    return {
      ...status,
      ides: ((status.ides as unknown[]) || []).map((entry) => {
        const typedEntry = entry as Record<string, unknown>
        const adapter = findEditorById(typedEntry.id as EditorId)
        const positionalSample = adapter
          ? buildEditorPositionalArgs(adapter, '/path/to/file.ts', 42, 5)
          : null
        return {
          ...typedEntry,
          notes: adapter?.notes,
          positionalArgsSample: positionalSample
        }
      })
    }
  }

  async function executeListRunningIdes(): Promise<unknown> {
    const status = (await executeIdeAppStatus()) as Record<string, unknown>
    return {
      ok: true,
      generatedAt: status.generatedAt,
      running: ((status.ides as unknown[]) || []).filter(
        (entry) => isRecord(entry) && entry.runningHint
      )
    }
  }

  function executeApprovalStatus(
    context: DesktopToolContext,
    args: Record<string, unknown>,
    parentProvider: ProviderId
  ) {
    const settings = deps.store.getSettings()
    const workspacePath = context.workspacePath || context.cwd
    const provider = args.provider ? assertProviderId(args.provider) : parentProvider
    const service = args.service ? assertAgenticServiceId(args.service) : undefined
    const statuses = mcpStringList(args.statuses || args.status)
    const scopes = mcpStringList(args.scopes || args.scope)
    const filter: ApprovalLedgerFilter = {
      provider,
      ...(service ? { service } : {}),
      ...(optionalString(args.approvalId) ? { approvalId: optionalString(args.approvalId) } : {}),
      ...(optionalString(args.runId) || (!args.all && context.appRunId)
        ? { runId: optionalString(args.runId) || context.appRunId }
        : {}),
      ...(optionalString(args.chatId) || (!args.all && context.appChatId)
        ? { chatId: optionalString(args.chatId) || context.appChatId }
        : {}),
      ...(optionalString(args.workspaceId)
        ? { workspaceId: optionalString(args.workspaceId) }
        : {}),
      ...(statuses.length ? { statuses: statuses as ApprovalLedgerFilter['statuses'] } : {}),
      ...(scopes.length ? { scopes: scopes as ApprovalLedgerFilter['scopes'] } : {}),
      includeExpired: args.includeExpired === true,
      limit: clampInteger(args.limit, 25, 1, 200)
    }
    const approvals = deps.store.getApprovalLedger(filter)
    const countsByStatus = approvals.reduce<Record<string, number>>((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1
      return acc
    }, {})
    const queryScope = {
      all: args.all === true,
      runIdInFilter: filter.runId || null,
      chatIdInFilter: filter.chatId || null,
      explicitRunIdProvided: Boolean(optionalString(args.runId)),
      explicitChatIdProvided: Boolean(optionalString(args.chatId)),
      effectiveScope:
        args.all === true && !optionalString(args.runId) && !optionalString(args.chatId)
          ? 'all'
          : optionalString(args.runId) || optionalString(args.chatId)
            ? 'explicit'
            : 'current-run'
    }
    return {
      provider,
      scope: context.scope,
      queryScope,
      workspacePath,
      services: settings.agenticServices,
      workspaceGrants: (settings.agenticWorkspaceGrants || []).filter(
        (grant) =>
          grant.provider === provider &&
          (!workspacePath || resolve(grant.workspacePath) === resolve(workspacePath))
      ),
      filter,
      count: approvals.length,
      countsByStatus,
      approvals: approvals.map((record) =>
        summarizeApprovalRecord(record, args.includePreview === true)
      )
    }
  }

  function requireProviderAuthDeps(): DesktopProviderAuthDeps {
    if (!deps.providerAuth) {
      throw new Error('Provider auth/status dependencies are not wired up.')
    }
    return deps.providerAuth
  }

  function summarizeGeminiAuthStatusForMcp(status: GeminiAuthStatus) {
    return {
      provider: 'gemini',
      available: status.available,
      authState: status.authState,
      apiKeyConfigured: status.apiKeyConfigured,
      encryptionAvailable: status.encryptionAvailable,
      version: status.version,
      binaryPath: status.binaryPath,
      activeProfileId: status.activeProfileId,
      activeProfileLabel: status.activeProfileLabel,
      supportsSessions: true,
      supportsApprovals: true,
      supportsQuota: false,
      supportsMcpStatus: false,
      appServer: 'sdk-or-cli',
      profiles: status.profiles.map(redactGeminiProfileForMcp),
      oauthLogin: status.oauthLogin
        ? {
            profileId: status.oauthLogin.profileId,
            status: status.oauthLogin.status,
            startedAt: status.oauthLogin.startedAt,
            finishedAt: status.oauthLogin.finishedAt,
            message: status.oauthLogin.message,
            exitCode: status.oauthLogin.exitCode
          }
        : undefined
    }
  }

  async function summarizeProviderAuthStatusForMcp(provider: ProviderId) {
    const auth = requireProviderAuthDeps()
    if (provider === 'gemini') {
      const snapshot = await auth.getGeminiAuthStatusSnapshot()
      const v2 = buildProviderAuthStatusV2({
        provider: 'gemini',
        available: snapshot.available,
        rawAuthState: snapshot.authState,
        apiKeyConfigured: snapshot.apiKeyConfigured
      })
      return { ...summarizeGeminiAuthStatusForMcp(snapshot), ...v2 }
    }
    const status = await auth.getCliProviderStatus(provider)
    const rawAuthState = typeof status.authState === 'string' ? status.authState : null
    const errorReason = typeof status.error === 'string' ? status.error : undefined
    if (provider === 'claude') {
      const apiKeyConfigured = Boolean(auth.getStoredClaudeApiKey())
      const v2 = buildProviderAuthStatusV2({
        provider: 'claude',
        available: status.available,
        rawAuthState,
        apiKeyConfigured,
        errorReason
      })
      return {
        ...status,
        apiKeyConfigured,
        encryptionAvailable: auth.encryptionAvailable(),
        ...v2
      }
    }
    if (provider === 'kimi') {
      const apiKeyConfigured = Boolean(auth.getStoredKimiApiKey())
      const v2 = buildProviderAuthStatusV2({
        provider: 'kimi',
        available: status.available,
        rawAuthState,
        apiKeyConfigured,
        errorReason
      })
      return {
        ...status,
        apiKeyConfigured,
        encryptionAvailable: auth.encryptionAvailable(),
        ...v2
      }
    }
    if (provider !== 'codex') {
      const v2 = buildProviderAuthStatusV2({
        provider,
        available: status.available,
        rawAuthState,
        errorReason
      })
      return {
        ...status,
        apiKeyConfigured: false,
        encryptionAvailable: auth.encryptionAvailable(),
        ...v2
      }
    }
    const codexUsageConfigured = Boolean(deps.store.getSettings().codexUsageCredential?.accountId)
    const v2 = buildProviderAuthStatusV2({
      provider: 'codex',
      available: status.available,
      rawAuthState,
      codexClientStarted: auth.isCodexClientStarted(),
      errorReason
    })
    return {
      ...status,
      apiKeyConfigured: false,
      encryptionAvailable: auth.encryptionAvailable(),
      appServer: auth.isCodexClientStarted() ? 'started' : 'lazy',
      accountStatus: 'not-queried',
      codexUsageConfigured,
      ...v2
    }
  }

  async function executeProviderAuthStatus(args: Record<string, unknown>) {
    const providers = args.provider ? [assertProviderId(args.provider)] : availableProviderIds()
    const entries: Record<string, unknown> = {}
    for (const provider of providers) {
      entries[provider] = await summarizeProviderAuthStatusForMcp(provider)
    }
    return {
      checkedAt: new Date().toISOString(),
      providers: entries
    }
  }

  function executeProviderUsageStatus(args: Record<string, unknown>) {
    const providers = args.provider ? [assertProviderId(args.provider)] : availableProviderIds()
    const entries: Record<string, ProviderUsageSummary> = {}
    for (const provider of providers) {
      const cached = deps.store.getProviderUsageSnapshot(
        provider
      ) as NormalizedProviderUsageSnapshot | null
      entries[provider] = summarizeProviderUsage(provider, cached)
    }
    return {
      checkedAt: new Date().toISOString(),
      providers: entries
    }
  }

  /**
   * A run id is not an authority token. Agents may inspect their current run
   * while it is still being persisted, or an earlier run recorded on their
   * current chat, but never use this surface to sweep other chats' ledgers.
   */
  function assertRunIsInActiveContext(
    runId: string,
    context: DesktopToolContext,
    toolName: 'run_timeline' | 'raw_provider_events'
  ): void {
    if (runId === context.appRunId) return

    const chatId = context.appChatId
    const chat = chatId ? deps.store.getChat(chatId) : null
    if (chat?.runs.some((run) => run.runId === runId)) return

    throw new Error(`${toolName} can only inspect the active run or a run from the active chat.`)
  }

  function assertChatIsActiveContext(
    chatId: string,
    context: DesktopToolContext,
    toolName: 'raw_provider_events'
  ): void {
    if (chatId === context.appChatId) return
    throw new Error(`${toolName} can only inspect the active chat.`)
  }

  function executeRunTimeline(args: Record<string, unknown>, context: DesktopToolContext) {
    const runId = optionalString(args.runId) || context.appRunId
    if (!runId) throw new Error('run_timeline requires runId or an active run context.')
    assertRunIsInActiveContext(runId, context, 'run_timeline')
    const replay = deps.runRepository.getRunEventReplay(runId)
    const limit = clampInteger(args.limit, 100, 1, 1000)
    return {
      runId,
      count: replay.count,
      lastSequence: replay.lastSequence,
      hashHead: replay.hashHead,
      approvalIds: replay.approvalIds,
      startedAt: replay.startedAt,
      endedAt: replay.endedAt,
      hashChainValid: replay.hashChainValid,
      countsByKind: replay.countsByKind,
      timeline: replay.timeline.slice(-limit),
      events:
        args.includeEvents === true
          ? replay.events.slice(-limit).map((event) => ({
              sequence: event.sequence,
              timestamp: event.timestamp,
              provider: event.provider,
              providerSessionId: event.providerSessionId,
              providerRunId: event.providerRunId,
              kind: event.kind,
              phase: event.phase,
              source: event.source,
              summary: event.summary,
              spanId: event.spanId,
              parentSpanId: event.parentSpanId,
              toolCallId: event.toolCallId,
              approvalId: event.approvalId,
              commitSha: event.commitSha,
              externalUrl: event.externalUrl,
              artifacts: redactRunEventArtifactPaths(event.artifacts),
              payload: args.includePayload === true ? event.payload : undefined
            }))
          : undefined
    }
  }

  function executeRawProviderEvents(args: Record<string, unknown>, context: DesktopToolContext) {
    const runId = optionalString(args.runId) || context.appRunId
    const chatId = optionalString(args.chatId) || (!runId ? context.appChatId : undefined)
    if (!runId && !chatId) {
      throw new Error('raw_provider_events requires runId, chatId, or an active run context.')
    }
    if (runId) assertRunIsInActiveContext(runId, context, 'raw_provider_events')
    if (chatId) assertChatIsActiveContext(chatId, context, 'raw_provider_events')
    const limit = clampInteger(args.limit, 100, 1, 1000)
    const filter = {
      ...(runId ? { runId } : {}),
      ...(chatId ? { chatId } : {}),
      provider: args.provider ? assertProviderId(args.provider) : undefined,
      kinds: ['provider_raw', 'provider_error', 'provider_exit'] as RunEventFilter['kinds']
    }
    const events = deps.runRepository.getRunEvents(filter).slice(-limit)
    return {
      filter,
      count: events.length,
      events: events.map((event) => ({
        sequence: event.sequence,
        timestamp: event.timestamp,
        runId: event.runId,
        chatId: event.chatId,
        workspaceId: event.workspaceId,
        provider: event.provider,
        providerSessionId: event.providerSessionId,
        providerRunId: event.providerRunId,
        kind: event.kind,
        phase: event.phase,
        source: event.source,
        summary: event.summary,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        toolCallId: event.toolCallId,
        payload: event.payload,
        artifacts:
          args.includeArtifacts === false ? undefined : redactRunEventArtifactPaths(event.artifacts),
        hash: event.hash
      }))
    }
  }

  async function executeOpenWorkspaceFile(
    args: Record<string, unknown>,
    context: DesktopToolContext
  ) {
    const targetPath = resolveMcpScopedPath(context, String(args.path || args.file || ''))
    if (args.reveal === true) {
      deps.shell.showItemInFolder(targetPath)
      return { ok: true, path: targetPath, action: 'reveal' }
    }
    const error = await deps.shell.openPath(targetPath)
    return { ok: !error, path: targetPath, action: 'open', error: error || undefined }
  }

  function executeCreateHandoffCard(
    args: Record<string, unknown>,
    context: DesktopToolContext,
    parentProvider: ProviderId
  ) {
    const chatId = context.appChatId || optionalString(args.sourceChatId)
    if (!chatId) throw new Error('create_handoff_card requires an active chat context.')
    const chat = deps.store.getChat(chatId)
    const card = deps.store.saveHandoffCard(
      sanitizeHandoffCardForSave({
        sourceChatId: chatId,
        sourceRunId: optionalString(args.sourceRunId) || context.appRunId,
        sourceProvider: parentProvider,
        workspaceId: chat?.workspaceId,
        workspacePath: chat?.workspacePath || context.workspacePath,
        summary: optionalString(args.summary) || 'Agent-created handoff',
        selectedFiles: toStringArray(args.selectedFiles || args.files),
        workspaceChangeSetIds: toStringArray(args.workspaceChangeSetIds),
        rawEventRunIds: toStringArray(
          args.rawEventRunIds || (context.appRunId ? [context.appRunId] : [])
        ),
        recommendedProvider: args.recommendedProvider
          ? assertProviderId(args.recommendedProvider)
          : undefined,
        recommendedModel: optionalString(args.recommendedModel),
        recommendedApprovalMode: optionalString(args.recommendedApprovalMode),
        finalPrompt:
          optionalString(args.finalPrompt || args.prompt) ||
          optionalString(args.summary) ||
          'Continue this handoff.'
      })
    )
    deps.notifyRenderer?.('handoff-cards-changed', deps.store.getHandoffCards())
    return card
  }

  function executeAgentDelegationRole(
    args: Record<string, unknown>,
    context: DesktopToolContext,
    parentProvider: ProviderId
  ) {
    const chatId = context.appChatId
    if (!chatId) throw new Error('agent_delegation_role requires an active chat context.')
    const chat = deps.store.getChat(chatId)
    if (!chat) throw new Error('Active chat was not found.')
    const provider = assertProviderId(args.provider || parentProvider)
    const role = requireNonEmptyString(args.role || args.name, 'Delegation role')
    const instructions = optionalString(args.instructions || args.prompt || args.description)
    const providerMetadata = {
      ...(chat.providerMetadata || {}),
      agentDelegationRoles: {
        ...(chat.providerMetadata?.agentDelegationRoles &&
        typeof chat.providerMetadata.agentDelegationRoles === 'object'
          ? (chat.providerMetadata.agentDelegationRoles as Record<string, unknown>)
          : {}),
        [provider]: {
          role,
          instructions,
          updatedAt: new Date().toISOString()
        }
      }
    }
    const updated = { ...chat, providerMetadata, updatedAt: Date.now() }
    deps.store.saveChat(updated)
    deps.notifyRenderer?.('chat-updated', updated)
    return providerMetadata.agentDelegationRoles
  }

  async function executeDesktopTool(
    toolName: DesktopMcpToolName,
    args: Record<string, unknown>,
    context: DesktopToolContext,
    parentProvider: ProviderId
  ): Promise<McpToolExecutionResult> {
    const unsupportedNativeTool = unsupportedNativeToolResult(toolName)
    if (unsupportedNativeTool) return { ...unsupportedNativeTool, isError: true }
    if (toolName === 'attached_window_capture') return executeAttachedWindowCapture(args)
    if (toolName === 'attached_window_status') return executeAttachedWindowStatus()
    if (toolName === 'appwatch_start') return executeAppwatchStart(args)
    if (toolName === 'appwatch_stop') return executeAppwatchStop()
    if (toolName === 'appwatch_status') return executeAppwatchStatus()
    if (toolName === 'appwatch_latest_frame') return executeAppwatchLatestFrame()
    if (toolName === 'appwatch_frames') return executeAppwatchFrames(args)
    if (toolName === 'approval_status') {
      return desktopToolJsonResult(executeApprovalStatus(context, args, parentProvider))
    }
    if (toolName === 'provider_auth_status') {
      return desktopToolJsonResult(await executeProviderAuthStatus(args))
    }
    if (toolName === 'provider_usage_status') {
      return desktopToolJsonResult(executeProviderUsageStatus(args))
    }
    if (toolName === 'run_timeline') {
      return desktopToolJsonResult(executeRunTimeline(args, context))
    }
    if (toolName === 'raw_provider_events') {
      return desktopToolJsonResult(executeRawProviderEvents(args, context))
    }
    if (toolName === 'open_workspace_file') {
      return desktopToolJsonResult(await executeOpenWorkspaceFile(args, context))
    }
    if (toolName === 'creative_app_status') {
      return desktopToolJsonResult(await executeCreativeAppStatus(args))
    }
    if (toolName === 'creative_app_capabilities') {
      return desktopToolJsonResult(await executeCreativeAppCapabilities(args))
    }
    if (toolName === 'creative_project_snapshot') {
      return desktopToolJsonResult(await executeCreativeProjectSnapshot(args, context))
    }
    if (toolName === 'creative_timeline_validate') {
      return desktopToolJsonResult(await executeCreativeTimelineValidate(args, context))
    }
    if (toolName === 'creative_timeline_ir') {
      return desktopToolJsonResult(await executeCreativeTimelineIr(args, context))
    }
    if (toolName === 'creative_timeline_diff') {
      return desktopToolJsonResult(await executeCreativeTimelineDiff(args, context))
    }
    if (toolName === 'creative_timeline_import') {
      return desktopToolJsonResult(await executeCreativeTimelineImport(args, context))
    }
    if (toolName === 'creative_applescript_dispatch') {
      return desktopToolJsonResult(await executeCreativeAppleScriptDispatch(args))
    }
    if (toolName === 'creative_blender_python') {
      return desktopToolJsonResult(await executeCreativeBlenderPython(args))
    }
    if (toolName === 'creative_midi_dispatch') {
      return desktopToolJsonResult(await executeCreativeMidiDispatch(args))
    }
    if (toolName === 'open_in_ide') {
      return desktopToolJsonResult(await executeOpenInIde(args, context))
    }
    if (toolName === 'open_in_ide_at_position') {
      return desktopToolJsonResult(await executeOpenInIdeAtPosition(args, context))
    }
    if (toolName === 'reveal_in_finder') {
      return desktopToolJsonResult(await executeRevealInFinder(args, context))
    }
    if (toolName === 'ide_app_status') {
      return desktopToolJsonResult(await executeIdeAppStatus())
    }
    if (toolName === 'ide_app_capabilities') {
      return desktopToolJsonResult(await executeIdeAppCapabilities())
    }
    if (toolName === 'list_running_ides') {
      return desktopToolJsonResult(await executeListRunningIdes())
    }
    if (toolName === 'create_handoff_card') {
      return desktopToolJsonResult(executeCreateHandoffCard(args, context, parentProvider))
    }
    return desktopToolJsonResult(executeAgentDelegationRole(args, context, parentProvider))
  }

  return {
    executeAttachedWindowCapture,
    executeAttachedWindowStatus,
    executeAppwatchStart,
    executeAppwatchStop,
    executeAppwatchStatus,
    executeAppwatchLatestFrame,
    executeAppwatchFrames,
    executeCreativeAppStatus,
    executeCreativeAppCapabilities,
    executeCreativeProjectSnapshot,
    executeCreativeTimelineValidate,
    executeCreativeTimelineIr,
    executeCreativeTimelineDiff,
    executeCreativeTimelineImport,
    executeCreativeAppleScriptDispatch,
    executeCreativeBlenderPython,
    executeCreativeMidiDispatch,
    executeOpenInIde,
    executeOpenInIdeAtPosition,
    executeRevealInFinder,
    executeIdeAppStatus,
    executeIdeAppCapabilities,
    executeListRunningIdes,
    executeApprovalStatus,
    executeProviderAuthStatus,
    executeProviderUsageStatus,
    executeRunTimeline,
    executeRawProviderEvents,
    executeOpenWorkspaceFile,
    executeCreateHandoffCard,
    executeAgentDelegationRole,
    executeDesktopTool
  }
}
