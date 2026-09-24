/**
 * Pure-Node Codex app-server provider adapter.
 *
 * Adapted from src/main/CodexAppServerClient.ts:877-924 and
 * src/main/index.ts:32319-32345. Desktop reuse is a named follow-up. This
 * module owns a short-lived Node-only app-server session; it never imports the
 * Electron/main client or advertises approvals without a real continuation.
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
  resolveCodexSandboxControls,
  type CodexSandboxControls
} from '../shared/codexSandboxControls'
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
import { hostNodeProviderEnvironment } from './HostNodeProviderEnvironment'

const PROVIDER_ID = 'codex'

type CodexSpawn = (
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
  threadId: string
  turnId?: string
  cancelled: boolean
}

export interface HostNodeCodexProviderOptions {
  readonly resources?: HostNodeProviderResourcePort
  readonly spawn?: CodexSpawn
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  /** Non-secret configured-state probe; explicit resource auth wins when known. */
  readonly isConfigured?: () => boolean | Promise<boolean>
}

function hasConfiguredCodexCredential(): boolean {
  if (['OPENAI_API_KEY'].some((name) => Boolean(process.env[name]?.trim()))) return true
  const configuredHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return existsSync(join(configuredHome, 'auth.json'))
}

function timestamp(): string {
  return new Date().toISOString()
}

function safeOperationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- provider ids reject C0 controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  const record = readObject(value)
  if (!record) return ''
  if (typeof record.text === 'string') return record.text
  if (typeof record.delta === 'string') return record.delta
  if (typeof record.content === 'string') return record.content
  return ''
}

function modelIsSelectable(
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

export interface HostNodeCodexPostureControls extends CodexSandboxControls {
  readonly approvalPolicy: 'on-request' | 'never'
}

/**
 * Exact standalone Codex posture mapping. Plan disables mutations without
 * manufacturing approval cards; Ask retains interactive approval; Full WS and
 * verified Full Access deliberately suppress provider prompts inside their
 * respective workspace / host-wide boundaries.
 */
export function resolveHostNodeCodexPosture(
  thread: Pick<HostProviderRunThread, 'workspace' | 'posture'>
): HostNodeCodexPostureControls {
  const requestsFullAccess =
    thread.posture.postureId === 'full_access' || thread.posture.approvalMode === 'full_access'
  const verifiedFullAccess =
    thread.posture.postureId === 'full_access' &&
    thread.posture.approvalMode === 'auto_edit' &&
    thread.posture.requiresExplicitConsent === true &&
    thread.posture.explicitConsentAcknowledged === true &&
    thread.posture.verifiedConsent?.authority === 'host-signed'
  const readOnly =
    thread.posture.postureId === 'read_only' ||
    thread.posture.postureId === 'plan' ||
    thread.posture.approvalMode === 'plan'
  const root = thread.workspace.canonicalPath
  const failClosedFullRequest = requestsFullAccess && !verifiedFullAccess
  const sandboxControls = resolveCodexSandboxControls({
    planMode: thread.posture.postureId === 'plan',
    fullAccessGranted: verifiedFullAccess,
    allowNativeWorkspaceWrite: !readOnly && !failClosedFullRequest,
    readableRoots: [root],
    writableRoots: [root],
    networkAccess: false
  })
  const approvalPolicy = verifiedFullAccess
    ? 'never'
    : failClosedFullRequest
      ? 'on-request'
      : thread.posture.postureId === 'plan' || thread.posture.postureId === 'workspace_write'
        ? 'never'
        : 'on-request'
  return {
    approvalPolicy,
    ...sandboxControls
  }
}

function interactionDecision(decision: string): 'accept' | 'decline' {
  return decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision === 'acceptForWorkspace'
    ? 'accept'
    : 'decline'
}

function isCodexQuestionMethod(method: string): boolean {
  return (
    method === 'mcpServer/elicitation/request' ||
    method === 'mcp/elicitation/request' ||
    method === 'tool/requestUserInput'
  )
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function firstQuestion(params: Record<string, unknown> | null): Record<string, unknown> | null {
  return Array.isArray(params?.questions) ? readObject(params.questions[0]) : null
}

function questionOptions(params: Record<string, unknown> | null): readonly string[] | undefined {
  const collected: string[] = []
  const seen = new Set<string>()
  const push = (raw: unknown): void => {
    if (collected.length >= 16) return
    const rec = readObject(raw)
    const label = boundedText(
      typeof raw === 'string' ? raw : (rec?.label ?? rec?.id ?? rec?.value),
      512
    )
    // eslint-disable-next-line no-control-regex -- provider option labels reject C0 controls.
    if (!label || seen.has(label) || /[\u0000-\u001f\u007f]/.test(label)) return
    seen.add(label)
    collected.push(label)
  }
  if (Array.isArray(params?.options)) {
    for (const option of params.options) push(option)
  }
  const question = firstQuestion(params)
  if (Array.isArray(question?.options)) {
    for (const option of question.options) push(option)
  }
  const schema = readObject(params?.requestedSchema) ?? readObject(params?.schema)
  const properties = readObject(schema?.properties)
  if (properties) {
    for (const prop of Object.values(properties)) {
      const rec = readObject(prop)
      if (Array.isArray(rec?.enum)) {
        for (const option of rec.enum) push(option)
      }
    }
  }
  return collected.length > 0 ? collected : undefined
}

function questionPresentation(
  method: string,
  params: Record<string, unknown> | null
): { title: string; summary: string; options?: readonly string[] } {
  const question = firstQuestion(params)
  const title =
    boundedText(params?.title, 200) ||
    boundedText(params?.message, 200) ||
    boundedText(question?.question, 200) ||
    boundedText(params?.header, 200) ||
    boundedText(question?.header, 200) ||
    boundedText(question?.title, 200) ||
    boundedText(params?.name, 200) ||
    (method === 'tool/requestUserInput' ? 'Codex question' : 'Codex elicitation')
  const summary =
    boundedText(params?.message, 1000) ||
    boundedText(question?.question, 1000) ||
    boundedText(params?.prompt, 1000) ||
    boundedText(question?.context, 1000) ||
    (method === 'tool/requestUserInput'
      ? 'Codex requested user input: ' + title + '.'
      : 'Codex requested elicitation for ' + title + '.')
  const options = questionOptions(params)
  return options ? { title, summary, options } : { title, summary }
}

function codexApprovalResponse(decision: 'accept' | 'decline'): Record<string, unknown> {
  return { decision }
}

function codexQuestionResult(
  method: string,
  settlement: { readonly decision: string; readonly answer?: string } | null
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const answered = settlement?.decision === 'answer'
  const answer = typeof settlement?.answer === 'string' ? settlement.answer : ''
  if (method === 'tool/requestUserInput') {
    if (!answered) {
      return { error: { code: -32000, message: 'User dismissed Codex input request.' } }
    }
    return { result: { answers: { default: answer } } }
  }
  return {
    result: {
      action: answered ? 'accept' : 'decline',
      content: answered ? answer : null,
      _meta: null
    }
  }
}

class HostNodeCodexProviderInstance implements HostNodeProviderInstance {
  readonly providerId = PROVIDER_ID
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(
    private readonly runPort: HostProviderRunPort,
    private readonly interactions: HostNodeInteractionResolver,
    private readonly offers: HostProviderOffersProjection,
    private readonly options: HostNodeCodexProviderOptions
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
        ? await (this.options.isConfigured?.() ?? hasConfiguredCodexCredential())
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
    if (!safeOperationId(operationId)) throw new Error('Codex auth operation is invalid.')
    const status = await this.runtimeStatus()
    if (!status.binaryAvailable || status.authState !== 'unauthenticated') {
      throw new Error('Codex sign-in is not currently available.')
    }
    if (hostProviderAuthFlows(PROVIDER_ID).length === 0) {
      throw new Error('Codex has no manual sign-in flow.')
    }
    const binary = await this.resources.resolveBinary()
    if (!binary.binaryPath) throw new Error('Codex CLI is unavailable.')
    const launcher = this.options.terminalLauncher
    if (!launcher) {
      throw new Error('Codex interactive terminal login is unavailable.')
    }
    // Handoff close is not authentication; getAuthStatus still probes credentials.
    await launcher.launchForProvider(PROVIDER_ID, { argv: [binary.binaryPath, 'login'] })
  }

  async cancelAuth(_operationId: string): Promise<boolean> {
    return false
  }

  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    if (!safeOperationId(request.runId) || !safeOperationId(request.threadId)) {
      throw new Error('Codex run identity is invalid.')
    }
    if (!validateHostProviderRunPrompt(request.prompt)) {
      throw new Error('Codex prompt must be bounded and control-free.')
    }
    const thread = normalizeHostProviderRunThread(this.runPort.getThread(request.threadId))
    if (!thread || thread.providerId !== PROVIDER_ID || !modelIsSelectable(this.offers, thread)) {
      throw new Error('Codex thread configuration is not selectable.')
    }
    if (this.activeRuns.has(request.runId)) throw new Error('Codex run already exists.')

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
      throw new Error('Codex run already exists.')
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
      this.finishRun(
        request,
        thread,
        thread.providerSessionId,
        'failed',
        '',
        'provider_setup_unavailable'
      )
      return { runId: request.runId, status: 'failed' }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.options.spawn
        ? this.options.spawn(resolved.binaryPath, ['app-server'], {
            cwd: thread.workspace.canonicalPath,
            env: hostNodeProviderEnvironment(process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
            shell: false,
            stdio: 'pipe'
          })
        : nodeSpawn(resolved.binaryPath, ['app-server'], {
            cwd: thread.workspace.canonicalPath,
            env: hostNodeProviderEnvironment(process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
            shell: false,
            stdio: 'pipe'
          })
    } catch {
      this.finishRun(
        request,
        thread,
        thread.providerSessionId,
        'failed',
        '',
        'provider_launch_failed'
      )
      return { runId: request.runId, status: 'failed' }
    }

    return new Promise<HostNodeProviderRunResult>((resolve) => {
      let settled = false
      let providerThreadId = thread.providerSessionId ?? ''
      let assistantText = ''
      let failure = ''
      let carry = ''
      let interactionSequence = 0
      const deliveredApprovalIds = new Set<string>()
      const active: ActiveRun = {
        child,
        threadId: providerThreadId || thread.threadId,
        cancelled: false
      }
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
          failure = failure || 'Codex cancellation cleanup failed.'
        }
        this.finishRun(
          request,
          thread,
          providerThreadId || undefined,
          status,
          assistantText,
          errorCode,
          failure
        )
        resolve({
          runId: request.runId,
          status,
          ...(providerThreadId ? { sessionId: providerThreadId } : {})
        })
      }
      const write = (id: number, method: string, params: Record<string, unknown>): void => {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      }
      const posture = resolveHostNodeCodexPosture(thread)
      const startTurn = (): void => {
        if (!providerThreadId) {
          failure = 'Codex app-server returned no thread identity.'
          finish('failed', 'provider_launch_failed')
          return
        }
        active.threadId = providerThreadId
        write(3, 'turn/start', {
          threadId: providerThreadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          cwd: thread.workspace.canonicalPath,
          approvalPolicy: posture.approvalPolicy,
          sandboxPolicy: posture.sandboxPolicy,
          model: thread.modelId,
          ...(thread.reasoningId ? { effort: thread.reasoningId } : {})
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
      const handleQuestionRequest = (
        rpcId: string | number,
        method: string,
        params: Record<string, unknown> | null
      ): void => {
        const presentation = questionPresentation(method, params)
        const interactionId =
          PROVIDER_ID + ':' + request.runId + ':question:' + ++interactionSequence
        const deliver = (
          settlement: { readonly decision: string; readonly answer?: string } | null
        ): void => {
          if (settled || deliveredApprovalIds.has(interactionId)) return
          deliveredApprovalIds.add(interactionId)
          try {
            const payload = codexQuestionResult(method, settlement)
            child.stdin.write(
              JSON.stringify(
                'error' in payload
                  ? { id: rpcId, error: payload.error }
                  : { id: rpcId, result: payload.result }
              ) + '\n'
            )
          } catch {
            failure = failure || 'Codex question response could not be delivered.'
          }
        }
        void this.interactions
          .register({
            id: interactionId,
            kind: 'question',
            providerId: PROVIDER_ID,
            runId: request.runId,
            threadId: thread.threadId,
            title: presentation.title,
            summary: presentation.summary,
            ...(presentation.options ? { options: presentation.options } : {}),
            createdAt: timestamp()
          })
          .then((settlement) => deliver(settlement))
          .catch(() => deliver(null))
      }
      const handleApprovalRequest = (frame: Record<string, unknown>): void => {
        const rpcId = frame.id
        const method = typeof frame.method === 'string' ? frame.method : ''
        if (!method || (typeof rpcId !== 'string' && typeof rpcId !== 'number')) return
        const params = readObject(frame.params)
        if (isCodexQuestionMethod(method)) {
          handleQuestionRequest(rpcId, method, params)
          return
        }
        const rawTitle =
          (typeof params?.toolName === 'string' && params.toolName) ||
          (typeof params?.tool_name === 'string' && params.tool_name) ||
          (typeof params?.name === 'string' && params.name) ||
          method
        const title = rawTitle.trim().slice(0, 200) || 'Codex approval'
        const interactionId =
          PROVIDER_ID + ':' + request.runId + ':approval:' + ++interactionSequence
        const deliver = (decision: 'accept' | 'decline'): void => {
          if (settled || deliveredApprovalIds.has(interactionId)) return
          deliveredApprovalIds.add(interactionId)
          try {
            child.stdin.write(
              JSON.stringify({ id: rpcId, result: codexApprovalResponse(decision) }) + '\n'
            )
          } catch {
            failure = failure || 'Codex approval response could not be delivered.'
          }
        }
        void this.interactions
          .register({
            id: interactionId,
            kind: 'approval',
            providerId: PROVIDER_ID,
            runId: request.runId,
            threadId: thread.threadId,
            ...(typeof params?.itemId === 'string' && safeOperationId(params.itemId)
              ? { toolId: params.itemId }
              : {}),
            title,
            summary: 'Codex requested approval for ' + title + '.',
            createdAt: timestamp()
          })
          .then((settlement) => deliver(interactionDecision(settlement.decision)))
          .catch(() => deliver('decline'))
      }

      const handle = (frame: Record<string, unknown>): void => {
        if (
          typeof frame.method === 'string' &&
          (typeof frame.id === 'string' || typeof frame.id === 'number')
        ) {
          handleApprovalRequest(frame)
          return
        }
        if (frame.id === 1 && frame.result) {
          if (providerThreadId) {
            write(2, 'thread/resume', {
              threadId: providerThreadId,
              cwd: thread.workspace.canonicalPath,
              config: {
                model: thread.modelId,
                ...(thread.reasoningId ? { model_reasoning_effort: thread.reasoningId } : {})
              },
              persistExtendedHistory: true
            })
          } else {
            write(2, 'thread/start', {
              cwd: thread.workspace.canonicalPath,
              model: thread.modelId,
              config: {
                ...(thread.reasoningId ? { model_reasoning_effort: thread.reasoningId } : {})
              },
              approvalPolicy: posture.approvalPolicy,
              sandbox: posture.sandbox,
              experimentalRawEvents: false,
              persistExtendedHistory: true
            })
          }
          return
        }
        if (frame.id === 2 && frame.result) {
          const result = readObject(frame.result)
          const resultThread = readObject(result?.thread)
          const id =
            typeof result?.threadId === 'string'
              ? result.threadId
              : typeof resultThread?.id === 'string'
                ? resultThread.id
                : providerThreadId
          providerThreadId = id
          startTurn()
          return
        }
        if (frame.id === 3) {
          if (frame.error) {
            const error = readObject(frame.error)
            failure =
              typeof error?.message === 'string' ? error.message : 'Codex turn was rejected.'
            finish('failed', 'provider_failed')
            try {
              child.kill('SIGTERM')
            } catch {
              // The terminal receipt is already durable.
            }
            return
          }
          const result = readObject(frame.result)
          const turn = readObject(result?.turn)
          if (typeof result?.turnId === 'string') active.turnId = result.turnId
          else if (typeof turn?.id === 'string') active.turnId = turn.id
          return
        }
        const method = String(frame.method ?? '')
        const params = readObject(frame.params)
        if (method === 'turn/started') {
          const turn = readObject(params?.turn)
          if (typeof params?.turnId === 'string') active.turnId = params.turnId
          else if (typeof turn?.id === 'string') active.turnId = turn.id
          return
        }
        if (method === 'item/agentMessage/delta' || method === 'item/agentMessage/updated') {
          publishText(messageText(params))
          return
        }
        if (method === 'turn/completed' || method === 'turn/failed') {
          const status =
            method === 'turn/completed' && !active.cancelled
              ? 'completed'
              : active.cancelled
                ? 'cancelled'
                : 'failed'
          finish(status, status === 'failed' ? 'provider_failed' : undefined)
          try {
            child.kill('SIGTERM')
          } catch {
            // Completion does not depend on process teardown.
          }
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
            if (frame) handle(frame)
          } catch {
            // App-server output must be JSON-RPC; non-JSON output is not transcript content.
          }
        }
      }

      child.stdout.on('data', consume)
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = normalizeHostProviderRunPresentationText(String(chunk), 300)
        if (text) failure = text
      })
      child.once('error', (error) => {
        failure = error instanceof Error ? error.message : 'Codex app-server failed.'
        finish('failed', 'provider_launch_failed')
      })
      child.once('close', (code) => {
        if (!settled)
          finish(
            active.cancelled ? 'cancelled' : code === 0 ? 'failed' : 'failed',
            'provider_failed'
          )
      })

      const registration = this.runPort.registerCancel(request.runId, () => {
        active.cancelled = true
        this.runPort.updateRun({
          runId: request.runId,
          phase: 'cancelling',
          updatedAt: timestamp()
        })
        if (active.turnId) {
          try {
            write(4, 'turn/interrupt', { threadId: active.threadId, turnId: active.turnId })
          } catch {
            // The exact process cancellation below remains the fallback.
          }
        }
        try {
          child.kill('SIGTERM')
        } catch {
          finish('cancelled')
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
        sessionId: providerThreadId || request.runId,
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
        clientInfo: { name: 'taskwraith-host', version: 'node-host-v1' },
        capabilities: {}
      })
    })
  }

  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active) return false
    active.cancelled = true
    try {
      active.child.kill('SIGTERM')
    } catch {
      return false
    }
    return true
  }

  async shutdown(): Promise<void> {
    for (const [runId] of this.activeRuns) this.cancel(runId)
  }

  private finishRun(
    request: HostNodeProviderRunRequest,
    thread: HostProviderRunThread,
    sessionId: string | undefined,
    status: HostNodeProviderRunResult['status'],
    assistantText: string,
    errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed',
    warning?: string
  ): void {
    const text = normalizeHostProviderRunPresentationText(assistantText)
    if (text) {
      this.runPort.appendTranscript({
        threadId: thread.threadId,
        runId: request.runId,
        role: 'assistant',
        text,
        createdAt: timestamp()
      })
    }
    this.runPort.finishRun({
      runId: request.runId,
      status,
      finishedAt: timestamp(),
      ...(sessionId ? { providerSessionId: sessionId } : {}),
      warningSummaries: warning ? [warning.slice(0, 300)] : [],
      ...(errorCode ? { errorCode } : {})
    })
    this.runPort.publishRunEvent(request.target, {
      type: 'run.status',
      runId: request.runId,
      threadId: thread.threadId,
      status,
      at: timestamp(),
      ...(warning ? { warningCount: 1 } : {})
    })
  }
}

export function createHostNodeCodexProvider(
  options: HostNodeCodexProviderOptions = {}
): HostNodeProvider {
  const entry = hostProviderCatalogEntry(PROVIDER_ID)
  const offers = hostProviderOffers(PROVIDER_ID, true)
  if (!entry || !offers) throw new Error('Codex catalog is unavailable.')
  return {
    providerId: PROVIDER_ID,
    displayProvider: entry.displayProvider,
    shortCode: entry.shortCode,
    offers,
    supportsApprovals: true,
    supportsQuestions: true,
    create(input: HostNodeProviderCreateInput): HostNodeProviderInstance {
      return new HostNodeCodexProviderInstance(input.runPort, input.interactions, offers, options)
    }
  }
}
