/**
 * Node-owned Ollama provider adapter — real run path.
 *
 * Extracted from src/main/ollama/OllamaProvider.ts (run loop at 3716-4674,
 * model discovery at 1108-1300, context budget, tool tiers, run memory).
 * Desktop reuse is a named follow-up.
 *
 * This adapter implements the generic HostNodeProvider contract for Ollama:
 * daemon-reachability status, catalog-backed selection validation, streaming
 * chat completion with tool calls, exact cancellation, and model unload on
 * cleanup. It carries no Electron/AppStore/WebContents dependencies.
 */

import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import {
  isOllamaReasoningToken,
  normalizeOllamaReasoningEffort,
  resolveOllamaReasoningSupport
} from '../shared/ollamaReasoning'
import {
  fetchOllamaModelCatalog,
  OLLAMA_CLOUD_API_BASE_URL,
  unloadOllamaModel,
  type OllamaChatMessage,
  type OllamaModelInfo
} from '../host-shared/ollama/OllamaDaemonClient'
import { isOllamaCloudModelId, ollamaCloudBaseModelId } from '../shared/ollamaModelAvailability'
import {
  compressOllamaMessagesWithWorkingMemory,
  createEmptyOllamaSessionMemory,
  resolveOllamaRuntimeContextLimit,
  resolveOllamaToolResultLimits,
  shouldCompressOllamaMessagesForPressure,
  upsertOllamaSessionMemory,
  type OllamaSessionMemory
} from '../host-shared/ollama/OllamaContextBudget'
import { runOllamaChatLoop, type OllamaToolCall } from '../host-shared/ollama/OllamaChatLoop'
import type { HostNodeProviderResourcePort } from './HostNodeProviderResources'
import {
  normalizeHostProviderRunThread,
  type HostProviderRunPort,
  type HostProviderRunThread,
  type HostProviderRunFinish,
  type HostProviderRunUsage
} from '../host-runtime/HostProviderRunPort'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type {
  HostNodeProvider,
  HostNodeProviderInstance,
  HostNodeProviderRunRequest,
  HostNodeProviderRunResult
} from './HostNodeProvider'
import { hostNodeOllamaOffersFromCatalog } from './HostNodeOllamaCatalog'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'

const OLLAMA_PROVIDER_ID = 'ollama'
const OLLAMA_CATALOG_CACHE_MS = 1_000
const SAFE_IDENTIFIER_MAX_CHARS = 512
const CONTROL_MAX_CODE_POINT = 0x1f
const DELETE_CODE_POINT = 0x7f

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= CONTROL_MAX_CODE_POINT || codePoint === DELETE_CODE_POINT) return true
  }
  return false
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

export class HostNodeOllamaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostNodeOllamaValidationError'
  }
}

export class HostNodeOllamaDaemonUnavailableError extends Error {
  constructor() {
    super('Ollama daemon is not reachable. Start the Ollama service and refresh models.')
    this.name = 'HostNodeOllamaDaemonUnavailableError'
  }
}

export class HostNodeOllamaModelNotInstalledError extends Error {
  constructor(modelId: string) {
    super(
      `Ollama model is not installed: ${modelId}. Pull it with \`ollama pull ${modelId}\` first.`
    )
    this.name = 'HostNodeOllamaModelNotInstalledError'
  }
}

export interface HostNodeOllamaProviderOptions {
  readonly runPort: HostProviderRunPort
  readonly offers: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly baseUrl?: string
  readonly cloudApiKey?: string | null
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly executeTool?: (toolCall: OllamaToolCall) => Promise<{ ok: boolean; result: string }>
}

interface ActiveOllamaRun {
  cancelled: boolean
  abortController: AbortController
  modelId: string
  baseUrl: string
  directCloud: boolean
}

export class HostNodeOllamaProvider implements HostNodeProviderInstance {
  readonly providerId = OLLAMA_PROVIDER_ID
  private readonly baseUrl: string
  private readonly cloudApiKey: string | null
  private readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  private currentOffers: HostProviderOffersProjection
  private readonly executeTool?: (
    toolCall: OllamaToolCall
  ) => Promise<{ ok: boolean; result: string }>
  private readonly activeRuns = new Map<string, ActiveOllamaRun>()
  private readonly sessionMemoryByThreadModel = new Map<string, OllamaSessionMemory>()
  private catalogCache:
    | {
        readonly value: Awaited<ReturnType<typeof fetchOllamaModelCatalog>>
        readonly expiresAt: number
      }
    | undefined
  private catalogInFlight: Promise<Awaited<ReturnType<typeof fetchOllamaModelCatalog>>> | null =
    null

  constructor(private readonly options: HostNodeOllamaProviderOptions) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434'
    this.cloudApiKey = options.cloudApiKey ?? null
    this.terminalLauncher = options.terminalLauncher
    this.currentOffers = options.offers
    this.executeTool = options.executeTool
  }

  private async catalog(defaultModel?: string) {
    if (!defaultModel && this.catalogCache && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.value
    }
    if (!defaultModel && this.catalogInFlight) return this.catalogInFlight
    const pending = fetchOllamaModelCatalog(this.baseUrl, {
      timeoutMs: 2_000,
      cloudApiKey: this.cloudApiKey,
      ...(defaultModel ? { defaultModel } : {})
    })
    if (defaultModel) return pending
    this.catalogInFlight = pending
    try {
      const value = await pending
      this.catalogCache = { value, expiresAt: Date.now() + OLLAMA_CATALOG_CACHE_MS }
      return value
    } finally {
      this.catalogInFlight = null
    }
  }

  private async runtimeStatus() {
    try {
      const catalog = await this.catalog()
      const runnable = catalog.models.some((model) => !model.disabled)
      return { catalog, runnable }
    } catch {
      return { catalog: null, runnable: false }
    }
  }

  async getOffers(): Promise<HostProviderOffersProjection> {
    const status = await this.runtimeStatus()
    this.currentOffers = hostNodeOllamaOffersFromCatalog({
      models: status.catalog?.models ?? []
    })
    return this.currentOffers
  }

  /** A missing daemon is a present `unavailable` row, never an omission. */
  async getStatus(): Promise<HostProviderStatusProjection> {
    const status = await this.runtimeStatus()
    if (!status.catalog || !status.runnable) {
      return {
        providerId: OLLAMA_PROVIDER_ID,
        status: 'unavailable',
        label: 'Ollama',
        detail: status.catalog
          ? 'No installed local model or authenticated Ollama Cloud model is available.'
          : 'Ollama daemon and direct Cloud API are not reachable.'
      }
    }
    return {
      providerId: OLLAMA_PROVIDER_ID,
      status: 'ready',
      label: 'Ollama',
      detail:
        status.catalog.cloud.authenticated === true
          ? status.catalog.localReachable
            ? 'Local Ollama and authenticated Cloud models are available.'
            : 'Authenticated Ollama Cloud models are available.'
          : 'Local Ollama models are available.'
    }
  }

  async getAuthStatus(): Promise<HostProviderAuthStatusProjection> {
    const status = await this.runtimeStatus()
    const authenticated = status.catalog?.cloud.authenticated
    return {
      providerId: OLLAMA_PROVIDER_ID,
      state:
        authenticated === true
          ? 'authenticated'
          : authenticated === false
            ? 'unauthenticated'
            : status.catalog
              ? 'unknown'
              : 'unavailable',
      detail:
        authenticated === true
          ? 'Ollama Cloud account verified.'
          : 'Local models do not require an account; Cloud models require `ollama signin` or OLLAMA_API_KEY.'
    }
  }

  async getAuthFlows(): Promise<readonly HostProviderAuthFlowProjection[]> {
    if (!this.terminalLauncher || !this.options.resources) return []
    const status = await this.runtimeStatus()
    if (status.catalog?.cloud.authenticated === true) return []
    const binary = await this.options.resources.resolveBinary()
    if (!binary.binaryPath) return []
    return [
      {
        flowId: 'ollama:signin',
        kind: 'manual',
        label: 'Sign in to Ollama Cloud',
        available: true,
        detail:
          'Runs `ollama signin`; Cloud offers appear only after the daemon proves the account.'
      }
    ]
  }

  async beginAuth(operationId: string): Promise<void> {
    if (!isCanonicalIdentifier(operationId)) {
      throw new HostNodeOllamaValidationError('Ollama auth operation id is not canonical.')
    }
    if (!this.terminalLauncher || !this.options.resources) {
      throw new HostNodeOllamaValidationError('Ollama Cloud sign-in handoff is unavailable.')
    }
    const binary = await this.options.resources.resolveBinary()
    if (!binary.binaryPath) throw new HostNodeOllamaValidationError('Ollama CLI is unavailable.')
    await this.terminalLauncher.launchForProvider(OLLAMA_PROVIDER_ID, {
      argv: [binary.binaryPath, 'signin']
    })
  }

  async cancelAuth(): Promise<boolean> {
    return false
  }

  /** Validate a thread's Ollama selection against the catalog offers. */
  validateThread(thread: HostProviderRunThread): HostProviderRunThread {
    const normalized = normalizeHostProviderRunThread(thread)
    if (!normalized) {
      throw new HostNodeOllamaValidationError('Ollama thread configuration is invalid.')
    }
    if (normalized.providerId !== OLLAMA_PROVIDER_ID) {
      throw new HostNodeOllamaValidationError('Thread is not configured for Ollama.')
    }
    const model = this.currentOffers.models.find((entry) => entry.modelId === normalized.modelId)
    if (!model) {
      throw new HostNodeOllamaValidationError('Ollama model is not offered by the Host catalog.')
    }
    if (
      normalized.reasoningId !== undefined &&
      !model.reasoning.some((entry) => entry.reasoningId === normalized.reasoningId)
    ) {
      // A persisted effort is a HISTORICAL selection, not a fresh claim: the
      // ladder it was chosen from can narrow under it when this model's real
      // capabilities are corrected. Refusing the run turns every such chat into
      // a permanent `run_not_started`, so fold the stored intent onto a stop
      // this model actually offers — the same clamp the desktop seat applies.
      // Only a RECOGNISED token folds; junk still fails closed, because the
      // normalizer answers for any string and would otherwise launder it.
      if (!isOllamaReasoningToken(normalized.reasoningId)) {
        throw new HostNodeOllamaValidationError('Ollama reasoning is not offered for this model.')
      }
      const folded = normalizeOllamaReasoningEffort(
        normalized.reasoningId,
        resolveOllamaReasoningSupport({ modelId: normalized.modelId })
      )
      const offered =
        folded !== null && model.reasoning.some((entry) => entry.reasoningId === folded)
      const { reasoningId: _stale, ...rest } = normalized
      return offered ? { ...rest, reasoningId: folded } : rest
    }
    return normalized
  }

  private async ensureModelAvailable(modelId: string): Promise<OllamaModelInfo> {
    let catalog
    try {
      catalog = await fetchOllamaModelCatalog(this.baseUrl, {
        cloudApiKey: this.cloudApiKey,
        defaultModel: modelId
      })
    } catch {
      throw new HostNodeOllamaDaemonUnavailableError()
    }
    const model = catalog.models.find(
      (entry) => entry.id === modelId || entry.id.toLowerCase() === modelId.toLowerCase()
    )
    if (!model) {
      throw new HostNodeOllamaModelNotInstalledError(modelId)
    }
    if (model.disabled) {
      throw new HostNodeOllamaValidationError(
        model.disabledReason ?? `Ollama model ${modelId} is not available.`
      )
    }
    if (model.source === 'local' && !catalog.localReachable) {
      throw new HostNodeOllamaDaemonUnavailableError()
    }
    if (model.source === 'cloud' && !this.cloudApiKey && !catalog.localReachable) {
      throw new HostNodeOllamaDaemonUnavailableError()
    }
    return model
  }

  private buildMessages(prompt: string, sessionMemory: OllamaSessionMemory): OllamaChatMessage[] {
    const messages: OllamaChatMessage[] = []
    if (sessionMemory.workingMemory) {
      messages.push({
        role: 'system',
        content: `[Working memory from previous turns]\n${sessionMemory.workingMemory}`
      })
    }
    messages.push({ role: 'user', content: prompt })
    return messages
  }

  private usageFromResult(result: {
    promptTokens?: number
    completionTokens?: number
  }): HostProviderRunUsage | undefined {
    if (result.promptTokens === undefined && result.completionTokens === undefined) return undefined
    return {
      ...(result.promptTokens !== undefined ? { inputTokens: result.promptTokens } : {}),
      ...(result.completionTokens !== undefined ? { outputTokens: result.completionTokens } : {})
    }
  }

  /** Run an Ollama chat completion with streaming and tool-call support. */
  async run(request: HostNodeProviderRunRequest): Promise<HostNodeProviderRunResult> {
    if (!isCanonicalIdentifier(request.runId) || !isCanonicalIdentifier(request.threadId)) {
      throw new HostNodeOllamaValidationError('Ollama run and thread ids must be canonical.')
    }
    const thread = this.validateThread(
      this.options.runPort.getThread(request.threadId) as HostProviderRunThread
    )
    const abortController = new AbortController()
    const active: ActiveOllamaRun = {
      cancelled: false,
      abortController,
      modelId: thread.modelId,
      baseUrl: this.baseUrl,
      directCloud: false
    }
    this.activeRuns.set(request.runId, active)

    const startedAt = new Date().toISOString()
    const begin = this.options.runPort.beginRun({
      runId: request.runId,
      threadId: request.threadId,
      providerId: OLLAMA_PROVIDER_ID,
      modelId: thread.modelId,
      startedAt
    })
    if (begin.kind === 'duplicate') {
      this.activeRuns.delete(request.runId)
      throw new HostNodeOllamaValidationError(`Ollama run already exists: ${request.runId}`)
    }

    this.options.runPort.appendTranscript({
      threadId: request.threadId,
      runId: request.runId,
      role: 'user',
      text: request.prompt,
      createdAt: startedAt
    })
    this.options.runPort.updateRun({
      runId: request.runId,
      phase: 'starting',
      updatedAt: startedAt
    })
    this.options.runPort.publishRunEvent(request.target, {
      type: 'run.started',
      runId: request.runId,
      threadId: request.threadId,
      providerId: OLLAMA_PROVIDER_ID,
      sessionId: request.runId,
      at: startedAt
    })
    this.options.runPort.publishRunEvent(request.target, {
      type: 'run.status',
      runId: request.runId,
      threadId: request.threadId,
      status: 'running',
      at: startedAt
    })

    const registration = this.options.runPort.registerCancel(request.runId, () => {
      active.cancelled = true
      active.abortController.abort()
    })
    if (registration.kind !== 'registered') {
      this.activeRuns.delete(request.runId)
      throw new HostNodeOllamaValidationError('Ollama cancel registration failed.')
    }

    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let errorCode:
      | 'provider_setup_unavailable'
      | 'provider_launch_failed'
      | 'provider_failed'
      | undefined
    let assistantText = ''
    let usage: HostProviderRunUsage | undefined

    try {
      const model = await this.ensureModelAvailable(thread.modelId)
      const directCloud = model.transport === 'cloud-direct'
      active.directCloud = directCloud
      const transportBaseUrl = directCloud ? OLLAMA_CLOUD_API_BASE_URL : this.baseUrl
      const transportModelId = directCloud ? ollamaCloudBaseModelId(thread.modelId) : thread.modelId
      const memoryKey = `${request.threadId}:${thread.modelId}`
      const sessionMemory =
        this.sessionMemoryByThreadModel.get(memoryKey) ??
        createEmptyOllamaSessionMemory(thread.modelId)
      this.sessionMemoryByThreadModel.set(memoryKey, sessionMemory)
      const messages = this.buildMessages(request.prompt, sessionMemory)
      const contextLimit = resolveOllamaRuntimeContextLimit({
        modelInfo: model.contextLength ? { contextLength: model.contextLength } : undefined,
        contextCapTokens: 8_192
      })
      const toolLimits = resolveOllamaToolResultLimits({
        measuredContextTokens: model.contextLength,
        contextCapTokens: contextLimit
      })
      const compressedMessages = shouldCompressOllamaMessagesForPressure({
        measuredRuntimeContextTokens: contextLimit,
        currentPromptTokens: messages.reduce((sum, message) => sum + message.content.length, 0),
        toolTurnCount: sessionMemory.toolTurnCount
      })
        ? compressOllamaMessagesWithWorkingMemory({ messages, memory: sessionMemory })
        : messages

      const result = await runOllamaChatLoop({
        baseUrl: transportBaseUrl,
        ...(directCloud && this.cloudApiKey ? { apiKey: this.cloudApiKey } : {}),
        signal: abortController.signal,
        model: transportModelId,
        messages: compressedMessages,
        tools: this.executeTool ? [] : undefined, // Tool definitions would come from the tool tier system
        executeTool: this.executeTool
          ? async (toolCall) => {
              const result = await this.executeTool!(toolCall)
              const trajectoryEntry = {
                toolName: toolCall.name,
                argsSummary: JSON.stringify(toolCall.arguments).slice(0, 120),
                ok: result.ok,
                resultSummary: result.result.slice(0, toolLimits.toolResultMaxChars)
              }
              this.sessionMemoryByThreadModel.set(
                memoryKey,
                upsertOllamaSessionMemory(sessionMemory, trajectoryEntry)
              )
              return result
            }
          : undefined,
        onContentDelta: (delta, full) => {
          assistantText = full
          this.options.runPort.updateRun({
            runId: request.runId,
            phase: 'streaming',
            updatedAt: new Date().toISOString()
          })
          this.options.runPort.publishRunEvent(request.target, {
            type: 'run.content',
            runId: request.runId,
            threadId: request.threadId,
            text: delta,
            at: new Date().toISOString()
          })
        }
      })

      if (active.cancelled) {
        status = 'cancelled'
      } else {
        assistantText = result.content
        usage = result.usage ? this.usageFromResult(result.usage) : undefined
      }
    } catch (error) {
      if (active.cancelled) {
        status = 'cancelled'
      } else {
        status = 'failed'
        errorCode = 'provider_failed'
        assistantText = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.options.runPort.clearCancel(request.runId)
      this.activeRuns.delete(request.runId)
      if (status === 'cancelled' && !active.directCloud) {
        await unloadOllamaModel(this.baseUrl, active.modelId).catch(() => undefined)
      }
    }

    const finishedAt = new Date().toISOString()
    const finish: HostProviderRunFinish = {
      runId: request.runId,
      status,
      finishedAt,
      ...(usage ? { usage } : {}),
      warningSummaries: [],
      ...(errorCode ? { errorCode } : {})
    }
    this.options.runPort.finishRun(finish)
    this.options.runPort.publishRunEvent(request.target, {
      type: 'run.status',
      runId: request.runId,
      threadId: request.threadId,
      status,
      at: finishedAt
    })
    if (assistantText.trim()) {
      this.options.runPort.appendTranscript({
        threadId: request.threadId,
        runId: request.runId,
        role: 'assistant',
        text: assistantText,
        createdAt: finishedAt
      })
    }

    return {
      runId: request.runId,
      status,
      ...(thread.providerSessionId ? { sessionId: thread.providerSessionId } : {})
    }
  }

  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId)
    if (!active || active.cancelled) return false
    active.cancelled = true
    active.abortController.abort()
    return true
  }

  async shutdown(): Promise<void> {
    for (const active of this.activeRuns.values()) {
      active.cancelled = true
      active.abortController.abort()
    }
    this.activeRuns.clear()
    this.catalogCache = undefined
    this.catalogInFlight = null
    // Best-effort unload of the most recent model per thread.
    for (const memory of this.sessionMemoryByThreadModel.values()) {
      if (memory.modelId && !isOllamaCloudModelId(memory.modelId)) {
        await unloadOllamaModel(this.baseUrl, memory.modelId).catch(() => undefined)
      }
    }
    this.sessionMemoryByThreadModel.clear()
  }
}

export interface HostNodeOllamaProviderFactoryOptions {
  readonly offers?: HostProviderOffersProjection
  readonly resources?: HostNodeProviderResourcePort
  readonly baseUrl?: string
  readonly cloudApiKey?: string | null
  readonly terminalLauncher?: HostNodeProviderTerminalLauncher
  readonly executeTool?: (toolCall: OllamaToolCall) => Promise<{ ok: boolean; result: string }>
}

/** Static Ollama factory implementing the generic HostNodeProvider contract. */
export function createHostNodeOllamaProviderFactory(
  options: HostNodeOllamaProviderFactoryOptions = {}
): HostNodeProvider {
  const offers = options.offers ?? hostProviderOffers(OLLAMA_PROVIDER_ID, true)
  if (!offers || offers.providerId !== OLLAMA_PROVIDER_ID) {
    throw new Error('Ollama provider factory requires Ollama offers')
  }
  return {
    providerId: OLLAMA_PROVIDER_ID,
    displayProvider: 'Ollama',
    shortCode: 'OL',
    offers,
    supportsApprovals: false,
    supportsQuestions: false,
    create({ runPort, interactions }) {
      void interactions
      return new HostNodeOllamaProvider({
        runPort,
        offers,
        ...(options.resources ? { resources: options.resources } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.cloudApiKey !== undefined ? { cloudApiKey: options.cloudApiKey } : {}),
        ...(options.terminalLauncher ? { terminalLauncher: options.terminalLauncher } : {}),
        ...(options.executeTool ? { executeTool: options.executeTool } : {})
      })
    }
  }
}
