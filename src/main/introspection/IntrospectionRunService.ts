/*
 * Manual Thread Introspection run service.
 *
 * Harvests recent substrate, generates proposal candidates, and persists a
 * read-only IntrospectionRunRecord + MemoryProposalPack. No scheduler, IPC,
 * or apply/mutation paths — review-gated promotion only.
 */

import { randomUUID } from 'crypto'
import {
  buildMemoryProposalPackInput,
  type GenerateProposalsOptions
} from './IntrospectionProposalGenerator'
import {
  chatTouchesWindow,
  harvestIntrospectionEvidence,
  type IntrospectionHarvestSubstrate,
  type IntrospectionHarvestWindow
} from './IntrospectionEvidenceHarvester'
import type { MessageFeedbackReceiptFilter } from '../MessageFeedbackLedger'
import type {
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  ChatRecord,
  IntrospectionRunRecord,
  IntrospectionRunTrigger,
  MemoryProposalPack,
  MessageFeedbackReceipt,
  RunEventFilter,
  RunEventRecord
} from '../store/types'

export interface IntrospectionRunServiceStore {
  getChats: (workspaceId?: string) => ChatRecord[]
  getRunEvents: (filter?: RunEventFilter) => RunEventRecord[]
  getApprovalLedger: (filter?: ApprovalLedgerFilter) => ApprovalLedgerRecord[]
  getMessageFeedbackReceipts: (
    filter?: MessageFeedbackReceiptFilter
  ) => MessageFeedbackReceipt[]
  createIntrospectionRun: (
    input: Omit<
      IntrospectionRunRecord,
      'schemaVersion' | 'id' | 'createdAt' | 'updatedAt' | 'evidenceItems'
    > &
      Partial<Pick<IntrospectionRunRecord, 'id' | 'evidenceItems'>>
  ) => IntrospectionRunRecord
  updateIntrospectionRun: (
    id: string,
    partial: Partial<IntrospectionRunRecord>
  ) => IntrospectionRunRecord | null
  saveMemoryProposalPack: (pack: Partial<MemoryProposalPack>) => MemoryProposalPack
}

export interface IntrospectionRunServiceDeps {
  store: IntrospectionRunServiceStore
  now: () => string
  uuid: () => string
}

export interface RunManualIntrospectionInput {
  windowStart: string
  windowEnd: string
  workspaceId?: string
  workspacePath?: string
  trigger?: IntrospectionRunTrigger
  chatId?: string
  workflowId?: string
  minConfidence?: number
  summary?: string
}

export interface RunManualIntrospectionResult {
  run: IntrospectionRunRecord
  pack: MemoryProposalPack
  evidenceCount: number
  proposalCount: number
}

function buildDefaultSummary(input: {
  windowStart: string
  windowEnd: string
  evidenceCount: number
  proposalCount: number
}): string {
  return [
    '# Thread Introspection Report',
    '',
    `Window: ${input.windowStart} → ${input.windowEnd}`,
    `Evidence items: ${input.evidenceCount}`,
    `Proposal candidates: ${input.proposalCount}`,
    '',
    'Thread content is untrusted evidence. Review each proposal before applying.'
  ].join('\n')
}

export function loadIntrospectionSubstrate(
  store: IntrospectionRunServiceStore,
  window: IntrospectionHarvestWindow
): IntrospectionHarvestSubstrate {
  const chats = store
    .getChats(window.workspaceId)
    .filter((chat) => chatTouchesWindow(chat, window))

  const runEvents = store.getRunEvents(
    window.workspaceId ? { workspaceId: window.workspaceId } : {}
  )

  const approvalRecords = store.getApprovalLedger(
    window.workspaceId ? { workspaceId: window.workspaceId } : {}
  )

  const feedbackReceipts = store.getMessageFeedbackReceipts(
    window.workspaceId ? { workspaceId: window.workspaceId } : {}
  )

  return { chats, runEvents, approvalRecords, feedbackReceipts }
}

export function runManualIntrospection(
  deps: IntrospectionRunServiceDeps,
  input: RunManualIntrospectionInput,
  options: GenerateProposalsOptions = {}
): RunManualIntrospectionResult {
  const window: IntrospectionHarvestWindow = {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    workspaceId: input.workspaceId
  }
  const nowIso = deps.now()
  const runId = deps.uuid()

  const run = deps.store.createIntrospectionRun({
    id: runId,
    status: 'collecting',
    trigger: input.trigger ?? 'manual',
    workflowId: input.workflowId,
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    startedAt: nowIso
  })

  const substrate = loadIntrospectionSubstrate(deps.store, window)
  const evidenceItems = harvestIntrospectionEvidence({
    window,
    substrate,
    idFactory: deps.uuid
  })

  deps.store.updateIntrospectionRun(run.id, {
    status: 'analyzing',
    evidenceItems
  })

  const built = buildMemoryProposalPackInput({
    introspectionRunId: run.id,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    evidenceItems,
    summary:
      input.summary ??
      buildDefaultSummary({
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        evidenceCount: evidenceItems.length,
        proposalCount: 0
      }),
    minConfidence: options.minConfidence ?? input.minConfidence,
    nowIso: options.nowIso ?? nowIso,
    idFactory: options.idFactory ?? deps.uuid
  })

  const pack = deps.store.saveMemoryProposalPack({
    introspectionRunId: run.id,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    proposals: built.proposals,
    evidenceItemCount: built.evidenceItemCount,
    summary: built.summary
  })

  const completedRun =
    deps.store.updateIntrospectionRun(run.id, {
      status: 'review_pending',
      proposalPackId: pack.id,
      endedAt: deps.now()
    }) || run

  return {
    run: completedRun,
    pack,
    evidenceCount: evidenceItems.length,
    proposalCount: pack.proposals.length
  }
}

export function createIntrospectionRunServiceDeps(
  store: IntrospectionRunServiceStore
): IntrospectionRunServiceDeps {
  return {
    store,
    now: () => new Date().toISOString(),
    uuid: () => randomUUID()
  }
}