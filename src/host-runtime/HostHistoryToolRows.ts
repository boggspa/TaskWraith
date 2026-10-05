/**
 * What the terminal app's history shows for a thread's messages, read from
 * the thread's record: an entry for each message it can show, in message
 * order, with the tool rows the desktop draws for that message. The profile
 * store's full copy and the log's follower both project through here, so the
 * two serve the same pages.
 *
 * Tool rows come from where the desktop draws them:
 * - a tool message's activities, which it draws as an activity stack;
 * - an ensemble fan-out result's own activities, drawn inside its card;
 * - a Host run's rows, `run.toolActivities`, for the assistant messages that
 *   name the run. Only the Host writes those, as its run port records a
 *   provider's tool events; the app's runs carry none.
 *
 * The desktop's stack leaves out three kinds of activity, and so does this:
 * a provider's MCP transport envelope, the app's own housekeeping rows, and
 * reasoning, which it draws as a thinking note rather than as a tool. The
 * Host cannot import the desktop's rules, so these are copies, and tests hold
 * them to the originals.
 *
 * Once a run ends, the app moves its activities' detail (parameters, output,
 * raw events) out of the record and leaves a ref. The desktop paints the
 * compact row first and fetches the detail when it draws the row; the history
 * never fetches it. So a row is the compact row: its name, category, status,
 * file and line counts. A command, its output and a diff are detail, and no
 * row carries them, inline or not.
 */
import {
  HOST_HISTORY_MAX_ENTRY_TEXT,
  HOST_HISTORY_MAX_ENTRY_TOOLS,
  HOST_HISTORY_MAX_TOOL_FILE,
  HOST_HISTORY_MAX_TOOL_NAME,
  decodeHostHistoryToolEntry,
  type HostHistoryToolCategory,
  type HostHistoryToolEntry,
  type HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'

/** The fields of a stored message the history reads. */
export interface HostHistoryMessage {
  readonly id: string
  readonly role?: unknown
  readonly content?: unknown
  readonly timestamp?: unknown
  readonly runId?: unknown
}

/** The fields of a stored run the history reads. */
export interface HostHistoryRun {
  readonly runId?: unknown
  readonly toolActivities?: unknown
}

type Fields = Readonly<Record<string, unknown>>

const MAX_TOOL_ID = 512

const CATEGORIES: ReadonlySet<string> = new Set<HostHistoryToolCategory>([
  'task',
  'read',
  'write',
  'search',
  'shell',
  'unknown'
])

// eslint-disable-next-line no-control-regex -- history text refuses terminal controls but keeps tabs and line breaks.
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- the wire refuses every control in an id, a name or a file.
const LINE_CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- a tool row is one line: each run of controls becomes a space.
const LINE_CONTROLS = /[\u0000-\u001f\u007f]+/g

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The profile store's rule for transcript text: present, bounded, free of terminal controls. */
function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= HOST_HISTORY_MAX_ENTRY_TEXT &&
    !TEXT_CONTROL.test(value)
  )
}

/** A string the wire takes as an id, name or file: present, trimmed, bounded, no controls. */
function canonical(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !LINE_CONTROL.test(value)
  )
}

/** One line, at most `max` code units, never ending in half a surrogate pair. */
function oneLine(value: string, max: number): string {
  let line = value.replace(LINE_CONTROLS, ' ').trim()
  if (line.length > max) {
    line = line.slice(0, /[\ud800-\udbff]/.test(line[max - 1]) ? max - 1 : max).trimEnd()
  }
  return line
}

// ---------------------------------------------------------------------------
// The desktop's rules for which activities its stack leaves out. Copies of
// `stripToolNamespace`, `isHiddenInfrastructureToolName` and
// `isReasoningToolName` (renderer ToolParser), the stack's thinking-trace
// test (ActivityStack), and `isMcpTransportWrapperActivity` (shared
// toolInvocationPresentation, which imports main's types, so the Host Node
// import boundary refuses it).
// ---------------------------------------------------------------------------

function stripDesktopToolNamespace(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const index = toolName.indexOf('__', 5)
    return index > 5 ? toolName.slice(index + 2) : toolName
  }
  if (toolName.startsWith('mcp_')) {
    for (const prefix of [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-'
    ]) {
      if (toolName.startsWith(prefix)) return toolName.slice(prefix.length)
    }
  }
  for (const prefix of [
    'taskwraith-broker__',
    'taskwraith_broker__',
    'taskwraith-broker_',
    'taskwraith_broker_',
    'taskwraith__',
    'taskwraith_'
  ]) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length)
  }
  return toolName
}

/** The app's own housekeeping rows, which the desktop never draws. */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'antigravity_init',
  'generic',
  'provider_diagnostic'
])

export function isHiddenHistoryToolName(toolName: string): boolean {
  return HIDDEN_TOOL_NAMES.has(stripDesktopToolNamespace(toolName.toLowerCase()))
}

export function isReasoningHistoryToolName(toolName: string): boolean {
  const name = stripDesktopToolNamespace(toolName.toLowerCase())
  return (
    name === 'thinking' ||
    name === 'reasoning' ||
    name.endsWith('_thinking') ||
    name.endsWith('_reasoning')
  )
}

/** Reasoning, which the desktop draws as a thinking note, not as a tool. */
function isThinkingTrace(activity: Fields): boolean {
  if (isReasoningHistoryToolName(text(activity.toolName))) return true
  const parameters = isFields(activity.parameters) ? activity.parameters : undefined
  const kind = parameters?.kind
  if (typeof kind === 'string' && ['thinking', 'reasoning'].includes(kind.trim().toLowerCase())) {
    return true
  }
  const displayName = text(activity.displayName).trim().toLowerCase()
  return (
    displayName === 'thinking' ||
    displayName === 'reasoning' ||
    displayName.endsWith(' thinking') ||
    displayName.endsWith(' reasoning')
  )
}

const MCP_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'callmcptool',
  'call_mcp_tool',
  'mcp',
  'use_tool'
])
const MCP_WRAPPER_DISPLAY_NAMES: ReadonlySet<string> = new Set([
  'used callmcptool',
  'used call_mcp_tool',
  'used mcp',
  'mcp',
  'used an mcp tool'
])
const COMMAND_KEYS = [
  'command',
  'cmd',
  'script',
  'bash',
  'shell',
  'shell_command',
  'shellCommand',
  'terminal_command',
  'terminalCommand'
] as const
const NESTED_RECORD_KEYS = [
  'parameters',
  'params',
  'payload',
  'args',
  'input',
  'arguments',
  'rawInput',
  'toolInput',
  'tool_input'
] as const
const TRANSPORT_KIND_KEYS = ['type', 'kind', 'tool_kind', 'toolKind'] as const
const MCP_SERVER_KEYS = [
  'server',
  'serverName',
  'server_name',
  'providerIdentifier',
  'provider_identifier',
  'mcpToolName',
  'mcp_tool_name',
  'mcpTool',
  'mcp_tool'
] as const
const WRAPPED_NAME_KEYS = ['tool', 'toolName', 'tool_name', 'name'] as const

function recordFrom(value: unknown): Fields | undefined {
  if (isFields(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isFields(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function firstString(record: Fields, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function payloadRecords(activity: Fields): Fields[] {
  const records: Fields[] = isFields(activity.parameters) ? [activity.parameters] : []
  const raw = recordFrom(activity.rawUseEvent)
  if (!raw) return records
  records.push(raw)
  for (const key of NESTED_RECORD_KEYS) {
    const nested = recordFrom(raw[key])
    if (nested) records.push(nested)
  }
  return records
}

/** A provider's MCP envelope around the real call; a command-shaped activity never is one. */
function isMcpTransportWrapper(activity: Fields): boolean {
  if (activity.category === 'shell') return false
  const records = payloadRecords(activity)
  if (records.some((record) => firstString(record, COMMAND_KEYS))) return false
  const toolName = text(activity.toolName).trim().toLowerCase()
  const displayName = text(activity.displayName).trim().toLowerCase()
  if (MCP_WRAPPER_NAMES.has(toolName) || MCP_WRAPPER_DISPLAY_NAMES.has(displayName)) return true
  if (toolName !== 'unknown' && displayName !== 'used unknown' && displayName !== 'unknown') {
    return false
  }
  return records.some((record) => {
    if (firstString(record, TRANSPORT_KIND_KEYS)?.toLowerCase().includes('mcp')) return true
    if (firstString(record, MCP_SERVER_KEYS)) return true
    const wrapped = firstString(record, WRAPPED_NAME_KEYS)
    return wrapped !== undefined && MCP_WRAPPER_NAMES.has(wrapped.toLowerCase())
  })
}

// ---------------------------------------------------------------------------
// One activity's row.
// ---------------------------------------------------------------------------

/** The desktop's keys for an activity's file, in its order (ActivityStack `getFilePathFromActivity`). */
const FILE_PARAMETER_KEYS = [
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
] as const

function fileOf(activity: Fields): string | undefined {
  const parameters = isFields(activity.parameters) ? activity.parameters : undefined
  const candidates = [
    ...FILE_PARAMETER_KEYS.map((key) => parameters?.[key]),
    activity.filePath,
    activity.affectedFilePath
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

/**
 * The stored display name, or the tool's name. The app's display names often
 * end in the file ("Edited src/a.ts"); the terminal prints the file beside the
 * name, so that ending goes, as the desktop draws a verb beside a file chip.
 */
function nameOf(activity: Fields, file: string | undefined): string {
  for (const candidate of [activity.displayName, activity.toolName]) {
    let name = oneLine(text(candidate), Number.POSITIVE_INFINITY)
    if (file && name.endsWith(file) && /\s/.test(name.charAt(name.length - file.length - 1))) {
      name = name.slice(0, name.length - file.length).trimEnd()
    }
    name = oneLine(name, HOST_HISTORY_MAX_TOOL_NAME)
    if (name) return name
  }
  return 'Tool'
}

// The desktop's inline line counts (ActivityInlineStats), from the stored diff
// summary: it estimates from parameters only for rows that still carry them.
const WRITE_LIKE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'replace',
  'write_file',
  'create_file',
  'edit_file',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'strreplaceeditor'
])
const WRITE_LIKE_SUFFIX =
  /__(?:write_file|create_file|edit_file|replace|apply_patch|create_directory|delete_path|move_path|rename_path|edit|write)$/
const FREEFORM_EDIT_TITLE =
  /^(?:edit|write|create|delete|remove|replace|patch|rewrite|modify|move|rename|update)[\s`'"]/i
/** Line counts a shell row may show: measured from the workspace or declared by the provider. */
const SHELL_TRUSTED_SOURCES: ReadonlySet<unknown> = new Set(['git_numstat', 'codex_changes'])
/** Estimates the desktop shows only on an edit. */
const ESTIMATED_SOURCES: ReadonlySet<unknown> = new Set([
  'content',
  'string_replace',
  'patch_preview'
])

function isEditLike(toolName: string, category: HostHistoryToolCategory): boolean {
  const name = toolName.trim().toLowerCase()
  return (
    category === 'write' ||
    WRITE_LIKE_TOOL_NAMES.has(name) ||
    WRITE_LIKE_SUFFIX.test(name) ||
    FREEFORM_EDIT_TITLE.test(toolName.trim())
  )
}

function lineCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function lineCountsOf(
  activity: Fields,
  category: HostHistoryToolCategory
): { additions: number; deletions: number } | null {
  // A refused or failed edit changed nothing.
  if (activity.status === 'error' || !isFields(activity.diffSummary)) return null
  const summary = activity.diffSummary
  if (!isEditLike(text(activity.toolName), category)) {
    if (
      category === 'shell'
        ? !SHELL_TRUSTED_SOURCES.has(summary.source)
        : ESTIMATED_SOURCES.has(summary.source)
    ) {
      return null
    }
  }
  const additions = lineCount(summary.additions) ?? 0
  const deletions = lineCount(summary.deletions) ?? 0
  // `+0 -0` is a placeholder, not an edit.
  return additions === 0 && deletions === 0 ? null : { additions, deletions }
}

/** The row the desktop draws for an activity, or null for one its stack leaves out. */
function toolRowOf(value: unknown): HostHistoryToolEntry | null {
  if (!isFields(value) || !canonical(value.id, MAX_TOOL_ID)) return null
  const activity = value
  if (isHiddenHistoryToolName(text(activity.toolName))) return null
  if (isThinkingTrace(activity) || isMcpTransportWrapper(activity)) return null
  const category =
    typeof activity.category === 'string' && CATEGORIES.has(activity.category)
      ? (activity.category as HostHistoryToolCategory)
      : 'unknown'
  const target = fileOf(activity)
  const file = canonical(target, HOST_HISTORY_MAX_TOOL_FILE) ? target : undefined
  const row: HostHistoryToolEntry = {
    id: activity.id as string,
    name: nameOf(activity, file),
    category,
    status:
      activity.status === 'running' || activity.status === 'pending'
        ? 'running'
        : activity.status === 'error'
          ? 'error'
          : 'success',
    ...(file ? { file } : {}),
    ...lineCountsOf(activity, category)
  }
  return decodeHostHistoryToolEntry(row, 0).ok ? row : null
}

/**
 * The rows a stored activity list draws, in its order. An id that comes again
 * keeps its last place. Only the newest HOST_HISTORY_MAX_ENTRY_TOOLS are kept,
 * as many as one entry carries; the stack's newest rows are its live ones.
 */
export function hostHistoryToolRows(activities: unknown): HostHistoryToolEntry[] {
  if (!Array.isArray(activities)) return []
  const rows: HostHistoryToolEntry[] = []
  const ids = new Set<string>()
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (rows.length === HOST_HISTORY_MAX_ENTRY_TOOLS) break
    const row = toolRowOf(activities[index])
    if (!row || ids.has(row.id)) continue
    ids.add(row.id)
    rows.push(row)
  }
  return rows.reverse()
}

/** Whether a stored activity list draws any row at all. */
function drawsAnyRow(activities: unknown): boolean {
  return Array.isArray(activities) && activities.some((activity) => toolRowOf(activity) !== null)
}

/**
 * A Host run's rows, the newest HOST_HISTORY_MAX_ENTRY_TOOLS of those the wire
 * takes, as stored. The run port keeps more than one entry may carry.
 */
export function hostHistoryRunToolRows(run: HostHistoryRun | undefined): HostHistoryToolEntry[] {
  const activities = run?.toolActivities
  if (!Array.isArray(activities)) return []
  const rows: HostHistoryToolEntry[] = []
  const ids = new Set<string>()
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (rows.length === HOST_HISTORY_MAX_ENTRY_TOOLS) break
    const decoded = decodeHostHistoryToolEntry(activities[index], index)
    if (!decoded.ok || ids.has(decoded.value.id)) continue
    ids.add(decoded.value.id)
    rows.push({ ...(activities[index] as HostHistoryToolEntry) })
  }
  return rows.reverse()
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

function fieldsOf(message: HostHistoryMessage): Fields {
  return message as unknown as Fields
}

/** An ensemble lane's result, whose card draws the lane's tool activities (shared fanoutLaneGrouping). */
function isFanoutResult(message: HostHistoryMessage): boolean {
  const metadata = fieldsOf(message).metadata
  return (
    message.role === 'assistant' &&
    isFields(metadata) &&
    metadata.kind === 'ensembleParticipant' &&
    typeof metadata.ensembleLaneId === 'string' &&
    metadata.ensembleLaneId.trim().length > 0
  )
}

/** The run whose rows a message's entry carries: an assistant message's run, by id. */
export function hostHistoryEntryRun(message: HostHistoryMessage): string | null {
  const runId = message.runId
  return message.role === 'assistant' &&
    typeof runId === 'string' &&
    runId !== '' &&
    !isFanoutResult(message)
    ? runId
    : null
}

/** Whether the history shows a message; it does not depend on any run. */
export function hostHistoryShows(message: HostHistoryMessage): boolean {
  switch (message.role) {
    case 'user':
    case 'system':
      return safeText(message.content)
    case 'assistant':
      return (
        safeText(message.content) ||
        (message.content === '' &&
          isFanoutResult(message) &&
          drawsAnyRow(fieldsOf(message).toolActivities))
      )
    case 'tool':
      return drawsAnyRow(fieldsOf(message).toolActivities)
    default:
      return false
  }
}

/**
 * A message's entry, given the first run with the id `hostHistoryEntryRun`
 * names; null for a message the history does not show.
 */
export function hostHistoryEntry(
  message: HostHistoryMessage,
  run: HostHistoryRun | undefined
): HostTranscriptHistoryEntry | null {
  if (!hostHistoryShows(message)) return null
  const parsed = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN
  const head = {
    entryId: message.id,
    role: message.role as HostTranscriptHistoryEntry['role'],
    createdAt: Number.isFinite(parsed) ? parsed : 0,
    // A tool message's own text is a provider's payload or a carrier's: the desktop draws its stack instead.
    text: message.role !== 'tool' && safeText(message.content) ? message.content : ''
  }
  if (message.role === 'tool' || isFanoutResult(message)) {
    return { ...head, tools: hostHistoryToolRows(fieldsOf(message).toolActivities) }
  }
  return hostHistoryEntryRun(message) === null
    ? head
    : { ...head, tools: hostHistoryRunToolRows(run) }
}

/** Each run id's first run, which is the one an entry takes its rows from. */
export function hostHistoryFirstRuns<Run extends HostHistoryRun>(
  runs: Iterable<Run>
): Map<string, Run> {
  const first = new Map<string, Run>()
  for (const run of runs) {
    if (typeof run.runId === 'string' && !first.has(run.runId)) first.set(run.runId, run)
  }
  return first
}

/** A whole record's history, in message order. */
export function hostHistoryEntries(
  messages: readonly HostHistoryMessage[],
  runs: readonly HostHistoryRun[]
): HostTranscriptHistoryEntry[] {
  const first = hostHistoryFirstRuns(runs)
  const entries: HostTranscriptHistoryEntry[] = []
  for (const message of messages) {
    const runId = hostHistoryEntryRun(message)
    const entry = hostHistoryEntry(message, runId === null ? undefined : first.get(runId))
    if (entry) entries.push(entry)
  }
  return entries
}
