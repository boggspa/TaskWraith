// Pure NDJSON parser + event mapper for `grok -p ... --output-format
// streaming-json`. No Electron / fs / child_process imports — unit-testable
// against fixture strings captured from the real Grok 0.2.3 CLI.
//
// Grok's streaming-json is its OWN shape (NOT Claude Code's): newline-delimited
// objects with a `type` discriminator and the payload text in `data`:
//   {"type":"thought","data":"..."}   reasoning / thinking token
//   {"type":"text","data":"..."}      assistant answer token
//   {"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"..."}
// All Grok-specific shape knowledge lives in `grokEventToRunEvents` (the single
// function to adjust if a future CLI version changes the wire shape).
//
// G5d/G5e CAPTURE (grok 0.2.8, TASKWRAITH_GROK_DEBUG live runs): the headless
// streaming-json stream carries ONLY `thought` / `text` / `end`. Grok's actual
// tool calls — read/list_dir/grep, the denied `find`, and file writes — run
// INVISIBLY: not a single tool event reaches stdout. So inline tool-call
// activity cards are impossible on the headless transport (the run-diff "File
// changes" card is the only side-effect surface); rendering Grok tool calls
// requires the ACP transport (`grok agent stdio`, which emits structured
// `session/update` tool_call notifications). The best-effort tool_use/tool_call
// cases below are kept for ACP / a future CLI that flattens tool events inline.
// `end.stopReason` can be 'Cancelled' — Grok self-cancels a turn mid-reasoning,
// exiting 0; the runtime maps that to an honest result status (see G5e).

export interface GrokStreamLine {
  /** Parsed JSON object for a well-formed NDJSON line. */
  json?: Record<string, unknown>
  /** Raw text for a non-JSON line (banner, warning, malformed) — never dropped. */
  nonJson?: string
}

export interface NormalizedGrokRunEvent {
  type: 'init' | 'content' | 'thinking' | 'result' | 'provider_warning' | 'tool_use' | 'tool_result'
  text?: string
  sessionId?: string
  status?: string
  /** Tool-call fields (G5d) — populated only for 'tool_use' / 'tool_result'. */
  toolId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  /** Late ACP tool-call evidence carried by a terminal update. */
  toolResultInput?: Record<string, unknown>
  toolStatus?: 'success' | 'error'
  toolOutput?: string
  /**
   * Canonical ACP tool kind (read | edit | delete | move | search | execute |
   * think | fetch | other) when the transport supplies one. Threaded to the
   * renderer so the activity card resolves the right category icon even when
   * the human `title` (used as toolName/label) isn't a recognised tool name —
   * e.g. ACP titles like "Write `package.json`" or "Run terminal command".
   */
  toolKind?: string
  raw?: unknown
}

/**
 * Split a streaming-json chunk into NDJSON lines, carrying any partial trailing
 * line across chunk boundaries. `carry` is the leftover from the previous call
 * ('' on first call). Mirrors the line-buffering in `runCliProviderProcess`.
 */
export function parseGrokStreamChunk(
  rawChunk: string,
  carry: string
): { lines: GrokStreamLine[]; carry: string } {
  const buffer = (carry || '') + (rawChunk || '')
  const segments = buffer.split(/\r?\n/)
  const nextCarry = segments.pop() ?? ''
  const lines: GrokStreamLine[] = []
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

/** First non-empty string among the candidates (defensive field lookup). */
function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v
  return ''
}

/** A plain object, or undefined for anything else (arrays/scalars/null). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Coerce a tool-result payload to display text (stringify structured output). */
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

/**
 * Map a single parsed NDJSON line to zero or more normalized run events. Never
 * throws; genuinely-unknown event types are ignored. Grok's shape: `{type,
 * data}` for thought/text, a terminal `{type:'end', stopReason, sessionId}`,
 * and (G5d) best-effort tool-call events.
 *
 * G5d NOTE: Grok's headless tool-event wire shape is still undocumented — the
 * tool_use / tool_result cases below read the *most likely* flattened field
 * names (Grok is Claude-Code-modelled). Set TASKWRAITH_GROK_DEBUG=1 to capture the
 * real shape from a live run; if it differs, extend the field lookups here (the
 * single place that owns Grok's wire shape). Claude-style *nested* tool events
 * (`message.content[].tool_use`) are handled separately by the shared
 * `emitCliProviderToolEvent` sink, so both shapes are covered.
 */
export function grokEventToRunEvents(line: GrokStreamLine): NormalizedGrokRunEvent[] {
  if (line.nonJson != null) {
    // Non-JSON stdout (banner / warning) is surfaced verbatim, never dropped.
    return [{ type: 'content', text: `${line.nonJson}\n`, raw: line.nonJson }]
  }
  const obj = line.json
  if (!obj) return []
  const eventType = typeof obj.type === 'string' ? obj.type : ''
  const data = typeof obj.data === 'string' ? obj.data : ''

  switch (eventType) {
    case 'text':
      // Assistant answer token.
      return data ? [{ type: 'content', text: data, raw: obj }] : []
    case 'thought':
    case 'reasoning':
      // Reasoning / thinking token.
      return data ? [{ type: 'thinking', text: data, raw: obj }] : []
    case 'end': {
      // Turn complete; carries the resumable session id.
      const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
      const stop = typeof obj.stopReason === 'string' ? obj.stopReason : ''
      const status = !stop || stop === 'EndTurn' || stop === 'Stop' ? 'success' : stop
      return [{ type: 'result', status, sessionId, raw: obj }]
    }
    case 'error':
      return [
        {
          type: 'provider_warning',
          text: data || (typeof obj.message === 'string' ? obj.message : 'Grok reported an error.'),
          raw: obj
        }
      ]
    case 'tool_use':
    case 'tool_call':
    case 'tool_invocation': {
      // A tool the agent is invoking (Write/Edit/etc). Best-effort field lookup.
      const toolName = firstString(obj.name, obj.tool_name, obj.toolName, obj.tool) || 'tool'
      const toolId = firstString(obj.id, obj.tool_id, obj.toolId, obj.tool_call_id, obj.toolCallId)
      const toolInput =
        asRecord(obj.input) ||
        asRecord(obj.arguments) ||
        asRecord(obj.args) ||
        asRecord(obj.parameters) ||
        asRecord(obj.params) ||
        {}
      return [{ type: 'tool_use', toolId: toolId || undefined, toolName, toolInput, raw: obj }]
    }
    case 'tool_result':
    case 'tool_response':
    case 'tool_output': {
      const toolId = firstString(
        obj.tool_use_id,
        obj.tool_call_id,
        obj.toolCallId,
        obj.id,
        obj.tool_id,
        obj.toolId
      )
      const isError =
        obj.is_error === true || obj.isError === true || obj.status === 'error' || obj.error != null
      const toolOutput = coerceToolOutput(
        obj.output,
        obj.content,
        obj.result,
        obj.data,
        obj.message
      )
      return [
        {
          type: 'tool_result',
          toolId: toolId || undefined,
          toolStatus: isError ? 'error' : 'success',
          toolOutput,
          raw: obj
        }
      ]
    }
    default:
      return []
  }
}
