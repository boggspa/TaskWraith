import { CAPABILITY_GATEWAY_TOOL_NAMES } from '../mcp/McpToolGateway'
import { ollamaModelIdsMatch as modelIdsMatchByAvailability } from '../../shared/ollamaModelAvailability'
import type {
  AgenticNetworkPolicy,
  OllamaReasoningLevel,
  OllamaRunProfile,
  OllamaRunProfileId,
  OllamaToolControlTier,
  TaskWraithMcpProfileId
} from '../store/types'
import { ollamaHarnessEnforced } from './OllamaHarnessGates'
import { ollamaModelFamilyTemperature } from './OllamaModelProfiles'
import {
  ollamaOneToolAtATime,
  ollamaPrefersJsonToolProtocol,
  ollamaUsesCompactToolSchemas
} from './OllamaModelProtocol'
import {
  classifyOllamaPromptIntent,
  extractOllamaCurrentRequestText,
  type OllamaPromptIntent
} from './OllamaPromptIntent'
import {
  createEmptyOllamaSessionMemory,
  normalizeOllamaSessionMemory,
  type OllamaSessionMemory
} from './OllamaRunMemory'
import { resolveOllamaRunProfile, resolveOllamaThinkingLevel } from './OllamaRunProfiles'
import { ollamaAdvertisedToolNames } from './OllamaToolTiers'
import type {
  OllamaChatMessage,
  OllamaModelInfo,
  OllamaModelShowInfo,
  OllamaNativeToolDefinition
} from './OllamaProvider'

export const OLLAMA_TOOL_HELP_NAME = 'tool_help'

export interface OllamaFinalLaunchPlan {
  readonly schemaVersion: 1
  readonly baseUrl: string
  readonly model: string
  readonly modelLabel: string
  readonly installedModels: OllamaModelInfo[]
  readonly modelManifest: {
    readonly installedTag: OllamaModelInfo | null
    readonly show: OllamaModelShowInfo | null
    readonly merged: OllamaModelInfo | null
  }
  readonly toolControlTier: OllamaToolControlTier
  readonly toolProtocolEnabled: boolean
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly runProfile: OllamaRunProfile
  readonly nativeToolsSupported: boolean
  readonly compactToolSchemas: boolean
  readonly oneToolAtATime: boolean
  readonly networkAccess: AgenticNetworkPolicy
  readonly readOnly: boolean
  readonly plan: boolean
  readonly nativeToolDefinitions: OllamaNativeToolDefinition[]
  readonly availableToolNames: string[]
  readonly formatToolNames: string[]
  /** Exact effective temperature sent in the first `/api/chat` request. */
  readonly temperature: number
  readonly thinkingLevel: OllamaReasoningLevel | null
  readonly memoryKey: string | null
  readonly sessionMemory: OllamaSessionMemory
  readonly harnessEnabled: boolean
  readonly userPrompt: string
  readonly promptIntent: OllamaPromptIntent
  readonly workspaceIndexBlock: string
  readonly openingMessages: OllamaChatMessage[]
  /** Exact body of the first production `/api/chat` request. */
  readonly firstRequest: Record<string, unknown>
}

export interface ResolveOllamaFinalLaunchPlanInput {
  readonly baseUrl: string
  readonly requestedModel: string | null | undefined
  readonly configuredDefaultModel: string | null | undefined
  readonly prompt: string
  readonly scope: 'global' | 'workspace'
  readonly workspacePath: string | null | undefined
  readonly toolExecutionAvailable: boolean
  readonly mcpToolsPolicy: string | null | undefined
  readonly configuredNetworkAccess: string | null | undefined
  readonly effectiveNetworkAccess: string | null | undefined
  readonly readOnly: boolean
  readonly plan: boolean
  readonly ollamaRunProfile: OllamaRunProfileId | string | null | undefined
  readonly taskWraithMcpAdvertised: boolean | null | undefined
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null | undefined
  readonly chatId: string | null | undefined
  readonly ensemble: Readonly<{
    enabled: boolean
    participantId?: string | null
    contextChars?: number
    contextTurns?: number
  }>
}

export interface ResolveOllamaFinalLaunchPlanDeps {
  loadInstalledModels(): Promise<readonly OllamaModelInfo[]>
  loadModelShow(model: string): Promise<OllamaModelShowInfo | null>
  modelLabel(model: string): string
  buildNativeToolDefinitions(input: {
    compact: boolean
    networkAccess: AgenticNetworkPolicy
    readOnly: boolean
    plan: boolean
    taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  }): OllamaNativeToolDefinition[]
  getSessionMemory(chatId: string, memoryKey?: string): OllamaSessionMemory | null | undefined
  prepareEnsemblePrompt(input: {
    prompt: string
    modelId: string
    modelInfo?: OllamaModelInfo | null
    contextCapTokens?: number
    configuredContextChars?: number
    configuredContextTurns?: number
    toolsEnabled?: boolean
  }): string
  buildWorkspaceIndexBlock(workspacePath: string): string
  buildOpeningMessages(input: {
    toolProtocolEnabled: boolean
    harnessEnabled: boolean
    promptIntent: OllamaPromptIntent
    toolControlTier: OllamaToolControlTier
    networkAccess: AgenticNetworkPolicy
    readOnly: boolean
    plan: boolean
    taskWraithMcpProfileId: TaskWraithMcpProfileId | null
    model: string
    workspaceIndexBlock: string
    userPrompt: string
    ensembleRun: boolean
  }): OllamaChatMessage[]
  resolveNumCtx(input: {
    messages: OllamaChatMessage[]
    tools?: OllamaNativeToolDefinition[]
    modelInfo?: OllamaModelInfo | null
    contextCapTokens?: number
    reserveTokens?: number
  }): number | undefined
}

/**
 * Resolve the immutable facts used by the first Ollama `/api/chat` request.
 * Production dispatch consumes this object directly. Scheduled evidence must
 * consume the same object instance rather than reconstructing mutable settings,
 * model, tool, or memory state after the seal boundary.
 */
export async function resolveOllamaFinalLaunchPlan(
  input: ResolveOllamaFinalLaunchPlanInput,
  deps: ResolveOllamaFinalLaunchPlanDeps
): Promise<OllamaFinalLaunchPlan | null> {
  const installedModels = cloneJson([...(await deps.loadInstalledModels())])
  const model = resolveOllamaRequestedWireModel(
    input.requestedModel,
    input.configuredDefaultModel,
    installedModels
  )
  if (!model) return null

  const installedTag =
    installedModels.find((candidate) => ollamaModelIdsMatch(candidate.id, model)) ?? null
  const show = cloneJson(await deps.loadModelShow(model))
  const merged = mergeOllamaModelShow(installedTag, show)
  const toolProtocolEligible =
    input.toolExecutionAvailable &&
    Boolean(input.workspacePath) &&
    input.scope !== 'global' &&
    input.mcpToolsPolicy !== 'deny'
  const toolProtocolEnabled = toolProtocolEligible && input.taskWraithMcpAdvertised !== false
  const toolControlTier: OllamaToolControlTier = 'provider_parity'
  // `merged` (line above) already carries the daemon's own `/api/show` metadata,
  // so the profile's context cap can be sized against the model's MEASURED window
  // rather than the hand-maintained `CONTEXT_WINDOWS_BY_MODEL` table plus a family
  // gate. That gate returned null for any tag without a family arm, dropping a
  // freshly pulled model to a 32K–65K preset however much context it really
  // supports; a measurement bypasses it. The cap is only a ceiling — `num_ctx` is
  // still demand-driven, so this does not pre-allocate.
  const runProfile = resolveOllamaRunProfile(
    model,
    input.ollamaRunProfile,
    merged?.contextLength
  )
  const nativeToolsSupported = ollamaModelSupportsNativeTools(merged)
  const compactToolSchemas =
    input.ensemble.enabled ||
    runProfile.compactToolSchemas === true ||
    ollamaUsesCompactToolSchemas(model, merged)
  const oneToolAtATime = runProfile.oneToolAtATime !== false && ollamaOneToolAtATime(model, merged)
  const networkAccess: AgenticNetworkPolicy =
    input.configuredNetworkAccess === 'deny' || input.effectiveNetworkAccess === 'deny'
      ? 'deny'
      : 'allow'
  const nativeToolDefinitions =
    toolProtocolEnabled && nativeToolsSupported && runProfile.protocolMode !== 'json_only'
      ? deps.buildNativeToolDefinitions({
          compact: compactToolSchemas,
          networkAccess,
          readOnly: input.readOnly,
          plan: input.plan,
          taskWraithMcpProfileId: input.taskWraithMcpProfileId ?? null
        })
      : []
  const availableToolNames =
    nativeToolDefinitions.length > 0
      ? nativeToolDefinitions.map((definition) => definition.function.name)
      : toolProtocolEnabled
        ? [
            ...ollamaAdvertisedToolNames({
              networkAccess,
              readOnly: input.readOnly,
              plan: input.plan,
              taskWraithMcpProfileId: input.taskWraithMcpProfileId
            }),
            ...CAPABILITY_GATEWAY_TOOL_NAMES,
            OLLAMA_TOOL_HELP_NAME
          ]
        : []
  const formatToolNames = toolProtocolEnabled ? [...availableToolNames] : []
  const memoryKey = ollamaSessionMemoryKeyForParticipant(input.ensemble.participantId)
  const persistedMemory =
    input.chatId && deps.getSessionMemory
      ? normalizeOllamaSessionMemory(deps.getSessionMemory(input.chatId, memoryKey ?? undefined))
      : null
  const sessionMemory =
    persistedMemory?.modelId === model ? persistedMemory : createEmptyOllamaSessionMemory(model)
  const harnessEnabled = toolProtocolEnabled && ollamaHarnessEnforced(model)
  const userPrompt = input.ensemble.enabled
    ? deps.prepareEnsemblePrompt({
        prompt: input.prompt,
        modelId: model,
        modelInfo: merged,
        contextCapTokens: runProfile.contextCapTokens,
        configuredContextChars: input.ensemble.contextChars,
        configuredContextTurns: input.ensemble.contextTurns,
        toolsEnabled: toolProtocolEnabled
      })
    : input.prompt
  const promptIntent: OllamaPromptIntent = input.ensemble.enabled
    ? 'workspace'
    : classifyOllamaPromptIntent(extractOllamaCurrentRequestText(userPrompt), {
        ongoingWork: sessionMemory.toolTurnCount > 0
      })
  const workspaceIndexBlock =
    toolProtocolEnabled && promptIntent === 'workspace' && input.workspacePath
      ? deps.buildWorkspaceIndexBlock(input.workspacePath)
      : ''
  const openingMessages = deps.buildOpeningMessages({
    toolProtocolEnabled,
    harnessEnabled,
    promptIntent,
    toolControlTier,
    networkAccess,
    readOnly: input.readOnly,
    plan: input.plan,
    taskWraithMcpProfileId: input.taskWraithMcpProfileId ?? null,
    model,
    workspaceIndexBlock,
    userPrompt,
    ensembleRun: input.ensemble.enabled
  })
  const temperature = ollamaModelFamilyTemperature(model) ?? 0.2
  const thinkingLevel = resolveOllamaThinkingLevel(model, runProfile) ?? null
  const jsonToolFallback =
    (toolProtocolEnabled && (!nativeToolsSupported || runProfile.protocolMode === 'json_only')) ||
    runProfile.protocolMode === 'json_fallback' ||
    (nativeToolDefinitions.length === 0 &&
      toolProtocolEnabled &&
      ollamaPrefersJsonToolProtocol(model, merged))
  const firstRequestTools = jsonToolFallback ? [] : nativeToolDefinitions
  const firstNumCtx = deps.resolveNumCtx({
    messages: openingMessages,
    tools: firstRequestTools,
    modelInfo: merged,
    contextCapTokens: runProfile.contextCapTokens,
    reserveTokens: runProfile.numPredictFinal
  })
  const firstRequestOptions: Record<string, unknown> = { temperature }
  if (typeof firstNumCtx === 'number' && Number.isFinite(firstNumCtx)) {
    firstRequestOptions.num_ctx = Math.max(1024, Math.trunc(firstNumCtx))
  }
  if (typeof runProfile.numPredictTool === 'number' && Number.isFinite(runProfile.numPredictTool)) {
    firstRequestOptions.num_predict = Math.max(1, Math.trunc(runProfile.numPredictTool))
  }
  const firstRequest: Record<string, unknown> = {
    model,
    stream: true,
    messages: cloneJson(openingMessages),
    ...(firstRequestTools.length ? { tools: cloneJson(firstRequestTools) } : {}),
    ...(jsonToolFallback
      ? {
          format:
            formatToolNames.length > 0
              ? ollamaToolCallFormatSchema(formatToolNames)
              : availableToolNames.length > 0
                ? ollamaToolCallFormatSchema(availableToolNames)
                : 'json'
        }
      : {}),
    ...(thinkingLevel ? { think: thinkingLevel } : {}),
    ...(runProfile.keepAlive ? { keep_alive: runProfile.keepAlive } : {}),
    options: firstRequestOptions
  }

  return deepFreeze({
    schemaVersion: 1,
    baseUrl: input.baseUrl,
    model,
    modelLabel: deps.modelLabel(model),
    installedModels,
    modelManifest: {
      installedTag: cloneJson(installedTag),
      show,
      merged: cloneJson(merged)
    },
    toolControlTier,
    toolProtocolEnabled,
    taskWraithMcpAdvertised: toolProtocolEnabled,
    taskWraithMcpProfileId: toolProtocolEnabled ? (input.taskWraithMcpProfileId ?? null) : null,
    runProfile: cloneJson(runProfile),
    nativeToolsSupported,
    compactToolSchemas,
    oneToolAtATime,
    networkAccess,
    readOnly: input.readOnly,
    plan: input.plan,
    nativeToolDefinitions: cloneJson(nativeToolDefinitions),
    availableToolNames: [...availableToolNames],
    formatToolNames,
    temperature,
    thinkingLevel,
    memoryKey,
    sessionMemory: cloneJson(sessionMemory),
    harnessEnabled,
    userPrompt,
    promptIntent,
    workspaceIndexBlock,
    openingMessages: cloneJson(openingMessages),
    firstRequest
  })
}

export function ollamaToolCallFormatSchema(toolNames: readonly string[]): Record<string, unknown> {
  const names = toolNames.filter((name) => typeof name === 'string' && name.length > 0)
  return {
    type: 'object',
    properties: {
      taskwraith_tool: {
        type: 'object',
        properties: {
          ...(names.length
            ? { name: { type: 'string', enum: names } }
            : { name: { type: 'string' } }),
          arguments: { type: 'object' }
        },
        required: ['name']
      }
    },
    required: ['taskwraith_tool']
  }
}

export function ollamaModelIdsMatch(a: string, b: string): boolean {
  return modelIdsMatchByAvailability(a, b)
}

export function resolveOllamaRequestedWireModel(
  requestedModel: string | null | undefined,
  configuredDefaultModel: string | null | undefined,
  models: readonly OllamaModelInfo[]
): string {
  const resolveInstalled = (value: string): string => {
    const target = value.trim()
    if (!target) return ''
    return models.find((model) => ollamaModelIdsMatch(model.id, target))?.id || target
  }
  const requested = String(requestedModel || '').trim()
  if (requested && !['cli-default', 'auto', 'default', 'custom'].includes(requested)) {
    return resolveInstalled(requested)
  }
  const configured = String(configuredDefaultModel || '').trim()
  if (configured) return resolveInstalled(configured)
  return models.find((model) => model.isDefault)?.id || models[0]?.id || ''
}

export function extractOllamaShowContextLength(
  show: OllamaModelShowInfo | null | undefined
): number | undefined {
  const detailsContext = positiveInteger(show?.details?.context_length)
  if (detailsContext) return detailsContext

  const modelInfo = show?.model_info || {}
  for (const [key, value] of Object.entries(modelInfo)) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey.endsWith('.context_length') || normalizedKey.endsWith('_context_length')) {
      const contextLength = positiveInteger(value)
      if (contextLength) return contextLength
    }
  }

  const parameters = String(show?.parameters || '')
  const match = parameters.match(/(?:^|\n)\s*num_ctx\s*[= ]\s*(\d+)\b/i)
  return match ? positiveInteger(match[1]) : undefined
}

export function mergeOllamaModelShow(
  modelInfo: OllamaModelInfo | null,
  show: OllamaModelShowInfo | null
): OllamaModelInfo | null {
  if (!modelInfo || !show) return modelInfo
  const next: OllamaModelInfo = { ...modelInfo, show }
  if (!next.contextLength) {
    const contextLength = extractOllamaShowContextLength(show)
    if (contextLength) next.contextLength = contextLength
  }
  if (!next.format && show.details?.format) next.format = show.details.format
  if (!next.family && show.details?.family) next.family = show.details.family
  if (!next.families && Array.isArray(show.details?.families)) {
    next.families = show.details.families.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    )
  }
  if (!next.parameterSize && show.details?.parameter_size) {
    next.parameterSize = show.details.parameter_size
  }
  if (!next.quantizationLevel && show.details?.quantization_level) {
    next.quantizationLevel = show.details.quantization_level
  }
  if (!next.capabilities && Array.isArray(show.capabilities)) {
    next.capabilities = show.capabilities.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    )
  }
  return next
}

export function ollamaModelSupportsNativeTools(modelInfo?: OllamaModelInfo | null): boolean {
  if (!modelInfo?.capabilities?.length) return true
  return modelInfo.capabilities.some((capability) => capability.toLowerCase() === 'tools')
}

export function ollamaSessionMemoryKeyForParticipant(
  participantId: string | null | undefined
): string | null {
  const trimmed = participantId?.trim()
  if (!trimmed) return null
  const safeParticipantId = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  return safeParticipantId ? `ensemble:${safeParticipantId}` : null
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(numeric) || numeric < 2048) return undefined
  return Math.floor(numeric)
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}
