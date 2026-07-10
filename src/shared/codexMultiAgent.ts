/**
 * Codex native Multi-agent telemetry.
 *
 * Codex's Multi-agent beta lets a root agent spawn subagents that work in
 * parallel and then synthesizes their results (OpenAI's product term is
 * "Multi-agent"; internal transport identifiers like `multi_agents_v2` or
 * `responses_multi_agent=v1` must never surface in user-facing copy).
 *
 * Evidence base (captured live from `codex app-server` 0.144.0, 2026-07-10):
 *   - PARENT-thread `item/completed` with `item.type: 'subAgentActivity'`:
 *       { id: 'call_…', kind: 'started', agentThreadId, agentPath: '/root/<task>' }
 *     One per spawn. NO terminal subAgentActivity kind is emitted — a
 *     subagent's completion is only observable via its CHILD thread's
 *     `turn/completed` (threadId === agentThreadId).
 *   - PARENT-thread `item/started|completed` with `item.type: 'collabAgentToolCall'`:
 *       { id, tool: 'wait', status: 'inProgress'|'completed', senderThreadId,
 *         receiverThreadIds, prompt, model, reasoningEffort, agentsStates }
 *     Coordination actions (the raw model-side vocabulary is `spawn_agent`,
 *     `wait_agent`, `send_message`, `interrupt_agent`, … under
 *     `namespace: 'collaboration'`).
 *   - CHILD-thread `turn/started` / `turn/completed` / `turn/failed` with
 *     threadId === a registered agentThreadId.
 *
 * The raw spawn `message` payloads and reasoning `encrypted_content` are
 * ENCRYPTED on the wire — they are never decoded, stored on telemetry, or
 * rendered. The only honest task label is the plaintext tail of `agentPath`
 * (the model-chosen `task_name`, e.g. '/root/ready_one' → 'ready_one').
 *
 * Honesty levels drive the card: `detailLevel: 'full'` when subagent
 * identities were observed; `'detected'` when only coordination markers were
 * seen. Detection NEVER comes from model choice, effort setting, latency, or
 * tool volume — only from these explicit provider events.
 *
 * Because Codex emits no natural anchor tool-call for the episode, the main
 * process synthesizes a single `codex_multi_agent` tool activity at the first
 * explicit Multi-agent event and attaches this telemetry to it (keyed by that
 * activity id) — mirroring `codex_review` / the Claude `Workflow` card.
 *
 * Pure and node-builtin-free: imported by main (ingestion), renderer (card),
 * and the shared `ToolActivity` type. Provider stays a loose string to avoid
 * a cycle with store/types.
 */

export type CodexMultiAgentStatus =
  | 'delegating'
  | 'working'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown'

export type CodexSubagentStatus = 'spawned' | 'working' | 'completed' | 'failed' | 'interrupted'

/** One OBSERVED subagent. Never fabricated — only created from an explicit
 * `subAgentActivity` spawn event carrying at least a call id. */
export interface CodexSubagentState {
  /** Spawn call id (`call_…`) — the stable identity for this subagent. */
  id: string
  /** The subagent's own thread id; correlates child-thread turn events. */
  agentThreadId?: string
  /** Hierarchical agent path, e.g. '/root/ready_one'. */
  agentPath?: string
  /** Plaintext task label — the tail segment of agentPath. NOT the (encrypted)
   * spawn message. */
  taskName?: string
  status: CodexSubagentStatus
  startedAtMs?: number
  completedAtMs?: number
}

export type CodexMultiAgentDetailLevel = 'full' | 'detected'

/** The honest slice of a Codex Multi-agent episode we can surface. Attached to
 * the synthesized `codex_multi_agent` tool activity as
 * `ToolActivity.multiAgentSummary`. */
export interface CodexMultiAgentTelemetry {
  /** Producing provider — 'codex' today (loose string to keep this pure). */
  provider?: string
  status?: CodexMultiAgentStatus
  /** Stable episode identity: `<parentThreadId>:<parentTurnId>`. */
  episodeId?: string
  /** 'full' = subagent identities observed; 'detected' = only coordination
   * markers observed (counts/chips must not be shown). */
  detailLevel?: CodexMultiAgentDetailLevel
  /** Observed subagents, in spawn order. */
  subagents?: CodexSubagentState[]
  /** Count of coordination actions observed (wait / send / interrupt / …). */
  coordinationEvents?: number
  /** Most recent coordination tool name (e.g. 'wait'). */
  lastCoordination?: string
  startedAtMs?: number
  durationMs?: number
  /** Parent-turn token usage at settle (the episode IS the parent turn). */
  totalTokens?: number
  /** True only when the synthesis phase was actually observed (all observed
   * subagents settled + coordination resumed on the root before completion).
   * Drives "…and synthesized their results" vs neutral completion copy. */
  synthesized?: boolean
  error?: string
}

/** Tool name of the synthesized Multi-agent anchor activity. */
export const CODEX_MULTI_AGENT_TOOL_NAME = 'codex_multi_agent'

const TERMINAL_STATUSES = new Set<CodexMultiAgentStatus>(['completed', 'failed', 'interrupted'])

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** True when a tool name is the synthesized Multi-agent anchor. */
export function isCodexMultiAgentToolName(name: string | undefined | null): boolean {
  return str(name).toLowerCase() === CODEX_MULTI_AGENT_TOOL_NAME
}

/**
 * Item types that are Multi-agent COORDINATION events. These are excluded from
 * the generic Tool viewport (they render through the orchestration card) while
 * remaining available in raw provider events.
 */
export function isCodexMultiAgentCoordinationItemType(type: string | undefined | null): boolean {
  const value = str(type)
  return value === 'subAgentActivity' || value === 'collabAgentToolCall'
}

/** Stable episode identity for one orchestration episode (= one parent turn). */
export function codexMultiAgentEpisodeId(
  threadId: string | undefined | null,
  turnId: string | undefined | null
): string {
  return `${str(threadId) || 'thread'}:${str(turnId) || 'turn'}`
}

/** Plaintext task label from an agent path ('/root/ready_one' → 'ready_one'). */
export function codexAgentPathTaskName(agentPath: string | undefined | null): string | undefined {
  const path = str(agentPath)
  if (!path) return undefined
  const tail = path.split('/').filter(Boolean).pop()
  return tail || undefined
}

/** Fresh telemetry for a newly detected episode. */
export function codexMultiAgentStartTelemetry(input: {
  episodeId?: string
  startedAtMs?: number
}): CodexMultiAgentTelemetry {
  const telemetry: CodexMultiAgentTelemetry = {
    provider: 'codex',
    status: 'delegating',
    detailLevel: 'detected',
    subagents: [],
    coordinationEvents: 0
  }
  if (input.episodeId) telemetry.episodeId = input.episodeId
  if (typeof input.startedAtMs === 'number' && Number.isFinite(input.startedAtMs)) {
    telemetry.startedAtMs = input.startedAtMs
  }
  return telemetry
}

/** Recompute the episode status from observed subagent states. Only called
 * while the episode is live (finalize handles terminal states). */
function deriveLiveStatus(telemetry: CodexMultiAgentTelemetry): CodexMultiAgentStatus {
  const subagents = telemetry.subagents ?? []
  if (subagents.length === 0) return 'delegating'
  const allSettled = subagents.every(
    (agent) =>
      agent.status === 'completed' || agent.status === 'failed' || agent.status === 'interrupted'
  )
  // All observed subagents settled while the parent turn is still running —
  // the root is synthesizing their results. Only claimed when at least one
  // subagent actually COMPLETED: if every one failed/was interrupted there are
  // no results to synthesize, so the root is honestly still just working.
  if (allSettled && subagents.some((agent) => agent.status === 'completed')) {
    return 'synthesizing'
  }
  // Any progress beyond bare spawns (a child turn started, or some agents
  // already settled while others run) = parallel work in flight.
  const anyProgress = subagents.some((agent) => agent.status !== 'spawned')
  return anyProgress ? 'working' : 'delegating'
}

/**
 * Apply a parent-thread `subAgentActivity` item. `kind: 'started'` registers a
 * subagent; a terminal-looking kind for a known agentThreadId settles it; any
 * other kind is tolerated as a bare activity marker (no fabrication).
 */
export function applyCodexSubAgentActivity(
  previous: CodexMultiAgentTelemetry,
  item: unknown,
  atMs?: number
): CodexMultiAgentTelemetry {
  const record = asRecord(item)
  if (!record) return previous
  const next: CodexMultiAgentTelemetry = {
    ...previous,
    subagents: [...(previous.subagents ?? [])]
  }
  const kind = str(record.kind).toLowerCase()
  const id = str(record.id)
  const agentThreadId = str(record.agentThreadId) || undefined
  const agentPath = str(record.agentPath) || undefined

  if (kind === 'started' && id) {
    const existing = next.subagents!.find((agent) => agent.id === id)
    if (!existing) {
      next.subagents!.push({
        id,
        agentThreadId,
        agentPath,
        taskName: codexAgentPathTaskName(agentPath),
        status: 'spawned',
        startedAtMs: atMs
      })
    } else {
      // Duplicate raw events describing the same spawn — enrich, don't dupe.
      existing.agentThreadId = existing.agentThreadId ?? agentThreadId
      existing.agentPath = existing.agentPath ?? agentPath
      existing.taskName = existing.taskName ?? codexAgentPathTaskName(agentPath)
    }
  } else if (
    (kind === 'completed' || kind === 'finished' || kind === 'stopped' || kind === 'failed') &&
    (id || agentThreadId)
  ) {
    // Defensive: not observed on 0.144.0 (completion arrives via the child
    // thread's turn/completed), but honor it if a future runtime emits one.
    const match = next.subagents!.find(
      (agent) => (id && agent.id === id) || (agentThreadId && agent.agentThreadId === agentThreadId)
    )
    if (match && match.status !== 'completed' && match.status !== 'failed') {
      match.status = kind === 'failed' ? 'failed' : 'completed'
      match.completedAtMs = atMs
    }
  }

  if (next.subagents!.some((agent) => agent.agentThreadId)) {
    next.detailLevel = 'full'
  }
  next.status = deriveLiveStatus(next)
  return next
}

/**
 * Apply a parent-thread `collabAgentToolCall` item (wait / send / interrupt /
 * …). Counts it as coordination once per call id + status transition, records
 * the tool name, and absorbs any per-agent states the runtime volunteers.
 */
export function applyCodexCollabToolCall(
  previous: CodexMultiAgentTelemetry,
  item: unknown,
  phase: 'started' | 'completed'
): CodexMultiAgentTelemetry {
  const record = asRecord(item)
  if (!record) return previous
  const next: CodexMultiAgentTelemetry = {
    ...previous,
    subagents: [...(previous.subagents ?? [])]
  }
  const tool = str(record.tool).toLowerCase()
  if (phase === 'started') {
    next.coordinationEvents = (next.coordinationEvents ?? 0) + 1
    if (tool) next.lastCoordination = tool
  }
  // agentsStates: optional { [agentThreadId]: status-ish } map — absorb only
  // states for subagents we already observed (never manufacture agents).
  const states = asRecord(record.agentsStates)
  if (states) {
    for (const [agentThreadId, rawState] of Object.entries(states)) {
      const match = next.subagents!.find((agent) => agent.agentThreadId === agentThreadId)
      if (!match) continue
      const state = str(rawState).toLowerCase()
      if (state === 'completed' || state === 'done') match.status = 'completed'
      else if (state === 'failed' || state === 'error') match.status = 'failed'
      else if (state === 'running' || state === 'active' || state === 'working')
        match.status = 'working'
    }
  }
  // An interrupt_agent call settles targeted subagents as interrupted.
  if (tool === 'interrupt' || tool === 'interrupt_agent') {
    const receivers = Array.isArray(record.receiverThreadIds)
      ? record.receiverThreadIds.map((value) => str(value)).filter(Boolean)
      : []
    for (const receiver of receivers) {
      const match = next.subagents!.find((agent) => agent.agentThreadId === receiver)
      if (match && match.status !== 'completed' && match.status !== 'failed') {
        match.status = 'interrupted'
      }
    }
  }
  next.status = deriveLiveStatus(next)
  return next
}

/**
 * Apply a CHILD-thread turn lifecycle event for a registered agentThreadId
 * (the only way subagent completion is observable on 0.144.0).
 */
export function applyCodexChildTurnEvent(
  previous: CodexMultiAgentTelemetry,
  input: {
    agentThreadId: string
    kind: 'started' | 'completed' | 'failed' | 'interrupted'
    atMs?: number
  }
): CodexMultiAgentTelemetry {
  const agentThreadId = str(input.agentThreadId)
  if (!agentThreadId) return previous
  const subagents = previous.subagents ?? []
  const index = subagents.findIndex((agent) => agent.agentThreadId === agentThreadId)
  if (index === -1) return previous
  const next: CodexMultiAgentTelemetry = { ...previous, subagents: [...subagents] }
  const agent = { ...next.subagents![index] }
  if (input.kind === 'started') {
    if (agent.status === 'spawned') agent.status = 'working'
  } else if (input.kind === 'completed') {
    agent.status = 'completed'
    agent.completedAtMs = input.atMs
  } else if (input.kind === 'failed') {
    agent.status = 'failed'
    agent.completedAtMs = input.atMs
  } else if (input.kind === 'interrupted') {
    if (agent.status !== 'completed' && agent.status !== 'failed') {
      agent.status = 'interrupted'
      agent.completedAtMs = input.atMs
    }
  }
  next.subagents![index] = agent
  next.status = deriveLiveStatus(next)
  return next
}

/** Finalize the episode when the PARENT turn settles. */
export function finalizeCodexMultiAgent(
  previous: CodexMultiAgentTelemetry,
  input: {
    outcome: 'completed' | 'failed' | 'interrupted'
    durationMs?: number
    totalTokens?: number
    error?: string
  }
): CodexMultiAgentTelemetry {
  const next: CodexMultiAgentTelemetry = { ...previous }
  // "Synthesized" is only claimed when the synthesis phase was actually
  // reached before the parent turn settled successfully AND at least one
  // subagent genuinely completed (an all-failed fan-out has no results to
  // synthesize, whatever the parent turn's own outcome).
  next.synthesized =
    input.outcome === 'completed' &&
    previous.status === 'synthesizing' &&
    (previous.subagents ?? []).some((agent) => agent.status === 'completed')
  next.status = input.outcome
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    next.durationMs = input.durationMs
  }
  if (typeof input.totalTokens === 'number' && Number.isFinite(input.totalTokens)) {
    next.totalTokens = input.totalTokens
  }
  const error = str(input.error)
  if (error) next.error = error
  // Subagents still marked live when the episode ends inherit the outcome
  // shape honestly: interrupted episodes interrupt them; otherwise leave the
  // last observed state untouched (no fabricated completion).
  if (input.outcome === 'interrupted' && next.subagents) {
    next.subagents = next.subagents.map((agent) =>
      agent.status === 'spawned' || agent.status === 'working'
        ? { ...agent, status: 'interrupted' }
        : agent
    )
  }
  return next
}

/**
 * Merge a telemetry patch onto accumulated telemetry. Only defined (non-empty)
 * fields overwrite, and a terminal status is never downgraded by a late or
 * out-of-order frame.
 */
export function mergeCodexMultiAgentTelemetry(
  previous: CodexMultiAgentTelemetry | undefined,
  next: Partial<CodexMultiAgentTelemetry> | null | undefined
): CodexMultiAgentTelemetry {
  const merged: CodexMultiAgentTelemetry = { ...(previous || {}) }
  if (!next) return merged
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  if (
    previous?.status &&
    TERMINAL_STATUSES.has(previous.status) &&
    merged.status &&
    !TERMINAL_STATUSES.has(merged.status)
  ) {
    merged.status = previous.status
  }
  return merged
}
