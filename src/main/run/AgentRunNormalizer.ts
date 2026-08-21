import type { AgentRunPayload } from './AgentRunTypes'
import type {
  ActiveGoal,
  AppSettings,
  ChatRecord,
  ChatScope,
  EffectiveRunPermissions,
  ExternalPathGrant,
  GeminiWorktreeLaunchOption,
  ProviderId,
  ProviderRunReroute
} from '../store/types'
import {
  clampUntrustedRunPosture,
  isExecutionGraphAttemptPermissionPostureSignature,
  runPostureContextFromPayload,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import { normalizeActiveGoalObjective, normalizeActiveGoalSpecification } from '../GoalState'
import {
  claudeModelSupportsFastMode,
  isKimiK3Model,
  normalizeKimiReasoningEffort
} from '../providers/StaticProviderModels'
import type { ExternalPathGrantRunBindingContext } from '../ExternalPathGrantBinding'
import { parseResolvedProjectReferenceContext } from '../../shared/projectReferenceContext'
import {
  assertLiveProviderId,
  assertProviderId,
  isRecord,
  normalizeAuditRunIdentity,
  normalizeEnsembleRunIdentity,
  optionalString,
  optionalStringOrNull,
  requireNonEmptyString,
  requireRecord,
  stringArray
} from '../settings/MainSanitizers'
import { ANTIGRAVITY_PROVIDER_ID } from '../../shared/retiredProviders'

/**
 * AgentRunNormalizer — M3 orchestration-facade extraction (M3-1b, per
 * `design-m3-1b-spec`).
 *
 * `normalizeAgentRunPayload` is the universal run-dispatch trust boundary:
 * every run (renderer `run-agent`, main-built ensemble / sub-thread / solo, and
 * the legacy gemini path) flows through it. M3-1a made the 7 index.ts-scoped
 * dependencies explicit via `AgentRunNormalizerDeps` (the external-grant signing
 * secret, the AppStore singleton, Electron paths, fs realpath — all captured as
 * closures). M3-1b relocates the body here now that the seam is explicit.
 *
 * The deps bundle is still constructed in index.ts's `whenReady` and passed in,
 * so this module NEVER reads `externalGrantSigningSecret` directly and stays
 * free of Electron / AppStore coupling — it unit-tests under plain vitest with a
 * faked 7-field deps object (see AgentRunNormalizer.test.ts). Mirrors how
 * `RunCoordinator.ts` owns + exports `RunCoordinatorDeps`.
 */
export interface AgentRunNormalizerDeps {
  /** Verify an HMAC-bound run-permission-posture signature (signing secret).
   *  Currently `verifyRunPosture`. */
  verifyRunPosture: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    signature: string | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => boolean
  /** Integrity-check + canonicalize external path grants (signing secret + fs
   *  realpath). Currently `normalizeExternalPathGrants`. */
  normalizeExternalPathGrants: (grants?: ExternalPathGrant[]) => ExternalPathGrant[]
  /** Timing-safe main-issued-grant check (signing secret). Currently
   *  `isMainIssuedExternalPathGrant`. */
  isMainIssuedExternalPathGrant: (
    grant: ExternalPathGrant,
    runContext?: Omit<ExternalPathGrantRunBindingContext, 'workspaceId'> & {
      workspacePath?: string
    }
  ) => boolean
  /** Resolve + assert a saved GLOBAL chat by id (AppStore). Currently
   *  `requireGlobalChat`. */
  requireGlobalChat: (chatId: unknown, label?: string) => ChatRecord
  /** Canonical cwd for global-mode runs (Electron `app.getPath('home')`).
   *  Currently `globalRunCwd`. */
  globalRunCwd: () => string
  /** Home-expand + resolve a workspace path. Currently `canonicalPath`. */
  canonicalWorkspacePath: (value: string) => string
  /** Read current app settings for the posture re-derivation closures
   *  (AppStore). Currently `AppStore.getSettings`. */
  getSettings: () => AppSettings
}

export function normalizeAgentRunPayload(
  rawPayload: unknown,
  deps: AgentRunNormalizerDeps
): AgentRunPayload {
  const payload = requireRecord(rawPayload, 'Run payload')
  // Universal run-dispatch chokepoint (renderer + main-built ensemble / sub-thread
  // / solo all flow through here): a retired provider can never start a new run.
  // Keep normal providers and retired-provider rejection settings-free, while
  // passing persisted settings only for the one explicitly opt-in provider.
  // This preserves the normalizer's fail-closed default and avoids making a
  // renderer-supplied run eligible merely because it names a known ProviderId.
  const structuralProvider = assertProviderId(payload.provider)
  const provider =
    structuralProvider === ANTIGRAVITY_PROVIDER_ID
      ? assertLiveProviderId(structuralProvider, deps.getSettings())
      : assertLiveProviderId(structuralProvider)
  const scope: ChatScope = payload.scope === 'global' ? 'global' : 'workspace'
  const appChatId = optionalString(payload.appChatId) || optionalString(payload.chatId)
  const appRunId = optionalString(payload.appRunId)
  const rawExternalPathGrants = Array.isArray(payload.externalPathGrants)
    ? (payload.externalPathGrants as ExternalPathGrant[])
    : []
  const externalPathGrants = rawExternalPathGrants.length
    ? deps.normalizeExternalPathGrants(rawExternalPathGrants)
    : []
  if (
    rawExternalPathGrants.some(
      (grant) =>
        grant &&
        typeof grant.path === 'string' &&
        grant.issuedBy === 'main' &&
        typeof grant.signature === 'string' &&
        grant.signature.length > 0 &&
        !deps.isMainIssuedExternalPathGrant(grant as ExternalPathGrant)
    )
  ) {
    throw new Error('External path grants must be issued by TaskWraith in this app session.')
  }
  let workspace: string | undefined
  let scopedExternalPathGrants = externalPathGrants
  if (scope === 'global') {
    deps.requireGlobalChat(appChatId, 'Run global chat')
    workspace = deps.globalRunCwd()
    if (rawExternalPathGrants.length > 0) {
      throw new Error('Global chats use approval prompts instead of external path grants.')
    }
    scopedExternalPathGrants = []
  } else {
    workspace = deps.canonicalWorkspacePath(requireNonEmptyString(payload.workspace, 'Workspace'))
    for (const grant of externalPathGrants) {
      if (grant.provider !== provider) {
        throw new Error('External path grant provider does not match the dispatched provider.')
      }
      if (
        !deps.isMainIssuedExternalPathGrant(grant, {
          provider,
          appChatId,
          appRunId,
          workspacePath: workspace
        })
      ) {
        throw new Error(
          'External path grant does not match this chat, workspace, provider, or run.'
        )
      }
    }
  }
  const suppliedEffectivePermissions = isRecord(payload.effectivePermissions)
    ? (payload.effectivePermissions as unknown as EffectiveRunPermissions)
    : undefined
  const requestedWorkflowMode = payload.workflowMode === 'plan' ? 'plan' : 'normal'
  const projectReferenceContext =
    payload.projectReferenceContext === undefined
      ? null
      : parseResolvedProjectReferenceContext(payload.projectReferenceContext)
  if (payload.projectReferenceContext !== undefined && !projectReferenceContext) {
    throw new Error('Project reference context is malformed.')
  }
  const postureContext = runPostureContextFromPayload({
    provider,
    scope,
    appRunId: optionalString(payload.appRunId),
    appChatId,
    prompt: typeof payload.prompt === 'string' ? payload.prompt : String(payload.prompt ?? ''),
    resumeFallbackPrompt:
      typeof payload.resumeFallbackPrompt === 'string' ? payload.resumeFallbackPrompt : undefined,
    workflowMode: requestedWorkflowMode,
    runtimeProfileId: optionalString(payload.runtimeProfileId),
    ...(isExecutionGraphAttemptPermissionPostureSignature(
      optionalString(payload.effectivePermissionsSignature)
    )
      ? { workspacePath: workspace }
      : {}),
    ensembleRun: payload.ensembleRun,
    projectReferenceContext
  })
  const projectReferenceContextAuthorized = projectReferenceContext
    ? deps.verifyRunPosture(
        optionalString(payload.approvalMode),
        suppliedEffectivePermissions,
        optionalString(payload.effectivePermissionsSignature),
        postureContext
      )
    : false
  if (projectReferenceContext && !projectReferenceContextAuthorized) {
    throw new Error('Project reference context authorization is invalid.')
  }
  // Downgrade-only permission-posture clamp at the renderer / bridge trust
  // boundary. A validly-signed posture (stamped by a main-side producer via
  // `signRunPosture`) passes through byte-for-byte; an unsigned / forged /
  // inflated posture is clamped so it cannot auto-approve itself. This closes
  // the escalation-via-payload gap that `preserveExplicitDeny` (which only
  // stops un-denying a global deny) does not cover. See RunPermissionPosture.ts.
  const clampedPosture = clampUntrustedRunPosture(
    {
      scope,
      approvalMode: optionalString(payload.approvalMode),
      effectivePermissions: suppliedEffectivePermissions,
      signature: optionalString(payload.effectivePermissionsSignature),
      context: postureContext
    },
    {
      verify: deps.verifyRunPosture,
      reDeriveReadOnly: () =>
        resolveEffectiveRunPermissions({
          provider,
          workspacePath: scope === 'global' ? undefined : workspace,
          settings: deps.getSettings(),
          // Posture inversion (2026-08-04): the tamper/unsigned fail-safe is the
          // plan NO-ASK floor. read_only (Ask) now carries an approval surface,
          // and an untrusted payload must never gain the power to raise
          // attacker-shaped permission prompts.
          presetId: 'plan'
        }),
      reDeriveDefault: () =>
        resolveEffectiveRunPermissions({
          provider,
          workspacePath: undefined,
          settings: deps.getSettings(),
          presetId: 'default'
        })
    }
  )
  if (clampedPosture.downgraded) {
    console.warn(
      `[run-posture] clamped ${provider} run permission posture — ${clampedPosture.reason}`
    )
  }
  return {
    provider,
    providerReroute: normalizeProviderRunReroute(payload.providerReroute, provider),
    scope,
    workspace,
    prompt: typeof payload.prompt === 'string' ? payload.prompt : String(payload.prompt ?? ''),
    usagePromptText:
      typeof payload.usagePromptText === 'string' ? payload.usagePromptText : undefined,
    resumeFallbackPrompt: optionalString(payload.resumeFallbackPrompt),
    instructionsDigest: optionalString(payload.instructionsDigest),
    activeGoal: normalizeAgentRunActiveGoal(payload.activeGoal),
    appRunId,
    appChatId,
    model: optionalString(payload.model),
    reasoningEffort:
      provider === 'kimi'
        ? normalizeKimiReasoningEffort(
            optionalString(payload.model),
            optionalStringOrNull(payload.reasoningEffort)
          )
        : optionalStringOrNull(payload.reasoningEffort),
    serviceTier:
      provider === 'kimi' && isKimiK3Model(optionalString(payload.model))
        ? 'standard'
        : optionalStringOrNull(payload.serviceTier),
    claudeReasoningEffort: optionalStringOrNull(payload.claudeReasoningEffort),
    claudeFastMode:
      provider === 'claude' &&
      claudeModelSupportsFastMode(optionalString(payload.model)) &&
      typeof payload.claudeFastMode === 'boolean'
        ? payload.claudeFastMode
        : undefined,
    // Current K2.7 Coding and K3 models both advertise always_thinking. Ignore
    // stale persisted/off inputs at the universal dispatch boundary.
    kimiThinking: provider === 'kimi' ? true : undefined,
    approvalMode: clampedPosture.approvalMode,
    workflowMode: clampedPosture.downgraded ? 'normal' : requestedWorkflowMode,
    imagePaths: stringArray(payload.imagePaths),
    providerSessionId: optionalStringOrNull(payload.providerSessionId),
    externalPathGrants: scopedExternalPathGrants,
    ...(projectReferenceContextAuthorized && projectReferenceContext
      ? { projectReferenceContext }
      : {}),
    sessionTrust: Boolean(payload.sessionTrust),
    geminiWorktree: (payload.geminiWorktree ?? null) as GeminiWorktreeLaunchOption,
    runtimeProfileId: optionalString(payload.runtimeProfileId),
    geminiAuthProfileId: optionalStringOrNull(payload.geminiAuthProfileId),
    handoffSourceRunId: optionalString(payload.handoffSourceRunId),
    failoverHopCount:
      typeof payload.failoverHopCount === 'number' && Number.isFinite(payload.failoverHopCount)
        ? payload.failoverHopCount
        : undefined,
    runtimeWorktree: normalizeRuntimeWorktreeIntent(payload.runtimeWorktree),
    effectivePermissions: clampedPosture.effectivePermissions,
    effectivePermissionsSignature: clampedPosture.signature,
    ensembleRun: normalizeEnsembleRunIdentity(payload.ensembleRun),
    auditRun: normalizeAuditRunIdentity(payload.auditRun)
  }
}

function normalizeProviderRunReroute(
  value: unknown,
  provider: ProviderId
): ProviderRunReroute | undefined {
  if (!isRecord(value)) return undefined
  let from: ProviderId
  let to: ProviderId
  try {
    from = assertProviderId(value.from)
    to = assertProviderId(value.to)
  } catch {
    return undefined
  }
  if (
    from === to ||
    to !== provider ||
    (value.reason !== 'provider-paused' && value.reason !== 'user-failover')
  ) {
    return undefined
  }
  return {
    from,
    to,
    reason: value.reason,
    ...(typeof value.savedAsDefault === 'boolean' ? { savedAsDefault: value.savedAsDefault } : {})
  }
}

function normalizeRuntimeWorktreeIntent(value: unknown): AgentRunPayload['runtimeWorktree'] {
  if (!isRecord(value)) return undefined
  const effectiveWorkspacePath = optionalString(value.effectiveWorkspacePath)
  const baseWorkspacePath = optionalString(value.baseWorkspacePath)
  const status =
    value.status === 'selected' && effectiveWorkspacePath ? 'selected' : 'selection-required'
  const source =
    value.source === 'composer'
      ? 'composer'
      : value.source === 'ensembleLane'
        ? 'ensembleLane'
        : value.source === 'ephemeralFleet'
          ? 'ephemeralFleet'
          : 'runtimeProfile'
  return {
    requested: value.requested !== false,
    source,
    profileId: optionalString(value.profileId),
    profileName: optionalString(value.profileName),
    baseWorkspacePath,
    effectiveWorkspacePath: status === 'selected' ? effectiveWorkspacePath : undefined,
    status
  }
}

function normalizeAgentRunActiveGoal(value: unknown): ActiveGoal | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const id = optionalString(value.id)
  const objective = normalizeActiveGoalObjective(value.objective)
  const status = optionalString(value.status)
  const mode = optionalString(value.mode)
  const createdAt = optionalString(value.createdAt)
  const updatedAt = optionalString(value.updatedAt)
  if (!id || !objective || !createdAt || !updatedAt) return undefined
  if (
    status !== 'active' &&
    status !== 'paused' &&
    status !== 'blocked' &&
    status !== 'completed'
  ) {
    return undefined
  }
  if (
    mode !== 'codex_native' &&
    mode !== 'claude_native' &&
    mode !== 'grok_native' &&
    mode !== 'taskwraith_steered' &&
    mode !== 'ollama_harness'
  ) {
    return undefined
  }
  let provider: ProviderId
  try {
    provider = assertProviderId(value.provider)
  } catch {
    return undefined
  }
  const objectiveSource = optionalString(value.objectiveSource)
  const specification = normalizeActiveGoalSpecification(value.specification)
  return {
    id,
    objective,
    ...(objectiveSource === 'user' || objectiveSource === 'agent' ? { objectiveSource } : {}),
    ...(specification ? { specification } : {}),
    status,
    mode,
    provider,
    createdAt,
    updatedAt,
    ...(normalizeGoalRuntimeLedger(value.runtimeLedger)
      ? { runtimeLedger: normalizeGoalRuntimeLedger(value.runtimeLedger) }
      : {}),
    pausedAt: optionalString(value.pausedAt),
    blockedAt: optionalString(value.blockedAt),
    blockedReason: optionalString(value.blockedReason),
    completedAt: optionalString(value.completedAt),
    completedSummary: optionalString(value.completedSummary),
    lastStatusReason: optionalString(value.lastStatusReason)
  }
}

function normalizeGoalRuntimeLedger(value: unknown): ActiveGoal['runtimeLedger'] | undefined {
  if (!isRecord(value)) return undefined
  const startedAt = optionalString(value.startedAt)
  if (!startedAt) return undefined
  const intervalsValue = value.intervals
  if (!Array.isArray(intervalsValue)) return undefined
  const intervals: NonNullable<ActiveGoal['runtimeLedger']>['intervals'] = intervalsValue
    .map((entry) => {
      if (!isRecord(entry)) return null
      const status = optionalString(entry.status)
      if (status !== 'active' && status !== 'paused' && status !== 'blocked') return null
      const intervalStatus: NonNullable<
        ActiveGoal['runtimeLedger']
      >['intervals'][number]['status'] = status
      const intervalStartedAt = optionalString(entry.startedAt)
      if (!intervalStartedAt) return null
      return {
        status: intervalStatus,
        startedAt: intervalStartedAt,
        ...(optionalString(entry.endedAt) ? { endedAt: optionalString(entry.endedAt) } : {})
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  if (intervals.length === 0) return undefined
  const endedAt = optionalString(value.endedAt)
  const endStatus = optionalString(value.endStatus)
  return {
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(endStatus === 'completed' || endStatus === 'cancelled' ? { endStatus } : {}),
    intervals
  }
}
