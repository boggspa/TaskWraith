import { assessCompletionClaimSupport } from '../EvidencePackModel'
import { buildScopeRadarResult } from '../ScopeRadarModel'
import type {
  CapabilityLedgerSnapshot,
  ChatRecord,
  CompletionClaimSupportAssessment,
  EvidencePackRecord,
  ProviderId
} from '../store/types'
import type { WorkspaceToolContext } from './WorkspaceToolExecutors'

export const EVIDENCE_MCP_TOOL_NAMES = [
  'scope_radar',
  'evidence_pack_write',
  'completion_claim_check'
] as const

export type EvidenceMcpToolName = (typeof EVIDENCE_MCP_TOOL_NAMES)[number]

export interface EvidenceToolStore {
  getChat: (chatId: string) => ChatRecord | undefined
  getEvidencePacks: (workspaceId?: string) => EvidencePackRecord[]
  saveEvidencePack: (pack: Partial<EvidencePackRecord>) => EvidencePackRecord
  getCapabilityLedgerSnapshot: (workspaceId?: string) => CapabilityLedgerSnapshot
}

export interface EvidenceToolMetadata {
  provider: ProviderId
  runId?: string
}

interface EvidenceWorkspace {
  workspaceId: string
  workspacePath?: string
  chatId?: string
}

export function isEvidenceMcpToolName(value: string): value is EvidenceMcpToolName {
  return (EVIDENCE_MCP_TOOL_NAMES as readonly string[]).includes(value)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function resolveEvidenceWorkspace(
  store: EvidenceToolStore,
  args: Record<string, unknown>,
  context: WorkspaceToolContext
): EvidenceWorkspace {
  if (context.scope !== 'workspace') {
    throw new Error('Evidence Pack tools require an active workspace chat.')
  }
  const chat = context.appChatId ? store.getChat(context.appChatId) : undefined
  const workspaceId = chat?.workspaceId || optionalString(args.workspaceId)
  if (!workspaceId) {
    throw new Error('Evidence Pack tools require a workspace id.')
  }
  const requestedWorkspaceId = optionalString(args.workspaceId)
  if (chat?.workspaceId && requestedWorkspaceId && requestedWorkspaceId !== chat.workspaceId) {
    throw new Error('Evidence Pack workspace must match the active chat workspace.')
  }
  return {
    workspaceId,
    workspacePath: chat?.workspacePath || context.workspacePath || optionalString(args.workspacePath),
    chatId: chat?.appChatId || context.appChatId
  }
}

function evidencePackInput(args: Record<string, unknown>): Record<string, unknown> {
  const source = record(args.pack)
  const input = Object.keys(source).length > 0 ? source : args
  return {
    ...input,
    mapEntries: input.mapEntries ?? input.capabilityMap ?? input.scopeMap,
    capabilityCells: input.capabilityCells ?? input.cells,
    completionClaims: input.completionClaims ?? input.claims,
    diffTouchedFiles: input.diffTouchedFiles ?? input.changedFiles ?? input.touchedFiles
  }
}

function finalTextFromArgs(args: Record<string, unknown>): string | undefined {
  const pack = record(args.pack)
  return (
    optionalString(args.finalText) ||
    optionalString(args.finalAnswer) ||
    optionalString(args.response) ||
    optionalString(pack.finalText) ||
    optionalString(pack.finalAnswer) ||
    optionalString(pack.response)
  )
}

function boolArg(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false
  }
  return fallback
}

function summarizeLedger(snapshot: CapabilityLedgerSnapshot) {
  return {
    workspaceId: snapshot.workspaceId,
    generatedAt: snapshot.generatedAt,
    capabilityCount: snapshot.cells.length,
    mapEntryCount: snapshot.mapEntries.length,
    totalCompletionClaims: snapshot.totalCompletionClaims,
    unsupportedCompletionClaims: snapshot.unsupportedCompletionClaims,
    unsupportedCompletionClaimRate: snapshot.unsupportedCompletionClaimRate,
    stallSignals: snapshot.stallSignals
  }
}

function completionCheckResult(
  assessment: CompletionClaimSupportAssessment
): Record<string, unknown> {
  return {
    assessment,
    shouldRevise:
      assessment.status === 'unsupported' || assessment.status === 'partial',
    canClaimComplete: assessment.status === 'supported'
  }
}

export function createEvidenceToolExecutors(store: EvidenceToolStore) {
  return {
    executeEvidenceMcpTool: (
      toolName: EvidenceMcpToolName,
      args: Record<string, unknown>,
      context: WorkspaceToolContext,
      metadata: EvidenceToolMetadata
    ) => executeEvidenceMcpTool(store, toolName, args, context, metadata)
  }
}

export async function executeEvidenceMcpTool(
  store: EvidenceToolStore,
  toolName: EvidenceMcpToolName,
  args: Record<string, unknown>,
  context: WorkspaceToolContext,
  metadata: EvidenceToolMetadata
): Promise<{ result: unknown; isError: boolean }> {
  try {
    const workspace = resolveEvidenceWorkspace(store, args, context)

    if (toolName === 'scope_radar') {
      const prompt =
        optionalString(args.prompt) ||
        optionalString(args.task) ||
        optionalString(args.userPrompt) ||
        optionalString(args.intent)
      if (!prompt) throw new Error('scope_radar requires a non-empty prompt.')
      const radar = buildScopeRadarResult({
        prompt,
        currentState: optionalString(args.currentState) || optionalString(args.current_state)
      })
      const shouldRecord = boolArg(args.record, true)
      const recordedEvidencePack = shouldRecord
        ? store.saveEvidencePack({
            title: radar.title,
            workspaceId: workspace.workspaceId,
            workspacePath: workspace.workspacePath,
            chatId: workspace.chatId,
            runId: metadata.runId,
            provider: metadata.provider,
            mapEntries: radar.evidencePackDraft.mapEntries,
            capabilityCells: radar.evidencePackDraft.capabilityCells,
            completionClaims: radar.evidencePackDraft.completionClaims,
            diffTouchedFiles: radar.evidencePackDraft.diffTouchedFiles
          })
        : undefined
      const ledger = shouldRecord ? store.getCapabilityLedgerSnapshot(workspace.workspaceId) : undefined
      return {
        result: {
          ok: true,
          tool: toolName,
          radar,
          recorded: Boolean(recordedEvidencePack),
          ...(recordedEvidencePack ? { evidencePack: recordedEvidencePack } : {}),
          ...(ledger ? { ledger: summarizeLedger(ledger) } : {})
        },
        isError: false
      }
    }

    if (toolName === 'evidence_pack_write') {
      const input = evidencePackInput(args)
      const saved = store.saveEvidencePack({
        ...input,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        chatId: workspace.chatId,
        runId: metadata.runId || optionalString(input.runId),
        provider: metadata.provider
      })
      const ledger = store.getCapabilityLedgerSnapshot(workspace.workspaceId)
      const finalText = finalTextFromArgs(args)
      const assessment = finalText
        ? assessCompletionClaimSupport(finalText, store.getEvidencePacks(workspace.workspaceId), {
            workspaceId: workspace.workspaceId,
            chatId: workspace.chatId,
            runId: saved.runId
          })
        : undefined
      return {
        result: {
          ok: true,
          tool: toolName,
          evidencePack: saved,
          ledger: summarizeLedger(ledger),
          ...(assessment ? completionCheckResult(assessment) : {})
        },
        isError: false
      }
    }

    if (toolName === 'completion_claim_check') {
      const finalText = finalTextFromArgs(args)
      if (!finalText) throw new Error('completion_claim_check requires finalText or finalAnswer.')
      const runId = optionalString(args.runId) || metadata.runId
      const chatId = optionalString(args.chatId) || workspace.chatId
      const assessment = assessCompletionClaimSupport(
        finalText,
        store.getEvidencePacks(workspace.workspaceId),
        {
          workspaceId: workspace.workspaceId,
          chatId,
          runId
        }
      )
      return {
        result: {
          ok: true,
          tool: toolName,
          workspaceId: workspace.workspaceId,
          chatId,
          runId,
          ...completionCheckResult(assessment)
        },
        isError: false
      }
    }

    return {
      result: { ok: false, error: `Unknown evidence tool: ${toolName}` },
      isError: true
    }
  } catch (error) {
    return {
      result: {
        ok: false,
        tool: toolName,
        error: error instanceof Error ? error.message : String(error)
      },
      isError: true
    }
  }
}
