/**
 * MCP executor for the `tw_introspection_*` Thread Introspection tool family.
 *
 * Safe, review-gated surface over the landed introspection backend:
 * - `tw_introspection_run` — harvest recent substrate and persist a proposal pack
 * - `tw_introspection_list` / `tw_introspection_read` — read-only pack access
 * - `tw_introspection_review` — approve/reject/expire proposals (no apply path)
 *
 * Apply (`applyMemoryProposal` → RepoConventionIndex) stays Settings-only in
 * phase 1; skill/instruction writes remain blocked.
 */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import type {
  MemoryProposal,
  MemoryProposalPack,
  MemoryProposalStatus
} from '../store/types'
import { buildRolling24hWindow } from '../introspection/IntrospectionScheduler'
import type {
  RunManualIntrospectionInput,
  RunManualIntrospectionResult
} from '../introspection/IntrospectionRunService'

export const INTROSPECTION_MCP_TOOL_NAMES = [
  'tw_introspection_run',
  'tw_introspection_list',
  'tw_introspection_read',
  'tw_introspection_review'
] as const

export type IntrospectionMcpToolName = (typeof INTROSPECTION_MCP_TOOL_NAMES)[number]

const INTROSPECTION_TOOL_NAME_SET: ReadonlySet<string> = new Set(INTROSPECTION_MCP_TOOL_NAMES)

const REVIEWABLE_STATUSES = new Set<MemoryProposalStatus>(['approved', 'rejected', 'expired'])

export function isIntrospectionMcpToolName(name: string): name is IntrospectionMcpToolName {
  return INTROSPECTION_TOOL_NAME_SET.has(name)
}

export interface IntrospectionToolContext {
  appChatId?: string
  workspacePath?: string
}

export interface IntrospectionToolExecutorDeps {
  getMemoryProposalPacks: (workspaceId?: string) => MemoryProposalPack[]
  getMemoryProposalPack: (id: string) => MemoryProposalPack | null
  updateMemoryProposal: (
    packId: string,
    proposalId: string,
    partial: Partial<MemoryProposal>
  ) => MemoryProposalPack | null
  runManualIntrospection: (input: RunManualIntrospectionInput) => RunManualIntrospectionResult
  resolveCallerWorkspaceId: (context: IntrospectionToolContext) => string | null
  resolveCallerWorkspacePath: (context: IntrospectionToolContext) => string | undefined
  now: () => string
}

export interface IntrospectionToolExecutors {
  executeIntrospectionTool: (
    toolName: IntrospectionMcpToolName,
    rawArgs: unknown,
    context: IntrospectionToolContext
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function text(value: unknown, max = 240): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function optionalText(value: unknown, max = 240): string | undefined {
  const trimmed = text(value, max)
  return trimmed || undefined
}

function parseIsoWindow(value: unknown): string | null {
  const raw = text(value, 80)
  if (!raw) return null
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function jsonResult(
  value: Record<string, unknown>,
  extraContent: McpToolContentBlock[] = []
): McpToolExecutionResult {
  const serialized = JSON.stringify(value)
  return {
    text: serialized,
    structuredContent: value,
    content: [{ type: 'text', text: serialized }, ...extraContent]
  }
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const serialized = JSON.stringify(value)
  return {
    text: serialized,
    isError: true,
    structuredContent: value,
    content: [{ type: 'text', text: serialized }]
  }
}

function sanitizeProposalPatch(partial: unknown): Partial<MemoryProposal> {
  if (!partial || typeof partial !== 'object') return {}
  const input = partial as Partial<MemoryProposal>
  const patch: Partial<MemoryProposal> = {}

  if (input.status && REVIEWABLE_STATUSES.has(input.status)) {
    patch.status = input.status
  }

  const reviewNote = optionalText(input.reviewNote, 2000)
  if (reviewNote) patch.reviewNote = reviewNote

  const expiresAt = parseIsoWindow(input.expiresAt)
  if (expiresAt) patch.expiresAt = expiresAt

  return patch
}

function sanitizeRunInput(
  rawArgs: unknown,
  context: IntrospectionToolContext,
  deps: IntrospectionToolExecutorDeps
): RunManualIntrospectionInput | { error: string } {
  const args = asRecord(rawArgs)
  const nowIso = deps.now()

  let windowStart = parseIsoWindow(args.windowStart)
  let windowEnd = parseIsoWindow(args.windowEnd)

  if (!windowStart || !windowEnd) {
    const hoursBackRaw = Number(args.hoursBack)
    const hoursBack =
      Number.isFinite(hoursBackRaw) && hoursBackRaw > 0 ? Math.min(hoursBackRaw, 168) : 24
    const endMs = Date.parse(nowIso)
    const end = Number.isFinite(endMs) ? endMs : Date.now()
    windowEnd = new Date(end).toISOString()
    windowStart = new Date(end - hoursBack * 60 * 60 * 1000).toISOString()
  }

  if (!windowStart || !windowEnd) {
    return { error: 'windowStart and windowEnd must be valid ISO timestamps.' }
  }
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) {
    return { error: 'windowStart must be earlier than windowEnd.' }
  }

  const workspaceId =
    optionalText(args.workspaceId, 120) ?? deps.resolveCallerWorkspaceId(context) ?? undefined
  const workspacePath =
    optionalText(args.workspacePath, 4096) ?? deps.resolveCallerWorkspacePath(context)

  const minConfidenceRaw = Number(args.minConfidence)
  const minConfidence =
    Number.isFinite(minConfidenceRaw) ? Math.min(1, Math.max(0, minConfidenceRaw)) : undefined

  return {
    windowStart,
    windowEnd,
    workspaceId,
    workspacePath,
    trigger: 'manual',
    chatId: optionalText(args.chatId, 120) ?? optionalText(context.appChatId, 120),
    minConfidence,
    summary: optionalText(args.summary, 8000)
  }
}

function summarizePack(pack: MemoryProposalPack) {
  const statusCounts: Partial<Record<MemoryProposalStatus, number>> = {}
  for (const proposal of pack.proposals) {
    statusCounts[proposal.status] = (statusCounts[proposal.status] ?? 0) + 1
  }
  return {
    id: pack.id,
    introspectionRunId: pack.introspectionRunId,
    windowStart: pack.windowStart,
    windowEnd: pack.windowEnd,
    workspaceId: pack.workspaceId ?? null,
    workspacePath: pack.workspacePath ?? null,
    proposalCount: pack.proposals.length,
    evidenceItemCount: pack.evidenceItemCount,
    statusCounts,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt
  }
}

export function createIntrospectionToolExecutors(
  deps: IntrospectionToolExecutorDeps
): IntrospectionToolExecutors {
  async function executeRun(
    rawArgs: unknown,
    context: IntrospectionToolContext
  ): Promise<McpToolExecutionResult> {
    const tool = 'tw_introspection_run'
    const normalized = sanitizeRunInput(rawArgs, context, deps)
    if ('error' in normalized) return fail(tool, normalized.error)

    const result = deps.runManualIntrospection(normalized)
    return jsonResult({
      ok: true,
      tool,
      runId: result.run.id,
      packId: result.pack.id,
      windowStart: result.pack.windowStart,
      windowEnd: result.pack.windowEnd,
      evidenceCount: result.evidenceCount,
      proposalCount: result.proposalCount,
      pack: summarizePack(result.pack),
      note:
        'Proposal pack created for review. Use tw_introspection_read for details. Apply remains Settings-only in phase 1.'
    })
  }

  async function executeList(
    rawArgs: unknown,
    context: IntrospectionToolContext
  ): Promise<McpToolExecutionResult> {
    const tool = 'tw_introspection_list'
    const args = asRecord(rawArgs)
    const workspaceId =
      optionalText(args.workspaceId, 120) ?? deps.resolveCallerWorkspaceId(context) ?? undefined
    const limitRaw = Number(args.limit)
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 50) : 20

    const packs = deps
      .getMemoryProposalPacks(workspaceId)
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)

    return jsonResult({
      ok: true,
      tool,
      workspaceId: workspaceId ?? null,
      count: packs.length,
      packs: packs.map(summarizePack)
    })
  }

  async function executeRead(rawArgs: unknown): Promise<McpToolExecutionResult> {
    const tool = 'tw_introspection_read'
    const packId = text(asRecord(rawArgs).packId, 120)
    if (!packId) return fail(tool, 'packId is required.')

    const pack = deps.getMemoryProposalPack(packId)
    if (!pack) return fail(tool, `Memory proposal pack not found: ${packId}`)

    return jsonResult({
      ok: true,
      tool,
      pack
    })
  }

  async function executeReview(rawArgs: unknown): Promise<McpToolExecutionResult> {
    const tool = 'tw_introspection_review'
    const args = asRecord(rawArgs)
    const packId = text(args.packId, 120)
    const proposalId = text(args.proposalId, 120)
    if (!packId || !proposalId) {
      return fail(tool, 'packId and proposalId are required.')
    }

    const patch = sanitizeProposalPatch({
      status: args.status,
      reviewNote: args.reviewNote,
      expiresAt: args.expiresAt
    })
    if (Object.keys(patch).length === 0) {
      return fail(
        tool,
        'At least one reviewable field is required: status (approved|rejected|expired), reviewNote, or expiresAt.'
      )
    }

    const updated = deps.updateMemoryProposal(packId, proposalId, patch)
    if (!updated) {
      return fail(tool, `Memory proposal pack or proposal not found: ${packId}/${proposalId}`)
    }

    const proposal = updated.proposals.find((item) => item.id === proposalId) ?? null
    return jsonResult({
      ok: true,
      tool,
      packId,
      proposalId,
      proposal,
      pack: summarizePack(updated),
      note: 'Review status updated. Apply to RepoConventionIndex remains Settings-only in phase 1.'
    })
  }

  return {
    async executeIntrospectionTool(toolName, rawArgs, context) {
      switch (toolName) {
        case 'tw_introspection_run':
          return executeRun(rawArgs, context)
        case 'tw_introspection_list':
          return executeList(rawArgs, context)
        case 'tw_introspection_read':
          return executeRead(rawArgs)
        case 'tw_introspection_review':
          return executeReview(rawArgs)
        default:
          return fail(toolName, `Unknown introspection tool: ${toolName}`)
      }
    }
  }
}

/** Default rolling window helper exposed for tests. */
export function defaultIntrospectionWindow(nowIso: string): { windowStart: string; windowEnd: string } {
  return buildRolling24hWindow(nowIso)
}