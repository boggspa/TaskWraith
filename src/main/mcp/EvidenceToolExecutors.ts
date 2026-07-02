import fs from 'node:fs/promises'
import path from 'node:path'

import {
  buildCoherenceGateResult,
  type BuildCoherenceGateInput,
  type CoherenceGateFileInput
} from '../CoherenceGateModel'
import { assessCompletionClaimSupport } from '../EvidencePackModel'
import { buildPromptTaskContract } from '../PromptTaskNormalizerModel'
import {
  buildRepoConventionIndexSnapshot,
  summarizeRepoConventionIndexScan
} from '../RepoConventionIndexBuilder'
import { buildScopeRadarResult } from '../ScopeRadarModel'
import type {
  CapabilityLedgerSnapshot,
  ChatRecord,
  CompletionClaimSupportAssessment,
  AuditEvidenceRef,
  EvidencePackRecord,
  ProviderId,
  RepoConventionIndexSnapshot
} from '../store/types'
import type { WorkspaceToolContext } from './WorkspaceToolExecutors'

export const EVIDENCE_MCP_TOOL_NAMES = [
  'prompt_task_normalize',
  'scope_radar',
  'repo_convention_scan',
  'coherence_gate_check',
  'evidence_pack_write',
  'completion_claim_check'
] as const

export type EvidenceMcpToolName = (typeof EVIDENCE_MCP_TOOL_NAMES)[number]

export interface EvidenceToolStore {
  getChat: (chatId: string) => ChatRecord | undefined
  getEvidencePacks: (workspaceId?: string) => EvidencePackRecord[]
  saveEvidencePack: (pack: Partial<EvidencePackRecord>) => EvidencePackRecord
  getCapabilityLedgerSnapshot: (workspaceId?: string) => CapabilityLedgerSnapshot
  getRepoConventionIndexes: (workspaceId?: string) => RepoConventionIndexSnapshot[]
  saveRepoConventionIndex: (
    snapshot: Partial<RepoConventionIndexSnapshot>
  ) => RepoConventionIndexSnapshot
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

function arrayArg(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function fileInput(value: unknown): string | CoherenceGateFileInput | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const source = record(value)
  const rawPath = optionalString(source.path) || optionalString(source.file)
  if (!rawPath) return undefined
  return {
    path: rawPath,
    ...(optionalString(source.status)
      ? { status: optionalString(source.status) as CoherenceGateFileInput['status'] }
      : {}),
    ...(typeof source.isPlaceholder === 'boolean'
      ? { isPlaceholder: source.isPlaceholder }
      : {})
  }
}

function fileInputs(...values: unknown[]): Array<string | CoherenceGateFileInput> {
  return values
    .flatMap((value) => arrayArg(value))
    .map(fileInput)
    .filter((item): item is string | CoherenceGateFileInput => Boolean(item))
}

function evidenceRefInput(value: unknown): AuditEvidenceRef | undefined {
  const source = record(value)
  const path = optionalString(source.path)
  if (!path) return undefined
  const line = Number(source.line)
  return {
    path,
    ...(Number.isFinite(line) && line > 0 ? { line: Math.trunc(line) } : {}),
    ...(optionalString(source.note) || optionalString(source.reason)
      ? { note: optionalString(source.note) || optionalString(source.reason) }
      : {})
  }
}

function evidenceRefInputs(value: unknown): AuditEvidenceRef[] {
  return arrayArg(value)
    .map(evidenceRefInput)
    .filter((item): item is AuditEvidenceRef => Boolean(item))
}

function stringInputs(value: unknown): string[] {
  return arrayArg(value)
    .map(optionalString)
    .filter((item): item is string => Boolean(item))
}

function latestRepoConventionIndex(
  store: EvidenceToolStore,
  workspaceId: string
): RepoConventionIndexSnapshot | undefined {
  return [...store.getRepoConventionIndexes(workspaceId)].sort((a, b) =>
    b.generatedAt.localeCompare(a.generatedAt)
  )[0]
}

function gateEvidencePack(args: Record<string, unknown>): BuildCoherenceGateInput['evidencePack'] {
  const input = evidencePackInput(args)
  const capabilityCells = arrayArg(input.capabilityCells) as EvidencePackRecord['capabilityCells']
  const completionClaims = arrayArg(input.completionClaims) as EvidencePackRecord['completionClaims']
  const diffTouchedFiles = fileInputs(input.diffTouchedFiles).map((item) =>
    typeof item === 'string' ? item : item.path
  )
  if (!capabilityCells.length && !completionClaims.length && !diffTouchedFiles.length) return undefined
  return {
    capabilityCells,
    completionClaims,
    diffTouchedFiles
  }
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

const REPO_SCAN_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  'DerivedData',
  '.swiftpm',
  '.gradle',
  'target',
  'out'
])

async function collectRepoConventionFiles(
  workspacePath: string,
  options: { maxFiles: number; includeHidden: boolean }
): Promise<{ files: string[]; truncated: boolean }> {
  const root = path.resolve(workspacePath)
  const files: string[] = []
  const queue: string[] = ['']
  let truncated = false
  while (queue.length > 0) {
    const relativeDir = queue.shift() || ''
    const absoluteDir = path.join(root, relativeDir)
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of entries) {
      if (!options.includeHidden && dirent.name.startsWith('.') && dirent.name !== '.github') {
        continue
      }
      const relativePath = path.posix.join(relativeDir.replace(/\\/g, '/'), dirent.name)
      if (dirent.isDirectory()) {
        if (REPO_SCAN_SKIP_DIRS.has(dirent.name)) {
          files.push(relativePath)
        } else {
          queue.push(relativePath)
        }
      } else if (dirent.isFile()) {
        files.push(relativePath)
      }
      if (files.length >= options.maxFiles) {
        truncated = true
        return { files, truncated }
      }
    }
  }
  return { files, truncated }
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

    if (toolName === 'prompt_task_normalize') {
      const prompt =
        optionalString(args.prompt) ||
        optionalString(args.task) ||
        optionalString(args.userPrompt) ||
        optionalString(args.intent)
      if (!prompt) throw new Error('prompt_task_normalize requires a non-empty prompt.')
      const suppliedConventionIndex = record(args.repoConventionIndex).schemaVersion
        ? (record(args.repoConventionIndex) as unknown as RepoConventionIndexSnapshot)
        : undefined
      const contract = buildPromptTaskContract({
        prompt,
        currentState: optionalString(args.currentState) || optionalString(args.current_state),
        repoConventionIndex:
          suppliedConventionIndex || latestRepoConventionIndex(store, workspace.workspaceId)
      })
      return {
        result: {
          ok: true,
          tool: toolName,
          workspaceId: workspace.workspaceId,
          contract
        },
        isError: false
      }
    }

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

    if (toolName === 'repo_convention_scan') {
      if (!workspace.workspacePath) {
        throw new Error('repo_convention_scan requires an active workspace path.')
      }
      const maxFiles = numberArg(args.maxFiles, 4000, 100, 12000)
      const includeHidden = boolArg(args.includeHidden, false)
      const shouldRecord = boolArg(args.record, true)
      const scan = await collectRepoConventionFiles(workspace.workspacePath, {
        maxFiles,
        includeHidden
      })
      const snapshot = buildRepoConventionIndexSnapshot({
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.workspacePath,
        files: scan.files
      })
      const saved = shouldRecord ? store.saveRepoConventionIndex(snapshot) : undefined
      return {
        result: {
          ok: true,
          tool: toolName,
          recorded: Boolean(saved),
          summary: summarizeRepoConventionIndexScan(saved || snapshot, {
            fileCount: scan.files.length,
            truncated: scan.truncated
          }),
          snapshot: saved || snapshot
        },
        isError: false
      }
    }

    if (toolName === 'coherence_gate_check') {
      const prompt =
        optionalString(args.prompt) ||
        optionalString(args.task) ||
        optionalString(args.userPrompt) ||
        optionalString(args.intent)
      const scopeRadar = record(args.scopeRadar).schemaVersion
        ? (record(args.scopeRadar) as unknown as ReturnType<typeof buildScopeRadarResult>)
        : prompt
          ? buildScopeRadarResult({
              prompt,
              currentState: optionalString(args.currentState) || optionalString(args.current_state)
            })
          : undefined
      const suppliedConventionIndex = record(args.repoConventionIndex).schemaVersion
        ? (record(args.repoConventionIndex) as unknown as RepoConventionIndexSnapshot)
        : undefined
      const gate = buildCoherenceGateResult({
        touchedFiles: fileInputs(args.touchedFiles, args.changedFiles, args.diffTouchedFiles),
        changedFiles: fileInputs(args.changedFiles, args.diffTouchedFiles),
        newFiles: fileInputs(args.newFiles, args.addedFiles),
        placeholderFiles: fileInputs(args.placeholderFiles, args.stubFiles),
        validationEvidenceRefs: evidenceRefInputs(args.validationEvidenceRefs),
        validationCommands: stringInputs(args.validationCommands),
        evidencePack: gateEvidencePack(args),
        scopeRadar,
        repoConventionIndex:
          suppliedConventionIndex || latestRepoConventionIndex(store, workspace.workspaceId)
      })
      return {
        result: {
          ok: true,
          tool: toolName,
          workspaceId: workspace.workspaceId,
          gate,
          canProceed: gate.status !== 'block',
          shouldReview: gate.status !== 'pass'
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
