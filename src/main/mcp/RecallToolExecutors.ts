/**
 * MCP executor for the exclusive `tw_recall_*` cross-thread retrospection tool
 * family.
 *
 * `tw_recall_find` resolves a deliberately-vague {provider, workspace, time,
 * task} reference to a ranked, bounded set of past runs; `tw_recall_read` /
 * `tw_recall_read_events` read how far a chosen run got. All three are
 * READ-ONLY.
 *
 * Scope model (v1): a find is scoped to a SINGLE workspace — the one the agent
 * named, or (if it named none) the caller's own workspace. Searching the
 * caller's own workspace is auto-allowed; naming a DIFFERENT workspace is a
 * cross-workspace read. The host approval gate runs before this executor, so
 * the call is already user-approved by the time we resolve; Slice 3 refines
 * that gate into the scope-conditional `crossThreadRead` service (own-workspace
 * skips the prompt, cross-workspace uses a per-provider/expiring grant). The
 * `crossWorkspace` flag in the result tells the host which path applied.
 *
 * Like the canvas executor this is a factory over injected deps so it stays
 * unit-testable with no Electron. Slice 4 fills in the read verbs (they return
 * `not_implemented` here).
 */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import type { ProviderId, RunEventRecord, RunQueueJob, WorkspaceRecord } from '../store/types'
import { resolveCanonicalWorkspaceId } from '../WorkspaceIdentity'
import { createRunEventReplay } from '../RunEventStore'
import {
  RECALL_TOP_K,
  normalizeProviderQuery,
  resolveRecall,
  type RecallResolution
} from '../CrossThreadRecall'

export const RECALL_MCP_TOOL_NAMES = [
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events'
] as const

export type RecallMcpToolName = (typeof RECALL_MCP_TOOL_NAMES)[number]

const RECALL_TOOL_NAME_SET: ReadonlySet<string> = new Set(RECALL_MCP_TOOL_NAMES)

export function isRecallMcpToolName(name: string): name is RecallMcpToolName {
  return RECALL_TOOL_NAME_SET.has(name)
}

/** Narrow caller context; GeminiToolContext is structurally assignable. */
export interface RecallToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  scope?: string
}

export interface RecallToolExecutorDeps {
  /** Cheap run-queue metadata read (no message bodies, no write side effects). */
  listRunQueueJobs: (filter: { provider?: ProviderId; includeTerminal?: boolean }) => RunQueueJob[]
  getWorkspaces: () => readonly WorkspaceRecord[]
  /** Caller's canonical workspace id, or null (global scope / unknown). */
  resolveCallerWorkspaceId: (context: RecallToolContext) => string | null
  /** Full chat text (title + message bodies) for top-K topic rescoring only. */
  loadChatText: (chatId: string) => string | null
  /** False when a run's forensic events are gone (deleted/tombstoned) so it is
   * excluded rather than ranked as an empty shell. */
  isForensicsAvailable: (runId: string) => boolean
  /** Optional remote-allowlist visibility gate (capability 'monitor'). When
   * provided and it returns false for the target workspace, find refuses —
   * defence for a remote caller (host-issued recall is the v1 path). */
  isWorkspaceVisibleToCaller?: (workspaceId: string, context: RecallToolContext) => boolean
  /** Read-verb deps (Slice 4). */
  getRunQueueJob: (runId: string) => RunQueueJob | null
  getRunEvents: (runId: string) => RunEventRecord[]
  /** The run's final assistant message text (durable result), or null. */
  loadFinalAssistantMessage: (input: { runId: string; chatId: string | null }) => string | null
  /** Best-effort plan/todo progress for the run, or null. */
  loadPlanProgress?: (input: { runId: string; chatId: string | null }) => {
    done: number
    total: number
  } | null
  /** Mint an opaque per-serving citation token (Slice 5 makes it verifiable). */
  mintCitationToken: (input: { runId: string; kind: string }) => string
  now: () => number
  normalizePath?: (value: string) => string
  timeZone?: string
}

export interface RecallToolExecutors {
  executeRecallTool: (
    toolName: RecallMcpToolName,
    rawArgs: unknown,
    context: RecallToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asOptString(value: unknown): string | undefined {
  const s = asString(value).trim()
  return s ? s : undefined
}

function asOptNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function jsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }, ...extraContent] }
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

export function createRecallToolExecutors(deps: RecallToolExecutorDeps): RecallToolExecutors {
  function executeFind(rawArgs: unknown, context: RecallToolContext): McpToolExecutionResult {
    const args = asRecord(rawArgs)
    const tool = 'tw_recall_find'
    const workspaces = deps.getWorkspaces()
    const callerWorkspaceId = deps.resolveCallerWorkspaceId(context)
    const namedWorkspace = asOptString(args.workspace)

    // Decide which single workspace to search: the named one, else the
    // caller's own. With neither we refuse rather than enumerate everything.
    const searchWorkspaceRef = namedWorkspace ?? callerWorkspaceId
    if (!searchWorkspaceRef) {
      return jsonResult({
        ok: true,
        tool,
        matchKind: 'none',
        candidates: [],
        crossWorkspace: false,
        note: 'Tell me which workspace to look in — this chat is not scoped to a workspace.'
      })
    }

    const canonicalSearchWs = resolveCanonicalWorkspaceId(
      searchWorkspaceRef,
      workspaces,
      deps.normalizePath
    )
    const crossWorkspace = canonicalSearchWs
      ? canonicalSearchWs !== callerWorkspaceId
      : Boolean(namedWorkspace)

    // Remote-allowlist intersection (defensive; remote-issued recall is blocked
    // upstream in v1, so this only bites if that ever changes).
    if (
      canonicalSearchWs &&
      deps.isWorkspaceVisibleToCaller &&
      !deps.isWorkspaceVisibleToCaller(canonicalSearchWs, context)
    ) {
      return jsonResult({
        ok: true,
        tool,
        matchKind: 'none',
        candidates: [],
        crossWorkspace,
        note: 'That workspace is not in your allowlist.'
      })
    }

    const provider = normalizeProviderQuery(asOptString(args.provider)) ?? undefined
    const jobs = deps.listRunQueueJobs({ provider, includeTerminal: true })

    const resolution: RecallResolution = resolveRecall(
      {
        provider: asOptString(args.provider) ?? null,
        workspace: searchWorkspaceRef,
        timeApprox: asOptString(args.timeApprox) ?? null,
        taskQuery: asOptString(args.taskQuery) ?? null,
        freeText: asOptString(args.freeText) ?? null
      },
      jobs,
      {
        workspaces,
        now: deps.now(),
        timeZone: deps.timeZone,
        normalizePath: deps.normalizePath,
        loadTopicText: (job) => (job.chatId ? deps.loadChatText(job.chatId) : null),
        isForensicsAvailable: (job) => deps.isForensicsAvailable(job.runId)
      }
    )

    const requestedLimit = asOptNumber(args.limit)
    const limit =
      requestedLimit && requestedLimit > 0
        ? Math.min(RECALL_TOP_K, Math.floor(requestedLimit))
        : RECALL_TOP_K
    const candidates = resolution.candidates.slice(0, limit)

    return jsonResult({
      ok: true,
      tool,
      crossWorkspace,
      interpretation: resolution.interpretation,
      matchKind: resolution.matchKind,
      candidates
    })
  }

  function workspaceLabelFor(workspaceId: string | null | undefined): string | null {
    if (!workspaceId) return null
    const workspaces = deps.getWorkspaces()
    const canonical = resolveCanonicalWorkspaceId(workspaceId, workspaces, deps.normalizePath)
    if (!canonical) return null
    return workspaces.find((w) => w.id === canonical)?.displayName ?? null
  }

  function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value
  }

  function executeRead(rawArgs: unknown): McpToolExecutionResult {
    const tool = 'tw_recall_read'
    const args = asRecord(rawArgs)
    const runId = asOptString(args.runId)
    if (!runId)
      return fail(tool, '`runId` is required (use a runId from a tw_recall_find candidate).')

    // Fail closed when the run's forensics were deleted — never return an
    // empty-but-plausible shell (the #1 confabulation trap).
    if (!deps.isForensicsAvailable(runId)) {
      return jsonResult({
        ok: true,
        tool,
        runId,
        available: false,
        reason: 'forensics_deleted',
        message: "That run's history was deleted, so I can't see how far it got."
      })
    }

    const events = deps.getRunEvents(runId)
    if (events.length === 0) {
      return jsonResult({
        ok: true,
        tool,
        runId,
        available: false,
        reason: 'no_events',
        message: 'No durable events were recorded for that run.'
      })
    }

    const job = deps.getRunQueueJob(runId)
    const replay = createRunEventReplay(runId, events)
    const startedAt = job?.startedAt || replay.startedAt || null
    const endedAt =
      job?.endedAt ||
      job?.completedAt ||
      job?.failedAt ||
      job?.cancelledAt ||
      replay.endedAt ||
      null
    const durationMs =
      startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null
    const finalMessage = deps.loadFinalAssistantMessage({ runId, chatId: job?.chatId ?? null })
    const planProgress = deps.loadPlanProgress?.({ runId, chatId: job?.chatId ?? null }) ?? null
    const citationToken = deps.mintCitationToken({ runId, kind: 'read' })

    const result: Record<string, unknown> = {
      ok: true,
      tool,
      runId,
      available: true,
      provider: job?.provider ?? null,
      workspace: workspaceLabelFor(job?.workspaceId),
      status: job?.status ?? 'unknown',
      startedAt,
      endedAt,
      durationMs,
      counts: replay.countsByKind,
      finalMessage: finalMessage ? truncate(finalMessage, 4000) : null,
      planProgress,
      citationToken
    }
    if (asOptString(args.depth) === 'full') {
      result.timeline = replay.timeline.slice(-40).map((entry) => ({
        sequence: entry.sequence,
        kind: entry.kind,
        summary: entry.summary,
        timestamp: entry.timestamp
      }))
    }
    return jsonResult(result)
  }

  function executeReadEvents(rawArgs: unknown): McpToolExecutionResult {
    const tool = 'tw_recall_read_events'
    const args = asRecord(rawArgs)
    const runId = asOptString(args.runId)
    if (!runId)
      return fail(tool, '`runId` is required (use a runId from a tw_recall_find candidate).')

    if (!deps.isForensicsAvailable(runId)) {
      return jsonResult({ ok: true, tool, runId, available: false, reason: 'forensics_deleted' })
    }

    const kind = asOptString(args.kind)
    const all = deps.getRunEvents(runId)
    const filtered = kind ? all.filter((event) => event.kind === kind) : all
    const requested = asOptNumber(args.limit)
    const limit = requested && requested > 0 ? Math.min(100, Math.floor(requested)) : 30
    const sliced = filtered.slice(-limit)
    const citationToken = deps.mintCitationToken({ runId, kind: 'read_events' })

    return jsonResult({
      ok: true,
      tool,
      runId,
      available: true,
      count: sliced.length,
      totalAvailable: filtered.length,
      truncated: filtered.length > sliced.length,
      disclaimer:
        'Long runs are compacted on disk; older detail may be summarized rather than verbatim.',
      citationToken,
      events: sliced.map((event) => ({
        sequence: event.sequence,
        kind: event.kind,
        phase: event.phase,
        summary: event.summary,
        timestamp: event.timestamp,
        payloadPreview:
          event.payload != null ? truncate(JSON.stringify(event.payload), 600) : undefined
      }))
    })
  }

  async function executeRecallTool(
    toolName: RecallMcpToolName,
    rawArgs: unknown,
    context: RecallToolContext,
    _parentProvider: string
  ): Promise<McpToolExecutionResult> {
    try {
      switch (toolName) {
        case 'tw_recall_find':
          return executeFind(rawArgs, context)
        case 'tw_recall_read':
          return executeRead(rawArgs)
        case 'tw_recall_read_events':
          return executeReadEvents(rawArgs)
        default:
          return fail(toolName, `Unknown recall tool "${toolName}".`)
      }
    } catch (err) {
      return fail(toolName, err instanceof Error ? err.message : String(err))
    }
  }

  return { executeRecallTool }
}
