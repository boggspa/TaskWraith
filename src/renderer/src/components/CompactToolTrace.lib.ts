import type { ProviderId, ToolActivity } from '../../../main/store/types'
import { isTodoToolName, parseTodoItemsFromActivity, summarizeTodoProgress } from '../../../main/TodoList'
import {
  getToolDisplayName,
  isWriteLikeToolName,
  prettyPrintJson,
  unwrapMcpEnvelope
} from '../lib/ToolParser'
import { looksLikeUnifiedDiff, type DiffTone } from '../lib/diffToneClass'
import {
  extractHttpUrls,
  mergeLinkPresentationTargets,
  type LinkPresentationTarget
} from '../lib/urlPresentation'

/** Inline preview shown on the row. Hard cap at 80 chars; appends a
 * truncation hint when the underlying result is long (> 500 chars) so
 * the user knows the foldout has more content. */
export const PREVIEW_CHAR_LIMIT = 80
export const RESULT_REDACTION_THRESHOLD = 500
export const REDACTION_HINT = '(truncated — expand to see full output)'

/** Slice 6a — soften (never hide) the web tool family to a friendly one-liner
 * for the collapsed trace line in General (global) chats. The foldout still
 * carries the full raw provider / status / output. Returns null for non-web
 * tools, which keep their normal compact name. */
export function friendlyGlobalToolLabel(activity: ToolActivity): string | null {
  // Normalise away underscores so the no-underscore aliases (websearch /
  // googlewebsearch / webfetch) that ToolDisplayNames treats as the same web
  // family soften consistently with web_search / web_fetch.
  const name = (activity.toolName || '').toLowerCase().replace(/_/g, '')
  if (name.endsWith('websearch')) return 'Searched the web'
  if (name.endsWith('webfetch')) return 'Read a web page'
  return null
}

export function resolveProvider(
  activity: ToolActivity,
  fallback: ProviderId | undefined
): ProviderId | undefined {
  return activity.metadata?.ensembleProvider || activity.metadata?.provider || fallback
}

export function providerLabel(provider: ProviderId | undefined): string {
  if (!provider) return ''
  switch (provider) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'gemini':
      return 'Gemini'
    case 'kimi':
      return 'Kimi'
    case 'grok':
      return 'Grok'
    case 'cursor':
      return 'Cursor'
    case 'ollama':
      return 'Ollama'
    case 'antigravity':
      return 'AntiGravity'
    case 'pi':
      return 'Pi'
    case 'mistral':
      return 'Mistral'
    default:
      return provider
  }
}

export function compactToolDisplayName(activity: ToolActivity): string {
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
  return displayLooksRaw ? fallback || displayName || rawToolName || 'tool' : displayName
}

/** Ordered param keys we treat as "the file this tool acted on", mirroring
 * `getPathFromRecord` in ToolParser + `getFilePathFromActivity` in
 * ActivityStack so the compact trace resolves the same path those surfaces do. */
const TOOL_FILE_PATH_KEYS = [
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

/** The file path this activity acted on, if any. Checks the well-known
 * parameter keys FIRST (matching `getFilePathFromActivity` in ActivityStack
 * and the parameter-derived label from `getToolDisplayName`, so the compact
 * split's `endsWith` match stays reliable), then the first-class
 * `activity.filePath` as a last resort. */
export function extractToolFilePath(activity: ToolActivity): string | undefined {
  const params = activity.parameters || {}
  for (const key of TOOL_FILE_PATH_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const direct = typeof activity.filePath === 'string' ? activity.filePath.trim() : ''
  return direct || undefined
}

export interface CompactToolLabelParts {
  /** The leading verb/label (e.g. "Read", "Edited"), or the whole label when
   * no file path could be cleanly split out of it. */
  prefix: string
  /** The trailing file path, present only when it was cleanly separable from
   * the label so the caller can render it as a distinct clickable target. */
  filePath?: string
}

/**
 * Split a compact tool-trace label like `Read /repo/src/foo.ts` into its
 * `{ prefix: 'Read', filePath: '/repo/src/foo.ts' }` parts so the file portion
 * can be rendered as a clickable {@link TranscriptFileTarget}.
 *
 * The split only happens when the resolved path is genuinely the tail of the
 * label (which is how `getToolDisplayName` composes file verbs). A softened
 * global web label, or any tool whose label doesn't end in its path, is
 * returned whole with no `filePath` so it renders exactly as before.
 */
export function splitCompactToolLabel(
  activity: ToolActivity,
  softLabel: string | null
): CompactToolLabelParts {
  if (softLabel) return { prefix: softLabel }
  const label = compactToolDisplayName(activity)
  const filePath = extractToolFilePath(activity)
  if (filePath && label.length > filePath.length && label.endsWith(filePath)) {
    const prefix = label.slice(0, label.length - filePath.length).trimEnd()
    if (prefix) return { prefix, filePath }
  }
  return { prefix: label }
}

export function statusLabel(status: ToolActivity['status']): string {
  switch (status) {
    case 'success':
      return 'ok'
    case 'error':
      return 'error'
    case 'warning':
      return 'warn'
    case 'running':
      return 'running'
    case 'pending':
      return 'pending'
    default:
      return status || 'unknown'
  }
}

export function durationLabel(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`
  const mins = Math.floor(secs / 60)
  const remSecs = Math.round(secs - mins * 60)
  return `${mins}m${remSecs}s`
}

/** Squeeze whitespace + strip line breaks for the one-line preview. */
function collapsePreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getResultText(activity: ToolActivity): string {
  return activity.resultSummary || activity.outputPreview || ''
}

export interface RenderedPreview {
  /** The 80-char (or less) display string. */
  display: string
  /** Whether the underlying content was redacted (i.e. > 500 chars). */
  redacted: boolean
  /** Whether there is *any* preview content at all. */
  hasContent: boolean
}

export function buildResultPreview(activity: ToolActivity): RenderedPreview {
  if (isTodoToolName(activity.toolName)) {
    const todos = parseTodoItemsFromActivity(activity)
    if (todos.length > 0) {
      return {
        display: summarizeTodoProgress(todos).label,
        redacted: false,
        hasContent: true
      }
    }
  }

  const raw = getResultText(activity)
  if (!raw) {
    return { display: '', redacted: false, hasContent: false }
  }

  const cleaned = collapsePreview(unwrapMcpEnvelope(raw))
  if (!cleaned) {
    return { display: '', redacted: false, hasContent: false }
  }

  const redacted = raw.length > RESULT_REDACTION_THRESHOLD
  const sliced =
    cleaned.length > PREVIEW_CHAR_LIMIT ? `${cleaned.slice(0, PREVIEW_CHAR_LIMIT)}…` : cleaned
  return { display: sliced, redacted, hasContent: true }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export interface FoldoutSection {
  label: string
  body: string
  /** Drives per-line +/- accenting. Absent ⇒ neutral (flat) rendering. */
  tone?: DiffTone
}

/** Parameter keys an edit-class tool uses for its before/after payload —
 *  mirrors the write branch of ActivityStack's `buildSanitizedDetail` so the
 *  compact foldout and the full detail panel surface the SAME three blocks. */
const EDIT_OLD_KEYS = ['old_string', 'oldString']
const EDIT_NEW_KEYS = ['new_string', 'newString']
const EDIT_CONTENT_KEYS = ['content', 'contents', 'file_text']
const EDIT_PATCH_KEYS = ['patchPreview', 'patch_preview', 'patch', 'diff']

function firstStringParam(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Diff-shaped sections for a write/edit tool, in the order the change reads:
 * the patch, then what went out, then what came in.
 *
 * These are ADDITIVE to Input/Result/Timeline rather than a replacement. The
 * raw `Input` JSON still carries the same strings, but escaped onto one line —
 * unreadable as a change. This is the readable view of the same data, and it
 * is the block the user actually came to the foldout for.
 */
function buildEditDiffSections(activity: ToolActivity): FoldoutSection[] {
  const toolName = activity.toolName || ''
  if (activity.category !== 'write' && !isWriteLikeToolName(toolName)) return []

  const params = (activity.parameters || {}) as Record<string, unknown>
  const sections: FoldoutSection[] = []

  const patch = firstStringParam(params, EDIT_PATCH_KEYS)
  if (patch) sections.push({ label: 'Patch preview', body: patch, tone: 'diff' })

  const oldString = firstStringParam(params, EDIT_OLD_KEYS)
  const newString = firstStringParam(params, EDIT_NEW_KEYS)
  if (oldString) sections.push({ label: 'Removed', body: oldString, tone: 'deletion' })
  if (newString) sections.push({ label: 'Added', body: newString, tone: 'addition' })

  // Whole-file writes have no before-image; the content IS the addition. Only
  // when there was no edit pair, so a replace doesn't render its payload twice.
  if (!oldString && !newString) {
    const content = firstStringParam(params, EDIT_CONTENT_KEYS)
    if (content) sections.push({ label: 'Added content', body: content, tone: 'addition' })
  }

  return sections
}

export function buildFoldoutSections(activity: ToolActivity): FoldoutSection[] {
  const sections: FoldoutSection[] = []

  if (isTodoToolName(activity.toolName)) {
    const todos = parseTodoItemsFromActivity(activity)
    if (todos.length > 0) {
      const lines = todos.map((item) => {
        const mark =
          item.status === 'completed'
            ? '[x]'
            : item.status === 'in_progress'
              ? '[>]'
              : item.status === 'cancelled'
                ? '[-]'
                : '[ ]'
        return `${mark} ${item.content}`
      })
      sections.push({ label: 'Goal steps', body: lines.join('\n') })
    }
  }

  sections.push(...buildEditDiffSections(activity))

  const params = activity.parameters || {}
  if (Object.keys(params).length > 0) {
    sections.push({ label: 'Input', body: safeJsonStringify(params) })
  }

  const resultText = getResultText(activity)
  if (resultText) {
    const body = prettyPrintJson(unwrapMcpEnvelope(resultText))
    // A provider that echoes the applied patch back as its result gets the
    // same accenting as an explicit patch parameter — detected from the text,
    // since the section label alone ("Result") says nothing about the shape.
    sections.push({
      label: 'Result',
      body,
      ...(looksLikeUnifiedDiff(body) ? { tone: 'diff' as const } : {})
    })
  }

  const timelineParts: string[] = []
  if (activity.startedAt) timelineParts.push(`started: ${activity.startedAt}`)
  if (activity.endedAt) timelineParts.push(`ended:   ${activity.endedAt}`)
  if (typeof activity.durationMs === 'number') {
    timelineParts.push(`duration: ${activity.durationMs}ms`)
  }
  if (activity.status) timelineParts.push(`status:  ${activity.status}`)
  if (timelineParts.length > 0) {
    sections.push({ label: 'Timeline', body: timelineParts.join('\n') })
  }

  return sections
}

export function extractToolUrlTargets(activity: ToolActivity, limit = 5): LinkPresentationTarget[] {
  return mergeLinkPresentationTargets(
    [
      extractUrlsFromUnknown(activity.parameters, limit),
      extractHttpUrls(activity.resultSummary || '', limit),
      extractHttpUrls(activity.outputPreview || '', limit)
    ],
    limit
  )
}

function extractUrlsFromUnknown(
  value: unknown,
  limit: number,
  depth = 0
): LinkPresentationTarget[] {
  if (limit <= 0 || value === null || value === undefined || depth > 4) return []
  if (typeof value === 'string') return extractHttpUrls(value, limit)
  if (typeof value === 'number' || typeof value === 'boolean') return []
  if (Array.isArray(value)) {
    return mergeLinkPresentationTargets(
      value.map((item) => extractUrlsFromUnknown(item, limit, depth + 1)),
      limit
    )
  }
  if (typeof value === 'object') {
    return mergeLinkPresentationTargets(
      Object.values(value as Record<string, unknown>).map((item) =>
        extractUrlsFromUnknown(item, limit, depth + 1)
      ),
      limit
    )
  }
  return []
}
