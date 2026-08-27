// Namespace import (not `{ resolve }`): this module sat in the renderer
// bundle's import graph on 2026-08-26 and a named `node:path` import fails
// the client rollup at bind time. A namespace binding resolves the member
// only at call time, which only ever happens in the main process.
import * as nodePath from 'node:path'
import type { WebContentsConsoleMessageEventParams } from 'electron'
import type { AppearanceMode } from '../store/types'
import { normalizeSystemThemeAppearance } from '../../shared/systemThemeAppearance'
import {
  MIN_INSPECTOR_PANEL_WIDTH,
  MAX_INSPECTOR_PANEL_WIDTH
} from '../../shared/panelWidthLimits'
import { normalizeDiffStatColors } from '../../shared/diffStatColors'
import { normalizeThemeAccentColor } from '../../shared/themeAccentColor'
import { normalizeAgentThemeTokenOverrides } from '../../shared/agentThemeTokens'
import { ACTIVITY_ARCHETYPES, sanitizeBannerTemplate } from '../../shared/bannerTemplate'
import type { ActivityArchetype } from '../../shared/bannerTemplate'
import type {
  AgenticServiceId,
  AgenticWorkspaceGrant,
  AgenticWorkspaceGrantProviderId,
  AppSettings,
  AuditOrchestrationSettings,
  AuditRole,
  AuditRunIdentity,
  ChatRecord,
  EnsembleRunIdentity,
  ExternalPathGrant,
  HandoffCard,
  HandoffCardFilter,
  ProviderId,
  ProductUpdateChangelog,
  RuntimeProfile,
  ScheduledTask,
  ScheduledTaskAttachmentRef,
  UserMcpServerConfig,
  WorkspaceBoardCard,
  WorkspaceBoardCardLinkKind,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition,
  WorkspaceBoardProvenance,
  WorkspaceBoardProvenanceSourceKind,
  WorkflowDefinition,
  WorkflowDefinitionCreateInput,
  WorkflowDefinitionRendererUpdate,
  WorkflowRunTemplate,
  WorkflowTrigger,
  WorkspaceRecord
} from '../store/types'
import type {
  TaskWraithPluginResourceProvenance,
  TaskWraithPluginReviewState
} from '../../shared/plugins/PluginTypes'
import { WORKSPACE_BOARD_CARD_LINK_KINDS } from '../store/types'
import { pickWorkflowRunTemplateFields } from '../store/WorkflowRunTemplate'
import { sanitizeRendererScheduledTaskLifecyclePatch } from '../ScheduledTaskRendererAuthority'
import type { RendererScheduledTaskLifecyclePatch } from '../ScheduledTaskRendererAuthority'
import { sanitizeProviderRunPauses } from '../ProviderRunPause'
import { normalizePromptCacheSettings } from '../PromptCachePolicy'
import { normalizeProviderHarnessPostureMap } from '../../shared/providerHarnessPosture'
import { normalizePiCerebrasMaxCompletionTokens } from '../../shared/piCerebrasCompletionCap'
import { normalizeCliPathDirectories } from '../../shared/cliPathDirectories'
import { normalizeApiUsageBillingSettings } from '../../shared/apiUsageBilling'
import {
  APPROVAL_TIMEOUT_DEFAULTS_VERSION,
  APPROVAL_TIMEOUT_MAX_MS,
  APPROVAL_TIMEOUT_MIN_MS
} from '../../shared/interactionTimeouts'
import {
  coerceLiveProvider,
  isLiveSelectableProvider,
  LIVE_SELECTABLE_PROVIDER_IDS,
  ANTIGRAVITY_PROVIDER_ID,
  isAntigravityOptInEnabled,
  type AntigravityOptInSettingsLike
} from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import { isAppIconVariant } from '../../shared/iconVariants'
import { canPersistPlaintextFieldValue } from '../PlaintextSecretPolicy'
import {
  copyResolvedScheduledAttachments,
  MAX_DURABLE_ATTACHMENT_REFS,
  SCHEDULED_ATTACHMENT_RESELECT_REASON,
  type StageScheduledAttachments
} from '../ScheduledAttachmentDurability'

// Known provider ids include historical/temporarily unavailable providers so
// persisted records remain decodable. New-run eligibility is narrower; see
// `selectableProviderIds` and `assertLiveProviderId` below.
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  // Known/decode id. Offer/run eligibility is gated separately (opt-in); being
  // here only lets persisted records with provider 'antigravity' decode.
  'antigravity',
  'pi',
  'mistral',
  'muse'
])
const AGENTIC_WORKSPACE_GRANT_PROVIDER_IDS = new Set<AgenticWorkspaceGrantProviderId>([
  ...PROVIDER_IDS,
  'agents'
])
const DEFAULT_AGENTIC_SERVICES_FOR_PROFILE: AppSettings['agenticServices'] = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  externalPublish: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  sketchCanvas: 'allow',
  meshCanvas: 'ask',
  simulatorCanvas: 'ask',
  crossThreadRead: 'ask',
  threadMessage: 'ask',
  mediaEditing: 'ask',
  mediaRecording: 'deny',
  canvasEval: 'ask',
  webBrowsing: 'ask',
  networkAccess: 'allow'
}
/** Services the workspace-grant picker may pre-authorise. Non-grantable
 * services (canvasEval / mediaRecording) are deliberately
 * absent so a forged settings patch cannot promote them. */
const GRANTABLE_AGENTIC_SERVICE_IDS = new Set<AgenticServiceId>([
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'sketchCanvas',
  'meshCanvas',
  'simulatorCanvas',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'webBrowsing'
])
const SETTINGS_PATCH_KEYS = new Set<keyof AppSettings>([
  'activeProvider',
  'midRunInputBehavior',
  'providerRunPauses',
  'windowBounds',
  'claudeBinaryPath',
  'kimiBinaryPath',
  'cliPathDirectories',
  'simulatorControlEnabled',
  'ollamaBaseUrl',
  'ollamaDefaultModel',
  'piCerebrasMaxCompletionTokens',
  'apiUsageBilling',
  'antigravityEnabled',
  'antigravityOptInAcceptedAt',
  'antigravityGeminiApiDisclosureAcceptedAt',
  'antigravityGeminiApiMonthlySpendCapUsd',
  'museMonthlySpendCapUsd',
  'codexUsageCredential',
  'storeLocalChatHistory',
  'storeRawEvents',
  'storePromptResponseInUsage',
  'customInstructionsEnabled',
  'auditRetention',
  'ensembleModeEnabled',
  'geminiCheckpointingEnabled',
  'chatContextTurns',
  'appearanceMode',
  'visualEffectStyle',
  'themeAppearance',
  'themeCornerStyle',
  'themeAccentStyle',
  'themeAccentColor',
  'toolIconAccent',
  'userBubbleColor',
  // Was MISSING while `useAppearance` sent it in every appearance patch and
  // `rendererAppearanceSettings` read it back — so chosen diff colours applied
  // live and were silently dropped on persist, never surviving a restart. Same
  // class as the toolIconAccent/userBubbleColor omission above it.
  'diffStatColors',
  'agentThemeTokens',
  'promptSurfaceStyle',
  'fanoutLaneLayout',
  'composerStyle',
  'transcriptFontFamily',
  'composerFontFamily',
  'reduceTransparency',
  'reduceMotion',
  'compactDensity',
  'liveActivityViewport',
  'showInspector',
  'inspectorWidth',
  'sidebarWidth',
  'sidebarOpacity',
  'mainPaneOpacity',
  'sidebarOpacityOverride',
  'mainPaneOpacityOverride',
  'funFxEnabled',
  'funFxMode',
  'advancedFx',
  'currency',
  'currencyOverestimatePercent',
  'showRunCompleteSummary',
  'closeoutAiSummaryEnabled',
  'hostAutoCompactEnabled',
  'ensembleCollapseOlderRounds',
  'maxWaveAgents',
  'modelUsagePanelView',
  'modelUsageExternalUsage',
  'dashboardStatPrefs',
  'welcomeHeatmapPrefs',
  'kimiSanitiserEnabled',
  'kimiSanitiserCustomKeywords',
  'kimiClassifierEnabled',
  'agenticServices',
  // PermissionService upserts/removes route through SettingsService, so this
  // key MUST be allowlisted or every workspace tool-grant write is silently
  // dropped. Renderer `update-settings` still rejects the key (IpcValidation);
  // only the dedicated grant IPCs + main-side PermissionService write it.
  'agenticWorkspaceGrants',
  // The main renderer records the one-per-workspace Accept Edits notice here.
  // Omitting this key makes the acknowledgement renderer-local: it appears to
  // work, then vanishes on the next settings reload/resumed chat.
  'approvalModeElevationAcknowledgements',
  'nativeSubAgentRequests',
  'promptCache',
  'geminiApiRuntime',
  'providerHarnessPosture',
  'trustWorkspaceHooks',
  'askBeforeHookCommands',
  'userMcpServers',
  'geminiMcpBridgeEnabled',
  'geminiMcpBridgeLastStatus',
  'bridgeDaemonEnabled',
  'studioCompanionEnabled',
  'localServersDetachSpawns',
  'localServersStopOnQuit',
  'codexSandboxFallback',
  'codexReuseExistingLogin',
  'autoUpdateEnabled',
  'activityReportingEnabled',
  'iosBannerTemplate',
  'iosActivityArchetype',
  'iosActivityEnabled',
  'updateChannel',
  'lastSeenChangelogVersion',
  'pendingUpdateChangelog',
  'approvalTimeouts',
  'auditOrchestration',
  'appIconVariant'
])

// Single-sourced from shared/panelWidthLimits: a sanitizer-local ceiling
// below the renderer's resize max (previously 720 here) silently snapped
// every wide dock drag back on the next settings round-trip, capping canvas
// surfaces in the dock however far the user dragged.
export const MIN_INSPECTOR_WIDTH = MIN_INSPECTOR_PANEL_WIDTH
export const MAX_INSPECTOR_WIDTH = MAX_INSPECTOR_PANEL_WIDTH
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 440
export const DEFAULT_WINDOW_WIDTH = 1400
export const DEFAULT_WINDOW_HEIGHT = 900
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 600

export interface MainSanitizerDeps {
  getSettings: () => AppSettings
  getScheduledTasks: () => ScheduledTask[]
  getWorkflowDefinitions: () => WorkflowDefinition[]
  getChat: (
    id: string
  ) => Pick<ChatRecord, 'appChatId' | 'archived' | 'scope' | 'workspaceId' | 'workspacePath'> | null
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  canonicalPath: (value: string) => string
  normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => ExternalPathGrant[]
  stageScheduledAttachments: StageScheduledAttachments
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

export function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
}

export function availableProviderIds(): ProviderId[] {
  return [
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
  ]
}

/**
 * The subset of KNOWN providers that may be OFFERED or RUN — excludes retired
 * or security-unqualified providers. Use this for pickers, MCP tool enums, run-command
 * parsing, and "supported provider" error lists. `availableProviderIds()` stays
 * the full known set so decode/validation of historical data keeps working.
 *
 * The `antigravity` provider is admitted when EITHER the caller supplies
 * settings that pass `isAntigravityOptInEnabled` (both enabled AND consent
 * recorded, for the AGY/CLI ban-risk lane) OR a Gemini API key is currently
 * configured in the dedicated secret store (the independent, non-ban-risk
 * BYO-key lane; see `AntigravityGeminiApiKeyConfiguredSignal`). Settings-less,
 * no-key callers fail closed — antigravity stays absent from every offer/run
 * surface until at least one lane is admitted.
 */
export function selectableProviderIds(settings?: AntigravityOptInSettingsLike): ProviderId[] {
  const ids: ProviderId[] = [...LIVE_SELECTABLE_PROVIDER_IDS]
  if (isAntigravityOptInEnabled(settings) || isAntigravityGeminiApiKeyConfigured()) {
    ids.push(ANTIGRAVITY_PROVIDER_ID)
  }
  return ids
}

/**
 * Like `assertProviderId`, but also rejects unavailable providers. Use at run
 * DISPATCH so a historical/unqualified provider can never start a new run, while
 * read/validate paths keep `assertProviderId` (which still accepts it).
 *
 * `antigravity` is admitted when `settings` passes `isAntigravityOptInEnabled`
 * OR a Gemini API key is currently configured; settings-less, no-key callers
 * reject it (fail closed).
 */
export function assertLiveProviderId(
  value: unknown,
  settings?: AntigravityOptInSettingsLike
): ProviderId {
  const provider = assertProviderId(value)
  if (isLiveSelectableProvider(provider)) return provider
  if (
    provider === ANTIGRAVITY_PROVIDER_ID &&
    (isAntigravityOptInEnabled(settings) || isAntigravityGeminiApiKeyConfigured())
  ) {
    return provider
  }
  throw new Error(
    `${provider} is unavailable for new runs. Choose ${selectableProviderIds(settings).join(', ')}.`
  )
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeUserMcpServers(value: unknown): UserMcpServerConfig[] {
  if (!Array.isArray(value)) return []
  const servers: UserMcpServerConfig[] = []
  const seenIds = new Set<string>()
  for (const item of value.slice(0, 64)) {
    const record = isRecord(item) ? item : null
    if (!record) continue
    const id = optionalString(record.id)?.trim()
    const name = optionalString(record.name)?.trim()
    if (!id || !name || seenIds.has(id)) continue
    seenIds.add(id)
    const transport =
      record.transport === 'http' || record.transport === 'sse' ? record.transport : 'stdio'
    const args = stringArray(record.args)
      .map((arg) => arg.trim())
      .filter(Boolean)
      .slice(0, 64)
    const env: Record<string, string> = {}
    if (isRecord(record.env)) {
      for (const [key, rawValue] of Object.entries(record.env).slice(0, 64)) {
        if (
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
          typeof rawValue === 'string' &&
          canPersistPlaintextFieldValue({ key, value: rawValue, kind: 'env' })
        ) {
          env[key] = rawValue
        }
      }
    }
    const headers: Record<string, string> = {}
    if (isRecord(record.headers)) {
      for (const [key, rawValue] of Object.entries(record.headers).slice(0, 64)) {
        if (
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) &&
          typeof rawValue === 'string' &&
          canPersistPlaintextFieldValue({ key, value: rawValue, kind: 'header' })
        ) {
          headers[key] = rawValue
        }
      }
    }
    const secretRefsInput = isRecord(record.secretRefs) ? record.secretRefs : {}
    const secretEnvRefs = Array.isArray(secretRefsInput.env)
      ? Array.from(
          new Set(
            secretRefsInput.env.filter(
              (key): key is string =>
                typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const secretHeaderRefs = Array.isArray(secretRefsInput.headers)
      ? Array.from(
          new Set(
            secretRefsInput.headers.filter(
              (key): key is string =>
                typeof key === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const command = optionalString(record.command)?.trim()
    const rawUrl = optionalString(record.url)?.trim()
    const url = rawUrl && isValidUserMcpRemoteUrl(rawUrl) ? rawUrl : undefined
    const bearerTokenEnvVar = optionalString(record.bearerTokenEnvVar)?.trim()
    const description = optionalString(record.description)?.trim()
    const createdAt = optionalString(record.createdAt)?.trim()
    const updatedAt = optionalString(record.updatedAt)?.trim()
    const pluginProvenance = sanitizePluginResourceProvenance(record.pluginProvenance)
    const pluginReview = sanitizePluginReviewState(record.pluginReview)
    const canEnable = transport === 'stdio' ? Boolean(command) : Boolean(url)
    const sanitized: UserMcpServerConfig = {
      id,
      name,
      enabled: Boolean(record.enabled && canEnable),
      transport
    }
    if (command) sanitized.command = command
    if (args.length > 0) sanitized.args = args
    if (url) sanitized.url = url
    if (Object.keys(env).length > 0) sanitized.env = env
    if (Object.keys(headers).length > 0) sanitized.headers = headers
    if (secretEnvRefs.length > 0 || secretHeaderRefs.length > 0) {
      sanitized.secretRefs = {
        ...(secretEnvRefs.length > 0 ? { env: secretEnvRefs } : {}),
        ...(secretHeaderRefs.length > 0 ? { headers: secretHeaderRefs } : {})
      }
    }
    if (bearerTokenEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar)) {
      sanitized.bearerTokenEnvVar = bearerTokenEnvVar
    }
    if (description) sanitized.description = description
    if (pluginProvenance) sanitized.pluginProvenance = pluginProvenance
    if (pluginReview) sanitized.pluginReview = pluginReview
    if (createdAt) sanitized.createdAt = createdAt
    if (updatedAt) sanitized.updatedAt = updatedAt
    servers.push(sanitized)
  }
  return servers
}

function sanitizePluginResourceProvenance(
  value: unknown
): TaskWraithPluginResourceProvenance | undefined {
  if (!isRecord(value)) return undefined
  const pluginId = optionalString(value.pluginId)?.trim()
  const publisher = optionalString(value.publisher)?.trim()
  const version = optionalString(value.version)?.trim()
  const namespace = optionalString(value.namespace)?.trim()
  const manifestHash = optionalString(value.manifestHash)?.trim()
  const objectId = optionalString(value.objectId)?.trim()
  const materializedAt = optionalString(value.materializedAt)?.trim()
  const source =
    value.source === 'builtin' || value.source === 'local' || value.source === 'marketplace'
      ? value.source
      : undefined
  const kind =
    value.kind === 'mcpServer' ||
    value.kind === 'toolBundle' ||
    value.kind === 'workflowTemplate' ||
    value.kind === 'runtimeProfile' ||
    value.kind === 'connector' ||
    value.kind === 'localService' ||
    value.kind === 'providerSetup' ||
    value.kind === 'remoteProjection'
      ? value.kind
      : undefined
  if (
    !pluginId ||
    !publisher ||
    !version ||
    !source ||
    !namespace ||
    !manifestHash ||
    !kind ||
    !objectId ||
    !materializedAt
  ) {
    return undefined
  }
  return {
    pluginId,
    publisher,
    version,
    source,
    namespace,
    manifestHash,
    kind,
    objectId,
    materializedAt
  }
}

function sanitizePluginReviewState(value: unknown): TaskWraithPluginReviewState | undefined {
  if (!isRecord(value)) return undefined
  const status =
    value.status === 'pending' || value.status === 'accepted' ? value.status : undefined
  const reason =
    value.reason === 'new-plugin-resource' ||
    value.reason === 'manifest-update' ||
    value.reason === 'user-enabled-reviewed-resource'
      ? value.reason
      : undefined
  const manifestHash = optionalString(value.manifestHash)?.trim()
  const reviewedAt = optionalString(value.reviewedAt)?.trim()
  if (!status || !reason || !manifestHash) return undefined
  return {
    status,
    reason,
    manifestHash,
    ...(reviewedAt ? { reviewedAt } : {})
  }
}

export function imageAttachmentSnapshots(
  value: unknown
): Array<{ id?: string; path: string; name?: string; kind?: 'directory' }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const path = typeof record.path === 'string' ? record.path.trim() : ''
      if (!path) return null
      return {
        ...(typeof record.id === 'string' && record.id.trim() ? { id: record.id.trim() } : {}),
        path,
        ...(typeof record.name === 'string' && record.name.trim()
          ? { name: record.name.trim() }
          : {}),
        ...(record.kind === 'directory' ? { kind: 'directory' as const } : {})
      }
    })
    .filter((item): item is { id?: string; path: string; name?: string; kind?: 'directory' } =>
      Boolean(item)
    )
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function clampDimension(value: unknown, min: number, max: number, fallback = 0): number {
  const next = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, Math.round(next)))
}

export function sanitizeWindowBounds(value: unknown): AppSettings['windowBounds'] | undefined {
  if (!isRecord(value)) return undefined
  const width = clampDimension(value.width, MIN_WINDOW_WIDTH, 10_000, DEFAULT_WINDOW_WIDTH)
  const height = clampDimension(value.height, MIN_WINDOW_HEIGHT, 10_000, DEFAULT_WINDOW_HEIGHT)
  const x = optionalNumber(value.x)
  const y = optionalNumber(value.y)
  return {
    ...(x !== undefined ? { x: Math.round(x) } : {}),
    ...(y !== undefined ? { y: Math.round(y) } : {}),
    width,
    height,
    ...(typeof value.isMaximized === 'boolean' ? { isMaximized: value.isMaximized } : {})
  }
}

export function sanitizeAgenticServicePolicy(
  value: unknown,
  fallback: 'ask' | 'workspace' | 'allow' | 'deny'
): 'ask' | 'workspace' | 'allow' | 'deny' {
  return value === 'ask' || value === 'workspace' || value === 'allow' || value === 'deny'
    ? value
    : fallback
}

/**
 * Sanitize the agentic workspace-grant list for settings patches.
 * Returns `undefined` when the value is not an array so the key is dropped
 * rather than wiping existing grants with garbage. An empty array is valid
 * (revoke-all). Non-grantable services are stripped.
 */
export function sanitizeAgenticWorkspaceGrants(
  value: unknown
): AgenticWorkspaceGrant[] | undefined {
  if (!Array.isArray(value)) return undefined
  const grants: AgenticWorkspaceGrant[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const workspacePath = typeof entry.workspacePath === 'string' ? entry.workspacePath.trim() : ''
    const provider =
      typeof entry.provider === 'string' &&
      AGENTIC_WORKSPACE_GRANT_PROVIDER_IDS.has(entry.provider as AgenticWorkspaceGrantProviderId)
        ? (entry.provider as AgenticWorkspaceGrantProviderId)
        : null
    const service =
      typeof entry.service === 'string' &&
      GRANTABLE_AGENTIC_SERVICE_IDS.has(entry.service as AgenticServiceId)
        ? (entry.service as AgenticServiceId)
        : null
    const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : ''
    const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
    if (!id || !workspacePath || !provider || !service || !createdAt || !updatedAt) continue
    const grant: AgenticWorkspaceGrant = {
      id,
      workspacePath,
      provider,
      service,
      createdAt,
      updatedAt
    }
    if (typeof entry.expiresAt === 'string' && entry.expiresAt.trim()) {
      grant.expiresAt = entry.expiresAt.trim()
    }
    if (entry.expiresOn === 'workspace_revocation') {
      grant.expiresOn = 'workspace_revocation'
    }
    grants.push(grant)
  }
  return consolidateAgenticWorkspaceGrants(grants)
}

// Workspace mutation grants are workspace-scoped ('agents'); canvasInteraction
// is the one grantable service that is surface-scoped instead, so a wildcard
// row for it could never be honored by the gate (PermissionService refuses
// canvasInteraction at the workspace tier). Its legacy rows pass through as-is.
const CONSOLIDATABLE_WORKSPACE_GRANT_SERVICE_IDS = new Set<AgenticServiceId>(
  [...GRANTABLE_AGENTIC_SERVICE_IDS].filter((service) => service !== 'canvasInteraction')
)

function workspaceGrantConsolidationKey(grant: AgenticWorkspaceGrant): string | null {
  if (!grant || typeof grant !== 'object') return null
  if (typeof grant.workspacePath !== 'string' || !grant.workspacePath.trim()) return null
  if (
    typeof grant.provider !== 'string' ||
    !AGENTIC_WORKSPACE_GRANT_PROVIDER_IDS.has(grant.provider as AgenticWorkspaceGrantProviderId)
  ) {
    return null
  }
  if (
    typeof grant.service !== 'string' ||
    !CONSOLIDATABLE_WORKSPACE_GRANT_SERVICE_IDS.has(grant.service as AgenticServiceId)
  ) {
    return null
  }
  return `${nodePath.resolve(grant.workspacePath)}\u0000${grant.service}`
}

/**
 * Collapse legacy per-provider workspace grants into the 'agents' wildcard so
 * "granted once for this workspace" holds for every provider immediately —
 * not only after the next accept re-mints the row. One consented provider is
 * the workspace-level consent; the merge keeps the earliest grant date and the
 * latest update, and keeps an expiry only when every merged row carried one
 * (the latest wins). Runs on settings load and on every grants patch;
 * idempotent and order-stable. Rows that are not workspace-consolidatable
 * (malformed shapes, unknown providers, canvasInteraction) pass through
 * untouched.
 */
export function consolidateAgenticWorkspaceGrants(
  grants: AgenticWorkspaceGrant[]
): AgenticWorkspaceGrant[] {
  const groups = new Map<string, AgenticWorkspaceGrant[]>()
  for (const grant of grants) {
    const key = workspaceGrantConsolidationKey(grant)
    if (!key) continue
    const group = groups.get(key)
    if (group) group.push(grant)
    else groups.set(key, [grant])
  }
  const emitted = new Set<string>()
  const result: AgenticWorkspaceGrant[] = []
  for (const grant of grants) {
    const key = workspaceGrantConsolidationKey(grant)
    if (!key) {
      result.push(grant)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    const group = groups.get(key) || [grant]
    const alreadyNormalized =
      group.length === 1 &&
      group[0].provider === 'agents' &&
      nodePath.resolve(group[0].workspacePath) === group[0].workspacePath
    if (alreadyNormalized) {
      result.push(group[0])
      continue
    }
    const base = group.find((member) => member.provider === 'agents') || group[0]
    let createdAt = base.createdAt
    let createdAtMs = Date.parse(base.createdAt)
    let updatedAt = base.updatedAt
    let updatedAtMs = Date.parse(base.updatedAt)
    let everyExpires = true
    let maxExpiresAt = ''
    let maxExpiresAtMs = Number.NEGATIVE_INFINITY
    for (const member of group) {
      const created = Date.parse(member.createdAt)
      if (Number.isFinite(created) && (!Number.isFinite(createdAtMs) || created < createdAtMs)) {
        createdAtMs = created
        createdAt = member.createdAt
      }
      const updated = Date.parse(member.updatedAt)
      if (Number.isFinite(updated) && (!Number.isFinite(updatedAtMs) || updated > updatedAtMs)) {
        updatedAtMs = updated
        updatedAt = member.updatedAt
      }
      const expires = Date.parse(member.expiresAt || '')
      if (!Number.isFinite(expires)) {
        everyExpires = false
      } else if (expires > maxExpiresAtMs) {
        maxExpiresAtMs = expires
        maxExpiresAt = member.expiresAt as string
      }
    }
    const merged: AgenticWorkspaceGrant = {
      id: base.id,
      workspacePath: nodePath.resolve(base.workspacePath),
      provider: 'agents',
      service: base.service,
      createdAt,
      updatedAt,
      expiresOn: 'workspace_revocation'
    }
    if (everyExpires && maxExpiresAt) merged.expiresAt = maxExpiresAt
    result.push(merged)
  }
  return result
}

export function sanitizeAgenticNetworkPolicy(
  value: unknown,
  fallback: 'allow' | 'deny'
): 'allow' | 'deny' {
  return value === 'allow' || value === 'deny' ? value : fallback
}

const AUDIT_ROLES: readonly AuditRole[] = ['recon', 'reviewer', 'skeptic', 'synthesis']
// Audit policy accepts any structural provider. This preserves historical
// preferences only; it is not a signal that the provider is runnable.
const AUDIT_PROVIDER_IDS = new Set<ProviderId>([
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

/** Sanitize the audit orchestration policy: drop unknown providers, clamp the
 * Ollama concurrency cap + budgets, and keep only known roles in the
 * per-role preference map. Returns undefined when the input clears to nothing
 * meaningful (so it round-trips as "use defaults"). */
export function sanitizeAuditOrchestration(value: unknown): AuditOrchestrationSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const filterProviders = (raw: unknown): ProviderId[] =>
    Array.isArray(raw)
      ? Array.from(
          new Set(raw.filter((p): p is ProviderId => AUDIT_PROVIDER_IDS.has(p as ProviderId)))
        )
      : []
  const out: AuditOrchestrationSettings = {}

  if (Array.isArray(input.providerAllowlist)) {
    out.providerAllowlist = filterProviders(input.providerAllowlist)
  }
  if (typeof input.ollamaEnabled === 'boolean') out.ollamaEnabled = input.ollamaEnabled
  if (input.ollamaMaxConcurrent !== undefined) {
    const n = Math.round(Number(input.ollamaMaxConcurrent))
    if (Number.isFinite(n)) out.ollamaMaxConcurrent = Math.max(1, Math.min(4, n))
  }
  if (input.perRolePreferences && typeof input.perRolePreferences === 'object') {
    const prefsIn = input.perRolePreferences as Record<string, unknown>
    const prefs: Partial<Record<AuditRole, ProviderId[]>> = {}
    for (const role of AUDIT_ROLES) {
      const chain = filterProviders(prefsIn[role])
      if (chain.length > 0) prefs[role] = chain
    }
    if (Object.keys(prefs).length > 0) out.perRolePreferences = prefs
  }
  if (input.budgetMaxAgents !== undefined) {
    const n = Math.round(Number(input.budgetMaxAgents))
    if (Number.isFinite(n)) out.budgetMaxAgents = Math.max(1, Math.min(200, n))
  }
  if (input.budgetMaxTokens !== undefined) {
    const n = Math.round(Number(input.budgetMaxTokens))
    if (Number.isFinite(n) && n > 0) out.budgetMaxTokens = n
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeApprovalTimeoutMs(value: unknown, fallback: number): number {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(APPROVAL_TIMEOUT_MIN_MS, Math.min(APPROVAL_TIMEOUT_MAX_MS, parsed))
}

function sanitizeUpdateChangelog(value: unknown): ProductUpdateChangelog | undefined {
  const record = isRecord(value) ? value : {}
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  if (!version) return undefined

  const changelog: ProductUpdateChangelog = { version }
  if (typeof record.releaseName === 'string' && record.releaseName.trim()) {
    changelog.releaseName = record.releaseName.trim()
  }
  if (typeof record.releaseDate === 'string' && record.releaseDate.trim()) {
    changelog.releaseDate = record.releaseDate.trim()
  }
  if (typeof record.releaseNotes === 'string') {
    changelog.releaseNotes = record.releaseNotes
  } else if (Array.isArray(record.releaseNotes)) {
    const notes = record.releaseNotes
      .map((item) => {
        const noteRecord = isRecord(item) ? item : {}
        const noteVersion = typeof noteRecord.version === 'string' ? noteRecord.version.trim() : ''
        if (!noteVersion) return null
        return {
          version: noteVersion,
          note: typeof noteRecord.note === 'string' ? noteRecord.note : null
        }
      })
      .filter((item): item is { version: string; note: string | null } => item !== null)
    if (notes.length > 0) {
      changelog.releaseNotes = notes
    }
  }
  return changelog
}

export function normalizeEnsembleRunIdentity(value: unknown): EnsembleRunIdentity | undefined {
  if (!isRecord(value)) return undefined
  const stageRole =
    value.stageRole === 'scout' ||
    value.stageRole === 'worker' ||
    value.stageRole === 'reviewer' ||
    value.stageRole === 'background'
      ? value.stageRole
      : undefined
  return {
    roundId: requireNonEmptyString(value.roundId, 'Ensemble round id'),
    participantId: requireNonEmptyString(value.participantId, 'Ensemble participant id'),
    ...(value.promptMode === 'full' || value.promptMode === 'slim'
      ? { promptMode: value.promptMode }
      : {}),
    ...(optionalString(value.laneId) ? { laneId: optionalString(value.laneId) } : {}),
    provider: assertProviderId(value.provider),
    role: optionalString(value.role) || 'Participant',
    ...(stageRole ? { stageRole } : {}),
    order: optionalNumber(value.order) ?? 0,
    ...(optionalNumber(value.ensembleContextChars) !== undefined
      ? { ensembleContextChars: optionalNumber(value.ensembleContextChars) }
      : {}),
    ...(optionalNumber(value.ensembleContextTurns) !== undefined
      ? { ensembleContextTurns: optionalNumber(value.ensembleContextTurns) }
      : {})
  }
}

export function normalizeAuditRunIdentity(value: unknown): AuditRunIdentity | undefined {
  if (!isRecord(value)) return undefined
  // Optional payload field — a malformed identity is dropped (the run is just
  // treated as a non-audit run), never thrown.
  const auditRunId = optionalString(value.auditRunId)
  const role = optionalString(value.role)
  if (!auditRunId) return undefined
  if (role !== 'recon' && role !== 'reviewer' && role !== 'skeptic' && role !== 'synthesis') {
    return undefined
  }
  return {
    auditRunId,
    role,
    ...(optionalString(value.dimension) ? { dimension: optionalString(value.dimension) } : {}),
    ...(optionalString(value.findingId) ? { findingId: optionalString(value.findingId) } : {})
  }
}

export function createMainSanitizers(deps: MainSanitizerDeps) {
  function normalizeScheduledTaskExternalGrants(value: unknown): ExternalPathGrant[] | undefined {
    const rawGrants = Array.isArray(value) ? (value as ExternalPathGrant[]) : []
    const grants = deps.normalizeExternalPathGrants(rawGrants)
    if (rawGrants.length && grants.length !== rawGrants.length) {
      throw new Error(
        'Scheduled task external path grants must be issued by TaskWraith in this app session.'
      )
    }
    return grants.length ? grants : undefined
  }

  function assertScheduledTaskWorkspaceIdentity(
    workspacePath: string,
    workspaceId?: unknown
  ): WorkspaceRecord {
    const registeredPath = deps.requireRegisteredWorkspace(
      workspacePath,
      'Scheduled task workspace'
    )
    const workspace = deps.findRegisteredWorkspace(registeredPath)
    if (!workspace) {
      throw new Error('Scheduled task workspace must be registered.')
    }
    if (typeof workspaceId === 'string' && workspaceId && workspaceId !== workspace.id) {
      throw new Error('Scheduled task workspace id does not match the registered workspace.')
    }
    return workspace
  }

  function assertScheduledTaskChatIdentity(
    appChatId: string,
    workspace: WorkspaceRecord,
    workspacePath: string
  ): void {
    const chat = deps.getChat(appChatId)
    if (
      !chat ||
      chat.archived ||
      chat.scope !== 'workspace' ||
      chat.workspaceId !== workspace.id ||
      !chat.workspacePath ||
      deps.canonicalPath(chat.workspacePath) !== workspacePath
    ) {
      throw new Error('Scheduled task chat must be a live chat in the selected workspace.')
    }
  }

  function normalizeScheduledAttachmentCandidates(
    value: unknown,
    label: string
  ): ScheduledTaskAttachmentRef[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
    if (value.length > MAX_DURABLE_ATTACHMENT_REFS) {
      throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
    }
    return value.map((attachment, index) => {
      const input = requireRecord(attachment, `${label} ${index + 1}`)
      const id = requireNonEmptyString(input.id, `${label} ${index + 1} id`)
      const name = requireNonEmptyString(input.name, `${label} ${index + 1} name`)
      const path = requireNonEmptyString(input.path, `${label} ${index + 1} path`)
      if (input.persistenceVersion === undefined) return { id, name, path }
      if (input.persistenceVersion !== 1) {
        throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
      }
      const byteLength = Number(input.byteLength)
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
        throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
      }
      return {
        persistenceVersion: 1 as const,
        id,
        path,
        name,
        sha256: requireNonEmptyString(input.sha256, `${label} ${index + 1} hash`),
        mimeType: requireNonEmptyString(input.mimeType, `${label} ${index + 1} MIME type`),
        byteLength
      }
    })
  }

  function stageScheduledAttachments(
    value: unknown,
    context: {
      appChatId: string
      workspaceId: string
      workspacePath: string
      externalPathGrants?: ExternalPathGrant[]
    },
    label: string,
    existingPersistedValue?: unknown
  ): ScheduledTaskAttachmentRef[] {
    const attachments = normalizeScheduledAttachmentCandidates(value, label)
    if (attachments.length === 0) return []
    const existingLegacyAttachments = Array.isArray(existingPersistedValue)
      ? existingPersistedValue.filter((attachment) => {
          if (!isRecord(attachment) || attachment.persistenceVersion === 1) return false
          return typeof attachment.path === 'string' && Boolean(attachment.path.trim())
        })
      : []
    const resubmitsLegacyPath = attachments.some((attachment) => {
      if ('persistenceVersion' in attachment && attachment.persistenceVersion === 1) return false
      return existingLegacyAttachments.some((existing) => {
        if (!isRecord(existing) || existing.path !== attachment.path) return false
        const existingId = typeof existing.id === 'string' ? existing.id.trim() : ''
        return Boolean(existingId) && existingId === attachment.id
      })
    })
    if (resubmitsLegacyPath) throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
    try {
      const staged = deps.stageScheduledAttachments({
        appChatId: context.appChatId,
        workspaceId: context.workspaceId,
        workspacePath: context.workspacePath,
        externalPathGrants: context.externalPathGrants || [],
        attachments
      })
      if (!staged.ok) throw new Error(staged.reason)
      const resolved = copyResolvedScheduledAttachments(attachments, staged.attachments)
      if (!resolved) throw new Error('Attachment persistence returned an incomplete result.')
      return resolved
    } catch {
      throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
    }
  }

  function sanitizeScheduledTaskForSave(
    task: unknown
  ): WorkflowRunTemplate & Pick<ScheduledTask, 'runAt' | 'timezone'> {
    const input = requireRecord(task, 'Scheduled task')
    const runAt = requireNonEmptyString(input.runAt, 'Scheduled task run time')
    const runAtMs = new Date(runAt).getTime()
    if (!Number.isFinite(runAtMs)) {
      throw new Error('Scheduled task run time is invalid.')
    }
    if (runAtMs <= Date.now()) {
      throw new Error('Scheduled task run time must be in the future.')
    }
    const template = sanitizeWorkflowTemplate(input)
    return {
      ...template,
      sessionTrust: false,
      runAt: new Date(runAtMs).toISOString(),
      timezone: requireNonEmptyString(input.timezone, 'Scheduled task timezone')
    }
  }

  function sanitizeScheduledTaskPatch(
    id: string,
    partial: unknown
  ): RendererScheduledTaskLifecyclePatch | null {
    const input = requireRecord(partial, 'Scheduled task update')
    const existing = deps.getScheduledTasks().find((task) => task.id === id)
    if (!existing) return null
    return sanitizeRendererScheduledTaskLifecyclePatch(existing, input)
  }

  function sanitizeWorkflowTrigger(value: unknown): WorkflowTrigger {
    const input = requireRecord(value, 'Workflow trigger')
    const kind =
      input.kind === 'once' || input.kind === 'interval' || input.kind === 'cron'
        ? input.kind
        : input.kind === 'manual'
          ? 'manual'
          : 'manual'
    if (kind === 'once') {
      return {
        kind,
        runAt: optionalString(input.runAt) || new Date().toISOString(),
        timezone: optionalString(input.timezone)
      }
    }
    if (kind === 'interval') {
      const intervalMs = Number(input.intervalMs)
      return {
        kind,
        intervalMs: Number.isFinite(intervalMs) ? Math.max(60_000, Math.trunc(intervalMs)) : 60_000,
        startAt: optionalString(input.startAt) || new Date().toISOString(),
        timezone: optionalString(input.timezone)
      }
    }
    if (kind === 'cron') {
      return {
        kind,
        cronExpression: optionalString(input.cronExpression) || '',
        timezone: optionalString(input.timezone)
      }
    }
    return { kind: 'manual' }
  }

  function sanitizeWorkflowTemplate(
    value: unknown,
    existingTemplate?: WorkflowRunTemplate
  ): WorkflowRunTemplate {
    const input = requireRecord(value, 'Workflow template')
    const workspace = assertScheduledTaskWorkspaceIdentity(
      requireNonEmptyString(input.workspacePath, 'Workflow workspace'),
      input.workspaceId
    )
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    if (!prompt.trim()) throw new Error('Workflow prompt is required.')
    const workspacePath = deps.canonicalPath(workspace.path)
    const appChatId = requireNonEmptyString(input.chatId, 'Workflow chat')
    // Validate the durable owner before staging any attachment bytes. A
    // compromised renderer must not be able to leave orphaned main-owned
    // assets behind by pairing a valid workspace with a missing/moved chat.
    assertScheduledTaskChatIdentity(appChatId, workspace, workspacePath)
    const externalPathGrants = normalizeScheduledTaskExternalGrants(input.externalPathGrants)
    const imageAttachments = stageScheduledAttachments(
      input.imageAttachments,
      { appChatId, workspaceId: workspace.id, workspacePath, externalPathGrants },
      'Workflow attachments',
      existingTemplate?.imageAttachments
    )
    const templateInput = pickWorkflowRunTemplateFields(input)
    return {
      ...templateInput,
      workspaceId: workspace.id,
      workspacePath,
      chatId: appChatId,
      provider: assertLiveProviderId(input.provider),
      prompt,
      displayPrompt: optionalString(input.displayPrompt),
      selectedModelType: optionalString(input.selectedModelType) || 'default',
      customModel: optionalString(input.customModel) || '',
      approvalMode: optionalString(input.approvalMode) || 'default',
      workflowMode: input.workflowMode === 'plan' ? 'plan' : 'normal',
      // Workflows and scheduled tasks are unattended. They may receive only a
      // separately verified unattended-elevation ack, never Full Access.
      sessionTrust: false,
      imageAttachments,
      externalPathGrants,
      geminiWorktree: input.geminiWorktree as any,
      codexReasoningEffort: optionalString(input.codexReasoningEffort),
      grokReasoningEffort: optionalString(input.grokReasoningEffort),
      museReasoningEffort: optionalString(input.museReasoningEffort),
      ollamaReasoningEffort: optionalString(input.ollamaReasoningEffort),
      cursorReasoningEffort: optionalString(input.cursorReasoningEffort),
      codexServiceTier: optionalString(input.codexServiceTier),
      claudeFastMode: typeof input.claudeFastMode === 'boolean' ? input.claudeFastMode : undefined,
      kimiFastMode: typeof input.kimiFastMode === 'boolean' ? input.kimiFastMode : undefined,
      kimiReasoningEffort: optionalString(input.kimiReasoningEffort),
      cursorFastMode: typeof input.cursorFastMode === 'boolean' ? input.cursorFastMode : undefined,
      kimiThinkingEnabled: input.provider === 'kimi' ? true : undefined,
      runtimeProfileId: optionalString(input.runtimeProfileId),
      geminiAuthProfileId: optionalStringOrNull(input.geminiAuthProfileId),
      handoffSourceRunId: optionalString(input.handoffSourceRunId),
      kind: input.kind === 'ensemble' ? 'ensemble' : 'single',
      ensembleSnapshot: input.ensembleSnapshot as any
    } as WorkflowRunTemplate
  }

  function sanitizeWorkflowForSave(workflow: unknown): WorkflowDefinitionCreateInput {
    const input = requireRecord(workflow, 'Workflow')
    if ('id' in input) {
      throw new Error('Workflow creation cannot replace an existing workflow.')
    }
    const template = sanitizeWorkflowTemplate(input.template)
    const limits = isRecord(input.limits) ? input.limits : {}
    return {
      name: requireNonEmptyString(input.name, 'Workflow name'),
      workspaceId: template.workspaceId,
      workspacePath: template.workspacePath,
      enabled: input.enabled !== false,
      trigger: sanitizeWorkflowTrigger(input.trigger),
      template,
      missedRunPolicy: input.missedRunPolicy === 'skip' ? 'skip' : 'coalesce',
      concurrencyPolicy: input.concurrencyPolicy === 'enqueue' ? 'enqueue' : 'skip',
      limits: {
        maxRunsPerDay: Number.isFinite(Number(limits.maxRunsPerDay))
          ? Math.max(1, Math.trunc(Number(limits.maxRunsPerDay)))
          : undefined,
        maxConsecutiveFailures: Number.isFinite(Number(limits.maxConsecutiveFailures))
          ? Math.max(1, Math.trunc(Number(limits.maxConsecutiveFailures)))
          : 3
      }
    }
  }

  function sanitizeWorkflowPatch(
    id: string,
    partial: unknown
  ): (WorkflowDefinitionRendererUpdate & { unattendedElevation?: undefined }) | null {
    const existing = deps.getWorkflowDefinitions().find((workflow) => workflow.id === id)
    if (!existing) return null
    const input = requireRecord(partial, 'Workflow update')
    const allowedFields = new Set(['enabled', 'trigger'])
    if (Object.keys(input).some((field) => !allowedFields.has(field))) {
      throw new Error('Workflow configuration and authority are main-owned after creation.')
    }
    const sanitized: WorkflowDefinitionRendererUpdate & {
      unattendedElevation?: undefined
    } = {}
    if ('enabled' in input) {
      if (typeof input.enabled !== 'boolean') throw new Error('Workflow enabled state is invalid.')
      sanitized.enabled = input.enabled
    }
    if ('trigger' in input) sanitized.trigger = sanitizeWorkflowTrigger(input.trigger)
    if ('enabled' in input || 'trigger' in input) {
      // Renderer-owned pause/cadence controls are fail-safe: changing either
      // explicitly revokes any standing unattended authority.
      sanitized.unattendedElevation = undefined
    }
    return sanitized
  }

  const workspaceBoardColumnIds = new Set<WorkspaceBoardColumnId>([
    'inbox',
    'ready',
    'running',
    'needs-input',
    'blocked',
    'review-ready',
    'done',
    'archived'
  ])
  const workspaceBoardCardLinkKinds = new Set<WorkspaceBoardCardLinkKind>(
    WORKSPACE_BOARD_CARD_LINK_KINDS
  )
  const workspaceBoardProvenanceSourceKinds = new Set<WorkspaceBoardProvenanceSourceKind>([
    'manual',
    'capture',
    'seed',
    'duplicate',
    'thread',
    'goal',
    'plan',
    'agent'
  ])

  function sanitizeWorkspaceBoardProvenance(value: unknown): WorkspaceBoardProvenance | undefined {
    if (!isRecord(value)) return undefined
    const trimmed = (input: unknown) => optionalString(input)?.trim() || undefined
    const sourceKind = workspaceBoardProvenanceSourceKinds.has(
      value.sourceKind as WorkspaceBoardProvenanceSourceKind
    )
      ? (value.sourceKind as WorkspaceBoardProvenanceSourceKind)
      : 'manual'
    return {
      actor: value.actor === 'agent' || value.actor === 'system' ? value.actor : 'user',
      sourceKind,
      at: optionalString(value.at) || new Date().toISOString(),
      trust:
        value.trust === 'agent-proposed' ||
        value.trust === 'system-derived' ||
        value.trust === 'user-confirmed'
          ? value.trust
          : undefined,
      sourceId: trimmed(value.sourceId),
      sourceTitle: trimmed(value.sourceTitle),
      provider: trimmed(value.provider),
      runId: trimmed(value.runId),
      note: trimmed(value.note)
    }
  }

  function assertWorkspaceBoardWorkspaceIdentity(
    workspacePath: string,
    workspaceId?: unknown
  ): WorkspaceRecord {
    const registeredPath = deps.requireRegisteredWorkspace(workspacePath, 'Workspace board')
    const workspace = deps.findRegisteredWorkspace(registeredPath)
    if (!workspace) {
      throw new Error('Workspace board workspace must be registered.')
    }
    if (typeof workspaceId === 'string' && workspaceId && workspaceId !== workspace.id) {
      throw new Error('Workspace board workspace id does not match the registered workspace.')
    }
    return workspace
  }

  function sanitizeWorkspaceBoardForSave(
    board: unknown
  ): Omit<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
    Partial<Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>> {
    const input = requireRecord(board, 'Workspace board')
    const workspace = assertWorkspaceBoardWorkspaceIdentity(
      requireNonEmptyString(input.workspacePath, 'Workspace board workspace'),
      input.workspaceId
    )
    return {
      id: optionalString(input.id),
      workspaceId: workspace.id,
      workspacePath: deps.canonicalPath(workspace.path),
      name: requireNonEmptyString(input.name, 'Workspace board name'),
      description: optionalString(input.description),
      provenance: sanitizeWorkspaceBoardProvenance(input.provenance),
      pinned: input.pinned === true,
      archived: input.archived === true,
      columns: Array.isArray(input.columns)
        ? input.columns
            .filter((column): column is Record<string, unknown> => isRecord(column))
            .filter((column) => workspaceBoardColumnIds.has(column.id as WorkspaceBoardColumnId))
            .map((column, index) => ({
              id: column.id as WorkspaceBoardColumnId,
              name: optionalString(column.name) || String(column.id),
              sortOrder: Number.isFinite(Number(column.sortOrder))
                ? Math.max(0, Math.trunc(Number(column.sortOrder)))
                : index,
              wipLimit: Number.isFinite(Number(column.wipLimit))
                ? Math.max(1, Math.trunc(Number(column.wipLimit)))
                : undefined
            }))
        : []
    }
  }

  function sanitizeWorkspaceBoardPatch(partial: unknown): Partial<WorkspaceBoardDefinition> {
    const input = requireRecord(partial, 'Workspace board update')
    const sanitized: Partial<WorkspaceBoardDefinition> = {}
    if ('name' in input) sanitized.name = requireNonEmptyString(input.name, 'Workspace board name')
    if ('description' in input) sanitized.description = optionalString(input.description)
    if ('provenance' in input)
      sanitized.provenance = sanitizeWorkspaceBoardProvenance(input.provenance)
    if ('pinned' in input) sanitized.pinned = input.pinned === true
    if ('archived' in input) sanitized.archived = input.archived === true
    if ('columns' in input && Array.isArray(input.columns)) {
      sanitized.columns = input.columns
        .filter((column): column is Record<string, unknown> => isRecord(column))
        .filter((column) => workspaceBoardColumnIds.has(column.id as WorkspaceBoardColumnId))
        .map((column, index) => ({
          id: column.id as WorkspaceBoardColumnId,
          name: optionalString(column.name) || String(column.id),
          sortOrder: Number.isFinite(Number(column.sortOrder))
            ? Math.max(0, Math.trunc(Number(column.sortOrder)))
            : index,
          wipLimit: Number.isFinite(Number(column.wipLimit))
            ? Math.max(1, Math.trunc(Number(column.wipLimit)))
            : undefined
        }))
    }
    return sanitized
  }

  function sanitizeWorkspaceBoardCardForSave(
    card: unknown
  ): Omit<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
    Partial<Pick<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>> {
    const input = requireRecord(card, 'Workspace board card')
    const columnId = workspaceBoardColumnIds.has(input.columnId as WorkspaceBoardColumnId)
      ? (input.columnId as WorkspaceBoardColumnId)
      : 'inbox'
    return {
      id: optionalString(input.id),
      boardId: requireNonEmptyString(input.boardId, 'Workspace board'),
      workspaceId: optionalString(input.workspaceId) || '',
      columnId,
      title: requireNonEmptyString(input.title, 'Workspace board card title'),
      body: optionalString(input.body),
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : Date.now(),
      humanOwner: optionalString(input.humanOwner),
      labels: Array.isArray(input.labels)
        ? input.labels
            .filter((label): label is string => typeof label === 'string')
            .map((label) => label.trim())
            .filter(Boolean)
            .slice(0, 12)
        : undefined,
      link: sanitizeWorkspaceBoardCardLink(input.link),
      blockedReason: optionalString(input.blockedReason),
      nextStep: optionalString(input.nextStep),
      reminderAt: optionalString(input.reminderAt),
      provenance: sanitizeWorkspaceBoardProvenance(input.provenance),
      archived: input.archived === true
    }
  }

  function sanitizeWorkspaceBoardCardPatch(partial: unknown): Partial<WorkspaceBoardCard> {
    const input = requireRecord(partial, 'Workspace board card update')
    const sanitized: Partial<WorkspaceBoardCard> = {}
    if ('title' in input)
      sanitized.title = requireNonEmptyString(input.title, 'Workspace board card title')
    if ('body' in input) sanitized.body = optionalString(input.body)
    if (
      'columnId' in input &&
      workspaceBoardColumnIds.has(input.columnId as WorkspaceBoardColumnId)
    ) {
      sanitized.columnId = input.columnId as WorkspaceBoardColumnId
    }
    if ('sortOrder' in input && Number.isFinite(Number(input.sortOrder))) {
      sanitized.sortOrder = Number(input.sortOrder)
    }
    if ('humanOwner' in input) sanitized.humanOwner = optionalString(input.humanOwner)
    if ('labels' in input && Array.isArray(input.labels)) {
      sanitized.labels = input.labels
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 12)
    }
    if ('link' in input) {
      sanitized.link = sanitizeWorkspaceBoardCardLink(input.link)
    }
    if ('blockedReason' in input) sanitized.blockedReason = optionalString(input.blockedReason)
    if ('nextStep' in input) sanitized.nextStep = optionalString(input.nextStep)
    if ('reminderAt' in input) sanitized.reminderAt = optionalString(input.reminderAt)
    if ('provenance' in input)
      sanitized.provenance = sanitizeWorkspaceBoardProvenance(input.provenance)
    if ('archived' in input) sanitized.archived = input.archived === true
    return sanitized
  }

  function sanitizeWorkspaceBoardCardLink(link: unknown): WorkspaceBoardCard['link'] {
    if (link == null) return undefined
    const input = requireRecord(link, 'Workspace board card link')
    const kind = input.kind as WorkspaceBoardCardLinkKind
    if (!workspaceBoardCardLinkKinds.has(kind)) {
      throw new Error('Workspace board card link kind is invalid.')
    }
    return {
      kind,
      id: requireNonEmptyString(input.id, 'Workspace board card link')
    }
  }

  function sanitizeRuntimeProfileForSave(
    profile: unknown
  ): Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'> {
    const input = requireRecord(profile, 'Runtime profile')
    const env: Record<string, string> = {}
    if (isRecord(input.env)) {
      for (const [key, value] of Object.entries(input.env)) {
        if (
          typeof key === 'string' &&
          key.trim() &&
          typeof value === 'string' &&
          canPersistPlaintextFieldValue({ key, value, kind: 'env' })
        ) {
          env[key] = value
        }
      }
    }
    const secretRefsInput = isRecord(input.secretRefs) ? input.secretRefs : {}
    const secretEnvRefs = Array.isArray(secretRefsInput.env)
      ? Array.from(
          new Set(
            secretRefsInput.env.filter(
              (key): key is string =>
                typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const workspaceMode =
      input.workspaceMode === 'worktree' || input.workspaceMode === 'container'
        ? input.workspaceMode
        : 'local'
    const networkPolicy =
      input.networkPolicy === 'allow' || input.networkPolicy === 'deny'
        ? input.networkPolicy
        : 'inherit'
    const persistence = input.persistence === 'ephemeral' ? 'ephemeral' : 'reusable'
    return {
      id: optionalString(input.id),
      name: requireNonEmptyString(input.name, 'Runtime profile name'),
      provider: assertProviderId(input.provider),
      scope: input.scope === 'global' ? 'global' : 'workspace',
      workspaceMode,
      binaryPath: optionalString(input.binaryPath),
      env,
      ...(secretEnvRefs.length > 0 ? { secretRefs: { env: secretEnvRefs } } : {}),
      mcpProfileId: optionalString(input.mcpProfileId),
      approvalMode: optionalString(input.approvalMode),
      agenticServices: isRecord(input.agenticServices)
        ? {
            shellCommands: sanitizeAgenticServicePolicy(
              input.agenticServices.shellCommands,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.shellCommands
            ),
            fileChanges: sanitizeAgenticServicePolicy(
              input.agenticServices.fileChanges,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.fileChanges
            ),
            externalPublish: sanitizeAgenticServicePolicy(
              input.agenticServices.externalPublish,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.externalPublish ?? 'ask'
            ),
            mcpTools: sanitizeAgenticServicePolicy(
              input.agenticServices.mcpTools,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.mcpTools
            ),
            subThreadDelegation: sanitizeAgenticServicePolicy(
              input.agenticServices.subThreadDelegation,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.subThreadDelegation
            ),
            canvasInteraction: sanitizeAgenticServicePolicy(
              input.agenticServices.canvasInteraction,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.canvasInteraction
            ),
            sketchCanvas: sanitizeAgenticServicePolicy(
              input.agenticServices.sketchCanvas,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.sketchCanvas ?? 'allow'
            ),
            meshCanvas: sanitizeAgenticServicePolicy(
              input.agenticServices.meshCanvas,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.meshCanvas ?? 'ask'
            ),
            simulatorCanvas: sanitizeAgenticServicePolicy(
              input.agenticServices.simulatorCanvas,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.simulatorCanvas ?? 'ask'
            ),
            crossThreadRead: sanitizeAgenticServicePolicy(
              input.agenticServices.crossThreadRead,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.crossThreadRead ?? 'ask'
            ),
            threadMessage: sanitizeAgenticServicePolicy(
              input.agenticServices.threadMessage,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.threadMessage ?? 'ask'
            ),
            mediaEditing: sanitizeAgenticServicePolicy(
              input.agenticServices.mediaEditing,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.mediaEditing ?? 'ask'
            ),
            mediaRecording: sanitizeAgenticServicePolicy(
              input.agenticServices.mediaRecording,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.mediaRecording ?? 'deny'
            ),
            canvasEval: sanitizeAgenticServicePolicy(
              input.agenticServices.canvasEval,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.canvasEval
            ),
            webBrowsing: sanitizeAgenticServicePolicy(
              input.agenticServices.webBrowsing,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.webBrowsing ?? 'ask'
            ),
            networkAccess: sanitizeAgenticNetworkPolicy(
              input.agenticServices.networkAccess,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.networkAccess
            )
          }
        : undefined,
      networkPolicy,
      persistence,
      containerConfig: isRecord(input.containerConfig)
        ? {
            image: optionalString(input.containerConfig.image),
            workdir: optionalString(input.containerConfig.workdir),
            mounts: Array.isArray(input.containerConfig.mounts)
              ? input.containerConfig.mounts.filter(isRecord).map((mount) => ({
                  source: requireNonEmptyString(mount.source, 'Runtime mount source'),
                  target: requireNonEmptyString(mount.target, 'Runtime mount target'),
                  access: mount.access === 'write' ? 'write' : 'read'
                }))
              : undefined
          }
        : undefined
    }
  }

  function sanitizeHandoffStatus(value: unknown): HandoffCard['status'] {
    return value === 'dispatched' || value === 'archived' ? value : 'draft'
  }

  function stringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : []
  }

  function sanitizeHandoffCardForSave(
    card: unknown
  ): Partial<HandoffCard> &
    Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'> {
    const input = requireRecord(card, 'Handoff card')
    const sourceChatId = requireNonEmptyString(input.sourceChatId, 'Handoff source chat')
    const sourceProvider = assertProviderId(input.sourceProvider)
    const recommendedProvider =
      input.recommendedProvider === undefined
        ? undefined
        : assertProviderId(input.recommendedProvider)
    return {
      id: optionalString(input.id),
      status: sanitizeHandoffStatus(input.status),
      sourceChatId,
      sourceRunId: optionalString(input.sourceRunId),
      sourceProvider,
      workspaceId: optionalString(input.workspaceId),
      workspacePath: optionalString(input.workspacePath),
      summary: requireNonEmptyString(input.summary, 'Handoff summary'),
      selectedFiles: stringList(input.selectedFiles),
      workspaceChangeSetIds: stringList(input.workspaceChangeSetIds),
      rawEventRunIds: stringList(input.rawEventRunIds),
      recommendedProvider,
      recommendedModel: optionalString(input.recommendedModel),
      recommendedApprovalMode: optionalString(input.recommendedApprovalMode),
      targetChatId: optionalString(input.targetChatId),
      dispatchedRunId: optionalString(input.dispatchedRunId),
      finalPrompt: requireNonEmptyString(input.finalPrompt, 'Handoff prompt'),
      dispatchedAt: optionalString(input.dispatchedAt)
    }
  }

  function sanitizeHandoffCardPatch(partial: unknown): Partial<HandoffCard> {
    const input = requireRecord(partial, 'Handoff card update')
    const sanitized: Partial<HandoffCard> = {}
    if ('status' in input) sanitized.status = sanitizeHandoffStatus(input.status)
    if ('summary' in input && input.summary !== undefined)
      sanitized.summary = requireNonEmptyString(input.summary, 'Handoff summary')
    if ('finalPrompt' in input && input.finalPrompt !== undefined)
      sanitized.finalPrompt = requireNonEmptyString(input.finalPrompt, 'Handoff prompt')
    if ('sourceRunId' in input) sanitized.sourceRunId = optionalString(input.sourceRunId)
    if ('selectedFiles' in input) sanitized.selectedFiles = stringList(input.selectedFiles)
    if ('workspaceChangeSetIds' in input)
      sanitized.workspaceChangeSetIds = stringList(input.workspaceChangeSetIds)
    if ('rawEventRunIds' in input) sanitized.rawEventRunIds = stringList(input.rawEventRunIds)
    if ('recommendedProvider' in input)
      sanitized.recommendedProvider =
        input.recommendedProvider === undefined
          ? undefined
          : assertProviderId(input.recommendedProvider)
    if ('recommendedModel' in input)
      sanitized.recommendedModel = optionalString(input.recommendedModel)
    if ('recommendedApprovalMode' in input)
      sanitized.recommendedApprovalMode = optionalString(input.recommendedApprovalMode)
    if ('targetChatId' in input) sanitized.targetChatId = optionalString(input.targetChatId)
    if ('dispatchedRunId' in input)
      sanitized.dispatchedRunId = optionalString(input.dispatchedRunId)
    if ('dispatchedAt' in input) sanitized.dispatchedAt = optionalString(input.dispatchedAt)
    return sanitized
  }

  function sanitizeHandoffCardFilter(filter: unknown): HandoffCardFilter {
    if (!isRecord(filter)) return {}
    return {
      sourceChatId: optionalString(filter.sourceChatId),
      sourceRunId: optionalString(filter.sourceRunId),
      status:
        filter.status === 'draft' || filter.status === 'dispatched' || filter.status === 'archived'
          ? filter.status
          : undefined
    }
  }

  function sanitizeAdvancedFxSettings(
    value: unknown,
    current: AppSettings['advancedFx']
  ): AppSettings['advancedFx'] {
    const source = isRecord(value) ? value : {}
    const rawIntensity = source.intensity
    const intensity =
      rawIntensity === 'subtle' || rawIntensity === 'cinematic' || rawIntensity === 'epic'
        ? rawIntensity
        : current.intensity || 'cinematic'

    return {
      agentAura: 'agentAura' in source ? Boolean(source.agentAura) : current.agentAura,
      livingWorkspace:
        'livingWorkspace' in source ? Boolean(source.livingWorkspace) : current.livingWorkspace,
      dataViz: 'dataViz' in source ? Boolean(source.dataViz) : current.dataViz,
      refraction: 'refraction' in source ? Boolean(source.refraction) : current.refraction,
      intensity
    }
  }

  function sanitizeAuditRetentionSettings(
    value: unknown,
    current: AppSettings['auditRetention']
  ): AppSettings['auditRetention'] {
    const source = isRecord(value) ? value : {}
    const currentMaxAge = isRecord(current?.maxAgeDays) ? current?.maxAgeDays : {}
    const sourceMaxAge = isRecord(source.maxAgeDays) ? source.maxAgeDays : {}
    const surfaces = [
      'approvalLedger',
      'runEvents',
      'workspaceChanges',
      'auditRuns',
      'messageFeedback',
      'externalPublish',
      'productCrashes'
    ] as const
    const maxAgeDays: NonNullable<AppSettings['auditRetention']>['maxAgeDays'] = {}
    for (const surface of surfaces) {
      const raw = surface in sourceMaxAge ? sourceMaxAge[surface] : currentMaxAge?.[surface]
      const days = Number(raw)
      if (Number.isFinite(days) && days > 0) {
        maxAgeDays[surface] = Math.min(3650, Math.max(1, Math.floor(days)))
      }
    }
    return {
      enabled: 'enabled' in source ? source.enabled === true : current?.enabled === true,
      maxAgeDays
    }
  }

  function sanitizeSettingsPatch(partial: unknown): Partial<AppSettings> {
    const input = requireRecord(partial, 'Settings patch')
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (!SETTINGS_PATCH_KEYS.has(key as keyof AppSettings)) continue
      sanitized[key] = value
    }
    if ('activeProvider' in sanitized && sanitized.activeProvider !== undefined) {
      // assertProviderId still rejects genuinely unknown ids, but a RETIRED
      // provider (e.g. gemini) must never become the active provider — coerce it
      // to a live default so legacy/stale patches migrate instead of sticking.
      const provider = assertProviderId(sanitized.activeProvider)
      const effectiveSettings = { ...deps.getSettings(), ...sanitized }
      sanitized.activeProvider = selectableProviderIds(effectiveSettings).includes(provider)
        ? provider
        : coerceLiveProvider(provider)
    }
    if ('providerRunPauses' in sanitized) {
      sanitized.providerRunPauses = sanitizeProviderRunPauses(sanitized.providerRunPauses)
    }
    if ('cliPathDirectories' in sanitized) {
      // These directories are searched FIRST for every external CLI, so a
      // forged patch here would be a binary-planting primitive. Normalizing on
      // WRITE bounds the count, rejects relative entries (which would resolve
      // against an unpredictable cwd) and strips control characters that would
      // corrupt the joined PATH.
      sanitized.cliPathDirectories = normalizeCliPathDirectories(sanitized.cliPathDirectories)
    }
    if ('simulatorControlEnabled' in sanitized) {
      if (typeof sanitized.simulatorControlEnabled !== 'boolean') {
        delete sanitized.simulatorControlEnabled
      }
    }
    if ('piCerebrasMaxCompletionTokens' in sanitized) {
      if (sanitized.piCerebrasMaxCompletionTokens === null) {
        // Explicit UI reset: serialize as absent so Pi returns to each model's
        // advertised maximum instead of carrying a hidden old cap.
        sanitized.piCerebrasMaxCompletionTokens = undefined
      } else {
        const cap = normalizePiCerebrasMaxCompletionTokens(sanitized.piCerebrasMaxCompletionTokens)
        if (cap === undefined) delete sanitized.piCerebrasMaxCompletionTokens
        else sanitized.piCerebrasMaxCompletionTokens = cap
      }
    }
    if ('apiUsageBilling' in sanitized) {
      sanitized.apiUsageBilling = normalizeApiUsageBillingSettings(sanitized.apiUsageBilling)
    }
    if ('themeAppearance' in sanitized && typeof sanitized.themeAppearance === 'string') {
      sanitized.themeAppearance = normalizeSystemThemeAppearance(sanitized.themeAppearance)
    }
    if ('themeAccentColor' in sanitized) {
      sanitized.themeAccentColor = normalizeThemeAccentColor(sanitized.themeAccentColor)
    }
    // Normalize on WRITE, not only on read. The store already normalizes when
    // loading, but the allowlist alone would let an arbitrary object reach disk;
    // coercing here keeps what is persisted a valid `#RRGGBB` pair regardless of
    // what a renderer (or, later, an agent-driven token write) sends.
    if ('diffStatColors' in sanitized) {
      sanitized.diffStatColors = normalizeDiffStatColors(sanitized.diffStatColors)
    }
    // Agent-authored, so the write is sanitised against the allowlist here and
    // not merely trusted from whatever produced the patch.
    if ('agentThemeTokens' in sanitized) {
      sanitized.agentThemeTokens = normalizeAgentThemeTokenOverrides(sanitized.agentThemeTokens)
    }
    if ('auditRetention' in sanitized) {
      sanitized.auditRetention = sanitizeAuditRetentionSettings(
        sanitized.auditRetention,
        deps.getSettings().auditRetention
      )
    }
    if ('autoUpdateEnabled' in sanitized) {
      if (typeof sanitized.autoUpdateEnabled !== 'boolean') {
        delete sanitized.autoUpdateEnabled
      }
    }
    if ('customInstructionsEnabled' in sanitized) {
      if (typeof sanitized.customInstructionsEnabled !== 'boolean') {
        delete sanitized.customInstructionsEnabled
      }
    }
    if ('activityReportingEnabled' in sanitized) {
      if (typeof sanitized.activityReportingEnabled !== 'boolean') {
        delete sanitized.activityReportingEnabled
      }
    }
    if ('iosBannerTemplate' in sanitized) {
      // `null` is the explicit "reset to the built-in wording" signal, so it is
      // preserved as a delete rather than sanitized into a default template.
      if (sanitized.iosBannerTemplate === null || sanitized.iosBannerTemplate === undefined) {
        sanitized.iosBannerTemplate = undefined
      } else {
        sanitized.iosBannerTemplate = sanitizeBannerTemplate(sanitized.iosBannerTemplate)
      }
    }
    if ('iosActivityArchetype' in sanitized) {
      // Same reset convention as the template above: null/undefined means "back
      // to the built-in layout", which must survive as a delete rather than be
      // coerced into the default id (the two are indistinguishable on the wire
      // but not in the settings UI, which shows a preset as unselected).
      const archetype = sanitized.iosActivityArchetype
      if (archetype === null || archetype === undefined) {
        sanitized.iosActivityArchetype = undefined
      } else if (!ACTIVITY_ARCHETYPES.includes(archetype as ActivityArchetype)) {
        delete sanitized.iosActivityArchetype
      }
    }
    if ('iosActivityEnabled' in sanitized) {
      if (typeof sanitized.iosActivityEnabled !== 'boolean') {
        delete sanitized.iosActivityEnabled
      }
    }
    if ('userMcpServers' in sanitized) {
      sanitized.userMcpServers = sanitizeUserMcpServers(sanitized.userMcpServers)
    }
    if ('agenticServices' in sanitized) {
      const services = requireRecord(sanitized.agenticServices, 'Agentic services')
      const current = deps.getSettings().agenticServices
      sanitized.agenticServices = {
        shellCommands: sanitizeAgenticServicePolicy(services.shellCommands, current.shellCommands),
        fileChanges: sanitizeAgenticServicePolicy(services.fileChanges, current.fileChanges),
        externalPublish: sanitizeAgenticServicePolicy(
          services.externalPublish,
          current.externalPublish ?? 'ask'
        ),
        mcpTools: sanitizeAgenticServicePolicy(services.mcpTools, current.mcpTools),
        subThreadDelegation: sanitizeAgenticServicePolicy(
          services.subThreadDelegation,
          current.subThreadDelegation
        ),
        // Dedicated grant buckets carried through the settings-patch rebuild so a
        // partial patch can't silently reset them to default. (Pre-existing gap:
        // canvasInteraction/crossThreadRead/canvasEval were dropped here; preserve
        // them too rather than singling out the new media services.)
        canvasInteraction: sanitizeAgenticServicePolicy(
          services.canvasInteraction,
          current.canvasInteraction
        ),
        sketchCanvas: sanitizeAgenticServicePolicy(
          services.sketchCanvas,
          current.sketchCanvas ?? 'allow'
        ),
        meshCanvas: sanitizeAgenticServicePolicy(services.meshCanvas, current.meshCanvas ?? 'ask'),
        simulatorCanvas: sanitizeAgenticServicePolicy(
          services.simulatorCanvas,
          current.simulatorCanvas ?? 'ask'
        ),
        crossThreadRead: sanitizeAgenticServicePolicy(
          services.crossThreadRead,
          current.crossThreadRead ?? 'ask'
        ),
        threadMessage: sanitizeAgenticServicePolicy(
          services.threadMessage,
          current.threadMessage ?? 'ask'
        ),
        mediaEditing: sanitizeAgenticServicePolicy(
          services.mediaEditing,
          current.mediaEditing ?? 'ask'
        ),
        // mediaRecording is the default-deny capture scaffold.
        mediaRecording: sanitizeAgenticServicePolicy(
          services.mediaRecording,
          current.mediaRecording ?? 'deny'
        ),
        canvasEval: sanitizeAgenticServicePolicy(services.canvasEval, current.canvasEval),
        webBrowsing: sanitizeAgenticServicePolicy(
          services.webBrowsing,
          current.webBrowsing ?? 'ask'
        ),
        networkAccess: sanitizeAgenticNetworkPolicy(services.networkAccess, current.networkAccess)
      }
    }
    if ('agenticWorkspaceGrants' in sanitized) {
      const grants = sanitizeAgenticWorkspaceGrants(sanitized.agenticWorkspaceGrants)
      if (grants) sanitized.agenticWorkspaceGrants = grants
      else delete sanitized.agenticWorkspaceGrants
    }
    if ('approvalModeElevationAcknowledgements' in sanitized) {
      if (!isRecord(sanitized.approvalModeElevationAcknowledgements)) {
        delete sanitized.approvalModeElevationAcknowledgements
      } else {
        sanitized.approvalModeElevationAcknowledgements = Object.fromEntries(
          Object.entries(sanitized.approvalModeElevationAcknowledgements).filter(
            ([key, value]) => key.length > 0 && typeof value === 'boolean'
          )
        )
      }
    }
    if ('currency' in sanitized) {
      const value = sanitized.currency
      if (value !== 'USD' && value !== 'GBP' && value !== 'EUR') delete sanitized.currency
    }
    if ('currencyOverestimatePercent' in sanitized) {
      const value = Number(sanitized.currencyOverestimatePercent)
      if (Number.isFinite(value)) {
        sanitized.currencyOverestimatePercent = Math.max(0, Math.min(25, Math.round(value)))
      } else {
        delete sanitized.currencyOverestimatePercent
      }
    }
    if ('showRunCompleteSummary' in sanitized) {
      const value = sanitized.showRunCompleteSummary
      sanitized.showRunCompleteSummary = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('closeoutAiSummaryEnabled' in sanitized) {
      const value = sanitized.closeoutAiSummaryEnabled
      sanitized.closeoutAiSummaryEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('hostAutoCompactEnabled' in sanitized) {
      const value = sanitized.hostAutoCompactEnabled
      sanitized.hostAutoCompactEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('ensembleCollapseOlderRounds' in sanitized) {
      const value = sanitized.ensembleCollapseOlderRounds
      sanitized.ensembleCollapseOlderRounds = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('maxWaveAgents' in sanitized) {
      // Settings → General: cap delegate_wave batch size (default 8, clamp 2–64).
      const value = Number(sanitized.maxWaveAgents)
      if (Number.isFinite(value)) {
        sanitized.maxWaveAgents = Math.max(2, Math.min(64, Math.floor(value)))
      } else {
        delete sanitized.maxWaveAgents
      }
    }
    if ('modelUsagePanelView' in sanitized) {
      const value = sanitized.modelUsagePanelView
      if (value !== 'plan' && value !== 'spend' && value !== 'context')
        delete sanitized.modelUsagePanelView
    }
    if ('appIconVariant' in sanitized) {
      // Drop invalid ids (including the retired wwdc26 — its assets are gone, so
      // both a NEW selection and a stale persisted value fall back to the default).
      if (!isAppIconVariant(sanitized.appIconVariant)) {
        delete sanitized.appIconVariant
      }
    }
    if ('modelUsageExternalUsage' in sanitized) {
      const value = sanitized.modelUsageExternalUsage
      if (typeof value !== 'boolean') delete sanitized.modelUsageExternalUsage
    }
    if ('dashboardStatPrefs' in sanitized) {
      const prefs = isRecord(sanitized.dashboardStatPrefs) ? sanitized.dashboardStatPrefs : {}
      const current = deps.getSettings().dashboardStatPrefs || {}
      const visibility = isRecord(prefs.visibility) ? prefs.visibility : current.visibility
      sanitized.dashboardStatPrefs = {
        ...current,
        ...(typeof prefs.dashboardEnabled === 'boolean'
          ? { dashboardEnabled: prefs.dashboardEnabled }
          : {}),
        ...(prefs.dashboardSize === 'large' || prefs.dashboardSize === 'small'
          ? { dashboardSize: prefs.dashboardSize }
          : {}),
        ...(visibility
          ? {
              visibility: Object.fromEntries(
                Object.entries(visibility).filter(
                  (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
                )
              )
            }
          : {}),
        ...(Number.isFinite(Number(prefs.resetAt))
          ? { resetAt: Math.max(0, Number(prefs.resetAt)) }
          : {}),
        ...(typeof prefs.workspacesTabEnabled === 'boolean'
          ? { workspacesTabEnabled: prefs.workspacesTabEnabled }
          : {}),
        ...(Number.isFinite(Number(prefs.workspacesShown))
          ? {
              workspacesShown: Math.max(4, Math.min(20, Math.round(Number(prefs.workspacesShown))))
            }
          : {}),
        ...(typeof prefs.providersTabEnabled === 'boolean'
          ? { providersTabEnabled: prefs.providersTabEnabled }
          : {}),
        ...(Number.isFinite(Number(prefs.autoCycleSeconds))
          ? {
              autoCycleSeconds: Math.max(
                0,
                Math.min(3600, Math.round(Number(prefs.autoCycleSeconds)))
              )
            }
          : {})
      }
    }
    if ('welcomeHeatmapPrefs' in sanitized) {
      const prefs = isRecord(sanitized.welcomeHeatmapPrefs) ? sanitized.welcomeHeatmapPrefs : {}
      const current = deps.getSettings().welcomeHeatmapPrefs || {}
      sanitized.welcomeHeatmapPrefs = {
        ...(prefs.layout === 'single' || prefs.layout === 'stacked'
          ? { layout: prefs.layout }
          : current.layout === 'single' || current.layout === 'stacked'
            ? { layout: current.layout }
            : {}),
        workspaceActivityEnabled:
          typeof prefs.workspaceActivityEnabled === 'boolean'
            ? prefs.workspaceActivityEnabled
            : current.workspaceActivityEnabled,
        taskwraithActivityEnabled:
          typeof prefs.taskwraithActivityEnabled === 'boolean'
            ? prefs.taskwraithActivityEnabled
            : current.taskwraithActivityEnabled,
        externalActivityEnabled:
          typeof prefs.externalActivityEnabled === 'boolean'
            ? prefs.externalActivityEnabled
            : current.externalActivityEnabled
      }
    }
    if ('approvalTimeouts' in sanitized) {
      const prefs = isRecord(sanitized.approvalTimeouts) ? sanitized.approvalTimeouts : {}
      const current = deps.getSettings().approvalTimeouts
      const perProvider = isRecord(prefs.perProviderMs) ? prefs.perProviderMs : {}
      const perProviderMs: AppSettings['approvalTimeouts']['perProviderMs'] = {
        ...current.perProviderMs
      }
      for (const provider of PROVIDER_IDS) {
        perProviderMs[provider] = sanitizeApprovalTimeoutMs(
          perProvider[provider],
          current.perProviderMs[provider]
        )
      }
      sanitized.approvalTimeouts = {
        enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : current.enabled,
        defaultsVersion: current.defaultsVersion ?? APPROVAL_TIMEOUT_DEFAULTS_VERSION,
        perProviderMs,
        mainAuthorityMs: sanitizeApprovalTimeoutMs(prefs.mainAuthorityMs, current.mainAuthorityMs)
      }
    }
    if ('lastSeenChangelogVersion' in sanitized) {
      if (
        typeof sanitized.lastSeenChangelogVersion === 'string' &&
        sanitized.lastSeenChangelogVersion.trim()
      ) {
        sanitized.lastSeenChangelogVersion = sanitized.lastSeenChangelogVersion.trim()
      } else {
        delete sanitized.lastSeenChangelogVersion
      }
    }
    if ('pendingUpdateChangelog' in sanitized) {
      const changelog = sanitizeUpdateChangelog(sanitized.pendingUpdateChangelog)
      if (changelog) {
        sanitized.pendingUpdateChangelog = changelog
      } else {
        delete sanitized.pendingUpdateChangelog
      }
    }
    if ('kimiSanitiserEnabled' in sanitized) {
      sanitized.kimiSanitiserEnabled =
        typeof sanitized.kimiSanitiserEnabled === 'boolean'
          ? sanitized.kimiSanitiserEnabled
          : Boolean(sanitized.kimiSanitiserEnabled)
    }
    if ('kimiSanitiserCustomKeywords' in sanitized) {
      sanitized.kimiSanitiserCustomKeywords =
        typeof sanitized.kimiSanitiserCustomKeywords === 'string'
          ? sanitized.kimiSanitiserCustomKeywords
          : ''
    }
    if ('kimiClassifierEnabled' in sanitized) {
      sanitized.kimiClassifierEnabled =
        typeof sanitized.kimiClassifierEnabled === 'boolean'
          ? sanitized.kimiClassifierEnabled
          : Boolean(sanitized.kimiClassifierEnabled)
    }
    if ('geminiApiRuntime' in sanitized) {
      const value = sanitized.geminiApiRuntime
      if (value !== 'auto' && value !== 'always' && value !== 'never') {
        delete sanitized.geminiApiRuntime
      }
    }
    if ('promptCache' in sanitized) {
      sanitized.promptCache = normalizePromptCacheSettings(
        sanitized.promptCache,
        deps.getSettings().promptCache
      )
    }
    if ('providerHarnessPosture' in sanitized) {
      sanitized.providerHarnessPosture = normalizeProviderHarnessPostureMap(
        sanitized.providerHarnessPosture
      )
    }
    if ('trustWorkspaceHooks' in sanitized) {
      if (typeof sanitized.trustWorkspaceHooks !== 'boolean') {
        delete sanitized.trustWorkspaceHooks
      }
    }
    if ('askBeforeHookCommands' in sanitized) {
      if (typeof sanitized.askBeforeHookCommands !== 'boolean') {
        delete sanitized.askBeforeHookCommands
      }
    }
    if ('nativeSubAgentRequests' in sanitized) {
      sanitized.nativeSubAgentRequests =
        sanitized.nativeSubAgentRequests === 'provider' ||
        sanitized.nativeSubAgentRequests === 'taskwraith'
          ? sanitized.nativeSubAgentRequests
          : 'ask'
    }
    if ('advancedFx' in sanitized) {
      sanitized.advancedFx = sanitizeAdvancedFxSettings(
        sanitized.advancedFx,
        deps.getSettings().advancedFx
      )
    }
    if ('windowBounds' in sanitized) {
      const bounds = sanitizeWindowBounds(sanitized.windowBounds)
      if (bounds) {
        sanitized.windowBounds = bounds
      } else {
        delete sanitized.windowBounds
      }
    }
    for (const key of [
      'chatContextTurns',
      'inspectorWidth',
      'sidebarWidth',
      'sidebarOpacity',
      'mainPaneOpacity'
    ] as const) {
      if (key in sanitized) {
        const value = Number(sanitized[key])
        if (Number.isFinite(value)) {
          if (key === 'chatContextTurns') {
            sanitized[key] = Math.max(0, Math.trunc(value))
          } else if (key === 'inspectorWidth') {
            sanitized[key] = clampDimension(value, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)
          } else if (key === 'sidebarWidth') {
            sanitized[key] = clampDimension(value, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
          } else if (key === 'sidebarOpacity' || key === 'mainPaneOpacity') {
            sanitized[key] = clampDimension(value, 0, 100, 100)
          } else {
            sanitized[key] = Math.max(0, Math.trunc(value))
          }
        } else {
          delete sanitized[key]
        }
      }
    }

    if ('funFxEnabled' in sanitized) {
      const value = sanitized.funFxEnabled
      sanitized.funFxEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('bridgeDaemonEnabled' in sanitized) {
      const value = sanitized.bridgeDaemonEnabled
      sanitized.bridgeDaemonEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('studioCompanionEnabled' in sanitized) {
      const value = sanitized.studioCompanionEnabled
      sanitized.studioCompanionEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('localServersDetachSpawns' in sanitized) {
      const value = sanitized.localServersDetachSpawns
      sanitized.localServersDetachSpawns = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('localServersStopOnQuit' in sanitized) {
      const value = sanitized.localServersStopOnQuit
      sanitized.localServersStopOnQuit = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('sidebarOpacityOverride' in sanitized) {
      const value = sanitized.sidebarOpacityOverride
      sanitized.sidebarOpacityOverride = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('mainPaneOpacityOverride' in sanitized) {
      const value = sanitized.mainPaneOpacityOverride
      sanitized.mainPaneOpacityOverride = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('ensembleModeEnabled' in sanitized) {
      const value = sanitized.ensembleModeEnabled
      sanitized.ensembleModeEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('funFxMode' in sanitized) {
      const value = sanitized.funFxMode
      if (value === 'off' || value === 'subtle' || value === 'cinematic' || value === 'epic') {
        sanitized.funFxMode = value
      } else {
        delete sanitized.funFxMode
      }
    }
    if ('auditOrchestration' in sanitized) {
      const cleaned = sanitizeAuditOrchestration(sanitized.auditOrchestration)
      if (cleaned) sanitized.auditOrchestration = cleaned
      else delete sanitized.auditOrchestration
    }
    if ('antigravityEnabled' in sanitized) {
      const value = sanitized.antigravityEnabled
      sanitized.antigravityEnabled = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('antigravityOptInAcceptedAt' in sanitized) {
      const value = sanitized.antigravityOptInAcceptedAt
      sanitized.antigravityOptInAcceptedAt =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    }
    if ('antigravityGeminiApiDisclosureAcceptedAt' in sanitized) {
      const value = sanitized.antigravityGeminiApiDisclosureAcceptedAt
      sanitized.antigravityGeminiApiDisclosureAcceptedAt =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    }
    if ('antigravityGeminiApiMonthlySpendCapUsd' in sanitized) {
      // Soft advisory budget: positive finite USD, bounded so a typo cannot
      // produce a meter that never fills; anything else clears the cap.
      const value = sanitized.antigravityGeminiApiMonthlySpendCapUsd
      sanitized.antigravityGeminiApiMonthlySpendCapUsd =
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000
          ? value
          : null
    }
    if ('museMonthlySpendCapUsd' in sanitized) {
      // Same soft-budget clamp as the AntiGravity Gemini API cap. Explicit null
      // clears the Muse meter; omitting the key leaves the shared $15 default
      // at read sites (see resolveMuseMonthlySpendCapUsd).
      const value = sanitized.museMonthlySpendCapUsd
      sanitized.museMonthlySpendCapUsd =
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000
          ? value
          : null
    }
    return sanitized as Partial<AppSettings>
  }

  return {
    sanitizeScheduledTaskForSave,
    sanitizeScheduledTaskPatch,
    sanitizeWorkflowForSave,
    sanitizeWorkflowPatch,
    sanitizeWorkspaceBoardForSave,
    sanitizeWorkspaceBoardPatch,
    sanitizeWorkspaceBoardCardForSave,
    sanitizeWorkspaceBoardCardPatch,
    sanitizeRuntimeProfileForSave,
    sanitizeHandoffCardForSave,
    sanitizeHandoffCardPatch,
    sanitizeHandoffCardFilter,
    sanitizeAdvancedFxSettings,
    sanitizeSettingsPatch
  }
}

export type MainSanitizers = ReturnType<typeof createMainSanitizers>

export function consoleMessageLevelToNumber(
  level: WebContentsConsoleMessageEventParams['level'] | number
): number {
  if (typeof level === 'number') return level
  switch (level) {
    case 'debug':
      return 0
    case 'info':
      return 1
    case 'warning':
      return 2
    case 'error':
      return 3
    default:
      return 1
  }
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'solid' || value === 'soft_glass' || value === 'native_glass'
}
