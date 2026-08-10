/**
 * Project agy's durable brain `transcript.jsonl` step records into
 * Claude/Codex-shaped tool events for ActivityStack display.
 *
 * agy's official CLI (`agy --print`) emits no structured tool events on stdout,
 * but it writes a complete step-by-step record to its per-conversation brain:
 *
 *   ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a JSON object with: step_index, source, type, status, created_at,
 * content, truncated_fields.
 *
 * The PreToolUse approval bridge (AntigravityHookBridge.ts) already projects
 * shell (RUN_COMMAND) and write (CODE_ACTION) tools in real-time. This module
 * handles the read-side tools that never reach the permission hook:
 *
 *   VIEW_FILE, GREP_SEARCH, LIST_DIRECTORY, GENERIC, ERROR_MESSAGE
 *
 * Display-only: TaskWraith does not mediate agy-native tool execution.
 */

import { promises as fs } from 'fs'
import os from 'os'
import { join } from 'path'
import { parseAgyProjectBoundSessionId, agyCliRootPath } from './AntigravityConversationReceipt'

type SendAgentCompatLine = (
  sender: Electron.WebContents,
  provider: 'antigravity',
  payload: Record<string, unknown>,
  route?: unknown
) => void

/**
 * Best-effort: project read-side tools from agy's brain transcript after a
 * turn completes. Failures are silent — tool projection is display-only.
 *
 * @param providerSessionId  Our tagged session id (`agy-project-v1:<uuid>`)
 * @param sendCompatLine     The same sendAgentCompatLine used in the provider run
 * @param sender             The IPC sender (event.sender)
 * @param route              The route object from the provider run
 * @param deps               Injectable dependencies for testing
 */
export async function projectAgyBrainTranscriptTools(
  providerSessionId: string | null | undefined,
  sendCompatLine: SendAgentCompatLine,
  sender: Electron.WebContents,
  route: unknown,
  deps?: {
    readFile?: (path: string) => Promise<string>
    homeDir?: string
    env?: Readonly<Record<string, string | undefined>>
  }
): Promise<void> {
  const conversationId = parseAgyProjectBoundSessionId(providerSessionId)
  if (!conversationId) return

  const homeDir = deps?.homeDir ?? os.homedir()
  const env = deps?.env ?? process.env
  const readFile = deps?.readFile ?? ((path: string) => fs.readFile(path, 'utf8'))

  const transcriptPath = join(
    agyCliRootPath(env, homeDir),
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )

  let raw: string
  try {
    raw = await readFile(transcriptPath)
  } catch {
    return
  }

  const lines = raw.split(/\r?\n/)
  const events = projectAgyTranscriptTools(lines)
  if (events.length === 0) return

  for (const evt of events) {
    try {
      sendCompatLine(sender, 'antigravity', { ...evt, provider: 'antigravity' }, route)
    } catch {
      // Display-only — never fail the run for projection
    }
  }
}

/** Types from the agy brain transcript that represent tool calls. */
const TOOL_STEP_TYPES = new Set([
  'VIEW_FILE',
  'GREP_SEARCH',
  'LIST_DIRECTORY',
  'GENERIC',
  'ERROR_MESSAGE'
])

/** Bridge-projected types we skip to avoid duplicate cards. */
const BRIDGE_COVERED_TYPES = new Set(['RUN_COMMAND', 'CODE_ACTION'])

export interface AgyTranscriptStep {
  step_index: number
  source: string
  type: string
  status: string
  created_at: string
  content: string
  truncated_fields?: string[]
}

export interface AgyToolEvent {
  type: 'tool_use' | 'tool_result'
  tool_id: string
  tool_name: string
  parameters: Record<string, unknown>
  status?: 'success' | 'error'
  output?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Parse a single line from agy's `transcript.jsonl`. Returns null for
 * malformed lines, empty lines, or non-tool steps.
 */
export function parseAgyTranscriptLine(line: string): AgyTranscriptStep | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const step = parsed as Record<string, unknown>
    if (
      typeof step.step_index !== 'number' ||
      typeof step.source !== 'string' ||
      typeof step.type !== 'string'
    ) {
      return null
    }
    return {
      step_index: step.step_index,
      source: step.source,
      type: step.type,
      status: typeof step.status === 'string' ? step.status : '',
      created_at: typeof step.created_at === 'string' ? step.created_at : '',
      content: typeof step.content === 'string' ? step.content : '',
      truncated_fields: Array.isArray(step.truncated_fields)
        ? step.truncated_fields.map(String)
        : undefined
    }
  } catch {
    return null
  }
}

/**
 * Extract a human-readable summary from the content field for display as
 * the tool result. The content format varies by tool type and is always
 * plain text (never JSON), so we extract what's useful.
 */
function extractToolSummary(type: string, content: string): string {
  if (!content.trim()) return ''

  switch (type) {
    case 'VIEW_FILE': {
      // "Created At: ...\nCompleted At: ...\n\nFile Path: `file:///path`\n..."
      const fileMatch = content.match(/File Path:\s*`([^`]+)`/)
      const linesMatch = content.match(/Showing lines (\d+) to (\d+)/)
      const totalLinesMatch = content.match(/Total Lines:\s*(\d+)/)
      if (fileMatch) {
        const parts: string[] = [fileMatch[1]]
        if (linesMatch && totalLinesMatch) {
          parts.push(` (lines ${linesMatch[1]}-${linesMatch[2]} of ${totalLinesMatch[1]})`)
        }
        return parts.join('')
      }
      // Fallback: first meaningful line after the timestamp header
      const lines = content.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (
          trimmed &&
          !trimmed.startsWith('Created At:') &&
          !trimmed.startsWith('Completed At:')
        ) {
          return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed
        }
      }
      return ''
    }
    case 'GREP_SEARCH': {
      const noResults = content.includes('No results found')
      if (noResults) return 'No results found'
      // Count result lines (NDJSON-like)
      const resultLines = content
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .length
      return resultLines > 0 ? `${resultLines} match(es)` : 'Search completed'
    }
    case 'LIST_DIRECTORY': {
      const entryCount = content
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .length
      return entryCount > 0 ? `${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}` : 'Directory listed'
    }
    case 'ERROR_MESSAGE':
      return content.slice(0, 500)
    case 'GENERIC':
      return content.slice(0, 200)
    default:
      return content.slice(0, 200)
  }
}

/**
 * Extract the most useful parameter from a tool step for use as the
 * `tool_use` input. For read tools, we extract the file path or search
 * pattern from the content.
 */
function extractToolParams(type: string, content: string): Record<string, unknown> {
  if (!content.trim()) return {}

  switch (type) {
    case 'VIEW_FILE': {
      const fileMatch = content.match(/File Path:\s*`([^`]+)`/)
      if (fileMatch) return { path: fileMatch[1] }
      return {}
    }
    case 'GREP_SEARCH': {
      // The grep content doesn't reliably include the pattern in an
      // extractable format — it varies by agy version.
      const resultLines = content
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
      if (resultLines.length > 0) {
        return { results: resultLines.length }
      }
      return {}
    }
    case 'LIST_DIRECTORY':
    case 'GENERIC':
    case 'ERROR_MESSAGE':
    default:
      return {}
  }
}

/**
 * Map one agy transcript step into zero or more tool events.
 * Returns an empty array for non-tool steps, bridge-covered tools,
 * or unrecognised types.
 */
export function projectAgyStepTools(step: AgyTranscriptStep): AgyToolEvent[] {
  // Only model-sourced steps are tool calls
  if (step.source !== 'MODEL') return []

  const type = step.type
  if (!type) return []

  // Skip bridge-covered tools (shell/write) to avoid duplicate cards
  if (BRIDGE_COVERED_TYPES.has(type)) return []

  // Skip non-tool steps like PLANNER_RESPONSE
  if (!TOOL_STEP_TYPES.has(type)) return []

  const toolId = `agy-${type.toLowerCase()}-${step.step_index}`
  const toolName = type.toLowerCase()
  const output = extractToolSummary(type, step.content)
  const failed = type === 'ERROR_MESSAGE' || step.status?.toUpperCase() === 'ERROR'

  const events: AgyToolEvent[] = [
    {
      type: 'tool_use',
      tool_id: toolId,
      tool_name: toolName,
      parameters: extractToolParams(type, step.content)
    }
  ]

  events.push({
    type: 'tool_result',
    tool_id: toolId,
    tool_name: toolName,
    status: failed ? 'error' : 'success',
    output
  })

  return events
}

/**
 * Process a full transcript (all lines of a `transcript.jsonl`) and return
 * all projected tool events in order.
 */
export function projectAgyTranscriptTools(lines: readonly string[]): AgyToolEvent[] {
  const events: AgyToolEvent[] = []
  for (const line of lines) {
    const step = parseAgyTranscriptLine(line)
    if (!step) continue
    const projected = projectAgyStepTools(step)
    events.push(...projected)
  }
  return events
}
