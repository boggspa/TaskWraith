/**
 * Node-owned Pi provider adapter — real `pi --mode rpc` run path.
 *
 * Supersedes this lane's wave-B refusal. The refusal reason was that pi's
 * credential lifecycle and containment could not be re-authored safely from the
 * outside; both now come from the EXTRACTED code in `src/host-shared/pi/`
 * rather than from guesswork.
 *
 * CONTAINMENT — do not "simplify" any of this:
 *
 *   Pi ships no permission system of its own (see the header of
 *   host-shared/pi/PiCliArgs.ts). TaskWraith's containment is built ENTIRELY
 *   from pi's flag surface: `--no-extensions`, `--no-skills`,
 *   `--no-prompt-templates`, `--no-context-files`, `--no-approve`, `--offline`,
 *   plus a per-run isolated `PI_CODING_AGENT_DIR`. Those flags are produced by
 *   `buildPiRpcArgs`, which is why this adapter CALLS it instead of assembling
 *   argv itself.
 *
 *   `PI_READ_ONLY_TOOLS === PI_WRITE_TOOLS === ['read','grep','find','ls']`:
 *   pi's native tools are always read-only, and write capability only ever
 *   arrives through the TaskWraith coordination extension. The pure-Node Host
 *   has no such extension, so `writeCapable` is pinned to `false` and a Host Pi
 *   run is READ-ONLY BY CONSTRUCTION. That is stricter than the App, never
 *   looser.
 *
 *   Credentials go through `buildPiCredentialEnv`, which deletes every foreign
 *   credential variable and every allowlisted upstream variable before setting
 *   exactly the one selected key. A parent shell can therefore never widen the
 *   credential set of the child.
 *
 * CONTRACT PROBE (pi 0.84.2, /opt/homebrew/bin/pi): `--mode rpc` exists and all
 * fifteen flags `buildPiRpcArgs` emits exist on the real binary. Verified
 * before this adapter was finalised, because fake-spawn tests prove internals
 * and never the CLI contract.
 *
 * Interaction flags stay OFF: pi has no permission prompt to resume.
 *
 * Control characters are detected numerically so this file carries no literal
 * control bytes.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import {
  buildPiProcessEnv,
  buildPiRpcArgs,
  piThinkingLevelForEffort
} from '../host-shared/pi/PiCliArgs'
import { createPiIsolatedHome, type PiIsolatedHomeLease } from '../host-shared/pi/PiIsolatedHome'
import {
  PI_UPSTREAM_KEY_ENV,
  buildPiCredentialEnv,
  isPiUpstreamAllowed,
  type PiUpstreamId
} from '../host-shared/pi/PiModelPolicy'
import {
  PiRpcTurnReducer,
  parsePiStreamChunk,
  piAbortCommand,
  piPromptCommand,
  type NormalizedPiRunEvent
} from '../host-shared/pi/PiRpc'
import { splitPiWireModelId } from '../shared/piBrandTable'
import {
  createHostNodeProviderResourcePort,
  hostNodeProviderAuthFlows,
  hostNodeProviderAuthStatus,
  normalizeHostNodeProviderStatus,
  type HostNodeProviderResourcePort
} from './HostNodeProviderResources'
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

const PI_PROVIDER_ID = 'pi'
const SAFE_IDENTIFIER_MAX_CHARS = 512
const MAX_STREAM_CARRY_CHARS = 1_000_000

const CONTROL_MAX_CODE_POINT = 0x1f
const DELETE_CODE_POINT = 0x7f
const TAB_CODE_POINT = 0x09
const NEWLINE_CODE_POINT = 0x0a
const CARRIAGE_RETURN_CODE_POINT = 0x0d

const CREDENTIAL_VALUE_PATTERN =
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= CONTROL_MAX_CODE_POINT || codePoint === DELETE_CODE_POINT) return true
  }
  return false
}

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

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SAFE_IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !hasControlCharacter(value)
  )
}

/** Bounded presentation text. The selected key is redacted by exact value too. */
function boundedText(value: unknown, limit: number, secrets: readonly string[] = []): string {
  const raw = typeof value === 'string' ? value : ''
  let clean = stripUnsafeControls(raw).replace(CREDENTIAL_VALUE_PATTERN, '$1[redacted]')
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join('[redacted]')
  }
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class HostNodePiValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostNodePiValidationError'
  }
}

export class HostNodePiDuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Host Pi run already exists: ${runId}`)
    this.name = 'HostNodePiDuplicateRunError'
  }
}

export class HostNodePiPersistenceError extends Error {
  constructor(operation: string) {
    super(`Pi Host persistence operation failed: ${operation}`)
    this.name = 'HostNodePiPersistenceError'
  }
}

/* ------------------------------------------------------------------ *
 * Process seam
 * ------------------------------------------------------------------ */

export interface HostNodePiSpawnInput {
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
}

export interface HostNodePiSpawnHandle {
  /** Write one newline-terminated RPC command to the child's stdin. */
  writeCommand(line: string): void
  kill(signal: NodeJS.Signals): void
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export type HostNodePiSpawn = (input: HostNodePiSpawnInput) => HostNodePiSpawnHandle

/** Default spawn: ordinary Node child process, never a shell. */
export const hostNodePiSpawn: HostNodePiSpawn = (input) => {
  const child = nodeSpawn(input.binaryPath, [...input.args], {
    cwd: input.cwd,
    env: input.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
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
    writeCommand(line) {
      try {
        child.stdin?.write(`${line}\n`)
      } catch {
        // A closed stdin is not a caller error; the run settles on exit.
      }
    },
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

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

type ActivePiRun = {
  cancelled: boolean
  cancellationPublished: boolean
  handle: HostNodePiSpawnHandle | null
}

export interface HostNodePiProviderOptions {
  readonly runPort: HostProviderRunPort
  readonly offers: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: HostNodePiSpawn
  /** Base environment the credential firewall scrubs. Defaults to process.env. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
  /** Root for the per-run isolated PI_CODING_AGENT_DIR. Defaults to os.tmpdir(). */
  readonly temporaryRoot?: string
  /**
   * Root for persistent per-thread pi sessions. When omitted the run is
   * ephemeral (`--no-session`): the Host run port exposes no profile path to
   * providers today, so persistence is opt-in rather than invented.
   */
  readonly sessionRoot?: string
  readonly now?: () => number
}

export class HostNodePiProvider implements HostNodeProviderInstance {
  readonly providerId = PI_PROVIDER_ID
  private readonly activeRuns = new Map<string, ActivePiRun>()
  private readonly resources: HostNodeProviderResourcePort
  private readonly spawnProcess: HostNodePiSpawn
  private readonly baseEnv: Readonly<Record<string, string | undefined>>
  private readonly temporaryRoot: string
  private readonly now: () => number

  constructor(private readonly options: HostNodePiProviderOptions) {
    this.resources = options.resources ?? createHostNodeProviderResourcePort(PI_PROVIDER_ID)
    this.spawnProcess = options.spawn ?? hostNodePiSpawn
    this.baseEnv = options.baseEnv ?? process.env
    this.temporaryRoot = options.temporaryRoot ?? tmpdir()
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The Host reads a single upstream BYOK key from its own environment.
   *
   * It deliberately does NOT read the App's Pi key store: that store is sealed
   * with Electron `safeStorage` (PiSafeStorage.encryptString/decryptString),
   * which a pure-Node Host does not have. Inventing a second decryption path
   * would be exactly the credential guesswork this adapter refused in wave B.
   */
  private upstreamKey(upstream: PiUpstreamId): string | null {
    const value = this.baseEnv[PI_UPSTREAM_KEY_ENV[upstream]]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  private configuredUpstreams(): PiUpstreamId[] {
    return (Object.keys(PI_UPSTREAM_KEY_ENV) as PiUpstreamId[]).filter((upstream) =>
      Boolean(this.upstreamKey(upstream))
    )
  }

  private async runtimeStatus() {
    const binary = await this.resources.resolveBinary().catch(() => ({ binaryPath: null }))
    const binaryAvailable = Boolean(binary.binaryPath)
    const authenticated = this.configuredUpstreams().length > 0
    return {
      providerId: PI_PROVIDER_ID,
      available: binaryAvailable && authenticated,
      binaryAvailable,
      authState: authenticated ? ('authenticated' as const) : ('unauthenticated' as const)
    }
  }

  /** A missing binary is a present `unavailable` row, never an omission. */
  async getStatus(): Promise<HostProviderStatusProjection> {
    const runtime = await this.runtimeStatus()
    const projection = normalizeHostNodeProviderStatus(PI_PROVIDER_ID, runtime)
    if (runtime.binaryAvailable && runtime.authState === 'unauthenticated') {
      return {
        ...projection,
        detail:
          'Pi authenticates by upstream API key in the Host environment, not a terminal login.'
      }
    }
    return projection
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    return hostNodeProviderAuthStatus(PI_PROVIDER_ID, await this.runtimeStatus())
  }

  /** Pi has no terminal login flow; this stays derived rather than fabricated. */
  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    return hostNodeProviderAuthFlows(PI_PROVIDER_ID, await this.runtimeStatus())
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!isCanonicalIdentifier(operationId)) {
      throw new HostNodePiValidationError('Pi auth operation id is not canonical.')
    }
    throw new HostNodePiValidationError(
      'Pi authenticates by upstream API key in the Host environment, not a terminal handoff.'
    )
  }

  async cancelAuth(): Promise<boolean> {
    return false
  }

  /** Exact run cancellation: abort over RPC first, then signal. */
  cancel(runId: string): boolean {
    if (!isCanonicalIdentifier(runId)) return false
    const active = this.activeRuns.get(runId)
    if (!active || active.cancelled) return false
    active.cancelled = true
    if (active.handle) {
      active.handle.writeCommand(piAbortCommand())
      active.handle.kill('SIGTERM')
    }
    return true
  }

  async shutdown(): Promise<void> {
    for (const active of this.activeRuns.values()) {
      if (active.cancelled) continue
      active.cancelled = true
      active.handle?.kill('SIGTERM')
    }
  }

  /**
   * Validate the thread against catalog offers AND against pi's wire-id shape.
   *
   * A Pi model id is `<upstream>/<model>`; the upstream selects both the flag
   * and the credential variable, so an id without one cannot be run.
   */
  validateThread(thread: HostProviderRunThread): {
    thread: HostProviderRunThread
    upstream: PiUpstreamId
    modelId: string
  } {
    const normalized = normalizeHostProviderRunThread(thread)
    if (!normalized) throw new HostNodePiValidationError('Pi thread configuration is invalid.')
    if (normalized.providerId !== PI_PROVIDER_ID) {
      throw new HostNodePiValidationError('Thread is not configured for Pi.')
    }
    const model = this.options.offers.models.find((entry) => entry.modelId === normalized.modelId)
    if (!model) {
      throw new HostNodePiValidationError('Pi model is not offered by the Host catalog.')
    }
    if (
      normalized.reasoningId !== undefined &&
      !model.reasoning.some((entry) => entry.reasoningId === normalized.reasoningId)
    ) {
      throw new HostNodePiValidationError('Pi reasoning is not offered for this model.')
    }
    const split = splitPiWireModelId(normalized.modelId)
    if (!split) {
      throw new HostNodePiValidationError(
        'Pi model id must be an upstream-qualified wire id (upstream/model).'
      )
    }
    if (!isPiUpstreamAllowed(split.upstream)) {
      throw new HostNodePiValidationError('Pi upstream is not allowlisted.')
    }
    return { thread: normalized, upstream: split.upstream as PiUpstreamId, modelId: split.modelId }
  }

  async run(request: HostNodePiRunRequest): Promise<HostNodeProviderRunResult> {
    if (!isCanonicalIdentifier(request.runId) || !isCanonicalIdentifier(request.threadId)) {
      throw new HostNodePiValidationError('Pi run and thread ids must be canonical.')
    }
    if (this.activeRuns.has(request.runId)) {
      throw new HostNodePiDuplicateRunError(request.runId)
    }
    if (!validateHostProviderRunPrompt(request.prompt)) {
      throw new HostNodePiValidationError('Pi prompt must be bounded and control-free.')
    }
    const prompt = request.prompt

    let loaded: HostProviderRunThread | null
    try {
      loaded = this.options.runPort.getThread(request.threadId)
    } catch {
      throw new HostNodePiPersistenceError('getThread')
    }
    if (!loaded) throw new HostNodePiValidationError('Pi thread was not found.')
    const { thread, upstream, modelId } = this.validateThread(loaded)

    const startedAt = this.isoNow()
    const beginInput = normalizeHostProviderRunBegin({
      runId: request.runId,
      threadId: thread.threadId,
      providerId: PI_PROVIDER_ID,
      modelId: thread.modelId,
      startedAt
    })
    if (!beginInput) throw new HostNodePiValidationError('Pi run start is invalid.')
    let begin
    try {
      begin = this.options.runPort.beginRun(beginInput)
    } catch {
      throw new HostNodePiPersistenceError('beginRun')
    }
    if (begin.kind === 'duplicate') throw new HostNodePiDuplicateRunError(request.runId)

    const active: ActivePiRun = { cancelled: false, cancellationPublished: false, handle: null }
    this.activeRuns.set(request.runId, active)
    let finishCommitted = false
    let cancelRegistered = false
    let lease: PiIsolatedHomeLease | null = null

    const finishOnce = (input: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>): void => {
      if (finishCommitted) return
      const normalized = normalizeHostProviderRunFinish({
        runId: request.runId,
        finishedAt: this.isoNow(),
        ...input
      })
      if (!normalized) throw new HostNodePiValidationError('Pi run finish is invalid.')
      try {
        this.options.runPort.finishRun(normalized)
      } catch {
        throw new HostNodePiPersistenceError('finishRun')
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
        throw new HostNodePiPersistenceError('registerCancel')
      }
      cancelRegistered = true

      const binary = await this.resources.resolveBinary()
      if (!binary.binaryPath) {
        return this.finishPrelaunchFailure({
          request,
          thread,
          finishOnce,
          message: 'Pi CLI is unavailable.'
        })
      }
      const apiKey = this.upstreamKey(upstream)
      if (!apiKey) {
        return this.finishPrelaunchFailure({
          request,
          thread,
          finishOnce,
          message: `Pi upstream credential is unavailable (${PI_UPSTREAM_KEY_ENV[upstream]}).`
        })
      }

      // Isolated PI_CODING_AGENT_DIR: created and verified before the child
      // can ever see it, and cleaned up in `finally`.
      lease = createPiIsolatedHome({ temporaryRoot: this.temporaryRoot, runId: request.runId })

      const ephemeral = !this.options.sessionRoot
      const args = buildPiRpcArgs({
        upstream,
        modelId,
        // Read-only by construction: the Host has no coordination extension, so
        // no write tools can exist regardless of the thread's posture.
        writeCapable: false,
        sessionDir: ephemeral
          ? lease.path
          : join(this.options.sessionRoot as string, thread.threadId),
        ...(ephemeral
          ? { ephemeralSession: true }
          : { sessionId: `taskwraith-${thread.threadId}` }),
        ...(piThinkingLevelForEffort(thread.reasoningId)
          ? { thinkingLevel: piThinkingLevelForEffort(thread.reasoningId) }
          : {})
      })
      const env = buildPiProcessEnv({
        credentialEnv: buildPiCredentialEnv(this.baseEnv, { [upstream]: apiKey }),
        isolatedHomeDir: lease.path
      })

      const sessionId = request.runId
      this.publish(request.target, {
        type: 'run.started',
        runId: request.runId,
        threadId: thread.threadId,
        providerId: PI_PROVIDER_ID,
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

      const reducer = new PiRpcTurnReducer()
      const secrets = [apiKey]
      let carry = ''
      let assistantText = ''
      let usage: HostProviderRunUsage | undefined
      let resolvedSessionId = sessionId
      const warnings = new Set<string>()

      const handle = this.spawnProcess({
        binaryPath: binary.binaryPath,
        args,
        cwd: thread.workspace.canonicalPath,
        env,
        onStdout: (chunk) => {
          const parsed = parsePiStreamChunk(chunk, carry)
          carry = parsed.carry.length > MAX_STREAM_CARRY_CHARS ? '' : parsed.carry
          for (const line of parsed.lines) {
            for (const event of reducer.ingest(line)) {
              const outcome = this.onPiEvent(request, thread, active, event, secrets)
              if (outcome.text) assistantText += outcome.text
              if (outcome.usage) usage = outcome.usage
              if (outcome.sessionId) resolvedSessionId = outcome.sessionId
              if (outcome.warning) warnings.add(outcome.warning)
            }
          }
        },
        onStderr: (chunk) => {
          if (String(chunk).trim()) warnings.add('Pi reported stderr during the run.')
        }
      })
      active.handle = handle
      if (active.cancelled) {
        handle.writeCommand(piAbortCommand())
        handle.kill('SIGTERM')
      } else {
        handle.writeCommand(piPromptCommand(prompt, request.runId))
      }

      const exit = await handle.exit
      const outcome = reducer.terminalOutcome()
      const status: HostProviderRunTerminalStatus = active.cancelled
        ? 'cancelled'
        : !outcome.failed && exit.code === 0
          ? 'completed'
          : 'failed'

      const finalText = boundedText(assistantText, HOST_PROVIDER_RUN_MAX_TEXT_CHARS, secrets)
      if (finalText.trim()) {
        this.appendTranscript({
          threadId: thread.threadId,
          runId: request.runId,
          role: 'assistant',
          text: finalText,
          createdAt: this.isoNow()
        })
      }
      if (status === 'failed' && outcome.text) {
        warnings.add(boundedText(outcome.text, HOST_PROVIDER_RUN_MAX_WARNING_CHARS, secrets))
      }

      const warningSummaries = [...warnings]
        .filter(Boolean)
        .slice(0, HOST_PROVIDER_RUN_MAX_WARNING_COUNT)
      finishOnce({
        status,
        ...(isCanonicalIdentifier(resolvedSessionId)
          ? { providerSessionId: resolvedSessionId }
          : {}),
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
        ...(isCanonicalIdentifier(resolvedSessionId) ? { sessionId: resolvedSessionId } : {}),
        exitCode: exit.code
      }
    } catch (error) {
      if (error instanceof HostNodePiPersistenceError) throw error
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
        // The isolated home must not outlive the run, cancelled or not.
        lease?.cleanup()
      } catch {
        // Cleanup failure is reported by the lease, never fatal to the run.
      }
      try {
        if (cancelRegistered) this.clearCancel(request.runId)
      } finally {
        this.activeRuns.delete(request.runId)
      }
    }
  }

  private onPiEvent(
    request: HostNodePiRunRequest,
    thread: HostProviderRunThread,
    active: ActivePiRun,
    event: NormalizedPiRunEvent,
    secrets: readonly string[]
  ): {
    text: string
    usage?: HostProviderRunUsage
    sessionId?: string
    warning?: string
  } {
    if (event.type === 'content' && event.text) {
      this.updateRun({ runId: request.runId, phase: 'streaming', updatedAt: this.isoNow() })
      this.publish(request.target, {
        type: 'run.content',
        runId: request.runId,
        threadId: thread.threadId,
        text: boundedText(event.text, HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS, secrets),
        at: this.isoNow()
      })
      this.publishCancelling(request, active)
      return { text: event.text }
    }
    if (event.type === 'tool_use' && isCanonicalIdentifier(event.toolId)) {
      this.publish(request.target, {
        type: 'run.tool',
        runId: request.runId,
        threadId: thread.threadId,
        toolId: event.toolId,
        ...(isCanonicalIdentifier(event.toolName) ? { toolName: event.toolName } : {}),
        phase: 'started',
        at: this.isoNow()
      })
      return { text: '' }
    }
    if (event.type === 'tool_result' && isCanonicalIdentifier(event.toolId)) {
      this.publish(request.target, {
        type: 'run.tool',
        runId: request.runId,
        threadId: thread.threadId,
        toolId: event.toolId,
        phase: 'finished',
        ...(event.toolStatus ? { status: event.toolStatus } : {}),
        at: this.isoNow()
      })
      return { text: '' }
    }
    if (event.type === 'provider_warning') {
      return {
        text: '',
        warning: boundedText(event.text, HOST_PROVIDER_RUN_MAX_WARNING_CHARS, secrets)
      }
    }
    if (event.type === 'init' && isCanonicalIdentifier(event.sessionId)) {
      return { text: '', sessionId: event.sessionId }
    }
    if (event.type === 'result') {
      return {
        text: '',
        ...(event.usage ? { usage: hostUsageFromPiUsage(event.usage) } : {}),
        ...(isCanonicalIdentifier(event.sessionId) ? { sessionId: event.sessionId } : {})
      }
    }
    return { text: '' }
  }

  private publishCancelling(request: HostNodePiRunRequest, active: ActivePiRun): void {
    if (!active.cancelled || active.cancellationPublished) return
    active.cancellationPublished = true
    this.updateRun({ runId: request.runId, phase: 'cancelling', updatedAt: this.isoNow() })
  }

  private finishPrelaunchFailure(input: {
    request: HostNodePiRunRequest
    thread: HostProviderRunThread
    finishOnce: (finish: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>) => void
    message: string
  }): HostNodeProviderRunResult {
    this.appendTranscript({
      threadId: input.thread.threadId,
      runId: input.request.runId,
      role: 'system',
      text: boundedText(input.message, HOST_PROVIDER_RUN_MAX_WARNING_CHARS),
      createdAt: this.isoNow()
    })
    input.finishOnce({
      status: 'failed',
      warningSummaries: [],
      errorCode: 'provider_setup_unavailable'
    })
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
    if (!normalized) throw new HostNodePiValidationError('Pi transcript append is invalid.')
    try {
      this.options.runPort.appendTranscript(normalized)
    } catch {
      throw new HostNodePiPersistenceError('appendTranscript')
    }
  }

  private updateRun(input: Parameters<HostProviderRunPort['updateRun']>[0]): void {
    const normalized = normalizeHostProviderRunUpdate(input)
    if (!normalized) throw new HostNodePiValidationError('Pi run update is invalid.')
    try {
      this.options.runPort.updateRun(normalized)
    } catch {
      throw new HostNodePiPersistenceError('updateRun')
    }
  }

  private publish(target: HostRunEventTarget, event: HostProviderRunEvent): void {
    const normalized = normalizeHostProviderRunEvent(event)
    if (!normalized) return
    try {
      this.options.runPort.publishRunEvent(target, normalized)
    } catch {
      throw new HostNodePiPersistenceError('publishRunEvent')
    }
  }

  private registerCancel(runId: string, cancel: () => void) {
    try {
      return this.options.runPort.registerCancel(runId, cancel)
    } catch {
      throw new HostNodePiPersistenceError('registerCancel')
    }
  }

  private clearCancel(runId: string): void {
    try {
      this.options.runPort.clearCancel(runId)
    } catch {
      throw new HostNodePiPersistenceError('clearCancel')
    }
  }
}

type HostNodePiRunRequest = HostNodeProviderRunRequest

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function hostUsageFromPiUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
}): HostProviderRunUsage | undefined {
  const mapped: HostProviderRunUsage = {
    ...(finiteNonNegative(usage.inputTokens) !== undefined
      ? { inputTokens: finiteNonNegative(usage.inputTokens) }
      : {}),
    ...(finiteNonNegative(usage.outputTokens) !== undefined
      ? { outputTokens: finiteNonNegative(usage.outputTokens) }
      : {}),
    ...(finiteNonNegative(usage.cacheReadTokens) !== undefined
      ? { cacheReadTokens: finiteNonNegative(usage.cacheReadTokens) }
      : {}),
    ...(finiteNonNegative(usage.cacheWriteTokens) !== undefined
      ? { cacheWriteTokens: finiteNonNegative(usage.cacheWriteTokens) }
      : {}),
    ...(finiteNonNegative(usage.costUsd) !== undefined
      ? { estimatedCostUsd: finiteNonNegative(usage.costUsd) }
      : {})
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

export interface HostNodePiProviderFactoryOptions {
  readonly offers?: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: HostNodePiSpawn
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
  readonly temporaryRoot?: string
  readonly sessionRoot?: string
  readonly now?: () => number
}

/** Static Pi factory implementing the generic HostNodeProvider contract. */
export function createHostNodePiProviderFactory(
  options: HostNodePiProviderFactoryOptions = {}
): HostNodeProvider {
  const offers = options.offers ?? hostProviderOffers(PI_PROVIDER_ID, true)
  if (!offers || offers.providerId !== PI_PROVIDER_ID) {
    throw new Error('Pi provider factory requires Pi offers')
  }
  return {
    providerId: PI_PROVIDER_ID,
    displayProvider: 'Pi',
    shortCode: 'PI',
    offers,
    // Pi ships no permission system, so there is no prompt to resume. These
    // must stay false: advertising them would make derived capabilities lie.
    supportsApprovals: false,
    supportsQuestions: false,
    create({ runPort, interactions }) {
      void interactions
      return new HostNodePiProvider({
        runPort,
        offers,
        ...(options.resources ? { resources: options.resources } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
        ...(options.temporaryRoot ? { temporaryRoot: options.temporaryRoot } : {}),
        ...(options.sessionRoot ? { sessionRoot: options.sessionRoot } : {}),
        ...(options.now ? { now: options.now } : {})
      })
    }
  }
}
