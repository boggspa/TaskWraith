/**
 * Node-owned Claude provider adapter.
 *
 * Authored directly against the Claude CLI's `--output-format stream-json`
 * contract. ACCEPTED DUPLICATION: the App's Claude seam is the SDK invocation
 * embedded in src/main/index.ts (~20435, ~21105), which closes over Electron
 * main singletons and cannot be imported here (hostNodeBoundary.test.ts forbids
 * src/main outside the pinned Muse closure). Desktop reuse is a named follow-up.
 *
 * Two deliberate safety properties:
 *
 *   1. Posture mapping is FAIL-CLOSED. An unrecognised approval mode runs
 *      `plan`, never a writing mode.
 *   2. No approvals/questions are advertised. `HostNodeInteractionResolver`
 *      exposes `register` only and offers no awaitable settlement, so a real
 *      one-shot continuation cannot be wired from an adapter today.
 *
 * Control-character handling is done with numeric code-point checks rather than
 * regex escapes so this source file stays free of literal control bytes.
 */

import { spawn as nodeSpawn } from 'node:child_process'

import { hostProviderAuthFlows, hostProviderOffers } from '../host-shared/HostProviderCatalog'
import {
  createHostNodeProviderResourcePort,
  hostNodeProviderAuthFlows,
  hostNodeProviderAuthStatus,
  normalizeHostNodeProviderStatus,
  type HostNodeProviderResourcePort
} from './HostNodeProviderResources'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'
import {
  HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS,
  HOST_PROVIDER_RUN_MAX_TEXT_CHARS,
  HOST_PROVIDER_RUN_MAX_WARNING_CHARS,
  HOST_PROVIDER_RUN_MAX_WARNING_COUNT,
  normalizeHostProviderRunBegin,
  normalizeHostProviderRunEvent,
  normalizeHostProviderRunFinish,
  normalizeHostProviderRunThread,
  normalizeHostProviderRunTranscriptAppend,
  normalizeHostProviderRunUpdate,
  validateHostProviderRunPrompt,
  type HostProviderRunEvent,
  type HostProviderRunFinish,
  type HostProviderRunPort,
  type HostProviderRunTerminalStatus,
  type HostProviderRunThread,
  type HostProviderRunUsage
} from '../host-runtime/HostProviderRunPort'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import type {
  HostNodeProvider,
  HostNodeProviderInstance,
  HostNodeProviderRunRequest,
  HostNodeProviderRunResult
} from './HostNodeProvider'

const CLAUDE_PROVIDER_ID = 'claude'
const SAFE_IDENTIFIER_MAX_CHARS = 512
const MAX_STREAM_CARRY_CHARS = 1_000_000
const CLAUDE_AUTH_PROBE_ARGS = ['auth', 'status'] as const
const CLAUDE_LOGIN_ARGV_SUFFIX = ['auth', 'login'] as const

const CONTROL_MAX_CODE_POINT = 0x1f
const DELETE_CODE_POINT = 0x7f
const TAB_CODE_POINT = 0x09
const NEWLINE_CODE_POINT = 0x0a
const CARRIAGE_RETURN_CODE_POINT = 0x0d

const CREDENTIAL_VALUE_PATTERN =
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi

/** True when the value contains any C0 control or DEL. */
export function hostNodeClaudeHasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= CONTROL_MAX_CODE_POINT || codePoint === DELETE_CODE_POINT) return true
  }
  return false
}

/** Replace unsafe controls with a space; tab/newline/CR are legal transcript formatting. */
function stripUnsafeControls(value: string): string {
  let output = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint === TAB_CODE_POINT ||
      codePoint === NEWLINE_CODE_POINT ||
      codePoint === CARRIAGE_RETURN_CODE_POINT
    ) {
      output += character
      continue
    }
    output +=
      codePoint <= CONTROL_MAX_CODE_POINT || codePoint === DELETE_CODE_POINT ? ' ' : character
  }
  return output
}

/* ------------------------------------------------------------------ *
 * Process seam
 * ------------------------------------------------------------------ */

export interface HostNodeClaudeSpawnInput {
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
}

export interface HostNodeClaudeSpawnHandle {
  kill(signal: NodeJS.Signals): void
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export type HostNodeClaudeSpawn = (input: HostNodeClaudeSpawnInput) => HostNodeClaudeSpawnHandle

/** Default spawn: ordinary Node child process, never a shell. */
export const hostNodeClaudeSpawn: HostNodeClaudeSpawn = (input) => {
  const child = nodeSpawn(input.binaryPath, [...input.args], {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => input.onStdout(String(chunk)))
  child.stderr?.on('data', (chunk: string) => input.onStderr(String(chunk)))
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }))
    child.once('close', (code, signal) => resolve({ code, signal: signal ? String(signal) : null }))
  })
  return {
    kill(signal) {
      try {
        child.kill(signal)
      } catch {
        // A process that already exited is not a cancellation failure.
      }
    },
    exit
  }
}

export interface HostNodeClaudeAuthProbeInput {
  readonly binaryPath: string
  readonly args: readonly string[]
}

export interface HostNodeClaudeAuthProbeResult {
  readonly exitCode: number | null
}

export type HostNodeClaudeAuthProbe = (
  input: HostNodeClaudeAuthProbeInput
) => Promise<HostNodeClaudeAuthProbeResult>

/** Exit-code-only Claude auth probe. Stdio is discarded so credential text never enters the Host. */
export const hostNodeClaudeAuthProbe: HostNodeClaudeAuthProbe = (input) =>
  new Promise((resolve) => {
    const child = nodeSpawn(input.binaryPath, [...input.args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
      windowsHide: true
    })
    child.once('error', () => resolve({ exitCode: null }))
    child.once('close', (code) => resolve({ exitCode: code ?? null }))
  })

/* ------------------------------------------------------------------ *
 * Errors + validation
 * ------------------------------------------------------------------ */

export class HostNodeClaudeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostNodeClaudeValidationError'
  }
}

export class HostNodeClaudeDuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Host Claude run already exists: ${runId}`)
    this.name = 'HostNodeClaudeDuplicateRunError'
  }
}

export class HostNodeClaudePersistenceError extends Error {
  constructor(operation: string) {
    super(`Claude Host persistence operation failed: ${operation}`)
    this.name = 'HostNodeClaudePersistenceError'
  }
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SAFE_IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !hostNodeClaudeHasControlCharacter(value)
  )
}

function boundedText(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : ''
  const clean = stripUnsafeControls(raw).replace(CREDENTIAL_VALUE_PATTERN, '$1[redacted]')
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/* ------------------------------------------------------------------ *
 * Argv
 * ------------------------------------------------------------------ */

/**
 * Every value the Claude CLI's `--permission-mode` actually accepts.
 *
 * Verified against the installed binary: `claude --help` lists exactly
 * `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`.
 *
 * This is NOT the same vocabulary as the SDK. The App maps its approval mode to
 * the SDK's `'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`
 * (src/main/ProviderCapabilities.ts:667, ProviderLaunchAuthorityDigest.ts:704),
 * because Electron main drives the Claude SDK. This adapter drives the CLI,
 * where `default` is not a choice and would be rejected outright — so the App's
 * mapping must not be copied verbatim.
 */
export const CLAUDE_CLI_PERMISSION_MODES: readonly string[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan'
]

/**
 * Fail-closed posture mapping onto the CLI vocabulary.
 *
 * A headless `-p` run has no interactive permission prompt, and this Host has
 * no provider-proven interaction resume (the CLI exposes no
 * `--permission-prompt-tool`; `canUseTool` is SDK-only), so any posture that
 * would require per-tool approval degrades to `plan` rather than silently
 * escalating. That deliberately includes the App's `default`: its SDK meaning
 * ("permissions work normally", i.e. prompt the user) cannot be honoured
 * headlessly, and there is no CLI token for it.
 */
export function claudePermissionModeFor(approvalMode: string): string {
  if (approvalMode === 'full_access') return 'bypassPermissions'
  if (approvalMode === 'auto_edit') return 'acceptEdits'
  return 'plan'
}

/** Exact CLI argv. The prompt rides `-p` as one argument, never through a shell. */
export function buildHostNodeClaudeArgs(input: {
  readonly prompt: string
  readonly modelId: string
  readonly approvalMode: string
  readonly providerSessionId?: string
}): string[] {
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.modelId,
    '--permission-mode',
    claudePermissionModeFor(input.approvalMode)
  ]
  if (isCanonicalIdentifier(input.providerSessionId)) {
    args.push('--resume', input.providerSessionId)
  }
  return args
}

/* ------------------------------------------------------------------ *
 * Stream parsing
 * ------------------------------------------------------------------ */

export interface HostNodeClaudeStreamLine {
  readonly json?: Record<string, unknown>
}

/** NDJSON splitter that carries a partial trailing line across chunk boundaries. */
export function parseHostNodeClaudeChunk(
  rawChunk: string,
  carry: string
): { lines: HostNodeClaudeStreamLine[]; carry: string } {
  const buffer = `${carry || ''}${rawChunk || ''}`
  const segments = buffer.split(/\r?\n/)
  let nextCarry = segments.pop() ?? ''
  // A provider that never emits a newline must not grow an unbounded buffer.
  if (nextCarry.length > MAX_STREAM_CARRY_CHARS) nextCarry = ''
  const lines: HostNodeClaudeStreamLine[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    try {
      const record = asRecord(JSON.parse(trimmed) as unknown)
      if (record) lines.push({ json: record })
    } catch {
      // Non-JSON stdout is provider noise, never presentation text.
    }
  }
  return { lines, carry: nextCarry }
}

export interface HostNodeClaudeResultSummary {
  readonly sessionId?: string
  readonly isError: boolean
  readonly usage?: HostProviderRunUsage
  readonly finalText?: string
}

function usageFromClaudeResult(value: unknown): HostProviderRunUsage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const usage: HostProviderRunUsage = {
    ...(finiteNonNegative(record.input_tokens) !== undefined
      ? { inputTokens: finiteNonNegative(record.input_tokens) }
      : {}),
    ...(finiteNonNegative(record.output_tokens) !== undefined
      ? { outputTokens: finiteNonNegative(record.output_tokens) }
      : {}),
    ...(finiteNonNegative(record.cache_read_input_tokens) !== undefined
      ? { cacheReadTokens: finiteNonNegative(record.cache_read_input_tokens) }
      : {}),
    ...(finiteNonNegative(record.cache_creation_input_tokens) !== undefined
      ? { cacheWriteTokens: finiteNonNegative(record.cache_creation_input_tokens) }
      : {})
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

type ActiveClaudeRun = {
  cancelled: boolean
  cancellationPublished: boolean
  handle: HostNodeClaudeSpawnHandle | null
}

export interface HostNodeClaudeProviderOptions {
  readonly runPort: HostProviderRunPort
  readonly offers: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: HostNodeClaudeSpawn
  readonly now?: () => number
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly probeAuth?: HostNodeClaudeAuthProbe
}

export class HostNodeClaudeProvider implements HostNodeProviderInstance {
  readonly providerId = CLAUDE_PROVIDER_ID
  private readonly activeRuns = new Map<string, ActiveClaudeRun>()
  private readonly resources: HostNodeProviderResourcePort
  private readonly spawnProcess: HostNodeClaudeSpawn
  private readonly now: () => number

  constructor(private readonly options: HostNodeClaudeProviderOptions) {
    this.resources = options.resources ?? createHostNodeProviderResourcePort(CLAUDE_PROVIDER_ID)
    this.spawnProcess = options.spawn ?? hostNodeClaudeSpawn
    this.now = options.now ?? (() => Date.now())
  }

  private async probeAuthState(
    binaryPath: string
  ): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
    try {
      const probe = this.options.probeAuth ?? hostNodeClaudeAuthProbe
      const result = await probe({ binaryPath, args: [...CLAUDE_AUTH_PROBE_ARGS] })
      if (result.exitCode === 0) return 'authenticated'
      if (typeof result.exitCode === 'number') return 'unauthenticated'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async resolveAuthState(
    resourceAuthState: 'authenticated' | 'unauthenticated' | 'unknown',
    binaryPath: string | null
  ): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
    if (resourceAuthState === 'authenticated' || resourceAuthState === 'unauthenticated') {
      return resourceAuthState
    }
    if (!binaryPath) return 'unknown'
    return this.probeAuthState(binaryPath)
  }

  private async runtimeStatus() {
    const [binary, resourceAuthState] = await Promise.all([
      this.resources.resolveBinary().catch(() => ({ binaryPath: null as string | null })),
      this.resources.getAuthState().catch(() => 'unknown' as const)
    ])
    const binaryAvailable = Boolean(binary.binaryPath)
    const authState = await this.resolveAuthState(resourceAuthState, binary.binaryPath)
    return {
      providerId: CLAUDE_PROVIDER_ID,
      available: binaryAvailable && authState === 'authenticated',
      binaryAvailable,
      authState
    }
  }

  /** A missing binary is a present `unavailable` row, never an omission. */
  async getStatus(): Promise<HostProviderStatusProjection> {
    return normalizeHostNodeProviderStatus(CLAUDE_PROVIDER_ID, await this.runtimeStatus())
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    return hostNodeProviderAuthStatus(CLAUDE_PROVIDER_ID, await this.runtimeStatus())
  }

  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (!this.options.terminalLauncher) return []
    return hostNodeProviderAuthFlows(CLAUDE_PROVIDER_ID, await this.runtimeStatus())
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!isCanonicalIdentifier(operationId)) {
      throw new HostNodeClaudeValidationError('Claude auth operation id is not canonical.')
    }
    const launcher = this.options.terminalLauncher
    if (!launcher) {
      throw new HostNodeClaudeValidationError('Claude interactive terminal login is unavailable.')
    }
    const status = await this.runtimeStatus()
    if (!status.binaryAvailable || status.authState !== 'unauthenticated') {
      throw new HostNodeClaudeValidationError('Claude sign-in is not currently available.')
    }
    if (hostProviderAuthFlows(CLAUDE_PROVIDER_ID).length === 0) {
      throw new HostNodeClaudeValidationError('Claude has no manual sign-in flow.')
    }
    const binary = await this.resources.resolveBinary()
    if (!binary.binaryPath) {
      throw new HostNodeClaudeValidationError('Claude CLI is unavailable.')
    }
    // Handoff close is not authentication; getAuthStatus still probes `auth status`.
    await launcher.launchForProvider(CLAUDE_PROVIDER_ID, {
      argv: [binary.binaryPath, ...CLAUDE_LOGIN_ARGV_SUFFIX]
    })
  }

  async cancelAuth(): Promise<boolean> {
    return false
  }

  cancel(runId: string): boolean {
    if (!isCanonicalIdentifier(runId)) return false
    const active = this.activeRuns.get(runId)
    if (!active || active.cancelled) return false
    active.cancelled = true
    active.handle?.kill('SIGTERM')
    return true
  }

  async shutdown(): Promise<void> {
    for (const active of this.activeRuns.values()) {
      if (active.cancelled) continue
      active.cancelled = true
      active.handle?.kill('SIGTERM')
    }
  }

  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    if (!isCanonicalIdentifier(request.runId) || !isCanonicalIdentifier(request.threadId)) {
      throw new HostNodeClaudeValidationError('Claude run and thread ids must be canonical.')
    }
    if (this.activeRuns.has(request.runId)) {
      throw new HostNodeClaudeDuplicateRunError(request.runId)
    }
    if (!validateHostProviderRunPrompt(request.prompt)) {
      throw new HostNodeClaudeValidationError('Claude prompt must be bounded and control-free.')
    }
    const prompt = request.prompt

    let loaded: HostProviderRunThread | null
    try {
      loaded = this.options.runPort.getThread(request.threadId)
    } catch {
      throw new HostNodeClaudePersistenceError('getThread')
    }
    if (!loaded) throw new HostNodeClaudeValidationError('Claude thread was not found.')
    const thread = this.validateThread(loaded)

    const startedAt = this.isoNow()
    const beginInput = normalizeHostProviderRunBegin({
      runId: request.runId,
      threadId: thread.threadId,
      providerId: CLAUDE_PROVIDER_ID,
      modelId: thread.modelId,
      startedAt
    })
    if (!beginInput) throw new HostNodeClaudeValidationError('Claude run start is invalid.')
    let begin
    try {
      begin = this.options.runPort.beginRun(beginInput)
    } catch {
      throw new HostNodeClaudePersistenceError('beginRun')
    }
    if (begin.kind === 'duplicate') throw new HostNodeClaudeDuplicateRunError(request.runId)

    const active: ActiveClaudeRun = { cancelled: false, cancellationPublished: false, handle: null }
    this.activeRuns.set(request.runId, active)
    let finishCommitted = false
    let cancelRegistered = false

    const finishOnce = (input: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>): void => {
      if (finishCommitted) return
      const normalized = normalizeHostProviderRunFinish({
        runId: request.runId,
        finishedAt: this.isoNow(),
        ...input
      })
      if (!normalized) throw new HostNodeClaudeValidationError('Claude run finish is invalid.')
      try {
        this.options.runPort.finishRun(normalized)
      } catch {
        throw new HostNodeClaudePersistenceError('finishRun')
      }
      finishCommitted = true
    }

    try {
      this.appendTranscript({
        threadId: thread.threadId,
        runId: request.runId,
        role: 'user',
        text: prompt,
        createdAt: startedAt
      })
      this.updateRun({ runId: request.runId, phase: 'starting', updatedAt: startedAt })

      const registration = this.registerCancel(request.runId, () => {
        this.cancel(request.runId)
      })
      if (registration.kind !== 'registered') {
        throw new HostNodeClaudePersistenceError('registerCancel')
      }
      cancelRegistered = true

      const binary = await this.resources.resolveBinary()
      if (!binary.binaryPath) {
        return this.finishPrelaunchFailure({
          request,
          thread,
          finishOnce,
          message: 'Claude CLI is unavailable.',
          errorCode: 'provider_setup_unavailable'
        })
      }

      let sessionId = isCanonicalIdentifier(thread.providerSessionId)
        ? thread.providerSessionId
        : request.runId
      this.publish(request.target, {
        type: 'run.started',
        runId: request.runId,
        threadId: thread.threadId,
        providerId: CLAUDE_PROVIDER_ID,
        sessionId,
        at: this.isoNow()
      })
      this.publish(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status: 'running',
        at: this.isoNow()
      })

      let carry = ''
      let assistantText = ''
      let result: HostNodeClaudeResultSummary | null = null
      const warnings = new Set<string>()

      const handle = this.spawnProcess({
        binaryPath: binary.binaryPath,
        args: buildHostNodeClaudeArgs({
          prompt,
          modelId: thread.modelId,
          approvalMode: thread.posture.approvalMode,
          ...(isCanonicalIdentifier(thread.providerSessionId)
            ? { providerSessionId: thread.providerSessionId }
            : {})
        }),
        cwd: thread.workspace.canonicalPath,
        onStdout: (chunk) => {
          const parsed = parseHostNodeClaudeChunk(chunk, carry)
          carry = parsed.carry
          for (const line of parsed.lines) {
            if (!line.json) continue
            const outcome = this.onStreamLine(request, thread, line.json, active)
            if (outcome.text) assistantText += outcome.text
            if (outcome.result) {
              result = outcome.result
              if (outcome.result.sessionId) sessionId = outcome.result.sessionId
            }
          }
        },
        onStderr: (chunk) => {
          if (String(chunk).trim()) warnings.add('Claude reported stderr during the run.')
        }
      })
      active.handle = handle
      if (active.cancelled) handle.kill('SIGTERM')

      const exit = await handle.exit
      const settled = result as HostNodeClaudeResultSummary | null

      const status: HostProviderRunTerminalStatus = active.cancelled
        ? 'cancelled'
        : settled && !settled.isError && exit.code === 0
          ? 'completed'
          : 'failed'

      const finalText = boundedText(
        assistantText.trim() ? assistantText : (settled?.finalText ?? ''),
        HOST_PROVIDER_RUN_MAX_TEXT_CHARS
      )
      if (finalText.trim()) {
        this.appendTranscript({
          threadId: thread.threadId,
          runId: request.runId,
          role: 'assistant',
          text: finalText,
          createdAt: this.isoNow()
        })
      }

      const warningSummaries = [...warnings].slice(0, HOST_PROVIDER_RUN_MAX_WARNING_COUNT)
      const usage = settled?.usage
      finishOnce({
        status,
        ...(isCanonicalIdentifier(sessionId) ? { providerSessionId: sessionId } : {}),
        ...(usage ? { usage } : {}),
        warningSummaries,
        ...(status === 'failed' ? { errorCode: 'provider_failed' as const } : {})
      })
      this.publish(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status,
        at: this.isoNow(),
        ...(warningSummaries.length ? { warningCount: warningSummaries.length } : {})
      })
      return {
        runId: request.runId,
        status,
        ...(isCanonicalIdentifier(sessionId) ? { sessionId } : {}),
        exitCode: exit.code
      }
    } catch (error) {
      if (error instanceof HostNodeClaudePersistenceError) throw error
      finishOnce({ status: 'failed', warningSummaries: [], errorCode: 'provider_launch_failed' })
      this.publish(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status: 'failed',
        at: this.isoNow()
      })
      return { runId: request.runId, status: 'failed', exitCode: null }
    } finally {
      try {
        if (cancelRegistered) this.clearCancel(request.runId)
      } finally {
        this.activeRuns.delete(request.runId)
      }
    }
  }

  private onStreamLine(
    request: HostNodeProviderRunRequest,
    thread: HostProviderRunThread,
    json: Record<string, unknown>,
    active: ActiveClaudeRun
  ): { text: string; result: HostNodeClaudeResultSummary | null } {
    const type = typeof json.type === 'string' ? json.type : ''

    if (type === 'assistant') {
      const message = asRecord(json.message)
      const content = Array.isArray(message?.content) ? message.content : []
      let text = ''
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text
          continue
        }
        if (block.type === 'tool_use' && isCanonicalIdentifier(block.id)) {
          this.publish(request.target, {
            type: 'run.tool',
            runId: request.runId,
            threadId: thread.threadId,
            toolId: block.id,
            ...(isCanonicalIdentifier(block.name) ? { toolName: block.name } : {}),
            phase: 'started',
            at: this.isoNow()
          })
        }
      }
      if (text) {
        this.updateRun({ runId: request.runId, phase: 'streaming', updatedAt: this.isoNow() })
        this.publish(request.target, {
          type: 'run.content',
          runId: request.runId,
          threadId: thread.threadId,
          text: boundedText(text, HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS),
          at: this.isoNow()
        })
      }
      this.publishCancelling(request, active)
      return { text, result: null }
    }

    if (type === 'user') {
      const message = asRecord(json.message)
      const content = Array.isArray(message?.content) ? message.content : []
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (!block || block.type !== 'tool_result') continue
        if (!isCanonicalIdentifier(block.tool_use_id)) continue
        this.publish(request.target, {
          type: 'run.tool',
          runId: request.runId,
          threadId: thread.threadId,
          toolId: block.tool_use_id,
          phase: 'finished',
          status: block.is_error === true ? 'error' : 'success',
          at: this.isoNow()
        })
      }
      this.publishCancelling(request, active)
      return { text: '', result: null }
    }

    if (type === 'result') {
      const sessionId = isCanonicalIdentifier(json.session_id) ? json.session_id : undefined
      const usage = usageFromClaudeResult(json.usage)
      return {
        text: '',
        result: {
          ...(sessionId ? { sessionId } : {}),
          isError: json.is_error === true || json.subtype !== 'success',
          ...(usage ? { usage } : {}),
          ...(typeof json.result === 'string' ? { finalText: json.result } : {})
        }
      }
    }

    return { text: '', result: null }
  }

  private publishCancelling(request: HostNodeProviderRunRequest, active: ActiveClaudeRun): void {
    if (!active.cancelled || active.cancellationPublished) return
    active.cancellationPublished = true
    this.updateRun({ runId: request.runId, phase: 'cancelling', updatedAt: this.isoNow() })
  }

  /** Thread must be Claude-configured and its selection must exist in catalog offers. */
  private validateThread(thread: HostProviderRunThread): HostProviderRunThread {
    const normalized = normalizeHostProviderRunThread(thread)
    if (!normalized) {
      throw new HostNodeClaudeValidationError('Claude thread configuration is invalid.')
    }
    if (normalized.providerId !== CLAUDE_PROVIDER_ID) {
      throw new HostNodeClaudeValidationError('Thread is not configured for Claude.')
    }
    const model = this.options.offers.models.find((entry) => entry.modelId === normalized.modelId)
    if (!model) {
      throw new HostNodeClaudeValidationError('Claude model is not offered by the Host catalog.')
    }
    if (
      normalized.reasoningId !== undefined &&
      !model.reasoning.some((entry) => entry.reasoningId === normalized.reasoningId)
    ) {
      throw new HostNodeClaudeValidationError('Claude reasoning is not offered for this model.')
    }
    return normalized
  }

  private finishPrelaunchFailure(input: {
    request: HostNodeProviderRunRequest
    thread: HostProviderRunThread
    finishOnce: (finish: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>) => void
    message: string
    errorCode: NonNullable<HostProviderRunFinish['errorCode']>
  }): HostNodeProviderRunResult {
    this.appendTranscript({
      threadId: input.thread.threadId,
      runId: input.request.runId,
      role: 'system',
      text: boundedText(input.message, HOST_PROVIDER_RUN_MAX_WARNING_CHARS),
      createdAt: this.isoNow()
    })
    input.finishOnce({ status: 'failed', warningSummaries: [], errorCode: input.errorCode })
    this.publish(input.request.target, {
      type: 'run.status',
      runId: input.request.runId,
      threadId: input.thread.threadId,
      status: 'failed',
      at: this.isoNow()
    })
    return { runId: input.request.runId, status: 'failed', exitCode: null }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  private appendTranscript(input: Parameters<HostProviderRunPort['appendTranscript']>[0]): void {
    const normalized = normalizeHostProviderRunTranscriptAppend(input)
    if (!normalized) throw new HostNodeClaudeValidationError('Claude transcript append is invalid.')
    try {
      this.options.runPort.appendTranscript(normalized)
    } catch {
      throw new HostNodeClaudePersistenceError('appendTranscript')
    }
  }

  private updateRun(input: Parameters<HostProviderRunPort['updateRun']>[0]): void {
    const normalized = normalizeHostProviderRunUpdate(input)
    if (!normalized) throw new HostNodeClaudeValidationError('Claude run update is invalid.')
    try {
      this.options.runPort.updateRun(normalized)
    } catch {
      throw new HostNodeClaudePersistenceError('updateRun')
    }
  }

  private publish(target: HostRunEventTarget, event: HostProviderRunEvent): void {
    const normalized = normalizeHostProviderRunEvent(event)
    if (!normalized) return
    try {
      this.options.runPort.publishRunEvent(target, normalized)
    } catch {
      throw new HostNodeClaudePersistenceError('publishRunEvent')
    }
  }

  private registerCancel(runId: string, cancel: () => void) {
    try {
      return this.options.runPort.registerCancel(runId, cancel)
    } catch {
      throw new HostNodeClaudePersistenceError('registerCancel')
    }
  }

  private clearCancel(runId: string): void {
    try {
      this.options.runPort.clearCancel(runId)
    } catch {
      throw new HostNodeClaudePersistenceError('clearCancel')
    }
  }
}

export interface HostNodeClaudeProviderFactoryOptions {
  readonly offers?: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: HostNodeClaudeSpawn
  readonly now?: () => number
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly probeAuth?: HostNodeClaudeAuthProbe
}

/** Static Claude factory implementing the generic HostNodeProvider contract. */
export function createHostNodeClaudeProviderFactory(
  options: HostNodeClaudeProviderFactoryOptions = {}
): HostNodeProvider {
  const offers = options.offers ?? hostProviderOffers(CLAUDE_PROVIDER_ID, true)
  if (!offers || offers.providerId !== CLAUDE_PROVIDER_ID) {
    throw new Error('Claude provider factory requires Claude offers')
  }
  return {
    providerId: CLAUDE_PROVIDER_ID,
    displayProvider: 'Claude',
    shortCode: 'CL',
    offers,
    // HostNodeInteractionResolver exposes `register` only, with no awaitable
    // settlement, so no adapter can wire a real one-shot resume today. Flags
    // stay off so the domain's derived capabilities remain honest.
    supportsApprovals: false,
    supportsQuestions: false,
    create({ runPort, interactions }) {
      void interactions
      return new HostNodeClaudeProvider({
        runPort,
        offers,
        ...(options.resources ? { resources: options.resources } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.terminalLauncher ? { terminalLauncher: options.terminalLauncher } : {}),
        ...(options.probeAuth ? { probeAuth: options.probeAuth } : {})
      })
    }
  }
}
