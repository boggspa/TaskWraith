import { randomUUID } from 'crypto'
import type { UnattendedElevationAck } from '../../UnattendedPostureGate'
import { WORKFLOW_HISTORY_LIMIT } from '../../ScheduledOccurrenceMutationSemantics'
import { normalizeWorkflowLoopConfig } from '../../WorkflowLoopModel'
import {
  normalizeWorkflowTrigger,
  resolveNextWorkflowRunAt
} from '../../workflows/WorkflowScheduler'
import type {
  ChatWorkflowMode,
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowRunTemplate
} from '../types'
import { pickWorkflowRunTemplateFields } from '../WorkflowRunTemplate'

export function normalizeChatWorkflowMode(value: unknown): ChatWorkflowMode {
  return value === 'plan' ? 'plan' : 'normal'
}

export function normalizeWorkflowExecutionRecord(
  value: unknown,
  workflowId: string
): WorkflowExecutionRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkflowExecutionRecord>
  if (!input.id || typeof input.id !== 'string') return null
  const status = input.status || 'queued'
  if (
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'skipped'
  ) {
    return null
  }
  const now = new Date().toISOString()
  return {
    id: input.id,
    workflowId,
    plannedFor: typeof input.plannedFor === 'string' && input.plannedFor ? input.plannedFor : now,
    status,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : now,
    ...(typeof input.scheduledTaskId === 'string'
      ? { scheduledTaskId: input.scheduledTaskId }
      : {}),
    ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
    ...(typeof input.startedAt === 'string' ? { startedAt: input.startedAt } : {}),
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {})
  }
}

export function normalizeWorkflowTemplate(value: unknown): WorkflowRunTemplate | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown> & Partial<WorkflowRunTemplate>
  if (
    !input.workspaceId ||
    !input.workspacePath ||
    !input.chatId ||
    !input.provider ||
    typeof input.prompt !== 'string'
  ) {
    return null
  }
  return {
    ...pickWorkflowRunTemplateFields(input),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    chatId: input.chatId,
    provider: input.provider,
    prompt: input.prompt,
    displayPrompt: input.displayPrompt,
    selectedModelType: input.selectedModelType || 'default',
    customModel: input.customModel || '',
    approvalMode: input.approvalMode || 'default',
    // Missing/legacy workflow posture is the normal product workflow, not a
    // third authority state. ScheduledTask persistence already canonicalizes
    // the same omission to `normal`; keep the durable template identical so
    // exact workflow-occurrence comparisons do not discard valid elevation.
    workflowMode: normalizeChatWorkflowMode(input.workflowMode),
    // Persisted workflows are unattended authority. Legacy renderer-authored
    // Full Access flags are discarded during every read/normalization.
    sessionTrust: false,
    imageAttachments: Array.isArray(input.imageAttachments) ? input.imageAttachments : [],
    externalPathGrants: input.externalPathGrants,
    geminiWorktree: input.geminiWorktree,
    codexReasoningEffort: input.codexReasoningEffort,
    grokReasoningEffort: input.grokReasoningEffort,
    museReasoningEffort: input.museReasoningEffort,
    ollamaReasoningEffort: input.ollamaReasoningEffort,
    cursorReasoningEffort: input.cursorReasoningEffort,
    antigravityReasoningEffort: input.antigravityReasoningEffort,
    codexServiceTier: input.codexServiceTier,
    claudeFastMode: input.claudeFastMode,
    kimiFastMode: input.kimiFastMode,
    kimiReasoningEffort: input.kimiReasoningEffort,
    cursorFastMode: input.cursorFastMode,
    kimiThinkingEnabled: input.kimiThinkingEnabled,
    runtimeProfileId: input.runtimeProfileId,
    geminiAuthProfileId: input.geminiAuthProfileId,
    handoffSourceRunId: input.handoffSourceRunId,
    kind: input.kind,
    ensembleSnapshot: input.ensembleSnapshot
  }
}

export function normalizeWorkflowDefinitionRecord(
  value: unknown,
  nowMs: number
): WorkflowDefinition | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkflowDefinition>
  const template = normalizeWorkflowTemplate(input.template)
  if (!template) return null
  const nowIso = new Date(nowMs).toISOString()
  const id = typeof input.id === 'string' && input.id ? input.id : randomUUID()
  const trigger = normalizeWorkflowTrigger(input.trigger, nowMs)
  const history = Array.isArray(input.history)
    ? input.history
        .map((item) => normalizeWorkflowExecutionRecord(item, id))
        .filter((item): item is WorkflowExecutionRecord => Boolean(item))
        .slice(-WORKFLOW_HISTORY_LIMIT)
    : []
  const enabled = input.enabled !== false
  const nextRunAt =
    typeof input.nextRunAt === 'string' && input.nextRunAt
      ? input.nextRunAt
      : enabled
        ? resolveNextWorkflowRunAt(trigger, nowMs, nowMs)
        : undefined
  return {
    id,
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : template.prompt.slice(0, 48) || 'Workflow',
    workspaceId: template.workspaceId,
    workspacePath: template.workspacePath,
    enabled,
    trigger,
    template,
    missedRunPolicy: input.missedRunPolicy === 'skip' ? 'skip' : 'coalesce',
    concurrencyPolicy: input.concurrencyPolicy === 'enqueue' ? 'enqueue' : 'skip',
    limits: {
      ...(input.limits || {}),
      maxConsecutiveFailures:
        input.limits?.maxConsecutiveFailures && input.limits.maxConsecutiveFailures > 0
          ? Math.floor(input.limits.maxConsecutiveFailures)
          : 3
    },
    nextRunAt,
    lastRunAt: typeof input.lastRunAt === 'string' ? input.lastRunAt : undefined,
    lastCompletedAt: typeof input.lastCompletedAt === 'string' ? input.lastCompletedAt : undefined,
    lastStatus: input.lastStatus,
    lastError: typeof input.lastError === 'string' ? input.lastError : undefined,
    // Slice 7b — preserve the cached loop summary (the normalizer whitelists fields,
    // and updateWorkflowDefinition re-normalizes, so without this they'd never persist).
    lastRunIterationCount:
      typeof input.lastRunIterationCount === 'number' &&
      Number.isFinite(input.lastRunIterationCount)
        ? Math.max(0, Math.floor(input.lastRunIterationCount))
        : undefined,
    lastRunStopReason:
      typeof input.lastRunStopReason === 'string' ? input.lastRunStopReason : undefined,
    lastRunTokens:
      typeof input.lastRunTokens === 'number' && Number.isFinite(input.lastRunTokens)
        ? Math.max(0, Math.floor(input.lastRunTokens))
        : undefined,
    failureStreak:
      typeof input.failureStreak === 'number' && Number.isFinite(input.failureStreak)
        ? Math.max(0, Math.floor(input.failureStreak))
        : 0,
    activeExecutionId:
      typeof input.activeExecutionId === 'string' ? input.activeExecutionId : undefined,
    history,
    unattendedElevation: normalizeUnattendedElevationAck(input.unattendedElevation),
    loop: normalizeWorkflowLoopConfig(input.loop),
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso
  }
}

/**
 * Structural decode for a persisted unattended-elevation ack. Keeps the blob
 * only when it is shaped like a real ack — level ∈ {safe,default,full_access}
 * and acknowledgedAt/acknowledgedApprovalMode/signature are non-empty strings.
 * The HMAC is NOT verified here (the store has no secret); cryptographic
 * verification happens at dispatch (resolveUnattendedElevation in index.ts). A
 * malformed value decodes to undefined so a hand-edited workflows.json can never
 * smuggle a partial ack past the dispatch verifier as "present".
 */
export function normalizeUnattendedElevationAck(
  value: unknown
): UnattendedElevationAck | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ack = value as Partial<UnattendedElevationAck>
  if (ack.level !== 'safe' && ack.level !== 'default' && ack.level !== 'full_access')
    return undefined
  if (typeof ack.acknowledgedAt !== 'string' || !ack.acknowledgedAt) return undefined
  if (typeof ack.acknowledgedApprovalMode !== 'string' || !ack.acknowledgedApprovalMode)
    return undefined
  if (typeof ack.authorityDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(ack.authorityDigest)) {
    return undefined
  }
  if (typeof ack.signature !== 'string' || !ack.signature) return undefined
  return {
    level: ack.level,
    acknowledgedAt: ack.acknowledgedAt,
    acknowledgedApprovalMode: ack.acknowledgedApprovalMode,
    authorityDigest: ack.authorityDigest,
    signature: ack.signature
  }
}
