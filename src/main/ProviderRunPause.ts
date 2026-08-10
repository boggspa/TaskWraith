import type {
  ActiveGoal,
  AppSettings,
  ProviderId,
  ProviderReroutePlan,
  ProviderRunPauseState,
  ProviderRunReroute
} from './store/types'
import { approvalModeRank, coerceApprovalMode } from './RunPermissionPosture'
import { resolveActiveGoalForProvider } from './GoalState'
import {
  isCursorGrok45ModelId,
  isGrok45ReasoningModelId
} from '../shared/grok45Models'

const PROVIDER_IDS: readonly ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
]
const PROVIDER_SET = new Set<ProviderId>(PROVIDER_IDS)

export class ProviderPausedError extends Error {
  readonly code = 'PROVIDER_PAUSED'
  readonly provider: ProviderId
  readonly pause: ProviderRunPauseState

  constructor(provider: ProviderId, pause: ProviderRunPauseState) {
    super(formatProviderPausedMessage(provider, pause))
    this.name = 'ProviderPausedError'
    this.provider = provider
    this.pause = pause
  }
}

export interface ProviderDispatchResolution {
  provider: ProviderId
  reroute?: ProviderRunReroute
  reroutePlan?: ProviderReroutePlan
  pause?: ProviderRunPauseState
}

export function sanitizeProviderRunPauses(
  value: unknown
): AppSettings['providerRunPauses'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const output: Partial<Record<ProviderId, ProviderRunPauseState>> = {}
  for (const provider of PROVIDER_IDS) {
    const state = sanitizeProviderPauseState(input[provider])
    if (state) output[provider] = state
  }
  return output
}

export function getProviderPauseState(
  settings: Pick<AppSettings, 'providerRunPauses'> | null | undefined,
  provider: ProviderId,
  now = Date.now()
): ProviderRunPauseState | null {
  const state = settings?.providerRunPauses?.[provider]
  if (!state) return null
  if (!isProviderPauseActive(state, now)) return null
  return state
}

export function isProviderPaused(
  settings: Pick<AppSettings, 'providerRunPauses'> | null | undefined,
  provider: ProviderId,
  now = Date.now()
): boolean {
  return Boolean(getProviderPauseState(settings, provider, now))
}

export function resolveProviderDispatch(
  settings: Pick<AppSettings, 'providerRunPauses'> | null | undefined,
  provider: ProviderId,
  now = Date.now()
): ProviderDispatchResolution {
  const pause = getProviderPauseState(settings, provider, now)
  if (!pause) return { provider }
  const plan = sanitizeReroutePlan(pause.reroute)
  if (plan && plan.provider !== provider && !getProviderPauseState(settings, plan.provider, now)) {
    return {
      provider: plan.provider,
      reroutePlan: plan,
      pause,
      reroute: {
        from: provider,
        to: plan.provider,
        reason: 'provider-paused',
        savedAsDefault: true
      }
    }
  }
  throw new ProviderPausedError(provider, pause)
}

export function applyReroutePlanToPayload<T extends { provider: ProviderId }>(
  payload: T,
  resolution: ProviderDispatchResolution
): T & { providerReroute?: ProviderRunReroute } {
  if (!resolution.reroute || !resolution.reroutePlan) return payload
  const plan = resolution.reroutePlan
  const providerChanged = payload.provider !== resolution.provider
  const rerouteApprovalMode = cappedRerouteApprovalMode(
    (payload as { approvalMode?: string }).approvalMode,
    plan.approvalMode
  )
  return {
    ...payload,
    provider: resolution.provider,
    providerReroute: resolution.reroute,
    activeGoal: resolveReroutedActiveGoal(
      (payload as { activeGoal?: ActiveGoal | null }).activeGoal,
      resolution.provider
    ),
    ...(plan.customModel
      ? { model: plan.customModel }
      : plan.selectedModelType
        ? { model: plan.selectedModelType }
        : {}),
    ...(rerouteApprovalMode ? { approvalMode: rerouteApprovalMode } : {}),
    runtimeProfileId:
      plan.runtimeProfileId ||
      (providerChanged ? undefined : (payload as { runtimeProfileId?: string }).runtimeProfileId),
    ...(providerChanged
      ? {
          providerSessionId: null,
          effectivePermissions: undefined,
          effectivePermissionsSignature: undefined
        }
      : {}),
    ...(resolution.provider === 'gemini'
      ? { geminiAuthProfileId: plan.geminiAuthProfileId ?? null }
      : {}),
    ...(resolution.provider === 'codex'
      ? {
          reasoningEffort: plan.codexReasoningEffort ?? null,
          serviceTier: plan.codexServiceTier ?? null
        }
      : {}),
    ...(resolution.provider === 'grok'
      ? {
          reasoningEffort: isGrok45ReasoningModelId(plan.selectedModelType)
            ? plan.grokReasoningEffort ?? null
            : null
        }
      : {}),
    ...(resolution.provider === 'muse'
      ? {
          museReasoningEffort: plan.museReasoningEffort ?? null
        }
      : {}),
    ...(resolution.provider === 'cursor'
      ? {
          reasoningEffort: isCursorGrok45ModelId(plan.selectedModelType)
            ? plan.cursorReasoningEffort ?? null
            : null,
          serviceTier:
            isCursorGrok45ModelId(plan.selectedModelType) && plan.cursorFastMode ? 'fast' : null
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
          reasoningEffort: plan.kimiReasoningEffort ?? null,
          serviceTier: plan.kimiFastMode ? 'fast' : 'standard',
          kimiThinking: true
        }
      : {})
  }
}

function resolveReroutedActiveGoal(
  goal: ActiveGoal | null | undefined,
  provider: ProviderId
): ActiveGoal | null | undefined {
  if (goal === undefined) return undefined
  if (goal === null) return null
  return resolveActiveGoalForProvider(goal, provider, {
    codexNativeAvailable: provider === 'codex' && goal.mode === 'codex_native',
    claudeNativeAvailable: provider === 'claude' && goal.mode === 'claude_native',
    grokNativeAvailable: provider === 'grok'
  })
}

function cappedRerouteApprovalMode(
  currentMode: string | undefined,
  plannedMode: string | undefined
): string | undefined {
  const planned = normalizeRerouteApprovalMode(plannedMode)
  if (!planned) return undefined
  const current = coerceApprovalMode(currentMode) || 'default'
  return approvalModeRank(planned) <= approvalModeRank(current) ? planned : undefined
}

function normalizeRerouteApprovalMode(value: string | undefined): string | undefined {
  if (value === 'full_access') return 'auto_edit'
  return coerceApprovalMode(value)
}

export function formatProviderPausedMessage(
  provider: ProviderId,
  pause: ProviderRunPauseState
): string {
  const label = providerLabel(provider)
  const until =
    pause.until && Date.parse(pause.until) > Date.now()
      ? ` until ${new Date(pause.until).toLocaleString()}`
      : ''
  const reason = pause.reason?.trim() ? ` Reason: ${pause.reason.trim()}` : ''
  return `${label} is paused for new runs${until}.${reason}`
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  return 'Gemini'
}

function isProviderPauseActive(state: ProviderRunPauseState, now: number): boolean {
  if (!state.paused) return false
  if (!state.until) return true
  const untilMs = Date.parse(state.until)
  return Number.isFinite(untilMs) && untilMs > now
}

function sanitizeProviderPauseState(value: unknown): ProviderRunPauseState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const paused = input.paused === true
  const until = sanitizeIsoTimestamp(input.until)
  const reason = sanitizeShortString(input.reason, 280)
  const reroute = sanitizeReroutePlan(input.reroute)
  if (!paused && !until && !reason && !reroute) return null
  return {
    paused,
    ...(until ? { until } : {}),
    ...(reason ? { reason } : {}),
    ...(reroute ? { reroute } : {}),
    ...(typeof input.updatedAt === 'string' && input.updatedAt.trim()
      ? { updatedAt: input.updatedAt.trim() }
      : {})
  }
}

function sanitizeReroutePlan(value: unknown): ProviderReroutePlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const provider = typeof input.provider === 'string' ? input.provider : ''
  if (!PROVIDER_SET.has(provider as ProviderId)) return null
  return {
    provider: provider as ProviderId,
    ...(sanitizeShortString(input.selectedModelType, 120)
      ? { selectedModelType: sanitizeShortString(input.selectedModelType, 120) }
      : {}),
    ...(sanitizeShortString(input.customModel, 200)
      ? { customModel: sanitizeShortString(input.customModel, 200) }
      : {}),
    ...(sanitizeShortString(input.approvalMode, 80)
      ? { approvalMode: sanitizeShortString(input.approvalMode, 80) }
      : {}),
    ...(sanitizeShortString(input.runtimeProfileId, 200)
      ? { runtimeProfileId: sanitizeShortString(input.runtimeProfileId, 200) }
      : {}),
    ...(input.geminiAuthProfileId === null
      ? { geminiAuthProfileId: null }
      : sanitizeShortString(input.geminiAuthProfileId, 200)
        ? { geminiAuthProfileId: sanitizeShortString(input.geminiAuthProfileId, 200) }
        : {}),
    ...(input.codexReasoningEffort === null
      ? { codexReasoningEffort: null }
      : sanitizeShortString(input.codexReasoningEffort, 80)
        ? { codexReasoningEffort: sanitizeShortString(input.codexReasoningEffort, 80) }
        : {}),
    ...(input.codexServiceTier === null
      ? { codexServiceTier: null }
      : sanitizeShortString(input.codexServiceTier, 80)
        ? { codexServiceTier: sanitizeShortString(input.codexServiceTier, 80) }
        : {}),
    ...(input.claudeReasoningEffort === null
      ? { claudeReasoningEffort: null }
      : sanitizeShortString(input.claudeReasoningEffort, 80)
        ? { claudeReasoningEffort: sanitizeShortString(input.claudeReasoningEffort, 80) }
        : {}),
    ...(input.claudeFastMode === null
      ? { claudeFastMode: null }
      : typeof input.claudeFastMode === 'boolean'
        ? { claudeFastMode: input.claudeFastMode }
        : {}),
    ...(typeof input.kimiFastMode === 'boolean' ? { kimiFastMode: input.kimiFastMode } : {}),
    ...(input.kimiReasoningEffort === null
      ? { kimiReasoningEffort: null }
      : sanitizeShortString(input.kimiReasoningEffort, 80)
        ? { kimiReasoningEffort: sanitizeShortString(input.kimiReasoningEffort, 80) }
        : {}),
    ...(input.grokReasoningEffort === null
      ? { grokReasoningEffort: null }
      : sanitizeShortString(input.grokReasoningEffort, 80)
        ? { grokReasoningEffort: sanitizeShortString(input.grokReasoningEffort, 80) }
        : {}),
    ...(input.museReasoningEffort === null
      ? { museReasoningEffort: null }
      : sanitizeShortString(input.museReasoningEffort, 80)
        ? { museReasoningEffort: sanitizeShortString(input.museReasoningEffort, 80) }
        : {}),
    ...(input.cursorReasoningEffort === null
      ? { cursorReasoningEffort: null }
      : sanitizeShortString(input.cursorReasoningEffort, 80)
        ? { cursorReasoningEffort: sanitizeShortString(input.cursorReasoningEffort, 80) }
        : {}),
    ...(input.cursorFastMode === null
      ? { cursorFastMode: null }
      : typeof input.cursorFastMode === 'boolean'
        ? { cursorFastMode: input.cursorFastMode }
        : {}),
    ...(input.provider === 'kimi' ? { kimiThinkingEnabled: true } : {})
  }
}

function sanitizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined
}

function sanitizeShortString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}
