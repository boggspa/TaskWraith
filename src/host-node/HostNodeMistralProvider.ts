/**
 * Pure-Node Mistral ACP provider adapter.
 *
 * Adapted from src/main/mistral/MistralAcpClient.ts:431-486 (ACP launch/stream lifecycle).
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
  hostProviderAuthFlows,
  hostProviderCatalogEntry,
  hostProviderOffers
} from '../host-shared/HostProviderCatalog'
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
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'
import { resolveMistralCredentialLaunch } from '../main/mistral/MistralCredentialLane'

const PROVIDER_ID = 'mistral'
const PROVIDER_DISPLAY_NAME = 'Mistral'

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
  readonly child: ChildProcessWithoutNullStreams
  cancelled: boolean
}

export interface HostNodeMistralProviderOptions {
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: AcpSpawn
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  /** Non-secret configured-state probe; explicit resource auth wins when known. */
  readonly isConfigured?: () => boolean | Promise<boolean>
  /** Dependency-injected launch environment; production inherits process.env. */
  readonly environment?: NodeJS.ProcessEnv
}

function hasConfiguredMistralCredential(environment: NodeJS.ProcessEnv): boolean {
  if (['MISTRAL_API_KEY'].some((name) => Boolean(environment[name]?.trim()))) return true
  const configuredHome = join(homedir(), '.vibe', 'config.toml')
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
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function acpArgs(thread: HostProviderRunThread): string[] {
  void thread
  return []
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

class HostNodeMistralProviderInstance implements HostNodeProviderInstance {
  readonly providerId = PROVIDER_ID
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(
    private readonly runPort: HostProviderRunPort,
    private readonly interactions: HostNodeInteractionResolver,
    private readonly offers: HostProviderOffersProjection,
    private readonly options: HostNodeMistralProviderOptions
  ) {}

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
        ? await (this.options.isConfigured?.() ??
            hasConfiguredMistralCredential(this.options.environment ?? process.env))
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
    if (
      !thread ||
      thread.providerId !== PROVIDER_ID ||
      !providerModelIsSelectable(this.offers, thread)
    ) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' thread configuration is not selectable.')
    }
    if (this.activeRuns.has(request.runId)) {
      throw new Error(PROVIDER_DISPLAY_NAME + ' run already exists.')
    }

    const credentialLaunch = resolveMistralCredentialLaunch({
      model: thread.modelId,
      resolvedEnv: {
        ...(this.options.environment ?? process.env),
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      },
      storedApiKeyPresent: false,
      // On a paired host the configured process environment is the explicit
      // BYOK source; there is no desktop encrypted-key store to consult.
      ambientApiKeyAllowed: true
    })
    if (credentialLaunch.missingApiKey) {
      throw new Error(
        `${PROVIDER_DISPLAY_NAME} model ${thread.modelId} requires MISTRAL_API_KEY; choose Devstral Small / Mistral Medium 3.5 to use Vibe instead.`
      )
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
            env: credentialLaunch.childEnv,
            shell: false,
            stdio: 'pipe'
          })
        : nodeSpawn(resolved.binaryPath, acpArgs(thread), {
            cwd: thread.workspace.canonicalPath,
            env: credentialLaunch.childEnv,
            shell: false,
            stdio: 'pipe'
          })
    } catch {
      this.finishWithoutProcess(request, thread, 'provider_launch_failed')
      return { runId: request.runId, status: 'failed' }
    }

    return new Promise<HostNodeProviderRunResult>((resolve) => {
      let settled = false
      let sessionId = thread.providerSessionId ?? request.runId
      let carry = ''
      let promptSent = false
      let assistantText = ''
      let failure = ''
      let interactionSequence = 0
      const deliveredPermissionIds = new Set<string>()
      const active: ActiveRun = { child, cancelled: false }
      this.activeRuns.set(request.runId, active)

      const finish = (
        status: HostNodeProviderRunResult['status'],
        errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed'
      ): void => {
        if (settled) return
        settled = true
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
        this.runPort.finishRun({
          runId: request.runId,
          status,
          finishedAt: timestamp(),
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          warningSummaries: failure ? [failure.slice(0, 300)] : [],
          ...(errorCode ? { errorCode } : {})
        })
        this.runPort.publishRunEvent(request.target, {
          type: 'run.status',
          runId: request.runId,
          threadId: thread.threadId,
          status,
          at: timestamp(),
          ...(failure ? { warningCount: 1 } : {})
        })
        resolve({ runId: request.runId, status, ...(sessionId ? { sessionId } : {}) })
      }

      const write = (id: number, method: string, params: Record<string, unknown>): void => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }
      const sendPrompt = (): void => {
        if (promptSent) return
        promptSent = true
        write(3, 'session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: request.prompt }]
        })
      }
      const publishText = (value: string): void => {
        const text = normalizeHostProviderRunPresentationText(value)
        if (!text) return
        assistantText += text
        this.runPort.updateRun({ runId: request.runId, phase: 'streaming', updatedAt: timestamp() })
        this.runPort.publishRunEvent(request.target, {
          type: 'run.content',
          runId: request.runId,
          threadId: thread.threadId,
          text,
          at: timestamp()
        })
      }
      const handlePermissionRequest = (frame: Record<string, unknown>): void => {
        const rpcId = frame.id
        if (typeof rpcId !== 'string' && typeof rpcId !== 'number') return
        const params = readObject(frame.params)
        const toolCall = readObject(params?.toolCall)
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
          write(2, 'session/new', {
            cwd: thread.workspace.canonicalPath,
            mcpServers: [],
            configOptions: [
              { configId: 'model', value: thread.modelId },
              ...(thread.reasoningId ? [{ configId: 'reasoning', value: thread.reasoningId }] : [])
            ]
          })
          return
        }
        if (frame.id === 2 && frame.result) {
          const result = readObject(frame.result)
          const session =
            result &&
            (typeof result.sessionId === 'string'
              ? result.sessionId
              : typeof readObject(result.session)?.id === 'string'
                ? String(readObject(result.session)?.id)
                : '')
          if (session) sessionId = session
          sendPrompt()
          return
        }
        if (frame.id === 3 && frame.error) {
          const error = readObject(frame.error)
          failure = typeof error?.message === 'string' ? error.message : 'ACP prompt was rejected.'
          try {
            child.kill('SIGTERM')
          } catch {
            finish('failed', 'provider_failed')
          }
          return
        }
        if (frame.method !== 'session/update') return
        const params = readObject(frame.params)
        const update = readObject(params?.update)
        if (!update) return
        const kind = String(update.sessionUpdate ?? update.type ?? '')
        if (/agent_message|assistant_message/i.test(kind))
          publishText(updateText(update.content ?? update))
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
        const text = normalizeHostProviderRunPresentationText(String(chunk), 300)
        if (text) failure = text
      })
      child.once('error', (error) => {
        failure = error instanceof Error ? error.message : 'ACP process failed.'
        finish('failed', 'provider_launch_failed')
      })
      child.once('close', (code) => {
        finish(
          active.cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed',
          code === 0 ? undefined : 'provider_failed'
        )
      })

      const registration = this.runPort.registerCancel(request.runId, () => {
        active.cancelled = true
        this.runPort.updateRun({
          runId: request.runId,
          phase: 'cancelling',
          updatedAt: timestamp()
        })
        try {
          child.stdin.end()
        } catch {
          child.kill('SIGTERM')
        }
      })
      if (registration.kind !== 'registered') {
        failure = 'Host could not register exact cancellation.'
        active.cancelled = true
        try {
          child.kill('SIGTERM')
        } catch {
          finish('failed', 'provider_launch_failed')
        }
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
    try {
      active.child.stdin.end()
    } catch {
      active.child.kill('SIGTERM')
    }
    return true
  }

  async shutdown(): Promise<void> {
    for (const [runId] of this.activeRuns) this.cancel(runId)
  }
}

export function createHostNodeMistralProvider(
  options: HostNodeMistralProviderOptions = {}
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
    supportsQuestions: false,
    create(input: HostNodeProviderCreateInput): HostNodeProviderInstance {
      return new HostNodeMistralProviderInstance(input.runPort, input.interactions, offers, options)
    }
  }
}
