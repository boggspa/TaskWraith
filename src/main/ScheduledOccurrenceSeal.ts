import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'
import { isRetiredProvider } from '../shared/retiredProviders'
import type {
  AgenticServicesSettings,
  ProviderId,
  RunPermissionPostureSnapshot,
  RuntimeProfile,
  ScheduledOccurrenceSeal,
  ScheduledTask,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'
import {
  workflowAuthorityEnvelope,
  workflowRunTemplateAuthority
} from './WorkflowAuthorityDigest'

const TASK_DOMAIN = 'taskwraith:scheduled-task-authority:v1\0'
const RUNTIME_SET_DOMAIN = 'taskwraith:runtime-profile-set:v1\0'
const POSTURE_SET_DOMAIN = 'taskwraith:permission-posture-set:v1\0'
const WORKFLOW_DOMAIN = 'taskwraith:workflow-base-authority:v1\0'
const WORKFLOW_EXECUTION_DOMAIN = 'taskwraith:workflow-execution-authority:v1\0'
const SEAL_DOMAIN = 'taskwraith:scheduled-occurrence:v1\0'
const ROOT_SEAT_ID = 'root'
export const SCHEDULED_LOOP_VERIFIER_SEAT_ID = 'loop-verifier'
const MAX_TEXT_LENGTH = 4_096

const PROVIDER_IDS = {
  gemini: true,
  codex: true,
  claude: true,
  kimi: true,
  grok: true,
  cursor: true,
  ollama: true
} as const satisfies Record<ProviderId, true>

const AGENTIC_SERVICE_AUTHORITY_FIELDS = {
  shellCommands: true,
  fileChanges: true,
  externalPublish: true,
  mcpTools: true,
  subThreadDelegation: true,
  canvasInteraction: true,
  canvasEval: true,
  crossThreadRead: true,
  mediaEditing: true,
  mediaRecording: true,
  networkAccess: true
} as const satisfies Record<keyof Required<AgenticServicesSettings>, true>

const SEAL_KEYS = [
  'schemaVersion',
  'issuedAt',
  'taskAuthorityDigest',
  'compositeWorkflowAuthorityDigest',
  'workspaceRealPath',
  'runtimeProfileSetHmac',
  'permissionPostureSetHmac',
  'sealSignature'
] as const satisfies readonly (keyof ScheduledOccurrenceSeal)[]

/**
 * Exhaustive compile-time classification of the current RuntimeProfile schema.
 * Authority-classified fields must also have a builder below. Adding a profile
 * field, or changing its classification, therefore fails compilation until its
 * launch effect is reviewed deliberately.
 */
export const RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY = {
  id: 'authority',
  name: 'projection',
  provider: 'authority',
  scope: 'authority',
  workspaceMode: 'authority',
  binaryPath: 'authority',
  env: 'authority',
  secretRefs: 'authority',
  mcpProfileId: 'authority',
  approvalMode: 'authority',
  agenticServices: 'authority',
  networkPolicy: 'authority',
  persistence: 'authority',
  containerConfig: 'authority',
  builtin: 'authority',
  pluginProvenance: 'authority',
  createdAt: 'projection',
  updatedAt: 'projection'
} as const satisfies Record<keyof RuntimeProfile, 'authority' | 'projection'>

type RuntimeProfileAuthorityField = {
  [K in keyof RuntimeProfile]-?: (typeof RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY)[K] extends 'authority'
    ? K
    : never
}[keyof RuntimeProfile]

export type CanonicalLaunchAuthorityValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalLaunchAuthorityValue[]
  | { readonly [key: string]: CanonicalLaunchAuthorityValue }

type NormalizedAgenticServicesAuthority = Readonly<{
  [K in keyof Required<AgenticServicesSettings>]: Required<AgenticServicesSettings>[K] | null
}>

interface RuntimeProfileContainerAuthority {
  readonly image: string | null
  readonly workdir: string | null
  readonly mounts: readonly Readonly<{
    source: string
    target: string
    access: 'read' | 'write'
  }>[]
}

const RUNTIME_PROFILE_AUTHORITY_FIELD_BUILDERS = {
  id: (profile: RuntimeProfile) => nonEmptyText(profile.id, 'runtime profile id'),
  provider: (profile: RuntimeProfile) => providerId(profile.provider, 'runtime profile provider'),
  scope: (profile: RuntimeProfile) => oneOf(profile.scope, ['workspace', 'global'], 'runtime profile scope'),
  workspaceMode: (profile: RuntimeProfile) =>
    oneOf(profile.workspaceMode, ['local', 'worktree', 'container'], 'runtime profile workspace mode'),
  binaryPath: (profile: RuntimeProfile) =>
    nullableText(profile.binaryPath, 'runtime profile binary path'),
  env: (profile: RuntimeProfile) => stringRecord(profile.env, 'runtime profile environment'),
  secretRefs: (profile: RuntimeProfile) => normalizeRuntimeProfileSecretRefs(profile.secretRefs),
  mcpProfileId: (profile: RuntimeProfile) =>
    nullableText(profile.mcpProfileId, 'runtime profile MCP profile id'),
  approvalMode: (profile: RuntimeProfile) =>
    nullableText(profile.approvalMode, 'runtime profile approval mode'),
  agenticServices: (profile: RuntimeProfile) =>
    normalizePartialAgenticServices(profile.agenticServices),
  networkPolicy: (profile: RuntimeProfile) =>
    oneOf(profile.networkPolicy, ['inherit', 'allow', 'deny'], 'runtime profile network policy'),
  persistence: (profile: RuntimeProfile) =>
    oneOf(profile.persistence, ['reusable', 'ephemeral'], 'runtime profile persistence'),
  containerConfig: (profile: RuntimeProfile) =>
    normalizeRuntimeProfileContainer(profile.containerConfig),
  builtin: (profile: RuntimeProfile) => profile.builtin === true,
  pluginProvenance: (profile: RuntimeProfile) =>
    normalizePluginProvenance(profile.pluginProvenance)
} as const satisfies Record<
  RuntimeProfileAuthorityField,
  (profile: RuntimeProfile) => unknown
>

export type RuntimeProfileAuthority = Readonly<
  { schemaVersion: 1 } & {
    [K in keyof typeof RUNTIME_PROFILE_AUTHORITY_FIELD_BUILDERS]: ReturnType<
      (typeof RUNTIME_PROFILE_AUTHORITY_FIELD_BUILDERS)[K]
    >
  }
>

/**
 * Main derives this record after resolving the actual binary, effective policy,
 * MCP surface and provider launch plan. The provider-specific plan is represented
 * by a mandatory digest, not a caller-authored open-ended object. Its producer
 * must use an exhaustive provider-discriminated builder before calling this
 * primitive.
 */
export interface EffectiveRuntimeLaunchAuthority {
  readonly schemaVersion: 1
  readonly provider: ProviderId
  readonly effectiveBinary: string
  readonly effectiveWorkspaceMode: RuntimeProfile['workspaceMode']
  readonly effectiveMcpProfileId: string | null
  readonly effectiveApprovalMode: string
  readonly effectiveAgenticServices: Readonly<Required<AgenticServicesSettings>>
  readonly effectiveNetworkPolicy: RuntimeProfile['networkPolicy']
  readonly effectivePersistence: RuntimeProfile['persistence']
  readonly providerLaunchAuthorityDigest: string
}

/** Compatibility name for callers that are resolving a no-profile seat. */
export type DefaultRuntimeLaunchAuthority = EffectiveRuntimeLaunchAuthority

export type ScheduledOccurrenceSeatLaunchAuthority =
  | Readonly<{
      kind: 'selected-runtime-profile'
      profile: RuntimeProfile
      effectiveAuthority: EffectiveRuntimeLaunchAuthority
    }>
  | Readonly<{
      kind: 'default-runtime'
      effectiveAuthority: EffectiveRuntimeLaunchAuthority
    }>

export interface ScheduledOccurrenceRuntimeSeatContext {
  readonly seatId: string
  readonly launchAuthority: ScheduledOccurrenceSeatLaunchAuthority
  /** Resolved launch environment; it is consumed only by a keyed HMAC. */
  readonly resolvedEnv: Readonly<Record<string, string>>
  /**
   * A freshly re-derived, main-signed posture for this exact seat. Persisted
   * ScheduledTask.permissionPosture is intentionally not consulted.
   */
  readonly permissionPostureAuthority: RunPermissionPostureSnapshot
}

export type ScheduledOccurrenceAuthorityPhase =
  | Readonly<{ kind: 'queued' }>
  | Readonly<{ kind: 'running'; ownerRunId: string }>

export interface ScheduledOccurrenceCurrentContext {
  readonly task: ScheduledTask
  readonly workflow: WorkflowDefinition | null
  readonly canonicalizePath: (value: string) => string
  readonly workspaceRealPath: string
  readonly runtimeSeats: readonly ScheduledOccurrenceRuntimeSeatContext[]
  /** Exact current durable lifecycle state expected by this check. */
  readonly phase: ScheduledOccurrenceAuthorityPhase
  /**
   * Main's validated effective loop verifier provider. Null when no verifier is
   * configured. A cross-provider verifier creates the explicit
   * `loop-verifier` runtime/posture seat.
   */
  readonly effectiveLoopVerifierProvider: ProviderId | null
}

export type ScheduledOccurrenceSealPayload = Omit<ScheduledOccurrenceSeal, 'sealSignature'>

/**
 * This primitive authenticates current authority, not storage monotonicity.
 * Durable one-owner claim/history and the occurrence lease own consumption.
 * Restoring the entire Electron userData directory can restore an old task,
 * workflow and valid seal together; rollback resistance is deliberately out of
 * scope here and needs an external monotonic anchor.
 */
export function mintScheduledOccurrenceSeal(
  key: Buffer,
  context: ScheduledOccurrenceCurrentContext,
  issuedAt: string = new Date().toISOString()
): ScheduledOccurrenceSeal {
  if (context.phase.kind !== 'queued') {
    throw new TypeError('Scheduled occurrence seals may only be minted before run ownership.')
  }
  const strongKey = requireStrongKey(key)
  const payload = deriveScheduledOccurrenceSealPayload(strongKey, context, issuedAt)
  return normalizeSeal({
    ...payload,
    sealSignature: signSeal(strongKey, payload)
  })
}

export function deriveScheduledOccurrenceSealPayload(
  key: Buffer,
  context: ScheduledOccurrenceCurrentContext,
  issuedAt: string
): Readonly<ScheduledOccurrenceSealPayload> {
  const strongKey = requireStrongKey(key)
  assertOccurrencePhase(context.task, context.phase)
  const workspaceRealPath = canonicalWorkspaceRealPath(context.workspaceRealPath)
  const seatRows = authorityRows(context)
  const runtimeProfileSetHmac = keyedSetHmac(
    strongKey,
    RUNTIME_SET_DOMAIN,
    seatRows.map((row) => row.runtime)
  )
  const permissionPostureSetHmac = keyedSetHmac(
    strongKey,
    POSTURE_SET_DOMAIN,
    seatRows.map((row) => row.posture)
  )
  const workflowDigest = currentWorkflowDigest(
    context.task,
    context.workflow,
    context.phase,
    context.canonicalizePath
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    issuedAt: canonicalIso(issuedAt, 'issuedAt'),
    taskAuthorityDigest: scheduledTaskAuthorityDigest(
      context.task,
      context.canonicalizePath
    ),
    compositeWorkflowAuthorityDigest:
      workflowDigest === null
        ? null
        : hash(WORKFLOW_EXECUTION_DOMAIN, {
            workflowDigest,
            workspaceRealPath,
            runtimeProfileSetHmac,
            permissionPostureSetHmac
          }),
    workspaceRealPath,
    runtimeProfileSetHmac,
    permissionPostureSetHmac
  })
}

/** Verify an untrusted persisted seal against one freshly resolved context. */
export function verifyScheduledOccurrenceSealAgainstCurrentContext(
  key: Buffer,
  value: unknown,
  context: ScheduledOccurrenceCurrentContext
): ScheduledOccurrenceSeal | null {
  try {
    const strongKey = requireStrongKey(key)
    const seal = normalizeSeal(value)
    const stored = sealPayload(seal)
    if (!equalHex(signSeal(strongKey, stored), seal.sealSignature)) return null
    const expected = deriveScheduledOccurrenceSealPayload(strongKey, context, seal.issuedAt)
    return equalText(canonicalEncode(stored), canonicalEncode(expected)) ? seal : null
  } catch {
    return null
  }
}

/** Build selected-profile authority without caller-authored field bags. */
export function buildRuntimeProfileAuthority(profile: RuntimeProfile): RuntimeProfileAuthority {
  assertPlainDataObject(profile, 'runtime profile')
  assertKnownFields(profile, RUNTIME_PROFILE_AUTHORITY_FIELD_POLICY, 'runtime profile')
  const fields: Record<string, unknown> = {}
  for (const [field, build] of Object.entries(RUNTIME_PROFILE_AUTHORITY_FIELD_BUILDERS)) {
    fields[field] = build(profile)
  }
  return canonicalClone({ schemaVersion: 1, ...fields }) as RuntimeProfileAuthority
}

/** Strict builder for freshly resolved effective launch authority. */
export function buildEffectiveRuntimeLaunchAuthority(
  input: EffectiveRuntimeLaunchAuthority
): EffectiveRuntimeLaunchAuthority {
  const record = exactPlainDataObject(
    input,
    [
      'schemaVersion',
      'provider',
      'effectiveBinary',
      'effectiveWorkspaceMode',
      'effectiveMcpProfileId',
      'effectiveApprovalMode',
      'effectiveAgenticServices',
      'effectiveNetworkPolicy',
      'effectivePersistence',
      'providerLaunchAuthorityDigest'
    ],
    'effective runtime launch authority'
  )
  if (record.schemaVersion !== 1) throw new TypeError('Invalid effective launch schema version.')
  const normalized: EffectiveRuntimeLaunchAuthority = {
    schemaVersion: 1,
    provider: runnableProviderId(record.provider, 'effective launch provider'),
    effectiveBinary: nonEmptyText(record.effectiveBinary, 'effective binary'),
    effectiveWorkspaceMode: oneOf(
      record.effectiveWorkspaceMode,
      ['local', 'worktree', 'container'],
      'effective workspace mode'
    ),
    effectiveMcpProfileId: nullableText(record.effectiveMcpProfileId, 'effective MCP profile id'),
    effectiveApprovalMode: nonEmptyText(record.effectiveApprovalMode, 'effective approval mode'),
    effectiveAgenticServices: normalizeRequiredAgenticServices(
      record.effectiveAgenticServices
    ),
    effectiveNetworkPolicy: oneOf(
      record.effectiveNetworkPolicy,
      ['inherit', 'allow', 'deny'],
      'effective network policy'
    ),
    effectivePersistence: oneOf(
      record.effectivePersistence,
      ['reusable', 'ephemeral'],
      'effective persistence'
    ),
    providerLaunchAuthorityDigest: sha256Hex(
      record.providerLaunchAuthorityDigest,
      'provider launch authority digest'
    )
  }
  return canonicalClone(normalized)
}

/** Compatibility wrapper for no-profile callers. */
export function buildDefaultRuntimeLaunchAuthority(
  input: DefaultRuntimeLaunchAuthority
): DefaultRuntimeLaunchAuthority {
  return buildEffectiveRuntimeLaunchAuthority(input)
}

export function scheduledTaskAuthorityDigest(
  task: ScheduledTask,
  canonicalizePath: (value: string) => string
): string {
  const workflowOccurrenceAt = nullableText(
    task.workflowOccurrenceAt,
    'workflow occurrence time'
  )
  if (workflowOccurrenceAt !== null) canonicalIso(workflowOccurrenceAt, 'workflow occurrence time')
  return hash(TASK_DOMAIN, {
    template: normalizedTemplateAuthority(task, canonicalizePath),
    taskId: nonEmptyText(task.id, 'scheduled task id'),
    runAt: canonicalIso(task.runAt, 'scheduled task run time'),
    timezone: nonEmptyText(task.timezone, 'scheduled task timezone'),
    kind: taskKind(task),
    workflowId: nullableText(task.workflowId, 'workflow id'),
    workflowExecutionId: nullableText(task.workflowExecutionId, 'workflow execution id'),
    workflowOccurrenceAt
  })
}

interface RuntimeRequirement {
  seatId: string
  provider: ProviderId
  runtimeProfileId: string | null
  ensembleParticipant: boolean
}

interface SeatAuthorityRow {
  runtime: Readonly<Record<string, unknown>>
  posture: Readonly<Record<string, unknown>>
}

function authorityRows(context: ScheduledOccurrenceCurrentContext): readonly SeatAuthorityRow[] {
  const seats = context.runtimeSeats
  if (!Array.isArray(seats)) throw new TypeError('Runtime seats must be an array.')
  const requirements = runtimeRequirements(context)
  const bySeat = new Map<string, ScheduledOccurrenceRuntimeSeatContext>()
  for (const seat of seats) {
    assertPlainDataObject(seat, 'runtime seat')
    const seatId = nonEmptyText(seat.seatId, 'runtime seat id')
    if (bySeat.has(seatId)) throw new TypeError(`Duplicate runtime seat: ${seatId}`)
    bySeat.set(seatId, seat)
  }
  if (bySeat.size !== requirements.length) {
    throw new TypeError('Runtime seat set does not match the scheduled task.')
  }

  return requirements.map((requirement) => {
    const seat = bySeat.get(requirement.seatId)
    if (!seat) throw new TypeError(`Runtime seat is missing: ${requirement.seatId}`)
    const resolvedEnv = stringRecord(seat.resolvedEnv, 'resolved runtime environment')
    const launch = seat.launchAuthority
    assertPlainDataObject(launch, 'runtime seat launch authority')
    const effective = buildEffectiveRuntimeLaunchAuthority(launch.effectiveAuthority)
    if (effective.provider !== requirement.provider) {
      throw new TypeError('Effective runtime authority does not match the scheduled seat provider.')
    }

    let profileAuthority: RuntimeProfileAuthority | null = null
    if (requirement.runtimeProfileId === null) {
      if (launch.kind !== 'default-runtime' || 'profile' in launch) {
        throw new TypeError('A default runtime seat requires explicit effective launch authority.')
      }
    } else {
      if (launch.kind !== 'selected-runtime-profile' || !('profile' in launch)) {
        throw new TypeError(
          'A selected runtime seat requires its profile and effective launch authority.'
        )
      }
      profileAuthority = buildRuntimeProfileAuthority(launch.profile)
      if (
        profileAuthority.id !== requirement.runtimeProfileId ||
        profileAuthority.provider !== requirement.provider
      ) {
        throw new TypeError('Runtime profile does not match the scheduled seat.')
      }
    }

    const posture = trustedPostureAuthority(
      seat.permissionPostureAuthority,
      requirement,
      context.task
    )
    return {
      runtime: {
        seatId: requirement.seatId,
        provider: requirement.provider,
        runtimeProfileId: requirement.runtimeProfileId,
        profileAuthority,
        effectiveAuthority: effective,
        resolvedEnv
      },
      posture: {
        seatId: requirement.seatId,
        provider: requirement.provider,
        postureHash: posture.postureHash,
        signature: posture.signature
      }
    }
  })
}

function runtimeRequirements(context: ScheduledOccurrenceCurrentContext): RuntimeRequirement[] {
  const { task, workflow } = context
  const kind = taskKind(task)
  const result: RuntimeRequirement[] = []

  if (kind === 'single') {
    if (task.ensembleSnapshot !== undefined) {
      throw new TypeError('A single scheduled task cannot carry an Ensemble snapshot.')
    }
    result.push({
      seatId: ROOT_SEAT_ID,
      provider: runnableProviderId(task.provider, 'scheduled task provider'),
      runtimeProfileId: nullableText(task.runtimeProfileId, 'runtime profile id'),
      ensembleParticipant: false
    })
  } else {
    if (workflow?.loop) {
      throw new TypeError('An Ensemble scheduled task cannot run a maker-verifier loop.')
    }
    const participants = task.ensembleSnapshot?.participants
    if (!Array.isArray(participants)) {
      throw new TypeError('An Ensemble scheduled task requires a participant snapshot.')
    }
    const seen = new Set<string>()
    for (const participant of participants) {
      if (!participant.enabled) continue
      const seatId = nonEmptyText(participant.id, 'Ensemble participant id')
      if (seen.has(seatId)) throw new TypeError(`Duplicate Ensemble participant id: ${seatId}`)
      seen.add(seatId)
      result.push({
        seatId,
        provider: runnableProviderId(participant.provider, 'Ensemble participant provider'),
        runtimeProfileId: nullableText(participant.runtimeProfileId, 'runtime profile id'),
        ensembleParticipant: true
      })
    }
    if (result.length === 0) {
      throw new TypeError('An Ensemble scheduled task requires an enabled participant.')
    }
  }

  const verifier = workflow?.loop?.acceptance.verifier
  if (!verifier) {
    if (context.effectiveLoopVerifierProvider !== null) {
      throw new TypeError('A workflow without a verifier cannot carry verifier authority.')
    }
    return result.sort(compareRequirements)
  }
  if (kind !== 'single') {
    throw new TypeError('Only a single-provider scheduled task can carry verifier authority.')
  }
  const configuredProvider = verifier.provider ?? task.provider
  const expectedProvider = runnableProviderId(
    configuredProvider,
    'workflow loop verifier provider'
  )
  if (context.effectiveLoopVerifierProvider !== expectedProvider) {
    throw new TypeError('Effective loop verifier provider does not match the workflow.')
  }
  if (expectedProvider !== task.provider) {
    result.push({
      seatId: SCHEDULED_LOOP_VERIFIER_SEAT_ID,
      provider: expectedProvider,
      runtimeProfileId: null,
      ensembleParticipant: false
    })
  }
  return result.sort(compareRequirements)
}

function compareRequirements(left: RuntimeRequirement, right: RuntimeRequirement): number {
  return compareText(left.seatId, right.seatId)
}

function keyedSetHmac(key: Buffer, domain: string, rows: readonly unknown[]): string {
  return createHmac('sha256', key)
    .update(domain)
    .update(canonicalEncode({ rows }))
    .digest('hex')
}

function currentWorkflowDigest(
  task: ScheduledTask,
  workflow: WorkflowDefinition | null,
  phase: ScheduledOccurrenceAuthorityPhase,
  canonicalizePath: (value: string) => string
): string | null {
  const workflowId = nullableText(task.workflowId, 'workflow id')
  const executionId = nullableText(task.workflowExecutionId, 'workflow execution id')
  const occurrenceAt = nullableText(task.workflowOccurrenceAt, 'workflow occurrence time')
  const linkCount = [workflowId, executionId, occurrenceAt].filter(
    (value) => value !== null
  ).length
  if (linkCount !== 0 && linkCount !== 3) {
    throw new TypeError('Scheduled workflow linkage must be entirely present or entirely absent.')
  }
  if (linkCount === 0) {
    if (workflow !== null) throw new TypeError('An unlinked scheduled task cannot carry a workflow.')
    return null
  }
  if (!workflow) throw new TypeError('A linked scheduled task requires its current workflow.')
  if (workflow.id !== workflowId || workflow.activeExecutionId !== executionId) {
    throw new TypeError('Scheduled task workflow identity is not current.')
  }
  if (
    workflow.workspaceId !== task.workspaceId ||
    workflow.template.workspaceId !== task.workspaceId ||
    canonicalizePath(workflow.workspacePath) !== canonicalizePath(task.workspacePath) ||
    canonicalizePath(workflow.template.workspacePath) !== canonicalizePath(task.workspacePath)
  ) {
    throw new TypeError('Scheduled task workflow workspace does not match.')
  }
  canonicalIso(task.runAt, 'scheduled task run time')
  canonicalIso(occurrenceAt, 'workflow occurrence time')
  const execution = workflow.history.find((candidate) => candidate.id === executionId)
  if (
    !execution ||
    execution.workflowId !== workflow.id ||
    execution.scheduledTaskId !== task.id ||
    execution.plannedFor !== occurrenceAt
  ) {
    throw new TypeError('Scheduled workflow execution linkage does not match.')
  }
  if (phase.kind === 'queued') {
    if (execution.status !== 'queued' || execution.runId !== undefined) {
      throw new TypeError('Scheduled workflow execution is not queued and unowned.')
    }
  } else if (execution.status !== 'running' || execution.runId !== phase.ownerRunId) {
    throw new TypeError('Scheduled workflow execution is not owned by the running occurrence.')
  }

  const taskTemplate = normalizedTemplateAuthority(task, canonicalizePath)
  const workflowTemplate = normalizedTemplateAuthority(workflow.template, canonicalizePath)
  if (!equalText(canonicalEncode(taskTemplate), canonicalEncode(workflowTemplate))) {
    throw new TypeError('Scheduled task no longer matches its workflow template.')
  }
  const envelope = normalizeTypedOptionalAuthority(
    workflowAuthorityEnvelope(workflow, canonicalizePath)
  )
  return hash(WORKFLOW_DOMAIN, {
    envelope,
    template: workflowTemplate,
    // `workflowAuthorityEnvelope` deliberately excludes projection/lifecycle
    // state for saved-definition acknowledgements. Occurrence authority is
    // narrower: once materialized, toggling enabled must invalidate that exact
    // occurrence rather than allowing a disabled workflow to dispatch later.
    enabled: workflow.enabled
  })
}

function normalizedTemplateAuthority(
  template: WorkflowRunTemplate,
  canonicalizePath: (value: string) => string
): Record<string, unknown> {
  const normalized = normalizeTypedOptionalAuthority(
    workflowRunTemplateAuthority(template, canonicalizePath)
  )
  assertPlainDataObject(normalized, 'workflow template authority')
  canonicalEncode(normalized)
  return normalized
}

function trustedPostureAuthority(
  posture: RunPermissionPostureSnapshot,
  requirement: RuntimeRequirement,
  task: ScheduledTask
): { postureHash: string; signature: string } {
  assertPlainDataObject(posture, 'fresh permission posture authority')
  if (posture.schemaVersion !== 1 || posture.signaturePresent !== true) {
    throw new TypeError('A fresh signed permission posture is required for every runtime seat.')
  }
  const context = posture.context
  if (!context || context.provider !== requirement.provider) {
    throw new TypeError('Permission posture provider does not match its runtime seat.')
  }
  if (
    context.scope !== 'workspace' ||
    context.appRunId !== task.id ||
    context.appChatId !== task.chatId ||
    (context.workflowMode ?? 'normal') !== (task.workflowMode === 'plan' ? 'plan' : 'normal') ||
    (context.runtimeProfileId ?? null) !== requirement.runtimeProfileId
  ) {
    throw new TypeError('Permission posture context does not match its scheduled occurrence.')
  }
  if (
    requirement.ensembleParticipant &&
    context.ensembleParticipantId !== requirement.seatId
  ) {
    throw new TypeError('Permission posture participant does not match its runtime seat.')
  }
  if (!requirement.ensembleParticipant && context.ensembleParticipantId !== undefined) {
    throw new TypeError('A non-Ensemble posture cannot claim an Ensemble participant.')
  }
  return {
    postureHash: sha256Hex(posture.postureHash, 'permission posture hash'),
    signature: sha256Hex(posture.signature, 'permission posture signature')
  }
}

function assertOccurrencePhase(
  task: ScheduledTask,
  phase: ScheduledOccurrenceAuthorityPhase
): void {
  assertPlainDataObject(phase, 'scheduled occurrence phase')
  if (phase.kind === 'queued') {
    exactPlainDataObject(phase, ['kind'], 'queued scheduled occurrence phase')
    if ((task.status !== 'pending' && task.status !== 'due') || task.runId !== undefined) {
      throw new TypeError('Queued occurrence authority requires an unowned pending or due task.')
    }
    return
  }
  if (phase.kind !== 'running') throw new TypeError('Invalid scheduled occurrence phase.')
  exactPlainDataObject(
    phase,
    ['kind', 'ownerRunId'],
    'running scheduled occurrence phase'
  )
  const ownerRunId = nonEmptyText(phase.ownerRunId, 'scheduled occurrence owner run id')
  if (task.status !== 'running' || task.runId !== ownerRunId) {
    throw new TypeError('Running occurrence authority does not match the durable run owner.')
  }
}

function taskKind(task: ScheduledTask): 'single' | 'ensemble' {
  if (task.kind === undefined || task.kind === 'single') return 'single'
  if (task.kind === 'ensemble') return 'ensemble'
  throw new TypeError('Invalid scheduled task kind.')
}

function sealPayload(
  seal: ScheduledOccurrenceSealPayload | ScheduledOccurrenceSeal
): ScheduledOccurrenceSealPayload {
  return {
    schemaVersion: 1,
    issuedAt: seal.issuedAt,
    taskAuthorityDigest: seal.taskAuthorityDigest,
    compositeWorkflowAuthorityDigest: seal.compositeWorkflowAuthorityDigest,
    workspaceRealPath: seal.workspaceRealPath,
    runtimeProfileSetHmac: seal.runtimeProfileSetHmac,
    permissionPostureSetHmac: seal.permissionPostureSetHmac
  }
}

function normalizeSeal(value: unknown): ScheduledOccurrenceSeal {
  const record = exactPlainDataObject(value, SEAL_KEYS, 'scheduled occurrence seal')
  if (record.schemaVersion !== 1) throw new TypeError('Invalid seal schema version.')
  return Object.freeze({
    schemaVersion: 1 as const,
    issuedAt: canonicalIso(record.issuedAt, 'issuedAt'),
    taskAuthorityDigest: sha256Hex(record.taskAuthorityDigest, 'taskAuthorityDigest'),
    compositeWorkflowAuthorityDigest:
      record.compositeWorkflowAuthorityDigest === null
        ? null
        : sha256Hex(
            record.compositeWorkflowAuthorityDigest,
            'compositeWorkflowAuthorityDigest'
          ),
    workspaceRealPath: canonicalWorkspaceRealPath(record.workspaceRealPath),
    runtimeProfileSetHmac: sha256Hex(record.runtimeProfileSetHmac, 'runtimeProfileSetHmac'),
    permissionPostureSetHmac: sha256Hex(
      record.permissionPostureSetHmac,
      'permissionPostureSetHmac'
    ),
    sealSignature: sha256Hex(record.sealSignature, 'sealSignature')
  })
}

function signSeal(key: Buffer, payload: ScheduledOccurrenceSealPayload): string {
  return createHmac('sha256', key)
    .update(SEAL_DOMAIN)
    .update(canonicalEncode(sealPayload(payload)))
    .digest('hex')
}

function hash(domain: string, value: unknown): string {
  return createHash('sha256').update(domain).update(canonicalEncode(value)).digest('hex')
}

function requireStrongKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.byteLength < 32) {
    throw new TypeError('Scheduled occurrence signing key must be a Buffer of at least 32 bytes.')
  }
  return key
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function canonicalWorkspaceRealPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    parse(value).root === value
  ) {
    throw new TypeError('workspaceRealPath must be a bounded canonical absolute path.')
  }
  return value
}

function providerId(value: unknown, label: string): ProviderId {
  if (typeof value !== 'string' || !(value in PROVIDER_IDS)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value as ProviderId
}

function runnableProviderId(value: unknown, label: string): ProviderId {
  const provider = providerId(value, label)
  if (isRetiredProvider(provider)) throw new TypeError(`${label} is retired.`)
  return provider
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${label} must be a bounded non-empty string.`)
  }
  return value
}

function nullableText(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : nonEmptyText(value, label)
}

function sha256Hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be canonical SHA-256 hex.`)
  }
  return value
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value as T
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  assertPlainDataObject(value, label)
  const output = Object.create(null) as Record<string, string>
  for (const key of Object.keys(value).sort(compareText)) {
    const entry = value[key]
    if (typeof entry !== 'string') throw new TypeError(`${label} values must be strings.`)
    output[key] = entry
  }
  return Object.freeze(output)
}

function normalizeRuntimeProfileSecretRefs(
  value: RuntimeProfile['secretRefs']
): Readonly<{ env: readonly string[] }> {
  if (value !== undefined) {
    assertPlainDataObject(value, 'runtime profile secret refs')
    assertKnownFields(value, { env: true }, 'runtime profile secret refs')
  }
  const raw = value?.env ?? []
  if (!Array.isArray(raw)) throw new TypeError('Runtime profile secret env refs must be an array.')
  assertDenseStandardArray(raw, 'runtime profile secret env refs')
  const env = raw.map((entry) => nonEmptyText(entry, 'runtime profile secret reference'))
  env.sort(compareText)
  if (new Set(env).size !== env.length) {
    throw new TypeError('Runtime profile secret references must be unique.')
  }
  return Object.freeze({ env: Object.freeze(env) })
}

function normalizePartialAgenticServices(
  value: RuntimeProfile['agenticServices']
): NormalizedAgenticServicesAuthority {
  if (value !== undefined) {
    assertPlainDataObject(value, 'runtime profile agentic services')
    assertKnownFields(value, AGENTIC_SERVICE_AUTHORITY_FIELDS, 'runtime profile agentic services')
  }
  const output: Record<string, string | null> = {}
  for (const key of Object.keys(AGENTIC_SERVICE_AUTHORITY_FIELDS).sort(compareText)) {
    const entry = value?.[key as keyof Required<AgenticServicesSettings>]
    output[key] =
      entry === undefined
        ? null
        : key === 'networkAccess'
          ? oneOf(entry, ['allow', 'deny'], `agentic service ${key}`)
          : oneOf(
              entry,
              ['ask', 'workspace', 'allow', 'deny'],
              `agentic service ${key}`
            )
  }
  return canonicalClone(output) as NormalizedAgenticServicesAuthority
}

function normalizeRequiredAgenticServices(
  value: unknown
): Readonly<Required<AgenticServicesSettings>> {
  const record = exactPlainDataObject(
    value,
    Object.keys(AGENTIC_SERVICE_AUTHORITY_FIELDS) as Array<
      keyof Required<AgenticServicesSettings>
    >,
    'effective agentic services'
  )
  const output: Record<string, string> = {}
  for (const key of Object.keys(AGENTIC_SERVICE_AUTHORITY_FIELDS).sort(compareText)) {
    output[key] =
      key === 'networkAccess'
        ? oneOf(record[key], ['allow', 'deny'], `effective agentic service ${key}`)
        : oneOf(
            record[key],
            ['ask', 'workspace', 'allow', 'deny'],
            `effective agentic service ${key}`
          )
  }
  return canonicalClone(output) as Readonly<Required<AgenticServicesSettings>>
}

function normalizeRuntimeProfileContainer(
  value: RuntimeProfile['containerConfig']
): RuntimeProfileContainerAuthority | null {
  if (value === undefined) return null
  const record = exactOptionalPlainDataObject(
    value,
    ['image', 'workdir', 'mounts'],
    'runtime profile container config'
  )
  const rawMounts = record.mounts ?? []
  if (!Array.isArray(rawMounts)) throw new TypeError('Runtime profile mounts must be an array.')
  assertDenseStandardArray(rawMounts, 'runtime profile mounts')
  const mounts = rawMounts.map((mount, index) => {
    const entry = exactPlainDataObject(
      mount,
      ['source', 'target', 'access'],
      `runtime profile mount ${index}`
    )
    return {
      source: nonEmptyText(entry.source, 'runtime profile mount source'),
      target: nonEmptyText(entry.target, 'runtime profile mount target'),
      access: oneOf(entry.access, ['read', 'write'], 'runtime profile mount access')
    }
  })
  return canonicalClone({
    image: nullableText(record.image, 'runtime profile container image'),
    workdir: nullableText(record.workdir, 'runtime profile container workdir'),
    mounts
  })
}

function normalizePluginProvenance(
  value: RuntimeProfile['pluginProvenance']
): CanonicalLaunchAuthorityValue {
  if (value === undefined) return null
  const record = exactPlainDataObject(
    value,
    [
      'pluginId',
      'publisher',
      'version',
      'source',
      'namespace',
      'manifestHash',
      'kind',
      'objectId',
      'materializedAt'
    ],
    'runtime profile plugin provenance'
  )
  return canonicalClone({
    pluginId: nonEmptyText(record.pluginId, 'plugin id'),
    publisher: nonEmptyText(record.publisher, 'plugin publisher'),
    version: nonEmptyText(record.version, 'plugin version'),
    source: nonEmptyText(record.source, 'plugin source'),
    namespace: nonEmptyText(record.namespace, 'plugin namespace'),
    manifestHash: nonEmptyText(record.manifestHash, 'plugin manifest hash'),
    kind: nonEmptyText(record.kind, 'plugin resource kind'),
    objectId: nonEmptyText(record.objectId, 'plugin object id'),
    materializedAt: canonicalIso(record.materializedAt, 'plugin materialized time')
  })
}

function exactPlainDataObject<const K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string
): Record<K, unknown> {
  assertPlainDataObject(value, label)
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} has an invalid field set.`)
  }
  return value as Record<K, unknown>
}

function exactOptionalPlainDataObject<const K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string
): Partial<Record<K, unknown>> {
  assertPlainDataObject(value, label)
  assertKnownFields(value, Object.fromEntries(keys.map((key) => [key, true])), label)
  return value as Partial<Record<K, unknown>>
}

function assertKnownFields(
  value: Record<string, unknown>,
  fields: Readonly<Record<string, unknown>>,
  label: string
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new TypeError(`${label} has an invalid field set.`)
    }
  }
}

function assertPlainDataObject<T>(
  value: T,
  label: string
): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object.`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} cannot contain symbol keys.`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} must contain only enumerable data properties.`)
    }
  }
}

function assertDenseStandardArray(value: unknown[], label: string): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must use the standard Array prototype.`)
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be dense and cannot have extra properties.`)
  }
}

/**
 * Typed production records use optional object properties. Before strict
 * canonical encoding, explicitly-undefined optional properties are dropped at
 * every object depth (the same meaning as absence); undefined array elements,
 * sparse arrays and arbitrary exotic values remain invalid.
 */
function normalizeTypedOptionalAuthority(
  value: unknown,
  ancestors: Set<object> = new Set()
): CanonicalLaunchAuthorityValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Authority numbers must be finite.')
    return value
  }
  if (value === undefined) throw new TypeError('Top-level typed authority cannot be undefined.')
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported typed authority value type: ${typeof value}`)
  }
  if (ancestors.has(value)) throw new TypeError('Cyclic authority values are not supported.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Authority arrays must use the standard Array prototype.')
      }
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1) {
        throw new TypeError('Authority arrays must be dense and cannot have extra properties.')
      }
      return value.map((entry) => {
        if (entry === undefined) throw new TypeError('Authority arrays cannot contain undefined.')
        return normalizeTypedOptionalAuthority(entry, ancestors)
      })
    }
    assertPlainDataObject(value, 'typed authority object')
    const output = Object.create(null) as Record<string, CanonicalLaunchAuthorityValue>
    for (const key of Object.keys(value).sort(compareText)) {
      const entry = value[key]
      if (entry === undefined) continue
      output[key] = normalizeTypedOptionalAuthority(entry, ancestors)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Strict, injective canonical JSON subset. Unsupported/undefined/non-finite,
 * non-plain, sparse, accessor, symbol and cyclic values are rejected rather
 * than colliding with an accepted authority value.
 */
function canonicalEncode(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Authority numbers must be finite.')
    return Object.is(value, -0) ? '-0' : JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported authority value type: ${typeof value}`)
  }
  if (ancestors.has(value)) throw new TypeError('Cyclic authority values are not supported.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Authority arrays must use the standard Array prototype.')
      }
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.length !== value.length + 1) {
        throw new TypeError('Authority arrays must be dense and cannot have extra properties.')
      }
      const encoded: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Authority arrays must contain enumerable data elements.')
        }
        encoded.push(canonicalEncode(descriptor.value, ancestors))
      }
      return `[${encoded.join(',')}]`
    }

    assertPlainDataObject(value, 'authority object')
    const entries = Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalEncode(value[key], ancestors)}`)
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function canonicalClone<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalEncode(value)) as T)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function equalHex(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  )
}

function equalText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
