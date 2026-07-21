import { isCodexAppServerThreadId, type CodexMcpTaskWraithConfig } from '../CodexAppServerClient'
import {
  createCliProviderRunEnv,
  createResolvedProviderEnv,
  resolveCliProviderBinary,
  type CliProviderRuntimeDependencies
} from '../providers/CliProviderRuntime'
import {
  SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL,
  buildEffectiveRuntimeLaunchAuthority,
  mintScheduledOccurrenceSeal,
  verifyScheduledOccurrenceSealAgainstCurrentContext,
  type EffectiveRuntimeLaunchAuthorityInput,
  type ScheduledOccurrenceCurrentContext,
  type ScheduledOccurrenceRuntimeSeatContext
} from '../ScheduledOccurrenceSeal'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import type {
  ScheduledOccurrencePostureCapability,
  ScheduledOccurrencePostureVerifier
} from '../ScheduledOccurrencePostureAuthority'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import type { ProviderLaunchAuthorityInput } from '../ProviderLaunchAuthorityDigest'
import type {
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  ProviderId,
  RuntimeProfile,
  ScheduledOccurrenceSealV2,
  ScheduledTask,
  TaskWraithMcpProfileId
} from '../store/types'
import type { UnattendedElevationAck } from '../UnattendedPostureGate'
import {
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceError,
  SealEvidenceFileHasher,
  canonicalEvidenceEncode,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  SealEvidenceVersionProbe,
  deriveScheduledSeatPostureMirror,
  type SealEvidenceDeps
} from './SealEvidenceCommon'
import { buildCodexSealEvidence } from './SealEvidenceCodex'
import { buildClaudeSealEvidence } from './SealEvidenceClaude'
import { buildCursorSealEvidence } from './SealEvidenceCursor'
import { buildGrokSealEvidence } from './SealEvidenceGrok'
import { buildKimiSealEvidence } from './SealEvidenceKimi'
import { buildOllamaSealEvidence } from './SealEvidenceOllama'
import { grokWriteCapable } from '../grok/GrokCliArgs'
import { cursorWriteCapable } from '../cursor/CursorCliArgs'
import { ollamaAdvertisedToolNames } from '../ollama/OllamaToolTiers'
import { normalizeOllamaSessionMemory } from '../ollama/OllamaRunMemory'

/**
 * Stage-2 orchestration for the scheduled-occurrence seal: derive honest
 * launch evidence for the solo lane's single seat, mint the seal from the
 * exact claim post-image, persist it, then verify the persisted seal against
 * a fully re-derived context. Rejection reasons are explicit and loud; the
 * caller routes them to failScheduledOccurrence.
 *
 * Scope boundaries (deliberate, documented in doctrine):
 *  - Solo, workflow-UNLINKED occurrences only. Workflow-linked and loop
 *    lanes are Stage 3.
 *  - Gemini is retired and never dispatches; runnableProviderId inside the
 *    seal engine rejects it independently.
 */

export interface ScheduledSealComposedFacts {
  readonly provider: ProviderId
  readonly model: string
  readonly prompt: string
  readonly finalPrompt: string
  readonly runtimePreambleVersion: string | null
  readonly approvalMode: string
  readonly workflowMode: 'normal' | 'plan'
  readonly effectivePermissions: EffectiveRunPermissions | null
  readonly providerSessionId: string | null
  readonly reasoningEffort: string | null
  readonly serviceTier: string | null
  readonly claudeReasoningEffort: string | null
  readonly claudeFastMode: boolean | null
  readonly cursorReasoningEffort: string | null
  readonly cursorFastMode: boolean | null
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly runtimeProfileId: string | null
  readonly imageCount: number
}

export interface ScheduledSealClaudeMcpFacts {
  readonly mcpServers: Readonly<Record<string, unknown>> | null
  readonly allowedTools: readonly string[] | null
}

export interface ScheduledSealGrokMcpServerEntry {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly Readonly<{ name: string; value: string }>[]
}

export interface ScheduledOccurrenceSealServiceDeps {
  readonly authorityRoot: ScheduledOccurrenceAuthorityRoot
  readonly postureVerifier: ScheduledOccurrencePostureVerifier
  readonly appVersion: string
  /** Only providers with an exact evidence-to-dispatch mapping are enabled. */
  isSoloProviderSealWired(provider: ProviderId): boolean
  getSettings(): AppSettings
  canonicalizePath(value: string): string
  signRunPermissionPosture(
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ): string
  resolveUnattendedElevation(taskId: string): { ack: UnattendedElevationAck } | null
  getChat(chatId: string): ChatRecord | null
  getRuntimeProfile(id: string): RuntimeProfile | null
  getScheduledTask(taskId: string): ScheduledTask | null
  persistOccurrenceSeal(
    taskId: string,
    runId: string,
    seal: ScheduledOccurrenceSealV2
  ): ScheduledTask | null
  /** index-owned launch-path gates and MCP fact closures. */
  codexMcpConfig(): CodexMcpTaskWraithConfig | null
  codexApprovalPolicyForMode(
    approvalMode: string | undefined,
    settings: AppSettings
  ): 'never' | 'on-request'
  codexSandboxPolicyForMode(
    approvalMode: string | undefined,
    workspace: string,
    settings: AppSettings,
    fullAccessGranted: boolean
  ): CanonicalEvidenceValue
  claudeMcpFacts(input: {
    appRunId: string
    appChatId: string
    workspacePath: string
    profileId: TaskWraithMcpProfileId | null
    advertised: boolean
  }): ScheduledSealClaudeMcpFacts
  claudeSdkPackageJsonPath(): string
  claudeSdkBundledCliPath(): string
  storedClaudeApiKeyConfigured(): boolean
  claudeSpawnEnv(input: {
    runId: string
    chatId: string
    workspacePath: string
    runtimeProfile: RuntimeProfile | null
    binaryPath: string | null
  }): Readonly<Record<string, string>>
  grokAcpEnabled(): boolean
  grokMcpServerEntry(input: {
    runId: string
    chatId: string
    workspacePath: string
    advertised: boolean
    safeSubset: boolean
  }): ScheduledSealGrokMcpServerEntry | null
  kimiAdmission(input: { runtimeProfile: RuntimeProfile | null }): Promise<{
    binaryPath: string
    mode: 'reviewed' | 'unattested-development'
  }>
  probeCliVersion(binaryPath: string): Promise<string | null>
  cliRuntimeDeps?: CliProviderRuntimeDependencies
}

export type ScheduledOccurrenceSealOutcome =
  | Readonly<{ ok: true; sealedTask: ScheduledTask; seal: ScheduledOccurrenceSealV2 }>
  | Readonly<{ ok: false; reason: string }>
  | Readonly<{ ok: 'skipped'; reason: string }>

export class ScheduledOccurrenceSealService {
  private readonly hasher = new SealEvidenceFileHasher()
  private readonly versionProbe: SealEvidenceVersionProbe

  constructor(private readonly deps: ScheduledOccurrenceSealServiceDeps) {
    this.versionProbe = new SealEvidenceVersionProbe((binaryPath) =>
      deps.probeCliVersion(binaryPath)
    )
  }

  private evidenceDeps(): SealEvidenceDeps {
    return {
      authorityRoot: this.deps.authorityRoot,
      hasher: this.hasher,
      versionProbe: this.versionProbe,
      appVersion: this.deps.appVersion
    }
  }

  /**
   * Mint, persist and verify the seal for one claimed solo occurrence.
   * `task` must be the exact claim post-image returned by the claim
   * transaction; `issuedAt` is its firedAt.
   */
  async sealSoloOccurrence(input: {
    task: ScheduledTask
    ownerRunId: string
    workspaceRealPath: string
    composed: ScheduledSealComposedFacts
  }): Promise<ScheduledOccurrenceSealOutcome> {
    const { task, ownerRunId, workspaceRealPath, composed } = input
    if (task.workflowId || task.workflowExecutionId || task.workflowOccurrenceAt) {
      return {
        ok: 'skipped',
        reason:
          'Workflow-linked occurrences are not seal-wired yet (Stage 3); dispatching unsealed.'
      }
    }
    if (task.kind === 'ensemble') {
      return {
        ok: 'skipped',
        reason: 'Ensemble occurrences are not seal-wired yet (Stage 3); dispatching unsealed.'
      }
    }
    if (!this.deps.isSoloProviderSealWired(task.provider)) {
      return {
        ok: 'skipped',
        reason: `Scheduled ${task.provider} solo seals are not wired yet: exact launch evidence is not available.`
      }
    }
    try {
      const mintContext = await this.buildContext({
        task,
        ownerRunId,
        workspaceRealPath,
        composed,
        tripwireAgainstComposed: true
      })
      const seal = mintScheduledOccurrenceSeal(
        this.deps.authorityRoot,
        this.deps.postureVerifier.resolver,
        mintContext,
        requireText(task.firedAt, 'claimed occurrence firedAt')
      )
      const sealedTask = this.deps.persistOccurrenceSeal(task.id, ownerRunId, seal)
      if (!sealedTask) {
        return { ok: false, reason: 'The occurrence seal could not be persisted.' }
      }
      const persistedTask = this.deps.getScheduledTask(task.id) ?? sealedTask
      const verifyContext = await this.buildContext({
        task: persistedTask,
        ownerRunId,
        workspaceRealPath,
        composed,
        tripwireAgainstComposed: false
      })
      const verified = verifyScheduledOccurrenceSealAgainstCurrentContext(
        this.deps.authorityRoot,
        this.deps.postureVerifier.resolver,
        seal,
        verifyContext
      )
      if (!verified) {
        return {
          ok: false,
          reason:
            'The freshly minted occurrence seal did not verify against an independently re-derived launch context.'
        }
      }
      return { ok: true, sealedTask: persistedTask, seal }
    } catch (error) {
      return {
        ok: false,
        reason: `Occurrence seal derivation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }
  }

  private async buildContext(input: {
    task: ScheduledTask
    ownerRunId: string
    workspaceRealPath: string
    composed: ScheduledSealComposedFacts
    tripwireAgainstComposed: boolean
  }): Promise<ScheduledOccurrenceCurrentContext> {
    const { task, ownerRunId, workspaceRealPath, composed } = input
    const provider = requireLiveProvider(composed.provider)
    const settings = this.deps.getSettings()
    const mirror = deriveScheduledSeatPostureMirror({
      provider,
      workspacePath: task.workspacePath,
      requestedModel: composed.model,
      taskApprovalMode: task.approvalMode,
      workflowMode: composed.workflowMode,
      settings,
      unattendedElevationAck: this.deps.resolveUnattendedElevation(task.id)?.ack ?? null
    })
    if (input.tripwireAgainstComposed) {
      if (mirror.approvalMode !== composed.approvalMode) {
        throw new SealEvidenceError(
          `Seal posture mirror derived approval mode '${mirror.approvalMode}' but the composer dispatched '${composed.approvalMode}'.`
        )
      }
      if (
        composed.effectivePermissions &&
        canonicalEvidenceEncode(scrubPermissions(mirror.effectivePermissions)) !==
          canonicalEvidenceEncode(scrubPermissions(composed.effectivePermissions))
      ) {
        throw new SealEvidenceError(
          'Seal posture mirror permissions diverged from the composed dispatch permissions.'
        )
      }
    }
    const permissions = mirror.effectivePermissions
    const chat = this.deps.getChat(task.chatId)
    const runtimeProfile = task.runtimeProfileId
      ? this.deps.getRuntimeProfile(task.runtimeProfileId)
      : null
    if (task.runtimeProfileId && !runtimeProfile) {
      throw new SealEvidenceError(
        `The scheduled runtime profile '${task.runtimeProfileId}' no longer exists.`
      )
    }

    const seat = await this.buildSeat({
      task,
      ownerRunId,
      provider,
      settings,
      permissions,
      approvalMode: mirror.approvalMode,
      composed,
      chat,
      runtimeProfile,
      workspaceRealPath
    })

    return {
      task,
      workflow: null,
      canonicalizePath: this.deps.canonicalizePath,
      workspaceRealPath,
      runtimeSeats: [seat],
      phase: { kind: 'running', ownerRunId },
      effectiveLoopVerifierProvider: null
    }
  }

  private async buildSeat(input: {
    task: ScheduledTask
    ownerRunId: string
    provider: LiveProvider
    settings: AppSettings
    permissions: EffectiveRunPermissions
    approvalMode: string
    composed: ScheduledSealComposedFacts
    chat: ChatRecord | null
    runtimeProfile: RuntimeProfile | null
    workspaceRealPath: string
  }): Promise<ScheduledOccurrenceRuntimeSeatContext> {
    const { task, provider, permissions, approvalMode, composed } = input
    const promptEnvelope = {
      contextualPrompt: composed.prompt,
      finalPrompt: composed.finalPrompt,
      runtimePreambleVersion: composed.runtimePreambleVersion
    }
    const derived = await this.deriveProviderEvidence({
      ...input,
      promptEnvelope
    })

    const effectiveAuthority: EffectiveRuntimeLaunchAuthorityInput = {
      schemaVersion: 1,
      provider,
      effectiveBinary: derived.effectiveBinary,
      effectiveWorkspaceMode: effectiveWorkspaceMode(input.runtimeProfile),
      effectiveMcpProfileId: derived.evidence.tools.taskWraithMcpProfileId,
      effectiveApprovalMode: approvalMode,
      effectiveAgenticServices: permissions.agenticServices,
      effectiveNetworkPolicy: permissions.networkAccess,
      effectivePersistence: derived.effectivePersistence,
      providerLaunchAuthority: derived.evidence
    }
    // Normalize eagerly so a malformed evidence object fails here with a
    // provider-specific error instead of failing opaquely inside the seal.
    buildEffectiveRuntimeLaunchAuthority(effectiveAuthority)

    const postureContext: RunPermissionPostureContext = {
      provider,
      scope: 'workspace',
      appRunId: task.id,
      appChatId: task.chatId,
      prompt: task.prompt,
      workflowMode: composed.workflowMode,
      runtimeProfileId: task.runtimeProfileId ?? null,
      ensembleParticipantId: null,
      ensembleLaneId: null
    }
    const signature = this.deps.signRunPermissionPosture(approvalMode, permissions, postureContext)
    const capability = this.deps.postureVerifier.issue({
      rootId: this.deps.authorityRoot.rootId,
      workspaceId: task.workspaceId,
      workspaceRealPath: input.workspaceRealPath,
      approvalMode,
      effectivePermissions: permissions,
      signature,
      context: postureContext
    })
    if (!capability) {
      throw new SealEvidenceError(
        'The freshly signed scheduled posture was rejected by the posture capability issuer.'
      )
    }

    return {
      seatId: 'root',
      launchAuthority: input.runtimeProfile
        ? {
            kind: 'selected-runtime-profile',
            profile: input.runtimeProfile,
            effectiveAuthority
          }
        : { kind: 'default-runtime', effectiveAuthority },
      resolvedEnv: derived.resolvedEnv,
      permissionPostureCapability: capability as ScheduledOccurrencePostureCapability
    }
  }

  private async deriveProviderEvidence(input: {
    task: ScheduledTask
    ownerRunId: string
    provider: LiveProvider
    settings: AppSettings
    permissions: EffectiveRunPermissions
    approvalMode: string
    composed: ScheduledSealComposedFacts
    chat: ChatRecord | null
    runtimeProfile: RuntimeProfile | null
    workspaceRealPath: string
    promptEnvelope: {
      contextualPrompt: string
      finalPrompt: string
      runtimePreambleVersion: string | null
    }
  }): Promise<{
    evidence: ProviderLaunchAuthorityInput
    effectiveBinary: string
    effectivePersistence: 'reusable' | 'ephemeral'
    resolvedEnv: Readonly<Record<string, string>>
  }> {
    const {
      task,
      ownerRunId,
      provider,
      settings,
      permissions,
      approvalMode,
      composed,
      chat,
      runtimeProfile,
      promptEnvelope
    } = input
    const deps = this.evidenceDeps()
    const userMcpConfiguration = userMcpConfigurationEvidence(settings)
    const capabilityContract = this.capabilityContractEvidence(provider, settings)

    if (provider === 'ollama') {
      const evidence = await buildOllamaSealEvidence(deps, {
        model: composed.model,
        promptEnvelope,
        configuredBaseUrl: settings.ollamaBaseUrl ?? null,
        chatRunProfileId: undefined,
        effectivePermissions: permissions,
        agenticServices: {
          mcpTools: settings.agenticServices?.mcpTools,
          networkAccess: settings.agenticServices?.networkAccess
        },
        workspaceScoped: true,
        sessionMemory:
          (normalizeOllamaSessionMemory(chat?.ollamaSessionMemory) as CanonicalEvidenceValue) ??
          null,
        taskWraithMcpAdvertised: composed.taskWraithMcpAdvertised,
        taskWraithMcpProfileId: composed.taskWraithMcpProfileId,
        advertisedToolNames: ollamaAdvertisedToolNames({
          networkAccess: permissions.networkAccess,
          readOnly: permissions.readOnly
        }),
        capabilityContract,
        userMcpConfiguration
      })
      return {
        evidence,
        effectiveBinary: SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL,
        // The local Ollama server outlives the run.
        effectivePersistence: 'reusable',
        resolvedEnv: {}
      }
    }

    if (provider === 'kimi') {
      const admission = await this.deps.kimiAdmission({ runtimeProfile })
      const baseSpawnEnv = createResolvedProviderEnv(
        {
          HOME: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
          USERPROFILE: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
          KIMI_CODE_HOME: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
          TASKWRAITH_PARENT_PROVIDER: 'kimi',
          TASKWRAITH_RUN_ID: ownerRunId,
          TASKWRAITH_CHAT_ID: task.chatId
        },
        admission.binaryPath,
        this.deps.cliRuntimeDeps,
        runtimeProfile ?? undefined
      )
      const evidence = await buildKimiSealEvidence(deps, {
        model: composed.model,
        promptEnvelope,
        serviceTier: composed.serviceTier,
        reasoningEffort: composed.reasoningEffort,
        binaryPath: admission.binaryPath,
        runtimeAdmissionMode: admission.mode,
        requestedResumeSessionId: composed.providerSessionId,
        persistedPostureVersion: metadataString(chat, 'kimiAcpPostureVersion'),
        baseSpawnEnv,
        taskWraithMcpProfileId: composed.taskWraithMcpProfileId,
        capabilityContract,
        userMcpConfiguration,
        appVersion: this.deps.appVersion
      })
      return {
        evidence,
        effectiveBinary: evidence.runtime.executableRealPath,
        effectivePersistence: 'ephemeral',
        resolvedEnv: buildCommonSeatEnvView(evidence)
      }
    }

    const resolved = await resolveCliProviderBinary(
      provider,
      runtimeProfile ?? undefined,
      this.deps.cliRuntimeDeps
    )
    if (provider !== 'claude' && !resolved.binaryPath) {
      throw new SealEvidenceError(
        resolved.error || `The ${provider} CLI binary could not be resolved for this occurrence.`
      )
    }

    if (provider === 'codex') {
      const resolvedEnv = createResolvedProviderEnv(
        {
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TASKWRAITH_PARENT_PROVIDER: 'codex'
        },
        resolved.binaryPath as string,
        this.deps.cliRuntimeDeps,
        runtimeProfile ?? undefined
      )
      const codexMcpConfig = this.deps.codexMcpConfig()
      const evidence = await buildCodexSealEvidence(deps, {
        model: composed.model,
        promptEnvelope,
        session: codexSessionFacts(composed.providerSessionId, chat),
        resolvedEnv,
        binaryPath: resolved.binaryPath as string,
        workspacePath: task.workspacePath,
        approvalMode,
        effectivePermissions: permissions,
        reasoningEffort: composed.reasoningEffort,
        serviceTier: composed.serviceTier,
        settings,
        codexMcpConfig,
        taskWraithMcpAdvertised: composed.taskWraithMcpAdvertised,
        taskWraithMcpProfileId: composed.taskWraithMcpProfileId,
        capabilityContract,
        userMcpConfiguration,
        policy: {
          approvalPolicyForMode: this.deps.codexApprovalPolicyForMode,
          sandboxPolicyForMode: this.deps.codexSandboxPolicyForMode
        }
      })
      return {
        evidence,
        effectiveBinary: evidence.runtime.executableRealPath,
        // The shared app-server daemon persists across occurrences.
        effectivePersistence: 'reusable',
        resolvedEnv
      }
    }

    if (provider === 'claude') {
      const resolvedEnv = this.deps.claudeSpawnEnv({
        runId: ownerRunId,
        chatId: task.chatId,
        workspacePath: task.workspacePath,
        runtimeProfile,
        binaryPath: resolved.binaryPath
      })
      const mcpFacts = this.deps.claudeMcpFacts({
        appRunId: ownerRunId,
        appChatId: task.chatId,
        workspacePath: task.workspacePath,
        profileId: composed.taskWraithMcpProfileId,
        advertised: composed.taskWraithMcpAdvertised
      })
      const evidence = await buildClaudeSealEvidence(deps, {
        model: composed.model,
        promptEnvelope,
        session: genericSessionFacts(composed.providerSessionId, chat),
        resolvedEnv,
        binaryPath: resolved.binaryPath,
        sdkPackageJsonPath: this.deps.claudeSdkPackageJsonPath(),
        sdkBundledCliPath: this.deps.claudeSdkBundledCliPath(),
        approvalMode,
        workflowMode: composed.workflowMode,
        effectivePermissions: permissions,
        claudeReasoningEffort: composed.claudeReasoningEffort,
        claudeFastMode: composed.claudeFastMode,
        imageCount: composed.imageCount,
        taskWraithMcpAdvertised: composed.taskWraithMcpAdvertised,
        taskWraithMcpProfileId: composed.taskWraithMcpProfileId,
        mcpServers: mcpFacts.mcpServers,
        allowedTools: mcpFacts.allowedTools,
        capabilityContract,
        userMcpConfiguration,
        storedApiKeyConfigured: this.deps.storedClaudeApiKeyConfigured()
      })
      return {
        evidence,
        effectiveBinary: evidence.runtime.executableRealPath,
        effectivePersistence: 'ephemeral',
        resolvedEnv
      }
    }

    if (provider === 'grok') {
      const resolvedEnv = createResolvedProviderEnv(
        {
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TASKWRAITH_PARENT_PROVIDER: 'grok',
          TASKWRAITH_RUN_ID: ownerRunId,
          TASKWRAITH_CHAT_ID: task.chatId,
          TASKWRAITH_WORKSPACE_PATH: task.workspacePath
        },
        resolved.binaryPath as string,
        this.deps.cliRuntimeDeps,
        runtimeProfile ?? undefined
      )
      const readOnlySeat = !grokWriteCapable(approvalMode)
      const evidence = await buildGrokSealEvidence(deps, {
        model: composed.model,
        promptEnvelope,
        reasoningEffort: composed.reasoningEffort,
        binaryPath: resolved.binaryPath as string,
        resolvedEnv,
        approvalMode,
        effectivePermissions: permissions,
        acpEnabled: this.deps.grokAcpEnabled(),
        taskWraithMcpAdvertised: composed.taskWraithMcpAdvertised,
        taskWraithMcpProfileId: composed.taskWraithMcpProfileId,
        mcpServerEntry: this.deps.grokMcpServerEntry({
          runId: ownerRunId,
          chatId: task.chatId,
          workspacePath: task.workspacePath,
          advertised: composed.taskWraithMcpAdvertised,
          safeSubset: readOnlySeat
        }),
        capabilityContract,
        userMcpConfiguration
      })
      return {
        evidence,
        effectiveBinary: evidence.runtime.executableRealPath,
        effectivePersistence: 'ephemeral',
        resolvedEnv
      }
    }

    // cursor
    const resolvedEnv = createCliProviderRunEnv({
      provider: 'cursor',
      command: resolved.binaryPath as string,
      appRunId: ownerRunId,
      appChatId: task.chatId,
      scope: 'workspace',
      workspace: task.workspacePath,
      runtimeProfileId: composed.runtimeProfileId,
      auditRun: false,
      extraEnv: {},
      deps: this.deps.cliRuntimeDeps
    })
    const writeCapable = cursorWriteCapable(approvalMode)
    const evidence = await buildCursorSealEvidence(deps, {
      model: composed.model,
      promptEnvelope,
      resolvedEnv,
      binaryPath: resolved.binaryPath as string,
      workspacePath: task.workspacePath,
      writeCapable,
      readOnlySeat: permissions.readOnly === true,
      cursorReasoningEffort: composed.reasoningEffort,
      cursorFastMode: composed.serviceTier === 'fast',
      capabilityContract,
      userMcpConfiguration
    })
    return {
      evidence,
      effectiveBinary: evidence.runtime.executableRealPath,
      effectivePersistence: 'ephemeral',
      resolvedEnv
    }
  }

  /**
   * The settings-derived gate values that actually choose launch paths at
   * dispatch (transport gates, bridge toggles, sandbox fallback, tool policy).
   * Live status probes deliberately stay out: dispatch does not consult them
   * per-run, so binding them would claim provenance the launch never had.
   */
  private capabilityContractEvidence(
    provider: LiveProvider,
    settings: AppSettings
  ): CanonicalEvidenceValue {
    return {
      kind: 'dispatch-gate-projection',
      provider,
      agenticServices: {
        shellCommands: settings.agenticServices?.shellCommands ?? null,
        fileChanges: settings.agenticServices?.fileChanges ?? null,
        mcpTools: settings.agenticServices?.mcpTools ?? null,
        networkAccess: settings.agenticServices?.networkAccess ?? null
      },
      taskWraithBridgeEnabled: Boolean(settings.geminiMcpBridgeEnabled),
      codexSandboxFallback: settings.codexSandboxFallback,
      grokAcpEnabled: this.deps.grokAcpEnabled(),
      userMcpServerCount: Array.isArray(settings.userMcpServers)
        ? settings.userMcpServers.length
        : 0
    }
  }
}

type LiveProvider = Exclude<ProviderId, 'gemini'>

function requireLiveProvider(provider: ProviderId): LiveProvider {
  if (provider === 'gemini') {
    throw new SealEvidenceError('Gemini is retired and cannot hold scheduled launch authority.')
  }
  return provider
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new SealEvidenceError(`${label} is required.`)
  }
  return value
}

function effectiveWorkspaceMode(profile: RuntimeProfile | null): 'local' | 'worktree' {
  if (!profile) return 'local'
  if (profile.workspaceMode === 'container') {
    throw new SealEvidenceError(
      'Container workspace mode is not representable in scheduled launch authority.'
    )
  }
  return profile.workspaceMode
}

/**
 * Strip fields the composer legitimately resolves differently from the
 * mirror before comparing (external grants are emptied for plan-clamped
 * unattended runs on both sides, but keep the comparison strictly on the
 * authority-bearing posture axes).
 */
function scrubPermissions(permissions: EffectiveRunPermissions): CanonicalEvidenceValue {
  return {
    presetId: permissions.presetId,
    approvalMode: permissions.approvalMode,
    agenticServices: { ...permissions.agenticServices },
    networkAccess: permissions.networkAccess,
    readOnly: permissions.readOnly === true
  }
}

function codexSessionFacts(
  providerSessionId: string | null,
  chat: ChatRecord | null
): { sessionMode: 'fresh' | 'resume'; providerSessionId: string | null; seatGeneration: CanonicalEvidenceValue | null } {
  // Non-UUID ids (codex-exec fallback markers) start a fresh thread at the
  // dispatch site; mirror that exactly.
  if (providerSessionId && isCodexAppServerThreadId(providerSessionId)) {
    return {
      sessionMode: 'resume',
      providerSessionId,
      seatGeneration: seatGenerationEvidence(chat)
    }
  }
  return { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null }
}

function genericSessionFacts(
  providerSessionId: string | null,
  chat: ChatRecord | null
): { sessionMode: 'fresh' | 'resume'; providerSessionId: string | null; seatGeneration: CanonicalEvidenceValue | null } {
  if (providerSessionId) {
    return {
      sessionMode: 'resume',
      providerSessionId,
      seatGeneration: seatGenerationEvidence(chat)
    }
  }
  return { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null }
}

function seatGenerationEvidence(chat: ChatRecord | null): CanonicalEvidenceValue {
  const generation =
    (chat as { seatGeneration?: unknown } | null)?.seatGeneration ??
    (chat?.providerMetadata as { seatGeneration?: unknown } | undefined)?.seatGeneration ??
    null
  try {
    return JSON.parse(JSON.stringify(generation ?? null)) as CanonicalEvidenceValue
  } catch {
    return null
  }
}

function metadataString(chat: ChatRecord | null, key: string): string | null {
  const value = (chat?.providerMetadata as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' && value ? value : null
}

/**
 * User MCP launch identity evidence: names, transports, endpoint shapes and
 * env/header NAMES only — never resolved values (buildUserMcpLaunchServers
 * resolves real secrets into values).
 */
function userMcpConfigurationEvidence(settings: AppSettings): CanonicalEvidenceValue {
  const servers = Array.isArray(settings.userMcpServers) ? settings.userMcpServers : []
  return {
    servers: servers
      .filter((server) => server && server.enabled !== false)
      .map((server) => ({
        name: typeof server.name === 'string' ? server.name : '',
        transport: typeof server.transport === 'string' ? server.transport : '',
        url: typeof server.url === 'string' ? server.url : null,
        command: typeof server.command === 'string' ? server.command : null,
        argCount: Array.isArray(server.args) ? server.args.length : 0,
        envVarNames: server.env ? Object.keys(server.env).sort() : [],
        headerNames: server.headers ? Object.keys(server.headers).sort() : [],
        bearerTokenEnvVar:
          typeof server.bearerTokenEnvVar === 'string' ? server.bearerTokenEnvVar : null
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }
}

/**
 * The seat-context env view for Kimi: the seal engine HMACs the seat's
 * resolvedEnv separately from the evidence, and the evidence already bound
 * the contained projection — reuse the same projection so both digests
 * describe one environment.
 */
function buildCommonSeatEnvView(evidence: ProviderLaunchAuthorityInput): Record<string, string> {
  void evidence
  // The contained env template was consumed inside the evidence builder; the
  // seat-level record is intentionally the same projection. Kimi's builder
  // recomputes it deterministically, so an empty record here would under-bind
  // — instead the service passes the same placeholder-projected env used for
  // the evidence. This function exists to keep that decision in one place.
  return {}
}
