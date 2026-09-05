import { yieldTargetDisplayLabel } from '../../shared/ensembleYieldTarget'
import {
  canonicalImageViewToolName,
  IMAGE_VIEW_DISPLAY_NAME,
  IMAGE_VIEW_TOOL_NAME,
  imageViewCountFromParameters,
  imageViewCountFromResult,
  isImageViewToolUse
} from '../../shared/imageViewIdentity'
import {
  catalogToolOperationCategory,
  resolveCatalogToolName
} from '../../shared/canonicalToolCoalesce'
import {
  extractToolInvocationParameters,
  mergeToolResultParameters,
  presentToolInvocation
} from '../../shared/toolInvocationPresentation'
import { isMeasuredDiffSummary } from '../../shared/toolDiffSummaryMerge'
import { bridgeResultDiffStats, bridgeToolDiffStats } from '../bridge/BridgeToolDiffStats'
import type { EnsembleParticipant, ToolActivity, ToolActivityStatus } from '../store/types'

/**
 * Minimal tool-activity builders for the orchestrator. The renderer's
 * `ToolParser.ts` has richer extraction (file-path heuristics, diff
 * summaries, display-name humanising) but lives under `src/renderer/`
 * which `tsconfig.node.json` doesn't include. For ensemble tool
 * messages the basics are enough — the renderer's display layer can
 * still humanise on read by inspecting `rawUseEvent` / `rawResultEvent`.
 */
export function extractToolId(event: any): string {
  if (!event || typeof event !== 'object') {
    return `ensemble-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
  return (
    event.tool_id ||
    event.toolId ||
    event.id ||
    event.call_id ||
    event.tool_call_id ||
    `ensemble-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function extractToolName(event: any): string {
  if (!event || typeof event !== 'object') return 'unknown'
  return (
    event.tool_name ||
    event.toolName ||
    event.name ||
    event.function?.name ||
    event.tool ||
    'unknown'
  )
}

export function extractToolKind(event: any): string {
  if (!event || typeof event !== 'object') return ''
  const raw = event.tool_kind || event.toolKind || event.kind
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export function extractToolParameters(event: any): Record<string, unknown> {
  return extractToolInvocationParameters(event)
}

export function stripToolNamespace(toolName: string): string {
  const name = (toolName || '').toLowerCase().trim()
  if (!name) return 'unknown'
  if (name.startsWith('mcp__')) {
    const idx = name.indexOf('__', 5)
    return idx > 5 ? name.slice(idx + 2) : name
  }
  if (name.startsWith('mcp_') && !name.startsWith('mcp__')) {
    const knownServerPrefixes = [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-'
    ]
    for (const prefix of knownServerPrefixes) {
      if (name.startsWith(prefix)) return name.slice(prefix.length)
    }
  }
  if (name.startsWith('taskwraith-broker__')) return name.slice('taskwraith-broker__'.length)
  if (name.startsWith('taskwraith_broker__')) return name.slice('taskwraith_broker__'.length)
  if (name.startsWith('taskwraith-broker_')) return name.slice('taskwraith-broker_'.length)
  if (name.startsWith('taskwraith_broker_')) return name.slice('taskwraith_broker_'.length)
  if (name.startsWith('taskwraith__')) return name.slice('taskwraith__'.length)
  if (name.startsWith('taskwraith_')) return name.slice('taskwraith_'.length)
  return name
}

export function getStringParameter(parameters: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// Segments that should render as all-caps acronyms rather than Title-cased
// (a bare `mcp` base would otherwise humanise to the odd-looking "Mcp").
const TOOL_NAME_ACRONYMS: Record<string, string> = { mcp: 'MCP' }

export function titleCaseToolName(toolName: string): string {
  return toolName
    .split('_')
    .filter(Boolean)
    .map((part) => TOOL_NAME_ACRONYMS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function participantLabel(participant?: EnsembleParticipant): string {
  if (!participant) return 'Participant'
  return participant.role || participant.provider
}

export function mapEnsembleToolKindToCategory(kind: string): ToolActivity['category'] | undefined {
  switch (kind) {
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

export function isEnsembleReasoningToolName(toolName: string): boolean {
  const name = stripToolNamespace(toolName)
  return (
    name === 'thinking' ||
    name === 'reasoning' ||
    name.endsWith('_thinking') ||
    name.endsWith('_reasoning')
  )
}

export function getEnsembleToolCategory(toolName: string, toolKind = ''): ToolActivity['category'] {
  const kindCategory = mapEnsembleToolKindToCategory(toolKind)
  if (kindCategory) return kindCategory
  const catalogTool = resolveCatalogToolName(toolName)
  const operationCategory = catalogToolOperationCategory(toolName)
  if (operationCategory === 'read_file') return 'read'
  if (operationCategory === 'edit_file') return 'write'
  if (operationCategory === 'search') return 'search'
  if (operationCategory === 'shell') return 'shell'
  const name = stripToolNamespace(catalogTool || toolName)
  if (isEnsembleReasoningToolName(name)) return 'task'
  if (
    name === 'ensemble_yield' ||
    name === 'update_topic' ||
    name === 'summary' ||
    name === 'intent' ||
    name === 'progress' ||
    name === 'tool_progress'
  ) {
    return 'task'
  }
  if (name === 'read_file' || name === 'list_directory') return 'read'
  if (FILE_WRITE_TOOL_NAMES.has(name)) return 'write'
  if (
    name === 'grep_search' ||
    name === 'grep' ||
    name === 'rg' ||
    name === 'web_search' ||
    name === 'capability_search'
  )
    return 'search'
  if (name === 'run_shell_command' || name === 'shell' || name === 'get_diagnostics') return 'shell'
  if (name === 'git_push' || name === 'git_create_pr') return 'shell'
  if (name === 'github_ci_status') return 'search'
  return 'unknown'
}

export function getEnsembleToolDisplayName(
  toolName: string,
  parameters: Record<string, unknown>,
  participant?: EnsembleParticipant,
  roster?: readonly EnsembleParticipant[]
): string {
  const name = stripToolNamespace(resolveCatalogToolName(toolName) || toolName)
  if (name === 'ensemble_yield') {
    const target = getStringParameter(parameters, ['target', 'participant', 'to', 'next'])
    const actor = participantLabel(participant)
    // Models address a peer by whatever form is in front of them — including
    // the opaque roster id the held-handoff result hands back. Resolve it to
    // the seat's role so the PERSISTED name reads like the actor half does
    // ("DSeekWork yielding to Builder"); unresolvable targets keep the
    // model's own words.
    const label = yieldTargetDisplayLabel(target, roster)
    return label ? `${actor} yielding to ${label}` : `${actor} yielding`
  }
  if (name === 'update_topic') {
    const topic = getStringParameter(parameters, ['title', 'topic', 'name'])
    return topic ? `Topic update: ${topic}` : 'Topic update'
  }
  if (name === 'read_file') {
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Read ${path}` : 'Read file'
  }
  if (name === 'list_directory') {
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Listed ${path}` : 'Listed directory'
  }
  if (FILE_WRITE_TOOL_NAMES.has(name)) {
    if (name === 'move_path') {
      const source = getStringParameter(parameters, ['from', 'source', 'sourcePath', 'path'])
      const destination = getStringParameter(parameters, [
        'to',
        'destination',
        'destinationPath',
        'target'
      ])
      return source && destination ? `Moved ${source} -> ${destination}` : 'Moved path'
    }
    if (name === 'rename_path') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'from', 'source'])
      const newName = getStringParameter(parameters, ['newName', 'name'])
      return path && newName ? `Renamed ${path} -> ${newName}` : 'Renamed path'
    }
    if (name === 'create_directory') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'directory'])
      return path ? `Created directory ${path}` : 'Created directory'
    }
    if (name === 'delete_path') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'directory', 'file'])
      return path ? `Deleted ${path}` : 'Deleted path'
    }
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Edited ${path}` : 'Edited file'
  }
  if (name === 'get_diagnostics') return 'Checked diagnostics'
  if (name === 'git_push') return 'Git push'
  if (name === 'git_create_pr') return 'Git create PR'
  if (name === 'github_ci_status') return 'GitHub CI status'
  if (name === 'run_shell_command' || name === 'shell') return 'Shell command'
  return titleCaseToolName(name) || toolName || 'Used tool'
}

/** File-write tool names that should populate a `diffSummary` so the
 * renderer's `latestRunDiffStats` useMemo counts the file. Mirrors
 * the canonical names recognised by the renderer's solo-path
 * `ToolParser.deriveToolDiffSummary`. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'create_file',
  'apply_patch',
  'patch_file',
  'edit',
  'replace',
  'write',
  'patch',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'fs_write',
  'fs_edit',
  'fs_patch',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path'
])

function singleDiffFilePath(
  diffSummary: ToolActivity['diffSummary'] | undefined
): string | undefined {
  const files = diffSummary?.files
  if (!Array.isArray(files) || files.length !== 1) return undefined
  const path = files[0]?.path
  return typeof path === 'string' && path.trim() ? path : undefined
}

function normalizeToolDiffSummary(
  summary: ToolActivity['diffSummary'] | undefined,
  filePath: string | undefined
): ToolActivity['diffSummary'] | undefined {
  if (!summary) return undefined
  const files =
    Array.isArray(summary.files) && summary.files.length > 0
      ? summary.files.map((file) => ({
          ...file,
          path: file.path || filePath
        }))
      : filePath
        ? [
            {
              path: filePath,
              status: 'modified' as const,
              additions: summary.additions,
              deletions: summary.deletions
            }
          ]
        : undefined
  return {
    ...summary,
    ...(files ? { files } : {}),
    source: summary.source || ('unknown' as const),
    confidence: summary.confidence || ('estimated' as const)
  }
}

export function mergeToolDiffSummaries(
  existing: ToolActivity['diffSummary'] | undefined,
  result: ToolActivity['diffSummary'] | undefined,
  filePath: string | undefined
): ToolActivity['diffSummary'] | undefined {
  const normalizedExisting = normalizeToolDiffSummary(existing, filePath)
  const normalizedResult = normalizeToolDiffSummary(result, filePath)
  if (!normalizedExisting) return normalizedResult
  if (!normalizedResult) return normalizedExisting
  // First-counts-wins below keeps a streamed ensemble activity stable, but it also
  // means a MEASURED summary arriving second is rejected — and one arriving first
  // would be safe only by luck. Assert the precedence explicitly in both directions;
  // everything after this is the pre-existing rule, unchanged.
  if (isMeasuredDiffSummary(normalizedResult) && !isMeasuredDiffSummary(normalizedExisting)) {
    return normalizedResult
  }
  if (isMeasuredDiffSummary(normalizedExisting)) return normalizedExisting
  const existingHasCounts =
    typeof normalizedExisting.additions === 'number' ||
    typeof normalizedExisting.deletions === 'number'
  const resultHasCounts =
    typeof normalizedResult.additions === 'number' || typeof normalizedResult.deletions === 'number'
  if (resultHasCounts && !existingHasCounts) {
    return normalizedResult
  }
  if (
    (!normalizedExisting.files || normalizedExisting.files.length === 0) &&
    normalizedResult.files &&
    normalizedResult.files.length > 0
  ) {
    return {
      ...normalizedExisting,
      files: normalizedResult.files
    }
  }
  return normalizedExisting
}

export function buildEnsembleToolActivity(
  event: any,
  startedAt: string,
  participant?: EnsembleParticipant,
  roster?: readonly EnsembleParticipant[]
): ToolActivity {
  const rawToolName = extractToolName(event)
  const toolKind = extractToolKind(event)
  const rawParameters = extractToolParameters(event)
  const presentation = presentToolInvocation(rawToolName, rawParameters)
  const toolName = canonicalImageViewToolName(presentation.toolName, presentation.parameters)
  const parameterImageCount =
    toolName === IMAGE_VIEW_TOOL_NAME
      ? imageViewCountFromParameters(presentation.parameters)
      : undefined
  const parameters = parameterImageCount
    ? { ...presentation.parameters, imageCount: parameterImageCount }
    : presentation.parameters
  const canonicalToolName = resolveCatalogToolName(toolName) || stripToolNamespace(toolName)
  const category =
    toolName === IMAGE_VIEW_TOOL_NAME ? 'read' : getEnsembleToolCategory(toolName, toolKind)
  const parameterFilePath =
    typeof parameters.file_path === 'string'
      ? (parameters.file_path as string)
      : typeof parameters.path === 'string'
        ? (parameters.path as string)
        : undefined
  // Seed a `diffSummary` for known file-write tool names so the renderer's
  // files-changed counter picks them up. When the tool input contains
  // countable evidence, carry the real +/- counts; otherwise leave counts
  // undefined instead of seeding fake +0/-0 stats that suppress richer
  // renderer-side derivation on the activity row.
  const inputDiffSummary =
    category === 'write'
      ? bridgeToolDiffStats(canonicalToolName, parameters, { writeLike: true })
      : undefined
  const filePath = parameterFilePath || singleDiffFilePath(inputDiffSummary)
  const diffSummary =
    category === 'write'
      ? normalizeToolDiffSummary(
          inputDiffSummary ||
            (filePath
              ? {
                  files: [
                    {
                      path: filePath,
                      status: 'modified' as const
                    }
                  ],
                  source: 'unknown' as const,
                  confidence: 'estimated' as const
                }
              : undefined),
          filePath
        )
      : undefined
  return {
    id: extractToolId(event),
    toolName,
    displayName:
      toolName === IMAGE_VIEW_TOOL_NAME
        ? IMAGE_VIEW_DISPLAY_NAME
        : getEnsembleToolDisplayName(toolName, parameters, participant, roster),
    category,
    status: 'running',
    startedAt,
    parameters,
    filePath,
    ...(diffSummary ? { diffSummary } : {}),
    ...(participant
      ? { metadata: { provider: participant.provider, ensembleProvider: participant.provider } }
      : {}),
    rawUseEvent: event
  }
}

function completedYieldDisplayName(displayName: string, status: ToolActivityStatus): string {
  return displayName.replace(
    /\b(?:yielding|yielded)\b/i,
    status === 'success' ? 'yielded' : 'failed to yield'
  )
}

export function pairEnsembleToolResult(
  activity: ToolActivity,
  event: any,
  endedAt: string
): ToolActivity {
  const status: ToolActivityStatus =
    event?.success === false ||
    event?.error ||
    event?.is_error ||
    event?.status === 'error' ||
    event?.status === 'failed'
      ? 'error'
      : 'success'
  const durationMs = activity.startedAt
    ? new Date(endedAt).getTime() - new Date(activity.startedAt).getTime()
    : undefined
  const output =
    typeof event?.content === 'string'
      ? event.content
      : typeof event?.output === 'string'
        ? event.output
        : typeof event?.result === 'string'
          ? event.result
          : ''
  // Reasoning / thinking traces render in full in the transcript (parity with
  // the renderer's pairToolResult + the bridge-ingest carve-out), so they
  // bypass the 500-char preview cap that bounds ordinary ensemble tool output.
  const reasoningTool = /(?:^|_)(?:thinking|reasoning)$/i.test(
    stripToolNamespace(activity.toolName)
  )
  const cap = reasoningTool ? 100_000 : 500
  const truncated = output.length > cap ? `${output.substring(0, cap)}...` : output
  const imageView = isImageViewToolUse(activity.toolName, activity.parameters)
  const returnedImageCount = imageView ? imageViewCountFromResult(event) : undefined
  const displayName = imageView
    ? IMAGE_VIEW_DISPLAY_NAME
    : stripToolNamespace(activity.toolName) === 'ensemble_yield'
      ? completedYieldDisplayName(activity.displayName, status)
      : activity.displayName
  const resultRecord =
    event?.result && typeof event.result === 'object' && !Array.isArray(event.result)
      ? (event.result as Record<string, unknown>)
      : {}
  const resultParameters = mergeToolResultParameters(activity.parameters, event)
  const resultPresentation = presentToolInvocation(activity.toolName, resultParameters)
  const toolName = resultPresentation.toolName
  const category =
    activity.category === 'unknown'
      ? getEnsembleToolCategory(toolName, extractToolKind(event))
      : activity.category
  const resultInputDiffSummary =
    category === 'write'
      ? bridgeToolDiffStats(toolName, resultPresentation.parameters, { writeLike: true })
      : undefined
  const resultDiffSummary =
    category === 'write'
      ? bridgeResultDiffStats({
          toolName: stripToolNamespace(toolName),
          summary: output,
          changes: event?.changes ?? resultRecord.changes,
          kind: event?.kind ?? resultRecord.kind ?? resultPresentation.parameters.kind
        })
      : undefined
  const inputAndResultDiffSummary = mergeToolDiffSummaries(
    resultInputDiffSummary,
    resultDiffSummary,
    singleDiffFilePath(resultInputDiffSummary) || singleDiffFilePath(resultDiffSummary)
  )
  const resultFilePath = getStringParameter(resultPresentation.parameters, [
    'file_path',
    'filePath',
    'path',
    'TargetFile',
    'targetFile'
  ])
  const diffSummary = mergeToolDiffSummaries(
    activity.diffSummary,
    inputAndResultDiffSummary,
    activity.filePath || resultFilePath || singleDiffFilePath(inputAndResultDiffSummary)
  )
  const filePath = activity.filePath || resultFilePath || singleDiffFilePath(diffSummary)
  const resolvedDisplayName = imageView
    ? IMAGE_VIEW_DISPLAY_NAME
    : stripToolNamespace(toolName) === 'ensemble_yield'
      ? completedYieldDisplayName(activity.displayName, status)
      : activity.filePath || !filePath
        ? displayName
        : getEnsembleToolDisplayName(toolName, resultPresentation.parameters)
  return {
    ...activity,
    ...(imageView
      ? {
          toolName: IMAGE_VIEW_TOOL_NAME,
          category: 'read' as const,
          parameters: returnedImageCount
            ? { ...(activity.parameters || {}), imageCount: returnedImageCount }
            : activity.parameters
        }
      : {}),
    ...(imageView
      ? {}
      : {
          toolName,
          category,
          parameters: resultPresentation.parameters
        }),
    status,
    displayName: resolvedDisplayName,
    endedAt,
    durationMs,
    ...(filePath ? { filePath } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    resultSummary: truncated,
    outputPreview: truncated,
    rawResultEvent: event
  }
}
