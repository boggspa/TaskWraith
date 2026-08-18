import type {
  DiffFileStatus,
  ProviderId,
  ToolActivity,
  ToolActivityStatus,
  ToolDiffFileSummary,
  ToolDiffSummary
} from '../../../main/store/types'
import { lookupToolDisplayName, titleCaseToolName } from './ToolDisplayNames'
import { preserveMeasuredDiffSummary } from '../../../shared/toolDiffSummaryMerge'
import {
  catalogToolOperationCategory,
  isCatalogFileEditTool
} from '../../../shared/canonicalToolCoalesce'
import {
  canonicalImageViewToolName,
  IMAGE_VIEW_DISPLAY_NAME,
  IMAGE_VIEW_TOOL_NAME,
  imageViewCountFromParameters,
  imageViewCountFromResult,
  isImageViewToolUse
} from '../../../shared/imageViewIdentity'

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

export function extractToolId(event: any): string {
  if (!event || typeof event !== 'object') return `unknown-${Date.now()}`
  return (
    event.tool_id ||
    event.toolId ||
    event.id ||
    event.call_id ||
    event.tool_call_id ||
    `unknown-${Date.now()}`
  )
}

export function extractParentToolCallId(event: any): string | undefined {
  if (!event || typeof event !== 'object') return undefined
  const candidates = [
    event.parent_tool_use_id,
    event.parentToolUseId,
    event.parent_tool_call_id,
    event.parentToolCallId,
    event.parent_id,
    event.parentId,
    event.params?.parent_tool_use_id,
    event.params?.parentToolUseId,
    event.message?.parent_tool_use_id
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return undefined
}

export function extractParameters(event: any): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {}
  const raw =
    event.parameters ||
    event.params ||
    event.payload ||
    event.args ||
    event.input ||
    event.arguments ||
    {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Provider-native wrapper tools (notably Codex `exec`) carry source text.
    }
    return { input: raw }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/**
 * Canonical ACP-style tool *kind* (read | edit | delete | move | search |
 * execute | think | fetch | other), when a transport supplies one. Grok's ACP
 * transport sends a structured `kind` alongside a freeform human `title`; the
 * title is the card label, but the kind is the reliable category signal — so we
 * thread it through (`tool_kind` on the compat payload) and prefer it for the
 * category icon. Returns '' when no kind is present (the name-based resolver
 * then decides).
 */
export function extractToolKind(event: any): string {
  if (!event || typeof event !== 'object') return ''
  const raw = event.tool_kind || event.toolKind || event.kind
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

const TOOL_ACTIVITY_PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse'
])

function extractToolProvider(event: any): ProviderId | undefined {
  if (!event || typeof event !== 'object') return undefined
  const raw = event.provider ?? event.metadata?.provider
  return typeof raw === 'string' && TOOL_ACTIVITY_PROVIDER_IDS.has(raw as ProviderId)
    ? (raw as ProviderId)
    : undefined
}

/**
 * MCP tool results come back wrapped in the standard
 * `{ content: [{ type: 'text', text: string }, ...] }` envelope.
 * The agent itself unwraps this before reasoning — but the TaskWraith
 * renderer was dumping the raw JSON straight into `<pre>` blocks,
 * showing `{"content":[{"type":"text","text":"Exit code: 0\n..."}]}`
 * where it should have shown plain command output.
 *
 * `isMcpEnvelopeObject` + `extractMcpEnvelopeText` work at the object
 * level (when the raw tool result is still a parsed JS object); the
 * exported `unwrapMcpEnvelope` works at the string level (when the
 * result has already been stringified — typically by an earlier
 * `JSON.stringify` fallback in this same function).
 *
 * Phase L5 slice 1.
 */
function isMcpEnvelopeObject(value: unknown): value is {
  content: Array<Record<string, unknown>>
} {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (!Array.isArray(obj.content)) return false
  // At least one text-shaped part. We tolerate other part types
  // (image, resource_link, etc.) mixed in — they're skipped during
  // text extraction below rather than rejecting the whole envelope.
  return obj.content.some((item) => mcpContentText(item) !== null)
}

function mcpContentText(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type && type !== 'text') return null
  if (typeof record.text === 'string') return record.text
  const nestedText = record.text
  if (nestedText && typeof nestedText === 'object' && !Array.isArray(nestedText)) {
    const nested = nestedText as Record<string, unknown>
    if (typeof nested.text === 'string') return nested.text
  }
  return null
}

function extractMcpEnvelopeText(value: { content: unknown[] }): string {
  return value.content
    .map((item) => mcpContentText(item))
    .filter((text): text is string => text !== null)
    .join('')
}

export interface McpImageBlock {
  id: string
  mimeType: string
  data: string
}

function parseJsonObjectLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function imageBlockFromContentItem(item: unknown, index: number): McpImageBlock | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  if (record.type !== 'image') return null
  const mimeType =
    typeof record.mimeType === 'string'
      ? record.mimeType
      : typeof record.mime_type === 'string'
        ? record.mime_type
        : ''
  const data = typeof record.data === 'string' ? record.data : ''
  if (!mimeType.startsWith('image/') || !data) return null
  return {
    id: `mcp-image-${index}-${mimeType}-${data.length}`,
    mimeType,
    data
  }
}

/**
 * Extract rich MCP image content blocks from either a parsed MCP
 * `{ content: [...] }` envelope or a JSON-stringified equivalent.
 * Text unwrapping intentionally ignores these blocks; this helper is
 * the renderer-side companion used by tool detail panes.
 */
export function extractMcpImageBlocks(raw: unknown): McpImageBlock[] {
  const parsed = parseJsonObjectLike(raw)
  const candidates: unknown[] = [parsed]

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    candidates.push(parseJsonObjectLike(record.result))
    candidates.push(parseJsonObjectLike(record.output))
    candidates.push(parseJsonObjectLike(record.content))
  }

  const blocks: McpImageBlock[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        const block = imageBlockFromContentItem(item, blocks.length + index)
        if (block) blocks.push(block)
      })
      continue
    }
    const record = candidate as Record<string, unknown>
    const content = Array.isArray(record.content) ? record.content : []
    content.forEach((item, index) => {
      const block = imageBlockFromContentItem(item, blocks.length + index)
      if (block) blocks.push(block)
    })
  }

  const seen = new Set<string>()
  return blocks.filter((block) => {
    const key = `${block.mimeType}:${block.data}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Detect strings that JSON-parse to an MCP `{content:[{type:'text',
 * text}]}` envelope and return the concatenated `text` fields.
 * Pass-through for plain strings, non-JSON, malformed JSON, and JSON
 * that doesn't fit the envelope shape.
 *
 * Wired in two places (Phase L5 slice 1):
 *   - upstream in `extractResultOutput` so fresh tool calls produce a
 *     clean `resultSummary` from the start.
 *   - renderer-side in `ActivityPreview` so legacy transcripts already
 *     persisted with envelope-shaped strings render cleanly on next
 *     view.
 */
export function unwrapMcpEnvelope(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  if (!raw) return raw
  const trimmed = raw.trim()
  // Quick reject: not even JSON-shaped. The vast majority of
  // outputs (plain command stdout, file contents, etc.) hit this
  // path and pay near-zero cost.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  try {
    const parsed = JSON.parse(trimmed)
    if (isMcpEnvelopeObject(parsed)) {
      return extractMcpEnvelopeText(parsed)
    }
    // Valid JSON but not an MCP envelope — leave the original
    // string intact. `prettyPrintJson` is a separate concern.
    return raw
  } catch {
    return raw
  }
}

/**
 * Re-indent JSON-shaped strings with 2-space indentation when they
 * come in as one-liner blobs. Skip already-formatted content (any
 * line that starts with whitespace followed by `"` / `[` / `{` is
 * a strong signal that the JSON is already pretty-printed).
 *
 * Phase L5 slice 1 — used by `ActivityPreview` to make structured
 * tool outputs (post-MCP-unwrap fallback, or genuinely-JSON-shaped
 * results like `git status --porcelain=v2 --json`) readable in
 * the expansion panel rather than rendering as a single 10kb line.
 */
export function prettyPrintJson(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  if (!raw) return raw
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  // Heuristic skip: any newline followed by indentation + a JSON
  // structural character means it's already pretty-printed.
  if (/\n[ \t]+["[{]/.test(trimmed)) return raw
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return raw
  }
}

export function extractResultOutput(resultEvent: any): string {
  if (!resultEvent || typeof resultEvent !== 'object') return ''
  const evt = resultEvent
  // Phase L5 slice 1 — check raw OBJECT shapes for the MCP envelope
  // BEFORE falling through to string extraction. If `evt.result`
  // or `evt.output` is the envelope object itself, we extract the
  // text directly instead of stringifying it and re-parsing later.
  if (isMcpEnvelopeObject(evt.result)) return extractMcpEnvelopeText(evt.result)
  if (isMcpEnvelopeObject(evt.output)) return extractMcpEnvelopeText(evt.output)
  if (isMcpEnvelopeObject(evt)) return extractMcpEnvelopeText(evt)
  // String fallback paths — each goes through `unwrapMcpEnvelope`
  // so a value already serialised as `{"content":[...]}` gets
  // unwrapped before we ship it back to the renderer.
  if (typeof evt.output === 'string') return unwrapMcpEnvelope(evt.output)
  if (typeof evt.result === 'string') return unwrapMcpEnvelope(evt.result)
  if (typeof evt.content === 'string') return unwrapMcpEnvelope(evt.content)
  if (typeof evt.summary === 'string') return evt.summary
  if (typeof evt.message === 'string') return evt.message
  if (typeof evt.text === 'string') return evt.text
  if (evt.result && typeof evt.result === 'object') {
    if (typeof evt.result.output === 'string') return unwrapMcpEnvelope(evt.result.output)
    if (typeof evt.result.summary === 'string') return evt.result.summary
    if (typeof evt.result.message === 'string') return evt.result.message
    return JSON.stringify(evt.result)
  }
  if (evt.output && typeof evt.output === 'object') {
    return JSON.stringify(evt.output)
  }
  return ''
}

export function extractStatus(resultEvent: any): ToolActivityStatus {
  if (!resultEvent || typeof resultEvent !== 'object') return 'success'
  if (resultEvent.error || resultEvent.status === 'error') return 'error'
  if (resultEvent.status === 'warning') return 'warning'
  return 'success'
}

/**
 * A tool-call whose RESULT came back as an error or a user-rejection did
 * NOT do what it was asked. A read-only seat auto-denies write tools (Grok
 * ACP `search_replace`, Claude `Edit` / `apply_patch`, …) and the denied
 * `tool_result` is `{ status: 'error', output: 'User rejected the execution
 * …' }`, which `extractStatus` maps to the 'error' activity status.
 *
 * Diff/aggregation + card consumers gate on this so a denied or failed edit
 * stays OUT of the run diff, the "N files changed" count, the
 * "Created/Edited/Deleted" summary, the Review-changes / Create-PR diff, and
 * the "+N −M" pill / "Wrote …" label — the file on disk is unchanged. Gate
 * on the generic status so this covers ANY provider whose edit was denied,
 * not just Grok.
 */
export function isErroredToolStatus(status: ToolActivityStatus | null | undefined): boolean {
  return status === 'error'
}

export type ToolCategory = 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'

export function isWriteLikeToolName(toolName: string): boolean {
  return isCatalogFileEditTool(toolName)
}

/**
 * 1.0.4 — read-category aliases. Same canonical tool can show up
 * in three+ forms across provider adapters: `read_file` (Claude
 * SDK, snake_case), `readfile` (Kimi adapter, no separator),
 * `readFile` (some camelCase wrappers — already lowercased before
 * we check). Categorise all of them as 'read' so the activity
 * gets the friendly "Read <path>" label, the file-family SVG
 * icon, and the auto-compaction in `ActivityStack`.
 */
const READ_LIKE_TOOL_NAMES = new Set([
  'read_file',
  'readfile',
  'read',
  // AntiGravity's durable brain transcript uses VIEW_FILE rather than the
  // read_file spelling used by the other provider adapters.
  'view_file',
  'viewfile',
  'list_directory',
  'listdirectory',
  'list_dir',
  'listdir',
  'open_workspace_file',
  'openworkspacefile'
])

/**
 * 1.0.4 — task-category aliases beyond the 1.0.3 set. `exitplanmode`
 * + `exit_plan_mode` are emitted by Claude when it ends plan mode;
 * they were falling through to the 'unknown' category and rendering
 * as the raw "Used exitplanmode" string instead of "Exit plan mode."
 */
const TASK_LIKE_TOOL_NAMES = new Set([
  'update_topic',
  'ensemble_yield',
  'invoke_agent',
  'summary',
  'intent',
  'progress',
  'tool_progress',
  'codex_reasoning',
  'codex_plan',
  'kimi_thinking',
  'exit_plan_mode',
  'exitplanmode',
  'exitplan_mode',
  'exit_planmode',
  'ask_user_question',
  'askuserquestion',
  // Codex's host request may be projected into a transcript under this
  // display spelling; this is presentation-only, not MCP authority.
  'request_user_input',
  'requestuserinput',
  'request-user-input',
  'goal_read',
  'goalread',
  'goal_update',
  'goalupdate',
  'goal_complete',
  'goalcomplete',
  'goal_blocked',
  'goalblocked',
  'get_diagnostics',
  'getdiagnostics',
  // Cursor / Grok-ACP plan-tracking tool surface.
  'todo_write',
  'todowrite',
  'update_todo_list',
  'updatetodolist',
  'blackboard_post',
  'blackboardpost',
  'blackboard_read',
  'blackboardread',
  'blackboard_delete',
  'blackboarddelete'
])

const SEARCH_LIKE_TOOL_NAMES = new Set([
  'grep_search',
  'grepsearch',
  'glob',
  'search',
  'grep',
  'rg',
  'google_web_search',
  'googlewebsearch',
  'web_search',
  'websearch',
  'workspace_search',
  'file_search',
  'tw_recall_find'
])

/**
 * Whether a tool name denotes a model reasoning / thinking channel. Covers the
 * provider-specific pseudo-tools (`codex_reasoning`, `kimi_thinking`) plus the
 * generic `<provider>_thinking` / `<provider>_reasoning` shape emitted by Grok,
 * Cursor, Ollama, etc. Reasoning activities are task-category and render as a
 * streaming "Thinking" note in the live activity viewport.
 */
export function isReasoningToolName(toolName: string): boolean {
  const unqualified = stripToolNamespace((toolName || '').toLowerCase())
  return (
    unqualified === 'thinking' ||
    unqualified === 'reasoning' ||
    unqualified.endsWith('_thinking') ||
    unqualified.endsWith('_reasoning')
  )
}

export function getToolCategory(toolName: string): ToolCategory {
  const name = (toolName || '').toLowerCase()
  const unqualifiedName = stripToolNamespace(name)
  if (isImageViewToolUse(toolName)) return 'read'
  if (TASK_LIKE_TOOL_NAMES.has(unqualifiedName)) return 'task'
  if (isReasoningToolName(unqualifiedName)) return 'task'
  const operationCategory = catalogToolOperationCategory(toolName)
  if (operationCategory === 'read_file') return 'read'
  if (operationCategory === 'edit_file') return 'write'
  if (operationCategory === 'search') return 'search'
  if (operationCategory === 'shell') return 'shell'
  if (READ_LIKE_TOOL_NAMES.has(unqualifiedName)) return 'read'
  if (
    isWriteLikeToolName(unqualifiedName) ||
    // Observed AntiGravity PreToolUse hook spelling. This is display-only
    // categorisation; execution authority remains in AntigravityHookBridge.
    unqualifiedName === 'write_to_file' ||
    unqualifiedName === 'writetofile'
  )
    return 'write'
  if (SEARCH_LIKE_TOOL_NAMES.has(unqualifiedName) || SEARCH_LIKE_TOOL_NAMES.has(name))
    return 'search'
  if (
    unqualifiedName === 'run_shell_command' ||
    unqualifiedName === 'runshellcommand' ||
    unqualifiedName === 'shell' ||
    unqualifiedName === 'bash' ||
    // Cursor / Grok-ACP terminal tool surface.
    unqualifiedName === 'run_terminal_command' ||
    unqualifiedName === 'runterminalcommand' ||
    unqualifiedName === 'terminal'
  )
    return 'shell'
  return 'unknown'
}

/**
 * Map a canonical ACP-style tool *kind* to an TaskWraith activity category, so the
 * card gets the right icon even when the human tool label isn't a recognised
 * tool name. Returns `undefined` for absent / 'other' / unrecognised kinds so
 * the caller falls back to name-based resolution (`getToolCategory`).
 *
 * ACP kinds: read | edit | delete | move | search | execute | think | fetch |
 * other. We only have icons for read/write/search/shell/task, so several kinds
 * collapse onto the nearest category (delete/move → write, fetch → search,
 * think → task).
 */
export function mapToolKindToCategory(kind: string | null | undefined): ToolCategory | undefined {
  switch ((kind || '').trim().toLowerCase()) {
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
      return 'task'
    default:
      return undefined
  }
}

function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const index = toolName.indexOf('__', 5)
    return index > 5 ? toolName.slice(index + 2) : toolName
  }
  if (toolName.startsWith('mcp_') && !toolName.startsWith('mcp__')) {
    const knownServerPrefixes = [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-'
    ]
    for (const prefix of knownServerPrefixes) {
      if (toolName.startsWith(prefix)) return toolName.slice(prefix.length)
    }
  }
  if (toolName.startsWith('taskwraith-broker__')) {
    return toolName.slice('taskwraith-broker__'.length)
  }
  if (toolName.startsWith('taskwraith_broker__')) {
    return toolName.slice('taskwraith_broker__'.length)
  }
  if (toolName.startsWith('taskwraith-broker_')) {
    return toolName.slice('taskwraith-broker_'.length)
  }
  if (toolName.startsWith('taskwraith_broker_')) {
    return toolName.slice('taskwraith_broker_'.length)
  }
  if (toolName.startsWith('taskwraith__')) return toolName.slice('taskwraith__'.length)
  if (toolName.startsWith('taskwraith_')) return toolName.slice('taskwraith_'.length)
  return toolName
}

function getFirstStringParam(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function getToolDisplayName(toolName: string, parameters?: Record<string, unknown>): string {
  const category = getToolCategory(toolName)
  const unqualifiedName = stripToolNamespace((toolName || '').toLowerCase())
  const params = parameters || {}
  const filePath = (params.file_path as string) || (params.path as string) || ''
  const sourcePath =
    (params.from as string) ||
    (params.source as string) ||
    (params.sourcePath as string) ||
    (params.source_path as string) ||
    filePath
  const destinationPath =
    (params.to as string) ||
    (params.destination as string) ||
    (params.destinationPath as string) ||
    (params.destination_path as string) ||
    (params.target as string) ||
    ''
  const newName = (params.newName as string) || (params.name as string) || ''
  const beforePath =
    (params.before_path as string) ||
    (params.beforePath as string) ||
    (params.basePath as string) ||
    ''
  const afterPath =
    (params.after_path as string) ||
    (params.afterPath as string) ||
    (params.draftPath as string) ||
    ''
  const target = getFirstStringParam(params, ['target', 'participant', 'to', 'next'])

  if (isImageViewToolUse(toolName, params)) return IMAGE_VIEW_DISPLAY_NAME

  if (unqualifiedName === 'creative_app_status') return 'Creative app status'
  if (unqualifiedName === 'creative_app_capabilities') return 'Creative app capabilities'
  if (unqualifiedName === 'creative_project_snapshot') {
    return filePath ? `Creative project snapshot ${filePath}` : 'Creative project snapshot'
  }
  if (unqualifiedName === 'creative_timeline_validate') {
    return filePath ? `Validate timeline ${filePath}` : 'Validate timeline'
  }
  if (unqualifiedName === 'creative_timeline_ir') {
    return filePath ? `Timeline IR ${filePath}` : 'Timeline IR'
  }
  if (unqualifiedName === 'creative_timeline_diff') {
    return beforePath && afterPath ? `Timeline diff ${beforePath} -> ${afterPath}` : 'Timeline diff'
  }

  switch (category) {
    case 'task':
      if (unqualifiedName === 'ensemble_yield') {
        return target ? `Yielding to ${target}` : 'Yielding'
      }
      if (unqualifiedName === 'update_topic') {
        const topic =
          (params.title as string) || (params.topic as string) || (params.name as string) || ''
        return topic ? `Topic update: ${topic}` : 'Topic update'
      }
      if (unqualifiedName === 'codex_reasoning') return (params.title as string) || 'Thinking note'
      if (unqualifiedName === 'kimi_thinking') return (params.title as string) || 'Kimi thinking'
      if (isReasoningToolName(unqualifiedName)) return (params.title as string) || 'Thinking'
      if (unqualifiedName === 'codex_plan') return 'Plan update'
      if (unqualifiedName === 'invoke_agent') return (params.title as string) || 'Delegated task'
      if (unqualifiedName === 'summary') return (params.title as string) || 'Summary'
      if (unqualifiedName === 'intent') return (params.title as string) || 'Intent'
      // 1.0.4-AA — `exit_plan_mode` + `exitplanmode` were falling
      // through to the generic 'Task update' label and rendering
      // as "Used exitplanmode" in the UI. Provide a friendly
      // human-readable label instead.
      if (
        unqualifiedName === 'exit_plan_mode' ||
        unqualifiedName === 'exitplanmode' ||
        unqualifiedName === 'exit_planmode' ||
        unqualifiedName === 'exitplan_mode'
      ) {
        return 'Exited plan mode'
      }
      if (
        unqualifiedName === 'ask_user_question' ||
        unqualifiedName === 'askuserquestion' ||
        unqualifiedName === 'request_user_input' ||
        unqualifiedName === 'requestuserinput' ||
        unqualifiedName === 'request-user-input'
      ) {
        return 'Asked user'
      }
      if (unqualifiedName === 'get_diagnostics' || unqualifiedName === 'getdiagnostics') {
        return 'Checked diagnostics'
      }
      return (params.title as string) || 'Task update'
    case 'read':
      // 1.0.4-AA — match against the namespace-stripped/normalized
      // form so `list_directory`, `listdirectory`, `list_dir`, and
      // `listdir` all share the "Listed <path>" label.
      if (
        unqualifiedName === 'list_directory' ||
        unqualifiedName === 'listdirectory' ||
        unqualifiedName === 'list_dir' ||
        unqualifiedName === 'listdir'
      ) {
        return filePath ? `Listed ${filePath}` : 'Listed directory'
      }
      return filePath ? `Read ${filePath}` : 'Read file'
    case 'write': {
      // 1.0.4-AA — use the namespace-stripped unqualified form so
      // no-separator variants (`writefile`, `editfile`, `createfile`,
      // `deletefile`, `applypatch`, `strreplace`) hit the correct
      // verb branch instead of falling through to the generic
      // "Wrote file" default.
      const name = unqualifiedName
      if (
        name === 'replace' ||
        name.endsWith('__replace') ||
        name === 'edit' ||
        name === 'edit_file' ||
        name === 'editfile' ||
        name.endsWith('__edit_file') ||
        name === 'multiedit' ||
        name === 'notebookedit' ||
        name === 'apply_patch' ||
        name === 'applypatch' ||
        name.endsWith('__apply_patch') ||
        name.includes('str_replace') ||
        name === 'strreplace' ||
        name === 'strreplaceeditor'
      ) {
        return filePath ? `Edited ${filePath}` : 'Edited file'
      }
      if (name === 'create_file' || name === 'createfile' || name.endsWith('__create_file')) {
        return filePath ? `Created ${filePath}` : 'Created file'
      }
      if (name === 'delete_file' || name === 'deletefile' || name.endsWith('__delete_file')) {
        return filePath ? `Deleted ${filePath}` : 'Deleted file'
      }
      if (
        name === 'create_directory' ||
        name === 'createdirectory' ||
        name.endsWith('__create_directory')
      ) {
        return filePath ? `Created directory ${filePath}` : 'Created directory'
      }
      if (name === 'delete_path' || name === 'deletepath' || name.endsWith('__delete_path')) {
        return filePath ? `Deleted ${filePath}` : 'Deleted path'
      }
      if (name === 'move_path' || name === 'movepath' || name.endsWith('__move_path')) {
        return sourcePath && destinationPath
          ? `Moved ${sourcePath} -> ${destinationPath}`
          : 'Moved path'
      }
      if (name === 'rename_path' || name === 'renamepath' || name.endsWith('__rename_path')) {
        return sourcePath && newName ? `Renamed ${sourcePath} -> ${newName}` : 'Renamed path'
      }
      return filePath ? `Wrote ${filePath}` : 'Wrote file'
    }
    case 'search': {
      const query =
        (params.query as string) ||
        (params.search_query as string) ||
        (params.pattern as string) ||
        (params.taskQuery as string) ||
        (params.freeText as string) ||
        ''
      // Deterministic, target-specific search labels. Web / past-thread
      // (cross-thread recall) / workspace searches all used to collapse to the
      // misleading "Searched project" default — and Grok's ACP search, which
      // arrives as a bare `search` kind with no canonical name, hit it every
      // time. Key off the canonical tool name so the row says what was searched.
      if (unqualifiedName.includes('web_search')) {
        return query ? `Searched the web for ${query}` : 'Searched the web'
      }
      if (unqualifiedName.includes('tw_recall')) {
        return query ? `Searched past threads for ${query}` : 'Searched past threads'
      }
      if (unqualifiedName.includes('workspace_search')) {
        return query ? `Searched the workspace for ${query}` : 'Searched the workspace'
      }
      const searchPath = (params.path as string) || (params.dir as string) || ''
      return query ? `Searched for ${query}` : searchPath ? `Searched ${searchPath}` : 'Searched'
    }
    case 'shell':
      return 'Shell command'
    default: {
      // Catch-all branch. Order:
      //   1. Tool dictionary — friendly past-tense or noun-phrase
      //      label (e.g. delegate_to_subthread → "Delegated to
      //      sub-thread"). Renders standalone, no "Used " prefix.
      //   2. Snake-case title-case fallback (e.g. magic_tool →
      //      "Used Magic Tool"), keeping the "Used " prefix as a
      //      hint that this came through the generic path.
      //   3. The literal toolName (e.g. camelCase identifiers we
      //      can't safely re-split), still with the "Used " prefix.
      //   4. "Used unknown" when toolName is empty / "unknown".
      if (!toolName || toolName === 'unknown') return 'Used unknown'
      // A brokered MCP call whose inner tool name couldn't be unwrapped (some
      // Cursor stream shapes surface the bare `mcp` base) — read it as an MCP
      // tool rather than the raw "Used mcp".
      if (
        unqualifiedName === 'mcp' ||
        unqualifiedName === 'callmcptool' ||
        unqualifiedName === 'call_mcp_tool' ||
        unqualifiedName === 'use_tool'
      ) {
        return 'Used an MCP tool'
      }
      const friendly = lookupToolDisplayName(unqualifiedName)
      if (friendly) return friendly
      const titleCased = titleCaseToolName(unqualifiedName)
      return `Used ${titleCased || toolName}`
    }
  }
}

/**
 * The "replaced this text with that text" pair, under every spelling a provider
 * has been observed to use: snake_case (Claude/Codex/Ollama/broker MCP tools),
 * camelCase (Mistral Vibe serializes its ACP arguments through a `to_camel`
 * pydantic alias generator), and AntiGravity's TitleCase.
 *
 * Shared by `estimateLineChanges` and `deriveToolDiffSummary` on purpose: when
 * only the former knew the aliases, a camelCase edit was counted correctly and
 * then mislabelled `source: 'content'`, which in turn read as `confidence:
 * 'exact'` and dropped the `~` marker the identical snake_case edit shows.
 *
 * An EMPTY string deliberately does not qualify (the `&&` chain skips it), which
 * matches the original behaviour: a pure insertion (`old_string: ''`) reports no
 * stats rather than a misleading `-1`.
 */
function resolveReplacedText(parameters: Record<string, unknown>): string | undefined {
  return (
    (typeof parameters.old_string === 'string' && parameters.old_string) ||
    (typeof parameters.oldString === 'string' && parameters.oldString) ||
    (typeof parameters.old_text === 'string' && parameters.old_text) ||
    (typeof parameters.oldText === 'string' && parameters.oldText) ||
    (typeof parameters.TargetContent === 'string' && parameters.TargetContent) ||
    (typeof parameters.targetContent === 'string' && parameters.targetContent) ||
    (typeof parameters.target_content === 'string' && parameters.target_content) ||
    (typeof parameters.old === 'string' && parameters.old) ||
    undefined
  )
}

function resolveReplacementText(parameters: Record<string, unknown>): string | undefined {
  return (
    (typeof parameters.new_string === 'string' && parameters.new_string) ||
    (typeof parameters.newString === 'string' && parameters.newString) ||
    (typeof parameters.new_text === 'string' && parameters.new_text) ||
    (typeof parameters.newText === 'string' && parameters.newText) ||
    (typeof parameters.ReplacementContent === 'string' && parameters.ReplacementContent) ||
    (typeof parameters.replacementContent === 'string' && parameters.replacementContent) ||
    (typeof parameters.replacement_content === 'string' && parameters.replacement_content) ||
    (typeof parameters.new === 'string' && parameters.new) ||
    undefined
  )
}

/** True when the parameters describe a text-for-text replacement, in any spelling. */
function looksLikeStringReplacement(parameters?: Record<string, unknown>): boolean {
  if (!parameters) return false
  return (
    resolveReplacedText(parameters) !== undefined &&
    resolveReplacementText(parameters) !== undefined
  )
}

export function estimateLineChanges(parameters?: Record<string, unknown>): {
  additions?: number
  deletions?: number
} {
  if (!parameters) return {}

  const explicitAdditions =
    typeof parameters.additions === 'number'
      ? parameters.additions
      : typeof parameters.additions === 'string'
        ? parseInt(parameters.additions, 10)
        : undefined
  const explicitDeletions =
    typeof parameters.deletions === 'number'
      ? parameters.deletions
      : typeof parameters.deletions === 'string'
        ? parseInt(parameters.deletions, 10)
        : undefined
  if (
    (explicitAdditions !== undefined && !Number.isNaN(explicitAdditions)) ||
    (explicitDeletions !== undefined && !Number.isNaN(explicitDeletions))
  ) {
    return {
      additions:
        explicitAdditions !== undefined && !Number.isNaN(explicitAdditions) ? explicitAdditions : 0,
      deletions:
        explicitDeletions !== undefined && !Number.isNaN(explicitDeletions) ? explicitDeletions : 0
    }
  }
  const oldString = resolveReplacedText(parameters)
  const newString = resolveReplacementText(parameters)
  if (typeof oldString === 'string' && typeof newString === 'string') {
    const oldLines = oldString.split('\n').length
    const newLines = newString.split('\n').length
    return { additions: newLines, deletions: oldLines }
  }
  const content =
    (typeof parameters.content === 'string' && parameters.content) ||
    (typeof parameters.file_text === 'string' && parameters.file_text) ||
    (typeof parameters.CodeContent === 'string' && parameters.CodeContent) ||
    (typeof parameters.codeContent === 'string' && parameters.codeContent) ||
    (typeof parameters.CodeEdit === 'string' && parameters.CodeEdit) ||
    undefined
  if (typeof content === 'string') {
    return { additions: content.split('\n').length, deletions: 0 }
  }
  return {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : undefined
}

function normalizeStatus(value: unknown): ToolDiffFileSummary['status'] {
  const status = String(value || '').toLowerCase()
  if (status === 'add' || status === 'create' || status === 'created' || status === 'new')
    return 'created'
  if (status === 'delete' || status === 'deleted' || status === 'remove' || status === 'removed')
    return 'deleted'
  if (status === 'rename' || status === 'renamed' || status === 'move' || status === 'moved')
    return 'renamed'
  if (status === 'mkdir' || status === 'directory' || status === 'create_directory')
    return 'created'
  if (status === 'modify' || status === 'modified' || status === 'edit' || status === 'update')
    return 'modified'
  return status ? (status as DiffFileStatus | 'updated' | 'unknown') : 'unknown'
}

function getPathFromRecord(record: Record<string, unknown>): string | undefined {
  const path =
    stringValue(record.path) ||
    stringValue(record.filePath) ||
    stringValue(record.file_path) ||
    stringValue(record.TargetFile) ||
    stringValue(record.targetFile) ||
    stringValue(record.target_file) ||
    stringValue(record.target_file_path) ||
    stringValue(record.AbsolutePath) ||
    stringValue(record.absolutePath) ||
    stringValue(record.absolute_path) ||
    stringValue(record.from) ||
    stringValue(record.source) ||
    stringValue(record.sourcePath) ||
    stringValue(record.source_path) ||
    stringValue(record.to) ||
    stringValue(record.destination) ||
    stringValue(record.destinationPath) ||
    stringValue(record.destination_path) ||
    stringValue(record.target)
  return path.trim() || undefined
}

function summarizeFiles(
  files: ToolDiffFileSummary[],
  source: ToolDiffSummary['source'],
  confidence: ToolDiffSummary['confidence']
): ToolDiffSummary | undefined {
  if (files.length === 0) return undefined
  let hasStats = false
  const totals = files.reduce<{ additions: number; deletions: number }>(
    (acc, file) => {
      if (file.additions !== undefined || file.deletions !== undefined) hasStats = true
      acc.additions += file.additions || 0
      acc.deletions += file.deletions || 0
      return acc
    },
    { additions: 0, deletions: 0 }
  )

  return {
    additions: hasStats ? totals.additions : undefined,
    deletions: hasStats ? totals.deletions : undefined,
    files,
    source,
    confidence: hasStats ? confidence : 'unknown'
  }
}

function parseChanges(value: unknown): ToolDiffSummary | undefined {
  if (!Array.isArray(value)) return undefined
  const files = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item))
    )
    .map((item) => ({
      path: getPathFromRecord(item),
      status: normalizeStatus(item.kind || item.type || item.operation || item.status),
      additions: numberValue(item.additions ?? item.added ?? item.linesAdded ?? item.insertions),
      deletions: numberValue(item.deletions ?? item.deleted ?? item.linesDeleted ?? item.removals)
    }))

  return summarizeFiles(files, 'codex_changes', 'exact')
}

export function parseUnifiedDiffSummary(diffText: string): ToolDiffSummary | undefined {
  if (!diffText.trim()) return undefined

  // A real unified diff carries structural markers — a hunk header (`@@ -a,b +c,d @@`),
  // a `diff --git` line, or a `+++`/`---` file-header pair. Without any of these, the
  // text is just prose (a reasoning trace, an assistant message, a result blob) and
  // counting lines that merely START with +/- would invent a bogus diff — e.g. a
  // markdown bullet "- item" in a Grok/Kimi thinking trace surfaced as a phantom
  // "+0 -1" on the Thinking card. Require structure before counting anything.
  const hasDiffStructure =
    /^@@ .*@@/m.test(diffText) ||
    /^diff --git /m.test(diffText) ||
    (/^\+\+\+ /m.test(diffText) && /^--- /m.test(diffText))
  if (!hasDiffStructure) return undefined

  const files: ToolDiffFileSummary[] = []
  let current: ToolDiffFileSummary | null = null

  const commitCurrent = () => {
    if (current) {
      files.push(current)
      current = null
    }
  }

  for (const line of diffText.split('\n')) {
    const diffHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (diffHeader) {
      commitCurrent()
      current = {
        path: diffHeader[2] || diffHeader[1],
        status: 'modified',
        additions: 0,
        deletions: 0
      }
      continue
    }

    if (!current) {
      current = { additions: 0, deletions: 0, status: 'unknown' }
    }

    if (line.startsWith('+++ b/')) current.path = line.slice(6)
    if (line.startsWith('new file mode')) current.status = 'created'
    if (line.startsWith('deleted file mode')) current.status = 'deleted'
    if (line.startsWith('+') && !line.startsWith('+++'))
      current.additions = (current.additions || 0) + 1
    if (line.startsWith('-') && !line.startsWith('---'))
      current.deletions = (current.deletions || 0) + 1
  }

  commitCurrent()
  const usefulFiles = files.filter((file) => file.path || file.additions || file.deletions)
  return summarizeFiles(usefulFiles, 'patch_preview', 'exact')
}

function getPatchPreview(parameters?: Record<string, unknown>, resultText?: string): string {
  if (!parameters) return resultText || ''
  return (
    stringValue(parameters.patchPreview) ||
    stringValue(parameters.patch_preview) ||
    stringValue(parameters.patch) ||
    stringValue(parameters.diff) ||
    stringValue(parameters.unifiedDiff) ||
    stringValue(parameters.unified_diff) ||
    resultText ||
    ''
  )
}

export function deriveToolDiffSummary(
  toolName: string,
  parameters?: Record<string, unknown>,
  resultText?: string
): ToolDiffSummary | undefined {
  // Reasoning / thinking pseudo-activities (`grok_thinking`, `kimi_thinking`, …) carry
  // free-form prose as their "result", never a file edit. Never derive a diff for them
  // — otherwise a markdown bullet in the reasoning trace is miscounted as a deletion.
  const lowerTool = (toolName || '').toLowerCase()
  if (isReasoningToolName(lowerTool)) return undefined
  if (typeof parameters?.kind === 'string' && parameters.kind.toLowerCase() === 'reasoning') {
    return undefined
  }
  const category = getToolCategory(toolName)
  const changesSummary = parseChanges(parameters?.changes)
  if (
    changesSummary?.confidence === 'exact' &&
    ((changesSummary.additions || 0) > 0 || (changesSummary.deletions || 0) > 0)
  ) {
    return changesSummary
  }

  const patchPreview = getPatchPreview(parameters, resultText)
  const patchSummary = parseUnifiedDiffSummary(patchPreview)
  if (patchSummary) {
    const path = parameters ? getPathFromRecord(parameters) : undefined
    if (path) {
      return {
        ...patchSummary,
        files: (patchSummary.files || []).map((file) => ({
          ...file,
          path: file.path || path
        }))
      }
    }
    return patchSummary
  }

  if (changesSummary) return changesSummary

  const replacement = estimateLineChanges(parameters)
  if (replacement.additions !== undefined || replacement.deletions !== undefined) {
    const path = parameters ? getPathFromRecord(parameters) : undefined
    const source = looksLikeStringReplacement(parameters) ? 'string_replace' : 'content'
    return {
      additions: replacement.additions || 0,
      deletions: replacement.deletions || 0,
      files: [
        {
          path,
          status:
            category === 'write' && toolName.toLowerCase() === 'create_file'
              ? 'created'
              : 'modified',
          additions: replacement.additions || 0,
          deletions: replacement.deletions || 0
        }
      ],
      source,
      confidence:
        source === 'content' && toolName.toLowerCase() !== 'edit_file' ? 'exact' : 'estimated'
    }
  }

  return undefined
}

export function createToolActivity(toolUseEvent: any): ToolActivity {
  const rawToolName = extractToolName(toolUseEvent)
  const rawParameters = extractParameters(toolUseEvent)
  const toolName = canonicalImageViewToolName(rawToolName, rawParameters)
  const parameterImageCount =
    toolName === IMAGE_VIEW_TOOL_NAME ? imageViewCountFromParameters(rawParameters) : undefined
  const parameters = parameterImageCount
    ? { ...rawParameters, imageCount: parameterImageCount }
    : rawParameters
  // Prefer a transport-supplied canonical kind (e.g. Grok ACP `tool_kind`) for
  // the category icon — the human tool label is often a freeform title ("Write
  // `package.json`") that name-based resolution can't categorise. Fall back to
  // name-based resolution when no usable kind is present.
  const category =
    toolName === IMAGE_VIEW_TOOL_NAME
      ? 'read'
      : (mapToolKindToCategory(extractToolKind(toolUseEvent)) ?? getToolCategory(toolName))
  const displayName = getToolDisplayName(toolName, parameters)
  const filePath = getPathFromRecord(parameters)
  const parentToolCallId = extractParentToolCallId(toolUseEvent)
  const provider = extractToolProvider(toolUseEvent)

  return {
    id: extractToolId(toolUseEvent),
    toolName,
    displayName,
    category,
    status: 'running',
    startedAt: new Date().toISOString(),
    parameters,
    filePath,
    diffSummary: deriveToolDiffSummary(toolName, parameters),
    rawUseEvent: toolUseEvent,
    parentToolCallId,
    ...(provider ? { metadata: { provider } } : {}),
    // Legacy fields
    operationCategory: category as any,
    affectedFilePath: filePath
  }
}

function normalizeInferredPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.。]+$/g, '')
    .trim()
}

function inferNamelessActivityFromResult(
  activity: ToolActivity,
  resultOutput: string
): Partial<ToolActivity> {
  if ((activity.toolName || '').trim().toLowerCase() !== 'unknown') return {}
  const trimmed = resultOutput.trim()
  const fileMatch = trimmed.match(/^(edited|created|deleted|wrote|read|listed)\s+(.+?)\.?$/i)
  if (fileMatch) {
    const verb = fileMatch[1].toLowerCase()
    const path = normalizeInferredPath(fileMatch[2] || '')
    if (!path) return {}
    const toolName =
      verb === 'created'
        ? 'create_file'
        : verb === 'deleted'
          ? 'delete_file'
          : verb === 'wrote'
            ? 'write_file'
            : verb === 'read'
              ? 'read_file'
              : verb === 'listed'
                ? 'list_directory'
                : 'edit_file'
    const category: ToolCategory = verb === 'read' || verb === 'listed' ? 'read' : 'write'
    const parameters = { ...(activity.parameters || {}), file_path: path }
    const diffSummary: ToolDiffSummary | undefined =
      category === 'write'
        ? {
            files: [
              {
                path,
                status: verb === 'created' ? 'created' : verb === 'deleted' ? 'deleted' : 'modified'
              }
            ],
            source: 'unknown',
            confidence: 'unknown'
          }
        : undefined
    return {
      toolName,
      displayName: getToolDisplayName(toolName, parameters),
      category,
      parameters,
      filePath: path,
      affectedFilePath: path,
      operationCategory: category === 'write' ? 'edit_file' : 'read_file',
      ...(diffSummary ? { diffSummary } : {})
    }
  }

  const searchMatch = trimmed.match(
    /^searched(?:\s+(?:for|the workspace for|the web for))?\s+(.+?)\.?$/i
  )
  if (searchMatch) {
    const query = normalizeInferredPath(searchMatch[1] || '')
    if (!query) return {}
    const parameters = { ...(activity.parameters || {}), query }
    return {
      toolName: 'search',
      displayName: getToolDisplayName('search', parameters),
      category: 'search',
      parameters,
      operationCategory: 'search'
    }
  }

  return {}
}

export function pairToolResult(activity: ToolActivity, toolResultEvent: any): ToolActivity {
  const resultOutput = extractResultOutput(toolResultEvent)
  const status = extractStatus(toolResultEvent)
  const endedAt = new Date().toISOString()
  const durationMs = activity.startedAt
    ? new Date(endedAt).getTime() - new Date(activity.startedAt).getTime()
    : undefined

  // Reasoning / thinking traces are the one result the user explicitly wants
  // to read in full in the transcript, so they bypass the 500-char preview cap
  // that keeps ordinary (potentially huge) tool output bounded. The render
  // layer still bounds the live-streaming view; the full text shows once the
  // reasoning activity settles. See ActivityStack buildSanitizedDetail.
  const isReasoning = isReasoningToolName(activity.toolName || '')
  const summaryText = isReasoning
    ? resultOutput
    : resultOutput.substring(0, 500) + (resultOutput.length > 500 ? '...' : '')
  const inferred = inferNamelessActivityFromResult(activity, resultOutput)
  const inferredToolName = inferred.toolName || activity.toolName
  const inferredParameters = inferred.parameters || activity.parameters
  const imageView = isImageViewToolUse(inferredToolName, inferredParameters)
  const returnedImageCount = imageView ? imageViewCountFromResult(toolResultEvent) : undefined
  const pairedParameters = returnedImageCount
    ? { ...(inferredParameters || {}), imageCount: returnedImageCount }
    : inferredParameters

  return {
    ...activity,
    ...inferred,
    ...(imageView
      ? {
          toolName: IMAGE_VIEW_TOOL_NAME,
          displayName: IMAGE_VIEW_DISPLAY_NAME,
          category: 'read' as const
        }
      : {}),
    parameters: pairedParameters,
    status,
    endedAt,
    durationMs,
    // "Freshly derived wins" is deliberate here — a result-derived diff should beat
    // the parameter guess made at tool-use time — but it also discards a MEASURED
    // summary, which must never be displaced by an estimate. The guard asserts only
    // that; every estimate-versus-estimate outcome below is unchanged.
    diffSummary: preserveMeasuredDiffSummary(
      activity.diffSummary,
      deriveToolDiffSummary(inferredToolName, pairedParameters, resultOutput) ||
        inferred.diffSummary ||
        activity.diffSummary
    ),
    resultSummary: summaryText,
    outputPreview: summaryText,
    rawResultEvent: toolResultEvent,
    // Legacy
    outputSummary: summaryText
  }
}

export function isToolUseEvent(event: any): boolean {
  if (!event || typeof event !== 'object') return false
  return event.type === 'tool_use' || event.type === 'tool_call'
}

export function isToolResultEvent(event: any): boolean {
  if (!event || typeof event !== 'object') return false
  return (
    event.type === 'tool_result' || event.type === 'tool_output' || event.type === 'tool_response'
  )
}
