/**
 * Claude-native Workflow telemetry.
 *
 * Claude Code's own `Workflow` tool spins up many sub-agents (a "workflow run").
 * When Claude runs as a TaskWraith participant via the Agent SDK, the SDK streams
 * structured `type:'system'` task-lifecycle messages for that run:
 *   - `task_started`      — carries `workflow_name` (meta.name, parsed CLI-side),
 *                            `description`, `task_type:'local_workflow'`.
 *   - `task_progress`     — periodic `usage` aggregate + `last_tool_name`.
 *   - `task_updated`      — incremental `patch` (status / end_time / error / …).
 *   - `task_notification` — terminal `status` + final `summary` + `output_file`.
 *
 * TaskWraith cannot CONTROL the workflow (it runs entirely inside the `claude`
 * subprocess) — it can only surface the telemetry that leaks through the stream.
 * The per-sub-agent token/tools/time table the Claude desktop card shows is NOT
 * in the wire protocol (usage is a whole-workflow aggregate), so it is omitted
 * rather than faked.
 *
 * This module is intentionally dependency-free and node-builtin-free: it is
 * imported by the main process (ingestion), the renderer (adapter + card), and
 * the shared `ToolActivity` type, so it must stay portable and pure.
 */

export type ClaudeWorkflowStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'paused'
  | 'unknown'

/**
 * The slice of a Claude Workflow run's live status we can honestly surface.
 * Attached to the originating `Workflow` tool activity as `ToolActivity.workflowSummary`.
 */
export interface ClaudeWorkflowTelemetry {
  /** Background task id the SDK assigns to this workflow run. */
  taskId?: string
  /** Originating `Workflow` tool_use id — the key telemetry is associated by. */
  toolUseId?: string
  /** meta.name, parsed server-side by the claude CLI (clean, no client parsing). */
  workflowName?: string
  description?: string
  status?: ClaudeWorkflowStatus
  /** Whole-workflow aggregate token count (NOT per-sub-agent). */
  totalTokens?: number
  /** Whole-workflow aggregate tool-call count. */
  toolUses?: number
  durationMs?: number
  /** Number of sub-agents spawned, when the runtime reports it. */
  agentCount?: number
  /** Tokens spent inside spawned sub-agents, when reported. */
  subagentTokens?: number
  /** Name of the most-recent tool the workflow ran ("currently …" subtitle). */
  lastToolName?: string
  /** Final summary blurb, available on settle. */
  summary?: string
  /** On-disk path the full workflow result was written to. */
  outputFile?: string
  error?: string
  isBackgrounded?: boolean
}

const CLAUDE_WORKFLOW_SYSTEM_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification'
])

const TERMINAL_WORKFLOW_STATUSES = new Set<ClaudeWorkflowStatus>(['completed', 'failed', 'stopped'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * True for the `type:'system'` task-lifecycle frames that drive a workflow card.
 * (Plain background `Task` subagents share the same lifecycle frames; callers
 * that want to scope strictly to WORKFLOWS should additionally check the
 * `taskType === 'local_workflow'` returned by {@link normalizeClaudeWorkflowEvent}.)
 */
export function isClaudeWorkflowSystemEvent(event: unknown): boolean {
  const record = asRecord(event)
  if (!record) return false
  if (str(record.type) !== 'system') return false
  return CLAUDE_WORKFLOW_SYSTEM_SUBTYPES.has(str(record.subtype))
}

function normalizeWorkflowStatusString(raw: string): ClaudeWorkflowStatus {
  const value = raw.toLowerCase()
  if (value === 'completed' || value === 'complete' || value === 'success' || value === 'done')
    return 'completed'
  if (value === 'failed' || value === 'failure' || value === 'error') return 'failed'
  if (
    value === 'stopped' ||
    value === 'cancelled' ||
    value === 'canceled' ||
    value === 'aborted' ||
    value === 'killed'
  )
    return 'stopped'
  if (value === 'paused') return 'paused'
  if (value === 'running' || value === 'in_progress' || value === 'active' || value === 'started')
    return 'running'
  return 'unknown'
}

function workflowStatusFrom(
  subtype: string,
  record: Record<string, unknown>,
  patch: Record<string, unknown>
): ClaudeWorkflowStatus | undefined {
  if (subtype === 'task_started' || subtype === 'task_progress') return 'running'
  const raw = str(record.status) || str(patch.status)
  if (raw) return normalizeWorkflowStatusString(raw)
  // A settle notification with no explicit status is a normal completion.
  return subtype === 'task_notification' ? 'completed' : undefined
}

/**
 * Defensively normalize a raw SDK `type:'system'` task-lifecycle message into a
 * `{ taskId, toolUseId, taskType, telemetry }` shape. Reads both snake_case
 * (wire) and camelCase variants and tolerates the narrower / richer `usage` bag
 * the runtime actually emits (`agent_count` / `subagent_tokens` are present at
 * runtime even though the bundled `.d.ts` only types `total_tokens` / `tool_uses`
 * / `duration_ms`). Returns null when `event` is not a workflow system frame.
 */
export function normalizeClaudeWorkflowEvent(event: unknown): {
  taskId?: string
  toolUseId?: string
  taskType?: string
  telemetry: ClaudeWorkflowTelemetry
} | null {
  const record = asRecord(event)
  if (!record) return null
  if (str(record.type) !== 'system') return null
  const subtype = str(record.subtype)
  if (!CLAUDE_WORKFLOW_SYSTEM_SUBTYPES.has(subtype)) return null

  const patch = asRecord(record.patch) || {}
  const usage = asRecord(record.usage) || asRecord(patch.usage) || {}

  const taskId = str(record.task_id) || str(record.taskId) || undefined
  const toolUseId = str(record.tool_use_id) || str(record.toolUseId) || undefined
  const taskType = str(record.task_type) || str(record.taskType) || undefined

  const telemetry: ClaudeWorkflowTelemetry = {}
  if (taskId) telemetry.taskId = taskId
  if (toolUseId) telemetry.toolUseId = toolUseId

  const workflowName = str(record.workflow_name) || str(record.workflowName)
  if (workflowName) telemetry.workflowName = workflowName

  const description = str(record.description) || str(patch.description)
  if (description) telemetry.description = description

  const status = workflowStatusFrom(subtype, record, patch)
  if (status) telemetry.status = status

  const totalTokens = firstNumber(usage.total_tokens, usage.totalTokens)
  if (totalTokens !== undefined) telemetry.totalTokens = totalTokens
  const toolUses = firstNumber(usage.tool_uses, usage.toolUses)
  if (toolUses !== undefined) telemetry.toolUses = toolUses
  const durationMs = firstNumber(usage.duration_ms, usage.durationMs)
  if (durationMs !== undefined) telemetry.durationMs = durationMs
  const agentCount = firstNumber(usage.agent_count, usage.agentCount)
  if (agentCount !== undefined) telemetry.agentCount = agentCount
  const subagentTokens = firstNumber(usage.subagent_tokens, usage.subagentTokens)
  if (subagentTokens !== undefined) telemetry.subagentTokens = subagentTokens

  const lastToolName = str(record.last_tool_name) || str(record.lastToolName)
  if (lastToolName) telemetry.lastToolName = lastToolName

  const summary = str(record.summary)
  if (summary) telemetry.summary = summary

  const outputFile = str(record.output_file) || str(record.outputFile)
  if (outputFile) telemetry.outputFile = outputFile

  const error = str(record.error) || str(patch.error)
  if (error) telemetry.error = error

  const backgrounded = patch.is_backgrounded ?? record.is_backgrounded
  if (typeof backgrounded === 'boolean') telemetry.isBackgrounded = backgrounded

  return { taskId, toolUseId, taskType, telemetry }
}

export function shouldEmitClaudeWorkflowTelemetry(
  event: { taskId?: string; taskType?: string } | null | undefined,
  knownWorkflowTaskIds: ReadonlySet<string>
): boolean {
  if (!event) return false
  if (event.taskType === 'local_workflow') return true
  return Boolean(event.taskId && knownWorkflowTaskIds.has(event.taskId))
}

/**
 * Merge a freshly-normalized telemetry patch onto the accumulated telemetry.
 * Only DEFINED (non-empty) incoming fields overwrite, so a sparse `task_progress`
 * frame (usage only) never wipes the `workflow_name`/`description` learned from
 * `task_started`. A terminal status (completed/failed/stopped) is never
 * downgraded back to `running` by a late/out-of-order progress frame.
 */
export function mergeClaudeWorkflowTelemetry(
  previous: ClaudeWorkflowTelemetry | undefined,
  next: Partial<ClaudeWorkflowTelemetry> | null | undefined
): ClaudeWorkflowTelemetry {
  const merged: ClaudeWorkflowTelemetry = { ...(previous || {}) }
  if (!next) return merged
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  if (
    previous?.status &&
    TERMINAL_WORKFLOW_STATUSES.has(previous.status) &&
    merged.status === 'running'
  ) {
    merged.status = previous.status
  }
  return merged
}

/** Normalize a tool name to its bare lowercase form (strips mcp/namespace prefixes). */
export function normalizeWorkflowToolName(name: string | undefined | null): string {
  if (!name) return ''
  const segments = String(name).trim().split(/__|\//)
  return (segments[segments.length - 1] || '').toLowerCase().trim()
}

/** True when a tool name is Claude's native `Workflow` orchestration tool. */
export function isClaudeWorkflowToolName(name: string | undefined | null): boolean {
  return normalizeWorkflowToolName(name) === 'workflow'
}

/** Escape-aware quoted-string body: `\\.` consumes an escaped char so the match
 * only ends on a TRUE closing quote (an escaped quote inside the value can't
 * terminate it early). Captures the opening quote in group 1, the body in group 2. */
const QUOTED_VALUE_BODY = '([\'"`])((?:\\\\.|[\\s\\S])*?)\\1'

function unescapeMetaString(raw: string): string {
  return raw.replace(/\\(['"`\\nrt])/g, (_match, char) =>
    char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
  )
}

/**
 * From the opening `{`/`[` at `openIndex`, return the substring INSIDE its
 * matching close. Tracks nesting of that ONE bracket kind and skips string
 * literals (so brackets inside strings don't miscount). Tolerates a truncated
 * script by returning through end-of-string when the close is missing.
 */
function extractBalancedGroup(source: string, openIndex: number): string {
  const open = source[openIndex]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, i)
    }
  }
  return source.slice(openIndex + 1)
}

/**
 * Replace every nested `{…}`/`[…]` group in an object body with equal-length
 * blanks so a `name:`/`description:` key inside a phase/agent entry can't shadow
 * the meta object's OWN top-level field.
 */
function blankNestedGroups(body: string): string {
  let previous = ''
  let out = body
  while (out !== previous) {
    previous = out
    out = out.replace(/\{[^{}]*\}|\[[^[\]]*\]/g, (group) => ' '.repeat(group.length))
  }
  return out
}

/**
 * Best-effort parse of a Workflow script's `export const meta = {…}` literal for
 * the display name, description, and phase titles. The `workflow_name` from the
 * SDK is authoritative for the name; this exists mainly to recover the PHASE
 * list, which is NOT carried anywhere in the wire protocol. Tolerant of a
 * truncated script as long as the leading `meta` block survives.
 *
 * Uses a string-aware balanced-bracket scan (NOT a naive non-greedy regex) so a
 * phase object carrying a nested array (`agents:[…]`, `retries:[…]`) doesn't
 * truncate the phase list, and confines name/description to the meta object's
 * TOP level so a nested `name:` can't shadow the workflow's real name.
 */
export function parseWorkflowScriptMeta(script: string | undefined | null): {
  name?: string
  description?: string
  phases?: string[]
} {
  if (typeof script !== 'string' || !script) return {}
  const result: { name?: string; description?: string; phases?: string[] } = {}

  const metaMatch = script.match(/export\s+const\s+meta\s*=\s*\{/)
  if (!metaMatch || typeof metaMatch.index !== 'number') return result
  const braceIndex = script.indexOf('{', metaMatch.index)
  if (braceIndex < 0) return result
  const metaBody = extractBalancedGroup(script, braceIndex)

  // Top-level name/description: blank nested groups so an inner `name:` (e.g. a
  // phase or agent entry) can't shadow the meta object's own top-level name.
  const topLevel = blankNestedGroups(metaBody)
  const nameMatch = topLevel.match(new RegExp(`\\bname\\s*:\\s*${QUOTED_VALUE_BODY}`))
  if (nameMatch) result.name = unescapeMetaString(nameMatch[2]).trim()
  const descMatch = topLevel.match(new RegExp(`\\bdescription\\s*:\\s*${QUOTED_VALUE_BODY}`))
  if (descMatch) result.description = unescapeMetaString(descMatch[2]).trim()

  // Phases: balanced-scan the phases array so nested arrays inside phase objects
  // don't cut the list short, then pull each phase's title.
  const phasesKey = metaBody.match(/\bphases\s*:\s*\[/)
  if (phasesKey && typeof phasesKey.index === 'number') {
    const bracketIndex = metaBody.indexOf('[', phasesKey.index)
    if (bracketIndex >= 0) {
      const phasesBlock = extractBalancedGroup(metaBody, bracketIndex)
      const titles: string[] = []
      const titleRe = new RegExp(`\\btitle\\s*:\\s*${QUOTED_VALUE_BODY}`, 'g')
      let match: RegExpExecArray | null
      while ((match = titleRe.exec(phasesBlock)) !== null) {
        const title = unescapeMetaString(match[2]).trim()
        if (title) titles.push(title)
      }
      if (titles.length) result.phases = titles
    }
  }

  return result
}
