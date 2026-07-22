// Pure parser for the Cursor Agent CLI's `--output-format stream-json` NDJSON
// stream (`cursor-agent -p --output-format stream-json …`). No Electron / fs /
// child_process imports — unit-testable against fixtures captured from the real
// 2026.05.28 agent.
//
// Tool *names* emitted on tool_use events are Settings-catalog names when the
// shared coalescer can resolve them (WS-C). Provider-native Cursor bases
// (Shell, edit, glob, …) adapt through `resolveCatalogToolName` rather than a
// parallel alias table in this file.
//
// Confirmed wire shape (one JSON object per line, top-level `type`):
//   {type:"system", subtype:"init", session_id, model, cwd, permissionMode}
//   {type:"user", message:{role,content:[{type:"text",text}]}, session_id}
//   {type:"assistant", message:{role,content:[{type:"text",text}]}, session_id,
//      model_call_id, timestamp_ms}                          ← streamed answer
//   {type:"thinking", subtype:"delta"|"completed", text?, session_id}
//   {type:"tool_call", subtype:"started"|"completed", call_id,
//      tool_call:{ <name>ToolCall:{ args, result? } }, session_id}
//   {type:"result", subtype, is_error, duration_ms, result:"<final md>",
//      session_id, request_id, usage:{inputTokens,outputTokens,cacheReadTokens,
//      cacheWriteTokens}}                                    ← real token usage
//
// Tool name = the single nested key under `tool_call` ("globToolCall",
// "readToolCall", "editToolCall", "shellToolCall", "grepToolCall",
// "createPlanToolCall", …); args under `.args`, output under `.result`.

import { resolveCatalogToolName } from '../../shared/canonicalToolCoalesce'

export interface CursorUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface NormalizedCursorRunEvent {
  type: 'init' | 'content' | 'thinking' | 'result' | 'provider_warning' | 'tool_use' | 'tool_result'
  text?: string
  sessionId?: string
  /** Model label from the system/init event, e.g. "Composer 2.5 Fast". */
  model?: string
  /** Terminal status on a 'result' event ('success' or a failure reason). */
  status?: string
  /** Real token usage on the terminal 'result' event. */
  usage?: CursorUsage
  // Tool-call fields — populated only for 'tool_use' / 'tool_result'.
  toolId?: string
  toolName?: string
  /** Canonical kind (read|edit|delete|move|search|execute|think|fetch) for the
   *  renderer's category icon (AD3) — the Cursor tool name isn't always one the
   *  name-based resolver recognises. */
  toolKind?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'success' | 'error'
  toolOutput?: string
  raw?: unknown
}

export interface CursorTerminalCompatOutcome {
  failed: boolean
  status: 'success' | 'failed'
  subtype: 'success' | 'error'
  text?: string
}

/**
 * Convert Cursor's normalized terminal event into the provider-agnostic
 * result contract consumed by TaskWraith. Cursor can report `is_error: true`
 * while the CLI process exits 0, so process exit alone is not authoritative.
 */
export function cursorTerminalCompatOutcome(
  event: NormalizedCursorRunEvent
): CursorTerminalCompatOutcome | null {
  if (event.type !== 'result') return null
  const failed = event.status !== 'success'
  return {
    failed,
    status: failed ? 'failed' : 'success',
    subtype: failed ? 'error' : 'success',
    ...(typeof event.text === 'string' && event.text ? { text: event.text } : {})
  }
}

/** Cursor's protocol result outranks its wrapper process' zero exit status. */
export function cursorEffectiveExitCode(
  processExitCode: number | null,
  terminalResultFailed: boolean
): number | null {
  return terminalResultFailed && processExitCode === 0 ? 1 : processExitCode
}

/**
 * Preserve both Cursor's failure subtype and optional result detail for the
 * shared error classifier. Some overflow failures carry only the subtype.
 */
export function cursorTerminalFailureText(event: NormalizedCursorRunEvent): string {
  const outcome = cursorTerminalCompatOutcome(event)
  if (!outcome?.failed) return ''
  return (
    [event.status, outcome.text].filter((part): part is string => Boolean(part)).join(': ') ||
    'Cursor terminal result failed.'
  )
}

export interface CursorStreamLine {
  json?: Record<string, unknown>
  nonJson?: string
}

/**
 * Split a streaming-json chunk into NDJSON lines, carrying any partial trailing
 * line across chunk boundaries. `carry` is the leftover from the previous call
 * ('' on first call). Mirrors the line-buffering in `runCliProviderProcess`.
 */
export function parseCursorStreamChunk(
  rawChunk: string,
  carry: string
): { lines: CursorStreamLine[]; carry: string } {
  const buffer = (carry || '') + (rawChunk || '')
  const segments = buffer.split(/\r?\n/)
  const nextCarry = segments.pop() ?? ''
  const lines: CursorStreamLine[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push({ json: parsed as Record<string, unknown> })
      } else {
        lines.push({ nonJson: segment })
      }
    } catch {
      lines.push({ nonJson: segment })
    }
  }
  return { lines, carry: nextCarry }
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function coerceToolOutput(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object') {
      try {
        return JSON.stringify(v)
      } catch {
        /* fall through */
      }
    }
  }
  return ''
}

/** Concatenate the text blocks of a {message:{content:[{type:'text',text}]}}. */
function extractMessageText(message: unknown): string {
  const msg = asRecord(message)
  if (!msg) return ''
  if (typeof msg.text === 'string') return msg.text
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const b = asRecord(block)
    if (b && typeof b.text === 'string') out += b.text
  }
  return out
}

/**
 * Map a Cursor tool base name (the `tool_call` key with "ToolCall" stripped) to
 * the AD3 canonical kind so the renderer picks the right category icon.
 */
export function cursorToolKind(base: string): string | undefined {
  switch (base.toLowerCase()) {
    case 'read':
    case 'readfile':
    case 'ls':
    case 'list':
    case 'listdir':
    case 'readlints':
      return 'read'
    case 'glob':
    case 'grep':
    case 'search':
    case 'codebasesearch':
    case 'semanticsearch':
    case 'web_search':
    case 'websearch':
    case 'googlewebsearch':
      return 'search'
    case 'edit':
    case 'write':
    case 'create':
    case 'createfile':
    case 'multiedit':
    case 'searchreplace':
    case 'applypatch':
      return 'edit'
    case 'delete':
    case 'deletefile':
    case 'remove':
      return 'delete'
    case 'shell':
    case 'run':
    case 'runterminal':
    case 'runterminalcommand':
    case 'terminal':
      return 'execute'
    case 'createplan':
    case 'plan':
    case 'todo':
    case 'todowrite':
    case 'updatetodo':
      return 'think'
    case 'webfetch':
    case 'web_fetch':
    case 'fetch':
    case 'web':
      return 'fetch'
    default:
      return undefined
  }
}

/**
 * Cursor-only display names that are not Settings-catalog tools.
 * Catalog-mapped aliases live in `NATIVE_ALIAS_TO_CATALOG_TOOL` — do not
 * re-add shell/edit/search ladders here (WS-C single-map rule).
 */
const CURSOR_NON_CATALOG_DISPLAY: Readonly<Record<string, string>> = {
  createplan: 'create_plan',
  plan: 'create_plan',
  updatetodo: 'update_todo_list',
  updatetodolist: 'update_todo_list'
}

/**
 * Map a Cursor tool base name to the Settings catalog machine name when
 * possible (so policy chips, ToolFamilyIcon, and audit normalizers all see
 * the same identifier). Non-catalog Cursor-only tools keep a stable local
 * display name. Falls back to a light snake_case of the base.
 */
export function cursorToolName(base: string): string {
  const raw = String(base || '').trim()
  if (!raw) return 'tool'
  const catalog = resolveCatalogToolName(raw)
  if (catalog) return catalog
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const nonCatalog = CURSOR_NON_CATALOG_DISPLAY[compact]
  if (nonCatalog) return nonCatalog
  // Light camelCase → snake for unknown Cursor bases (display only).
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
  return snake || raw || 'tool'
}

/**
 * Normalize a Cursor tool-call args object into the field names the renderer's
 * diff machinery understands.
 *
 * Cursor's edit/write tool (`editToolCall`) streams the NEW file content under
 * `streamContent` and the target under `path`, and sends NO `old_string` /
 * `new_string` (confirmed against the real 2026.05.28 agent — it's a
 * content-replacement edit, not a string-replace patch). The renderer's
 * `deriveToolDiffSummary` / `estimateLineChanges` (ToolParser.ts) only derive a
 * diff from `old_string`+`new_string` or `content`, so without this mapping a
 * Cursor edit renders a bare tool card with no inline diff. Exposing
 * `streamContent` as `content` lights up the content-based path (additions =
 * the streamed lines); `path` is already read by `getPathFromRecord`. Since
 * Cursor omits the prior text, the preview is additions-only (no deletions) —
 * the honest representation of what the stream actually carries.
 */
export function normalizeCursorToolArgs(
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...(args || {}) }
  if (typeof input.streamContent === 'string' && typeof input.content !== 'string') {
    input.content = input.streamContent
  }
  return input
}

/** Pull the single `<name>ToolCall` entry out of a `tool_call` object. */
function extractToolCall(
  toolCall: unknown
): { base: string; args?: Record<string, unknown>; result?: unknown } | undefined {
  const tc = asRecord(toolCall)
  if (!tc) return undefined
  const key = Object.keys(tc)[0]
  if (!key) return undefined
  const inner = asRecord(tc[key])
  let base = key.replace(/ToolCall$/i, '')
  // CRUX40 — MCP tools surface as `mcpToolCall` with the REAL tool under
  // `toolName` (e.g. "web_fetch") + a `providerIdentifier` (e.g. "taskwraith"). Use
  // the nested tool name so the card reads "Fetched a web page" / "Searched web
  // for …" (via ToolDisplayNames) instead of the generic "Used mcp". Falls back
  // to `name` (provider-prefixed) then the literal `mcp` base.
  if (base.toLowerCase() === 'mcp') {
    const nested =
      (typeof inner?.toolName === 'string' && inner.toolName) ||
      (typeof inner?.name === 'string' && inner.name) ||
      ''
    if (nested) base = nested
  }
  return { base, args: asRecord(inner?.args), result: inner?.result }
}

/** Coerce a Cursor usage object to the normalized shape. */
function extractUsage(usage: unknown): CursorUsage | undefined {
  const u = asRecord(usage)
  if (!u) return undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const out: CursorUsage = {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens)
  }
  return out.inputTokens != null || out.outputTokens != null ? out : undefined
}

/**
 * Map a single parsed NDJSON line to zero or more normalized run events. Never
 * throws; genuinely-unknown event types are ignored. Top-level types: system /
 * user / assistant / thinking / tool_call / result (+ defensive text/error).
 */
export function cursorEventToRunEvents(line: CursorStreamLine): NormalizedCursorRunEvent[] {
  if (line.nonJson != null) {
    // Non-JSON stdout (banner / warning) is surfaced verbatim, never dropped.
    return [{ type: 'content', text: `${line.nonJson}\n`, raw: line.nonJson }]
  }
  const obj = line.json
  if (!obj) return []
  const eventType = typeof obj.type === 'string' ? obj.type : ''
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : ''
  const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined

  switch (eventType) {
    case 'system':
      // init handshake — carries the resumable session id + model label.
      return [
        {
          type: 'init',
          sessionId,
          model: typeof obj.model === 'string' ? obj.model : undefined,
          raw: obj
        }
      ]
    case 'user':
      // Echo of our own prompt — never re-emitted.
      return []
    case 'assistant': {
      const text = extractMessageText(obj.message)
      return text ? [{ type: 'content', text, sessionId, raw: obj }] : []
    }
    case 'text':
      // Defensive: streamed answer delta (--stream-partial-output).
      return typeof obj.text === 'string' && obj.text
        ? [{ type: 'content', text: obj.text, sessionId, raw: obj }]
        : []
    case 'thinking': {
      // Reasoning delta; the 'completed' marker has no text.
      const text = typeof obj.text === 'string' ? obj.text : ''
      return text ? [{ type: 'thinking', text, sessionId, raw: obj }] : []
    }
    case 'tool_call': {
      const tc = extractToolCall(obj.tool_call)
      if (!tc) return []
      const toolId = firstString(obj.call_id, obj.callId, obj.id) || undefined
      if (subtype === 'completed') {
        // Success shape: result = { success: {...} }. Error/denial shape:
        // result = { writePermissionDenied|permissionDenied|…: { error, … } }
        // (any single key that isn't `success`). So error == has a result but
        // no `success` key; surface the nested `.error` message when present.
        const resultRec = asRecord(tc.result)
        const isSuccess = !resultRec || 'success' in resultRec
        let output = ''
        if (resultRec && 'success' in resultRec) {
          output = coerceToolOutput(resultRec.success)
        } else if (resultRec) {
          const firstVal = asRecord(Object.values(resultRec)[0])
          output =
            firstString(typeof firstVal?.error === 'string' ? firstVal.error : '') ||
            coerceToolOutput(resultRec)
        } else {
          output = coerceToolOutput(tc.result)
        }
        return [
          {
            type: 'tool_result',
            toolId,
            toolStatus: isSuccess ? 'success' : 'error',
            toolOutput: output,
            raw: obj
          }
        ]
      }
      // 'started' (and any non-completed) opens the activity card.
      return [
        {
          type: 'tool_use',
          toolId,
          toolName: cursorToolName(tc.base),
          toolKind: cursorToolKind(tc.base),
          toolInput: normalizeCursorToolArgs(tc.args),
          raw: obj
        }
      ]
    }
    case 'result': {
      const isError = obj.is_error === true
      const status = isError ? subtype || 'failed' : 'success'
      return [
        {
          type: 'result',
          status,
          sessionId,
          usage: extractUsage(obj.usage),
          text: typeof obj.result === 'string' ? obj.result : undefined,
          raw: obj
        }
      ]
    }
    case 'error':
      return [
        {
          type: 'provider_warning',
          text: firstString(obj.message, obj.error, obj.text) || 'Cursor reported an error.',
          raw: obj
        }
      ]
    default:
      return []
  }
}
