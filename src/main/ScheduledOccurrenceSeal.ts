import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../shared/kimiAcpPosture'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isLiveSelectableProvider,
  isRetiredProvider
} from '../shared/retiredProviders'
import type {
  AgenticNetworkPolicy,
  AgenticServiceId,
  AgenticServicePolicy,
  AgenticServicesSettings,
  ProviderId,
  RuntimeProfile,
  ScheduledOccurrenceSealV1,
  ScheduledOccurrenceSealV2,
  ScheduledOccurrenceRootOwner,
  ScheduledTask,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'
import type { ScheduledOccurrenceAuthorityRoot } from './ScheduledOccurrenceAuthorityRootStore'
import {
  SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS,
  type ScheduledOccurrencePostureAuthority,
  type ScheduledOccurrencePostureCapability,
  type ScheduledOccurrencePostureResolver
} from './ScheduledOccurrencePostureAuthority'
import { approvalModeRank, coerceApprovalMode } from './RunPermissionPosture'
import { codexSandboxForMode } from './codex/CodexRunPolicy'
import { isFullShellAccessGranted } from './EffectiveRunPermissions'
import {
  buildProviderLaunchAuthority,
  providerLaunchAuthorityDigest,
  type CanonicalProviderLaunchAuthority,
  type ClaudeLaunchControls,
  type CodexLaunchControls,
  type CursorLaunchControls,
  type GrokLaunchControls,
  type MistralLaunchControls,
  type KimiLaunchControls,
  type OllamaLaunchControls,
  type ProviderLaunchAuthorityInput
} from './ProviderLaunchAuthorityDigest'
import type { PiLaunchControls } from './pi/PiLaunchAuthority'
import { resolvePiNativeToolPosture } from './pi/PiNativeToolPosture'
import type {
  AntigravityGeminiApiLaunchControls,
  AntigravityOfficialAgyLaunchControls
} from './scheduling/AntigravityLaunchAuthority'
import {
  workflowAuthorityEnvelope,
  workflowRunTemplateAuthority
} from './WorkflowAuthorityDigest'

const TASK_DOMAIN = 'taskwraith:scheduled-task-authority:v1\0'
const WORKFLOW_DOMAIN = 'taskwraith:workflow-base-authority:v1\0'
const WORKFLOW_EXECUTION_DOMAIN = 'taskwraith:workflow-execution-authority:v1\0'
const ROOT_SEAT_ID = 'root'
export const SCHEDULED_LOOP_VERIFIER_SEAT_ID = 'loop-verifier'
/** Canonical non-path marker for Ollama's HTTP runtime (which has no CLI binary). */
export const SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL =
  'taskwraith:ollama-http-runtime'
const MAX_TEXT_LENGTH = 4_096

const PROVIDER_IDS = {
  gemini: true,
  codex: true,
  claude: true,
  kimi: true,
  grok: true,
  cursor: true,
  ollama: true,
  antigravity: true,
  pi: true,
  mistral: true
} as const satisfies Record<ProviderId, true>

const AGENTIC_SERVICE_AUTHORITY_FIELDS = {
  shellCommands: true,
  fileChanges: true,
  externalPublish: true,
  mcpTools: true,
  subThreadDelegation: true,
  canvasInteraction: true,
  sketchCanvas: true,
  meshCanvas: true,
  simulatorCanvas: true,
  canvasEval: true,
  crossThreadRead: true,
  threadMessage: true,
  mediaEditing: true,
  mediaRecording: true,
  webBrowsing: true,
  networkAccess: true
} as const satisfies Record<keyof Required<AgenticServicesSettings>, true>

const SEAL_V2_KEYS = [
  'schemaVersion',
  'rootId',
  'issuedAt',
  'ownerRunId',
  'rootOwner',
  'taskAuthorityDigest',
  'compositeWorkflowAuthorityDigest',
  'workspaceRealPath',
  'runtimeProfileSetHmac',
  'permissionPostureSetHmac',
  'sealMac'
] as const satisfies readonly (keyof ScheduledOccurrenceSealV2)[]

const SEAL_V1_KEYS = [
  'schemaVersion',
  'issuedAt',
  'taskAuthorityDigest',
  'compositeWorkflowAuthorityDigest',
  'workspaceRealPath',
  'runtimeProfileSetHmac',
  'permissionPostureSetHmac',
  'sealSignature'
] as const satisfies readonly (keyof ScheduledOccurrenceSealV1)[]

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
 * Main derives this defensive preflight record after resolving the intended
 * binary, effective policy, MCP surface and provider launch plan. The
 * provider-specific plan is represented by a mandatory digest, not a
 * caller-authored open-ended object. Its producer must use an exhaustive
 * provider-discriminated builder before calling this primitive.
 *
 * This record does not attest what was actually spawned and is never sufficient
 * launch authority. A process-local, one-shot launch receipt must bind and
 * consume the exact executable/request, environment, workspace and session at
 * the irreversible provider start boundary.
 */
interface EffectiveRuntimeLaunchAuthorityCommon {
  readonly schemaVersion: 1
  readonly provider: ProviderId
  readonly effectiveBinary: string
  readonly effectiveWorkspaceMode: RuntimeProfile['workspaceMode']
  readonly effectiveMcpProfileId: string | null
  readonly effectiveApprovalMode: string
  readonly effectiveAgenticServices: Readonly<
    Record<AgenticServiceId, AgenticServicePolicy>
  >
  readonly effectiveNetworkPolicy: AgenticNetworkPolicy
  readonly effectivePersistence: RuntimeProfile['persistence']
}

export interface EffectiveRuntimeLaunchAuthorityInput
  extends EffectiveRuntimeLaunchAuthorityCommon {
  readonly providerLaunchAuthority: ProviderLaunchAuthorityInput
}

export interface EffectiveRuntimeLaunchAuthority
  extends EffectiveRuntimeLaunchAuthorityCommon {
  readonly providerLaunchAuthorityDigest: string
}

/** Compatibility name for callers that are resolving a no-profile seat. */
export type DefaultRuntimeLaunchAuthorityInput = EffectiveRuntimeLaunchAuthorityInput
export type DefaultRuntimeLaunchAuthority = EffectiveRuntimeLaunchAuthority

export type ScheduledOccurrenceSeatLaunchAuthority =
  | Readonly<{
      kind: 'selected-runtime-profile'
      profile: RuntimeProfile
      effectiveAuthority: EffectiveRuntimeLaunchAuthorityInput
    }>
  | Readonly<{
      kind: 'default-runtime'
      effectiveAuthority: EffectiveRuntimeLaunchAuthorityInput
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
  readonly permissionPostureCapability: ScheduledOccurrencePostureCapability
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

export type ScheduledOccurrenceSealPayload = Omit<ScheduledOccurrenceSealV2, 'sealMac'>
type ScheduledOccurrenceSealDerivationMode = 'mint' | 'verify'

/**
 * This primitive authenticates current authority, not storage monotonicity.
 * Durable one-owner claim/history and the occurrence lease own consumption.
 * Restoring the entire Electron userData directory can restore an old task,
 * workflow and valid seal together; rollback resistance is deliberately out of
 * scope here and needs an external monotonic anchor.
 */
export function mintScheduledOccurrenceSeal(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  postureResolver: ScheduledOccurrencePostureResolver,
  context: ScheduledOccurrenceCurrentContext,
  issuedAt: string = new Date().toISOString()
): ScheduledOccurrenceSealV2 {
  if (context.phase.kind !== 'running') {
    throw new TypeError('Scheduled occurrence seals may only be minted from a running post-image.')
  }
  const payload = deriveScheduledOccurrenceSealPayload(
    authorityRoot,
    postureResolver,
    context,
    issuedAt,
    'mint'
  )
  return normalizeSealV2({
    ...payload,
    sealMac: authorityRoot.sealPayloadMac(sealPayloadBytes(payload))
  })
}

function deriveScheduledOccurrenceSealPayload(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  postureResolver: ScheduledOccurrencePostureResolver,
  context: ScheduledOccurrenceCurrentContext,
  issuedAt: string,
  mode: ScheduledOccurrenceSealDerivationMode
): Readonly<ScheduledOccurrenceSealPayload> {
  const rootId = authorityRootId(authorityRoot)
  const canonicalIssuedAt = canonicalIso(issuedAt, 'issuedAt')
  assertOccurrencePhase(context.task, context.phase, canonicalIssuedAt, mode)
  if (context.phase.kind !== 'running') {
    throw new TypeError('Scheduled occurrence authority requires a running post-image.')
  }
  const rootOwner = scheduledOccurrenceRootOwner(context.task, context.workflow)
  const workspaceRealPath = canonicalWorkspaceRealPath(context.workspaceRealPath)
  const seatRows = authorityRows(
    context,
    postureResolver,
    rootId,
    workspaceRealPath
  )
  const runtimeProfileSetHmac = authorityRoot.runtimeProfileSetHmac(
    authoritySetBytes(seatRows.map((row) => row.runtime))
  )
  const permissionPostureSetHmac = authorityRoot.permissionPostureSetHmac(
    authoritySetBytes(seatRows.map((row) => row.posture))
  )
  const workflowDigest = currentWorkflowDigest(
    context.task,
    context.workflow,
    context.phase,
    context.canonicalizePath,
    canonicalIssuedAt,
    mode
  )
  return Object.freeze({
    schemaVersion: 2 as const,
    rootId,
    issuedAt: canonicalIssuedAt,
    ownerRunId: trimmedText(context.phase.ownerRunId, 'scheduled occurrence owner run id'),
    rootOwner,
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
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  postureResolver: ScheduledOccurrencePostureResolver,
  value: unknown,
  context: ScheduledOccurrenceCurrentContext
): ScheduledOccurrenceSealV2 | null {
  try {
    const rootId = authorityRootId(authorityRoot)
    const seal = normalizeSealV2(value)
    if (seal.rootId !== rootId || context.phase.kind !== 'running') return null
    const persistedSeal = normalizeSealV2(context.task.occurrenceSeal)
    if (!equalText(canonicalEncode(persistedSeal), canonicalEncode(seal))) return null
    const stored = sealPayload(seal)
    if (!authorityRoot.verifySealPayloadMac(sealPayloadBytes(stored), seal.sealMac)) return null
    const expected = deriveScheduledOccurrenceSealPayload(
      authorityRoot,
      postureResolver,
      context,
      seal.issuedAt,
      'verify'
    )
    return equalText(canonicalEncode(stored), canonicalEncode(expected)) ? seal : null
  } catch {
    return null
  }
}

/**
 * Strictly decode a legacy v1 record for migration/audit only. No launch
 * verifier accepts this type, irrespective of its historical signature.
 */
export function decodeLegacyScheduledOccurrenceSealV1ForMigration(
  value: unknown
): ScheduledOccurrenceSealV1 | null {
  try {
    return normalizeSealV1(value)
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
  input: EffectiveRuntimeLaunchAuthorityInput
): EffectiveRuntimeLaunchAuthority {
  return resolveEffectiveRuntimeLaunchAuthority(input).authority
}

interface ResolvedEffectiveRuntimeLaunchAuthority {
  authority: EffectiveRuntimeLaunchAuthority
  providerLaunchAuthority: CanonicalProviderLaunchAuthority
}

function resolveEffectiveRuntimeLaunchAuthority(
  input: EffectiveRuntimeLaunchAuthorityInput
): ResolvedEffectiveRuntimeLaunchAuthority {
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
      'providerLaunchAuthority'
    ],
    'effective runtime launch authority'
  )
  if (record.schemaVersion !== 1) throw new TypeError('Invalid effective launch schema version.')
  const provider = runnableProviderId(record.provider, 'effective launch provider')
  const providerLaunchAuthority = buildProviderLaunchAuthority(
    record.providerLaunchAuthority as ProviderLaunchAuthorityInput
  )
  if (providerLaunchAuthority.provider !== provider) {
    throw new TypeError('Provider launch plan does not match the effective launch provider.')
  }
  const effectiveBinary = nonEmptyText(record.effectiveBinary, 'effective binary')
  const effectivePersistence = oneOf(
    record.effectivePersistence,
    ['reusable', 'ephemeral'],
    'effective persistence'
  )
  if (provider === 'ollama') {
    if (
      providerLaunchAuthority.runtime.kind !== 'http' ||
      effectiveBinary !== SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL
    ) {
      throw new TypeError('Ollama effective binary must use the canonical HTTP runtime marker.')
    }
  } else if (
    provider === ANTIGRAVITY_PROVIDER_ID &&
    providerLaunchAuthority.runtime.kind === 'in-process-sdk'
  ) {
    if (providerLaunchAuthority.runtime.hostExecutableRealPath !== effectiveBinary) {
      throw new TypeError(
        'AntiGravity effective binary does not match the in-process SDK host executable.'
      )
    }
    if (effectivePersistence !== 'reusable') {
      throw new TypeError(
        'AntiGravity in-process SDK launches require reusable host persistence.'
      )
    }
  } else {
    if (
      providerLaunchAuthority.runtime.kind !== 'cli' ||
      providerLaunchAuthority.runtime.executableRealPath !== effectiveBinary
    ) {
      throw new TypeError('Effective binary does not match the provider launch runtime.')
    }
  }
  const effectiveMcpProfileId = nullableText(
    record.effectiveMcpProfileId,
    'effective MCP profile id'
  )
  if (effectiveMcpProfileId !== providerLaunchAuthority.tools.taskWraithMcpProfileId) {
    throw new TypeError('Effective MCP profile does not match the provider launch tool surface.')
  }
  const normalized: EffectiveRuntimeLaunchAuthority = {
    schemaVersion: 1,
    provider,
    effectiveBinary,
    effectiveWorkspaceMode: oneOf(
      record.effectiveWorkspaceMode,
      ['local', 'worktree'],
      'effective workspace mode'
    ),
    effectiveMcpProfileId,
    effectiveApprovalMode: nonEmptyText(record.effectiveApprovalMode, 'effective approval mode'),
    effectiveAgenticServices: normalizeEffectiveAgenticServices(
      record.effectiveAgenticServices
    ),
    effectiveNetworkPolicy: oneOf(
      record.effectiveNetworkPolicy,
      ['allow', 'deny'],
      'effective network policy'
    ),
    effectivePersistence,
    providerLaunchAuthorityDigest: providerLaunchAuthorityDigest(providerLaunchAuthority)
  }
  return {
    authority: canonicalClone(normalized),
    providerLaunchAuthority
  }
}

/** Compatibility wrapper for no-profile callers. */
export function buildDefaultRuntimeLaunchAuthority(
  input: DefaultRuntimeLaunchAuthorityInput
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

function authorityRows(
  context: ScheduledOccurrenceCurrentContext,
  postureResolver: ScheduledOccurrencePostureResolver,
  rootId: string,
  workspaceRealPath: string
): readonly SeatAuthorityRow[] {
  const seats = context.runtimeSeats
  if (!Array.isArray(seats)) throw new TypeError('Runtime seats must be an array.')
  const requirements = runtimeRequirements(context)
  const bySeat = new Map<string, ScheduledOccurrenceRuntimeSeatContext>()
  for (const seat of seats) {
    exactPlainDataObject(
      seat,
      ['seatId', 'launchAuthority', 'resolvedEnv', 'permissionPostureCapability'],
      'runtime seat'
    )
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
    if (launch.kind === 'selected-runtime-profile') {
      exactPlainDataObject(
        launch,
        ['kind', 'profile', 'effectiveAuthority'],
        'selected runtime seat launch authority'
      )
    } else if (launch.kind === 'default-runtime') {
      exactPlainDataObject(
        launch,
        ['kind', 'effectiveAuthority'],
        'default runtime seat launch authority'
      )
    } else {
      throw new TypeError('Runtime seat launch authority kind is invalid.')
    }
    const resolvedLaunch = resolveEffectiveRuntimeLaunchAuthority(
      launch.effectiveAuthority
    )
    const effective = resolvedLaunch.authority
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
      assertSelectedProfileEffectiveReconciliation(profileAuthority, effective)
    }

    const posture = trustedPostureAuthority(
      postureResolver,
      seat.permissionPostureCapability,
      requirement,
      context.task,
      rootId,
      workspaceRealPath
    )
    assertRuntimePostureReconciliation(
      effective,
      resolvedLaunch.providerLaunchAuthority,
      posture
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
        authority: posture
      }
    }
  })
}

function assertSelectedProfileEffectiveReconciliation(
  profile: RuntimeProfileAuthority,
  effective: EffectiveRuntimeLaunchAuthority
): void {
  if (
    profile.provider === 'ollama' &&
    (profile.binaryPath !== null ||
      Object.keys(profile.env).length !== 0 ||
      profile.secretRefs.env.length !== 0)
  ) {
    throw new TypeError(
      'An Ollama HTTP runtime profile cannot carry CLI binary or environment overrides.'
    )
  }
  if (profile.workspaceMode !== effective.effectiveWorkspaceMode) {
    throw new TypeError(
      'Effective workspace mode does not match the selected runtime profile.'
    )
  }
  if (profile.persistence !== effective.effectivePersistence) {
    throw new TypeError(
      'Effective persistence does not match the selected runtime profile.'
    )
  }
  if (
    profile.mcpProfileId !== null &&
    profile.mcpProfileId !== effective.effectiveMcpProfileId
  ) {
    throw new TypeError(
      'Effective MCP profile does not match the selected runtime profile.'
    )
  }

  if (profile.approvalMode !== null) {
    const profileMode = coerceApprovalMode(profile.approvalMode)
    const effectiveMode = coerceApprovalMode(effective.effectiveApprovalMode)
    if (
      profileMode === undefined ||
      effectiveMode === undefined ||
      approvalModeRank(effectiveMode) > approvalModeRank(profileMode)
    ) {
      throw new TypeError(
        'Effective approval mode is more permissive than the selected runtime profile.'
      )
    }
  }

  for (const service of SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS) {
    const profilePolicy = profile.agenticServices[service]
    if (
      profilePolicy !== null &&
      agenticServicePolicyRank(effective.effectiveAgenticServices[service]) >
        agenticServicePolicyRank(profilePolicy)
    ) {
      throw new TypeError(
        `Effective ${service} policy is more permissive than the selected runtime profile.`
      )
    }
  }

  const profileAgenticNetwork = profile.agenticServices.networkAccess
  if (
    profileAgenticNetwork !== null &&
    networkPolicyRank(effective.effectiveNetworkPolicy) >
      networkPolicyRank(profileAgenticNetwork)
  ) {
    throw new TypeError(
      'Effective network policy is more permissive than the selected runtime profile services.'
    )
  }
  if (
    profile.networkPolicy !== 'inherit' &&
    networkPolicyRank(effective.effectiveNetworkPolicy) >
      networkPolicyRank(profile.networkPolicy)
  ) {
    throw new TypeError(
      'Effective network policy is more permissive than the selected runtime profile.'
    )
  }
}

function agenticServicePolicyRank(value: AgenticServicePolicy): number {
  switch (value) {
    case 'deny':
      return 0
    case 'ask':
      return 1
    case 'workspace':
      return 2
    case 'allow':
      return 3
  }
}

function networkPolicyRank(value: AgenticNetworkPolicy): number {
  return value === 'deny' ? 0 : 1
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

function authoritySetBytes(rows: readonly unknown[]): Buffer {
  return Buffer.from(canonicalEncode({ rows }), 'utf8')
}

function currentWorkflowDigest(
  task: ScheduledTask,
  workflow: WorkflowDefinition | null,
  phase: ScheduledOccurrenceAuthorityPhase,
  canonicalizePath: (value: string) => string,
  issuedAt: string,
  mode: ScheduledOccurrenceSealDerivationMode
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
  if (workflow.enabled !== true) {
    throw new TypeError('A linked scheduled occurrence requires an enabled workflow.')
  }
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
  const matchingExecutions = workflow.history.filter(
    (candidate) => candidate.id === executionId
  )
  if (matchingExecutions.length !== 1) {
    throw new TypeError('Scheduled workflow active execution identity must be unique.')
  }
  const execution = matchingExecutions[0]
  if (
    execution.workflowId !== workflow.id ||
    execution.scheduledTaskId !== task.id ||
    execution.plannedFor !== occurrenceAt
  ) {
    throw new TypeError('Scheduled workflow execution linkage does not match.')
  }
  if (phase.kind !== 'running') {
    throw new TypeError('Scheduled workflow authority requires a running owner.')
  }
  if (execution.status !== 'running' || execution.runId !== phase.ownerRunId) {
    throw new TypeError('Scheduled workflow execution is not owned by the running occurrence.')
  }
  assertWorkflowRunningPostImage(workflow, execution, issuedAt, mode)

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
    // state for saved-definition acknowledgements. Occurrence preflight is
    // narrower: the workflow must be enabled in the current verification
    // snapshot. A future durable authority epoch is required if disable then
    // re-enable must remain distinguishable.
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
  resolver: ScheduledOccurrencePostureResolver,
  capability: ScheduledOccurrencePostureCapability,
  requirement: RuntimeRequirement,
  task: ScheduledTask,
  rootId: string,
  workspaceRealPath: string
): ScheduledOccurrencePostureAuthority {
  const posture = resolver.consume(capability)
  if (!posture) {
    throw new TypeError('A fresh verified permission posture capability is required.')
  }
  if (
    posture.rootId !== rootId ||
    posture.workspaceId !== task.workspaceId ||
    posture.workspaceRealPath !== workspaceRealPath
  ) {
    throw new TypeError('Permission posture authority root or workspace does not match.')
  }
  const context = posture.signedPosture.context
  if (context.provider !== requirement.provider) {
    throw new TypeError('Permission posture provider does not match its runtime seat.')
  }
  if (
    context.scope !== 'workspace' ||
    context.appRunId !== task.id ||
    context.appChatId !== task.chatId ||
    context.prompt !== task.prompt ||
    context.workflowMode !== (task.workflowMode === 'plan' ? 'plan' : 'normal') ||
    context.runtimeProfileId !== requirement.runtimeProfileId
  ) {
    throw new TypeError('Permission posture context does not match its scheduled occurrence.')
  }
  const expectedPromptSha256 = createHash('sha256').update(task.prompt).digest('hex')
  if (posture.promptSha256 !== expectedPromptSha256) {
    throw new TypeError('Permission posture prompt authority does not match.')
  }
  if (
    requirement.ensembleParticipant &&
    context.ensembleParticipantId !== requirement.seatId
  ) {
    throw new TypeError('Permission posture participant does not match its runtime seat.')
  }
  if (
    (!requirement.ensembleParticipant && context.ensembleParticipantId !== null) ||
    context.ensembleLaneId !== null
  ) {
    throw new TypeError('Permission posture participant or lane authority does not match.')
  }
  if (
    posture.signedPosture.approvalMode !==
    posture.signedPosture.effectivePermissions.approvalMode
  ) {
    throw new TypeError('Permission posture approval authority does not match.')
  }
  return posture
}

function assertRuntimePostureReconciliation(
  effective: EffectiveRuntimeLaunchAuthority,
  providerLaunch: CanonicalProviderLaunchAuthority,
  posture: ScheduledOccurrencePostureAuthority
): void {
  const signed = posture.signedPosture
  const permissions = signed.effectivePermissions
  if (effective.effectiveApprovalMode !== signed.approvalMode) {
    throw new TypeError('Effective approval mode does not match the signed posture.')
  }
  if (
    !equalText(
      canonicalEncode(effective.effectiveAgenticServices),
      canonicalEncode(permissions.agenticServices)
    )
  ) {
    throw new TypeError('Effective agentic services do not match the signed posture.')
  }
  if (effective.effectiveNetworkPolicy !== permissions.networkAccess) {
    throw new TypeError('Effective network policy does not match the signed posture.')
  }
  assertProviderPostureControls(providerLaunch, signed.context, permissions)
}

function assertProviderPostureControls(
  launch: CanonicalProviderLaunchAuthority,
  context: ScheduledOccurrencePostureAuthority['signedPosture']['context'],
  permissions: ScheduledOccurrencePostureAuthority['signedPosture']['effectivePermissions']
): void {
  const readOnly = permissions.readOnly
  const approvalMode = permissions.approvalMode
  const recon =
    approvalMode === 'plan' &&
    context.workflowMode === 'normal' &&
    permissions.presetId === 'read_only' &&
    readOnly

  if (
    permissions.agenticServices.mcpTools === 'deny' &&
    launch.tools.taskWraithMcpAdvertised
  ) {
    throw new TypeError(
      'A denied MCP posture cannot advertise the TaskWraith MCP tool surface.'
    )
  }

  switch (launch.provider) {
    case 'codex': {
      const controls = launch.controls as CodexLaunchControls
      const autoEditWithoutApprovalGate =
        permissions.agenticServices.shellCommands === 'allow' &&
        permissions.agenticServices.fileChanges === 'allow' &&
        permissions.agenticServices.mcpTools === 'allow'
      const expectedApprovalPolicy =
        approvalMode === 'plan'
          ? 'never'
          : approvalMode === 'auto_edit' && autoEditWithoutApprovalGate
            ? 'never'
            : 'on-request'
      if (controls.approvalPolicy !== expectedApprovalPolicy) {
        throw new TypeError('Codex approval policy does not match the signed posture.')
      }
      if (controls.transport === 'exec-json' && expectedApprovalPolicy !== 'never') {
        throw new TypeError(
          'Codex exec transport cannot satisfy an interactive approval posture.'
        )
      }
      // ONE derivation, shared with the launcher. This used to re-derive the
      // sandbox from the raw preset and expect `danger-full-access` for a
      // full_access shell-allow run — the contract as of `40d3c2e2f`. But
      // `b34286c3e` deliberately re-enforced the workspace sandbox: a signed
      // full-access grant changes which TOOLS may be called, not how wide the
      // native filesystem sandbox is. `codexSandboxForMode` can no longer
      // return `danger-full-access` at all, so the verifier was demanding a
      // sandbox the app will never launch with, and EVERY scheduled Codex
      // occurrence at Full Access failed to seal. Calling the same function the
      // producer calls is what stops the two drifting again.
      const expectedSandbox = codexSandboxForMode(
        approvalMode,
        isFullShellAccessGranted(permissions)
      )
      if (controls.sandboxMode !== expectedSandbox) {
        throw new TypeError('Codex sandbox does not match the signed posture.')
      }
      return
    }
    case 'claude': {
      const controls = launch.controls as ClaudeLaunchControls
      if (controls.builtinToolMode !== 'disabled') {
        throw new TypeError('Scheduled Claude launches must disable provider-native tools.')
      }
      const expectedMode =
        controls.transport === 'agent-sdk' && recon
          ? 'default'
          : approvalMode === 'plan'
            ? 'plan'
            : 'acceptEdits'
      if (controls.permissionMode !== expectedMode) {
        throw new TypeError('Claude permission mode does not match the signed posture.')
      }
      return
    }
    case 'kimi': {
      const controls = launch.controls as KimiLaunchControls
      // Compile-time tripwire: the schema pins the posture literal, so bumping
      // KIMI_ACP_PRODUCTION_POSTURE_VERSION makes this comparison a ts(2367)
      // no-overlap error — a posture bump must re-decide the signed schema, not
      // silently re-mean it. Gateway-mandatory and reusable-seat rules are
      // enforced by the canonical digest invariants; read-only/plan posture
      // rides the generic TaskWraith MCP profile checks (ACP Kimi has no
      // provider-native plan flag).
      if (controls.acpPostureVersion !== KIMI_ACP_PRODUCTION_POSTURE_VERSION) {
        throw new TypeError('Kimi ACP posture version does not match the production posture.')
      }
      return
    }
    case 'grok': {
      const controls = launch.controls as GrokLaunchControls
      if (controls.readOnlySeat !== readOnly) {
        throw new TypeError('Grok read-only control does not match the signed posture.')
      }
      const expectedMode =
        controls.transport === 'acp'
          ? 'host-gated'
          : readOnly
            ? 'plan'
            : 'acceptEdits'
      if (controls.permissionMode !== expectedMode) {
        throw new TypeError('Grok permission mode does not match the signed posture.')
      }
      if (controls.webSearchEnabled) {
        throw new TypeError('Scheduled Grok launches cannot enable provider web search.')
      }
      return
    }
    case 'mistral': {
      const controls = launch.controls as MistralLaunchControls
      if (controls.readOnlySeat !== readOnly) {
        throw new TypeError('Mistral read-only control does not match the signed posture.')
      }
      // Vibe's five ACP session modes are the actual enforcement surface, so the
      // mode must agree with the posture rather than merely sit alongside it.
      // `plan` and `chat` are Vibe's read-only modes; note that `plan` is NOT
      // write-free — it writes its plan artifact to $VIBE_HOME/plans — but it
      // performs no workspace mutation, which is what `readOnly` governs here.
      const readOnlyModes: readonly MistralLaunchControls['sessionMode'][] = ['plan', 'chat']
      const isReadOnlyMode = readOnlyModes.includes(controls.sessionMode)
      if (isReadOnlyMode !== readOnly) {
        throw new TypeError('Mistral session mode does not match the signed posture.')
      }
      // `auto-approve` answers every tool request without a gate. An unattended
      // scheduled occurrence is precisely the context where that must never be
      // reachable, regardless of posture.
      if (controls.sessionMode === 'auto-approve') {
        throw new TypeError('Scheduled Mistral launches cannot use the auto-approve session mode.')
      }
      // The seat is a subscription lane. If a scheduled launch were minted on
      // the BYOK key it would bill the user's metered API line instead of their
      // plan — silently, because Vibe prefers MISTRAL_API_KEY over the plan
      // sign-in and reports no error either way.
      if (controls.credentialLane !== 'plan-oauth' || !controls.apiKeyEnvScrubbed) {
        throw new TypeError(
          'Scheduled Mistral launches must run on the plan-backed sign-in with MISTRAL_API_KEY scrubbed from the child env.'
        )
      }
      return
    }
    case 'cursor': {
      const controls = launch.controls as CursorLaunchControls
      // This seal lane currently represents ONLY final native-only Path-B
      // launches. `--sandbox enabled` is pinned for both seat tiers; a
      // read-only seat uses the exact non-mutating `--mode ask` argv while a
      // write-capable seat uses Cursor's sandboxed default. Broker-intended
      // schedules are reported unsealed before reaching this validator until
      // their dynamic setup outcome is prepared before sealing.
      if (controls.executionMode !== (readOnly ? 'ask' : 'contained-default')) {
        throw new TypeError('Cursor execution mode does not match the signed posture.')
      }
      if (controls.bridgeMode !== 'none' || launch.tools.taskWraithMcpAdvertised) {
        throw new TypeError('Contained Cursor launches do not advertise a TaskWraith MCP bridge.')
      }
      if (launch.common.sessionMode !== 'fresh') {
        throw new TypeError('Contained Cursor launches never resume a provider session.')
      }
      return
    }
    case 'ollama': {
      const controls = launch.controls as OllamaLaunchControls
      if (
        controls.readOnly !== readOnly ||
        controls.networkAccess !== permissions.networkAccess
      ) {
        throw new TypeError('Ollama controls do not match the signed posture.')
      }
      return
    }
    case 'pi': {
      const controls = launch.controls as PiLaunchControls
      const expected = resolvePiNativeToolPosture({
        approvalMode,
        effectivePermissions: permissions
      })
      if (controls.writeCapable !== expected.writeCapable) {
        throw new TypeError('Pi native tool tier does not match the signed approval posture.')
      }
      return
    }
    case 'antigravity': {
      const controls = launch.controls as
        | AntigravityOfficialAgyLaunchControls
        | AntigravityGeminiApiLaunchControls
      if (controls.transport === 'official-agy-cli') {
        const expectedMode =
          readOnly ||
          approvalMode === 'plan' ||
          permissions.agenticServices.shellCommands === 'deny' ||
          permissions.agenticServices.fileChanges === 'deny'
            ? 'plan'
            : 'accept-edits'
        if (controls.permissionMode !== expectedMode) {
          throw new TypeError(
            'AntiGravity agy permission mode does not match the signed posture.'
          )
        }
      } else {
        const expectedHistoryMode =
          context.ensembleParticipantId === null
            ? 'host-history-replay'
            : 'ensemble-context-only'
        if (controls.historyMode !== expectedHistoryMode) {
          throw new TypeError(
            'AntiGravity Gemini API history mode does not match the signed seat context.'
          )
        }
      }
      return
    }
    default:
      return assertNeverProviderLaunch(launch)
  }
}

function assertNeverProviderLaunch(value: never): never {
  throw new TypeError(`Unsupported provider launch authority: ${String(value)}`)
}

function assertOccurrencePhase(
  task: ScheduledTask,
  phase: ScheduledOccurrenceAuthorityPhase,
  issuedAt: string,
  mode: ScheduledOccurrenceSealDerivationMode
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
  const ownerRunId = trimmedText(phase.ownerRunId, 'scheduled occurrence owner run id')
  if (task.status !== 'running' || task.runId !== ownerRunId) {
    throw new TypeError('Running occurrence authority does not match the durable run owner.')
  }
  if (task.completedAt !== undefined || task.lastError !== undefined) {
    throw new TypeError('Running occurrence authority cannot carry terminal task fields.')
  }
  if (task.firedAt !== issuedAt) {
    throw new TypeError('Running occurrence firedAt must equal the seal issue time.')
  }
  if (mode === 'mint') {
    if (
      task.runningSince !== issuedAt ||
      task.updatedAt !== issuedAt ||
      task.occurrenceSeal !== undefined
    ) {
      throw new TypeError('Seal minting requires the exact unsealed claim post-image.')
    }
    return
  }
  if (
    !canonicalIsoAtOrAfter(task.runningSince, issuedAt, 'runningSince') ||
    !canonicalIsoAtOrAfter(task.updatedAt, issuedAt, 'task updatedAt')
  ) {
    throw new TypeError('Running occurrence heartbeat predates its sealed claim.')
  }
}

function assertWorkflowRunningPostImage(
  workflow: WorkflowDefinition,
  execution: NonNullable<WorkflowDefinition['history'][number]>,
  issuedAt: string,
  mode: ScheduledOccurrenceSealDerivationMode
): void {
  if (
    execution.startedAt !== issuedAt ||
    execution.completedAt !== undefined ||
    execution.error !== undefined ||
    workflow.lastStatus !== 'running' ||
    workflow.lastError !== undefined
  ) {
    throw new TypeError('Scheduled workflow is not an exact running post-image.')
  }
  if (mode === 'mint') {
    if (execution.updatedAt !== issuedAt || workflow.updatedAt !== issuedAt) {
      throw new TypeError('Seal minting requires exact workflow claim timestamps.')
    }
    return
  }
  if (
    !canonicalIsoAtOrAfter(execution.updatedAt, issuedAt, 'execution updatedAt') ||
    !canonicalIsoAtOrAfter(workflow.updatedAt, issuedAt, 'workflow updatedAt')
  ) {
    throw new TypeError('Scheduled workflow heartbeat predates its sealed claim.')
  }
}

function taskKind(task: ScheduledTask): 'single' | 'ensemble' {
  if (task.kind === undefined || task.kind === 'single') return 'single'
  if (task.kind === 'ensemble') return 'ensemble'
  throw new TypeError('Invalid scheduled task kind.')
}

function scheduledOccurrenceRootOwner(
  task: ScheduledTask,
  workflow: WorkflowDefinition | null
): ScheduledOccurrenceRootOwner {
  const kind = taskKind(task)
  if (kind === 'ensemble') {
    if (workflow?.loop) {
      throw new TypeError('An Ensemble scheduled task cannot run a maker-verifier loop.')
    }
    return 'ensemble-root'
  }
  return workflow?.loop ? 'loop-root' : 'solo'
}

function sealPayload(
  seal: ScheduledOccurrenceSealPayload | ScheduledOccurrenceSealV2
): ScheduledOccurrenceSealPayload {
  return {
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
  }
}

function sealPayloadBytes(
  seal: ScheduledOccurrenceSealPayload | ScheduledOccurrenceSealV2
): Buffer {
  return Buffer.from(canonicalEncode(sealPayload(seal)), 'utf8')
}

function normalizeSealV2(value: unknown): ScheduledOccurrenceSealV2 {
  const record = exactPlainDataObject(value, SEAL_V2_KEYS, 'scheduled occurrence seal v2')
  if (record.schemaVersion !== 2) throw new TypeError('Invalid seal schema version.')
  return Object.freeze({
    schemaVersion: 2 as const,
    rootId: rootId(record.rootId),
    issuedAt: canonicalIso(record.issuedAt, 'issuedAt'),
    ownerRunId: trimmedText(record.ownerRunId, 'ownerRunId'),
    rootOwner: oneOf(
      record.rootOwner,
      ['solo', 'loop-root', 'ensemble-root'],
      'rootOwner'
    ),
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
    sealMac: sha256Hex(record.sealMac, 'sealMac')
  })
}

function normalizeSealV1(value: unknown): ScheduledOccurrenceSealV1 {
  const record = exactPlainDataObject(
    value,
    SEAL_V1_KEYS,
    'legacy scheduled occurrence seal v1'
  )
  if (record.schemaVersion !== 1) throw new TypeError('Invalid legacy seal schema version.')
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

function hash(domain: string, value: unknown): string {
  return createHash('sha256').update(domain).update(canonicalEncode(value)).digest('hex')
}

function authorityRootId(authorityRoot: ScheduledOccurrenceAuthorityRoot): string {
  if (!authorityRoot || typeof authorityRoot !== 'object') {
    throw new TypeError('Scheduled occurrence authority root is required.')
  }
  return rootId(authorityRoot.rootId)
}

function rootId(value: unknown): string {
  if (typeof value !== 'string' || !/^twso-root-v1:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('rootId must identify a canonical scheduled occurrence authority root.')
  }
  return value
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function canonicalIsoAtOrAfter(value: unknown, minimum: string, label: string): boolean {
  try {
    return Date.parse(canonicalIso(value, label)) >= Date.parse(minimum)
  } catch {
    return false
  }
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
  // AntiGravity is conditionally offered behind existing consent/credential
  // walls, so the pure seal validator must not mistake absence from the static
  // live set for provider unavailability. Admission remains the caller's job.
  if (!isLiveSelectableProvider(provider) && provider !== ANTIGRAVITY_PROVIDER_ID) {
    throw new TypeError(`${label} is unavailable.`)
  }
  return provider
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${label} must be a bounded non-empty string.`)
  }
  return value
}

function trimmedText(value: unknown, label: string): string {
  const text = nonEmptyText(value, label)
  if (text !== text.trim() || text.includes('\0')) {
    throw new TypeError(`${label} must be trimmed text.`)
  }
  return text
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

function normalizeEffectiveAgenticServices(
  value: unknown
): Readonly<Record<AgenticServiceId, AgenticServicePolicy>> {
  const record = exactPlainDataObject(
    value,
    SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS,
    'effective agentic services'
  )
  const output = Object.create(null) as Record<AgenticServiceId, AgenticServicePolicy>
  for (const key of SCHEDULED_OCCURRENCE_POSTURE_AGENTIC_SERVICE_IDS) {
    output[key] = oneOf(
      record[key],
      ['ask', 'workspace', 'allow', 'deny'],
      `effective agentic service ${key}`
    )
  }
  return canonicalClone(output) as Readonly<
    Record<AgenticServiceId, AgenticServicePolicy>
  >
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

function equalText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
