/**
 * Node-owned Muse provider adapter.
 *
 * This is a Host adapter, not an Electron IPC bridge: it receives a
 * transport-neutral event target and injected persistence/resource ports.
 * Electron composition, profile storage, and client connection lifetime stay
 * outside this module.
 */

import { randomUUID } from 'node:crypto'

import { isMuseSessionUuid, resolveMuseExecSessionId } from '../main/muse/MuseCliArgs'
import { parseMuseAuthJsonCredential } from '../main/muse/MuseProbe'
import {
  runMuseProvider,
  type MuseRunInput,
  type MuseRunOutcome,
  type MuseRunSpawn,
  type MuseRunSpawnHandle
} from '../main/muse/MuseRun'
import type { MuseExecNormalizedEvent } from '../main/muse/MuseExecJson'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import {
  HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS,
  HOST_PROVIDER_RUN_MAX_TEXT_CHARS,
  HOST_PROVIDER_RUN_MAX_WARNING_CHARS,
  HOST_PROVIDER_RUN_MAX_WARNING_COUNT,
  type HostProviderRunEvent,
  type HostProviderRunFinish,
  type HostProviderRunPort,
  type HostProviderRunTerminalStatus,
  type HostProviderRunThread,
  type HostProviderRunUsage,
  normalizeHostProviderRunBegin,
  normalizeHostProviderRunEvent,
  normalizeHostProviderRunFinish,
  normalizeHostProviderRunThread,
  normalizeHostProviderRunTranscriptAppend,
  normalizeHostProviderRunUpdate,
  validateHostProviderRunPrompt
} from '../host-runtime/HostProviderRunPort'

const MUSE_PROVIDER_ID = 'muse'
const SAFE_IDENTIFIER_MAX_CHARS = 512

// eslint-disable-next-line no-control-regex -- run ids and canonical paths reject C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const CREDENTIAL_VALUE_PATTERN =
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi
// eslint-disable-next-line no-control-regex -- transcript presentation permits tab/newline/CR only.
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface HostNodeMuseBinaryResolution {
  readonly binaryPath: string | null
  readonly source?: string
  readonly error?: string
}

/** Node-only resource seams. Credential bytes are never returned by status projections. */
export interface HostNodeMuseResourcePort {
  resolveBinary(): Promise<HostNodeMuseBinaryResolution>
  getTemporaryRoot(): string
  readAuthJsonText(): Promise<string | null>
  readMetaApiKeyEnv(): string | null | undefined
  spawn?: MuseRunSpawn
}

export interface HostNodeMuseProviderOptions {
  readonly runPort: HostProviderRunPort
  readonly resources: HostNodeMuseResourcePort
  /** Test seam; production defaults to the landed Node-only Muse lifecycle. */
  readonly runMuseProvider?: (input: MuseRunInput) => Promise<MuseRunOutcome>
  readonly now?: () => number
  /** Generates only a Muse session UUID, never a caller-controlled run id. */
  readonly createSessionId?: () => string
}

export interface HostNodeMuseRunRequest {
  readonly runId: string
  readonly threadId: string
  readonly prompt: string
  readonly target: HostRunEventTarget
}

export interface HostNodeMuseRunResult {
  readonly runId: string
  readonly status: HostProviderRunTerminalStatus
  readonly sessionId: string
  readonly exitCode: number | null
}

/** Presence-only projection for Host setup/provider inventory. */
export interface HostNodeMuseProviderStatus {
  readonly providerId: typeof MUSE_PROVIDER_ID
  readonly available: boolean
  readonly setupRequired: boolean
  readonly authState: 'authenticated' | 'missing'
  readonly binaryAvailable: boolean
  readonly credentialPresent: boolean
  readonly configured: boolean
  readonly checkedAt: string
}

export class HostNodeMuseProviderValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostNodeMuseProviderValidationError'
  }
}

export class HostNodeMuseProviderDuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Host Muse run already exists: ${runId}`)
    this.name = 'HostNodeMuseProviderDuplicateRunError'
  }
}

/** A durable port rejected an operation; callers must treat run state as unavailable. */
export class HostNodeMuseProviderPersistenceError extends Error {
  constructor(operation: string) {
    super(`Muse Host persistence operation failed: ${operation}`)
    this.name = 'HostNodeMuseProviderPersistenceError'
  }
}

type ResolvedMuseCredential =
  | { readonly present: false; readonly apiKey: null; readonly authJsonText: null }
  | { readonly present: true; readonly apiKey: string | null; readonly authJsonText: string | null }

type ActiveMuseRun = {
  cancelled: boolean
  cancellationPublished: boolean
  handle: MuseRunSpawnHandle | null
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SAFE_IDENTIFIER_MAX_CHARS &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function boundedText(value: unknown, limit: number, secretValues: readonly string[] = []): string {
  const raw = typeof value === 'string' ? value : ''
  let clean = raw
    .replace(UNSAFE_TEXT_CONTROLS, ' ')
    .replace(CREDENTIAL_VALUE_PATTERN, '$1[redacted]')
  for (const secret of secretValues) {
    if (secret) clean = clean.split(secret).join('[redacted]')
  }
  if (clean.length <= limit) return clean
  return `${clean.slice(0, Math.max(0, limit - 1))}…`
}

function boundedPrompt(value: unknown): string {
  if (!validateHostProviderRunPrompt(value)) {
    throw new HostNodeMuseProviderValidationError('Muse prompt must be bounded and control-free.')
  }
  return value
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usageFromOutcome(outcome: MuseRunOutcome): HostProviderRunUsage | undefined {
  const stats = outcome.providerStats
  const usage: HostProviderRunUsage = {
    ...(finiteNonNegative(stats.input_tokens) !== undefined
      ? { inputTokens: finiteNonNegative(stats.input_tokens) }
      : {}),
    ...(finiteNonNegative(stats.output_tokens) !== undefined
      ? { outputTokens: finiteNonNegative(stats.output_tokens) }
      : {}),
    ...(finiteNonNegative(stats.cache_read_input_tokens) !== undefined
      ? { cacheReadTokens: finiteNonNegative(stats.cache_read_input_tokens) }
      : {}),
    ...(finiteNonNegative(stats.cache_creation_input_tokens) !== undefined
      ? { cacheWriteTokens: finiteNonNegative(stats.cache_creation_input_tokens) }
      : {}),
    ...(finiteNonNegative(stats.total_cost_usd) !== undefined
      ? { estimatedCostUsd: finiteNonNegative(stats.total_cost_usd) }
      : {})
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function summarizeWarnings(warnings: readonly string[]): string[] {
  const summaries = new Set<string>()
  for (const warning of warnings) {
    const lower = String(warning).toLowerCase()
    const summary = lower.includes('stderr')
      ? 'Muse reported stderr during the run.'
      : lower.includes('session')
        ? 'Muse session-log data was unavailable or delayed.'
        : lower.includes('cron')
          ? 'Muse post-run cron verification reported a warning.'
          : lower.includes('cleanup')
            ? 'Muse isolated-home cleanup reported a warning.'
            : 'Muse reported a bounded provider warning.'
    summaries.add(boundedText(summary, HOST_PROVIDER_RUN_MAX_WARNING_CHARS))
    if (summaries.size >= HOST_PROVIDER_RUN_MAX_WARNING_COUNT) break
  }
  return [...summaries]
}

function terminalStatus(status: MuseRunOutcome['status']): HostProviderRunTerminalStatus {
  if (status === 'success') return 'completed'
  return status === 'cancelled' ? 'cancelled' : 'failed'
}

function errorCodeFor(
  status: HostProviderRunTerminalStatus
): HostProviderRunFinish['errorCode'] | undefined {
  return status === 'failed' ? 'provider_failed' : undefined
}

function apiKeyFromAuthJson(authJsonText: string): string | null {
  if (parseMuseAuthJsonCredential(authJsonText).credentialKind !== 'api-key') return null
  try {
    const parsed = JSON.parse(authJsonText) as { providers?: { meta?: { api_key?: unknown } } }
    const key = parsed.providers?.meta?.api_key
    return typeof key === 'string' && key.trim() ? key.trim() : null
  } catch {
    return null
  }
}

function credentialRedactionValues(credential: ResolvedMuseCredential): string[] {
  const values = credential.apiKey ? [credential.apiKey] : []
  if (!credential.authJsonText) return values
  try {
    const parsed = JSON.parse(credential.authJsonText) as {
      providers?: { meta?: { api_key?: unknown; access_token?: unknown } }
    }
    const meta = parsed.providers?.meta
    for (const value of [meta?.api_key, meta?.access_token]) {
      if (typeof value === 'string' && value.trim()) values.push(value.trim())
    }
  } catch {
    // Projection still redacts the whole auth document if a provider echoes it.
  }
  values.push(credential.authJsonText)
  return values
}

function validateConfiguredMuseThread(thread: HostProviderRunThread): HostProviderRunThread {
  const normalized = normalizeHostProviderRunThread(thread)
  if (!normalized)
    throw new HostNodeMuseProviderValidationError('Muse thread configuration is invalid.')
  if (!isCanonicalIdentifier(normalized.threadId)) {
    throw new HostNodeMuseProviderValidationError('Muse thread id is not canonical.')
  }
  if (normalized.providerId !== MUSE_PROVIDER_ID) {
    throw new HostNodeMuseProviderValidationError('Thread is not configured for Muse.')
  }
  if (!isCanonicalIdentifier(normalized.modelId)) {
    throw new HostNodeMuseProviderValidationError('Muse thread model is not configured.')
  }
  if (!isCanonicalIdentifier(normalized.workspace.workspaceId) || !normalized.workspace.canonical) {
    throw new HostNodeMuseProviderValidationError(
      'Muse workspace is not a canonical absolute directory.'
    )
  }
  if (
    !isCanonicalIdentifier(normalized.posture.postureId) ||
    !isCanonicalIdentifier(normalized.posture.approvalMode) ||
    (normalized.posture.requiresExplicitConsent && !normalized.posture.explicitConsentAcknowledged)
  ) {
    throw new HostNodeMuseProviderValidationError('Muse posture is not currently authorized.')
  }
  return normalized
}

/**
 * Node-only Muse adapter. It never depends on a client staying connected:
 * cancellation is registered by exact run id through the Host port instead.
 */
export class HostNodeMuseProvider {
  private readonly activeRuns = new Map<string, ActiveMuseRun>()
  private readonly runMuse: (input: MuseRunInput) => Promise<MuseRunOutcome>
  private readonly now: () => number
  private readonly createSessionId: () => string

  constructor(private readonly options: HostNodeMuseProviderOptions) {
    this.runMuse = options.runMuseProvider ?? runMuseProvider
    this.now = options.now ?? (() => Date.now())
    this.createSessionId = options.createSessionId ?? randomUUID
  }

  async getStatus(): Promise<HostNodeMuseProviderStatus> {
    const [binary, credential] = await Promise.all([
      this.options.resources.resolveBinary().catch(() => ({ binaryPath: null })),
      this.resolveCredential().catch(() => ({ present: false, apiKey: null, authJsonText: null }))
    ])
    return {
      providerId: MUSE_PROVIDER_ID,
      available: Boolean(binary.binaryPath),
      setupRequired: !binary.binaryPath || !credential.present,
      authState: credential.present ? 'authenticated' : 'missing',
      binaryAvailable: Boolean(binary.binaryPath),
      credentialPresent: credential.present,
      configured: Boolean(binary.binaryPath) && credential.present,
      checkedAt: this.isoNow()
    }
  }

  /** Exact run cancellation; closing a delivery target never calls this method. */
  cancel(runId: string): boolean {
    if (!isCanonicalIdentifier(runId)) return false
    const active = this.activeRuns.get(runId)
    if (!active || active.cancelled) return false
    active.cancelled = true
    if (active.handle) active.handle.kill('SIGTERM')
    return true
  }

  async run(request: HostNodeMuseRunRequest): Promise<HostNodeMuseRunResult> {
    if (!isCanonicalIdentifier(request.runId) || !isCanonicalIdentifier(request.threadId)) {
      throw new HostNodeMuseProviderValidationError('Muse run and thread ids must be canonical.')
    }
    if (this.activeRuns.has(request.runId))
      throw new HostNodeMuseProviderDuplicateRunError(request.runId)
    const prompt = boundedPrompt(request.prompt)
    let loadedThread: HostProviderRunThread | null
    try {
      loadedThread = this.options.runPort.getThread(request.threadId)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('getThread')
    }
    if (!loadedThread) throw new HostNodeMuseProviderValidationError('Muse thread was not found.')
    const thread = validateConfiguredMuseThread(loadedThread)
    const sessionId = this.sessionIdFor(thread)

    const startedAt = this.isoNow()
    const beginInput = normalizeHostProviderRunBegin({
      runId: request.runId,
      threadId: thread.threadId,
      providerId: MUSE_PROVIDER_ID,
      modelId: thread.modelId,
      startedAt
    })
    if (!beginInput) throw new HostNodeMuseProviderValidationError('Muse run start is invalid.')
    let begin
    try {
      begin = this.options.runPort.beginRun(beginInput)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('beginRun')
    }
    if (begin.kind === 'duplicate') throw new HostNodeMuseProviderDuplicateRunError(request.runId)

    const active: ActiveMuseRun = {
      cancelled: false,
      cancellationPublished: false,
      handle: null
    }
    this.activeRuns.set(request.runId, active)
    let finishCommitted = false
    let finishAttempted = false
    let cancelRegistered = false

    const finishOnce = (input: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>): void => {
      if (finishCommitted) return
      if (finishAttempted) {
        throw new HostNodeMuseProviderPersistenceError('finishRun')
      }
      const normalized = normalizeHostProviderRunFinish({
        runId: request.runId,
        finishedAt: this.isoNow(),
        ...input
      })
      if (!normalized) throw new HostNodeMuseProviderValidationError('Muse run finish is invalid.')
      finishAttempted = true
      try {
        this.options.runPort.finishRun(normalized)
      } catch {
        throw new HostNodeMuseProviderPersistenceError('finishRun')
      }
      finishCommitted = true
    }
    const publish = (event: HostProviderRunEvent): void => {
      this.publishRunEvent(request.target, event)
    }
    const publishCancelling = (): void => {
      if (!active.cancelled || active.cancellationPublished) return
      active.cancellationPublished = true
      this.updateRun({
        runId: request.runId,
        phase: 'cancelling',
        updatedAt: this.isoNow()
      })
    }

    try {
      this.appendTranscript({
        threadId: thread.threadId,
        runId: request.runId,
        role: 'user',
        text: prompt,
        createdAt: startedAt
      })
      this.appendTranscript({
        threadId: thread.threadId,
        runId: request.runId,
        role: 'system',
        text: 'Muse run started.',
        createdAt: startedAt
      })
      this.updateRun({
        runId: request.runId,
        phase: 'starting',
        updatedAt: startedAt
      })
      const registration = this.registerCancel(request.runId, () => {
        this.cancel(request.runId)
      })
      if (registration.kind !== 'registered') {
        throw new HostNodeMuseProviderPersistenceError('registerCancel')
      }
      cancelRegistered = true

      const [binary, credential] = await Promise.all([
        this.options.resources.resolveBinary(),
        this.resolveCredential()
      ])
      if (!binary.binaryPath || !credential.present) {
        const failure = !binary.binaryPath
          ? 'Muse binary is unavailable.'
          : 'Muse authentication is unavailable.'
        return this.finishPrelaunchFailure({
          request,
          thread,
          sessionId,
          finishOnce,
          publish,
          message: failure,
          errorCode: 'provider_setup_unavailable'
        })
      }

      publish({
        type: 'run.started',
        runId: request.runId,
        threadId: thread.threadId,
        providerId: MUSE_PROVIDER_ID,
        sessionId,
        at: this.isoNow()
      })
      publish({
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status: 'running',
        at: this.isoNow()
      })

      if (!this.options.resources.spawn && this.options.runMuseProvider === undefined) {
        return this.finishPrelaunchFailure({
          request,
          thread,
          sessionId,
          finishOnce,
          publish,
          message: 'Muse process spawn is unavailable.',
          errorCode: 'provider_launch_failed'
        })
      }
      const spawn = this.options.resources.spawn ?? unavailableMuseSpawn
      const outcome = await this.runMuse({
        binaryPath: binary.binaryPath,
        workspacePath: thread.workspace.canonicalPath,
        prompt,
        runId: request.runId,
        temporaryRoot: this.options.resources.getTemporaryRoot(),
        sessionId,
        model: thread.modelId,
        reasoningEffort: thread.reasoningId,
        approvalMode: thread.posture.approvalMode,
        apiKey: credential.apiKey,
        authJsonText: credential.authJsonText,
        spawn: (input) => {
          const handle = spawn(input)
          active.handle = handle
          if (active.cancelled) handle.kill('SIGTERM')
          return handle
        },
        shouldCancel: () => {
          publishCancelling()
          return active.cancelled
        },
        onEvent: (event) =>
          this.onMuseEvent(request, thread, active, event, credentialRedactionValues(credential))
      })

      const status = active.cancelled ? 'cancelled' : terminalStatus(outcome.status)
      const assistantText = boundedText(
        outcome.assistantText,
        HOST_PROVIDER_RUN_MAX_TEXT_CHARS,
        credentialRedactionValues(credential)
      )
      if (assistantText.trim()) {
        this.appendTranscript({
          threadId: thread.threadId,
          runId: request.runId,
          role: 'assistant',
          text: assistantText,
          createdAt: this.isoNow()
        })
      }
      const warningSummaries = summarizeWarnings(outcome.warnings)
      const usage = usageFromOutcome(outcome)
      finishOnce({
        status,
        providerSessionId: outcome.sessionId,
        ...(usage ? { usage } : {}),
        warningSummaries,
        ...(errorCodeFor(status) ? { errorCode: errorCodeFor(status) } : {})
      })
      publish({
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
        sessionId: outcome.sessionId,
        exitCode: outcome.exitCode
      }
    } catch (error) {
      if (error instanceof HostNodeMuseProviderPersistenceError) {
        if (!finishAttempted) {
          finishOnce({
            status: 'failed',
            warningSummaries: [],
            errorCode: 'provider_launch_failed'
          })
        }
        throw error
      }
      let transcriptFailure: unknown
      try {
        this.appendTranscript({
          threadId: thread.threadId,
          runId: request.runId,
          role: 'system',
          text: 'Muse run failed before completion.',
          createdAt: this.isoNow()
        })
      } catch (appendError) {
        transcriptFailure = appendError
      }
      finishOnce({ status: 'failed', warningSummaries: [], errorCode: 'provider_launch_failed' })
      publish({
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status: 'failed',
        at: this.isoNow()
      })
      if (transcriptFailure) throw transcriptFailure
      return { runId: request.runId, status: 'failed', sessionId, exitCode: null }
    } finally {
      try {
        if (cancelRegistered) this.clearCancel(request.runId)
      } finally {
        this.activeRuns.delete(request.runId)
      }
    }
  }

  private async resolveCredential(): Promise<ResolvedMuseCredential> {
    const fromEnv = this.options.resources.readMetaApiKeyEnv()
    if (typeof fromEnv === 'string' && fromEnv.trim()) {
      return { present: true, apiKey: fromEnv.trim(), authJsonText: null }
    }
    const authJsonText = await this.options.resources.readAuthJsonText()
    const evidence = parseMuseAuthJsonCredential(authJsonText)
    if (!evidence.present || !authJsonText) {
      return { present: false, apiKey: null, authJsonText: null }
    }
    if (evidence.credentialKind === 'api-key') {
      const apiKey = apiKeyFromAuthJson(authJsonText)
      return apiKey
        ? { present: true, apiKey, authJsonText: null }
        : { present: false, apiKey: null, authJsonText: null }
    }
    return { present: true, apiKey: null, authJsonText }
  }

  private sessionIdFor(thread: HostProviderRunThread): string {
    if (isMuseSessionUuid(thread.providerSessionId)) {
      return resolveMuseExecSessionId(thread.providerSessionId)
    }
    const created = this.createSessionId()
    if (!isMuseSessionUuid(created)) {
      throw new HostNodeMuseProviderValidationError(
        'Muse session id generator returned an invalid UUID.'
      )
    }
    return created
  }

  private finishPrelaunchFailure(input: {
    request: HostNodeMuseRunRequest
    thread: HostProviderRunThread
    sessionId: string
    finishOnce: (input: Omit<HostProviderRunFinish, 'runId' | 'finishedAt'>) => void
    publish: (event: HostProviderRunEvent) => void
    message: string
    errorCode: NonNullable<HostProviderRunFinish['errorCode']>
  }): HostNodeMuseRunResult {
    let transcriptFailure: unknown
    try {
      this.appendTranscript({
        threadId: input.thread.threadId,
        runId: input.request.runId,
        role: 'system',
        text: input.message,
        createdAt: this.isoNow()
      })
    } catch (error) {
      transcriptFailure = error
    }
    input.finishOnce({ status: 'failed', warningSummaries: [], errorCode: input.errorCode })
    input.publish({
      type: 'run.status',
      runId: input.request.runId,
      threadId: input.thread.threadId,
      status: 'failed',
      at: this.isoNow()
    })
    if (transcriptFailure) throw transcriptFailure
    return {
      runId: input.request.runId,
      status: 'failed',
      sessionId: input.sessionId,
      exitCode: null
    }
  }

  private onMuseEvent(
    request: HostNodeMuseRunRequest,
    thread: HostProviderRunThread,
    active: ActiveMuseRun,
    event: MuseExecNormalizedEvent,
    secretValues: readonly string[]
  ): void {
    if (event.type === 'content' && event.text) {
      this.updateRun({
        runId: request.runId,
        phase: 'streaming',
        updatedAt: this.isoNow()
      })
      this.publishRunEvent(request.target, {
        type: 'run.content',
        runId: request.runId,
        threadId: thread.threadId,
        text: boundedText(event.text, HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS, secretValues),
        at: this.isoNow()
      })
      return
    }
    if (event.type === 'tool_use' && isCanonicalIdentifier(event.toolId)) {
      this.publishRunEvent(request.target, {
        type: 'run.tool',
        runId: request.runId,
        threadId: thread.threadId,
        toolId: event.toolId,
        ...(isCanonicalIdentifier(event.toolName) ? { toolName: event.toolName } : {}),
        phase: 'started',
        at: this.isoNow()
      })
      return
    }
    if (event.type === 'tool_result' && isCanonicalIdentifier(event.toolId)) {
      this.publishRunEvent(request.target, {
        type: 'run.tool',
        runId: request.runId,
        threadId: thread.threadId,
        toolId: event.toolId,
        phase: 'finished',
        ...(event.toolStatus ? { status: event.toolStatus } : {}),
        at: this.isoNow()
      })
      return
    }
    if (active.cancelled) {
      this.updateRun({
        runId: request.runId,
        phase: 'cancelling',
        updatedAt: this.isoNow()
      })
    }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  private appendTranscript(input: Parameters<HostProviderRunPort['appendTranscript']>[0]): void {
    const normalized = normalizeHostProviderRunTranscriptAppend(input)
    if (!normalized)
      throw new HostNodeMuseProviderValidationError('Muse transcript append is invalid.')
    try {
      this.options.runPort.appendTranscript(normalized)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('appendTranscript')
    }
  }

  private updateRun(input: Parameters<HostProviderRunPort['updateRun']>[0]): void {
    const normalized = normalizeHostProviderRunUpdate(input)
    if (!normalized) throw new HostNodeMuseProviderValidationError('Muse run update is invalid.')
    try {
      this.options.runPort.updateRun(normalized)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('updateRun')
    }
  }

  private publishRunEvent(target: HostRunEventTarget, event: HostProviderRunEvent): void {
    const normalized = normalizeHostProviderRunEvent(event)
    if (!normalized) throw new HostNodeMuseProviderValidationError('Muse run event is invalid.')
    try {
      this.options.runPort.publishRunEvent(target, normalized)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('publishRunEvent')
    }
  }

  private registerCancel(runId: string, cancel: () => void) {
    try {
      return this.options.runPort.registerCancel(runId, cancel)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('registerCancel')
    }
  }

  private clearCancel(runId: string): void {
    try {
      this.options.runPort.clearCancel(runId)
    } catch {
      throw new HostNodeMuseProviderPersistenceError('clearCancel')
    }
  }
}

const unavailableMuseSpawn: MuseRunSpawn = () => {
  throw new HostNodeMuseProviderValidationError('Muse process spawn is unavailable.')
}
