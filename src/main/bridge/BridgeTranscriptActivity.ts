import type { ChatMessage, ProviderId, ToolActivity } from '../store/types'
import { bridgeToolDiffStats } from './BridgeToolDiffStats'
import {
  canonicalImageViewToolName,
  IMAGE_VIEW_DISPLAY_NAME,
  IMAGE_VIEW_TOOL_NAME,
  imageViewCountFromParameters,
  imageViewCountFromResult,
  isImageViewToolUse
} from '../../shared/imageViewIdentity'
import {
  extractToolInvocationParameters,
  presentToolInvocation
} from '../../shared/toolInvocationPresentation'

const BRIDGE_TOOL_CATEGORY_RULES: Array<{
  pattern: RegExp
  category: ToolActivity['category']
}> = [
  {
    pattern:
      /write|replace|apply_patch|edit|patch|create_file|create_directory|delete_path|move_path|rename_path|mkdir|delete|rename/i,
    category: 'write'
  },
  { pattern: /read|list|cat|view|open/i, category: 'read' },
  { pattern: /search|grep|glob|find/i, category: 'search' },
  { pattern: /shell|bash|terminal|command|exec/i, category: 'shell' },
  { pattern: /task|agent|delegate|diagnostic|problems/i, category: 'task' }
]

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function bridgeToolKindCategory(kind: string): ToolActivity['category'] | undefined {
  switch (kind.trim().toLowerCase()) {
    case 'read':
      return 'read'
    case 'edit':
    case 'delete':
    case 'move':
      return 'write'
    case 'search':
    case 'fetch':
      return 'search'
    case 'execute':
      return 'shell'
    case 'think':
    case 'thinking':
    case 'reasoning':
      return 'task'
    default:
      return undefined
  }
}

function isBridgeReasoningToolName(name: string): boolean {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/^mcp__[^_]+__/i, '')
    .replace(/^mcp_(?:taskwraith-broker|taskwraith)[_-]/i, '')
    .replace(/^taskwraith(?:-broker|_broker)?__/i, '')
  return (
    normalized === 'thinking' ||
    normalized === 'reasoning' ||
    /(?:^|[_\s-])(?:thinking|reasoning)$/.test(normalized)
  )
}

export function bridgeToolCategory(name: string, kind = ''): ToolActivity['category'] {
  const kindCategory = bridgeToolKindCategory(kind)
  if (kindCategory) return kindCategory
  if (isBridgeReasoningToolName(name)) return 'task'
  for (const rule of BRIDGE_TOOL_CATEGORY_RULES) {
    if (rule.pattern.test(name)) return rule.category
  }
  return 'unknown'
}

export function bridgeToolDisplayName(name: string): string {
  if (isImageViewToolUse(name)) return IMAGE_VIEW_DISPLAY_NAME
  const cleaned = name.replace(/^mcp__\w+__/i, '').replace(/[_-]+/g, ' ').trim()
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : name
}

export interface BridgeModelMetadata {
  model?: string
  modelLabel?: string
}

export function bridgeModelMetadataFromEvent(
  event: Record<string, unknown>
): BridgeModelMetadata {
  const model = stringValue(event.model) || stringValue(event.providerModel)
  const modelLabel =
    stringValue(event.modelLabel) ||
    stringValue(event.model_label) ||
    stringValue(event.providerModelLabel)
  return {
    ...(model ? { model } : {}),
    ...(modelLabel ? { modelLabel } : {})
  }
}

export function bridgeAssistantMessageMetadata(input: {
  provider: ProviderId
  actualModel?: string
  modelLabel?: string
}): ChatMessage['metadata'] {
  return {
    assistantProvider: input.provider,
    ...(input.actualModel ? { providerModel: input.actualModel } : {}),
    ...(input.modelLabel ? { providerModelLabel: input.modelLabel } : {})
  }
}

export function buildBridgeToolActivity(input: {
  payload: Record<string, unknown>
  provider: ProviderId
  activityIndex: number
  nowIso?: () => string
}): ToolActivity {
  const { payload, provider, activityIndex, nowIso = () => new Date().toISOString() } = input
  const reportedToolName = String(
    payload.tool_name || payload.toolName || payload.name || recordValue(payload.function).name || 'tool'
  )
  const id = String(
    payload.tool_id ||
      payload.id ||
      payload.call_id ||
      payload.tool_call_id ||
      payload.toolCallId ||
      `bridge-tool-${activityIndex + 1}`
  )
  const rawParameters = extractToolInvocationParameters(payload)
  const innerName =
    /^(use_tool|call_tool|mcp)$/i.test(reportedToolName) &&
    typeof rawParameters.tool_name === 'string'
      ? rawParameters.tool_name
      : undefined
  const presentation = presentToolInvocation(innerName || reportedToolName, rawParameters)
  const effectiveName = presentation.toolName
  const canonicalName = canonicalImageViewToolName(effectiveName, presentation.parameters)
  const parameterImageCount =
    canonicalName === IMAGE_VIEW_TOOL_NAME
      ? imageViewCountFromParameters(presentation.parameters)
      : undefined
  const parameters = parameterImageCount
    ? { ...presentation.parameters, imageCount: parameterImageCount }
    : presentation.parameters
  const filePath =
    stringValue(parameters.path) ||
    stringValue(parameters.file_path) ||
    stringValue(parameters.filePath) ||
    stringValue(parameters.from) ||
    stringValue(parameters.source) ||
    stringValue(parameters.sourcePath) ||
    stringValue(parameters.source_path) ||
    stringValue(parameters.to) ||
    stringValue(parameters.destination) ||
    stringValue(parameters.destinationPath) ||
    stringValue(parameters.destination_path) ||
    undefined
  const toolKind =
    stringValue(payload.tool_kind) ||
    stringValue(payload.toolKind) ||
    stringValue(payload.kind) ||
    stringValue(parameters.tool_kind) ||
    stringValue(parameters.toolKind) ||
    stringValue(parameters.kind)
  const category =
    canonicalName === IMAGE_VIEW_TOOL_NAME ? 'read' : bridgeToolCategory(effectiveName, toolKind)
  const diffSummary = bridgeToolDiffStats(effectiveName, parameters, {
    writeLike: category === 'write'
  })
  const patchPaths = new Set(
    (diffSummary?.files ?? []).map((file) => file.path).filter(Boolean) as string[]
  )
  const effectiveFilePath = filePath || (patchPaths.size === 1 ? [...patchPaths][0] : undefined)

  return {
    id,
    toolName: canonicalName,
    displayName:
      canonicalName === IMAGE_VIEW_TOOL_NAME
        ? IMAGE_VIEW_DISPLAY_NAME
        : bridgeToolDisplayName(effectiveName),
    category,
    status: 'running',
    startedAt: nowIso(),
    parameters,
    rawUseEvent: payload,
    metadata: { provider },
    ...(effectiveFilePath ? { filePath: effectiveFilePath } : {}),
    ...(diffSummary ? { diffSummary } : {})
  }
}

/** Apply result-derived Image View count/identity at the bridge ingestion seam. */
export function applyBridgeToolResultIdentity(
  activity: ToolActivity,
  payload: Record<string, unknown>
): void {
  activity.rawResultEvent = payload
  if (!isImageViewToolUse(activity.toolName, activity.parameters)) return
  const imageCount = imageViewCountFromResult(payload)
  activity.toolName = IMAGE_VIEW_TOOL_NAME
  activity.displayName = IMAGE_VIEW_DISPLAY_NAME
  activity.category = 'read'
  if (imageCount) {
    activity.parameters = { ...(activity.parameters || {}), imageCount }
  }
}
