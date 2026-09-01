/**
 * Pure-Node Kimi ACP provider adapter.
 *
 * Adapted from src/main/kimi/KimiAcpClient.ts:98-128 (ACP launch/stream lifecycle).
 * Desktop reuse is a named follow-up. This module intentionally imports no
 * Electron/main surfaces; provider permission prompts remain disabled until a
 * real one-shot HostNodeInteractionRegistry continuation is wired.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  HostProviderRunPort,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import {
  normalizeHostProviderRunPresentationText,
  normalizeHostProviderRunThread,
  validateHostProviderRunPrompt
} from '../host-runtime/HostProviderRunPort'
import {
  hostKimiManagedFallbackRows,
  hostProviderAuthFlows,
  hostProviderCatalogEntry,
  hostProviderKimiOffers,
  hostProviderOffers
} from '../host-shared/HostProviderCatalog'
import {
  discoverKimiManagedModelRows,
  type KimiManagedModelRow
} from '../host-shared/kimi/KimiManagedModelCatalog'
import { kimiExplicitCliModelAlias } from '../shared/kimiModels'
import { buildHostToolPresentation } from '../shared/hostToolPresentation'
import { estimateKimiAcpTokenUsage, kimiAcpVisiblePayloadChars } from '../host-shared/KimiAcpUsage'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import {
  createHostNodeProviderResourcePort,
  hostNodeProviderAuthFlows,
  hostNodeProviderAuthStatus,
  normalizeHostNodeProviderStatus,
  type HostNodeProviderResourcePort,
  type HostNodeProviderRuntimeStatus
} from './HostNodeProviderResources'
import type {
  HostNodeProvider,
  HostNodeProviderCreateInput,
  HostNodeProviderInstance,
  HostNodeProviderRunRequest,
  HostNodeProviderRunResult
} from './HostNodeProvider'
import {
  createHostAcpSessionConfigApplicator,
  hostAcpModelAndEffortSelections,
  readHostAcpAdvertisedConfigOptions
} from './HostNodeAcpSessionConfig'
import {
  createHostNodeAcpTurnCompletion,
  type HostNodeAcpTurnCompletion
} from './HostNodeAcpTurnCompletion'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import { meaningfulAcpStderrLine } from './HostNodeAcpStderr'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'

const PROVIDER_ID = 'kimi'
const PROVIDER_DISPLAY_NAME = 'Kimi'

type AcpSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    shell: false
    stdio: 'pipe'
  }
) => ChildProcessWithoutNullStreams

interface ActiveRun {
  readonly completion: HostNodeAcpTurnCompletion
  cancelled: boolean
}

export interface HostNodeKimiProviderOptions {
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: AcpSpawn
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  /** Non-secret configured-state probe; explicit resource auth wins when known. */
  readonly isConfigured?: () => boolean | Promise<boolean>
  /** Seat-isolated Kimi home used only to read credential-free model tables. */
  readonly kimiHome?: string
  /** Override managed-catalog discovery. `null` keeps the static Host fallback. */
  readonly discoverManagedModels?: (
    fallbackRows: readonly KimiManagedModelRow[]
  ) => Promise<KimiManagedModelRow[] | null>
}

function hasConfiguredKimiCredential(): boolean {
  if (['KIMI_API_KEY', 'MOONSHOT_API_KEY'].some((name) => Boolean(process.env[name]?.trim())))
    return true
  const configuredHome = join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
  return existsSync(configuredHome)
}

function timestamp(): string {
  return new Date().toISOString()
}

function safeOperationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- run ids and tool ids reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function acpArgs(thread: HostProviderRunThread): string[] {
  return ['--model', kimiExplicitCliModelAlias(thread.modelId), 'acp']
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function updateText(value: unknown): string {
  if (typeof value === 'string') return value
  const record = readObject(value)
  if (!record) return ''
  if (typeof record.text === 'string') return record.text
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        const item = readObject(part)
        return item && typeof item.text === 'string' ? item.text : ''
      })
      .join('')
  }
  return ''
}

function firstString(record: Record<string, unknown> | null, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function toolInput(
  update: Record<string, unknown>,
  tool: Record<string, unknown>
): Record<string, unknown> {
  for (const value of [
    tool.input,
    tool.rawInput,
    tool.arguments,
    tool.args,
    tool.parameters,
    tool.payload,
    update.input,
    update.rawInput,
    update.arguments,
    update.args,
    update.parameters,
    update.payload
  ]) {
    const record = readObject(value)
    if (record) return record
  }
  return {}
}

function toolOutput(update: Record<string, unknown>, tool: Record<string, unknown>): unknown {
  return (
    tool.output ?? tool.result ?? tool.content ?? update.output ?? update.result ?? update.content
  )
}

function providerModelIsSelectable(
  offers: HostProviderOffersProjection,
  thread: HostProviderRunThread
): boolean {
  const model = offers.models.find((candidate) => candidate.modelId === thread.modelId)
  return Boolean(
    model &&
    model.available &&
    (thread.reasoningId === undefined ||
      model.reasoning.some(
        (candidate) => candidate.reasoningId === thread.reasoningId && candidate.available
      ))
  )
}

function permissionOption(
  options: readonly { readonly optionId: string; readonly kind: string }[],
  decision: 'allow' | 'deny' | 'cancel'
): string | null {
  if (decision === 'cancel') return null
  const prefix = decision === 'allow' ? 'allow' : 'reject'
  const preferred = decision === 'allow' ? 'allow_once' : 'reject_once'
  return (
    options.find((option) => option.kind === preferred)?.optionId ??
    options.find((option) => option.kind.startsWith(prefix))?.optionId ??
    null
  )
}

function acpPermissionResponse(
  rpcId: string | number,
  options: readonly { readonly optionId: string; readonly kind: string }[],
  decision: 'allow' | 'deny' | 'cancel'
): Record<string, unknown> {
  const optionId = permissionOption(options, decision)
  return {
    jsonrpc: '2.0',
    id: rpcId,
    result:
      decision !== 'cancel' && optionId
        ? { outcome: 'selected', optionId }
        : { outcome: 'cancelled' }
  }
}

function interactionDecision(decision: string): 'allow' | 'deny' | 'cancel' {
  if (
    decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision === 'acceptForWorkspace'
  ) {
    return 'allow'
  }
  return decision === 'decline' ? 'deny' : 'cancel'
}

class HostNodeKimiProviderInstance implements HostNodeProviderInstance {
  readonly providerId = PROVIDER_ID
  private readonly activeRuns = new Map<string, ActiveRun>()
  private liveOffers: HostProviderOffersProjection

  constructor(
    private readonly runPort: HostProviderRunPort,
    private readonly interactions: HostNodeInteractionResolver,
    offers: HostProviderOffersProjection,
    private readonly options: HostNodeKimiProviderOptions
  ) {
    this.liveOffers = offers
  }

  async getOffers(): Promise<HostProviderOffersProjection> {
    const fallback = hostKimiManagedFallbackRows()
    let discovered: KimiManagedModelRow[] | null = null
    try {
      discovered = this.options.discoverManagedModels
        ? await this.options.discoverManagedModels(fallback)
        : await discoverKimiManagedModelRows(
            this.options.kimiHome ?? join(homedir(), '.kimi-code'),
            fallback
          )
    } catch {
      discovered = null
    }
    const gated = hostProviderKimiOffers(true, discovered)
    if (gated) this.liveOffers = gated
    return this.liveOffers
  }

  private get resources(): HostNodeProviderResourcePort {
    return this.options.resources ?? createHostNodeProviderResourcePort(PROVIDER_ID)
  }

  private async runtimeStatus(): Promise<HostNodeProviderRuntimeStatus> {
    const [resolved, resourceAuthState, version] = await Promise.all([
      this.resources.resolveBinary(),
      this.resources.getAuthState(),
      this.resources.getVersion()
    ])
    const configured =
      resourceAuthState === 'unknown'
        ? await (this.options.isConfigured?.() ?? hasConfiguredKimiCredential())
        : resourceAuthState === 'authenticated'
    const authState =
      resourceAuthState === 'unknown'
        ? configured
          ? 'authenticated'
          : 'unauthenticated'
        : resourceAuthState
    return {
      providerId: PROVIDER_ID,
      available: Boolean(resolved.binaryPath) && authState === 'authenticated',
      binaryAvailable: Boolean(resolved.binaryPath),
      authState,
      ...(version ? { version } : {}),
      ...(resolved.error ? { detail: resolved.error } : {})
    }
  }

  async getStatus(): Promise<HostProviderStatusProjection> {
    return normalizeHostNodeProviderStatus(PROVIDER_ID, await this.runtimeStatus())
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    return hostNodeProviderAuthStatus(PROVIDER_ID, await this.runtimeStatus())
  }

  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (!this.options.terminalLauncher) return []
    return hostNodeProviderAuthFlows(PROVIDER_ID, await this.runtimeStatus())
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!safeOperationId(operationId))
      throw new Error(PROVIDER_DISPLAY_NAME + ' auth operation is invalid.')
    const status = await this.runtimeStatus()
    if (!status.binaryAvailable || status.authState !== 'unauthenticated') {
      throw new Error(PROVIDER_DISPLAY_NAME + ' sign-in is not currently available.')
    }
    if (hostProviderAuthFlows(PROVIDER_ID).length === 0) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' has no manual sign-in flow.')
    }
    const binary = await this.resources.resolveBinary()
    if (!binary.binaryPath) throw new Error(PROVIDER_DISPLAY_NAME + ' CLI is unavailable.')
    const launcher = this.options.terminalLauncher
    if (!launcher) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' interactive terminal login is unavailable.')
    }
    // Handoff close is not authentication; getAuthStatus still probes credentials.
    await launcher.launchForProvider(PROVIDER_ID, { argv: [binary.binaryPath, 'login'] })
  }

  async cancelAuth(_operationId: string): Promise<boolean> {
    return false
  }

  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    if (!safeOperationId(request.runId) || !safeOperationId(request.threadId)) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' run identity is invalid.')
    }
    if (!validateHostProviderRunPrompt(request.prompt)) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' prompt must be bounded and control-free.')
    }
    const thread = normalizeHostProviderRunThread(this.runPort.getThread(request.threadId))
    const selectableOffers = await this.getOffers()
    if (
      !thread ||
      thread.providerId !== PROVIDER_ID ||
      !providerModelIsSelectable(selectableOffers, thread)
    ) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' thread configuration is not selectable.')
    }
    if (this.activeRuns.has(request.runId)) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' run already exists.')
    }

    const startedAt = timestamp()
    if (
      this.runPort.beginRun({
        runId: request.runId,
        threadId: thread.threadId,
        providerId: PROVIDER_ID,
        modelId: thread.modelId,
        startedAt
      }).kind !== 'started'
    ) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' run already exists.')
    }
    this.runPort.appendTranscript({
      threadId: thread.threadId,
      runId: request.runId,
      role: 'user',
      text: request.prompt,
      createdAt: startedAt
    })

    const resolved = await this.resources.resolveBinary()
    if (!resolved.binaryPath) {
      this.finishWithoutProcess(request, thread, 'provider_setup_unavailable')
      return { runId: request.runId, status: 'failed' }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.options.spawn
        ? this.options.spawn(resolved.binaryPath, acpArgs(thread), {
            cwd: thread.workspace.canonicalPath,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            shell: false,
            stdio: 'pipe'
          })
        : nodeSpawn(resolved.binaryPath, acpArgs(thread), {
            cwd: thread.workspace.canonicalPath,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            shell: false,
            stdio: 'pipe'
          })
    } catch {
      this.finishWithoutProcess(request, thread, 'provider_launch_failed')
      return { runId: request.runId, status: 'failed' }
    }

    return new Promise<HostNodeProviderRunResult>((resolve) => {
      let settled = false
      const requestedResumeSessionId = thread.providerSessionId
      let sessionId = requestedResumeSessionId ?? request.runId
      let carry = ''
      let promptSent = false
      let sessionRpcId = 2
      let resumeAttempted = false
      let promptText = request.prompt
      let kimiInputChars = request.prompt.length
      let kimiOutputChars = 0
      const resumeFallbackPrompt =
        request.resumeFallbackPrompt && validateHostProviderRunPrompt(request.resumeFallbackPrompt)
          ? request.resumeFallbackPrompt
          : undefined
      let assistantText = ''
      let failure = ''
      let stderrTail = ''
      const configWarnings: string[] = []
      let interactionSequence = 0
      const deliveredPermissionIds = new Set<string>()
      const completion = createHostNodeAcpTurnCompletion(child)
      const active: ActiveRun = { completion, cancelled: false }
      this.activeRuns.set(request.runId, active)

      const finish = (
        status: HostNodeProviderRunResult['status'],
        errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed'
      ): void => {
        if (settled) return
        settled = true
        completion.dispose()
        this.activeRuns.delete(request.runId)
        try {
          this.runPort.clearCancel(request.runId)
        } catch {
          failure = failure || 'Provider cancellation cleanup failed.'
        }
        const normalizedText = normalizeHostProviderRunPresentationText(assistantText)
        if (normalizedText) {
          this.runPort.appendTranscript({
            threadId: thread.threadId,
            runId: request.runId,
            role: 'assistant',
            text: normalizedText,
            createdAt: timestamp()
          })
        }
        const reason = failure || stderrTail
        const usageStats = estimateKimiAcpTokenUsage({
          inputChars: kimiInputChars,
          outputChars: kimiOutputChars,
          model: thread.modelId,
          durationMs: Date.now() - Date.parse(startedAt)
        })
        this.runPort.finishRun({
          runId: request.runId,
          status,
          finishedAt: timestamp(),
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          usage: {
            inputTokens: usageStats.input_tokens,
            outputTokens: usageStats.output_tokens
          },
          warningSummaries: [...configWarnings, ...(reason ? [reason.slice(0, 300)] : [])].slice(
            0,
            8
          ),
          ...(errorCode ? { errorCode } : {})
        })
        this.runPort.publishRunEvent(request.target, {
          type: 'run.status',
          runId: request.runId,
          threadId: thread.threadId,
          status,
          at: timestamp(),
          ...(configWarnings.length || reason ? { warningCount: 1 } : {})
        })
        resolve({ runId: request.runId, status, ...(sessionId ? { sessionId } : {}) })
      }

      const write = (id: number, method: string, params: Record<string, unknown>): void => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }
      const sendNewSession = (fallback: boolean): void => {
        sessionRpcId = fallback ? 4 : 2
        resumeAttempted = false
        sessionId = ''
        if (fallback && resumeFallbackPrompt) {
          promptText = resumeFallbackPrompt
          kimiInputChars = promptText.length
        }
        write(sessionRpcId, 'session/new', {
          cwd: thread.workspace.canonicalPath,
          mcpServers: []
        })
      }
      const sendPrompt = (): void => {
        if (promptSent) return
        promptSent = true
        write(3, 'session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: promptText }]
        })
      }
      const sessionConfig = createHostAcpSessionConfigApplicator({
        write,
        onWarning: (text) => configWarnings.push(text.slice(0, 300)),
        onComplete: sendPrompt
      })
      const applySessionConfig = (result: unknown): void => {
        const desiredModel = kimiExplicitCliModelAlias(thread.modelId)
        const advertised = readHostAcpAdvertisedConfigOptions(result)
        const modelOption = advertised.find((option) => option.id === 'model')
        if (
          modelOption &&
          modelOption.values.length > 0 &&
          !modelOption.values.includes(desiredModel)
        ) {
          failure =
            'Kimi ACP session does not offer selected model "' +
            desiredModel +
            '"; refusing to fall back to another alias.'
          completion.requestStop()
          return
        }
        sessionConfig.begin({
          sessionId,
          result,
          selections: hostAcpModelAndEffortSelections({
            modelValue: desiredModel,
            reasoningId: thread.reasoningId
          })
        })
      }
      const publishText = (value: string): void => {
        const text = normalizeHostProviderRunPresentationText(value)
        if (!text) return
        assistantText += text
        kimiOutputChars += text.length
        this.runPort.updateRun({ runId: request.runId, phase: 'streaming', updatedAt: timestamp() })
        this.runPort.publishRunEvent(request.target, {
          type: 'run.content',
          runId: request.runId,
          threadId: thread.threadId,
          text,
          at: timestamp()
        })
      }
      const publishTool = (
        update: Record<string, unknown>,
        phase: 'started' | 'finished',
        status?: 'success' | 'error'
      ): void => {
        const tool = readObject(update.toolCall) ?? update
        const toolId =
          firstString(update, ['toolCallId', 'toolCallID', 'toolId', 'id']) ||
          firstString(tool, ['toolCallId', 'toolCallID', 'toolId', 'id'])
        if (!safeOperationId(toolId)) return
        const toolName =
          firstString(tool, ['name', 'toolName', 'title', 'kind']) ||
          firstString(update, ['toolName', 'title', 'kind'])
        const input = toolInput(update, tool)
        const output = toolOutput(update, tool)
        const details = buildHostToolPresentation({ toolName, input, output })
        if (phase === 'started') {
          kimiOutputChars += toolName.length + kimiAcpVisiblePayloadChars(input)
        } else {
          kimiInputChars += kimiAcpVisiblePayloadChars(output)
        }
        this.runPort.publishRunEvent(request.target, {
          type: 'run.tool',
          runId: request.runId,
          threadId: thread.threadId,
          toolId,
          ...(toolName ? { toolName } : {}),
          ...(details.file ? { file: details.file } : {}),
          ...(details.additions !== undefined ? { additions: details.additions } : {}),
          ...(details.deletions !== undefined ? { deletions: details.deletions } : {}),
          ...(details.diff ? { diff: details.diff } : {}),
          ...(details.command ? { command: details.command } : {}),
          phase,
          ...(status ? { status } : {}),
          at: timestamp()
        })
      }
      const handlePermissionRequest = (frame: Record<string, unknown>): void => {
        const rpcId = frame.id
        if (typeof rpcId !== 'string' && typeof rpcId !== 'number') return
        const params = readObject(frame.params)
        const toolCall = readObject(params?.toolCall)
        if (toolCall) publishTool({ ...toolCall }, 'started')
        const title =
          (typeof toolCall?.title === 'string' && toolCall.title.trim().slice(0, 200)) ||
          (typeof toolCall?.kind === 'string' && toolCall.kind.trim().slice(0, 200)) ||
          'Provider tool permission'
        const options = Array.isArray(params?.options)
          ? params.options
              .map((entry) => readObject(entry))
              .flatMap((entry) => {
                const optionId = typeof entry?.optionId === 'string' ? entry.optionId : ''
                const kind = typeof entry?.kind === 'string' ? entry.kind : ''
                return safeOperationId(optionId) && safeOperationId(kind)
                  ? [{ optionId, kind }]
                  : []
              })
              .slice(0, 16)
          : []
        const interactionId =
          PROVIDER_ID + ':' + request.runId + ':approval:' + ++interactionSequence
        const deliver = (decision: 'allow' | 'deny' | 'cancel'): void => {
          if (settled || deliveredPermissionIds.has(interactionId)) return
          deliveredPermissionIds.add(interactionId)
          try {
            child.stdin.write(
              JSON.stringify(acpPermissionResponse(rpcId, options, decision)) + '\n'
            )
          } catch {
            failure = failure || 'ACP permission response could not be delivered.'
          }
        }
        void this.interactions
          .register({
            id: interactionId,
            kind: 'approval',
            providerId: PROVIDER_ID,
            runId: request.runId,
            threadId: thread.threadId,
            ...(typeof toolCall?.id === 'string' && safeOperationId(toolCall.id)
              ? { toolId: toolCall.id }
              : {}),
            title,
            summary: 'Provider requested permission for ' + title + '.',
            options: options.map((option) => option.optionId),
            createdAt: timestamp()
          })
          .then((settlement) => deliver(interactionDecision(settlement.decision)))
          .catch(() => deliver('cancel'))
      }

      const handleFrame = (frame: Record<string, unknown>): void => {
        if (frame.method === 'session/request_permission') {
          handlePermissionRequest(frame)
          return
        }
        if (frame.id === 1 && frame.result) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n'
          )
          if (requestedResumeSessionId) {
            resumeAttempted = true
            sessionRpcId = 2
            write(2, 'session/resume', {
              sessionId: requestedResumeSessionId,
              cwd: thread.workspace.canonicalPath,
              mcpServers: []
            })
          } else {
            sendNewSession(false)
          }
          return
        }
        if (frame.id === sessionRpcId && frame.result) {
          const result = readObject(frame.result)
          if (resumeAttempted) {
            sessionId = requestedResumeSessionId ?? ''
            resumeAttempted = false
          } else {
            const session =
              result &&
              (typeof result.sessionId === 'string'
                ? result.sessionId
                : typeof readObject(result.session)?.id === 'string'
                  ? String(readObject(result.session)?.id)
                  : '')
            if (session) sessionId = session
          }
          if (!sessionId) {
            failure = 'Kimi ACP did not return a session identity.'
            completion.requestStop()
            return
          }
          applySessionConfig(frame.result)
          return
        }
        if (sessionConfig.acceptFrame(frame)) return
        if (completion.acceptPromptResult(frame)) return
        if (frame.error && resumeAttempted && frame.id === 2) {
          // A missing/expired native session is recoverable: mint a fresh
          // session and explicitly carry the bounded Host transcript context.
          sendNewSession(true)
          return
        }
        if (frame.error && frame.id === sessionRpcId) {
          const error = readObject(frame.error)
          failure =
            typeof error?.message === 'string'
              ? error.message
              : 'Kimi ACP session setup was rejected.'
          completion.requestStop()
          return
        }
        if (frame.id === 3 && frame.error) {
          const error = readObject(frame.error)
          failure = typeof error?.message === 'string' ? error.message : 'ACP prompt was rejected.'
          completion.requestStop()
          return
        }
        if (frame.method !== 'session/update') return
        const params = readObject(frame.params)
        const update = readObject(params?.update)
        if (!update) return
        const kind = String(update.sessionUpdate ?? update.type ?? '')
        if (/agent_message|assistant_message/i.test(kind))
          publishText(updateText(update.content ?? update))
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          const rawStatus = firstString(update, ['status']).toLowerCase()
          const terminal = rawStatus === 'completed' || rawStatus === 'failed'
          publishTool(
            update,
            terminal ? 'finished' : 'started',
            terminal ? (rawStatus === 'failed' ? 'error' : 'success') : undefined
          )
        }
      }
      const consume = (chunk: Buffer | string): void => {
        carry += String(chunk)
        const lines = carry.split(/\r?\n/)
        carry = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            const frame = readObject(parsed)
            if (frame) handleFrame(frame)
          } catch {
            // ACP is JSON-RPC over NDJSON; ordinary stderr remains non-authoritative.
          }
        }
      }

      child.stdout.on('data', consume)
      child.stderr.on('data', (chunk: Buffer | string) => {
        // A protocol failure outranks stderr; telemetry and Sentry chatter
        // never become the recorded reason.
        const line = meaningfulAcpStderrLine(String(chunk))
        if (line) stderrTail = line
      })
      child.once('error', (error) => {
        failure = error instanceof Error ? error.message : 'ACP process failed.'
        completion.requestStop()
      })
      child.once('close', () => {
        const status = active.cancelled
          ? 'cancelled'
          : (completion.promptOutcome()?.status ?? 'failed')
        finish(status, status === 'failed' ? 'provider_failed' : undefined)
      })

      const registration = this.runPort.registerCancel(request.runId, () => {
        active.cancelled = true
        this.runPort.updateRun({
          runId: request.runId,
          phase: 'cancelling',
          updatedAt: timestamp()
        })
        completion.requestStop()
      })
      if (registration.kind !== 'registered') {
        failure = 'Host could not register exact cancellation.'
        completion.requestStop()
        return
      }

      this.runPort.publishRunEvent(request.target, {
        type: 'run.started',
        runId: request.runId,
        threadId: thread.threadId,
        providerId: PROVIDER_ID,
        sessionId,
        at: timestamp()
      })
      this.runPort.publishRunEvent(request.target, {
        type: 'run.status',
        runId: request.runId,
        threadId: thread.threadId,
        status: 'running',
        at: timestamp()
      })
      this.runPort.updateRun({ runId: request.runId, phase: 'starting', updatedAt: timestamp() })
      write(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'taskwraith-host', version: 'node-host-v1' }
      })
    })
  }

  private finishWithoutProcess(
    request: HostNodeProviderRunRequest,
    thread: HostProviderRunThread,
    errorCode: 'provider_setup_unavailable' | 'provider_launch_failed'
  ): void {
    this.runPort.finishRun({
      runId: request.runId,
      status: 'failed',
      finishedAt: timestamp(),
      warningSummaries: [],
      errorCode
    })
    this.runPort.publishRunEvent(request.target, {
      type: 'run.status',
      runId: request.runId,
      threadId: thread.threadId,
      status: 'failed',
      at: timestamp()
    })
  }

  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) return false
    active.cancelled = true
    active.completion.requestStop()
    return true
  }

  async shutdown(): Promise<void> {
    for (const [runId] of this.activeRuns) this.cancel(runId)
  }
}

export function createHostNodeKimiProvider(
  options: HostNodeKimiProviderOptions = {}
): HostNodeProvider {
  const entry = hostProviderCatalogEntry(PROVIDER_ID)
  const offers = hostProviderOffers(PROVIDER_ID, true)
  if (!entry || !offers) throw new Error(PROVIDER_DISPLAY_NAME + ' catalog is unavailable.')
  return {
    providerId: PROVIDER_ID,
    displayProvider: entry.displayProvider,
    shortCode: entry.shortCode,
    offers,
    supportsApprovals: true,
    // Keep false: live kimi-cli 1.47.0 ACP schema v0.10.8 CLIENT_METHODS has no
    // elicitation/create; kimi_cli/wire `_request_question` is the TUI wire protocol, not ACP.
    supportsQuestions: false,
    create(input: HostNodeProviderCreateInput): HostNodeProviderInstance {
      return new HostNodeKimiProviderInstance(input.runPort, input.interactions, offers, options)
    }
  }
}
