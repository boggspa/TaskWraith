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
import type { ProviderId, RunQueueJob, WorkspaceRecord } from '../store/types'
import { resolveCanonicalWorkspaceId } from '../WorkspaceIdentity'
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
        case 'tw_recall_read_events':
          return fail(
            toolName,
            `${toolName} is not implemented yet — the recall read verbs land in the next slice.`
          )
        default:
          return fail(toolName, `Unknown recall tool "${toolName}".`)
      }
    } catch (err) {
      return fail(toolName, err instanceof Error ? err.message : String(err))
    }
  }

  return { executeRecallTool }
}
