import type { AgentRunPayload } from '../run/AgentRunTypes'
import { DEFAULT_PROVIDER } from '../../shared/retiredProviders'
import { composeRunPrompt, type ComposeRunPromptResult } from '../PromptComposition'
import {
  formatDiscordContextPromptAppendix,
  normalizeDiscordContextSnapshots,
  redactDiscordContextReadMetadataForHistory,
  type DiscordContextReadMetadata,
  type DiscordContextSnapshot
} from '../channels/DiscordContextService'
import { normalizeOllamaSessionMemory } from '../ollama/OllamaRunMemory'
import { effectiveOllamaToolControlTier } from '../ollama/OllamaToolTiers'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  approvalModeRank,
  coerceApprovalMode,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import { resolveProviderDispatch, type ProviderDispatchResolution } from '../ProviderRunPause'
import { resolveActiveGoalForProvider } from '../GoalState'
import {
  coalesceExternalPathGrants,
  stripExternalPathGrantOrder
} from '../store/ExternalPathGrants'
import type {
  AppSettings,
  ChatRecord,
  ChatRun,
  ChatScope,
  EffectiveRunPermissions,
  ExternalPathGrant,
  GeminiWorktreeLaunchOption,
  ProviderRunReroute,
  ProviderId
} from '../store/types'

// Grok + Cursor are first-class providers; no eligibility gate (see ProviderId).
const PROVIDER_IDS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])

export interface ComposerImageAttachment {
  id?: string
  path?: string
  name?: string
}

export interface ComposerInput {
  chatId: string
  appRunId?: string
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
  sessionTrust?: boolean
  attachments?: ComposerImageAttachment[]
  imageAttachments?: ComposerImageAttachment[]
  externalPathGrants?: ExternalPathGrant[]
  geminiWorktree?: GeminiWorktreeLaunchOption
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  discordContextSnapshots?: DiscordContextSnapshot[]
  chatSnapshot?: ChatRecord
}

export interface ComposerRunMetadata {
  finalPrompt: string
  contextTurnsApplied: number
  applicationLog: string
  providerLabel: string
  requestedModel?: string
  approvalMode: string
  providerSessionId?: string | null
  geminiResumeSkippedReason?: string
  clearLinkedGeminiSession?: boolean
  providerMetadataPatch?: Record<string, unknown>
  codexHandoffApplied?: ComposeRunPromptResult['codexHandoffApplied']
  uiNoticeMessage?: string
  imagePaths: string[]
  discordContextReads?: DiscordContextReadMetadata[]
  planModeParsed?: boolean
  /**
   * 1.0.4-AF — set when the user prefixed the prompt with `/discuss`
   * (or `/meta`). Signals the renderer / orchestrator to flip the
   * active ensemble round into self-reflective mode (see
   * `EnsembleConfig.selfReflective`). The slash token is stripped
   * from `finalPrompt` so it never reaches the provider verbatim.
   */
  selfReflectiveRequested?: boolean
}

export type ComposerRunPayload = AgentRunPayload & {
  composer: ComposerRunMetadata
}

export interface ComposerServiceStore {
  getChat: (chatId: string) => ChatRecord | null
}

export interface ComposerServiceDeps {
  appStore: ComposerServiceStore
  getSettings: () => AppSettings
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
}

export class ComposerService {
  constructor(private deps: ComposerServiceDeps) {}

  composeRun(input: ComposerInput): ComposerRunPayload {
    const chatId = requireNonEmptyString(input?.chatId, 'Chat id')
    const storedChat = this.deps.appStore.getChat(chatId)
    const chat = input.chatSnapshot || storedChat
    if (!chat) {
      throw new Error(`Chat was not found: ${chatId}`)
    }
    const trustedApprovalChat: ChatRecord = storedChat || {
      ...chat,
      providerMetadata: {},
      settingsSnapshot: undefined
    }

    // Live default for a provider-less compose (was `|| 'gemini'`). An explicit
    // gemini chat still composes its gemini prompt and is blocked at dispatch.
    const requestedProvider = assertProviderId(input.provider || chat.provider || DEFAULT_PROVIDER)
    const scope: ChatScope =
      input.scope === 'global' || chat.scope === 'global' ? 'global' : 'workspace'
    const settings = this.deps.getSettings()
    const dispatchResolution = resolveProviderDispatch(settings, requestedProvider)
    const provider = dispatchResolution.provider
    const rawInputBeforeReroute =
      typeof input.userInput === 'string'
        ? input.userInput
        : typeof input.prompt === 'string'
          ? input.prompt
          : ''
    const requestedPlanMode = parsePlanModeInput(rawInputBeforeReroute).planMode
    const trustedApprovalMode = resolveApprovalMode(
      scope,
      requestedPlanMode ? 'plan' : undefined,
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
    const basePrompt = planParsed.prompt
    if (!basePrompt.trim()) {
      throw new Error('Prompt is required.')
    }
    const selfReflectiveRequested = planParsed.selfReflective

    const requestedModel = resolveRequestedModel(provider, effectiveInput, chat)
    const requestedApprovalMode = planParsed.planMode ? 'plan' : effectiveInput.approvalMode
    const appRunId = optionalString(input.appRunId)
    let approvalMode =
      provider === 'ollama'
        ? 'plan'
        : capRequestedApprovalMode(
            resolveApprovalMode(scope, undefined, trustedApprovalChat),
            resolveApprovalMode(scope, requestedApprovalMode, trustedApprovalChat),
            appRunId
          )
    const imagePaths = normalizeImagePaths(
      effectiveInput.imageAttachments || effectiveInput.attachments || []
    )
    const externalPathGrants =
      scope !== 'global'
        ? normalizeComposerExternalPathGrants(effectiveInput.externalPathGrants || [], provider)
        : []
    const discordContextSnapshots = normalizeDiscordContextSnapshots(input.discordContextSnapshots)
    const finalPrompt = `${basePrompt}${attachmentPromptAppendix(imagePaths)}${provider === 'codex' ? externalPathGrantPromptAppendix(externalPathGrants) : ''}`
    const contextualFinalPrompt = `${finalPrompt}${formatDiscordContextPromptAppendix(discordContextSnapshots)}`
    const geminiAuthProfileId =
      provider === 'gemini'
        ? optionalStringOrNull(effectiveInput.geminiAuthProfileId) ||
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
    const activeGoal = resolveActiveGoalForProvider(chat.activeGoal, provider, {
      codexNativeAvailable: Boolean(chat.providerMetadata?.codexGoalNativeAvailable),
      claudeNativeAvailable: Boolean(chat.providerMetadata?.claudeGoalNativeAvailable)
    })
    const composed = composeRunPrompt({
      provider,
      finalPrompt: contextualFinalPrompt,
      messages: chat.messages || [],
      chatContextTurns: settings.chatContextTurns,
      resumeSessionId: resumeDecision.sessionId || undefined,
      lastCompletedCodexModel,
      nextModel: requestedModel,
      codexHandoffsApplied,
      isGlobalRun: scope === 'global',
      approvalMode,
      runtimePreambleVersion: metadataString(chat, 'taskWraithRuntimePreambleVersion'),
      runtimePreambleProvider: metadataString(chat, 'taskWraithRuntimePreambleProvider'),
      providerLabel: getProviderLabel(provider),
      nativeSubAgentRequests: settings.nativeSubAgentRequests,
      guestParticipant: chat.guestParticipant,
      activeGoal,
      ...(provider === 'ollama'
        ? {
            ollamaToolControlTier: effectiveOllamaToolControlTier(
              settings,
              scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath
            ),
            ollamaSessionMemory: normalizeOllamaSessionMemory(chat.ollamaSessionMemory)
          }
        : {})
    })

    const providerMetadataPatchData = {
      ...buildProviderMetadataPatch(composed, codexHandoffsApplied),
      ...(composed.runtimePreambleVersion
        ? {
            taskWraithRuntimePreambleVersion: composed.runtimePreambleVersion,
            taskWraithRuntimePreambleProvider: composed.runtimePreambleProvider || provider
          }
        : {}),
      ...(provider === 'gemini' ? { geminiAuthProfileId } : {})
    }
    const providerMetadataPatch =
      Object.keys(providerMetadataPatchData).length > 0 ? providerMetadataPatchData : undefined
    // 1.0.72 — populate the canonical read-only permissions for the SINGLE-run
    // path. Previously only EnsembleOrchestrator called resolveEffectiveRunPermissions,
    // so a regular plan-mode run carried `effectivePermissions: undefined` — which
    // left isReadOnlyBlockedTool() (the fall-through-mutator hard-deny) AND the YOLO
    // read-only suppression INERT for non-ensemble runs. Only populated for a
    // read-only (plan) run, so non-read-only runs are byte-for-byte unchanged.
    const effectiveRunPermissions =
      approvalMode === 'plan'
        ? resolveEffectiveRunPermissions({
            provider,
            workspacePath:
              scope === 'global' ? undefined : effectiveInput.workspace || chat.workspacePath,
            settings,
            presetId: 'read_only'
          })
        : undefined
    const runtimeProfileId = optionalString(effectiveInput.runtimeProfileId)
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
      ...(input.providerReroute || dispatchResolution.reroute
        ? { providerReroute: input.providerReroute || dispatchResolution.reroute }
        : {}),
      prompt: composed.contextualPrompt,
      appRunId,
      appChatId: chatId,
      model: requestedModel,
      reasoningEffort:
        provider === 'codex'
          ? optionalStringOrNull(effectiveInput.codexReasoningEffort) || null
          : null,
      serviceTier:
        provider === 'codex'
          ? optionalStringOrNull(effectiveInput.codexServiceTier) || null
          : null,
      claudeReasoningEffort:
        provider === 'claude'
          ? optionalStringOrNull(effectiveInput.claudeReasoningEffort) || null
          : null,
      claudeFastMode:
        provider === 'claude'
          ? (effectiveInput.claudeFastMode ?? metadataBoolean(chat, 'claudeFastMode') ?? false)
          : null,
      kimiThinking:
        provider === 'kimi'
          ? (effectiveInput.kimiThinkingEnabled ?? metadataBoolean(chat, 'kimiThinkingEnabled') ?? true)
          : null,
      approvalMode,
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
                runtimeProfileId
              }
            )
          }
        : {}),
      imagePaths,
      providerSessionId: resumeDecision.sessionId || null,
      externalPathGrants,
      sessionTrust: provider === 'gemini' ? Boolean(effectiveInput.sessionTrust) : false,
      geminiWorktree:
        scope !== 'global' && provider === 'gemini' ? effectiveInput.geminiWorktree : null,
      runtimeProfileId,
      geminiAuthProfileId,
      handoffSourceRunId: optionalString(input.handoffSourceRunId),
      composer: {
        finalPrompt,
        contextTurnsApplied: composed.contextTurnsApplied,
        applicationLog: composed.applicationLog,
        providerLabel: getProviderLabel(provider),
        requestedModel,
        approvalMode,
        providerSessionId: resumeDecision.sessionId || null,
        geminiResumeSkippedReason: resumeDecision.skippedReason,
        clearLinkedGeminiSession: Boolean(resumeDecision.skippedReason),
        providerMetadataPatch,
        codexHandoffApplied: composed.codexHandoffApplied,
        uiNoticeMessage: composed.uiNoticeMessage,
        imagePaths,
        ...(discordContextSnapshots.length > 0
          ? {
              discordContextReads: discordContextSnapshots.map((snapshot) =>
                redactDiscordContextReadMetadataForHistory(snapshot.metadata)
              )
            }
          : {}),
        planModeParsed: planParsed.planMode,
        ...(selfReflectiveRequested ? { selfReflectiveRequested: true } : {})
      }
    }

    return payload
  }
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
    runtimeProfileId: plan.runtimeProfileId || (providerChanged ? undefined : input.runtimeProfileId),
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
      ? { kimiThinkingEnabled: plan.kimiThinkingEnabled ?? true }
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

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
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

function normalizeImagePaths(attachments: ComposerImageAttachment[]): string[] {
  if (!Array.isArray(attachments)) return []
  return attachments
    .map((item) => (typeof item?.path === 'string' ? item.path.trim() : ''))
    .filter((path): path is string => Boolean(path))
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
    const access = grant.access === 'write' ? 'write' : 'read'
    const grantPath = grant.path.trim()
    if (!grantPath) continue
    grants.push({
      ...grant,
      path: grantPath,
      access,
      kind: grant.kind === 'directory' ? 'directory' : 'file',
      duration: grant.duration || 'thisThread'
    })
  }
  // 1.0.6-EW66 — `order` is a renderer/display-only field; it has no
  // meaning in the provider dispatch payload, so strip it here.
  return stripExternalPathGrantOrder(coalesceExternalPathGrants(grants))
}

function attachmentPromptAppendix(imagePaths: string[]): string {
  if (imagePaths.length === 0) {
    return ''
  }
  const lines = imagePaths.map(
    (imagePath, index) => `${index + 1}. "${imagePath.replace(/"/g, '\\"')}"`
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
  return `\n\nUser-approved external path grants for this Codex request:\n${lines.join('\n')}\nUse only these paths outside the workspace.`
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
  return 'Gemini'
}

function getDefaultModelForProvider(provider: ProviderId): string {
  if (provider === 'codex') return 'gpt-5.5'
  if (provider === 'claude') return 'default'
  if (provider === 'kimi') return 'kimi-k2.7-code'
  if (provider === 'grok') return 'grok-composer-2.5-fast'
  if (provider === 'cursor') return 'composer-2.5-fast'
  if (provider === 'ollama') return 'qwen3:4b-instruct'
  return 'flash-lite'
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
