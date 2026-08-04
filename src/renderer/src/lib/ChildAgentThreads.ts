import type {
  ChatMessage,
  ChatRecord,
  ChildAgentInteractivity,
  ChildAgentKind,
  ChildAgentState,
  ChildAgentThread,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import { attachIdentitiesToThreads } from './agentIdentity'

const TASK_TOOL_NAMES = new Set([
  'task',
  'agent',
  'invoke_agent',
  'subagent',
  'subagentevent',
  'collabtoolcall'
])

/**
 * True when the activity is a sub-agent SPAWN anchor (Task / Agent /
 * invoke_agent …). Exported so ActivityStack can keep spawn anchors out of
 * "used N tools" compact groups and segment them into their own subagent
 * viewport lane.
 */
export function isChildAgentSpawnActivity(activity: ToolActivity): boolean {
  // The 'task' category in ToolParser also covers intent / progress markers
  // (update_topic, summary, progress, codex_reasoning, codex_plan,
  // kimi_thinking, etc.) — those are NOT sub-agent spawns and shouldn't be
  // promoted into ChildAgentThread cards. Trust the explicit name list only.
  const name = (activity.toolName || '').toLowerCase().trim()
  return TASK_TOOL_NAMES.has(name)
}

const isTaskActivity = isChildAgentSpawnActivity

function getParamString(
  params: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!params) return undefined
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function inferKindFromProvider(provider: ProviderId): ChildAgentKind {
  switch (provider) {
    case 'claude':
      return 'claude-task'
    case 'codex':
      return 'codex-background'
    case 'kimi':
      return 'kimi-swarm'
    case 'grok':
      return 'grok-agent'
    case 'cursor':
      return 'cursor-agent'
    case 'mistral':
      return 'mistral-agent'
    default:
      return 'gemini-subagent'
  }
}

function inferInteractivity(kind: ChildAgentKind): ChildAgentInteractivity {
  switch (kind) {
    case 'codex-background':
    case 'cursor-agent':
      return 'interactive'
    case 'kimi-swarm':
      return 'observe-only'
    // `mistral-agent` belongs in this group because the Vibe lane opens a fresh
    // session per turn and holds no persistent seat — one-shot like Grok's, not
    // observed across turns like Kimi's swarm.
    case 'grok-agent':
    case 'claude-task':
    case 'mistral-agent':
    case 'gemini-subagent':
    case 'manual':
    default:
      return 'oneshot'
  }
}

function inferState(activity: ToolActivity): ChildAgentState {
  switch (activity.status) {
    case 'running':
    case 'pending':
      return 'running'
    case 'success':
      return 'completed'
    case 'warning':
    case 'error':
      return 'failed'
    default:
      return 'queued'
  }
}

function inferName(activity: ToolActivity, index: number): { name: string; role?: string } {
  const params = activity.parameters || {}
  const description = getParamString(params, ['description', 'title', 'task'])
  const subagentType = getParamString(params, [
    'subagent_type',
    'subagentType',
    'agent_type',
    'agentType',
    'role'
  ])
  if (description) {
    return {
      name: description.length > 64 ? `${description.slice(0, 61)}…` : description,
      role: subagentType
    }
  }
  return { name: `Task #${index + 1}`, role: subagentType }
}

/**
 * Activity-only variant — used by ActivityStack which is scoped to one message.
 *
 * Pass `chat` to also populate `thread.identity` (visual name + color) via
 * `attachIdentitiesToThreads`. When `chat` is omitted, threads are returned
 * without identity (legacy callers).
 */
export function deriveChildAgentThreadsFromActivities(
  provider: ProviderId,
  chatId: string | undefined,
  runId: string | undefined,
  activities: ToolActivity[],
  chat?: ChatRecord
): ChildAgentThread[] {
  const threads: ChildAgentThread[] = []
  const threadById = new Map<string, ChildAgentThread>()

  let taskCounter = 0
  for (const activity of activities) {
    if (!isTaskActivity(activity)) continue
    const kind = inferKindFromProvider(provider)
    const { name, role } = inferName(activity, taskCounter)
    const params = activity.parameters || {}
    const seedPrompt = getParamString(params, ['prompt', 'input', 'request', 'query'])
    const finalResult = activity.resultSummary || activity.outputPreview || undefined
    const thread: ChildAgentThread = {
      id: activity.id,
      parentChatId: chatId,
      parentRunId: runId,
      parentToolCallId: activity.id,
      provider,
      kind,
      interactivity: inferInteractivity(kind),
      name,
      role,
      state: inferState(activity),
      startedAt: activity.startedAt,
      endedAt: activity.endedAt,
      durationMs: activity.durationMs,
      seedPrompt,
      finalResult,
      toolActivityIds: []
    }
    threads.push(thread)
    threadById.set(activity.id, thread)
    taskCounter += 1
  }

  if (threadById.size === 0) return []

  for (const activity of activities) {
    const parentId = activity.parentToolCallId
    if (!parentId) continue
    const parentThread = threadById.get(parentId)
    if (!parentThread) continue
    parentThread.toolActivityIds.push(activity.id)
  }

  // Attach visual identities (name + color) when a chat is provided. This
  // mutates `chat.providerMetadata.agentIdentities` so the same agent ids keep
  // the same identity across renders and across app reloads.
  if (chat) {
    const activityById = new Map<string, ToolActivity>()
    for (const activity of activities) activityById.set(activity.id, activity)
    return attachIdentitiesToThreads(chat, threads, activityById)
  }

  return threads
}

/**
 * Build child-agent thread records by walking a chat's messages, identifying
 * Task / Agent / invoke_agent tool calls, and grouping any sub-tool-calls that
 * link back to them via parentToolCallId.
 *
 * Returns the threads in the order their parent calls appeared.
 */
export function deriveChildAgentThreads(
  provider: ProviderId,
  chatId: string | undefined,
  messages: ChatMessage[] = [],
  chat?: ChatRecord
): ChildAgentThread[] {
  const allActivities: ToolActivity[] = []
  let firstRunId: string | undefined
  for (const message of messages) {
    if (!firstRunId && message.runId) firstRunId = message.runId
    for (const activity of message.toolActivities || []) {
      allActivities.push(activity)
    }
  }
  return deriveChildAgentThreadsFromActivities(provider, chatId, firstRunId, allActivities, chat)
}

export function findChildActivitiesForThread(
  thread: ChildAgentThread,
  messages: ChatMessage[] = []
): ToolActivity[] {
  const idSet = new Set(thread.toolActivityIds)
  const activities: ToolActivity[] = []
  for (const message of messages) {
    for (const activity of message.toolActivities || []) {
      if (idSet.has(activity.id)) {
        activities.push(activity)
      }
    }
  }
  return activities
}
