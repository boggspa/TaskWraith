import { createHash } from 'node:crypto'
import { isAbsolute, parse as parsePath, resolve as resolvePath } from 'node:path'
import { types as utilTypes } from 'node:util'
import { isDurableScheduledAttachmentRef } from './ScheduledAttachmentDurability'
import type { ScheduledOccurrenceAuthorityRoot } from './ScheduledOccurrenceAuthorityRootStore'
import {
  WAL_V2_MUTATION_VALIDATION_POLICY,
  WORKFLOW_HISTORY_LIMIT,
  scheduledTaskDispatchReceiptIsExact,
  validateScheduledOccurrenceMutationIntent,
  type ScheduledOccurrenceMutationIntent as SharedScheduledOccurrenceMutationIntent,
  type StandaloneScheduledOccurrenceMutationIntent
} from './ScheduledOccurrenceMutationSemantics'
import type {
  RunQueueDispatchReceipt,
  ScheduledOccurrenceSealV2,
  ScheduledTask,
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowLimits,
  WorkflowRunTemplate,
  WorkflowTrigger
} from './store/types'
import {
  safeWorkflowRunFileName,
  type WorkflowRunBudgetBreach,
  type WorkflowRunEvent,
  type WorkflowRunEventKind
} from './WorkflowRunStore'

export const SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION = 2 as const
export const SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES = 64 * 1024 * 1024

const MAX_NESTING_DEPTH = 128
const MAX_CANONICAL_NODES = 1_000_000
const MAX_METADATA_TEXT_LENGTH = 4_096
const ROOT_ID = /^twso-root-v1:[0-9a-f]{64}$/
const LOWER_HEX_256 = /^[0-9a-f]{64}$/
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MUTATION_KINDS = new Set<ScheduledOccurrenceMutationKind>([
  'materialize',
  'claim',
  'settle'
])
const PROJECTION_KINDS = new Set<ScheduledOccurrenceProjectionKind>([
  'standalone',
  'workflow'
])
const WORKFLOW_RUN_EVENT_KINDS = new Set<WorkflowRunEventKind>([
  'materialized',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'budget_breach',
  'stall_settled',
  'harvested',
  'loop_settled'
])

const ENVELOPE_KEYS = ['payload', 'rootId', 'schemaVersion', 'walMac'] as const
const UNSIGNED_ENVELOPE_KEYS = ['payload', 'rootId', 'schemaVersion'] as const
const PAYLOAD_KEYS = [
  'createdAt',
  'identity',
  'kind',
  'ledgerAfter',
  'ledgerBefore',
  'mutationId',
  'projection',
  'taskAfter',
  'taskBefore',
  'workflowAfter',
  'workflowBefore'
] as const
const IDENTITY_KEYS = [
  'executionId',
  'plannedFor',
  'runId',
  'taskId',
  'workflowId'
] as const
const LEDGER_PREFIX_KEYS = [
  'byteLength',
  'eventCount',
  'fileExisted',
  'schemaVersion',
  'sha256',
  'tailSequence'
] as const
const LEDGER_EVENT_KEYS = [
  'breach',
  'costUsd',
  'durationMs',
  'error',
  'iteration',
  'kind',
  'plannedFor',
  'runId',
  'scheduledTaskId',
  'schemaVersion',
  'sequence',
  'stopReason',
  'timestamp',
  'tokens',
  'verdict',
  'workflowExecutionId',
  'workflowId'
] as const
const BREACH_KEYS = ['kind', 'limit', 'observed'] as const
const VERDICT_KEYS = ['decision', 'evidence', 'rationale'] as const
const WORKFLOW_EXECUTION_KEYS = [
  'completedAt',
  'createdAt',
  'error',
  'id',
  'plannedFor',
  'runId',
  'scheduledTaskId',
  'startedAt',
  'status',
  'updatedAt',
  'workflowId'
] as const
const SCHEDULED_TASK_STATUSES = new Set([
  'pending',
  'due',
  'running',
  'completed',
  'failed',
  'cancelled'
])
const WORKFLOW_EXECUTION_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped'
])
const PROVIDER_IDS = new Set(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
const PERMISSION_PRESET_IDS = new Set([
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
])
const WORKFLOW_MODES = new Set(['normal', 'plan'])
const OCCURRENCE_ROOT_OWNERS = new Set(['solo', 'loop-root', 'ensemble-root'])

const SCHEDULED_TASK_FIELDS = {
  id: true,
  workspaceId: true,
  workspacePath: true,
  chatId: true,
  provider: true,
  prompt: true,
  displayPrompt: true,
  selectedModelType: true,
  customModel: true,
  approvalMode: true,
  permissionPresetId: true,
  workflowMode: true,
  sessionTrust: true,
  imageAttachments: true,
  externalPathGrants: true,
  geminiWorktree: true,
  codexReasoningEffort: true,
  codexServiceTier: true,
  claudeReasoningEffort: true,
  claudeFastMode: true,
  kimiFastMode: true,
  kimiReasoningEffort: true,
  kimiThinkingEnabled: true,
  grokReasoningEffort: true,
  cursorReasoningEffort: true,
  cursorFastMode: true,
  runtimeProfileId: true,
  geminiAuthProfileId: true,
  handoffSourceRunId: true,
  runAt: true,
  timezone: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  runId: true,
  permissionPosture: true,
  dispatchReceipt: true,
  occurrenceSeal: true,
  firedAt: true,
  runningSince: true,
  completedAt: true,
  lastError: true,
  workflowId: true,
  workflowExecutionId: true,
  workflowOccurrenceAt: true,
  kind: true,
  ensembleSnapshot: true
} as const satisfies Record<keyof ScheduledTask, true>
const SCHEDULED_TASK_KEYS = Object.keys(SCHEDULED_TASK_FIELDS)

const WORKFLOW_DEFINITION_FIELDS = {
  id: true,
  name: true,
  unattendedElevation: true,
  workspaceId: true,
  workspacePath: true,
  enabled: true,
  trigger: true,
  template: true,
  missedRunPolicy: true,
  concurrencyPolicy: true,
  limits: true,
  loop: true,
  nextRunAt: true,
  lastRunAt: true,
  lastCompletedAt: true,
  lastStatus: true,
  lastError: true,
  lastRunIterationCount: true,
  lastRunStopReason: true,
  lastRunTokens: true,
  failureStreak: true,
  activeExecutionId: true,
  history: true,
  createdAt: true,
  updatedAt: true
} as const satisfies Record<keyof WorkflowDefinition, true>
const WORKFLOW_DEFINITION_KEYS = Object.keys(WORKFLOW_DEFINITION_FIELDS)

const WORKFLOW_TEMPLATE_FIELDS = {
  workspaceId: true,
  workspacePath: true,
  chatId: true,
  provider: true,
  prompt: true,
  displayPrompt: true,
  selectedModelType: true,
  customModel: true,
  approvalMode: true,
  permissionPresetId: true,
  workflowMode: true,
  sessionTrust: true,
  imageAttachments: true,
  externalPathGrants: true,
  geminiWorktree: true,
  codexReasoningEffort: true,
  codexServiceTier: true,
  claudeReasoningEffort: true,
  claudeFastMode: true,
  kimiFastMode: true,
  kimiReasoningEffort: true,
  kimiThinkingEnabled: true,
  grokReasoningEffort: true,
  cursorReasoningEffort: true,
  cursorFastMode: true,
  runtimeProfileId: true,
  geminiAuthProfileId: true,
  handoffSourceRunId: true,
  kind: true,
  ensembleSnapshot: true
} as const satisfies Record<keyof WorkflowRunTemplate, true>
const WORKFLOW_TEMPLATE_KEYS = Object.keys(WORKFLOW_TEMPLATE_FIELDS)

const WORKFLOW_TRIGGER_FIELDS = {
  kind: true,
  runAt: true,
  intervalMs: true,
  startAt: true,
  cronExpression: true,
  timezone: true
} as const satisfies Record<keyof WorkflowTrigger, true>
const WORKFLOW_LIMIT_FIELDS = {
  maxRunsPerDay: true,
  maxConsecutiveFailures: true,
  timeoutSeconds: true,
  maxCostUsd: true,
  maxTokens: true
} as const satisfies Record<keyof WorkflowLimits, true>
const RUN_QUEUE_DISPATCH_RECEIPT_FIELDS = {
  schemaVersion: true,
  generatedAt: true,
  receiptHash: true,
  runId: true,
  provider: true,
  source: true,
  scope: true,
  workspaceId: true,
  chatId: true,
  ensembleParticipantId: true,
  ensembleLaneId: true,
  ensembleRole: true,
  ensembleStageRole: true,
  approvalMode: true,
  workflowMode: true,
  permissionPresetId: true,
  readOnly: true,
  permissionPostureHash: true,
  permissionPostureSignaturePresent: true,
  remoteComposer: true,
  remoteAllowlist: true
} as const satisfies Record<keyof RunQueueDispatchReceipt, true>
const RUN_QUEUE_DISPATCH_RECEIPT_KEYS = Object.keys(RUN_QUEUE_DISPATCH_RECEIPT_FIELDS)
const OCCURRENCE_SEAL_V2_KEYS = [
  'compositeWorkflowAuthorityDigest',
  'issuedAt',
  'ownerRunId',
  'permissionPostureSetHmac',
  'rootId',
  'rootOwner',
  'runtimeProfileSetHmac',
  'schemaVersion',
  'sealMac',
  'taskAuthorityDigest',
  'workspaceRealPath'
] as const satisfies readonly (keyof ScheduledOccurrenceSealV2)[]

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ScheduledOccurrenceMutationKind = 'materialize' | 'claim' | 'settle'
export type ScheduledOccurrenceProjectionKind = 'standalone' | 'workflow'

export interface ScheduledOccurrenceMutationIdentity {
  readonly taskId: string
  readonly workflowId: string | null
  readonly executionId: string | null
  readonly plannedFor: string
  readonly runId: string | null
}

export interface ScheduledOccurrenceMutationLedgerPrefix {
  readonly schemaVersion: 1
  readonly fileExisted: boolean
  readonly sha256: string
  readonly byteLength: number
  readonly eventCount: number
  readonly tailSequence: number
}

interface ScheduledOccurrenceMutationPayloadBase {
  readonly mutationId: string
  readonly createdAt: string
  readonly identity: ScheduledOccurrenceMutationIdentity
  readonly taskAfter: ScheduledTask
}

interface ScheduledOccurrenceStandaloneProjection {
  readonly projection: 'standalone'
  readonly workflowBefore: null
  readonly workflowAfter: null
  readonly ledgerBefore: null
  readonly ledgerAfter: null
}

interface ScheduledOccurrenceWorkflowProjection {
  readonly projection: 'workflow'
  readonly workflowBefore: WorkflowDefinition
  readonly workflowAfter: WorkflowDefinition
}

export type ScheduledOccurrenceMutationWalPayload =
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceStandaloneProjection & {
        readonly kind: 'materialize'
        readonly identity: ScheduledOccurrenceMutationIdentity & { readonly runId: null }
        readonly taskBefore: null
      })
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceStandaloneProjection & {
        readonly kind: 'claim'
        readonly identity: ScheduledOccurrenceMutationIdentity & { readonly runId: string }
        readonly taskBefore: ScheduledTask
        readonly taskAfter: ScheduledTask & { readonly occurrenceSeal: ScheduledOccurrenceSealV2 }
      })
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceStandaloneProjection & {
        readonly kind: 'settle'
        readonly taskBefore: ScheduledTask
      })
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceWorkflowProjection & {
        readonly kind: 'materialize'
        readonly identity: ScheduledOccurrenceMutationIdentity & {
          readonly workflowId: string
          readonly executionId: string
          readonly runId: null
        }
        readonly taskBefore: null
        readonly ledgerBefore: null
        readonly ledgerAfter: null
      })
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceWorkflowProjection & {
        readonly kind: 'claim'
        readonly identity: ScheduledOccurrenceMutationIdentity & {
          readonly workflowId: string
          readonly executionId: string
          readonly runId: string
        }
        readonly taskBefore: ScheduledTask
        readonly taskAfter: ScheduledTask & { readonly occurrenceSeal: ScheduledOccurrenceSealV2 }
        readonly ledgerBefore: ScheduledOccurrenceMutationLedgerPrefix
        readonly ledgerAfter: WorkflowRunEvent
      })
  | (ScheduledOccurrenceMutationPayloadBase &
      ScheduledOccurrenceWorkflowProjection & {
        readonly kind: 'settle'
        readonly identity: ScheduledOccurrenceMutationIdentity & {
          readonly workflowId: string
          readonly executionId: string
        }
        readonly taskBefore: ScheduledTask
        readonly ledgerBefore: ScheduledOccurrenceMutationLedgerPrefix
        readonly ledgerAfter: WorkflowRunEvent
      })

export interface ScheduledOccurrenceMutationWalEnvelopeV2 {
  readonly schemaVersion: typeof SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION
  readonly rootId: string
  readonly payload: ScheduledOccurrenceMutationWalPayload
  readonly walMac: string
}

interface CanonicalizedValue {
  readonly value: JsonValue
  readonly encoded: string
}

/**
 * Encode one mutation intent into its complete root-authenticated journal file.
 * The returned string is the only canonical textual representation accepted by
 * the decoder: key order, number spelling, whitespace, and duplicate-key
 * ambiguities cannot produce a second representation of the same MAC input.
 */
export function encodeScheduledOccurrenceMutationWal(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  payload: ScheduledOccurrenceMutationWalPayload
): string {
  const rootId = requireAuthorityRootId(authorityRoot)
  const canonicalPayload = canonicalizePlainData(payload, 'scheduled occurrence WAL payload')
  assertPayloadShape(canonicalPayload.value, authorityRoot)

  const unsigned = canonicalizePlainData(
    {
      schemaVersion: SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION,
      rootId,
      payload: canonicalPayload.value
    },
    'scheduled occurrence WAL unsigned envelope'
  )
  assertEncodedSize(unsigned.encoded)
  const walMac = authorityRoot.walPayloadMac(Buffer.from(unsigned.encoded, 'utf8'))
  if (!LOWER_HEX_256.test(walMac)) {
    throw new Error('Scheduled occurrence authority returned a non-canonical WAL MAC.')
  }

  const envelope = canonicalizePlainData(
    {
      schemaVersion: SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION,
      rootId,
      payload: canonicalPayload.value,
      walMac
    },
    'scheduled occurrence WAL envelope'
  )
  assertEncodedSize(envelope.encoded)
  return envelope.encoded
}

/**
 * Decode only a schema-v2 journal bound to this exact authority root. Any
 * malformed, non-canonical, foreign-root, or unauthenticated value fails
 * closed. This establishes root integrity plus structural mutation semantics,
 * not current launch authority. Before applying or launching a claimed
 * occurrence, integration must still call
 * `verifyScheduledOccurrenceSealAgainstCurrentContext` against freshly resolved
 * current authority. No task/workflow/ledger projection is applied here.
 */
export function decodeScheduledOccurrenceMutationWal(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  input: unknown
): ScheduledOccurrenceMutationWalPayload | null {
  try {
    const rootId = requireAuthorityRootId(authorityRoot)
    const serialized = serializedInput(input)
    const parsed = parseStrictJson(serialized)
    const canonicalEnvelope = canonicalizePlainData(
      parsed,
      'scheduled occurrence WAL envelope'
    )
    assertEncodedSize(canonicalEnvelope.encoded)
    if (serialized !== canonicalEnvelope.encoded) return null

    const envelope = requirePlainObject(canonicalEnvelope.value, 'WAL envelope')
    assertExactKeys(envelope, ENVELOPE_KEYS, 'WAL envelope')
    if (envelope.schemaVersion !== SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION) {
      return null
    }
    if (envelope.rootId !== rootId || !ROOT_ID.test(rootId)) return null
    if (typeof envelope.walMac !== 'string' || !LOWER_HEX_256.test(envelope.walMac)) {
      return null
    }
    const unsigned = canonicalizePlainData(
      {
        schemaVersion: SCHEDULED_OCCURRENCE_MUTATION_WAL_SCHEMA_VERSION,
        rootId,
        payload: envelope.payload
      },
      'scheduled occurrence WAL unsigned envelope'
    )
    assertExactKeys(
      requirePlainObject(unsigned.value, 'WAL unsigned envelope'),
      UNSIGNED_ENVELOPE_KEYS,
      'WAL unsigned envelope'
    )
    assertEncodedSize(unsigned.encoded)
    const verified = authorityRoot.verifyWalPayloadMac(
      Buffer.from(unsigned.encoded, 'utf8'),
      envelope.walMac
    )
    if (verified !== true) {
      return null
    }

    // Authenticate the exact canonical bytes before interpreting any
    // mutation-specific fields. Plain-data validation above is only the safe
    // parsing/canonicalization boundary; semantic projection checks belong
    // strictly after root authentication.
    assertPayloadShape(envelope.payload, authorityRoot)
    return deepFreeze(envelope.payload) as unknown as ScheduledOccurrenceMutationWalPayload
  } catch {
    return null
  }
}

function assertPayloadShape(
  value: unknown,
  authorityRoot: ScheduledOccurrenceAuthorityRoot
): asserts value is ScheduledOccurrenceMutationWalPayload {
  const payload = requirePlainObject(value, 'WAL payload')
  assertExactKeys(payload, PAYLOAD_KEYS, 'WAL payload')
  const kind = payload.kind
  const projection = payload.projection
  if (typeof kind !== 'string' || !MUTATION_KINDS.has(kind as ScheduledOccurrenceMutationKind)) {
    throw new TypeError('WAL payload kind is invalid.')
  }
  if (
    typeof projection !== 'string' ||
    !PROJECTION_KINDS.has(projection as ScheduledOccurrenceProjectionKind)
  ) {
    throw new TypeError('WAL payload projection is invalid.')
  }
  requireTrimmedText(payload.mutationId, 'mutation id')
  requireCanonicalIso(payload.createdAt, 'mutation createdAt')
  const identity = assertIdentityShape(payload.identity, projection as ScheduledOccurrenceProjectionKind)
  const taskBefore = nullablePlainObject(payload.taskBefore, 'task before-image')
  const taskAfter = requirePlainObject(payload.taskAfter, 'task after-image')
  assertScheduledTaskShape(taskAfter, authorityRoot)
  if (taskBefore) {
    assertScheduledTaskShape(taskBefore, authorityRoot)
  }

  if (kind === 'materialize') {
    if (taskBefore !== null || identity.runId !== null) {
      throw new TypeError('Materialize WAL payload must create an unowned task from null.')
    }
  } else {
    if (taskBefore === null) {
      throw new TypeError('Lifecycle WAL payload requires an exact task before-image.')
    }
    if (kind === 'claim' && identity.runId === null) {
      throw new TypeError('Claim WAL payload requires an exact run owner.')
    }
  }

  if (projection === 'standalone') {
    if (
      payload.workflowBefore !== null ||
      payload.workflowAfter !== null ||
      payload.ledgerBefore !== null ||
      payload.ledgerAfter !== null
    ) {
      throw new TypeError('Standalone WAL payload must carry explicit null workflow projections.')
    }
    const standalonePayload = payload as unknown as ScheduledOccurrenceMutationWalPayload
    assertSharedMutationSemantics(standalonePayload)
    return
  }

  const workflowBefore = requirePlainObject(payload.workflowBefore, 'workflow before-image')
  const workflowAfter = requirePlainObject(payload.workflowAfter, 'workflow after-image')
  assertWorkflowDefinitionShape(workflowBefore)
  assertWorkflowDefinitionShape(workflowAfter)
  if (kind === 'materialize') {
    if (payload.ledgerBefore !== null || payload.ledgerAfter !== null) {
      throw new TypeError('Materialize WAL payload must carry explicit null ledger projections.')
    }
    const materializePayload = payload as unknown as ScheduledOccurrenceMutationWalPayload
    assertSharedMutationSemantics(materializePayload)
    return
  }
  assertLedgerPrefixShape(payload.ledgerBefore)
  assertLedgerEventShape(payload.ledgerAfter)
  const lifecyclePayload = payload as unknown as ScheduledOccurrenceMutationWalPayload
  assertSharedMutationSemantics(lifecyclePayload)
}

function assertIdentityShape(
  value: unknown,
  projection: ScheduledOccurrenceProjectionKind
): ScheduledOccurrenceMutationIdentity {
  const identity = requirePlainObject(value, 'WAL identity')
  assertExactKeys(identity, IDENTITY_KEYS, 'WAL identity')
  requireTrimmedText(identity.taskId, 'identity taskId')
  requireCanonicalIso(identity.plannedFor, 'identity plannedFor')
  if (identity.runId !== null) requireTrimmedText(identity.runId, 'identity runId')
  if (projection === 'standalone') {
    if (identity.workflowId !== null || identity.executionId !== null) {
      throw new TypeError('Standalone WAL identity must carry null workflow identity.')
    }
  } else {
    requireTrimmedText(identity.workflowId, 'identity workflowId')
    requireTrimmedText(identity.executionId, 'identity executionId')
  }
  return identity as unknown as ScheduledOccurrenceMutationIdentity
}

function assertLedgerPrefixShape(
  value: unknown
): asserts value is ScheduledOccurrenceMutationLedgerPrefix {
  const prefix = requirePlainObject(value, 'ledger prefix')
  assertExactKeys(prefix, LEDGER_PREFIX_KEYS, 'ledger prefix')
  const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  if (
    prefix.schemaVersion !== 1 ||
    typeof prefix.fileExisted !== 'boolean' ||
    typeof prefix.sha256 !== 'string' ||
    !LOWER_HEX_256.test(prefix.sha256) ||
    !isNonNegativeSafeInteger(prefix.byteLength) ||
    !isNonNegativeSafeInteger(prefix.eventCount) ||
    !isNonNegativeSafeInteger(prefix.tailSequence) ||
    prefix.tailSequence !== prefix.eventCount ||
    (!prefix.fileExisted && (prefix.byteLength !== 0 || prefix.eventCount !== 0))
    || (prefix.byteLength === 0 && prefix.sha256 !== emptySha256)
    || (prefix.eventCount === 0 && prefix.byteLength !== 0)
    || (prefix.eventCount > 0 && (!prefix.fileExisted || prefix.byteLength === 0))
  ) {
    throw new TypeError('WAL ledger prefix is invalid.')
  }
}

function assertLedgerEventShape(value: unknown): asserts value is WorkflowRunEvent {
  const event = requirePlainObject(value, 'ledger event')
  assertAllowedKeys(event, LEDGER_EVENT_KEYS, 'ledger event')
  requireKeys(
    event,
    ['schemaVersion', 'sequence', 'workflowExecutionId', 'workflowId', 'kind', 'timestamp'],
    'ledger event'
  )
  if (
    event.schemaVersion !== 1 ||
    !isPositiveSafeInteger(event.sequence) ||
    typeof event.kind !== 'string' ||
    !WORKFLOW_RUN_EVENT_KINDS.has(event.kind as WorkflowRunEventKind)
  ) {
    throw new TypeError('WAL ledger event header is invalid.')
  }
  requireTrimmedText(event.workflowExecutionId, 'ledger workflowExecutionId')
  requireTrimmedText(event.workflowId, 'ledger workflowId')
  requireCanonicalIso(event.timestamp, 'ledger timestamp')
  optionalTrimmedText(event.scheduledTaskId, 'ledger scheduledTaskId')
  optionalTrimmedText(event.runId, 'ledger runId')
  if (event.plannedFor !== undefined) requireCanonicalIso(event.plannedFor, 'ledger plannedFor')
  optionalFiniteNumber(event.tokens, 'ledger tokens')
  optionalFiniteNumber(event.costUsd, 'ledger costUsd')
  optionalFiniteNumber(event.durationMs, 'ledger durationMs')
  optionalText(event.error, 'ledger error')
  optionalPositiveSafeInteger(event.iteration, 'ledger iteration')
  optionalText(event.stopReason, 'ledger stopReason')
  if (event.breach !== undefined) assertBreachShape(event.breach)
  if (event.verdict !== undefined) assertVerdictShape(event.verdict)
}

function assertBreachShape(value: unknown): asserts value is WorkflowRunBudgetBreach {
  const breach = requirePlainObject(value, 'ledger breach')
  assertExactKeys(breach, BREACH_KEYS, 'ledger breach')
  if (
    typeof breach.kind !== 'string' ||
    !['tokens', 'cost', 'wallclock'].includes(breach.kind) ||
    typeof breach.limit !== 'number' ||
    !Number.isFinite(breach.limit) ||
    typeof breach.observed !== 'number' ||
    !Number.isFinite(breach.observed)
  ) {
    throw new TypeError('WAL ledger breach is invalid.')
  }
}

function assertVerdictShape(value: unknown): void {
  const verdict = requirePlainObject(value, 'ledger verdict')
  assertAllowedKeys(verdict, VERDICT_KEYS, 'ledger verdict')
  requireKeys(verdict, ['decision'], 'ledger verdict')
  if (
    typeof verdict.decision !== 'string' ||
    !['accept', 'revise', 'reject'].includes(verdict.decision)
  ) {
    throw new TypeError('WAL ledger verdict decision is invalid.')
  }
  optionalText(verdict.evidence, 'ledger verdict evidence')
  optionalText(verdict.rationale, 'ledger verdict rationale')
}

function assertScheduledTaskShape(
  task: Record<string, unknown>,
  authorityRoot: ScheduledOccurrenceAuthorityRoot
): void {
  assertAllowedKeys(task, SCHEDULED_TASK_KEYS, 'scheduled task projection')
  requireKeys(
    task,
    [
      'id',
      'workspaceId',
      'workspacePath',
      'chatId',
      'provider',
      'prompt',
      'selectedModelType',
      'customModel',
      'approvalMode',
      'sessionTrust',
      'imageAttachments',
      'runAt',
      'timezone',
      'status',
      'createdAt',
      'updatedAt',
      'dispatchReceipt'
    ],
    'scheduled task projection'
  )
  assertTaskAuthorityFields(task, 'scheduled task projection')
  requireTrimmedText(task.id, 'scheduled task projection id')
  requireCanonicalIso(task.runAt, 'scheduled task runAt')
  requireCanonicalIso(task.createdAt, 'scheduled task createdAt')
  requireCanonicalIso(task.updatedAt, 'scheduled task updatedAt')
  if (Date.parse(task.createdAt as string) > Date.parse(task.updatedAt as string)) {
    throw new TypeError('Scheduled task timestamps are out of order.')
  }
  requireTrimmedText(task.timezone, 'scheduled task timezone')
  if (typeof task.status !== 'string' || !SCHEDULED_TASK_STATUSES.has(task.status)) {
    throw new TypeError('Scheduled task status is invalid.')
  }
  optionalTrimmedText(task.runId, 'scheduled task runId')
  for (const field of [
    'firedAt',
    'runningSince',
    'completedAt',
    'workflowOccurrenceAt'
  ] as const) {
    if (task[field] !== undefined) {
      requireCanonicalIso(task[field], `scheduled task ${field}`)
    }
  }
  optionalTrimmedText(task.workflowId, 'scheduled task workflowId')
  optionalTrimmedText(task.workflowExecutionId, 'scheduled task workflowExecutionId')
  optionalText(task.lastError, 'scheduled task lastError')
  const receipt = requirePlainObject(task.dispatchReceipt, 'scheduled task dispatchReceipt')
  assertAllowedKeys(
    receipt,
    RUN_QUEUE_DISPATCH_RECEIPT_KEYS,
    'scheduled task dispatchReceipt'
  )
  requireCanonicalIso(receipt.generatedAt, 'scheduled task dispatchReceipt generatedAt')
  if (!scheduledTaskDispatchReceiptIsExact(task as unknown as ScheduledTask)) {
    throw new TypeError('Scheduled task dispatch receipt is not canonical.')
  }
  if (task.occurrenceSeal !== undefined) {
    assertOccurrenceSealV2(task.occurrenceSeal, authorityRoot)
  }
}

function assertTaskAuthorityFields(task: Record<string, unknown>, label: string): void {
  for (const field of [
    'workspaceId',
    'workspacePath',
    'chatId',
    'selectedModelType',
    'approvalMode'
  ] as const) {
    requireTrimmedText(task[field], `${label} ${field}`)
  }
  if (typeof task.provider !== 'string' || !PROVIDER_IDS.has(task.provider)) {
    throw new TypeError(`${label} provider is invalid.`)
  }
  if (
    typeof task.prompt !== 'string' ||
    task.prompt.trim().length === 0 ||
    typeof task.customModel !== 'string'
  ) {
    throw new TypeError(`${label} prompt/model fields are invalid.`)
  }
  if (task.sessionTrust !== false) {
    throw new TypeError(`${label} sessionTrust is invalid.`)
  }
  if (
    !Array.isArray(task.imageAttachments) ||
    !task.imageAttachments.every((attachment) => {
      if (!isDurableScheduledAttachmentRef(attachment)) return false
      const record = requirePlainObject(attachment, `${label} attachment`)
      assertExactKeys(
        record,
        ['byteLength', 'id', 'mimeType', 'name', 'path', 'persistenceVersion', 'sha256'],
        `${label} attachment`
      )
      return true
    })
  ) {
    throw new TypeError(`${label} attachments are not durable snapshots.`)
  }
  optionalText(task.displayPrompt, `${label} displayPrompt`)
  if (
    task.permissionPresetId !== undefined &&
    (typeof task.permissionPresetId !== 'string' ||
      !PERMISSION_PRESET_IDS.has(task.permissionPresetId))
  ) {
    throw new TypeError(`${label} permissionPresetId is invalid.`)
  }
  if (
    task.workflowMode !== undefined &&
    (typeof task.workflowMode !== 'string' || !WORKFLOW_MODES.has(task.workflowMode))
  ) {
    throw new TypeError(`${label} workflowMode is invalid.`)
  }
  for (const field of [
    'codexReasoningEffort',
    'codexServiceTier',
    'claudeReasoningEffort',
    'kimiReasoningEffort',
    'grokReasoningEffort',
    'cursorReasoningEffort',
    'geminiAuthProfileId'
  ] as const) {
    if (task[field] !== undefined && task[field] !== null) {
      requireTrimmedText(task[field], `${label} ${field}`)
    }
  }
  for (const field of [
    'claudeFastMode',
    'kimiFastMode',
    'kimiThinkingEnabled',
    'cursorFastMode'
  ] as const) {
    if (task[field] !== undefined && typeof task[field] !== 'boolean') {
      throw new TypeError(`${label} ${field} is invalid.`)
    }
  }
  for (const field of ['runtimeProfileId', 'handoffSourceRunId'] as const) {
    optionalTrimmedText(task[field], `${label} ${field}`)
  }
  if (task.externalPathGrants !== undefined && !Array.isArray(task.externalPathGrants)) {
    throw new TypeError(`${label} externalPathGrants is invalid.`)
  }
  if (task.geminiWorktree !== undefined) {
    const worktree = requirePlainObject(task.geminiWorktree, `${label} geminiWorktree`)
    assertAllowedKeys(worktree, ['effectivePath', 'enabled', 'name'], `${label} geminiWorktree`)
    if (typeof worktree.enabled !== 'boolean') {
      throw new TypeError(`${label} geminiWorktree enabled is invalid.`)
    }
    optionalText(worktree.name, `${label} geminiWorktree name`)
    optionalText(worktree.effectivePath, `${label} geminiWorktree effectivePath`)
  }
  if (task.kind !== undefined && task.kind !== 'single' && task.kind !== 'ensemble') {
    throw new TypeError(`${label} kind is invalid.`)
  }
  if (task.kind === 'ensemble' && task.ensembleSnapshot === undefined) {
    throw new TypeError(`${label} ensemble task lacks its snapshot.`)
  }
  if (task.kind !== 'ensemble' && task.ensembleSnapshot !== undefined) {
    throw new TypeError(`${label} single task contains an ensemble snapshot.`)
  }
}

function assertWorkflowTriggerShape(value: unknown): asserts value is WorkflowTrigger {
  const trigger = requirePlainObject(value, 'workflow trigger')
  requireKeys(trigger, ['kind'], 'workflow trigger')
  if (trigger.kind === 'manual') {
    assertExactKeys(trigger, ['kind'], 'manual workflow trigger')
    return
  }
  if (trigger.kind === 'once') {
    assertAllowedKeys(trigger, ['kind', 'runAt', 'timezone'], 'once workflow trigger')
    requireKeys(trigger, ['kind', 'runAt'], 'once workflow trigger')
    requireCanonicalIso(trigger.runAt, 'once workflow runAt')
    optionalText(trigger.timezone, 'once workflow timezone')
    return
  }
  if (trigger.kind === 'interval') {
    assertAllowedKeys(
      trigger,
      ['intervalMs', 'kind', 'startAt', 'timezone'],
      'interval workflow trigger'
    )
    requireKeys(trigger, ['intervalMs', 'kind', 'startAt'], 'interval workflow trigger')
    if (!isPositiveSafeInteger(trigger.intervalMs) || trigger.intervalMs < 60_000) {
      throw new TypeError('Interval workflow cadence is invalid.')
    }
    requireCanonicalIso(trigger.startAt, 'interval workflow startAt')
    optionalText(trigger.timezone, 'interval workflow timezone')
    return
  }
  if (trigger.kind === 'cron') {
    assertAllowedKeys(
      trigger,
      ['cronExpression', 'kind', 'timezone'],
      'cron workflow trigger'
    )
    requireKeys(trigger, ['cronExpression', 'kind'], 'cron workflow trigger')
    if (typeof trigger.cronExpression !== 'string') {
      throw new TypeError('Cron workflow expression is invalid.')
    }
    optionalText(trigger.timezone, 'cron workflow timezone')
    return
  }
  assertAllowedKeys(trigger, Object.keys(WORKFLOW_TRIGGER_FIELDS), 'workflow trigger')
  throw new TypeError('Workflow trigger kind is invalid.')
}

function assertWorkflowLimitsShape(value: unknown): asserts value is WorkflowLimits {
  const limits = requirePlainObject(value, 'workflow limits')
  assertAllowedKeys(limits, Object.keys(WORKFLOW_LIMIT_FIELDS), 'workflow limits')
  for (const field of [
    'maxRunsPerDay',
    'maxConsecutiveFailures',
    'timeoutSeconds',
    'maxTokens'
  ] as const) {
    if (limits[field] !== undefined && !isPositiveSafeInteger(limits[field])) {
      throw new TypeError(`Workflow limit ${field} is invalid.`)
    }
  }
  if (
    limits.maxCostUsd !== undefined &&
    (typeof limits.maxCostUsd !== 'number' ||
      !Number.isFinite(limits.maxCostUsd) ||
      limits.maxCostUsd <= 0)
  ) {
    throw new TypeError('Workflow maxCostUsd is invalid.')
  }
}

function assertUnattendedElevationShape(value: unknown): void {
  const ack = requirePlainObject(value, 'workflow unattended elevation')
  assertAllowedKeys(
    ack,
    ['acknowledgedApprovalMode', 'acknowledgedAt', 'authorityDigest', 'level', 'signature'],
    'workflow unattended elevation'
  )
  requireKeys(
    ack,
    ['acknowledgedApprovalMode', 'acknowledgedAt', 'authorityDigest', 'level'],
    'workflow unattended elevation'
  )
  if (
    typeof ack.level !== 'string' ||
    !['safe', 'default', 'full_access'].includes(ack.level)
  ) {
    throw new TypeError('Workflow unattended elevation level is invalid.')
  }
  requireCanonicalIso(ack.acknowledgedAt, 'workflow unattended elevation acknowledgedAt')
  requireTrimmedText(
    ack.acknowledgedApprovalMode,
    'workflow unattended elevation acknowledgedApprovalMode'
  )
  if (typeof ack.authorityDigest !== 'string' || !LOWER_HEX_256.test(ack.authorityDigest)) {
    throw new TypeError('Workflow unattended elevation authorityDigest is invalid.')
  }
  optionalTrimmedText(ack.signature, 'workflow unattended elevation signature')
}

function assertWorkflowLoopShape(value: unknown): void {
  const loop = requirePlainObject(value, 'workflow loop')
  assertExactKeys(loop, ['acceptance', 'limits'], 'workflow loop')
  const acceptance = requirePlainObject(loop.acceptance, 'workflow loop acceptance')
  assertAllowedKeys(acceptance, ['maxIterations', 'verifier'], 'workflow loop acceptance')
  requireKeys(acceptance, ['maxIterations'], 'workflow loop acceptance')
  if (!isPositiveSafeInteger(acceptance.maxIterations)) {
    throw new TypeError('Workflow loop maxIterations is invalid.')
  }
  if (acceptance.verifier !== undefined) {
    const verifier = requirePlainObject(acceptance.verifier, 'workflow loop verifier')
    assertAllowedKeys(verifier, ['provider'], 'workflow loop verifier')
    if (
      verifier.provider !== undefined &&
      (typeof verifier.provider !== 'string' || !PROVIDER_IDS.has(verifier.provider))
    ) {
      throw new TypeError('Workflow loop verifier provider is invalid.')
    }
  }
  const limits = requirePlainObject(loop.limits, 'workflow loop limits')
  assertAllowedKeys(limits, ['maxCostUsd', 'maxRuns', 'maxTokens'], 'workflow loop limits')
  requireKeys(limits, ['maxRuns'], 'workflow loop limits')
  if (!isPositiveSafeInteger(limits.maxRuns)) {
    throw new TypeError('Workflow loop maxRuns is invalid.')
  }
  if (limits.maxTokens !== undefined && !isPositiveSafeInteger(limits.maxTokens)) {
    throw new TypeError('Workflow loop maxTokens is invalid.')
  }
  if (
    limits.maxCostUsd !== undefined &&
    (typeof limits.maxCostUsd !== 'number' ||
      !Number.isFinite(limits.maxCostUsd) ||
      limits.maxCostUsd <= 0)
  ) {
    throw new TypeError('Workflow loop maxCostUsd is invalid.')
  }
}

function assertOccurrenceSealV2(
  value: unknown,
  authorityRoot: ScheduledOccurrenceAuthorityRoot
): asserts value is ScheduledOccurrenceSealV2 {
  const seal = requirePlainObject(value, 'scheduled task occurrenceSeal')
  assertExactKeys(seal, OCCURRENCE_SEAL_V2_KEYS, 'scheduled task occurrenceSeal')
  const rootId = requireAuthorityRootId(authorityRoot)
  if (
    seal.schemaVersion !== 2 ||
    seal.rootId !== rootId ||
    typeof seal.ownerRunId !== 'string' ||
    !OCCURRENCE_ROOT_OWNERS.has(String(seal.rootOwner)) ||
    typeof seal.taskAuthorityDigest !== 'string' ||
    !LOWER_HEX_256.test(seal.taskAuthorityDigest) ||
    (seal.compositeWorkflowAuthorityDigest !== null &&
      (typeof seal.compositeWorkflowAuthorityDigest !== 'string' ||
        !LOWER_HEX_256.test(seal.compositeWorkflowAuthorityDigest))) ||
    typeof seal.runtimeProfileSetHmac !== 'string' ||
    !LOWER_HEX_256.test(seal.runtimeProfileSetHmac) ||
    typeof seal.permissionPostureSetHmac !== 'string' ||
    !LOWER_HEX_256.test(seal.permissionPostureSetHmac) ||
    typeof seal.sealMac !== 'string' ||
    !LOWER_HEX_256.test(seal.sealMac)
  ) {
    throw new TypeError('Scheduled task occurrenceSeal is malformed.')
  }
  requireTrimmedText(seal.ownerRunId, 'scheduled task occurrenceSeal ownerRunId')
  requireCanonicalIso(seal.issuedAt, 'scheduled task occurrenceSeal issuedAt')
  if (
    typeof seal.workspaceRealPath !== 'string' ||
    seal.workspaceRealPath.length === 0 ||
    seal.workspaceRealPath.length > MAX_METADATA_TEXT_LENGTH ||
    seal.workspaceRealPath.includes('\0') ||
    !isAbsolute(seal.workspaceRealPath) ||
    resolvePath(seal.workspaceRealPath) !== seal.workspaceRealPath ||
    parsePath(seal.workspaceRealPath).root === seal.workspaceRealPath
  ) {
    throw new TypeError('Scheduled task occurrenceSeal workspaceRealPath is invalid.')
  }
  const unsignedSeal = canonicalizePlainData(
    {
      schemaVersion: 2,
      rootId: seal.rootId,
      issuedAt: seal.issuedAt,
      ownerRunId: seal.ownerRunId,
      rootOwner: seal.rootOwner,
      taskAuthorityDigest: seal.taskAuthorityDigest,
      compositeWorkflowAuthorityDigest: seal.compositeWorkflowAuthorityDigest,
      workspaceRealPath: seal.workspaceRealPath,
      runtimeProfileSetHmac: seal.runtimeProfileSetHmac,
      permissionPostureSetHmac: seal.permissionPostureSetHmac
    },
    'scheduled task occurrenceSeal payload'
  )
  if (
    authorityRoot.verifySealPayloadMac(
      Buffer.from(unsignedSeal.encoded, 'utf8'),
      seal.sealMac
    ) !== true
  ) {
    throw new TypeError('Scheduled task occurrenceSeal MAC is invalid.')
  }
}

function assertWorkflowDefinitionShape(
  workflow: Record<string, unknown>
): void {
  assertAllowedKeys(workflow, WORKFLOW_DEFINITION_KEYS, 'workflow projection')
  requireKeys(
    workflow,
    [
      'id',
      'name',
      'workspaceId',
      'workspacePath',
      'enabled',
      'trigger',
      'template',
      'missedRunPolicy',
      'concurrencyPolicy',
      'limits',
      'failureStreak',
      'history',
      'createdAt',
      'updatedAt'
    ],
    'workflow projection'
  )
  for (const field of ['id', 'name', 'workspaceId', 'workspacePath'] as const) {
    requireTrimmedText(workflow[field], `workflow ${field}`)
  }
  if (typeof workflow.enabled !== 'boolean') throw new TypeError('Workflow enabled is invalid.')
  assertWorkflowTriggerShape(workflow.trigger)
  assertWorkflowLimitsShape(workflow.limits)
  const template = requirePlainObject(workflow.template, 'workflow template')
  assertAllowedKeys(template, WORKFLOW_TEMPLATE_KEYS, 'workflow template')
  requireKeys(
    template,
    [
      'workspaceId',
      'workspacePath',
      'chatId',
      'provider',
      'prompt',
      'selectedModelType',
      'customModel',
      'approvalMode',
      'sessionTrust',
      'imageAttachments'
    ],
    'workflow template'
  )
  assertTaskAuthorityFields(template, 'workflow template')
  if (
    typeof workflow.missedRunPolicy !== 'string' ||
    !['coalesce', 'skip'].includes(workflow.missedRunPolicy)
  ) {
    throw new TypeError('Workflow missed-run policy is invalid.')
  }
  if (
    typeof workflow.concurrencyPolicy !== 'string' ||
    !['skip', 'enqueue'].includes(workflow.concurrencyPolicy)
  ) {
    throw new TypeError('Workflow concurrency policy is invalid.')
  }
  if (!isNonNegativeSafeInteger(workflow.failureStreak)) {
    throw new TypeError('Workflow failure streak is invalid.')
  }
  requireCanonicalIso(workflow.createdAt, 'workflow createdAt')
  requireCanonicalIso(workflow.updatedAt, 'workflow updatedAt')
  if (Date.parse(workflow.createdAt as string) > Date.parse(workflow.updatedAt as string)) {
    throw new TypeError('Workflow timestamps are out of order.')
  }
  for (const field of ['nextRunAt', 'lastRunAt', 'lastCompletedAt'] as const) {
    if (workflow[field] !== undefined) requireCanonicalIso(workflow[field], `workflow ${field}`)
  }
  optionalTrimmedText(workflow.activeExecutionId, 'workflow activeExecutionId')
  optionalText(workflow.lastError, 'workflow lastError')
  optionalText(workflow.lastRunStopReason, 'workflow lastRunStopReason')
  for (const field of ['lastRunIterationCount', 'lastRunTokens'] as const) {
    if (workflow[field] !== undefined && !isNonNegativeSafeInteger(workflow[field])) {
      throw new TypeError(`Workflow ${field} is invalid.`)
    }
  }
  if (
    workflow.lastStatus !== undefined &&
    (typeof workflow.lastStatus !== 'string' ||
      !WORKFLOW_EXECUTION_STATUSES.has(workflow.lastStatus))
  ) {
    throw new TypeError('Workflow lastStatus is invalid.')
  }
  if (!Array.isArray(workflow.history) || workflow.history.length > WORKFLOW_HISTORY_LIMIT) {
    throw new TypeError('Workflow history is invalid.')
  }
  const executionIds = new Set<string>()
  for (const value of workflow.history) {
    assertWorkflowExecutionShape(value)
    const execution = value as WorkflowExecutionRecord
    if (execution.workflowId !== workflow.id || executionIds.has(execution.id)) {
      throw new TypeError('Workflow history contains foreign or duplicate execution identity.')
    }
    executionIds.add(execution.id)
  }
  if (
    workflow.activeExecutionId !== undefined &&
    !executionIds.has(workflow.activeExecutionId as string)
  ) {
    throw new TypeError('Workflow active execution is absent from its history.')
  }
  if (workflow.unattendedElevation !== undefined) {
    assertUnattendedElevationShape(workflow.unattendedElevation)
  }
  if (workflow.loop !== undefined) assertWorkflowLoopShape(workflow.loop)
}

function assertWorkflowExecutionShape(
  value: unknown
): asserts value is WorkflowExecutionRecord {
  const execution = requirePlainObject(value, 'workflow execution')
  assertAllowedKeys(execution, WORKFLOW_EXECUTION_KEYS, 'workflow execution')
  requireKeys(
    execution,
    ['id', 'workflowId', 'plannedFor', 'status', 'createdAt', 'updatedAt'],
    'workflow execution'
  )
  const executionId = requireTrimmedText(execution.id, 'workflow execution id')
  if (safeWorkflowRunFileName(executionId) !== `${executionId}.jsonl`) {
    throw new TypeError('Workflow execution id is not injective in the ledger filename domain.')
  }
  requireTrimmedText(execution.workflowId, 'workflow execution workflowId')
  requireCanonicalIso(execution.plannedFor, 'workflow execution plannedFor')
  const createdAt = requireCanonicalIso(execution.createdAt, 'workflow execution createdAt')
  const updatedAt = requireCanonicalIso(execution.updatedAt, 'workflow execution updatedAt')
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new TypeError('Workflow execution timestamps are out of order.')
  }
  if (
    typeof execution.status !== 'string' ||
    !WORKFLOW_EXECUTION_STATUSES.has(execution.status)
  ) {
    throw new TypeError('Workflow execution status is invalid.')
  }
  optionalTrimmedText(execution.scheduledTaskId, 'workflow execution scheduledTaskId')
  optionalTrimmedText(execution.runId, 'workflow execution runId')
  if (execution.startedAt !== undefined) {
    requireCanonicalIso(execution.startedAt, 'workflow execution startedAt')
  }
  if (execution.completedAt !== undefined) {
    requireCanonicalIso(execution.completedAt, 'workflow execution completedAt')
  }
  optionalText(execution.error, 'workflow execution error')
}

function sharedMutationIntent(
  payload: ScheduledOccurrenceMutationWalPayload
): SharedScheduledOccurrenceMutationIntent | StandaloneScheduledOccurrenceMutationIntent {
  const identity = {
    taskId: payload.identity.taskId,
    plannedFor: payload.identity.plannedFor,
    ...(payload.identity.runId !== null ? { runId: payload.identity.runId } : {})
  }
  if (payload.projection === 'standalone') {
    return {
      schemaVersion: 1,
      id: payload.mutationId,
      kind: payload.kind,
      createdAt: payload.createdAt,
      identity,
      taskBefore: payload.taskBefore,
      taskAfter: payload.taskAfter,
      workflowBefore: null,
      workflowAfter: null,
      ledgerBefore: null,
      ledgerAfter: null
    }
  }
  return {
    schemaVersion: 1,
    id: payload.mutationId,
    kind: payload.kind,
    createdAt: payload.createdAt,
    identity: {
      ...identity,
      workflowId: payload.identity.workflowId,
      executionId: payload.identity.executionId
    },
    taskBefore: payload.taskBefore,
    taskAfter: payload.taskAfter,
    workflowBefore: payload.workflowBefore,
    workflowAfter: payload.workflowAfter,
    ledgerBefore: payload.ledgerBefore,
    ledgerAfter: payload.ledgerAfter
  }
}

function assertSharedMutationSemantics(payload: ScheduledOccurrenceMutationWalPayload): void {
  const invalidReason = validateScheduledOccurrenceMutationIntent(
    sharedMutationIntent(payload),
    WAL_V2_MUTATION_VALIDATION_POLICY
  )
  if (invalidReason) throw new TypeError(invalidReason)
}

function canonicalizePlainData(value: unknown, label: string): CanonicalizedValue {
  const seen = new WeakSet<object>()
  let encodedBytes = 0
  let nodeCount = 0
  const chargeBytes = (bytes: number): void => {
    encodedBytes += bytes
    if (encodedBytes > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES) {
      throw new TypeError('Scheduled occurrence WAL exceeds its encoded size limit.')
    }
  }
  const encodeString = (text: string): string => {
    chargeBytes(canonicalJsonStringByteLength(text))
    return JSON.stringify(text)
  }
  const visit = (candidate: unknown, depth: number): CanonicalizedValue => {
    if (depth > MAX_NESTING_DEPTH) throw new TypeError(`${label} is nested too deeply.`)
    nodeCount += 1
    if (nodeCount > MAX_CANONICAL_NODES) {
      throw new TypeError(`${label} contains too many canonical nodes.`)
    }
    if (typeof candidate === 'string') {
      return { value: candidate, encoded: encodeString(candidate) }
    }
    if (candidate === null || typeof candidate === 'boolean') {
      const encoded = JSON.stringify(candidate)
      chargeBytes(encoded.length)
      return { value: candidate, encoded }
    }
    if (typeof candidate === 'number') {
      if (
        !Number.isFinite(candidate) ||
        Object.is(candidate, -0) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      ) {
        throw new TypeError(`${label} contains a non-canonical number.`)
      }
      const encoded = JSON.stringify(candidate)
      chargeBytes(encoded.length)
      return { value: candidate, encoded }
    }
    if (typeof candidate !== 'object') {
      throw new TypeError(`${label} contains non-JSON data.`)
    }
    if (utilTypes.isProxy(candidate)) {
      throw new TypeError(`${label} contains a proxy.`)
    }
    if (seen.has(candidate)) throw new TypeError(`${label} contains a cycle.`)
    seen.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new TypeError(`${label} contains a hostile array prototype.`)
        }
        const ownKeys = Reflect.ownKeys(candidate)
        if (
          ownKeys.some(
            (key) =>
              typeof key === 'symbol' ||
              (key !== 'length' &&
                (!/^(0|[1-9][0-9]*)$/.test(String(key)) ||
                  Number(key) >= candidate.length))
          )
        ) {
          throw new TypeError(`${label} contains an invalid array property.`)
        }
        const output: JsonValue[] = []
        const encoded: string[] = []
        chargeBytes(2 + Math.max(0, candidate.length - 1))
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(candidate, index)) {
            throw new TypeError(`${label} contains a sparse array.`)
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index))
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`${label} contains an accessor or hidden array value.`)
          }
          const item = visit(descriptor.value, depth + 1)
          output.push(item.value)
          encoded.push(item.encoded)
        }
        return { value: output, encoded: `[${encoded.join(',')}]` }
      }

      if (Object.getPrototypeOf(candidate) !== Object.prototype) {
        throw new TypeError(`${label} contains a hostile object prototype.`)
      }
      const ownKeys = Reflect.ownKeys(candidate)
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        throw new TypeError(`${label} contains a symbol key.`)
      }
      const keys = (ownKeys as string[]).sort()
      const output: { [key: string]: JsonValue } = {}
      const encoded: string[] = []
      chargeBytes(2 + Math.max(0, keys.length - 1) + keys.length)
      for (const key of keys) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          throw new TypeError(`${label} contains a forbidden object key.`)
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${label} contains an accessor or hidden property.`)
        }
        const encodedKey = encodeString(key)
        const item = visit(descriptor.value, depth + 1)
        Object.defineProperty(output, key, {
          value: item.value,
          enumerable: true,
          configurable: true,
          writable: true
        })
        encoded.push(`${encodedKey}:${item.encoded}`)
      }
      return { value: output, encoded: `{${encoded.join(',')}}` }
    } finally {
      seen.delete(candidate)
    }
  }
  return visit(value, 0)
}

function canonicalJsonStringByteLength(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2
    } else if (code < 0x20) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
    if (bytes > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES) return bytes
  }
  return bytes
}

function parseStrictJson(serialized: string): unknown {
  if (Buffer.byteLength(serialized, 'utf8') > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES) {
    throw new TypeError('Scheduled occurrence WAL exceeds its encoded size limit.')
  }
  let offset = 0
  let nodeCount = 0

  const whitespace = (): void => {
    while (offset < serialized.length && /[\t\n\r ]/.test(serialized[offset])) offset += 1
  }
  const parseString = (): string => {
    if (serialized[offset] !== '"') throw new TypeError('Expected a JSON string.')
    const start = offset
    offset += 1
    let escaped = false
    while (offset < serialized.length) {
      const character = serialized[offset]
      offset += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') {
        const value = JSON.parse(serialized.slice(start, offset)) as unknown
        if (typeof value !== 'string') throw new TypeError('Invalid JSON string.')
        return value
      }
      if (character.charCodeAt(0) < 0x20) throw new TypeError('Invalid JSON string control byte.')
    }
    throw new TypeError('Unterminated JSON string.')
  }
  const parseValue = (depth: number): unknown => {
    if (depth > MAX_NESTING_DEPTH) throw new TypeError('JSON input is nested too deeply.')
    nodeCount += 1
    if (nodeCount > MAX_CANONICAL_NODES) {
      throw new TypeError('JSON input contains too many canonical nodes.')
    }
    whitespace()
    const character = serialized[offset]
    if (character === '"') return parseString()
    if (character === '{') return parseObject(depth + 1)
    if (character === '[') return parseArray(depth + 1)
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (serialized.startsWith(literal, offset)) {
        offset += literal.length
        return value
      }
    }
    const numberMatch = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      serialized.slice(offset)
    )
    if (!numberMatch) throw new TypeError('Invalid JSON value.')
    offset += numberMatch[0].length
    const number = Number(numberMatch[0])
    if (!Number.isFinite(number) || Object.is(number, -0)) {
      throw new TypeError('Invalid canonical JSON number.')
    }
    return number
  }
  const parseObject = (depth: number): Record<string, unknown> => {
    offset += 1
    whitespace()
    const output: Record<string, unknown> = {}
    const keys = new Set<string>()
    if (serialized[offset] === '}') {
      offset += 1
      return output
    }
    for (;;) {
      whitespace()
      const key = parseString()
      if (keys.has(key)) throw new TypeError('JSON input contains a duplicate object key.')
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new TypeError('JSON input contains a forbidden key.')
      keys.add(key)
      whitespace()
      if (serialized[offset] !== ':') throw new TypeError('Expected a JSON object colon.')
      offset += 1
      const value = parseValue(depth)
      Object.defineProperty(output, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      })
      whitespace()
      if (serialized[offset] === '}') {
        offset += 1
        return output
      }
      if (serialized[offset] !== ',') throw new TypeError('Expected a JSON object comma.')
      offset += 1
    }
  }
  const parseArray = (depth: number): unknown[] => {
    offset += 1
    whitespace()
    const output: unknown[] = []
    if (serialized[offset] === ']') {
      offset += 1
      return output
    }
    for (;;) {
      output.push(parseValue(depth))
      whitespace()
      if (serialized[offset] === ']') {
        offset += 1
        return output
      }
      if (serialized[offset] !== ',') throw new TypeError('Expected a JSON array comma.')
      offset += 1
    }
  }

  const value = parseValue(0)
  whitespace()
  if (offset !== serialized.length) throw new TypeError('JSON input contains trailing data.')
  return value
}

function serializedInput(input: unknown): string {
  if (typeof input === 'string') {
    if (
      input.length > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES ||
      Buffer.byteLength(input, 'utf8') > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES
    ) {
      throw new TypeError('Scheduled occurrence WAL exceeds its encoded size limit.')
    }
    return input
  }
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('Scheduled occurrence WAL decoding requires raw canonical bytes.')
  }
  if (input.byteLength > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES) {
    throw new TypeError('Scheduled occurrence WAL exceeds its encoded size limit.')
  }
  // Preserve a leading U+FEFF so BOM-prefixed bytes cannot alias the canonical
  // BOM-free JSON text during the byte-for-byte canonicality check.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
}

function requireAuthorityRootId(authorityRoot: ScheduledOccurrenceAuthorityRoot): string {
  if (!authorityRoot || typeof authorityRoot !== 'object') {
    throw new TypeError('Scheduled occurrence authority root is required.')
  }
  const rootId = authorityRoot.rootId
  if (typeof rootId !== 'string' || !ROOT_ID.test(rootId)) {
    throw new TypeError('Scheduled occurrence authority root id is invalid.')
  }
  return rootId
}

function assertEncodedSize(encoded: string): void {
  if (Buffer.byteLength(encoded, 'utf8') > SCHEDULED_OCCURRENCE_MUTATION_WAL_MAX_BYTES) {
    throw new TypeError('Scheduled occurrence WAL exceeds its encoded size limit.')
  }
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function nullablePlainObject(value: unknown, label: string): Record<string, unknown> | null {
  return value === null ? null : requirePlainObject(value, label)
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} keys are not exact.`)
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new TypeError(`${label} contains an unknown key.`)
  }
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing a required key.`)
  }
}

function requireTrimmedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_METADATA_TEXT_LENGTH ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be non-empty trimmed text.`)
  }
  return value
}

function optionalTrimmedText(value: unknown, label: string): void {
  if (value !== undefined) requireTrimmedText(value, label)
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${label} must be text when present.`)
  }
}

function requireCanonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO timestamp.`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function optionalFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${label} must be finite when present.`)
  }
}

function optionalPositiveSafeInteger(value: unknown, label: string): void {
  if (value !== undefined && !isPositiveSafeInteger(value)) {
    throw new TypeError(`${label} must be a positive safe integer when present.`)
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}
