import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_PROVIDER,
  isLiveSelectableProvider
} from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import { isAntigravityAgyOptInEnabled } from '../antigravity/AntigravityAgyOptInEnabledSignal'
import {
  composeRunPrompt,
  type ComposeRunPromptResult,
  type OpenCanvasPromptContext
} from '../PromptComposition'
import { resolveRunSkillHookContext } from '../skillsHooks/resolveRunSkillHookContext'
import type {
  PromptEnvelopeSnapshot,
  ResolvedInstructionContext
} from '../../shared/instructions/InstructionTypes'
import { buildPromptEnvelopeSnapshot } from '../run/PromptEnvelope'
import {
  formatDiscordContextPromptAppendix,
  normalizeDiscordContextSnapshots,
  redactDiscordContextReadMetadataForHistory,
  type DiscordContextReadMetadata,
  type DiscordContextSnapshot
} from '../channels/DiscordContextService'
import { normalizeOllamaSessionMemory } from '../ollama/OllamaRunMemory'
import { resolveOllamaMeasuredContextTokens } from '../ollama/OllamaContextBudget'
import { isOllamaRunProfileId } from '../ollama/OllamaRunProfiles'
import { MISTRAL_DEFAULT_MODEL } from '../mistral/MistralCliArgs'
import { MUSE_DEFAULT_MODEL } from '../muse/MuseCliArgs'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  approvalModeRank,
  coerceApprovalMode,
  hashProjectReferenceContext,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import {
  resolveUnattendedApprovalMode,
  unattendedElevationPresetId,
  type UnattendedElevationAck
} from '../UnattendedPostureGate'
import { resolveProviderDispatch, type ProviderDispatchResolution } from '../ProviderRunPause'
import { filterMessagesExcludingIds } from '../run/MidRunSteering'
import { resolveActiveGoalForProvider } from '../GoalState'
import {
  coalesceExternalPathGrants,
  stripExternalPathGrantOrder
} from '../store/ExternalPathGrants'
import type { TrustedSessionScope } from '../TrustedSessionGrants'
import type {
  AppSettings,
  ChatRecord,
  ChatRun,
  ChatScope,
  ChatWorkflowMode,
  EffectiveRunPermissions,
  ExternalPathGrant,
  GeminiWorktreeLaunchOption,
  PermissionPresetId,
  ProviderRunReroute,
  ProviderId
} from '../store/types'
import type { Project, ProjectReference } from '../../shared/projects'
import type {
  ProjectReferenceContextSelection,
  ResolvedProjectReferenceContext
} from '../../shared/projectReferenceContext'
import {
  formatProjectReferenceContextPromptAppendix,
  formatProjectReferenceExtractsPromptAppendix,
  resolveProjectReferenceContext,
  type ProjectReferenceExtractLoader
} from './ProjectReferenceContextService'
import { isPreviewRiskModel } from '../../shared/previewModelCatalog'
import {
  GROK_46_MODEL_ID,
  isCursorGrokModelId,
  isGrokReasoningModelId
} from '../../shared/grok45Models'
import {
  isTaskWraithMcpProfileReceiptForSession,
  resolveTaskWraithMcpProfile,
  taskWraithCoreMcpProfileOptInEnabled
} from '../mcp/McpSessionProfileFence'
import { grokAcpEnabled, grokReadOnlyMcpAdvertiseEnabled } from '../grokGate'
import { shouldAdvertiseTaskWraithMcpToGrok } from '../grok/GrokMcpAdvertise'
import { isKimiK3Model, normalizeKimiReasoningEffort } from '../providers/StaticProviderModels'
import { isKimiAcpProductionPosture } from '../../shared/kimiAcpPosture'
import {
  isDirectoryComposerAttachment,
  type ComposerAttachmentKind
} from '../../shared/composerAttachment'

// Known ids for historical decode. Compose/dispatch uses the shared live
// admission predicate through `assertLiveProviderId`.
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse'
])

export interface ComposerImageAttachment {
  id?: string
  path?: string
  name?: string
  kind?: ComposerAttachmentKind
}

export interface ComposerInput {
  chatId: string
  appRunId?: string
  /** Present ONLY for an unattended scheduled-task / workflow occurrence. Its
   * presence forces a safe posture (see resolveUnattendedApprovalMode); an
   * interactive run never carries it. */
  scheduledTaskId?: string
  provider?: ProviderId
  providerReroute?: ProviderRunReroute
  scope?: ChatScope
  workspace?: string
  userInput?: string
  prompt?: string
  selectedModelType?: string
  customModel?: string
  overrideModel?: string
  approvalMode?: string
  permissionPresetId?: PermissionPresetId | string
  workflowMode?: ChatWorkflowMode
  sessionTrust?: boolean
  attachments?: ComposerImageAttachment[]
  imageAttachments?: ComposerImageAttachment[]
  externalPathGrants?: ExternalPathGrant[]
  projectReferenceContextSelection?: ProjectReferenceContextSelection
  geminiWorktree?: GeminiWorktreeLaunchOption
  codexReasoningEffort?: string | null
  antigravityReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiFastMode?: boolean
  kimiReasoningEffort?: string | null
  kimiThinkingEnabled?: boolean
  grokReasoningEffort?: string | null
  cursorReasoningEffort?: string | null
  cursorFastMode?: boolean | null
  museReasoningEffort?: string | null
  ollamaReasoningEffort?: string | null
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  discordContextSnapshots?: DiscordContextSnapshot[]
  chatSnapshot?: ChatRecord
  /** Main-only graph lane: no transcript, goal, compaction, or native-session inheritance. */
  contextIsolation?: 'execution_graph' | 'channel_agent'
  /** Send the prompt to the provider verbatim (no context/preamble blocks) —
   * provider-native slash dispatches only (see ComposeRunPromptInput). */
  verbatimPrompt?: boolean
  /** Transcript message ids to omit from injected conversation history.
   * Mid-run steering appends the prompt's message to the transcript BEFORE
   * dispatch (timestamped at arrival); without this exclusion a
   * transcript-injecting provider reads the same content twice — once as
   * history, once as the request. The composition tail-dedupe only covers a
   * message that is still the LAST entry, which a mid-run append is not. */
  excludeMessageIds?: string[]
}

export interface ComposerRunMetadata {
  finalPrompt: string
  contextTurnsApplied: number
  applicationLog: string
  providerLabel: string
  requestedModel?: string
  approvalMode: string
  workflowMode: ChatWorkflowMode
  providerSessionId?: string | null
  geminiResumeSkippedReason?: string
  clearLinkedGeminiSession?: boolean
  providerMetadataPatch?: Record<string, unknown>
  codexHandoffApplied?: ComposeRunPromptResult['codexHandoffApplied']
  uiNoticeMessage?: string
  imagePaths: string[]
  discordContextReads?: DiscordContextReadMetadata[]
  projectReferenceContext?: ResolvedProjectReferenceContext
  planModeParsed?: boolean
  /**
   * 1.0.4-AF — set when the user prefixed the prompt with `/discuss`
   * (or `/meta`). Signals the renderer / orchestrator to flip the
   * active ensemble round into self-reflective mode (see
   * `EnsembleConfig.selfReflective`). The slash token is stripped
   * from `finalPrompt` so it never reaches the provider verbatim.
   */
  selfReflectiveRequested?: boolean
  /**
   * Per-run prompt-envelope snapshot (Prompt Inspector "Layers" view).
   * Metadata always; layer content only when `storeRawEvents` was on at
   * compose time (see buildPromptEnvelopeSnapshot). The renderer copies
   * this onto the ChatRun it appends, which is what persists it.
   */
  promptEnvelope?: PromptEnvelopeSnapshot
}

export type ComposerRunPayload = AgentRunPayload & {
  composer: ComposerRunMetadata
}

export interface ComposerServiceStore {
  getChat: (chatId: string) => ChatRecord | null
  getProjects?: () => Project[]
  getProjectReferences?: () => ProjectReference[]
}

export interface ComposerServiceDeps {
  appStore: ComposerServiceStore
  getSettings: () => AppSettings
  /**
   * Optional consentful Project reference extract loader for Use-next body
   * injection. Absent → catalogue disclosure only (no extract bodies).
   */
  projectReferenceExtractLoader?: ProjectReferenceExtractLoader
  /**
   * Stamp the run's permission posture (`approvalMode` +
   * `effectivePermissions`) so the `normalizeAgentRunPayload` clamp trusts
   * this main-composed payload after it round-trips through the renderer.
   * Optional: unit tests that don't exercise the run-posture clamp omit it.
   * See src/main/RunPermissionPosture.ts.
   */
  signRunPermissionPosture?: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => string
  /**
   * Returns a previously signed, main-owned graph posture for this exact run,
   * or null for ordinary composer runs. The resolver must verify persisted
   * provenance before returning; renderer input is never authority here.
   */
  resolveFrozenPermissionPosture?: (input: {
    appRunId: string
    provider: ProviderId
    scope: ChatScope
    chatId: string
    workspacePath?: string
    runtimeProfileId?: string
  }) => {
    approvalMode: string
    workflowMode: ChatWorkflowMode
    effectivePermissions: EffectiveRunPermissions
  } | null
  /**
   * P2 — resolve a VERIFIED unattended-elevation grant for a scheduled
   * occurrence. The impure caller (index.ts) finds the scheduled task, its
   * workflow, HMAC-verifies the ack AND checks isUnattendedElevationAckCurrent,
   * and returns the ack + the template approvalMode it was confirmed against — or
   * null. Absent/null ⇒ the unattended run stays clamped to 'plan'. Optional so
   * unit tests that don't exercise elevation omit it.
   */
  resolveUnattendedElevation?: (
    scheduledTaskId: string
  ) => { ack: UnattendedElevationAck; templateApprovalMode: string } | null
  /**
   * In-memory, main-owned host-trust receipt. A renderer-selected
   * `permissionPresetId: 'full_access'` is only honored when this says the
   * current chat/lane has an active Full Access grant.
   */
  isTrustedSessionGranted?: (scope: TrustedSessionScope) => boolean
  /**
   * Progressive skill discovery for prompt composition. Optional so unit tests
   * that don't exercise SkillsStore omit it.
   */
  resolveSkillDiscoverySkills?: (
    workspacePath: string,
    workspaceId?: string
  ) => readonly { id: string; name: string; description: string }[]
  /**
   * Optional SessionStart hook stdout for this turn. May be sync or async;
   * `composeRun` awaits the result before prompt composition.
   */
  resolveSessionStartContext?: (
    workspacePath: string
  ) => string | null | undefined | Promise<string | null | undefined>
  /**
   * Main-owned, chat-scoped Canvas presence for the outgoing turn. Prompt
   * composition consumes only id/driver/status, never URL or page content.
   */
  listOpenCanvasSessions?: (chatId: string) => readonly OpenCanvasPromptContext[]
  /**
   * Resolved user instruction layers (global custom-instructions document +
   * workspace TASKWRAITH.md) for prompt composition. Receives null for
   * global-scope runs (no workspace layer there). Optional so unit tests
   * that don't exercise the InstructionResolver omit it — composeRunPrompt's
   * REQUIRED instructionContext input still forces this service to pass an
   * explicit null in that case.
   */
  resolveInstructionContext?: (workspacePath: string | null) => ResolvedInstructionContext | null
}

/**
 * Main-only authority for a fresh Channel-agent turn. This is a second method
 * argument, never part of renderer IPC, so renderer-authored payloads cannot
 * claim the already owner-signed permission posture.
 */
export interface ChannelAgentComposerAuthority {
  readonly kind: 'channel_agent'
  readonly appRunId: string
  readonly chatId: string
  readonly provider: ProviderId
  readonly scope: ChatScope
  readonly workspacePath?: string
  readonly approvalMode: string
  readonly workflowMode: ChatWorkflowMode
  readonly permissionPresetId: PermissionPresetId
  readonly effectivePermissions: EffectiveRunPermissions
}

export class ComposerService {
  constructor(private deps: ComposerServiceDeps) {}

  async composeRun(input: ComposerInput): Promise<ComposerRunPayload> {
    return this.composeRunInternal(input, null)
  }

  async composeMainOwnedChannelAgentRun(
    input: ComposerInput,
    authority: ChannelAgentComposerAuthority
  ): Promise<ComposerRunPayload> {
    assertChannelAgentComposerAuthority(input, authority)
    return this.composeRunInternal(input, authority)
  }

  private async composeRunInternal(
    input: ComposerInput,
    channelAgentAuthority: ChannelAgentComposerAuthority | null
  ): Promise<ComposerRunPayload> {
    const chatId = requireNonEmptyString(input?.chatId, 'Chat id')
    const storedChat = this.deps.appStore.getChat(chatId)
    const sourceChat = input.chatSnapshot || storedChat
    if (!sourceChat) {
      throw new Error(`Chat was not found: ${chatId}`)
    }
    const contextIsolated =
      input.contextIsolation === 'execution_graph' || input.contextIsolation === 'channel_agent'
    const chat: ChatRecord = contextIsolated
      ? {
          ...sourceChat,
          messages: [],
          runs: [],
          linkedProviderSessionId: undefined,
          linkedGeminiSessionId: undefined,
          taskWraithMcpProfileReceipt: undefined,
          activeGoal: undefined,
          contextCompactionSummary: undefined,
          providerMetadata: {},
          ollamaSessionMemory: undefined,
          ollamaSessionMemories: undefined
        }
      : sourceChat
    const trustedApprovalChat: ChatRecord = storedChat || {
      ...chat,
      providerMetadata: {},
      settingsSnapshot: undefined
    }

    // Live default for a provider-less compose (was `|| 'gemini'`). Historical
    // Gemini records remain decodable, but retired providers are rejected before
    // a new run is composed. Cursor is live and passes this same canonical check.
    const requestedProvider = assertLiveProviderId(
      input.provider || chat.provider || DEFAULT_PROVIDER
    )
    const scope: ChatScope =
      input.scope === 'global' || chat.scope === 'global' ? 'global' : 'workspace'
    if (
      channelAgentAuthority &&
      (chatId !== channelAgentAuthority.chatId ||
        scope !== channelAgentAuthority.scope ||
        (scope === 'workspace'
          ? input.workspace !== channelAgentAuthority.workspacePath
          : Boolean(input.workspace)))
    ) {
      throw new Error('Channel agent chat or workspace authority changed before composition.')
    }
    const settings = this.deps.getSettings()
    const dispatchResolution = resolveProviderDispatch(settings, requestedProvider)
    const provider = dispatchResolution.provider
    const effectiveProviderReroute = input.providerReroute || dispatchResolution.reroute
    if (
      channelAgentAuthority &&
      (requestedProvider !== channelAgentAuthority.provider ||
        provider !== channelAgentAuthority.provider ||
        effectiveProviderReroute)
    ) {
      throw new Error('Channel agent provider routing changed before composition.')
    }
    const crossProviderReroute = Boolean(
      effectiveProviderReroute && effectiveProviderReroute.from !== effectiveProviderReroute.to
    )
    // A verbatim slash dispatch is provider-native — rerouting it (provider
    // pause plans) would hand the literal slash text to a different provider
    // as prose. Fail visibly instead; the renderer surfaces compose errors.
    if (input.verbatimPrompt === true && provider !== requestedProvider) {
      throw new Error(
        `${getProviderLabel(requestedProvider)} is paused with a reroute to ${getProviderLabel(provider)} — resume it before compacting this session.`
      )
    }
    const rawInputBeforeReroute =
      typeof input.userInput === 'string'
        ? input.userInput
        : typeof input.prompt === 'string'
          ? input.prompt
          : ''
    const requestedPlanMode = parsePlanModeInput(rawInputBeforeReroute).planMode
    const requestedWorkflowMode = resolveComposerWorkflowMode(
      input.workflowMode,
      chat.workflowMode,
      requestedPlanMode
    )
    const trustedApprovalMode = resolveApprovalMode(
      scope,
      requestedWorkflowMode === 'plan' ? 'plan' : undefined,
      trustedApprovalChat
    )
    const effectiveInput = applyComposerReroutePlan(
      input,
      dispatchResolution,
      requestedProvider,
      trustedApprovalMode
    )
    const rawUserInput =
      typeof effectiveInput.userInput === 'string'
        ? effectiveInput.userInput
        : typeof effectiveInput.prompt === 'string'
          ? effectiveInput.prompt
          : ''
    const planParsed = parsePlanModeInput(rawUserInput)
    const composerAttachments = normalizeComposerAttachments(
      effectiveInput.imageAttachments || effectiveInput.attachments || []
    )
    const imagePaths = normalizeImagePaths(composerAttachments)
    const basePrompt = planParsed.prompt.trim()
      ? planParsed.prompt
      : composerAttachments.length > 0
        ? 'Please inspect the attached file(s).'
        : planParsed.prompt
    if (!basePrompt.trim()) {
      throw new Error('Prompt is required.')
    }
    const selfReflectiveRequested = planParsed.selfReflective

    const requestedModel = resolveRequestedModel(provider, effectiveInput, chat)
    const previewRiskModel = isPreviewRiskModel(provider, requestedModel)
    let workflowMode = resolveComposerWorkflowMode(
      effectiveInput.workflowMode,
      chat.workflowMode,
      planParsed.planMode
    )
    const requestedApprovalMode = workflowMode === 'plan' ? 'plan' : effectiveInput.approvalMode
    const appRunId = optionalString(input.appRunId)
    // Tier retirement (2026-07): Ollama now honors the user's picked permission
    // role through the SAME cap path as every other provider (it used to be
    // force-'plan', with its own tier ladder governing tools). read_only/plan
    // resolve the deny presets; default/auto_edit carry the standard posture the
    // gate reads. No Ollama special-case here anymore.
    let approvalMode = capRequestedApprovalMode(
      resolveApprovalMode(scope, undefined, trustedApprovalChat),
      resolveApprovalMode(scope, requestedApprovalMode, trustedApprovalChat),
      appRunId
    )
    // Unattended (scheduled/workflow) runs must NEVER silently inherit the chat's
    // elevated approvalMode. capRequestedApprovalMode can't prevent it: the "trusted"
    // ceiling is the scheduled chat's OWN persisted mode (a poisoned floor) and the
    // run carries an appRunId (so the no-appRunId cap is bypassed). Derive the safe
    // posture from scheduledTaskId presence and FORCE it here — BEFORE the
    // effectiveRunPermissions/plan-population block below, so a forced 'plan' actually
    // populates read-only permissions instead of being read-only in name only.
    // P1: no elevation ack yet → always 'plan'. (P2 wires a verified WorkflowDefinition
    // ack so a user can opt back into Default / Full-Access unattended loops.)
    const unattended = Boolean(optionalString(input.scheduledTaskId))
    const scheduledTaskId = optionalString(input.scheduledTaskId)
    // P2 — honor a VERIFIED elevation ack (HMAC + current) for this scheduled
    // occurrence; fail-closed to 'plan' otherwise. The dep does both the
    // cryptographic verify and the structural isUnattendedElevationAckCurrent
    // check, so resolveUnattendedApprovalMode here only caps the requested mode by
    // the (already-authenticated) level.
    const unattendedElevation =
      unattended && scheduledTaskId
        ? (this.deps.resolveUnattendedElevation?.(scheduledTaskId) ?? null)
        : null
    if (unattended) {
      approvalMode = resolveUnattendedApprovalMode(unattendedElevation?.ack, approvalMode)
      if (previewRiskModel) {
        approvalMode = 'plan'
      }
    }
    if (previewRiskModel && approvalMode !== 'plan') {
      approvalMode = 'default'
    }
    const runtimeProfileId = optionalString(effectiveInput.runtimeProfileId)
    const frozenPermissionPosture =
      !channelAgentAuthority && appRunId && !unattended
        ? (this.deps.resolveFrozenPermissionPosture?.({
            appRunId,
            provider,
            scope,
            chatId,
            ...(scope === 'workspace'
              ? { workspacePath: effectiveInput.workspace || chat.workspacePath }
              : {}),
            ...(runtimeProfileId ? { runtimeProfileId } : {})
          }) ?? null)
        : null
    if (frozenPermissionPosture) {
      if (
        previewRiskModel &&
        frozenPermissionPosture.effectivePermissions.presetId !== 'read_only' &&
        frozenPermissionPosture.effectivePermissions.presetId !== 'plan'
      ) {
        throw new Error(
          'Execution graph permission posture cannot be applied after the model became preview-risk.'
        )
      }
      approvalMode = frozenPermissionPosture.approvalMode
      workflowMode = frozenPermissionPosture.workflowMode
    }
    if (channelAgentAuthority) {
      approvalMode = channelAgentAuthority.approvalMode
      workflowMode = channelAgentAuthority.workflowMode
    }
    const requestedTrustedSession =
      !channelAgentAuthority &&
      !frozenPermissionPosture &&
      effectiveInput.permissionPresetId === 'full_access' &&
      scope !== 'global'
    const trustedSessionGranted =
      requestedTrustedSession &&
      this.deps.isTrustedSessionGranted?.({
        chatId,
        provider,
        workspacePath: effectiveInput.workspace || chat.workspacePath,
        runtimeProfileId
      }) === true
    const interactivePermissionPresetId = unattended
      ? undefined
      : resolveInteractivePermissionPresetId(
          approvalMode,
          workflowMode,
          effectiveInput.permissionPresetId,
          trustedSessionGranted
        )
    const externalPathGrants = frozenPermissionPosture
      ? [...frozenPermissionPosture.effectivePermissions.externalPathGrants]
      : scope !== 'global' && !(unattended && approvalMode === 'plan')
        ? normalizeComposerExternalPathGrants(effectiveInput.externalPathGrants || [], provider)
        : []
    const projectReferenceContext = effectiveInput.projectReferenceContextSelection
      ? resolveProjectReferenceContext({
          selection: effectiveInput.projectReferenceContextSelection,
          chatId,
          provider,
          workspacePath:
            scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
          projects: this.deps.appStore.getProjects?.() ?? missingProjectReferenceContextAuthority(),
          references:
            this.deps.appStore.getProjectReferences?.() ??
            missingProjectReferenceContextAuthority(),
          externalPathGrants,
          ...(this.deps.projectReferenceExtractLoader
            ? { extractLoader: this.deps.projectReferenceExtractLoader }
            : {})
        })
      : undefined
    const discordContextSnapshots = normalizeDiscordContextSnapshots(input.discordContextSnapshots)
    const finalPrompt = `${basePrompt}${attachmentPromptAppendix(composerAttachments)}${externalPathGrantPromptAppendix(externalPathGrants)}${formatProjectReferenceContextPromptAppendix(projectReferenceContext)}${formatProjectReferenceExtractsPromptAppendix(
      projectReferenceContext,
      this.deps.projectReferenceExtractLoader
    )}`
    const contextualFinalPrompt = `${finalPrompt}${formatDiscordContextPromptAppendix(discordContextSnapshots)}`
    const geminiAuthProfileId =
      provider === 'gemini'
        ? channelAgentAuthority
          ? optionalStringOrNull(effectiveInput.geminiAuthProfileId)
          : optionalStringOrNull(effectiveInput.geminiAuthProfileId) ||
            metadataString(chat, 'geminiAuthProfileId') ||
            optionalStringOrNull(settings.defaultGeminiAuthProfileId) ||
            null
        : null

    const resumeDecision = resolveResumeDecision(
      provider,
      chat,
      requestedModel,
      approvalMode,
      effectiveInput.geminiWorktree,
      geminiAuthProfileId
    )
    const lastCompletedCodexModel =
      provider === 'codex' ? getLastCompletedCodexRunModel(chat) : null
    const codexHandoffsApplied = provider === 'codex' ? getCodexModelContextAppliedKeys(chat) : []
    const allowProviderNativeGoal = chat.chatKind !== 'ensemble'
    const activeGoal = resolveActiveGoalForProvider(chat.activeGoal, provider, {
      codexNativeAvailable:
        allowProviderNativeGoal && Boolean(chat.providerMetadata?.codexGoalNativeAvailable),
      claudeNativeAvailable:
        allowProviderNativeGoal && Boolean(chat.providerMetadata?.claudeGoalNativeAvailable),
      grokNativeAvailable: allowProviderNativeGoal && provider === 'grok',
      allowProviderNative: allowProviderNativeGoal
    })
    // Legacy per-chat Ollama run profile (stored in providerMetadata like
    // approvalMode). There is no longer a picker to set it; a value only exists
    // on older chats. Absent → undefined → the runtime defaults to
    // provider_parity (the per-ensemble-participant selector is the live knob).
    const rawChatOllamaRunProfile = chat.providerMetadata?.ollamaRunProfile
    const chatOllamaRunProfile = isOllamaRunProfileId(rawChatOllamaRunProfile)
      ? rawChatOllamaRunProfile
      : undefined
    const mcpProfileOwner = contextIsolated ? chat : storedChat || chat
    const claudePinnedMcpReceipt =
      provider === 'claude' &&
      isTaskWraithMcpProfileReceiptForSession(mcpProfileOwner.taskWraithMcpProfileReceipt, {
        provider: 'claude',
        providerSessionId: resumeDecision.sessionId
      })
    const taskWraithMcpAdvertised =
      // Pi's optional Ensemble coordination extension is attached and
      // receipt-gated at launch. It must not inherit the generic TaskWraith MCP
      // preamble/profile from composer time.
      provider === 'pi'
        ? false
        : provider === 'grok'
          ? shouldAdvertiseTaskWraithMcpToGrok({
              acpEnabled: grokAcpEnabled(),
              approvalMode,
              bridgeEnabled: Boolean(settings.geminiMcpBridgeEnabled),
              readOnlyAdvertiseEnabled: grokReadOnlyMcpAdvertiseEnabled()
            })
          : provider === 'claude'
            ? Boolean(claudePinnedMcpReceipt || settings.geminiMcpBridgeEnabled)
            : true
    const taskWraithMcpProfile = resolveTaskWraithMcpProfile({
      provider,
      modelId: requestedModel,
      providerSessionId: resumeDecision.sessionId,
      storeProviderSessionId: mcpProfileOwner.linkedProviderSessionId,
      receipt: mcpProfileOwner.taskWraithMcpProfileReceipt,
      coreProfileOptIn: taskWraithCoreMcpProfileOptInEnabled(),
      profileReceiptCanPersist: provider !== 'claude' || !crossProviderReroute,
      grokMcpAdvertised: provider === 'grok' ? taskWraithMcpAdvertised : undefined
    })
    const kimiNativeSessionResume = Boolean(
      provider === 'kimi' &&
      resumeDecision.sessionId &&
      resumeDecision.sessionId.startsWith('session_') &&
      metadataBoolean(chat, 'kimiAcpNativeSession') === true &&
      isKimiAcpProductionPosture(chat.providerMetadata?.kimiAcpPostureVersion)
    )
    const workspacePathForSkills =
      scope !== 'global' && typeof chat.workspacePath === 'string' && chat.workspacePath.trim()
        ? chat.workspacePath.trim()
        : typeof input.workspace === 'string' && input.workspace.trim()
          ? input.workspace.trim()
          : ''
    // Prefer explicit deps (unit tests / legacy wiring); otherwise the shared
    // helper resolves progressive skills + SessionStart once per workspace.
    let skillDiscoverySkills:
      | readonly { id: string; name: string; description: string }[]
      | undefined
    let sessionStartContext: string | null | undefined
    if (!contextIsolated && workspacePathForSkills) {
      if (this.deps.resolveSkillDiscoverySkills || this.deps.resolveSessionStartContext) {
        skillDiscoverySkills = this.deps.resolveSkillDiscoverySkills?.(
          workspacePathForSkills,
          chat.workspaceId || undefined
        )
        sessionStartContext = this.deps.resolveSessionStartContext
          ? await this.deps.resolveSessionStartContext(workspacePathForSkills)
          : undefined
      } else {
        const skillHookContext = await resolveRunSkillHookContext({
          workspacePath: workspacePathForSkills,
          workspaceId: chat.workspaceId || undefined,
          allowWorkspaceHooks: settings.trustWorkspaceHooks === true
        })
        skillDiscoverySkills = skillHookContext.skillDiscoverySkills
        sessionStartContext = skillHookContext.sessionStartContext
      }
    }
    const openCanvasSessions = contextIsolated
      ? []
      : this.deps.listOpenCanvasSessions?.(chat.appChatId) || []
    // Context-isolated lanes (execution graph, channel agent) strip ambient
    // chat/workspace context the same way skills/hooks are stripped above —
    // instruction layers follow that existing isolation contract.
    const instructionContext =
      !contextIsolated && this.deps.resolveInstructionContext
        ? this.deps.resolveInstructionContext(
            scope === 'global' ? null : workspacePathForSkills || null
          )
        : null
    const reasoningEffort =
      provider === 'codex'
        ? optionalStringOrNull(effectiveInput.codexReasoningEffort) || null
        : provider === 'grok' && isGrokReasoningModelId(requestedModel)
          ? optionalStringOrNull(effectiveInput.grokReasoningEffort) || null
          : provider === 'cursor' && isCursorGrokModelId(requestedModel)
            ? optionalStringOrNull(effectiveInput.cursorReasoningEffort) || null
            : provider === 'kimi'
              ? normalizeKimiReasoningEffort(
                  requestedModel,
                  optionalStringOrNull(effectiveInput.kimiReasoningEffort) ||
                    optionalStringOrNull(metadataString(chat, 'kimiReasoningEffort'))
                )
              : provider === 'ollama'
                ? optionalStringOrNull(effectiveInput.ollamaReasoningEffort) ||
                  optionalStringOrNull(metadataString(chat, 'ollamaReasoningEffort')) ||
                  null
                : provider === 'muse'
                  ? optionalStringOrNull(effectiveInput.museReasoningEffort) ||
                    optionalStringOrNull(metadataString(chat, 'museReasoningEffort')) ||
                    null
                  : provider === 'claude'
                    ? optionalStringOrNull(effectiveInput.claudeReasoningEffort) || null
                      : provider === 'antigravity'
                        ? optionalStringOrNull(effectiveInput.antigravityReasoningEffort) ||
                          optionalStringOrNull(metadataString(chat, 'antigravityReasoningEffort')) ||
                          null
                        : null
    // Raw (un-normalized) reasoning tier, preserved solely for UltraTask
    // detection in prompt composition (`ultraTaskDetectionEffort`). Several
    // wire paths clamp or remap the token so `reasoningEffort` above can never
    // carry UltraTask intent:
    // - AntiGravity: normalizeAgyReasoningEffort accepts only low/medium/high;
    //   picking UltraTask swaps the wire model to the family's -high variant
    //   and persists a separate antigravityUltraTaskSelected marker instead.
    // - Kimi K3: normalizeKimiReasoningEffort collapses unknowns to 'max'.
    // - Gemini / Mistral / Pi: no wire effort branch exists at all.
    // Detection is deliberately provider-uniform: scan every per-provider
    // effort key (effectiveInput first, then chat metadata) plus the
    // AntiGravity presentation marker. The composer persists 'ultraTask'
    // verbatim into whichever key it owns; a run payload only populates its
    // own provider's field, so scanning both surfaces closes the gap for
    // providers whose queue path drops the token.
    const ultraTaskRawEffortCandidates = [
      optionalStringOrNull(effectiveInput.antigravityReasoningEffort),
      optionalStringOrNull(effectiveInput.kimiReasoningEffort),
      optionalStringOrNull(effectiveInput.claudeReasoningEffort),
      optionalStringOrNull(effectiveInput.grokReasoningEffort),
      optionalStringOrNull(effectiveInput.cursorReasoningEffort),
      optionalStringOrNull(effectiveInput.museReasoningEffort),
      optionalStringOrNull(effectiveInput.ollamaReasoningEffort),
      metadataString(chat, 'antigravityReasoningEffort'),
      metadataString(chat, 'kimiReasoningEffort'),
      metadataString(chat, 'geminiReasoningEffort'),
      metadataString(chat, 'mistralReasoningEffort'),
      metadataString(chat, 'piReasoningEffort'),
      metadataString(chat, 'museReasoningEffort'),
      metadataString(chat, 'ollamaReasoningEffort'),
      metadataString(chat, 'cursorReasoningEffort'),
      metadataString(chat, 'grokReasoningEffort'),
      metadataString(chat, 'claudeReasoningEffort'),
      metadataString(chat, 'codexReasoningEffort'),
      metadataString(chat, 'reasoningEffort')
    ]
    const ultraTaskDetectionEffort = ultraTaskRawEffortCandidates.some(
      (candidate) =>
        ['ultra', 'ultracode', 'ultratask'].includes((candidate ?? '').toLowerCase())
    )
      ? 'ultratask'
      : metadataBoolean(chat, 'antigravityUltraTaskSelected') === true
        ? 'ultratask'
        : null
    const promptInput = {
      provider,
      verbatimPrompt: input.verbatimPrompt === true,
      contextCompactionSummary: chat.contextCompactionSummary || null,
      finalPrompt: contextualFinalPrompt,
      messages: filterMessagesExcludingIds(chat.messages || [], input.excludeMessageIds),
      chatContextTurns: contextIsolated ? 0 : settings.chatContextTurns,
      resumeSessionId: resumeDecision.sessionId || undefined,
      lastCompletedCodexModel,
      nextModel: requestedModel,
      codexHandoffsApplied,
      isGlobalRun: scope === 'global',
      approvalMode,
      workflowMode,
      instructionContext,
      instructionsDigestApplied: metadataString(chat, 'taskWraithInstructionsDigest'),
      instructionsDigestProvider: metadataString(chat, 'taskWraithInstructionsProvider'),
      runtimePreambleVersion: metadataString(chat, 'taskWraithRuntimePreambleVersion'),
      runtimePreambleProvider: metadataString(chat, 'taskWraithRuntimePreambleProvider'),
      providerLabel: getProviderLabel(provider),
      nativeSubAgentRequests: settings.nativeSubAgentRequests,
      activeGoal,
      taskWraithMcpProfileId: taskWraithMcpProfile.profileId,
      taskWraithMcpAdvertised,
      reasoningEffort,
      ultraTaskDetectionEffort,
      ...(openCanvasSessions.length > 0 ? { openCanvasSessions } : {}),
      ...(skillDiscoverySkills ? { skillDiscoverySkills } : {}),
      ...(sessionStartContext ? { sessionStartContext } : {}),
      ...(kimiNativeSessionResume ? { nativeSessionResume: true } : {}),
      ...(provider === 'ollama'
        ? {
            ollamaSessionMemory: normalizeOllamaSessionMemory(chat.ollamaSessionMemory),
            // Daemon-measured window cached by a prior run (see
            // `recordOllamaModelContextTokens`). Absent on a model's very first
            // run, which is safe: the budget then keeps its conservative default
            // rather than scaling off an assumed window.
            ollamaLiveContextTokens: resolveOllamaMeasuredContextTokens(
              settings.ollamaModelContextTokens,
              requestedModel
            )
          }
        : {})
    } satisfies Parameters<typeof composeRunPrompt>[0]
    const composed = composeRunPrompt(promptInput)
    // The slim native-resume prompt and this full-context recovery prompt are
    // signed together below. AcpTurnClient selects the latter only when Kimi
    // cannot rehydrate the saved session and must use session/new; the Claude
    // lanes select it when the seat rotation nulls providerSessionId after
    // composition (claudeDispatchPrompt), so a rotated conversation is seeded
    // with the compaction summary + compact transcript instead of starting
    // cold.
    const codexNativeSessionResume = Boolean(provider === 'codex' && resumeDecision.sessionId)
    const claudeNativeSessionResume = Boolean(provider === 'claude' && resumeDecision.sessionId)
    const resumeFallbackPrompt =
      kimiNativeSessionResume || codexNativeSessionResume || claudeNativeSessionResume
        ? composeRunPrompt({
            ...promptInput,
            ...(kimiNativeSessionResume ? { nativeSessionResume: false } : {}),
            ...(codexNativeSessionResume || claudeNativeSessionResume
              ? { resumeSessionId: undefined }
              : {})
          }).contextualPrompt
        : undefined

    const providerMetadataPatchData = {
      ...buildProviderMetadataPatch(composed, codexHandoffsApplied),
      ...(composed.runtimePreambleVersion
        ? {
            taskWraithRuntimePreambleVersion: composed.runtimePreambleVersion,
            taskWraithRuntimePreambleProvider: composed.runtimePreambleProvider || provider
          }
        : {}),
      ...(composed.instructionsDigest
        ? {
            taskWraithInstructionsDigest: composed.instructionsDigest,
            taskWraithInstructionsProvider: composed.instructionsProvider || provider
          }
        : {}),
      ...(provider === 'gemini' ? { geminiAuthProfileId } : {})
    }
    const providerMetadataPatch =
      Object.keys(providerMetadataPatchData).length > 0 ? providerMetadataPatchData : undefined
    // Populate canonical permissions for the SINGLE-run path. Previously only
    // read-only runs carried effectivePermissions; write-capable solo runs had a
    // signed approvalMode but no signed preset. That made a selected Full Access
    // lane unable to prove `full_access` at the main trust boundary, so provider
    // adapters could not safely drop their own sandbox/deny-list posture. Solo
    // runs now mirror ensemble participants: the user-selected permission preset
    // is resolved in main and HMAC-signed with the run.
    // P2 — an ELEVATED unattended run (approvalMode lifted above 'plan' by a
    // verified ack) must ALSO carry real permissions so the SIGNED posture is
    // honest (not undefined → the normalize clamp would re-derive read-only). Map
    // the verified level → preset: full_access → workspace_write (auto_edit,
    // workspace-bounded, network-denied), default → default.
    const elevatedPresetId =
      unattended && unattendedElevation && approvalMode !== 'plan'
        ? unattendedElevationPresetId(unattendedElevation.ack.level)
        : undefined
    const resolvedRunPermissions = channelAgentAuthority
      ? (JSON.parse(
          JSON.stringify(channelAgentAuthority.effectivePermissions)
        ) as EffectiveRunPermissions)
      : frozenPermissionPosture
        ? frozenPermissionPosture.effectivePermissions
        : approvalMode === 'plan'
          ? resolveEffectiveRunPermissions({
              provider,
              workspacePath:
                scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
              model: requestedModel,
              settings,
              // Posture split: the solo composer's two `approvalMode: 'plan'` rows
              // are distinguished ONLY by workflowMode (the renderer derives the
              // same 'read_only' vs 'plan' label from it). The Plan row
              // (workflowMode 'plan') resolves the `plan` instrument tier; the
              // Ask row (workflowMode 'normal') the attended Ask posture. Both
              // keep readOnly:true so the signed posture still clears the clamp.
              // Unattended (scheduled) safe runs use Plan: standard-service asks
              // remain promptable and fail closed through approval timeout.
              presetId: workflowMode === 'plan' || unattended ? 'plan' : 'read_only'
            })
          : elevatedPresetId
            ? resolveEffectiveRunPermissions({
                provider,
                workspacePath:
                  scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
                model: requestedModel,
                settings,
                presetId: elevatedPresetId,
                // Unattended elevation NEVER gets network egress (exfiltration risk on
                // an unattended loop). workspace_write/default don't set networkAccess
                // (→ settings default 'allow'), so force-deny it here.
                overrides: {
                  networkAccess: 'deny'
                }
              })
            : previewRiskModel
              ? resolveEffectiveRunPermissions({
                  provider,
                  workspacePath:
                    scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
                  model: requestedModel,
                  settings,
                  presetId: 'default'
                })
              : resolveEffectiveRunPermissions({
                  provider,
                  workspacePath:
                    scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
                  model: requestedModel,
                  settings,
                  presetId:
                    scope === 'global' ? 'default' : interactivePermissionPresetId || 'default',
                  ...(scope === 'global'
                    ? {
                        overrides: {
                          agenticServices: {
                            // Global runs historically inherit settings rather
                            // than Accept Edits' workspace-oriented presets.
                            // Preserve that for every service except chat-local
                            // Mesh authoring, which follows the explicit ladder.
                            fileChanges: settings.agenticServices?.fileChanges ?? 'ask',
                            subThreadDelegation:
                              settings.agenticServices?.subThreadDelegation ?? 'ask',
                            simulatorCanvas: settings.agenticServices?.simulatorCanvas ?? 'ask',
                            meshCanvas: 'allow'
                          }
                        }
                      }
                    : {})
                })
    const effectiveRunPermissions = resolvedRunPermissions
    const payload: ComposerRunPayload = {
      provider,
      scope,
      ...(scope === 'global'
        ? {}
        : {
            workspace: requireNonEmptyString(
              effectiveInput.workspace || chat.workspacePath,
              'Workspace'
            )
          }),
      ...(effectiveProviderReroute ? { providerReroute: effectiveProviderReroute } : {}),
      // Carry the per-chat Ollama run profile onto the run payload so the
      // OllamaProvider applies the chat's runtime tuning. Absent → global default.
      ...(provider === 'ollama' && chatOllamaRunProfile
        ? { ollamaRunProfile: chatOllamaRunProfile }
        : {}),
      prompt: composed.contextualPrompt,
      ...(resumeFallbackPrompt && resumeFallbackPrompt !== composed.contextualPrompt
        ? { resumeFallbackPrompt }
        : {}),
      instructionsDigest: instructionContext?.digest || 'none',
      activeGoal,
      appRunId,
      appChatId: chatId,
      model: requestedModel,
      reasoningEffort: reasoningEffort === 'none' ? null : reasoningEffort,
      serviceTier:
        provider === 'codex'
          ? optionalStringOrNull(effectiveInput.codexServiceTier) || null
          : provider === 'kimi'
            ? !isKimiK3Model(requestedModel) &&
              (effectiveInput.kimiFastMode ?? metadataBoolean(chat, 'kimiFastMode') ?? false)
              ? 'fast'
              : 'standard'
            : provider === 'cursor' && isCursorGrokModelId(requestedModel)
              ? (effectiveInput.cursorFastMode ?? metadataBoolean(chat, 'cursorFastMode') ?? false)
                ? 'fast'
                : null
              : null,
      claudeReasoningEffort:
        provider === 'claude'
          ? optionalStringOrNull(effectiveInput.claudeReasoningEffort) || null
          : null,
      claudeFastMode:
        provider === 'claude'
          ? (effectiveInput.claudeFastMode ?? metadataBoolean(chat, 'claudeFastMode') ?? false)
          : null,
      kimiThinking: provider === 'kimi' ? true : null,
      approvalMode,
      workflowMode,
      ...(effectiveRunPermissions ? { effectivePermissions: effectiveRunPermissions } : {}),
      // Stamp the posture so the renderer can round-trip this payload back
      // through `run-agent` without the normalize-time clamp downgrading it.
      // Signed even when `effectiveRunPermissions` is undefined (non-plan
      // runs) so the approvalMode itself is bound against post-compose bumps.
      ...(this.deps.signRunPermissionPosture
        ? {
            effectivePermissionsSignature: this.deps.signRunPermissionPosture(
              approvalMode,
              effectiveRunPermissions,
              {
                provider,
                scope,
                appRunId,
                appChatId: chatId,
                prompt: composed.contextualPrompt,
                ...(resumeFallbackPrompt && resumeFallbackPrompt !== composed.contextualPrompt
                  ? { resumeFallbackPrompt }
                  : {}),
                workflowMode,
                runtimeProfileId,
                projectReferenceContextHash: hashProjectReferenceContext(projectReferenceContext)
              }
            )
          }
        : {}),
      imagePaths,
      providerSessionId: resumeDecision.sessionId || null,
      externalPathGrants,
      ...(projectReferenceContext ? { projectReferenceContext } : {}),
      sessionTrust: provider === 'gemini' ? Boolean(effectiveInput.sessionTrust) : false,
      geminiWorktree:
        scope !== 'global' && provider === 'gemini' ? effectiveInput.geminiWorktree : null,
      runtimeProfileId,
      taskWraithMcpProfileId: taskWraithMcpProfile.profileId,
      taskWraithMcpAdvertised,
      geminiAuthProfileId,
      handoffSourceRunId: optionalString(input.handoffSourceRunId),
      composer: {
        finalPrompt,
        contextTurnsApplied: composed.contextTurnsApplied,
        applicationLog: composed.applicationLog,
        providerLabel: getProviderLabel(provider),
        requestedModel,
        approvalMode,
        workflowMode,
        providerSessionId: resumeDecision.sessionId || null,
        geminiResumeSkippedReason: resumeDecision.skippedReason,
        clearLinkedGeminiSession: Boolean(resumeDecision.skippedReason),
        providerMetadataPatch,
        codexHandoffApplied: composed.codexHandoffApplied,
        uiNoticeMessage: composed.uiNoticeMessage,
        imagePaths,
        ...(projectReferenceContext ? { projectReferenceContext } : {}),
        ...(discordContextSnapshots.length > 0
          ? {
              discordContextReads: discordContextSnapshots.map((snapshot) =>
                redactDiscordContextReadMetadataForHistory(snapshot.metadata)
              )
            }
          : {}),
        planModeParsed: planParsed.planMode,
        ...(selfReflectiveRequested ? { selfReflectiveRequested: true } : {}),
        promptEnvelope: buildPromptEnvelopeSnapshot({
          provider,
          model: requestedModel,
          composedPrompt: composed.contextualPrompt,
          layers: composed.envelopeLayers,
          instructionsDigest: instructionContext?.digest || 'none',
          storeContent: settings.storeRawEvents === true
        })
      }
    }

    return payload
  }
}

function assertChannelAgentComposerAuthority(
  input: ComposerInput,
  authority: ChannelAgentComposerAuthority
): void {
  const authorityKeys = [
    'kind',
    'appRunId',
    'chatId',
    'provider',
    'scope',
    ...(authority?.scope === 'workspace' ? ['workspacePath'] : []),
    'approvalMode',
    'workflowMode',
    'permissionPresetId',
    'effectivePermissions'
  ]
  const actualAuthorityKeys =
    authority && typeof authority === 'object' ? Object.keys(authority) : []
  const forbiddenInput = Boolean(
    input.scheduledTaskId ||
    input.providerReroute ||
    input.chatSnapshot ||
    input.verbatimPrompt ||
    input.handoffSourceRunId ||
    input.projectReferenceContextSelection ||
    input.geminiWorktree ||
    input.sessionTrust ||
    (input.attachments?.length ?? 0) > 0 ||
    (input.imageAttachments?.length ?? 0) > 0 ||
    (input.externalPathGrants?.length ?? 0) > 0 ||
    (input.discordContextSnapshots?.length ?? 0) > 0 ||
    (input.excludeMessageIds?.length ?? 0) > 0
  )
  if (
    !authority ||
    authority.kind !== 'channel_agent' ||
    actualAuthorityKeys.length !== authorityKeys.length ||
    actualAuthorityKeys.some((key) => !authorityKeys.includes(key)) ||
    input.contextIsolation !== 'channel_agent' ||
    input.appRunId !== authority.appRunId ||
    input.chatId !== authority.chatId ||
    input.provider !== authority.provider ||
    input.scope !== authority.scope ||
    input.approvalMode !== authority.approvalMode ||
    input.workflowMode !== authority.workflowMode ||
    input.permissionPresetId !== authority.permissionPresetId ||
    authority.effectivePermissions?.presetId !== authority.permissionPresetId ||
    authority.effectivePermissions?.approvalMode !== authority.approvalMode ||
    (authority.scope === 'workspace'
      ? !authority.workspacePath || input.workspace !== authority.workspacePath
      : Boolean(authority.workspacePath) || Boolean(input.workspace)) ||
    forbiddenInput
  ) {
    throw new Error('Channel agent composer authority is invalid.')
  }
}

function missingProjectReferenceContextAuthority(): never {
  throw new Error('Project reference context is unavailable in this runtime.')
}

function applyComposerReroutePlan(
  input: ComposerInput,
  resolution: ProviderDispatchResolution,
  originalProvider: ProviderId,
  requestedApprovalMode: string | undefined
): ComposerInput {
  const plan = resolution.reroutePlan
  if (!plan) return input
  const providerChanged = originalProvider !== resolution.provider
  const rerouteApprovalMode = cappedComposerRerouteApprovalMode(
    requestedApprovalMode,
    plan.approvalMode
  )
  return {
    ...input,
    provider: resolution.provider,
    ...(plan.selectedModelType ? { selectedModelType: plan.selectedModelType } : {}),
    ...(plan.customModel !== undefined ? { customModel: plan.customModel } : {}),
    ...(rerouteApprovalMode ? { approvalMode: rerouteApprovalMode } : {}),
    runtimeProfileId:
      plan.runtimeProfileId || (providerChanged ? undefined : input.runtimeProfileId),
    ...(resolution.provider === 'gemini'
      ? { geminiAuthProfileId: plan.geminiAuthProfileId ?? null }
      : {}),
    ...(resolution.provider === 'codex'
      ? {
          codexReasoningEffort: plan.codexReasoningEffort ?? null,
          codexServiceTier: plan.codexServiceTier ?? null
        }
      : {}),
    ...(resolution.provider === 'claude'
      ? {
          claudeReasoningEffort: plan.claudeReasoningEffort ?? null,
          claudeFastMode: plan.claudeFastMode ?? null
        }
      : {}),
    ...(resolution.provider === 'kimi'
      ? {
          kimiFastMode: plan.kimiFastMode ?? false,
          kimiReasoningEffort: plan.kimiReasoningEffort ?? null,
          kimiThinkingEnabled: true
        }
      : {}),
    ...(resolution.provider === 'grok'
      ? { grokReasoningEffort: plan.grokReasoningEffort ?? null }
      : {}),
    ...(resolution.provider === 'ollama'
      ? { ollamaReasoningEffort: plan.ollamaReasoningEffort ?? null }
      : {}),
    ...(resolution.provider === 'cursor'
      ? {
          cursorReasoningEffort: plan.cursorReasoningEffort ?? null,
          cursorFastMode: plan.cursorFastMode ?? null
        }
      : {})
  }
}

function cappedComposerRerouteApprovalMode(
  currentMode: string | undefined,
  plannedMode: string | undefined
): string | undefined {
  const planned = normalizeComposerRerouteApprovalMode(plannedMode)
  if (!planned) return undefined
  const current = coerceApprovalMode(currentMode) || 'default'
  return approvalModeRank(planned) <= approvalModeRank(current) ? planned : undefined
}

function normalizeComposerRerouteApprovalMode(value: string | undefined): string | undefined {
  if (value === 'full_access') return 'auto_edit'
  return coerceApprovalMode(value)
}

function resolveComposerWorkflowMode(
  explicitWorkflowMode: unknown,
  chatWorkflowMode: unknown,
  planModeParsed: boolean
): ChatWorkflowMode {
  const explicit = normalizeComposerWorkflowMode(explicitWorkflowMode)
  if (explicit) return explicit
  if (planModeParsed) return 'plan'
  const persisted = normalizeComposerWorkflowMode(chatWorkflowMode)
  if (persisted) return persisted
  return 'normal'
}

function normalizeComposerWorkflowMode(value: unknown): ChatWorkflowMode | undefined {
  return value === 'plan' || value === 'normal' ? value : undefined
}

function normalizePermissionPresetId(value: unknown): PermissionPresetId | undefined {
  return value === 'read_only' ||
    value === 'plan' ||
    value === 'default' ||
    value === 'workspace_write' ||
    value === 'full_access' ||
    value === 'custom'
    ? value
    : undefined
}

function resolveInteractivePermissionPresetId(
  approvalMode: string,
  workflowMode: ChatWorkflowMode,
  requested: unknown,
  trustedSessionGranted = false
): PermissionPresetId {
  if (approvalMode === 'plan') return workflowMode === 'plan' ? 'plan' : 'read_only'
  const requestedPreset = normalizePermissionPresetId(requested)
  if (approvalMode === 'auto_edit') {
    return requestedPreset === 'full_access' && trustedSessionGranted
      ? 'full_access'
      : 'workspace_write'
  }
  return 'default'
}

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
}

/**
 * AntiGravity's two lanes are admitted INDEPENDENTLY, and each on evidence
 * about itself:
 * - the agy/CLI ban-risk lane on its recorded opt-in, and
 * - the Gemini API-key lane on a currently configured key.
 *
 * The union matters because it is a lane-agnostic gate: a bare quota model and
 * a `gemini-api:` model both arrive here as provider `antigravity`, and the
 * dispatch fork happens later in `dispatchAntigravityCombinedMode`. Gating on
 * the key alone therefore stranded the OTHER lane — an opted-in user with no
 * API key could select an agy quota model and physically could not send it.
 *
 * The previous comment here claimed the agy lane "opens an external terminal"
 * and so never reaches interactive compose. That was wrong:
 * `runAntigravityAgyProvider` spawns an in-app PTY child through
 * `runCliProviderProcess`, exactly like every other CLI transport.
 */
function assertLiveProviderId(value: unknown): ProviderId {
  const provider = assertProviderId(value)
  if (isLiveSelectableProvider(provider)) return provider
  if (
    provider === ANTIGRAVITY_PROVIDER_ID &&
    (isAntigravityAgyOptInEnabled() || isAntigravityGeminiApiKeyConfigured())
  ) {
    return provider
  }
  throw new Error(`${provider} is unavailable for new runs.`)
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataString(chat: ChatRecord, key: string): string | undefined {
  const value = chat.providerMetadata?.[key]
  return typeof value === 'string' ? value : undefined
}

function metadataBoolean(chat: ChatRecord, key: string): boolean | undefined {
  const value = chat.providerMetadata?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function resolveRequestedModel(
  provider: ProviderId,
  input: ComposerInput,
  chat: ChatRecord
): string {
  const selectedModel =
    optionalString(input.selectedModelType) ||
    metadataString(chat, 'selectedModelType') ||
    getLastRequestedModelForProvider(chat, provider) ||
    getDefaultModelForProvider(provider)
  if (input.overrideModel) {
    return input.overrideModel
  }
  if (selectedModel === 'custom') {
    return optionalString(input.customModel) || metadataString(chat, 'customModel') || selectedModel
  }
  return selectedModel
}

function resolveApprovalMode(
  scope: ChatScope,
  requested: string | undefined,
  chat: ChatRecord
): string {
  const mode =
    requested ||
    metadataString(chat, 'approvalMode') ||
    chat.settingsSnapshot?.approvalMode ||
    'default'
  return scope === 'global' && mode !== 'plan' ? 'default' : mode
}

function capRequestedApprovalMode(
  trustedMode: string,
  requestedMode: string,
  appRunId: string | undefined
): string {
  const trusted = coerceApprovalMode(trustedMode) || 'default'
  const requested = coerceApprovalMode(requestedMode) || 'default'
  if (approvalModeRank(requested) > approvalModeRank(trusted)) return trusted
  if (!appRunId && approvalModeRank(requested) > approvalModeRank('default')) return 'default'
  return requested
}

function resolveResumeDecision(
  provider: ProviderId,
  chat: ChatRecord,
  requestedModel: string | undefined,
  approvalMode: string,
  worktree?: GeminiWorktreeLaunchOption,
  geminiAuthProfileId?: string | null
): { sessionId?: string; skippedReason?: string } {
  if (provider !== 'gemini') {
    return { sessionId: normalizeProviderSessionId(chat.linkedProviderSessionId) }
  }
  return resolveGeminiResumeForRun(
    chat,
    requestedModel,
    approvalMode,
    worktree,
    geminiAuthProfileId
  )
}

function normalizeProviderSessionId(value?: string | null): string | undefined {
  const target = value?.trim()
  if (!target || target.toLowerCase() === 'unknown') return undefined
  return /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,511}$/.test(target) ? target : undefined
}

function normalizeComposerAttachments(
  attachments: ComposerImageAttachment[]
): ComposerImageAttachment[] {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map<ComposerImageAttachment | null>((item) => {
      const path = typeof item?.path === 'string' ? item.path.trim() : ''
      if (!path) return null
      return {
        ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {}),
        path,
        ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
        ...(isDirectoryComposerAttachment(item) ? { kind: 'directory' as const } : {})
      }
    })
    .filter((item): item is ComposerImageAttachment => item !== null)
}

function normalizeImagePaths(attachments: ComposerImageAttachment[]): string[] {
  return attachments
    .filter((attachment) => !isDirectoryComposerAttachment(attachment))
    .map((attachment) => attachment.path || '')
    .filter(Boolean)
}

function normalizeComposerExternalPathGrants(
  value: ExternalPathGrant[],
  provider: ProviderId
): ExternalPathGrant[] {
  if (!Array.isArray(value)) return []
  const grants: ExternalPathGrant[] = []
  for (const grant of value) {
    if (!grant || grant.provider !== provider || typeof grant.path !== 'string') continue
    if (grant.issuedBy !== 'main' || typeof grant.signature !== 'string' || !grant.signature)
      continue
    if (!grant.path.trim()) continue
    if (grant.access !== 'read' && grant.access !== 'write') continue
    if (grant.kind !== 'file' && grant.kind !== 'directory') continue
    if (
      grant.duration !== 'thisRun' &&
      grant.duration !== 'thisThread' &&
      grant.duration !== 'workspace'
    ) {
      continue
    }
    // The run normalizer owns HMAC verification. Preserve the signed object
    // byte-for-byte here; coercing any authority field would invalidate v2.
    grants.push(grant)
  }
  // 1.0.6-EW66 — `order` is a renderer/display-only field; it has no
  // meaning in the provider dispatch payload, so strip it here.
  return stripExternalPathGrantOrder(coalesceExternalPathGrants(grants))
}

function attachmentPromptAppendix(attachments: ComposerImageAttachment[]): string {
  if (attachments.length === 0) {
    return ''
  }
  const lines = attachments.map(
    (attachment, index) =>
      `${index + 1}. ${isDirectoryComposerAttachment(attachment) ? 'Folder' : 'File'}: "${(attachment.path || '').replace(/"/g, '\\"')}"`
  )
  return `\n\nAttachment references for this request:\n${lines.join('\n')}`
}

function externalPathGrantPromptAppendix(grants: ExternalPathGrant[] = []): string {
  if (grants.length === 0) {
    return ''
  }
  const lines = grants.map((grant, index) => {
    const access = grant.access === 'write' ? 'view and edit' : 'view'
    return `${index + 1}. ${access} ${grant.kind}: "${grant.path.replace(/"/g, '\\"')}"`
  })
  return `\n\nUser-approved additional workspace access for this request:\n${lines.join('\n')}\nUse only these paths outside the primary workspace.`
}

/**
 * Parses composer-level slash signals out of the user's raw prompt.
 *
 *   - ` ```plan ` (or ` ```taskwraith-plan `) fenced block → planMode=true
 *     and the block is stripped. Pre-existing behaviour (1.0.3); the
 *     composer then forces approvalMode='plan' for the run.
 *   - `/discuss` (alias `/meta`) leading token → selfReflective=true
 *     and the token is stripped from the leading whitespace. The
 *     orchestrator picks the flag up at round start and sets
 *     `chat.ensemble.selfReflective = true` for the round so
 *     `EnsemblePrompt` inverts the deictic rule. The prefix only
 *     fires when it's the first non-whitespace token; a `/discuss`
 *     buried inside the prompt body is left untouched so users can
 *     still talk about the command verbatim.
 *
 * Returns the cleaned prompt plus the two parsed signal flags.
 * Falls back to the original input if the cleaning steps left the
 * prompt empty (so callers that depend on a non-empty prompt still
 * see a usable string and can fail with their own validation).
 */
function parsePlanModeInput(input: string): {
  prompt: string
  planMode: boolean
  selfReflective: boolean
} {
  let planMode = false
  let selfReflective = false
  let working = input.replace(/```(?:taskwraith-)?plan[^\n]*\n[\s\S]*?```/gi, () => {
    planMode = true
    return ''
  })
  const discussMatch = working.match(/^[ \t]*\/(discuss|meta)\b[ \t]*/i)
  if (discussMatch) {
    selfReflective = true
    working = working.slice(discussMatch[0].length)
  }
  const prompt = working.trim()
  return { prompt: prompt || input, planMode, selfReflective }
}

function getProviderLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'antigravity') return 'AntiGravity'
  if (provider === 'pi') return 'Pi'
  return 'Gemini'
}

// Main's half of the silent-fallthrough bug class the renderer closed in
// providerModelDefaults.ts. This chain ended in `return 'flash-lite'`, so a
// provider with no branch was handed A GEMINI MODEL ID ON ITS OWN RUN — and
// `mistral` had no branch: `resolveRequestedModel` falls back here whenever a
// run arrives with no selected/stored model, and index.ts forces this value as
// `overrideModel` for every cross-provider verifier. Now exhaustive: `gemini`
// is a real case and the `default` arm takes a `never`, so the next ProviderId
// added to the union fails typecheck here instead of quietly running Gemini.
export function getDefaultModelForProvider(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return 'gpt-5.5'
    case 'claude':
      return 'claude-sonnet-5'
    case 'kimi':
      return 'kimi-k2.7-code'
    case 'grok':
      return GROK_46_MODEL_ID
    case 'cursor':
      return 'composer-2.5-fast'
    case 'ollama':
      return 'qwen3:4b-instruct'
    // A bare gemini token here would dodge the gemini-api candidate matcher and
    // route a model-less AntiGravity run onto the ban-risk agy CLI lane. The
    // wire-id default keeps it on the key lane (which fails visibly without a
    // key) and is present in the static fallback catalogue.
    case 'antigravity':
      return 'gemini-api:gemini-2.5-flash'
    // Pi wire ids are `<upstream>/<model>`; the default must stay in the curated
    // static catalogue (PiModels) so the policy wall and pickers agree.
    case 'pi':
      return 'deepseek/deepseek-v4-flash'
    // Bare id — a `mistral/<model>` id belongs to Pi's BYOK upstream, which is a
    // different provider that happens to share the brand word.
    case 'mistral':
      return MISTRAL_DEFAULT_MODEL
    case 'muse':
      return MUSE_DEFAULT_MODEL
    case 'gemini':
      return 'flash-lite'
    default: {
      const unhandled: never = provider
      throw new Error(
        `[ComposerService] No default model for provider "${String(unhandled)}". Add a case — ` +
          "falling through would dispatch another provider's model id on this run."
      )
    }
  }
}

function getLastRequestedModelForProvider(
  chat: ChatRecord,
  provider: ProviderId
): string | undefined {
  const runs = [...(chat.runs || [])].reverse()
  const run = runs.find(
    (candidate) => (candidate.provider || chat.provider || 'gemini') === provider
  )
  return run?.requestedModel || run?.actualModel || chat.requestedModel
}

function getLastCompletedCodexRunModel(chat: ChatRecord): string | null {
  const runs = [...(chat.runs || [])].reverse()
  const run = runs.find(
    (candidate) =>
      (candidate.provider || chat.provider || 'gemini') === 'codex' &&
      isCompletedCodexRunStatus(candidate.status)
  )
  return run?.actualModel || run?.requestedModel || null
}

function isCompletedCodexRunStatus(status?: string): boolean {
  return status === 'success' || status === 'success_with_warnings'
}

function getCodexModelContextAppliedKeys(chat: ChatRecord): string[] {
  const rawKeys = chat.providerMetadata?.codexModelContextAppliedKeys
  return Array.isArray(rawKeys)
    ? rawKeys.filter((value): value is string => typeof value === 'string')
    : []
}

function buildProviderMetadataPatch(
  composed: ComposeRunPromptResult,
  codexHandoffsApplied: string[]
): Record<string, unknown> | undefined {
  if (!composed.codexHandoffApplied) return undefined
  return {
    codexModelContextAppliedKeys: [
      ...codexHandoffsApplied,
      composed.codexHandoffApplied.handoffKey
    ],
    lastCodexModelContextHandoffAt: composed.codexHandoffApplied.appliedAt
  }
}

function resolveGeminiResumeForRun(
  chat: ChatRecord,
  requestedModel: string | undefined,
  approvalMode: string,
  worktree?: GeminiWorktreeLaunchOption,
  geminiAuthProfileId?: string | null
): { sessionId?: string; skippedReason?: string } {
  const sessionId = normalizeProviderSessionId(chat.linkedGeminiSessionId)
  if (!sessionId) {
    return {}
  }

  if (approvalMode !== 'plan') {
    return {
      skippedReason:
        'Starting a fresh Gemini session because write-capable Gemini runs cannot safely resume CLI sessions; Gemini can persist plan-mode tool limits inside a resumed session.'
    }
  }

  const lastRun = getLastGeminiRunForResume(chat)
  if (!lastRun) {
    return { sessionId }
  }

  const previousAuthProfileId =
    typeof lastRun.geminiAuthProfileId === 'string' ? lastRun.geminiAuthProfileId : null
  const nextAuthProfileId = geminiAuthProfileId || null
  if (previousAuthProfileId !== nextAuthProfileId) {
    return {
      skippedReason:
        'Starting a fresh Gemini session because the selected Gemini auth profile changed.'
    }
  }

  const previousApprovalMode = lastRun.approvalMode || 'default'
  if (previousApprovalMode !== approvalMode) {
    return {
      skippedReason: `Starting a fresh Gemini session because approval mode changed from ${previousApprovalMode} to ${approvalMode}.`
    }
  }

  const previousModel = lastRun.requestedModel || lastRun.actualModel
  const previousModelKey = normalizeModelKey(previousModel)
  const nextModelKey = normalizeModelKey(requestedModel)
  if (previousModelKey && nextModelKey && previousModelKey !== nextModelKey) {
    return {
      skippedReason: `Starting a fresh Gemini session because model changed from ${previousModel} to ${requestedModel}.`
    }
  }

  const previousWorktreeKey = getGeminiWorktreeResumeKey(lastRun.geminiWorktree)
  const nextWorktreeKey = getGeminiWorktreeResumeKey(worktree)
  if (previousWorktreeKey !== nextWorktreeKey) {
    return {
      skippedReason: 'Starting a fresh Gemini session because the Gemini worktree setting changed.'
    }
  }

  return { sessionId }
}

function getLastGeminiRunForResume(chat: ChatRecord): ChatRun | undefined {
  const runs = [...(chat.runs || [])].reverse()
  return runs.find((candidate) => (candidate.provider || chat.provider || 'gemini') === 'gemini')
}

function getGeminiWorktreeResumeKey(worktree?: GeminiWorktreeLaunchOption): string {
  if (!isGeminiWorktreeConfig(worktree) || !worktree.enabled) {
    return 'disabled'
  }
  return ['enabled', worktree.name || '', worktree.effectivePath || ''].join('\u0000')
}

function isGeminiWorktreeConfig(
  value: GeminiWorktreeLaunchOption
): value is { enabled: boolean; name?: string; effectivePath?: string } {
  return Boolean(value && typeof value === 'object' && 'enabled' in value)
}

function normalizeModelKey(model?: string | null): string {
  return String(model || '')
    .trim()
    .toLowerCase()
}
