/**
 * Shared todo / goal-step parsing + merge helpers.
 * Used by the renderer (ActivityStack checklist) and main-process MCP
 * `todo_write` handler (merge:true per-chat state).
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  /** Host-bound root Goal identity. Never inferred from checklist completion. */
  goalId?: string
  /** Host-bound Ensemble assignment identity when this is a seat-local substep. */
  assignmentId?: string
}

/** Lane key for solo + guest chats; ensemble lanes use the participantId. */
export const TODO_SOLO_LANE = '__solo__'

const TODO_TOOL_NAMES = new Set([
  'todo_write',
  'todowrite',
  'update_todo_list',
  'updatetodolist',
  'updatetodo',
  // Codex's native plan, emitted as a synthetic 'codex_plan' tool activity.
  'codex_plan'
])

const TODO_STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: 'pending',
  open: 'pending',
  todo: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  skipped: 'cancelled'
}

export function isTodoToolName(toolName: string | undefined | null): boolean {
  if (!toolName) return false
  let normalised = toolName.toLowerCase().trim()
  if (normalised.startsWith('mcp__')) {
    const idx = normalised.indexOf('__', 5)
    if (idx > 5) normalised = normalised.slice(idx + 2)
  } else if (normalised.startsWith('taskwraith__')) {
    normalised = normalised.slice('taskwraith__'.length)
  }
  return TODO_TOOL_NAMES.has(normalised)
}

export function normalizeTodoStatus(value: unknown): TodoStatus {
  if (typeof value !== 'string') return 'pending'
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return TODO_STATUS_ALIASES[key] || 'pending'
}

function normalizeTodoRecord(raw: unknown, index: number): TodoItem | null {
  // A bare-string step (some plan shapes emit `["step text", ...]`).
  if (typeof raw === 'string') {
    const content = raw.trim()
    return content ? { id: `todo-${index + 1}`, content, status: 'pending' } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  // `step` / `description` cover Codex's native plan step shape ({ step, status }).
  const content = String(
    record.content ?? record.text ?? record.title ?? record.task ?? record.step ?? record.description ?? ''
  ).trim()
  if (!content) return null
  const id = String(record.id ?? record.todo_id ?? record.key ?? `todo-${index + 1}`).trim()
  return {
    id: id || `todo-${index + 1}`,
    content,
    status: normalizeTodoStatus(record.status ?? record.state),
    ...(typeof record.goalId === 'string' && record.goalId.trim()
      ? { goalId: record.goalId.trim() }
      : {}),
    ...(typeof record.assignmentId === 'string' && record.assignmentId.trim()
      ? { assignmentId: record.assignmentId.trim() }
      : {})
  }
}

export function parseTodoItemsFromUnknown(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const items: TodoItem[] = []
  for (let i = 0; i < value.length; i++) {
    const item = normalizeTodoRecord(value[i], i)
    if (item) items.push(item)
  }
  return items
}

export function parseTodoItemsFromParameters(
  parameters: Record<string, unknown> | undefined | null
): TodoItem[] {
  if (!parameters) return []
  const direct = parseTodoItemsFromUnknown(parameters.todos)
  if (direct.length > 0) return direct
  return parseTodoItemsFromUnknown(parameters.items)
}

export function parseTodoItemsFromJsonText(text: string): TodoItem[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parseTodoItemsFromUnknown(parsed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const fromTodos = parseTodoItemsFromUnknown(record.todos)
      if (fromTodos.length > 0) return fromTodos
      if (record.ok === true && record.tool === 'todo_write') {
        return parseTodoItemsFromUnknown(record.todos)
      }
    }
  } catch {
    // fall through
  }
  return []
}

export function parseTodoItemsFromActivity(input: {
  toolName?: string | null
  parameters?: Record<string, unknown>
  resultSummary?: string
  outputPreview?: string
}): TodoItem[] {
  const fromParams = parseTodoItemsFromParameters(input.parameters)
  if (fromParams.length > 0) return fromParams
  const result = String(input.resultSummary || input.outputPreview || '')
  return parseTodoItemsFromJsonText(result)
}

export function mergeTodoLists(prior: readonly TodoItem[], batch: readonly TodoItem[]): TodoItem[] {
  if (batch.length === 0) return [...prior]
  const byId = new Map<string, TodoItem>()
  for (const item of prior) byId.set(item.id, item)
  for (const item of batch) byId.set(item.id, item)
  const ordered: TodoItem[] = []
  const seen = new Set<string>()
  for (const item of prior) {
    const next = byId.get(item.id)
    if (next) {
      ordered.push(next)
      seen.add(item.id)
    }
  }
  for (const item of batch) {
    if (!seen.has(item.id)) {
      ordered.push(item)
      seen.add(item.id)
    }
  }
  return ordered
}

export function applyTodoWrite(
  prior: readonly TodoItem[],
  batch: readonly TodoItem[],
  merge: boolean
): TodoItem[] {
  if (merge) return mergeTodoLists(prior, batch)
  return [...batch]
}

/**
 * Apply a todo_write batch to ONE lane of a per-lane map, returning the next
 * map. The lane key separates concurrent ensemble participants writing to the
 * same chat; solo/guest collapse to TODO_SOLO_LANE. Pure.
 */
export function applyLaneTodoWrite(
  priorByLane: Readonly<Record<string, TodoItem[]>> | undefined,
  laneId: string,
  batch: readonly TodoItem[],
  merge: boolean,
  scope?: { goalId?: string; assignmentId?: string }
): Record<string, TodoItem[]> {
  const lane = laneId || TODO_SOLO_LANE
  const goalId = scope?.goalId?.trim()
  const assignmentId = scope?.assignmentId?.trim()
  const prior = (priorByLane?.[lane] ?? []).filter(
    (item) => !goalId || item.goalId === goalId
  )
  const scopedBatch = batch.map((item) => ({
    ...item,
    ...(goalId ? { goalId } : {}),
    ...(assignmentId ? { assignmentId } : {})
  }))
  return {
    ...(priorByLane ?? {}),
    [lane]: applyTodoWrite(prior, scopedBatch, merge)
  }
}

export function computeMergedTodosByActivityId(
  activities: ReadonlyArray<{
    id?: string
    toolName?: string | null
    parameters?: Record<string, unknown>
    resultSummary?: string
    outputPreview?: string
  }>
): Map<string, TodoItem[]> {
  const map = new Map<string, TodoItem[]>()
  let merged: TodoItem[] = []
  for (const activity of activities) {
    if (!isTodoToolName(activity.toolName) || !activity.id) continue
    const batch = parseTodoItemsFromActivity(activity)
    const merge = activity.parameters?.merge === true
    merged = applyTodoWrite(merged, batch, merge)
    map.set(activity.id, [...merged])
  }
  return map
}

export function computeMergedTodosFromActivities(
  activities: ReadonlyArray<{
    id?: string
    toolName?: string | null
    parameters?: Record<string, unknown>
    resultSummary?: string
    outputPreview?: string
  }>
): TodoItem[] {
  let merged: TodoItem[] = []
  for (const activity of activities) {
    if (!isTodoToolName(activity.toolName)) continue
    const batch = parseTodoItemsFromActivity(activity)
    const merge = activity.parameters?.merge === true
    merged = applyTodoWrite(merged, batch, merge)
  }
  return merged
}

/**
 * Group todo activities into per-lane merged lists. `laneOf` maps an activity to
 * its lane (ensemble participant/provider, or TODO_SOLO_LANE). Powers the
 * per-participant PlanRail (ensemble shows one lane per author; solo/guest
 * collapse to a single lane). Pure.
 */
export function computeMergedTodosByLane<
  A extends {
    toolName?: string | null
    parameters?: Record<string, unknown>
    resultSummary?: string
    outputPreview?: string
  }
>(activities: readonly A[], laneOf: (activity: A) => string): Record<string, TodoItem[]> {
  const byLane = new Map<string, A[]>()
  for (const activity of activities) {
    if (!isTodoToolName(activity.toolName)) continue
    const lane = laneOf(activity) || TODO_SOLO_LANE
    const bucket = byLane.get(lane)
    if (bucket) bucket.push(activity)
    else byLane.set(lane, [activity])
  }
  const out: Record<string, TodoItem[]> = {}
  for (const [lane, acts] of byLane) out[lane] = computeMergedTodosFromActivities(acts)
  return out
}

export interface TodoProgressSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
  cancelled: number
  label: string
}

export function summarizeTodoProgress(todos: readonly TodoItem[]): TodoProgressSummary {
  const total = todos.length
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0
  for (const item of todos) {
    if (item.status === 'completed') completed++
    else if (item.status === 'in_progress') inProgress++
    else if (item.status === 'cancelled') cancelled++
    else pending++
  }
  const active = total - cancelled
  const done = completed
  const label =
    total === 0
      ? 'Plan'
      : active === 0
        ? 'Plan'
        : `${done}/${active} complete`
  return { total, completed, inProgress, pending, cancelled, label }
}

export function findCurrentTodoStep(todos: readonly TodoItem[]): TodoItem | null {
  const inProgress = todos.find((item) => item.status === 'in_progress')
  if (inProgress) return inProgress
  return todos.find((item) => item.status === 'pending') || null
}

export function validateTodoWriteArgs(args: Record<string, unknown>): {
  ok: true
  todos: TodoItem[]
  merge: boolean
} | {
  ok: false
  error: string
} {
  const rawTodos = args.todos ?? args.items
  if (!Array.isArray(rawTodos)) {
    return { ok: false, error: 'todo_write requires a `todos` array.' }
  }
  const todos = parseTodoItemsFromUnknown(rawTodos)
  if (todos.length === 0) {
    return { ok: false, error: 'todo_write requires at least one todo with non-empty `content`.' }
  }
  const merge = args.merge === true
  return { ok: true, todos, merge }
}
