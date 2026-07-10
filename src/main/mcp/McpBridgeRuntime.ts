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
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../TaskWraithMcpTools'
import {
  PLAN_INSTRUMENT_ADVERTISE_TOOLS,
  isPlanAdvertisedTool,
  isReadOnlyAdvertisedTool
} from './McpAutoAllowedTools'
import { isCoreMcpAdvertisedTool } from './McpToolProfiles'
import type { McpCallerContext } from './McpRouteGuards'
// Audit MCP tool definitions — advertised ONLY to audit role-runs (the bridge
// child carries TASKWRAITH_MCP_AUDIT=1, set per-run at the provider spawn site).
// AuditToolExecutors imports McpToolDefinition from here as `import type` (erased
// at runtime), so this value import introduces no runtime require cycle.
import { AUDIT_MCP_TOOL_NAMES, auditToolDefinitions } from './AuditToolExecutors'
import {
  KIMI_LEGACY_TASKWRAITH_SERVER_NAMES,
  KIMI_TASKWRAITH_SERVER_NAME,
  buildKimiMcpBridgeAddArgs,
  buildKimiMcpBridgeRemoveArgs,
  redactKimiMcpBridgeAddArgs
} from '../KimiMcpBridge'
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
// Audit scope flag. Carried in the bridge ARGV (atomic with the spawn, like
// safe-subset) AND/OR inherited via env: a bridge launched for an audit role-run
// also advertises the audit_* tool namespace. The bootstrap translates this arg
// to TASKWRAITH_MCP_AUDIT=1 (the env tools/list reads); for stdio providers the
// CLI sets the env directly and the bridge child inherits it. Unlike safe-subset
// this does NOT restrict tools/call — audit tools route through the registered
// audit context, and non-audit runs never set the flag.
export const GEMINI_MCP_AUDIT_SUBSET_ARG = '--audit-subset'
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
    toolName: TaskWraithMcpToolName,
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
  ) => McpBridgeAgentRunRoute
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
  // Cursor and Grok reach the broker via provider-native MCP registrations.
  'cursor',
  'grok'
])
const BRIDGE_LOG_MAX_BYTES = 1_048_576
const DEFAULT_MAX_CAPTURE_OUTPUT_CHARS = 200_000

let bridgeLogPath: string | null = null
let bridgeLogResolved = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBridgeAuditMcpToolName(value: string): boolean {
  return (AUDIT_MCP_TOOL_NAMES as readonly string[]).includes(value)
}

function isCoreMcpAdvertisedForSeat(name: string, planSubset: boolean): boolean {
  return (
    isCoreMcpAdvertisedTool(name) ||
    (planSubset && (PLAN_INSTRUMENT_ADVERTISE_TOOLS as readonly string[]).includes(name))
  )
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
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timeout)
      finish({ ok: false, error: error.message })
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

export function resolveBridgeLogPath(): string | null {
  if (bridgeLogResolved) return bridgeLogPath
  bridgeLogResolved = true
  try {
    const logsDir = join(os.homedir(), 'Library', 'Logs', 'TaskWraith')
    fsSync.mkdirSync(logsDir, { recursive: true })
    bridgeLogPath = join(logsDir, 'bridge-subprocess.log')
    try {
      const stat = fsSync.statSync(bridgeLogPath)
      if (stat.size > BRIDGE_LOG_MAX_BYTES) {
        fsSync.writeFileSync(bridgeLogPath, '')
      }
    } catch {
      // File does not exist yet; first append will create it.
    }
  } catch {
    bridgeLogPath = null
  }
  return bridgeLogPath
}

export function bridgeLog(message: string, pid: number = process.pid): void {
  const path = resolveBridgeLogPath()
  if (!path) return
  try {
    const line = `[${new Date().toISOString()}] pid=${pid} ${message}\n`
    fsSync.appendFileSync(path, line)
  } catch {
    // Logging failures must never crash the bridge.
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
    // Audit role-run bridge (TASKWRAITH_MCP_AUDIT=1): additionally advertise the
    // audit_* tool namespace so the role-run can record findings/verdicts/profile.
    // The flag is set per-run at the provider spawn site and never on a normal
    // run, so non-audit runs never see these tools. tools/call is NOT gated here
    // (audit tools route via the registered audit context in the broker).
    const auditSubset = (deps.env?.TASKWRAITH_MCP_AUDIT ?? process.env.TASKWRAITH_MCP_AUDIT) === '1'
    const allTools = deps.getMcpToolDefinitions()
    const baseTools =
      safeSubsetOnly || coreSubsetOnly
        ? allTools.filter(
            (tool) =>
              (!safeSubsetOnly || isAdvertisedForSeat(tool.name)) &&
              (!coreSubsetOnly || isCoreMcpAdvertisedForSeat(tool.name, planSubset))
          )
        : allTools
    const tools = auditSubset ? [...baseTools, ...auditToolDefinitions()] : baseTools
    writeMcpResponse(id, { tools }, transport, stdout)
    return
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {}
    const rawName = params.name
    const name = canonicalTaskWraithToolName(String(rawName || ''))
    const args = params.arguments || {}
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
    if (safeSubsetOnly && !isAdvertisedForSeat(String(name)) && !auditToolRequested) {
      bridgeLog(
        `tools/call REJECTED (${planSubset ? 'plan' : 'read-only'} scope) ` +
          `name=${String(rawName)} canonical=${String(name)} id=${String(id)}`
      )
      writeMcpError(
        id,
        -32601,
        `Tool '${String(rawName || name)}' is not available to a read-only TaskWraith seat.`,
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
      !isCoreMcpAdvertisedForSeat(String(name), planSubset) &&
      !auditToolRequested
    ) {
      bridgeLog(
        `tools/call REJECTED (core scope) name=${String(rawName)} ` +
          `canonical=${String(name)} id=${String(id)}`
      )
      writeMcpError(
        id,
        -32601,
        `Tool '${String(rawName || name)}' is not available in the TaskWraith core MCP profile.`,
        transport,
        stdout
      )
      return
    }
    bridgeLog(
      `tools/call name=${String(rawName)} canonical=${String(name)} id=${String(id)} ` +
        `args=${JSON.stringify(args).slice(0, 200)}`
    )
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
        bridgeLog(
          `tools/call name=${String(rawName)} canonical=${String(name)} id=${String(id)} ` +
            `result.ok=${String(resultRecord.ok)} text.len=${String((String(resultRecord.text || resultRecord.error || '')).length)}`
        )
        try {
          writeMcpResponse(id, responseFromResult(result), transport, stdout)
        } catch (writeError) {
          bridgeLog(
            `tools/call write FAILED id=${String(id)} err=${writeError instanceof Error ? writeError.message : String(writeError)}`
          )
        }
      })
      .catch((rejection) => {
        const reasonText = rejection instanceof Error ? rejection.message : String(rejection)
        bridgeLog(`tools/call REJECTION id=${String(id)} reason=${reasonText}`)
        try {
          writeMcpResponse(
            id,
            {
              content: [{ type: 'text', text: `TaskWraith bridge internal error: ${reasonText}` }],
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
  bridgeLog(
    `spawn argv=${JSON.stringify(argv.slice(1))} cwd=${deps.cwd?.() || process.cwd()} env.TASKWRAITH_RUN_ID=${env.TASKWRAITH_RUN_ID || ''} env.TASKWRAITH_PARENT_PROVIDER=${env.TASKWRAITH_PARENT_PROVIDER || ''} env.TASKWRAITH_WORKSPACE_PATH=${env.TASKWRAITH_WORKSPACE_PATH || ''}`,
    deps.pid?.() || process.pid
  )

  process.on('uncaughtException', (error) => {
    bridgeLog(
      `uncaughtException: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`,
      deps.pid?.() || process.pid
    )
  })
  process.on('unhandledRejection', (reason) => {
    bridgeLog(
      `unhandledRejection: ${reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)}`,
      deps.pid?.() || process.pid
    )
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
        } catch (error) {
          bridgeLog(
            `parse FAILED (framed) err=${error instanceof Error ? error.message : String(error)}`,
            deps.pid?.() || process.pid
          )
          writeMcpError(
            null,
            -32700,
            error instanceof Error ? error.message : String(error),
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
      } catch (error) {
        bridgeLog(
          `parse FAILED (line) err=${error instanceof Error ? error.message : String(error)}`,
          deps.pid?.() || process.pid
        )
        writeMcpError(
          null,
          -32700,
          error instanceof Error ? error.message : String(error),
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
    bridgeLog(`stdin error: ${error instanceof Error ? error.message : String(error)}`)
  })
  stdout.on('error', (error) => {
    bridgeLog(`stdout error: ${error instanceof Error ? error.message : String(error)}`)
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
  private kimiMcpBridgeRepairPromise: Promise<void> | null = null

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
    coreSubset = false
  ): string[] {
    return [
      ...(this.deps.isDev() ? [this.deps.getAppPath()] : []),
      GEMINI_MCP_BRIDGE_ARG,
      GEMINI_MCP_SOCKET_ARG,
      socketPath,
      GEMINI_MCP_TOKEN_ARG,
      this.deps.getGeminiMcpBrokerToken(),
      // Read-only seat (Grok): append the scope flag LAST so socket/token
      // index-based parsing is unaffected. Default false keeps the Gemini/Kimi
      // launch args byte-identical (bridgeArgsMatchCurrentLaunch still matches).
      ...(safeSubset ? [GEMINI_MCP_SAFE_SUBSET_ARG] : []),
      // Plan-tier seat: widen the safe-subset to the plan instruments. Appended
      // after --safe-subset, still index-safe; default false keeps the persistent
      // Gemini/Kimi launch args byte-identical (bridgeArgsMatchCurrentLaunch).
      ...(planSubset ? [GEMINI_MCP_PLAN_SUBSET_ARG] : []),
      // Tool-count constrained model seat: advertise the explicit coding/core
      // profile while retaining normal write approvals. Appended last so the
      // socket/token index parsing remains unchanged.
      ...(coreSubset ? [GEMINI_MCP_CORE_SUBSET_ARG] : [])
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
    if (!isTaskWraithMcpToolName(toolName) && !isBridgeAuditMcpToolName(toolName)) {
      return { ok: false, error: `Unknown TaskWraith MCP tool: ${String(rawToolName || 'unknown')}` }
    }
    const parentProvider = normalizeBrokerParentProvider(brokerRequestRecord.parentProvider)
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
      toolName as TaskWraithMcpToolName,
      brokerRequestRecord.arguments ?? brokerRequestRecord.args ?? brokerRequestRecord.input,
      normalizeRunRoute(brokerRequestRecord),
      parentProvider,
      callerContext
    )
    return { ok: !result.isError, ...result }
  }

  async startGeminiMcpBroker(): Promise<void> {
    if (this.geminiMcpBroker) return
    if (this.geminiMcpBrokerStartPromise) return this.geminiMcpBrokerStartPromise

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
            } catch (error) {
              safeMcpStreamWrite(
                socket,
                `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
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
              .catch((error) =>
                safeMcpStreamWrite(
                  socket,
                  `${JSON.stringify({ id: parsedRecord.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
                )
              )
          }
        })
      })

      this.geminiMcpBroker = server
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
    if (settings.geminiMcpBridgeEnabled || requireWriteTools) {
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
        this.deps.updateSettings({ geminiMcpBridgeEnabled: true })
      }
      await this.startGeminiMcpBroker()
      if (!this.geminiMcpBridgeInstalledForCurrentToken) {
        await this.repairGeminiMcpBridge(resolvedCwd)
      }
      const status = await this.getGeminiMcpBridgeStatus({
        autoRepairIfEnabled: true,
        cwd: resolvedCwd,
        allowSessionTrustBypass: sessionTrust
      })
      if (!status.available) {
        throw new Error(
          `TaskWraith MCP bridge repair failed: ${status.message || status.error || 'unknown status'}. Gemini write-capable mode was not launched because it would start without file-edit tools.`
        )
      }
      if (requireWriteTools) {
        const toolSelfTest = await this.selfTestGeminiMcpBridgeProcess(
          this.deps.getGeminiMcpSocketPath()
        )
        if (!toolSelfTest.ok) {
          throw new Error(
            `TaskWraith MCP bridge repair failed: ${toolSelfTest.error || 'write tools were not advertised by the bridge'}. Gemini write-capable mode was not launched because it would start without file-edit tools.`
          )
        }
      }
    }

    return this.deps.installGeminiToolContextForRun(
      sender,
      resolvedCwd,
      routed,
      scope,
      sessionTrust,
      options
    )
  }

  async addKimiMcpBridgeRegistration(kimiBinaryPath: string, socketPath: string): Promise<void> {
    const addArgs = buildKimiMcpBridgeAddArgs({
      bridgeBinaryPath: this.processExecPath(),
      bridgeArgs: this.taskwraithMcpBridgeArgs(socketPath)
    })
    const addResult = await this.deps.captureProcessOutput(kimiBinaryPath, addArgs, undefined, 15_000)
    if (addResult.code !== 0) {
      const output = (
        addResult.stderr ||
        addResult.stdout ||
        addResult.error ||
        'kimi mcp add failed.'
      ).trim()
      const safeArgs = redactKimiMcpBridgeAddArgs(addArgs)
      throw new Error(
        `Kimi MCP bridge registration failed (exit ${addResult.code ?? 'unknown'}): kimi ${safeArgs.join(' ')}\n${output}`
      )
    }
  }

  async removeKimiMcpBridgeRegistration(
    kimiBinaryPath: string,
    serverName: string
  ): Promise<boolean> {
    const removeResult = await this.deps.captureProcessOutput(
      kimiBinaryPath,
      buildKimiMcpBridgeRemoveArgs(serverName),
      undefined,
      8_000
    )
    return removeResult.code === 0
  }

  async pruneLegacyKimiMcpBridgeRegistrations(kimiBinaryPath: string): Promise<string[]> {
    const removed: string[] = []
    for (const serverName of KIMI_LEGACY_TASKWRAITH_SERVER_NAMES) {
      try {
        if (await this.removeKimiMcpBridgeRegistration(kimiBinaryPath, serverName)) {
          removed.push(serverName)
        }
      } catch {
        // Best effort: stale legacy registrations should not block current TaskWraith setup.
      }
    }
    return removed
  }

  async installKimiMcpBridge(): Promise<void> {
    await this.startGeminiMcpBroker()
    const resolved = await this.deps.resolveCliProviderBinary('kimi')
    if (!resolved.binaryPath) {
      return
    }
    await this.pruneLegacyKimiMcpBridgeRegistrations(resolved.binaryPath)
    const bridgeCommandStatus = this.taskwraithMcpBridgeCommandStatus()
    if (!bridgeCommandStatus.available) {
      await this.removeKimiMcpBridgeRegistration(resolved.binaryPath, KIMI_TASKWRAITH_SERVER_NAME)
      this.kimiMcpBridgeInstalledForCurrentToken = false
      throw new Error(this.taskwraithMcpBridgeCommandUnavailableMessage(bridgeCommandStatus))
    }
    const socketPath = this.deps.getGeminiMcpSocketPath()
    await this.addKimiMcpBridgeRegistration(resolved.binaryPath, socketPath)
    this.kimiMcpBridgeInstalledForCurrentToken = true
  }

  async repairKimiMcpBridge(): Promise<void> {
    if (!this.kimiMcpBridgeRepairPromise) {
      this.kimiMcpBridgeRepairPromise = this.installKimiMcpBridge().finally(() => {
        this.kimiMcpBridgeRepairPromise = null
      })
    }
    await this.kimiMcpBridgeRepairPromise
  }

  async prepareKimiMcpBridgeForRun(sender: WebContents): Promise<void> {
    const settings = this.deps.getSettings()
    if (!settings.geminiMcpBridgeEnabled) {
      return
    }
    try {
      await this.startGeminiMcpBroker()
      if (!this.kimiMcpBridgeInstalledForCurrentToken) {
        await this.repairKimiMcpBridge()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.sendAgentCompatLine(sender, 'kimi', {
        type: 'provider_warning',
        provider: 'kimi',
        severity: 'warning',
        title: 'Kimi MCP bridge registration failed',
        message: `TaskWraith could not register the TaskWraith MCP server with Kimi: ${message}. Cross-provider delegation tools will not be available for this run.`
      })
    }
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
