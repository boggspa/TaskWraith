import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import {
  ChatRecord,
  ChildAgentThread,
  DiffFileStatus,
  DiffFileSummary,
  EnsembleParticipant,
  ProviderId,
  ToolActivity,
  ToolDiffFileSummary,
  ToolDiffSummary
} from '../../../main/store/types'
import {
  deriveToolDiffSummary,
  extractMcpImageBlocks,
  getToolDisplayName,
  isErroredToolStatus,
  isReasoningToolName,
  isWriteLikeToolName,
  prettyPrintJson,
  unwrapMcpEnvelope
} from '../lib/ToolParser'
import { deriveChildAgentThreadsFromActivities } from '../lib/ChildAgentThreads'
import { isClaudeWorkflowToolName } from '../../../shared/claudeWorkflow'
import { ClaudeWorkflowCard } from './ClaudeWorkflowCard'
import { hasExpandableDetail } from '../lib/ActivityRenderMode'
import { inlineStatsForActivity } from '../lib/ActivityInlineStats'
import { displayPathRelativeToWorkspace } from '../lib/ActivityPathDisplay'
import { FileTypeIcon } from './FileTypeIcon'
import { DigitOdometer } from './DigitOdometer'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { ToolFamilyIcon, toolNameToFamily, type ToolFamily } from './icons/ToolFamilyIcon'
import { CreativeTimelineDiffCard } from './CreativeTimelineDiffCard'
import { creativeTimelineDiffModelFromActivity } from './CreativeTimelineDiffCardModel'
import { CompactToolTrace } from './CompactToolTrace'
import { LiveActivityViewport } from './LiveActivityViewport'
import { MarkdownMessage } from './MarkdownMessage'
import { TodoChecklistCard } from './TodoChecklistCard'
import {
  computeMergedTodosByActivityId,
  computeMergedTodosByLane,
  computeMergedTodosFromActivities,
  TODO_SOLO_LANE,
  isTodoToolName,
  parseTodoItemsFromActivity,
  summarizeTodoProgress,
  type TodoItem
} from '../../../main/TodoList'
import { durationLabel } from './CompactToolTrace.lib'
import { isGlobalChat } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import {
  agentInvocationRouteLabel,
  agentInvocationSourceClassName,
  agentInvocationSourceLabel,
  childAgentInteractivityLabel,
  childAgentStateLabel
} from '../lib/AgentInvocationPresentation'
import {
  DIFF_HOVER_PREVIEW_TOOLTIP_ID,
  DiffHoverPreviewOverlay,
  type DiffHoverPreviewState,
  diffHoverPreviewBoundaryForElement,
  useDiffHoverPreviewDismiss,
  useDiffHoverPreviewState
} from './DiffHoverPreview'

interface ActivityStackProps {
  activities: ToolActivity[]
  workspacePath?: string
  provider?: ProviderId
  chatId?: string
  runId?: string
  /** Chat record — when present, subagent threads pick up a stable visual
   * identity (name + color) via `assignAgentIdentity`. */
  chat?: ChatRecord
  /** Phase L3 slice 6 — when true (from `settings.compactDensity`),
   * tool cards collapse to their inline form and the turn-receipt
   * tape switches to its one-line summary variant. */
  compactDensity?: boolean
  /** When true (default from `settings.liveActivityViewport`), tool activity
   * renders inside the Cursor-style {@link LiveActivityViewport}: a bounded,
   * edge-faded region that auto-follows while activity is still live and
   * remains scrollable after the activity settles. */
  liveActivityViewport?: boolean
  /**
   * 1.0.6-TV2 — optional controlled expansion. When BOTH are provided
   * the stack's per-row expansion set is owned by the parent instead of
   * local state, so it survives the unmount/remount cycle of transcript
   * virtualisation (a tool row scrolled out of the window and back keeps
   * whatever the user had open). Omit both for the original uncontrolled
   * behaviour — every existing call site is untouched.
   */
  expandedActivityIds?: Set<string>
  onExpandedActivityIdsChange?: (next: Set<string>) => void
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
}

function providerFromPlanLane(lane: string): ProviderId | undefined {
  switch (lane) {
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'ollama':
    case 'gemini':
      return lane as ProviderId
    default:
      return undefined
  }
}

function planLanePresentation(lane: string, participants?: EnsembleParticipant[]) {
  const participant = participants?.find((item) => item.id === lane)
  const provider = participant?.provider || providerFromPlanLane(lane)
  const providerLabel = provider ? getProviderLabel(provider) : ''
  const label =
    participant?.role && providerLabel
      ? `${participant.role} / ${providerLabel}`
      : providerLabel || participant?.role || lane
  return {
    label,
    order: typeof participant?.order === 'number' ? participant.order : Number.MAX_SAFE_INTEGER
  }
}

const SEARCH_PARAM_KEYS = ['query', 'search_query', 'pattern', 'regex', 'term']
const COMMAND_PARAM_KEYS = ['command', 'cmd', 'script']
const CONTENT_PARAM_KEYS = ['content', 'new_string', 'old_string']
const PATH_PARAM_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_file',
  'target_file_path'
]
const ACTIVITY_DIFF_PREVIEW_PARAM_KEYS = [
  'patchPreview',
  'patch_preview',
  'patch',
  'diff',
  'unifiedDiff',
  'unified_diff'
]
// 1.0.4-AS2 — exported so the ensemble-collapse predicate test
// can assert the shape of `buildTimelineItems`'s output without
// touching the React render tree.
export type ActivityTimelineItem =
  | { type: 'activity'; activity: ToolActivity }
  | { type: 'compact-group'; id: string; activities: ToolActivity[] }

interface SanitizedDetail {
  rows: Array<{ label: string; value: string }>
  previews: Array<{
    label: string
    content: string
    terminal?: boolean
    tone?: 'addition' | 'deletion' | 'diff' | 'neutral'
  }>
}

function getStringParam(parameters: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

interface TruncateOptions {
  maxLength?: number
  /** Soft cap for line count. When the content exceeds this many
   * newlines AND `maxLength` characters, the truncation footer
   * reports both numbers. Defaults to 60 — generous for command
   * output, tight enough to keep the DOM bounded. */
  maxLines?: number
  /** Optional footer message used when truncation actually fires.
   * Receives the dropped-character count and dropped-line count;
   * default produces something like
   * `\n[+1240 chars · 60 lines hidden — open raw events for full output]`. */
  footer?: (droppedChars: number, droppedLines: number) => string
}

function defaultTruncationFooter(droppedChars: number, droppedLines: number): string {
  const lineFragment = droppedLines > 0 ? ` · ${droppedLines.toLocaleString()} lines hidden` : ''
  return `\n\n[+${droppedChars.toLocaleString()} chars${lineFragment} — open raw events for full output]`
}

function truncateText(value: string, optionsOrMaxLength: number | TruncateOptions = 420): string {
  const opts: TruncateOptions =
    typeof optionsOrMaxLength === 'number' ? { maxLength: optionsOrMaxLength } : optionsOrMaxLength
  const maxLength = opts.maxLength ?? 420
  const maxLines = opts.maxLines ?? Infinity
  const footerFn = opts.footer ?? defaultTruncationFooter
  const normalized = value.trim()
  const lines = normalized.split('\n')
  const charsOverflow = normalized.length > maxLength
  const linesOverflow = lines.length > maxLines
  if (!charsOverflow && !linesOverflow) {
    return normalized
  }
  // Find the largest prefix that respects both bounds.
  let charsKept = Math.min(normalized.length, maxLength)
  if (linesOverflow) {
    const linesKept = lines.slice(0, maxLines).join('\n').length
    charsKept = Math.min(charsKept, linesKept)
  }
  const prefix = normalized.slice(0, charsKept)
  const droppedChars = normalized.length - charsKept
  const droppedLines = lines.length - prefix.split('\n').length
  return `${prefix}${footerFn(droppedChars, Math.max(0, droppedLines))}`
}

function cleanProgressText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(/^[\s#>*![\]A-Z:_-]*(Topic|Summary|Intent|Strategic intent)\s*:\s*/gim, '')
    .replace(/\*\*(Topic|Summary|Intent|Strategic intent)\s*:\*\*/gim, '')
    .replace(/\[!STRATEGY\]/gi, '')
    .replace(/[📂📁]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned || cleaned === '...' || cleaned === '…') return undefined
  return truncateText(cleaned, 360)
}

function countLines(value: string): number {
  if (!value) {
    return 0
  }
  return value.split('\n').length
}

function getActivityKind(activity: ToolActivity): string {
  return (activity.toolName || activity.category || '').toLowerCase()
}

function isSearchActivity(activity: ToolActivity): boolean {
  const kind = getActivityKind(activity)
  return (
    activity.category === 'search' || kind.includes('search') || kind === 'grep' || kind === 'rg'
  )
}

function isShellActivity(activity: ToolActivity): boolean {
  const kind = getActivityKind(activity)
  return activity.category === 'shell' || kind === 'run_shell_command' || kind === 'shell'
}

function buildSanitizedDetail(
  activity: ToolActivity,
  activityFilePath?: string,
  addedLines?: number,
  deletedLines?: number
): SanitizedDetail {
  const parameters = activity.parameters || {}
  const rows: SanitizedDetail['rows'] = []
  const previews: SanitizedDetail['previews'] = []
  const resultText = activity.resultSummary || activity.outputPreview || ''
  const toolName = (activity.toolName || '').toLowerCase()
  const content = getStringParam(parameters, CONTENT_PARAM_KEYS)
  const command = getStringParam(parameters, COMMAND_PARAM_KEYS)
  const query = getStringParam(parameters, SEARCH_PARAM_KEYS)

  if (activityFilePath) {
    rows.push({ label: 'File', value: activityFilePath })
  }

  if (isShellActivity(activity)) {
    const cwd = getStringParam(parameters, ['cwd', 'working_directory', 'workingDirectory'])
    if (cwd) {
      rows.push({ label: 'Working directory', value: cwd })
    }
    if (command) {
      previews.push({ label: 'Command', content: command, terminal: true })
    }
    if (resultText) {
      previews.push({
        label: activity.status === 'error' ? 'Error output' : 'Output',
        // Phase L5 slice 1 — bump shell-output limit from 1000 chars
        // to 6000 chars / 60 lines, with the structured footer
        // pointing at the raw-events drawer for full content. A
        // single chatty `git log` output used to either be brutally
        // cut at 1000 chars (lost lots of context) or, prior to the
        // truncation in place, dump 50kb into the DOM. The new
        // bound gives the user useful context without blowing up
        // the activity panel.
        content: truncateText(resultText, { maxLength: 6000, maxLines: 60 }),
        terminal: true
      })
    }
    return { rows, previews }
  }

  if (isSearchActivity(activity)) {
    const scope = getStringParam(parameters, ['path', 'dir', 'directory', 'include', 'glob'])
    if (query) {
      rows.push({ label: toolName.includes('web_search') ? 'Search' : 'Pattern', value: query })
    }
    if (scope) {
      rows.push({ label: 'Scope', value: scope })
    }
    if (resultText) {
      previews.push({ label: 'Result', content: truncateText(resultText), tone: 'neutral' })
    }
    return { rows, previews }
  }

  if (activity.category === 'task') {
    if (isTodoToolName(toolName) && parseTodoItemsFromActivity(activity).length > 0) {
      return { rows, previews }
    }
    if (resultText) {
      const reasoning = toolName === 'codex_reasoning' || isReasoningToolName(toolName)
      // Reasoning renders in full so the user can read it inline (no Raw Events
      // detour), bounded only by a generous ceiling so a pathological multi-100KB
      // trace can't reparse a giant markdown block per streaming frame when a
      // live row is expanded. A length gate (not activity.status) is deliberate:
      // only Codex streams reasoning as 'running' — the `_thinking` providers
      // emit interim chunks as 'success', so a status gate would be a no-op for
      // them.
      previews.push({
        label: reasoning ? 'Thoughts' : 'Update',
        content: truncateText(resultText, {
          maxLength: reasoning ? 50000 : 6000,
          maxLines: reasoning ? 600 : 60
        }),
        tone: 'neutral'
      })
    }
    return { rows, previews }
  }

  if (activity.category === 'write' || isWriteLikeToolName(toolName)) {
    // A denied/errored write changed nothing — don't assert "Wrote file" in
    // the detail row either; mirror the title's attempted framing.
    const denied = isErroredToolStatus(activity.status)
    const operation =
      toolName === 'create_file'
        ? denied
          ? 'Attempted to create file (not applied)'
          : 'Created file'
        : toolName === 'replace'
          ? denied
            ? 'Attempted to edit file (not applied)'
            : 'Edited file'
          : denied
            ? 'Attempted to write file (not applied)'
            : 'Wrote file'
    rows.push({ label: 'Action', value: operation })

    if (addedLines !== undefined || deletedLines !== undefined) {
      rows.push({ label: 'Diff', value: `+${addedLines || 0} / -${deletedLines || 0}` })
    } else if (content) {
      rows.push({
        label: 'Content',
        value: `${countLines(content)} line${countLines(content) === 1 ? '' : 's'}`
      })
    }

    const patchPreview = typeof parameters.patchPreview === 'string' ? parameters.patchPreview : ''
    if (patchPreview) {
      previews.push({
        label: 'Patch preview',
        content: truncateText(patchPreview, 1400),
        tone: 'diff'
      })
    }

    if (toolName === 'replace') {
      const oldString = typeof parameters.old_string === 'string' ? parameters.old_string : ''
      const newString = typeof parameters.new_string === 'string' ? parameters.new_string : ''
      if (oldString)
        previews.push({ label: 'Removed', content: truncateText(oldString), tone: 'deletion' })
      if (newString)
        previews.push({ label: 'Added', content: truncateText(newString), tone: 'addition' })
    } else if (content) {
      previews.push({ label: 'Added content', content: truncateText(content), tone: 'addition' })
    }

    if (resultText) {
      previews.push({ label: 'Result', content: truncateText(resultText), tone: 'neutral' })
    }
    return { rows, previews }
  }

  const pathValue = getStringParam(parameters, PATH_PARAM_KEYS)
  if (!activityFilePath && pathValue) {
    rows.push({ label: 'Path', value: pathValue })
  }
  if (query) {
    rows.push({ label: 'Query', value: query })
  }
  if (content) {
    rows.push({
      label: 'Content',
      value: `${countLines(content)} line${countLines(content) === 1 ? '' : 's'}`
    })
    previews.push({ label: 'Content preview', content: truncateText(content), tone: 'diff' })
  }
  if (resultText) {
    previews.push({ label: 'Result', content: truncateText(resultText), tone: 'neutral' })
  }

  return { rows, previews }
}

function getFilePathFromActivity(activity: ToolActivity): string | undefined {
  const candidateFields: string[] = [
    'file_path',
    'filePath',
    'path',
    'target',
    'target_file',
    'target_file_path',
    'source',
    'source_file',
    'source_file_path',
    'destination',
    'destination_file',
    'destination_file_path'
  ]

  for (const field of candidateFields) {
    const value = activity.parameters?.[field]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  if (activity.filePath && typeof activity.filePath === 'string' && activity.filePath.trim()) {
    return activity.filePath.trim()
  }

  if (
    activity.affectedFilePath &&
    typeof activity.affectedFilePath === 'string' &&
    activity.affectedFilePath.trim()
  ) {
    return activity.affectedFilePath.trim()
  }

  return undefined
}

function getActivityDiffPreviewText(activity: ToolActivity): string {
  const parameters = activity.parameters || {}
  for (const key of ACTIVITY_DIFF_PREVIEW_PARAM_KEYS) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }

  const resultText = activity.resultSummary || activity.outputPreview || ''
  return /^(?:diff --git|@@\s|---\s|\+\+\+\s)/m.test(resultText) ? resultText : ''
}

function getActivityDiffPreviewPath(
  activity: ToolActivity,
  activityFilePath?: string,
  diffSummary?: ToolDiffSummary
): string {
  const summaryPath = diffSummary?.files?.find((file) => file.path?.trim())?.path
  return (
    activityFilePath ||
    summaryPath ||
    activity.displayName ||
    activity.toolName ||
    'Tool diff'
  )
}

const WORKBENCH_DIFF_STATUSES = new Set<DiffFileStatus>([
  'modified',
  'created',
  'deleted',
  'renamed',
  'untracked',
  'binary',
  'too_large',
  'hidden_sensitive',
  'noise'
])

const normalizeActivityWorkbenchPath = (
  filePath: string | undefined,
  workspacePath?: string
): string => {
  const normalizedPath = filePath?.trim().replace(/\\/g, '/')
  if (!normalizedPath) return ''
  if (!normalizedPath.startsWith('/')) return normalizedPath.replace(/^\.\/+/, '')
  if (!workspacePath) return ''

  const normalizedWorkspace = workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedWorkspace) return ''
  if (normalizedPath === normalizedWorkspace) return ''
  if (normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1)
  }
  return ''
}

const normalizeActivityWorkbenchStatus = (
  status: ToolDiffFileSummary['status'] | undefined
): DiffFileStatus => {
  if (status && WORKBENCH_DIFF_STATUSES.has(status as DiffFileStatus)) {
    return status as DiffFileStatus
  }
  return status === 'deleted' ? 'deleted' : 'modified'
}

export const buildActivityWorkbenchDiffSummary = ({
  activityFilePath,
  diffSummary,
  diffText,
  workspacePath
}: {
  activityFilePath?: string
  diffSummary?: ToolDiffSummary
  diffText?: string
  workspacePath?: string
}): DiffFileSummary | null => {
  const diffFile = diffSummary?.files?.find((file) => file.path?.trim())
  const path = normalizeActivityWorkbenchPath(activityFilePath || diffFile?.path, workspacePath)
  if (!path) return null
  return {
    path,
    status: normalizeActivityWorkbenchStatus(diffFile?.status),
    additions: diffFile?.additions ?? diffSummary?.additions,
    deletions: diffFile?.deletions ?? diffSummary?.deletions,
    previewKind: diffText ? 'git_diff' : 'none',
    diffText
  }
}

function getBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path
}

function getFileActionLabel(activity: ToolActivity): string {
  const toolName = (activity.toolName || '').toLowerCase()
  if (
    toolName === 'replace' ||
    toolName === 'edit_file' ||
    toolName === 'edit' ||
    toolName === 'multiedit' ||
    toolName === 'notebookedit' ||
    toolName === 'apply_patch' ||
    toolName.includes('str_replace') ||
    toolName.endsWith('__replace') ||
    toolName.endsWith('__edit_file') ||
    toolName.endsWith('__apply_patch')
  )
    return 'Edited'
  if (toolName === 'create_file' || toolName.endsWith('__create_file')) return 'Created'
  if (toolName === 'create_directory' || toolName.endsWith('__create_directory')) return 'Created'
  if (
    toolName === 'delete_file' ||
    toolName === 'delete_path' ||
    toolName.endsWith('__delete_file') ||
    toolName.endsWith('__delete_path')
  )
    return 'Deleted'
  if (toolName === 'move_path' || toolName.endsWith('__move_path')) return 'Moved'
  if (toolName === 'rename_path' || toolName.endsWith('__rename_path')) return 'Renamed'
  if (
    toolName === 'write_file' ||
    toolName === 'write' ||
    toolName.endsWith('__write_file') ||
    toolName.endsWith('__write')
  )
    return 'Wrote'
  if (toolName === 'read_file') return 'Read'
  return activity.displayName || activity.toolName || 'Used tool'
}

/**
 * Base verb for an attempted-but-denied/errored write, used by
 * `ActivityTitle` to render "Attempted to edit README.md" instead of the
 * success-implying "Wrote README.md" when the edit's RESULT was a rejection
 * or error. Defaults to "edit" — the common write op (search_replace /
 * replace / apply_patch / Edit) — and only narrows to write/create/delete
 * when the tool name says so.
 */
function attemptedWriteVerb(activity: ToolActivity): string {
  const toolName = (activity.toolName || '').toLowerCase()
  if (toolName.includes('delete')) return 'delete'
  if (toolName.includes('move')) return 'move'
  if (toolName.includes('rename')) return 'rename'
  if (toolName.includes('create')) return 'create'
  if (
    toolName === 'write' ||
    toolName === 'write_file' ||
    toolName.endsWith('__write') ||
    toolName.endsWith('__write_file')
  )
    return 'write'
  return 'edit'
}

/**
 * 1.0.4 — Render an ensemble_yield tool-activity title as structured
 * JSX with the target participant rendered as an `@-mention` chip
 * tinted with the target's provider colour. Used by both the inline
 * row title and the larger card title so the rendering is consistent
 * regardless of which call path produced the activity (renderer-side
 * `createToolActivity`, orchestrator-side `buildEnsembleToolActivity`,
 * or any future shape).
 *
 * The fallback shape is "Yielding to @<target>"; when the activity's
 * `displayName` already carries an actor prefix ("Codex yielding to
 * Gems" from the orchestrator), we surface that too as "Codex yielding
 * to @<target>".
 *
 * `participants` is optional — when present we resolve the target
 * string against the participant roster (role / provider / model
 * alias, case-insensitive) so the chip can carry a `data-provider`
 * attribute the CSS keys off for the colour tint. Without it the chip
 * still renders, just without provider colouring.
 */
function renderEnsembleYieldTitle(
  activity: ToolActivity,
  participants?: EnsembleParticipant[]
): ReactNode {
  const params = activity.parameters || {}
  const target = (getStringParam(params, ['target', 'participant', 'to', 'next']) || '').trim()

  let targetProvider: ProviderId | undefined
  let targetProviderClass: string | undefined
  if (target && participants && participants.length > 0) {
    // 1.0.4 — agents often emit compound target strings like
    // "Kimi / Captain K" (provider + role), "@Captain K" (with @
    // prefix), or "Captain K" (bare role). Strip leading @ and
    // split on common separators so we try each token against the
    // participant roster — first as an exact match, then as a
    // substring fallback. Without this, the chip stayed neutral
    // grey for compound targets even though the participant was
    // resolvable.
    const stripped = target.replace(/^@+/, '').trim().toLowerCase()
    const tokens = [
      stripped,
      ...stripped
        .split(/[/,|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    ]
    const matched = participants.find((p) => {
      const role = (p.role || '').toLowerCase()
      const provider = (p.provider || '').toLowerCase()
      const id = (p.id || '').toLowerCase()
      for (const token of tokens) {
        if (role === token) return true
        if (provider === token) return true
        if (id === token) return true
      }
      return false
    })
    if (matched) {
      targetProvider = matched.provider
      // Ollama-backed display brands resolve to their spoofed brand hue
      // class (e.g. `alibaba`) so the yield chip matches the brand tint
      // used by the transcript header and @-mention chips.
      targetProviderClass = resolveProviderHueClass(matched.provider, matched.model)
    }
  }

  // Pull actor prefix from the orchestrator's displayName when it
  // matches the canonical "X yielding to Y" shape. Falls back to no
  // actor when the displayName is the raw tool name (e.g. when the
  // activity was constructed by the renderer-side path without an
  // orchestrator participant context).
  const display = activity.displayName || ''
  const actorMatch = display.match(/^(.+?)\s+yielding\b/i)
  const actor = actorMatch && !actorMatch[1].toLowerCase().includes('_') ? actorMatch[1] : ''

  if (!target) {
    return <>{actor ? `${actor} yielding` : 'Yielding'}</>
  }

  const chip = (
    <span
      className={`activity-yield-target${targetProviderClass ? ` provider-${targetProviderClass}` : ''}`}
      data-provider={targetProvider || ''}
    >
      @{target}
    </span>
  )

  return (
    <>
      {actor ? `${actor} yielding to ` : 'Yielding to '}
      {chip}
    </>
  )
}

function getReadableActivityDisplayName(activity: ToolActivity): string {
  const fallback = getToolDisplayName(activity.toolName || '', activity.parameters || {})
  const displayName = activity.displayName || ''
  const rawToolName = activity.toolName || ''
  const lowerDisplay = displayName.toLowerCase()
  const displayLooksRaw =
    !displayName ||
    displayName === rawToolName ||
    lowerDisplay.startsWith('mcp_taskwraith-broker_') ||
    lowerDisplay.startsWith('mcp_taskwraith-broker-') ||
    lowerDisplay.startsWith('mcp_taskwraith_') ||
    lowerDisplay.startsWith('mcp_taskwraith-') ||
    lowerDisplay.startsWith('mcp__taskwraith-broker__') ||
    lowerDisplay.startsWith('mcp__taskwraith__') ||
    lowerDisplay.startsWith('taskwraith-broker__') ||
    lowerDisplay.startsWith('taskwraith_broker__') ||
    lowerDisplay.startsWith('taskwraith__') ||
    lowerDisplay.includes('_')
  return displayLooksRaw ? fallback || displayName || rawToolName : displayName
}

function isCallMcpToolActivity(activity: ToolActivity): boolean {
  const toolName = (activity.toolName || '').trim().toLowerCase()
  const displayName = (activity.displayName || '').trim().toLowerCase()
  return toolName === 'callmcptool' || displayName === 'used callmcptool'
}

function isThinkingTraceActivity(activity: ToolActivity): boolean {
  if (isReasoningToolName(activity.toolName || '')) return true
  const displayName = (activity.displayName || '').trim().toLowerCase()
  return (
    displayName === 'thinking' ||
    displayName === 'reasoning' ||
    displayName.endsWith(' thinking') ||
    displayName.endsWith(' reasoning')
  )
}

function activityProvider(activity: ToolActivity, fallback?: ProviderId): ProviderId | undefined {
  return activity.metadata?.ensembleProvider || activity.metadata?.provider || fallback
}

const CALL_MCP_TOOL_EASTER_EGG_FAMILIES: ToolFamily[] = [
  'mcp',
  'shell',
  'search',
  'edit',
  'browser',
  'task'
]

type CallMcpToolEasterEggStyle = CSSProperties & {
  '--callmcp-delay': string
}

function CallMcpToolEasterEgg() {
  return (
    <span
      className="callmcp-tool-easter-egg"
      role="img"
      aria-label="Used callmcptool"
      title="Used callmcptool"
    >
      {CALL_MCP_TOOL_EASTER_EGG_FAMILIES.map((family, index) => (
        <span
          key={family}
          className="callmcp-tool-easter-egg-icon"
          style={{ '--callmcp-delay': `${index * -0.16}s` } as CallMcpToolEasterEggStyle}
          aria-hidden="true"
        >
          <ToolFamilyIcon family={family} size={18} />
        </span>
      ))}
    </span>
  )
}

function getProgressNote(activity: ToolActivity): { title: string; body?: string } | null {
  if (activity.category !== 'task') return null
  // 1.4.2 — todo_write / update_todo_list render as checklist cards.
  if (isTodoToolName(activity.toolName)) return null
  // ensemble_yield is a `task`-category tool but has its own structured
  // render (actor + provider-tinted target chip) in `renderEnsembleYieldTitle`.
  // The generic progress-note path renders `activity.displayName` verbatim,
  // which surfaces the raw tool name (`mcp_TaskWraith_ensemble_yield`) on any
  // upstream that didn't pre-humanize it. Defer those rows to the inline
  // title path so the chip render runs.
  if ((activity.toolName || '').toLowerCase().includes('ensemble_yield')) return null
  const parameters = activity.parameters || {}
  const title =
    cleanProgressText(parameters.title) ||
    cleanProgressText(parameters.topic) ||
    cleanProgressText(activity.displayName) ||
    'Progress update'
  const body =
    cleanProgressText(parameters.strategic_intent) ||
    cleanProgressText(parameters.intent) ||
    cleanProgressText(parameters.summary) ||
    cleanProgressText(parameters.message) ||
    cleanProgressText(activity.resultSummary) ||
    cleanProgressText(activity.outputPreview)

  if (!title && !body) return null
  return {
    title: title || 'Progress update',
    ...(body && body !== title ? { body } : {})
  }
}

function ToolCategoryIcon({ category }: { category?: string }) {
  const cls = 'activity-category-icon'
  switch (category) {
    case 'read':
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="1" width="9" height="11" rx="1.5" />
          <line x1="4" y1="4.5" x2="9" y2="4.5" />
          <line x1="4" y1="6.5" x2="9" y2="6.5" />
          <line x1="4" y1="8.5" x2="7.5" y2="8.5" />
        </svg>
      )
    case 'write':
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8.5,2 L11,4.5 L4.5,11 L2,11.5 L2.5,9 Z" />
          <line x1="7" y1="3.5" x2="9.5" y2="6" />
        </svg>
      )
    case 'shell':
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1" y="2" width="11" height="9" rx="1.5" />
          <polyline points="3.5,5.5 6,7 3.5,8.5" />
          <line x1="7" y1="9" x2="10" y2="9" />
        </svg>
      )
    case 'search':
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="5.5" cy="5.5" r="3.5" />
          <line x1="8.1" y1="8.1" x2="11" y2="11" />
        </svg>
      )
    case 'task':
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6.5,1.5 L7.8,5 L11.5,5 L8.5,7.3 L9.8,11 L6.5,8.8 L3.2,11 L4.5,7.3 L1.5,5 L5.2,5 Z" />
        </svg>
      )
    default:
      return (
        <svg
          className={cls}
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="6.5" cy="6.5" r="4.5" strokeDasharray="2.5 1.5" />
          <circle cx="6.5" cy="6.5" r="1.5" />
        </svg>
      )
  }
}

function ActivityStatusIcon({ status }: { status: ToolActivity['status'] }) {
  switch (status) {
    case 'running':
      return (
        <span className="activity-status running">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="5" strokeDasharray="20 11" className="activity-status-spin" />
          </svg>
        </span>
      )
    case 'success':
      return (
        <span className="activity-status success">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="7" cy="7" r="5.5" />
            <polyline points="4.5,7 6.2,8.8 9.5,5.2" />
          </svg>
        </span>
      )
    case 'warning':
      return (
        <span className="activity-status warning">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="7,1.5 13,12.5 1,12.5" />
            <line x1="7" y1="5.5" x2="7" y2="8.5" />
            <circle cx="7" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
        </span>
      )
    case 'error':
      return (
        <span className="activity-status error">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="5.5" />
            <line x1="4.8" y1="4.8" x2="9.2" y2="9.2" />
            <line x1="9.2" y1="4.8" x2="4.8" y2="9.2" />
          </svg>
        </span>
      )
    default:
      return (
        <span className="activity-status" style={{ color: 'var(--text-muted)' }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="5.5" strokeDasharray="3 2" opacity="0.5" />
          </svg>
        </span>
      )
  }
}

function getActivityDurationTotal(activities: ToolActivity[]): number | undefined {
  const total = activities.reduce((sum, activity) => sum + (activity.durationMs || 0), 0)
  return total > 0 ? total : undefined
}

/**
 * 1.0.4-AS2b — extracted so the label-generation logic can be
 * unit-tested without instantiating the full
 * `ActivityCompactGroup` React component. Returns the header
 * string the group's button shows when collapsed.
 *
 * Pure read/search groups get the legacy descriptive phrasing
 * ("Read 5 files and searched 2 times"). Heterogeneous /
 * Ensemble-mode groups pick the dominant category and emit
 * category-specific phrasing ("Edited 3 files", "Ran 2
 * commands"), with a "+N more" suffix when other categories
 * are present. Groups with NO categorisable activities fall
 * back to "Used N tools" — slightly less opaque than the
 * pre-AS2b "N activities".
 */
export function buildCompactGroupLabel(activities: readonly ToolActivity[]): string {
  const searchCount = activities.filter(isSearchActivity).length
  const readCount = activities.filter((a) => a.category === 'read' && !isSearchActivity(a)).length
  const writeCount = activities.filter((a) => a.category === 'write').length
  const shellCount = activities.filter((a) => a.category === 'shell').length
  const taskCount = activities.filter((a) => a.category === 'task').length
  const otherCount = activities.length - searchCount - readCount

  if (otherCount === 0) {
    if (searchCount > 0 && readCount > 0) {
      return `Read ${readCount} ${readCount === 1 ? 'file' : 'files'} and searched ${searchCount} ${searchCount === 1 ? 'time' : 'times'}`
    }
    if (searchCount > 0) {
      return `Searched ${searchCount} ${searchCount === 1 ? 'time' : 'times'}`
    }
    return `Read ${readCount} ${readCount === 1 ? 'file' : 'files'}`
  }

  const counts: Array<[number, string]> = [
    [writeCount, `Edited ${writeCount} ${writeCount === 1 ? 'file' : 'files'}`],
    [shellCount, `Ran ${shellCount} ${shellCount === 1 ? 'command' : 'commands'}`],
    [readCount, `Read ${readCount} ${readCount === 1 ? 'file' : 'files'}`],
    [searchCount, `Searched ${searchCount} ${searchCount === 1 ? 'time' : 'times'}`],
    [taskCount, `Completed ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`]
  ]
  counts.sort((a, b) => b[0] - a[0])
  const [dominantCount, dominantLabel] = counts[0]
  if (dominantCount === 0) {
    const total = activities.length
    return `Used ${total} ${total === 1 ? 'tool' : 'tools'}`
  }
  const remainder = activities.length - dominantCount
  if (remainder <= 0) return dominantLabel
  return `${dominantLabel} (+${remainder} more)`
}

/** Grouping key for same-tool folding — a run folds only when consecutive
 * calls share BOTH the acting provider AND the tool family. Keying on the
 * provider keeps ENSEMBLE cross-provider attribution intact (Codex's edit
 * and Claude's edit never merge into one anonymous "Edited 2 files"
 * group); single-provider chats have one actor so this reduces to pure
 * family grouping (consistent behaviour). Search is split from generic
 * reads (distinct tools). */
function activityFamilyKey(activity: ToolActivity): string {
  const actor = activity.metadata?.ensembleProvider ?? activity.metadata?.provider ?? ''
  const family = isSearchActivity(activity) ? 'search' : activity.category
  return `${actor}|${family}`
}

/**
 * Whether an activity can fold into a same-tool compact group.
 * Unified across single-provider + ensemble chats (1.0.74): every
 * TERMINAL activity is groupable EXCEPT errors / running / pending
 * (those stay inline so the active step + anything to act on is
 * always readable) and `ensemble_yield` (the social-glue routing
 * chip the user follows the conversation by).
 */
function isGroupableActivity(activity: ToolActivity): boolean {
  if (activity.status === 'error' || activity.status === 'running' || activity.status === 'pending')
    return false
  // `ensemble_yield` activities stay inline even when terminal —
  // they're the social glue between turns (provider-tinted target
  // chip + role name) carrying high-signal routing info, not the
  // every-turn noise that file reads / shell calls produce. Match
  // every aliased form: bare `ensemble_yield`,
  // `mcp_TaskWraith_ensemble_yield` (Codex), `mcp__TaskWraith__ensemble_yield`
  // (Claude), and any future namespaced variant.
  const tool = (activity.toolName || '').toLowerCase()
  if (tool.includes('ensemble_yield')) return false
  // Claude-native Workflow runs render as a dedicated live card and must stay
  // inline (never swept into a "used N tools" compact group), even once terminal.
  if (isClaudeWorkflowToolName(activity.toolName)) return false
  return true
}

/**
 * Group the activity timeline into same-tool compact groups (1.0.74).
 *
 * Unified across single-provider AND ensemble chats — both behave
 * identically (consistency + clarity over per-mode cleverness). Runs
 * of 2+ CONSECUTIVE terminal activities of the SAME family (reads,
 * edits, shells, searches, tasks…) collapse into one expandable
 * `compact-group`; clicking it reveals every call in the run
 * (Codex/Claude-style). A family change breaks the run, so distinct
 * tools never merge into a vague "used N tools" blob. Errors,
 * running, pending and `ensemble_yield` stay inline.
 */
export function buildTimelineItems(activities: ToolActivity[]): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = []
  let index = 0
  // A solitary terminal activity carries useful context (which file,
  // which command, the args) that a group header hides — so require
  // at least 2 consecutive same-family calls before grouping.
  const minGroupSize = 2

  while (index < activities.length) {
    const activity = activities[index]
    if (!isGroupableActivity(activity)) {
      items.push({ type: 'activity', activity })
      index += 1
      continue
    }

    const familyKey = activityFamilyKey(activity)
    const group: ToolActivity[] = []
    while (
      index < activities.length &&
      isGroupableActivity(activities[index]) &&
      activityFamilyKey(activities[index]) === familyKey
    ) {
      group.push(activities[index])
      index += 1
    }

    if (group.length >= minGroupSize) {
      items.push({ type: 'compact-group', id: `${group[0].id}-${group.length}`, activities: group })
    } else {
      for (const groupedActivity of group) {
        items.push({ type: 'activity', activity: groupedActivity })
      }
    }
  }

  return items
}

function ActivityProgressNote({
  activity,
  provider
}: {
  activity: ToolActivity
  provider?: ProviderId
}) {
  const note = getProgressNote(activity)
  if (!note) return null
  const isThinkingTrace = isThinkingTraceActivity(activity)
  const noteProvider = activityProvider(activity, provider)
  const providerLabel = noteProvider ? getProviderLabel(noteProvider) : undefined

  return (
    <div
      className={`activity-progress-note status-${activity.status}${isThinkingTrace ? ' is-thinking-trace' : ''}`}
      data-provider={noteProvider || 'unknown'}
    >
      {isThinkingTrace ? (
        <ToolFamilyIcon
          family="reasoning"
          size={18}
          className="activity-progress-note-thinking-icon"
          title={providerLabel ? `${providerLabel} thinking trace` : 'Thinking trace'}
        />
      ) : (
        <ActivityStatusIcon status={activity.status} />
      )}
      <div className="activity-progress-note-body">
        <div className="activity-progress-note-title">
          <span>{note.title}</span>
          {durationLabel(activity.durationMs) && (
            <span className="activity-progress-note-duration">
              {durationLabel(activity.durationMs)}
            </span>
          )}
        </div>
        {note.body && <p>{note.body}</p>}
      </div>
    </div>
  )
}

function ActivityCompactGroup({
  activities,
  workspacePath,
  provider,
  participants,
  shimmerNow,
  onOpenFileChangeInWorkbench
}: {
  activities: ToolActivity[]
  workspacePath?: string
  /** Chat-context provider, forwarded to inner ActivityRow rows for
   * the provider-coloured border (Phase L3 slice 2). */
  provider?: ProviderId
  /** 1.0.4 — forwarded to ActivityRow for ensemble_yield chip tinting. */
  participants?: EnsembleParticipant[]
  shimmerNow: number
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const searchCount = activities.filter(isSearchActivity).length
  const readCount = activities.filter((a) => a.category === 'read' && !isSearchActivity(a)).length
  const otherCount = activities.length - searchCount - readCount
  const durationMs = getActivityDurationTotal(activities)
  // 1.0.4-AS2b — label generation extracted to a pure helper
  // (`buildCompactGroupLabel`) for unit testing. See its docstring
  // for the dominant-category phrasing rules.
  const label = buildCompactGroupLabel(activities)
  const primaryCategory: 'search' | 'read' =
    otherCount === 0 && searchCount > readCount ? 'search' : 'read'
  const chips = activities
    .map(
      (activity) =>
        getFilePathFromActivity(activity) ||
        getStringParam(activity.parameters || {}, SEARCH_PARAM_KEYS)
    )
    .filter((value): value is string => Boolean(value))
    .slice(0, 6)

  // Phase L3 slice 7 — intelligent group iconography. Compute the
  // distinct tool families present in this group; show ONE icon if
  // they all map to the same family, otherwise show an array of up
  // to 4 family icons (with a "+N" indicator for overflow). When no
  // tool maps to a family at all, fall back to the legacy category
  // icon so heterogeneous unknown-tool groups still render something.
  const distinctFamilies = (() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const activity of activities) {
      const family = toolNameToFamily(activity.toolName)
      if (family && !seen.has(family)) {
        seen.add(family)
        order.push(family)
      }
    }
    return order
  })()
  const visibleFamilies = distinctFamilies.slice(0, 4)
  const overflowFamilyCount = distinctFamilies.length - visibleFamilies.length

  // Phase L4 slice 2 — aggregate status for the gutter dot. Worst-
  // case wins: any error → error, then warning, then running,
  // then pending, otherwise success. Mirrors how a CI dashboard
  // would surface a group's worst result without hiding it
  // behind successes.
  const aggregateStatus: ToolActivity['status'] = (() => {
    if (activities.some((a) => a.status === 'error')) return 'error'
    if (activities.some((a) => a.status === 'warning')) return 'warning'
    if (activities.some((a) => a.status === 'running')) return 'running'
    if (activities.some((a) => a.status === 'pending')) return 'pending'
    return 'success'
  })()

  return (
    <div
      className={`activity-compact-group ${expanded ? 'expanded' : 'collapsed'}`}
      data-status={aggregateStatus}
      style={{ position: 'relative' }}
    >
      <span className="activity-gutter-dot" aria-hidden />
      <button
        className="activity-compact-group-header"
        type="button"
        onClick={() => setExpanded((current) => !current)}
      >
        {distinctFamilies.length === 0 ? (
          <ToolCategoryIcon category={primaryCategory} />
        ) : visibleFamilies.length === 1 ? (
          <ToolFamilyIcon
            family={visibleFamilies[0] as Parameters<typeof ToolFamilyIcon>[0]['family']}
            size={27.2}
            className="activity-category-icon"
          />
        ) : (
          <span className="activity-compact-group-icons" aria-hidden>
            {visibleFamilies.map((family) => (
              <ToolFamilyIcon
                key={family}
                family={family as Parameters<typeof ToolFamilyIcon>[0]['family']}
                /* Phase L4 slice 1 — compact-group icon array grows
                 * to 15px to match the body-text title beside it.
                 * Slice 4 follow-up — 1.5× bump (15 → 22px). */
                size={22}
                className="activity-compact-group-icon"
              />
            ))}
            {overflowFamilyCount > 0 && (
              <span className="activity-compact-group-icon-overflow">+{overflowFamilyCount}</span>
            )}
          </span>
        )}
        <span className="activity-compact-group-title">{label}</span>
        <span className="activity-compact-group-meta">
          {durationLabel(durationMs) && (
            <span className="activity-compact-group-duration">{durationLabel(durationMs)}</span>
          )}
          <span className="activity-count-badge">{activities.length}</span>
        </span>
        <span className="activity-compact-group-caret">
          <svg
            className={`activity-compact-chevron ${expanded ? 'expanded' : ''}`}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3,4.5 6,7.5 9,4.5" />
          </svg>
        </span>
      </button>
      {!expanded && chips.length > 0 && (
        <div className="activity-compact-group-chips">
          {chips.map((chip, index) => (
            <span key={`${chip}-${index}`} className="activity-compact-chip">
              {getBaseName(chip)}
            </span>
          ))}
          {activities.length > chips.length && (
            <span className="activity-compact-chip muted">+{activities.length - chips.length}</span>
          )}
        </div>
      )}
      {expanded && (
        <div className="activity-compact-group-list">
          {activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              workspacePath={workspacePath}
              forceCompact
              provider={provider}
              participants={participants}
              shimmerNow={shimmerNow}
              onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function getInlineActivityTitle(
  activity: ToolActivity,
  filePath?: string,
  participants?: EnsembleParticipant[]
): ReactNode {
  if (isCallMcpToolActivity(activity)) {
    return <CallMcpToolEasterEgg />
  }

  if (filePath) {
    return <ActivityTitle activity={activity} filePath={filePath} participants={participants} />
  }

  const parameters = activity.parameters || {}
  if (isShellActivity(activity)) {
    const command = getStringParam(parameters, COMMAND_PARAM_KEYS)
    return command ? (
      <>
        Ran <code className="activity-inline-command">{truncateText(command, 150)}</code>
      </>
    ) : (
      <>{activity.displayName || 'Ran shell command'}</>
    )
  }

  if (isSearchActivity(activity)) {
    const query = getStringParam(parameters, SEARCH_PARAM_KEYS)
    return query ? (
      <>
        Searched for <strong>{query}</strong>
      </>
    ) : (
      <>{activity.displayName || 'Searched'}</>
    )
  }

  if (isTodoToolName(activity.toolName)) {
    const todos = parseTodoItemsFromActivity(activity)
    if (todos.length > 0) {
      return <>{`Goal steps · ${summarizeTodoProgress(todos).label}`}</>
    }
    return <>{getReadableActivityDisplayName(activity) || 'Goal steps'}</>
  }

  if (activity.category === 'task') {
    if ((activity.toolName || '').toLowerCase().includes('ensemble_yield')) {
      // 1.0.4 — render the ensemble_yield activity title with a
      // provider-tinted @-mention chip for the target participant
      // (e.g. "Codex yielding to @Gems" where @Gems is tinted blue
      // for Gemini). Defensively self-contained — if the activity's
      // `displayName` is the raw tool name from an upstream path
      // that bypassed the humanization helper, this still produces
      // a friendly label by reading target straight from parameters.
      return renderEnsembleYieldTitle(activity, participants)
    }
    const displayName = getReadableActivityDisplayName(activity)
    const summary =
      activity.resultSummary ||
      activity.outputPreview ||
      getStringParam(parameters, ['summary', 'message', 'text', 'intent'])
    // Reasoning rows keep a tight one-line collapsed preview, but end with a
    // plain ellipsis instead of the "open raw events" marker — the full trace
    // is one click away in the expanded "Thoughts" card (no Raw Events detour).
    const collapsedReasoning = isReasoningToolName(activity.toolName || '')
    return summary ? (
      <>
        {truncateText(
          summary,
          collapsedReasoning ? { maxLength: 120, footer: () => '…' } : 120
        )}
      </>
    ) : (
      <>{displayName || activity.displayName || 'Task update'}</>
    )
  }

  return <ActivityTitle activity={activity} filePath={filePath} participants={participants} />
}

function ActivityTitle({
  activity,
  filePath,
  participants
}: {
  activity: ToolActivity
  filePath?: string
  participants?: EnsembleParticipant[]
}) {
  if (isCallMcpToolActivity(activity)) {
    return <CallMcpToolEasterEgg />
  }

  // 1.0.4 — same structured render as the inline path for
  // ensemble_yield activities so the larger card form stays in
  // visual lockstep with the inline form.
  if ((activity.toolName || '').toLowerCase().includes('ensemble_yield')) {
    return <>{renderEnsembleYieldTitle(activity, participants)}</>
  }

  if (!filePath) {
    return <>{getReadableActivityDisplayName(activity)}</>
  }

  // A write/edit whose RESULT was denied or errored did NOT change the file
  // — never render the success verb ("Wrote …" / "Edited …"), which reads as
  // an applied change. Surface the attempt honestly instead; the row already
  // carries the red error icon + the "User rejected …" result text in its
  // expandable detail. Gate on the generic status so this covers any
  // provider whose edit was denied (Grok search_replace, Claude Edit, …).
  if (
    isErroredToolStatus(activity.status) &&
    (activity.category === 'write' || isWriteLikeToolName(activity.toolName || ''))
  ) {
    return (
      <>
        Attempted to {attemptedWriteVerb(activity)}{' '}
        <strong className="activity-file-name">{getBaseName(filePath)}</strong>
      </>
    )
  }

  return (
    <>
      {getFileActionLabel(activity)}{' '}
      <strong className="activity-file-name">{getBaseName(filePath)}</strong>
    </>
  )
}

function getDiffToneClass(line: string, tone: SanitizedDetail['previews'][number]['tone']): string {
  const prefix = line[0]

  if (tone === 'diff') {
    if (prefix === '+' && !line.startsWith('+++')) return 'activity-diff-line-add'
    if (prefix === '-' && !line.startsWith('---')) return 'activity-diff-line-delete'
    return 'activity-diff-line-context'
  }

  if (tone === 'addition') {
    if (!line) return 'activity-diff-line-context'
    if (prefix === '-' && !line.startsWith('---')) return 'activity-diff-line-context'
    if (prefix === '+' && !line.startsWith('+++')) return 'activity-diff-line-add'
    return 'activity-diff-line-add'
  }

  if (tone === 'deletion') {
    if (!line) return 'activity-diff-line-context'
    if (prefix === '+' && !line.startsWith('+++')) return 'activity-diff-line-context'
    if (prefix === '-' && !line.startsWith('---')) return 'activity-diff-line-delete'
    return 'activity-diff-line-delete'
  }

  return 'activity-diff-line-context'
}

function isJsonLikeText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (!/^(?:\{|\[)/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function isRawStructuredOutput(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (isJsonLikeText(trimmed)) return true
  if (/^(diff --git|@@\s|---\s|\+\+\+\s)/m.test(trimmed)) return true

  const nonEmptyLines = trimmed.split('\n').filter((line) => line.trim())
  if (nonEmptyLines.length >= 2) {
    const pathLineCount = nonEmptyLines.filter((line) =>
      /^[^:\n]+:\d+(?::\d+)?:/.test(line.trim())
    ).length
    if (pathLineCount / nonEmptyLines.length > 0.7) return true

    const logLineCount = nonEmptyLines.filter((line) =>
      /^(stdout|stderr|error|warning|\$|>|[+-]\s)/i.test(line.trim())
    ).length
    if (logLineCount / nonEmptyLines.length > 0.7) return true
  }

  return false
}

function hasMarkdownSignal(value: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|~~~)/m.test(value) ||
    /(^|\n)\s{0,3}\|.+\|\s*$/m.test(value) ||
    /\[[^\]\n]+\]\([^)]+\)|!\[[^\]\n]*\]\([^)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`/.test(
      value
    )
  )
}

function shouldRenderPreviewAsMarkdown(
  preview: SanitizedDetail['previews'][number],
  cleanedContent: string
): boolean {
  if (
    preview.terminal ||
    preview.tone === 'diff' ||
    preview.tone === 'addition' ||
    preview.tone === 'deletion'
  ) {
    return false
  }
  if (!hasMarkdownSignal(cleanedContent)) return false
  return !isRawStructuredOutput(cleanedContent)
}

function ActivityPreview({ preview }: { preview: SanitizedDetail['previews'][number] }) {
  // Phase L5 slice 1 — clean output content before rendering:
  //   1. Unwrap MCP envelopes so we never render
  //      `{"content":[{"type":"text","text":"..."}]}` literally
  //      — covers legacy transcripts persisted before the upstream
  //      unwrap in `extractResultOutput` landed.
  //   2. Pretty-print one-liner JSON blobs so structured tool
  //      results (e.g. `git_status` JSON output) read as indented
  //      key/value pairs instead of one giant horizontal line.
  const cleanedContent = prettyPrintJson(unwrapMcpEnvelope(preview.content))

  if (preview.terminal) {
    return <pre className="activity-output-terminal">{cleanedContent}</pre>
  }

  if (shouldRenderPreviewAsMarkdown(preview, cleanedContent)) {
    return (
      <div className="activity-output-markdown">
        <MarkdownMessage content={cleanedContent} />
      </div>
    )
  }

  return (
    <pre className="activity-output-clean activity-output-diff">
      {cleanedContent.split('\n').map((line, index) => (
        <span
          key={`${index}-${line}`}
          className={`activity-diff-line ${getDiffToneClass(line, preview.tone || 'neutral')}`}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function ActivityImageBlocks({ blocks }: { blocks: ReturnType<typeof extractMcpImageBlocks> }) {
  if (blocks.length === 0) return null
  return (
    <div>
      <div className="activity-detail-section-title">
        {blocks.length === 1 ? 'Image result' : `Image results · ${blocks.length}`}
      </div>
      <div className="activity-image-grid">
        {blocks.map((block, index) => (
          <figure className="activity-image-card" key={block.id}>
            <img
              src={`data:${block.mimeType};base64,${block.data}`}
              alt={`Tool result ${index + 1}`}
            />
            <figcaption className="activity-image-meta">{block.mimeType}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

/**
 * Spawn block — collapsed summary that precedes the individual provider-native
 * invocation cards when 2+ agents are spawned in the same message.
 */
function ChildAgentSpawnBlock({ threads }: { threads: ChildAgentThread[] }) {
  const [expanded, setExpanded] = useState(true)
  if (!threads || threads.length < 2) return null

  const scrollToAgent = (agentId: string) => {
    if (typeof document === 'undefined') return
    const target = document.querySelector(`[data-agent-id="${CSS.escape(agentId)}"]`)
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.add('child-agent-thread-flash')
      window.setTimeout(() => target.classList.remove('child-agent-thread-flash'), 1200)
    }
  }

  return (
    <div className={`child-agent-spawn-block ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <button
        type="button"
        className="child-agent-spawn-block-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <svg
          className={`child-agent-spawn-block-chevron ${expanded ? 'expanded' : ''}`}
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="3,4.5 6,7.5 9,4.5" />
        </svg>
        <span className="child-agent-spawn-block-title">
          Agent Invocations <strong>{threads.length}</strong>
        </span>
        <span
          className={`agent-invocation-source-chip ${agentInvocationSourceClassName('provider-native')}`}
        >
          {agentInvocationSourceLabel('provider-native')}
        </span>
        {!expanded && (
          <span className="child-agent-spawn-block-collapsed-pills" aria-hidden>
            {threads.map((thread) => (
              <span
                key={thread.id}
                className="child-agent-spawn-block-pill"
                style={
                  thread.identity
                    ? { color: thread.identity.color, borderColor: thread.identity.color }
                    : undefined
                }
              >
                <AgentIdentityIcon
                  identity={thread.identity}
                  seed={thread.id}
                  color={thread.identity?.color}
                  size={14}
                  className="child-agent-spawn-block-pill-icon"
                />
                {thread.identity?.name || thread.name}
              </span>
            ))}
          </span>
        )}
      </button>
      {expanded && (
        <div className="child-agent-spawn-block-body">
          {threads.map((thread) => {
            const identity = thread.identity
            const preview = thread.seedPrompt
              ? thread.seedPrompt.length > 140
                ? `${thread.seedPrompt.slice(0, 137)}…`
                : thread.seedPrompt
              : ''
            return (
              <button
                key={thread.id}
                type="button"
                className="child-agent-spawn-block-row"
                onClick={() => scrollToAgent(thread.id)}
                title="Scroll to this agent's card"
              >
                <AgentIdentityIcon
                  identity={identity}
                  seed={thread.id}
                  color={identity?.color}
                  size={18}
                  className="child-agent-spawn-block-icon"
                />
                <span
                  className="child-agent-spawn-block-name"
                  style={identity ? { color: identity.color } : undefined}
                >
                  {identity?.name || thread.name}
                </span>
                {(identity?.role || thread.role) && (
                  <span className="child-agent-spawn-block-role">
                    ({identity?.role || thread.role})
                  </span>
                )}
                {preview && <span className="child-agent-spawn-block-preview">{preview}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 1.0.4-AS1 — shimmer-sweep + icon-pulse expiration.
 *
 * Two regimes:
 *
 *  1. **Definitive terminal data on the activity record.** If
 *     `endedAt` or `durationMs` is set we treat the activity as
 *     done for VISUAL purposes regardless of what `status` says.
 *     This catches the renderer-side race where the orchestrator
 *     wrote `endedAt` + flipped status in the same update but only
 *     the `endedAt` arrived in our copy of the record. Status
 *     conversion to `success` / `error` etc. owns the icon /
 *     category re-skin; this flag just kills the shimmer + pulse.
 *
 *  2. **TTL safety net for "stuck running" activities.** If no
 *     terminal field is set BUT the activity started more than
 *     `SHIMMER_TTL_MS` ago, we still drop the loud shimmer-sweep
 *     so a row that never received its terminal update can't
 *     command the user's attention forever. The icon-pulse stays
 *     attenuated but visible so genuinely long-running shells
 *     (notarize, ship scripts) still read as "alive".
 *
 * The TTL is generous (4 minutes) because the explicit
 * notarize/ship class of tool routinely takes 90-180s; we want a
 * cliff well past that so the shimmer carries through real work.
 * Past 4 minutes is rare enough that suppressing the sweep is a
 * net win — the icon + the activity row itself are still visible.
 */
const SHIMMER_TTL_MS = 4 * 60 * 1000

export function isActivityShimmerStale(
  activity: Pick<ToolActivity, 'status' | 'startedAt' | 'endedAt' | 'durationMs'>,
  now: number
): boolean {
  if (activity.status !== 'running' && activity.status !== 'pending') return false
  // Terminal field present despite status saying otherwise — the
  // activity is done; we just haven't received the matching status
  // update yet.
  if (activity.endedAt) return true
  if (typeof activity.durationMs === 'number' && activity.durationMs > 0) return true
  // TTL safety net.
  if (!activity.startedAt) return false
  const startedAt = Date.parse(activity.startedAt)
  if (!Number.isFinite(startedAt)) return false
  return now - startedAt > SHIMMER_TTL_MS
}

/**
 * 1.0.4-AS1 — periodic tick that drives staleness re-evaluation
 * when nothing else triggers a re-render. Only schedules the
 * interval while at least one activity is potentially still
 * running; once everything is terminal the timer naturally
 * cleans up. Tick cadence is 15s — well below the 4-minute TTL
 * cliff so the visual transition is observed promptly without
 * incurring per-row timers.
 */
function useShimmerStaleTick(activities: readonly ToolActivity[] | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const hasMaybeRunning = useMemo(() => {
    if (!activities || activities.length === 0) return false
    return activities.some(
      (a) =>
        (a.status === 'running' || a.status === 'pending') &&
        !a.endedAt &&
        (typeof a.durationMs !== 'number' || a.durationMs <= 0)
    )
  }, [activities])
  useEffect(() => {
    if (!hasMaybeRunning) return
    const frame = window.requestAnimationFrame(() => setNow(Date.now()))
    const handle = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(handle)
    }
  }, [hasMaybeRunning])
  return now
}

export function activitiesHaveLiveWork(activities: readonly ToolActivity[]): boolean {
  return activities.some((a) => a.status === 'running' || a.status === 'pending')
}

/** Cheap signature that changes whenever streamed content grows, so the
 * viewport re-pins to the live edge as reasoning text / tool results stream in. */
export function liveActivityRevision(activities: readonly ToolActivity[]): string {
  const last = activities[activities.length - 1]
  const tail = last ? `${last.id}:${(last.resultSummary || last.outputPreview || '').length}` : ''
  return `${activities.length}|${tail}`
}

export function ActivityStack({
  activities,
  workspacePath,
  provider,
  chatId,
  runId,
  chat,
  compactDensity = false,
  liveActivityViewport = false,
  expandedActivityIds,
  onExpandedActivityIdsChange,
  onOpenFileChangeInWorkbench
}: ActivityStackProps) {
  // 1.0.4-AS1 — drive the shimmer/pulse staleness check. The
  // returned `now` is consumed by InlineActivityRow via `Date.now()`
  // at render time — the tick's role is purely to keep the parent
  // re-rendering at a steady 15s cadence while any activity could
  // still be in flight.
  const shimmerNow = useShimmerStaleTick(activities)
  // 1.0.4 — ensemble participants are forwarded down to ActivityRow
  // so an `ensemble_yield(target: ...)` activity can render the target
  // as a provider-tinted `@<role>` chip. Memoised against the
  // participants array reference so we don't re-key every render when
  // the chat object has unrelated mutations.
  const participants = useMemo(() => chat?.ensemble?.participants, [chat?.ensemble?.participants])

  const childThreads = useMemo(() => {
    if (!provider || !activities || activities.length === 0) return [] as ChildAgentThread[]
    return deriveChildAgentThreadsFromActivities(provider, chatId, runId, activities, chat)
  }, [provider, chatId, runId, activities, chat])

  const { topLevelActivities, threadByParentId, threadActivityById } = useMemo(() => {
    const childIds = new Set<string>()
    const byParent = new Map<string, ChildAgentThread>()
    const byActivityId = new Map<string, ToolActivity>()
    for (const thread of childThreads) {
      if (thread.parentToolCallId) byParent.set(thread.parentToolCallId, thread)
      for (const id of thread.toolActivityIds) childIds.add(id)
    }
    for (const activity of activities || []) {
      if (childIds.has(activity.id)) byActivityId.set(activity.id, activity)
    }
    const topLevel = (activities || []).filter((activity) => !childIds.has(activity.id))
    return {
      topLevelActivities: topLevel,
      threadByParentId: byParent,
      threadActivityById: byActivityId
    }
  }, [activities, childThreads])

  const mergedTodosByActivityId = useMemo(
    () => computeMergedTodosByActivityId(topLevelActivities),
    [topLevelActivities]
  )
  const latestMergedTodos = useMemo(
    () => computeMergedTodosFromActivities(topLevelActivities),
    [topLevelActivities]
  )
  // Per-participant PlanRail lanes (ensemble): group todo activities by the
  // participant/provider that authored them so concurrent plans don't merge
  // into one undifferentiated list. Solo/guest collapse to a single lane.
  const planLanes = useMemo(() => {
    const byLane = computeMergedTodosByLane(
      topLevelActivities,
      (a) =>
        (a.metadata?.ensembleParticipantId as string | undefined) ??
        (a.metadata?.ensembleProvider as string | undefined) ??
        (a.metadata?.provider as string | undefined) ??
        TODO_SOLO_LANE
    )
    return Object.entries(byLane)
      .filter(([, todos]) => todos.length > 0)
      .map(([lane, todos]) => {
        const presentation = planLanePresentation(lane, participants)
        return { lane, todos, ...presentation }
      })
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [topLevelActivities, participants])
  // Phase L5 slice 3 — lifted expansion state. The set of ids that
  // are currently open. Single-open mode (default + always in
  // compactDensity) auto-collapses other rows when one expands;
  // ⌘/Shift click opts into multi-open. (1.0.74 — the per-turn
  // master expand/collapse toggle was removed along with the
  // turn-receipt strip; expansion is now purely per-row / per-group.)
  //
  // 1.0.6-TV2 — when the parent passes a controlled set + change
  // handler (transcript virtualisation), defer to those so expansion
  // survives unmount/remount; otherwise keep the original local state.
  // The wrapper resolves updater functions against the live value so
  // every internal call site (e.g. `toggleExpand`) keeps its
  // `setExpandedIds(prev => ...)` shape unchanged.
  const [localExpandedIds, setLocalExpandedIds] = useExpandedIdsState()
  const isExpansionControlled =
    expandedActivityIds !== undefined && onExpandedActivityIdsChange !== undefined
  const expandedIds = isExpansionControlled ? expandedActivityIds : localExpandedIds
  const setExpandedIds = (next: Set<string> | ((prev: Set<string>) => Set<string>)): void => {
    if (isExpansionControlled) {
      const resolved =
        typeof next === 'function'
          ? (next as (prev: Set<string>) => Set<string>)(expandedActivityIds)
          : next
      onExpandedActivityIdsChange(resolved)
    } else {
      setLocalExpandedIds(next)
    }
  }
  const allowMultiOpen = !compactDensity

  if (!activities || activities.length === 0) return null
  // 1.0.74 — same-tool grouping is unified across single + ensemble
  // (no per-mode split): runs of 2+ consecutive same-family terminal
  // activities fold into one expandable compact group.
  const timelineItems = buildTimelineItems(topLevelActivities)
  const liveViewportEnabled = Boolean(liveActivityViewport && topLevelActivities.length > 0)

  const resolveThreadActivities = (thread: ChildAgentThread): ToolActivity[] => {
    return thread.toolActivityIds
      .map((id) => threadActivityById.get(id))
      .filter((activity): activity is ToolActivity => Boolean(activity))
  }

  const toggleExpand = (id: string, modKey: boolean): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (modKey && allowMultiOpen) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      } else {
        // Single-open: clicking a row collapses everything else and
        // toggles this one. Clicking the only-open row closes it.
        const wasOpen = next.has(id)
        next.clear()
        if (!wasOpen) next.add(id)
      }
      return next
    })
  }
  const timelineNodes = timelineItems.map((item) => {
    if (item.type === 'compact-group') {
      return (
        <ActivityCompactGroup
          key={item.id}
          activities={item.activities}
          workspacePath={workspacePath}
          provider={provider}
          participants={participants}
          shimmerNow={shimmerNow}
          onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
        />
      )
    }
    // Claude-native Workflow runs get a dedicated live card in place of the
    // generic tool row / compact trace, in every density mode. Gated to the
    // Claude participant via the same provider-resolution precedence the rest of
    // the stack uses, so another provider's same-named tool never matches.
    if (
      isClaudeWorkflowToolName(item.activity.toolName) &&
      activityProvider(item.activity, provider) === 'claude'
    ) {
      return <ClaudeWorkflowCard key={item.activity.id} activity={item.activity} />
    }
    const thread = threadByParentId.get(item.activity.id)
    // 1.0.4-AG — when the user has compact density on AND this
    // activity isn't carrying a child-agent thread (those still
    // need the full ActivityRow render so the ChildAgentThreadCard
    // hangs off it), route through CompactToolTrace for the
    // one-line trace + foldout view. The CompactToolTrace reads
    // its own provider attribution from `activity.metadata` and
    // falls back to the chat-level `provider` passed here.
    if (compactDensity && !thread) {
      return (
        <CompactToolTrace
          key={item.activity.id}
          activity={item.activity}
          provider={provider}
          globalScope={isGlobalChat(chat)}
        />
      )
    }
    return (
      <ActivityRow
        key={item.activity.id}
        activity={item.activity}
        workspacePath={workspacePath}
        childThread={thread}
        childActivities={thread ? resolveThreadActivities(thread) : undefined}
        provider={provider}
        participants={participants}
        todoItems={mergedTodosByActivityId.get(item.activity.id)}
        forceCompact={compactDensity}
        isExpanded={expandedIds.has(item.activity.id)}
        onToggleExpand={(modKey) => toggleExpand(item.activity.id, modKey)}
        shimmerNow={shimmerNow}
        onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
      />
    )
  })

  // Keep every tool burst inside the same bounded viewport so provider timing
  // differences don't change the transcript layout. The child-agent spawn
  // header stays above it because it is navigational chrome, not stream detail.
  if (liveViewportEnabled) {
    return (
      <div className="activity-timeline">
        {childThreads.length >= 2 && <ChildAgentSpawnBlock threads={childThreads} />}
        <LiveActivityViewport
          active={activitiesHaveLiveWork(activities)}
          revision={liveActivityRevision(topLevelActivities)}
        >
          {planLanes.length > 1 ? (
            <div className="plan-rail-lanes">
              {planLanes.map((lane) => (
                <TodoChecklistCard
                  key={lane.lane}
                  todos={lane.todos}
                  variant="pinned"
                  laneLabel={lane.label}
                />
              ))}
            </div>
          ) : (
            latestMergedTodos.length > 0 && (
              <TodoChecklistCard todos={latestMergedTodos} variant="pinned" />
            )
          )}
          <div className="activity-timeline-live-inner">{timelineNodes}</div>
        </LiveActivityViewport>
      </div>
    )
  }

  return (
    <div className="activity-timeline">
      {childThreads.length >= 2 && <ChildAgentSpawnBlock threads={childThreads} />}
      {timelineNodes}
    </div>
  )
}

/** Local hook wrapper so callers see a familiar `useState`-shaped
 * tuple. Centralised so future extensions (persistence across
 * remounts, keyboard-shortcut binding, etc.) live in one place. */
function useExpandedIdsState(): [
  Set<string>,
  (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void
] {
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  return [ids, setIds]
}

function ActivityDiffFiles({
  diffSummary,
  workspacePath
}: {
  diffSummary?: ToolDiffSummary
  workspacePath?: string
}) {
  const files = diffSummary?.files || []
  if (files.length === 0) return null

  // Phase L5 slice 2 — drop entries that have no resolvable file path.
  // Pre-fix, these would render as "Unknown file" cards with
  // `UNKNOWN +0 -1` chrome — visually intrusive AND uninformative
  // because we already know SOMETHING was changed, we just can't
  // attribute it to a file. Filter them out here; if EVERY file is
  // unnamed (rare — implies a malformed diff payload or a tool that
  // emits diff stats without paths), surface a compact placeholder
  // so the user knows a diff was reported even though the file
  // attribution was lost.
  const namedFiles = files.filter((file) => Boolean(file.path && file.path.trim()))
  if (namedFiles.length === 0) {
    return (
      <div className="activity-file-change-cards">
        <div className="activity-file-change-card activity-file-change-card-placeholder">
          <span className="activity-file-change-path activity-file-change-path-placeholder">
            diff present · file paths not reported
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="activity-file-change-cards">
      {namedFiles.slice(0, 8).map((file, index) => {
        const fullPath = file.path || ''
        const displayPath = displayPathRelativeToWorkspace(fullPath, workspacePath) || fullPath
        return (
          <div key={`${file.path}-${index}`} className="activity-file-change-card">
            <FileTypeIcon
              path={fullPath}
              size={14}
              className="activity-file-type-icon"
              workspacePath={workspacePath}
            />
            <span className="activity-file-change-path" title={fullPath}>
              {displayPath || fullPath}
            </span>
            <span className={`activity-file-change-status status-${file.status || 'unknown'}`}>
              {file.status || 'changed'}
            </span>
            {(file.additions !== undefined || file.deletions !== undefined) &&
              ((file.additions || 0) !== 0 || (file.deletions || 0) !== 0) && (
              <span className="activity-file-change-stats">
                <span className="activity-line-stat activity-line-stat-add">
                  +{file.additions || 0}
                </span>
                <span className="activity-line-stat activity-line-stat-delete">
                  -{file.deletions || 0}
                </span>
              </span>
            )}
          </div>
        )
      })}
      {namedFiles.length > 8 && (
        <div className="activity-file-change-overflow">+{namedFiles.length - 8} more files</div>
      )}
    </div>
  )
}

function ChildAgentThreadCard({
  thread,
  activities,
  workspacePath,
  shimmerNow
}: {
  thread: ChildAgentThread
  activities: ToolActivity[]
  workspacePath?: string
  shimmerNow?: number
}) {
  const [expanded, setExpanded] = useState(thread.state === 'running')
  const interactivityLabel = childAgentInteractivityLabel(thread.interactivity)
  const stateLabel = childAgentStateLabel(thread.state)

  // Resolve identity (assigned via assignAgentIdentity during thread derive).
  // When present, the colored name + dot replace the generic "Task #N" label.
  const identity = thread.identity
  const displayName = identity?.name || thread.name
  const identityRole = identity?.role || thread.role
  const identityColor = identity?.color

  return (
    <div
      className={`child-agent-thread state-${thread.state} interactivity-${thread.interactivity}`}
      data-agent-id={thread.id}
      style={
        identityColor
          ? ({ ['--agent-identity-color' as string]: identityColor } as Record<string, string>)
          : undefined
      }
    >
      <button
        type="button"
        className="child-agent-thread-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className={`child-agent-thread-avatar status-${thread.state}`}
          aria-hidden
          style={identityColor ? { color: identityColor } : undefined}
        >
          <AgentIdentityIcon identity={identity} seed={thread.id} color={identityColor} size={22} />
        </span>
        <span
          className="child-agent-thread-name"
          style={identityColor ? { color: identityColor } : undefined}
        >
          {displayName}
        </span>
        {identityRole && <span className="child-agent-thread-role">{identityRole}</span>}
        <span
          className={`agent-invocation-source-chip ${agentInvocationSourceClassName('provider-native')}`}
        >
          {agentInvocationSourceLabel('provider-native')}
        </span>
        <span className={`child-agent-thread-state state-${thread.state}`}>{stateLabel}</span>
        <span className="child-agent-thread-interactivity">{interactivityLabel}</span>
        {durationLabel(thread.durationMs) && (
          <span className="child-agent-thread-duration">{durationLabel(thread.durationMs)}</span>
        )}
        <svg
          className={`child-agent-thread-chevron ${expanded ? 'expanded' : ''}`}
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="3,4.5 6,7.5 9,4.5" />
        </svg>
      </button>
      {expanded && (
        <div className="child-agent-thread-body">
          <div className="agent-invocation-route-note">
            {agentInvocationRouteLabel('provider-native')}
          </div>
          {thread.seedPrompt && (
            <div className="child-agent-section">
              <div className="child-agent-section-title">Invocation prompt</div>
              <pre className="child-agent-seed-prompt">{thread.seedPrompt}</pre>
            </div>
          )}
          {activities.length > 0 && (
            <div className="child-agent-section">
              <div className="child-agent-section-title">
                Provider-native activity · {activities.length}
              </div>
              <div className="child-agent-activities">
                {activities.map((childActivity) => (
                  <ActivityRow
                    key={childActivity.id}
                    activity={childActivity}
                    workspacePath={workspacePath}
                    forceCompact
                    /* Inside a ChildAgentThreadCard, the runtime-
                     * execution provider for the sub-thread is what
                     * matters — that's `thread.provider`. The chat-
                     * context provider would point at the OUTER chat,
                     * which is misleading for these inner rows. */
                    provider={thread.provider}
                    shimmerNow={shimmerNow}
                  />
                ))}
              </div>
            </div>
          )}
          {thread.finalResult && (
            <div className="child-agent-section">
              <div className="child-agent-section-title">Invocation result</div>
              <div className="child-agent-result">{thread.finalResult}</div>
            </div>
          )}
          {!thread.seedPrompt && activities.length === 0 && !thread.finalResult && (
            <div className="child-agent-empty">No agent invocation output captured yet.</div>
          )}
        </div>
      )}
    </div>
  )
}

function ActivityRow({
  activity,
  workspacePath,
  forceCompact = false,
  childThread,
  childActivities,
  provider,
  participants,
  todoItems,
  isExpanded,
  onToggleExpand,
  shimmerNow,
  onOpenFileChangeInWorkbench
}: {
  activity: ToolActivity
  workspacePath?: string
  forceCompact?: boolean
  childThread?: ChildAgentThread
  childActivities?: ToolActivity[]
  /** 1.4.2 — merged goal-step checklist state at this activity. */
  todoItems?: TodoItem[]
  /** 1.0.4 — ensemble participants for resolving an `ensemble_yield`
   * activity's target string to a provider, so the inline target chip
   * picks up provider-themed tinting (e.g. blue for Gemini). Optional
   * — non-ensemble chats pass undefined and the chip renders neutral. */
  participants?: EnsembleParticipant[]
  /** Chat-context provider — the CLI/runtime that owns the chat this
   * activity belongs to. Drives the left-border color via the
   * `[data-provider]` selector so a long transcript visually clusters
   * by which provider is doing the work. Sub-thread cards passed
   * through `ChildAgentThreadCard` can supply their own provider
   * here when the runtime-execution provider differs from the
   * outer chat. */
  provider?: ProviderId
  /** Phase L5 slice 3 — expansion state lifted to ActivityStack so
   * the parent can coordinate single-open mode + master toggle.
   * Optional: if undefined, the row falls back to local state for
   * backward compatibility with any caller that doesn't yet pass
   * these (e.g. ChildAgentThreadCard internal rows). */
  isExpanded?: boolean
  onToggleExpand?: (modKey: boolean) => void
  shimmerNow?: number
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
}) {
  // Phase L5 slice 3 — when the parent passes `isExpanded` +
  // `onToggleExpand`, use them (the parent coordinates single-open
  // mode + the master toggle). Otherwise fall back to local state
  // so internal call sites that don't yet plumb the props through
  // (child-agent threads, compact-group expanded view) keep working
  // without changes. `setLocalExpanded` is consumed below in
  // `toggleExpanded`'s fallback branch.
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = isExpanded ?? localExpanded
  const {
    closePreview: closeActivityDiffHoverPreview,
    keepPreviewOpen: keepActivityDiffHoverPreviewOpen,
    preview: activityDiffHoverPreview,
    scheduleClosePreview: scheduleCloseActivityDiffHoverPreview,
    showPreview: showActivityDiffHoverPreview
  } = useDiffHoverPreviewState()

  const isUnknown = activity.toolName === 'unknown' || !activity.toolName
  const showDebugWarning = Boolean(isUnknown && (activity.rawUseEvent || activity.rawResultEvent))
  const isWriteAction = isWriteLikeToolName(activity.toolName || '')
  const activityFilePath = getFilePathFromActivity(activity)

  const chipText: string[] = []
  // Previously the meta line carried `<path> · <duration>ms` for write
  // actions. The path was redundant — the main tool label already shows
  // the file's basename (via ToolDisplayNames + per-tool path-aware
  // labels), and when the file lives outside the workspace, the path
  // fell back to its absolute form (`~/Documents/Other/.../file.swift`)
  // and got truncated mid-segment in the meta band. That truncated path
  // duplicated information that was already legible above and added
  // visual noise without disambiguating anything for the user.
  //
  // The full absolute path still ships in the `.activity-meta` title
  // attribute below for hover disambiguation when the basename alone
  // isn't enough.
  const durationText = durationLabel(activity.durationMs)
  if (durationText) chipText.push(durationText)
  const metaText = chipText.join(' · ')
  const parameters = activity.parameters || {}
  // A write/edit whose RESULT was denied or errored changed nothing — drop
  // its diff so the expanded detail's per-file "+N −M" cards and the "Diff"
  // row don't assert an applied change (the inline pill is suppressed in
  // inlineStatsForActivity for the same reason). The "User rejected …"
  // result text still renders in the detail.
  const diffSummary = isErroredToolStatus(activity.status)
    ? undefined
    : activity.diffSummary ||
      deriveToolDiffSummary(
        activity.toolName,
        parameters,
        activity.resultSummary || activity.outputPreview
      )
  // Pure helper that decides whether the per-row Codex-style `+X -Y` odometer
  // renders and what numbers it carries — handles MultiEdit `edits[]`,
  // Claude `Write` content, Gemini MCP write tools, and suppresses `+0 -0`
  // for pending edits that have not reported back yet.
  const inlineStats = inlineStatsForActivity(activity)
  const activityDiffPreviewText =
    !isErroredToolStatus(activity.status) && isWriteAction ? getActivityDiffPreviewText(activity) : ''
  const activityDiffPreviewPath = getActivityDiffPreviewPath(
    activity,
    activityFilePath,
    diffSummary
  )
  const activityDiffPreviewStatus =
    diffSummary?.files?.find((file) => file.status)?.status || 'edited'
  const activityDiffPreviewAdditions = inlineStats.visible
    ? inlineStats.additions
    : diffSummary?.additions
  const activityDiffPreviewDeletions = inlineStats.visible
    ? inlineStats.deletions
    : diffSummary?.deletions
  const workbenchDiffSummary = useMemo(
    () =>
      buildActivityWorkbenchDiffSummary({
        activityFilePath,
        diffSummary,
        diffText: activityDiffPreviewText,
        workspacePath
      }),
    [activityDiffPreviewText, activityFilePath, diffSummary, workspacePath]
  )
  const openActivityDiffHoverPreview = useCallback(
    (
      event: { currentTarget: HTMLElement },
      options?: { focusTarget?: DiffHoverPreviewState['focusTarget'] }
    ) => {
      if (!activityDiffPreviewText) return
      showActivityDiffHoverPreview({
        anchor: event.currentTarget.getBoundingClientRect(),
        boundary: diffHoverPreviewBoundaryForElement(event.currentTarget),
        summary: {
          actionLabel: 'Hover preview',
          path: activityDiffPreviewPath,
          status: activityDiffPreviewStatus,
          additions: activityDiffPreviewAdditions,
          deletions: activityDiffPreviewDeletions,
          diffText: activityDiffPreviewText,
          source: 'tool-call'
        },
        focusTarget: options?.focusTarget,
        action:
          onOpenFileChangeInWorkbench && workbenchDiffSummary
            ? {
                label: 'Open Diff Studio',
                onActivate: () => {
                  closeActivityDiffHoverPreview()
                  onOpenFileChangeInWorkbench(workbenchDiffSummary)
                }
              }
            : undefined
      })
    },
    [
      activityDiffPreviewAdditions,
      activityDiffPreviewDeletions,
      activityDiffPreviewPath,
      activityDiffPreviewStatus,
      activityDiffPreviewText,
      closeActivityDiffHoverPreview,
      onOpenFileChangeInWorkbench,
      showActivityDiffHoverPreview,
      workbenchDiffSummary
    ]
  )
  useDiffHoverPreviewDismiss(activityDiffHoverPreview, closeActivityDiffHoverPreview)
  useEffect(() => {
    closeActivityDiffHoverPreview()
  }, [activity.id, activity.status, closeActivityDiffHoverPreview])
  const sanitizedDetail = buildSanitizedDetail(
    activity,
    activityFilePath,
    inlineStats.visible ? inlineStats.additions : diffSummary?.additions,
    inlineStats.visible ? inlineStats.deletions : diffSummary?.deletions
  )
  const checklistTodos =
    todoItems && todoItems.length > 0
      ? todoItems
      : isTodoToolName(activity.toolName)
        ? parseTodoItemsFromActivity(activity)
        : []
  const creativeTimelineDiff = creativeTimelineDiffModelFromActivity(activity)
  const visiblePreviews = creativeTimelineDiff
    ? sanitizedDetail.previews.filter((preview) => preview.label !== 'Result')
    : sanitizedDetail.previews
  const imageBlocks = extractMcpImageBlocks(activity.rawResultEvent)
  const hasRichImages = imageBlocks.length > 0
  const hasSanitizedDetail =
    sanitizedDetail.rows.length > 0 ||
    visiblePreviews.length > 0 ||
    Boolean(creativeTimelineDiff) ||
    hasRichImages ||
    checklistTodos.length > 0
  const shouldShowRawEvent = showDebugWarning || (isUnknown && !hasSanitizedDetail)
  const diffFileCount = diffSummary?.files?.length || 0
  const renderInputs = {
    expanded,
    detailRowCount: sanitizedDetail.rows.length,
    previews: sanitizedDetail.previews,
    diffFileCount,
    customDetailCount:
      (creativeTimelineDiff ? 1 : 0) +
      (hasRichImages ? 1 : 0) +
      (checklistTodos.length > 0 ? 1 : 0),
    shouldShowRawEvent
  }
  // Phase L4 slice 3 — all rows render in the inline body-text form by
  // default (Codex / Claude grammar). Heavy-content tools still have
  // their detail panel, but it lives BEHIND the expansion toggle —
  // collapsed by default, opens on click when `canExpand` is true.
  // The legacy `shouldRenderAsCard` decision used to auto-expand
  // content-heavy rows; we now defer that to the user's click so the
  // transcript reads as a uniform vertical list at one text scale.
  const isInlineActivity = true
  const canExpand = hasExpandableDetail(activity, renderInputs)
  // 1.0.4-AS1 — derive shimmer/pulse staleness from the parent tick
  // while any activity might still be in flight (`useShimmerStaleTick`).
  // Stale activities keep their original
  // `data-status` so the icon / category UX doesn't suddenly assert
  // success or error we can't confirm; the CSS rules for the
  // shimmer + pulse animations are the only thing that changes,
  // gated by `data-stale="true"`.
  const isShimmerStale = isActivityShimmerStale(activity, shimmerNow ?? 0)
  const showInlinePulse =
    (activity.status === 'running' || activity.status === 'pending') && !isShimmerStale
  // Phase L3 slice 4 — stamp animation on status transition. When a
  // Phase K-followup — `justCompleted` state + the running→done
  // "stamp" animation are gone. Both were anchored to the now-removed
  // traffic-light gutter dot. With the dot gone the icon's smooth
  // color + opacity transition is the completion cue (see the
  // `activity-icon-pulse` keyframe in main.css for the running
  // state). If a future surface wants the celebration animation,
  // hang it on `.activity-category-icon` instead.
  const progressNote = getProgressNote(activity)
  if (progressNote && !forceCompact) {
    return (
      <>
        <ActivityProgressNote activity={activity} provider={provider} />
        {childThread && (
          <ChildAgentThreadCard
            thread={childThread}
            activities={childActivities || []}
            workspacePath={workspacePath}
            shimmerNow={shimmerNow}
          />
        )}
      </>
    )
  }

  // Phase L5 slice 3 — toggle path forwards the click's mod-key
  // state so the parent's single-open coordinator can distinguish
  // "regular click → close everything else, open just this row"
  // from "⌘/Shift click → add this row to the expanded set without
  // collapsing the others". The keyboard variant always uses
  // regular-mode (no plausible UX for "Shift+Enter" mod-expand).
  const toggleExpanded = (modKey: boolean) => {
    if (!canExpand) return
    if (onToggleExpand) {
      onToggleExpand(modKey)
    } else {
      setLocalExpanded((current) => !current)
    }
  }

  return (
    <>
      <div
        className={`activity-row activity-row-inline ${expanded ? 'expanded' : 'collapsed'}${!canExpand ? ' no-expand' : ''}${showInlinePulse ? ' is-pulsing' : ''}`}
        data-category={activity.category || 'unknown'}
        data-status={activity.status}
        data-stale={isShimmerStale ? 'true' : undefined}
        data-provider={provider || 'unknown'}
        data-diff-hover-preview={activityDiffPreviewText ? 'true' : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : -1}
        onMouseEnter={activityDiffPreviewText ? openActivityDiffHoverPreview : undefined}
        onMouseLeave={activityDiffPreviewText ? scheduleCloseActivityDiffHoverPreview : undefined}
        onFocus={
          activityDiffPreviewText
            ? (event) => openActivityDiffHoverPreview(event, { focusTarget: 'preview' })
            : undefined
        }
        onBlur={activityDiffPreviewText ? scheduleCloseActivityDiffHoverPreview : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        onClick={canExpand ? (event) => toggleExpanded(event.metaKey || event.shiftKey) : undefined}
        onKeyDown={
          canExpand
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleExpanded(event.metaKey || event.shiftKey)
                }
              }
            : undefined
        }
      >
        {/*
          Phase K-followup — traffic-light gutter dot removed. The
          tool-family icon below (now larger) carries the visual
          anchor for the row. Status communication moves to the
          icon's color: accent by default, red on error. Cleaner
          transcript, less per-row decoration competing with body
          text. The justCompleted "stamp" animation is dropped along
          with the dot (the icon doesn't need a celebration cue).
        */}
        <div className="activity-body">
          <div className="activity-header">
            <div className="activity-label">
              <span className="activity-label-main">
                {isWriteAction && activityFilePath && !isInlineActivity ? (
                  <FileTypeIcon
                    path={activityFilePath}
                    size={14}
                    className="activity-file-type-icon"
                    workspacePath={workspacePath}
                  />
                ) : null}
                {!isInlineActivity &&
                  !(isWriteAction && activityFilePath) &&
                  (() => {
                    // Prefer the hand-drawn tool-family icon (Phase L3
                    // skeuomorphic redesign — see `ToolFamilyIcon.tsx`).
                    // Fall back to the legacy category icon when the
                    // tool name doesn't map to any known family — keeps
                    // unknown / custom MCP tools visible rather than
                    // disappearing into a placeholder.
                    const family = toolNameToFamily(activity.toolName)
                    return family ? (
                      <ToolFamilyIcon
                        family={family}
                        /* Phase L4 slice 1 — card-form icon grows to
                         * 16px to match the body-text scale of the
                         * label beside it.
                         * Slice 4 follow-up — 1.5× bump (16 → 24px).
                         * Phase K-followup — another 1.25× bump
                         * (24 → 30px). The icon now carries the
                         * row's left-margin anchor (replacing the
                         * removed traffic-light gutter dot).
                         * K-followup-2 — small density bump
                         * (30 → 34px) so the icon reads as the
                         * dominant left-edge anchor of the row at
                         * normal transcript zoom. */
                        size={34}
                        className="activity-category-icon"
                      />
                    ) : (
                      <ToolCategoryIcon category={activity.category} />
                    )
                  })()}
                {isInlineActivity &&
                  (() => {
                    // Phase L3 slice 7 — inline-row icon. Use the
                    // hand-drawn tool-family icon at a small size and
                    // tint it via the same `category-{X}` color the
                    // legacy pip carried (the class drives the
                    // currentColor inheritance). Fall back to the
                    // legacy pip when the tool name doesn't map to
                    // any family — keeps unknown tools visible.
                    const inlineFamily = isThinkingTraceActivity(activity)
                      ? 'reasoning'
                      : toolNameToFamily(activity.toolName)
                    return inlineFamily ? (
                      <ToolFamilyIcon
                        family={inlineFamily}
                        /* Phase L4 slice 1 — inline icons grow from
                         * 11px to 14px so they're actually visible
                         * at body-text scale (the surrounding label
                         * is now ~16.6px).
                         * Slice 4 follow-up — 1.5× bump (14 → 21px)
                         * for scannability in long transcripts. Icons
                         * now lead the row visually rather than
                         * competing with body text.
                         * K-followup-2 — density bump (21 → 25px)
                         * to match the now-bolded label weight; the
                         * icon needs to read with similar prominence
                         * or the row feels lopsided. */
                        size={25}
                        className={`activity-inline-icon category-${activity.category || 'unknown'}`}
                      />
                    ) : (
                      <span
                        className={`activity-category-pip category-${activity.category || 'unknown'}`}
                      />
                    )
                  })()}
                {isInlineActivity ? (
                  getInlineActivityTitle(activity, activityFilePath, participants)
                ) : (
                  <ActivityTitle
                    activity={activity}
                    filePath={activityFilePath}
                    participants={participants}
                  />
                )}
                {inlineStats.visible && (
                  <span className="activity-line-stats">
                    <DigitOdometer
                      value={inlineStats.additions}
                      sign="+"
                      className="activity-line-stat activity-line-stat-add"
                    />
                    <DigitOdometer
                      value={inlineStats.deletions}
                      sign="-"
                      className="activity-line-stat activity-line-stat-delete"
                    />
                    {inlineStats.confidence && inlineStats.confidence !== 'exact' && (
                      <span className="activity-line-stat-estimated">~</span>
                    )}
                  </span>
                )}
                {activityDiffPreviewText && (
                  <button
                    type="button"
                    className="activity-diff-preview-bubble"
                    aria-describedby={
                      activityDiffHoverPreview
                        ? DIFF_HOVER_PREVIEW_TOOLTIP_ID
                        : undefined
                    }
                    aria-label={`Preview diff for ${activityDiffPreviewPath}`}
                    title="Preview diff"
                    onMouseEnter={openActivityDiffHoverPreview}
                    onMouseLeave={scheduleCloseActivityDiffHoverPreview}
                    onFocus={(event) =>
                      openActivityDiffHoverPreview(event, { focusTarget: 'preview' })
                    }
                    onBlur={scheduleCloseActivityDiffHoverPreview}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openActivityDiffHoverPreview(event)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        openActivityDiffHoverPreview(event, { focusTarget: 'action' })
                      }
                    }}
                  >
                    Diff
                  </button>
                )}
                {/* Phase L4 slice 3 — expansion chevron at the end of
                 * the inline row, shown only when the row carries
                 * substantive detail worth expanding. Rotates 90°
                 * when open so the user has a clear affordance for
                 * "click to inspect / collapse". */}
                {canExpand && (
                  <span
                    className="activity-expand-chevron"
                    data-expanded={expanded ? 'true' : 'false'}
                    aria-hidden
                  >
                    ›
                  </span>
                )}
              </span>
            </div>
          </div>
          {metaText && (
            <div
              className="activity-meta"
              title={isWriteAction && activityFilePath ? activityFilePath : undefined}
            >
              {metaText}
            </div>
          )}

          {checklistTodos.length > 0 && !expanded && (
            <TodoChecklistCard todos={checklistTodos} variant="compact" maxVisible={5} />
          )}

          {expanded && (
            <div className="activity-detail">
              {showDebugWarning && (
                <div style={{ color: 'var(--warning)' }}>Tool event missing name</div>
              )}
              {sanitizedDetail.rows.length > 0 && (
                <div className="activity-detail-grid">
                  {sanitizedDetail.rows.map((row) => (
                    <div key={`${row.label}-${row.value}`} className="activity-detail-row">
                      <span className="activity-detail-label">{row.label}</span>
                      <span className="activity-detail-value">{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
              <ActivityDiffFiles diffSummary={diffSummary} workspacePath={workspacePath} />
              {checklistTodos.length > 0 && (
                <TodoChecklistCard todos={checklistTodos} variant="full" />
              )}
              {creativeTimelineDiff && <CreativeTimelineDiffCard activity={activity} />}
              {visiblePreviews.map((preview) => (
                <div key={`${preview.label}-${preview.content.slice(0, 32)}`}>
                  <div className="activity-detail-section-title">{preview.label}</div>
                  <ActivityPreview preview={preview} />
                </div>
              ))}
              <ActivityImageBlocks blocks={imageBlocks} />
              {shouldShowRawEvent && (!!activity.rawUseEvent || !!activity.rawResultEvent) && (
                <div>
                  <div className="activity-detail-section-title">Raw event</div>
                  <pre className="activity-output-terminal">
                    {JSON.stringify(activity.rawUseEvent || activity.rawResultEvent, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {childThread && (
        <ChildAgentThreadCard
          thread={childThread}
          activities={childActivities || []}
          workspacePath={workspacePath}
          shimmerNow={shimmerNow}
        />
      )}
      <DiffHoverPreviewOverlay
        preview={activityDiffHoverPreview}
        onFocus={keepActivityDiffHoverPreviewOpen}
        onBlur={scheduleCloseActivityDiffHoverPreview}
        onMouseEnter={keepActivityDiffHoverPreviewOpen}
        onMouseLeave={scheduleCloseActivityDiffHoverPreview}
      />
    </>
  )
}
