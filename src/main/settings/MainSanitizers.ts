import type { WebContentsConsoleMessageEventParams } from 'electron'
import type { AppearanceMode } from '../store/types'
import type {
  AppSettings,
  AuditOrchestrationSettings,
  AuditRole,
  AuditRunIdentity,
  EnsembleRunIdentity,
  ExternalPathGrant,
  HandoffCard,
  HandoffCardFilter,
  ProviderId,
  ProductUpdateChangelog,
  RuntimeProfile,
  ScheduledTask,
  UserMcpServerConfig,
  WorkflowDefinition,
  WorkflowRunTemplate,
  WorkflowTrigger,
  WorkspaceRecord
} from '../store/types'
import { sanitizeProviderRunPauses } from '../ProviderRunPause'
import { coerceLiveProvider, isRetiredProvider } from '../../shared/retiredProviders'
import { isAppIconVariant, isWwdc26IconAvailable } from '../../shared/iconVariants'

// Grok + Cursor are first-class providers; no eligibility gate (see ProviderId).
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
])
const DEFAULT_AGENTIC_SERVICES_FOR_PROFILE: AppSettings['agenticServices'] = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  crossThreadRead: 'ask',
  mediaEditing: 'ask',
  mediaRecording: 'deny',
  canvasEval: 'ask',
  networkAccess: 'allow'
}
const SETTINGS_PATCH_KEYS = new Set<keyof AppSettings>([
  'activeProvider',
  'providerRunPauses',
  'windowBounds',
  'claudeBinaryPath',
  'kimiBinaryPath',
  'ollamaBaseUrl',
  'ollamaDefaultModel',
  'ollamaToolControlTier',
  'ollamaDefaultRunProfile',
  'ollamaRunProfiles',
  'ollamaProviderParityAcknowledgedAt',
  'ollamaProviderParityWorkspaceGrants',
  'codexUsageCredential',
  'storeLocalChatHistory',
  'storeRawEvents',
  'storePromptResponseInUsage',
  'ensembleModeEnabled',
  'geminiCheckpointingEnabled',
  'chatContextTurns',
  'appearanceMode',
  'visualEffectStyle',
  'themeAppearance',
  'themeCornerStyle',
  'themeAccentStyle',
  'toolIconAccent',
  'userBubbleColor',
  'promptSurfaceStyle',
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
  'modelUsagePanelView',
  'modelUsageExternalUsage',
  'dashboardStatPrefs',
  'welcomeHeatmapPrefs',
  'kimiSanitiserEnabled',
  'kimiSanitiserCustomKeywords',
  'kimiClassifierEnabled',
  'agenticServices',
  'nativeSubAgentRequests',
  'geminiApiRuntime',
  'userMcpServers',
  'geminiMcpBridgeEnabled',
  'geminiMcpBridgeLastStatus',
  'bridgeDaemonEnabled',
  'localServersDetachSpawns',
  'localServersStopOnQuit',
  'messageBridgeEnabled',
  'messageBridgePollIntervalMs',
  'codexSandboxFallback',
  'autoUpdateEnabled',
  'updateChannel',
  'lastSeenChangelogVersion',
  'pendingUpdateChangelog',
  'approvalTimeouts',
  'auditOrchestration',
  'appIconVariant'
])

export const MIN_INSPECTOR_WIDTH = 300
export const MAX_INSPECTOR_WIDTH = 720
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
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  canonicalPath: (value: string) => string
  normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => ExternalPathGrant[]
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
  return ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama']
}

/**
 * The subset of KNOWN providers that may be OFFERED or RUN — excludes retired
 * providers (e.g. gemini). Use this for pickers, MCP tool enums, run-command
 * parsing, and "supported provider" error lists. `availableProviderIds()` stays
 * the full known set so decode/validation of historical data keeps working.
 */
export function selectableProviderIds(): ProviderId[] {
  return availableProviderIds().filter((provider) => !isRetiredProvider(provider))
}

/**
 * Like `assertProviderId`, but also rejects RETIRED providers. Use at run
 * DISPATCH so a retired/historical provider can never start a new run, while
 * read/validate paths keep `assertProviderId` (which still accepts it).
 */
export function assertLiveProviderId(value: unknown): ProviderId {
  const provider = assertProviderId(value)
  if (isRetiredProvider(provider)) {
    throw new Error(
      `${provider} has been retired and can no longer start runs. Chat history is preserved.`
    )
  }
  return provider
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
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof rawValue === 'string') {
          env[key] = rawValue
        }
      }
    }
    const headers: Record<string, string> = {}
    if (isRecord(record.headers)) {
      for (const [key, rawValue] of Object.entries(record.headers).slice(0, 64)) {
        if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof rawValue === 'string') {
          headers[key] = rawValue
        }
      }
    }
    const command = optionalString(record.command)?.trim()
    const rawUrl = optionalString(record.url)?.trim()
    const url = rawUrl && isValidUserMcpRemoteUrl(rawUrl) ? rawUrl : undefined
    const bearerTokenEnvVar = optionalString(record.bearerTokenEnvVar)?.trim()
    const description = optionalString(record.description)?.trim()
    const createdAt = optionalString(record.createdAt)?.trim()
    const updatedAt = optionalString(record.updatedAt)?.trim()
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
    if (bearerTokenEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar)) {
      sanitized.bearerTokenEnvVar = bearerTokenEnvVar
    }
    if (description) sanitized.description = description
    if (createdAt) sanitized.createdAt = createdAt
    if (updatedAt) sanitized.updatedAt = updatedAt
    servers.push(sanitized)
  }
  return servers
}

export function imageAttachmentSnapshots(
  value: unknown
): Array<{ id?: string; path: string; name?: string }> {
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
          : {})
      }
    })
    .filter((item): item is { id?: string; path: string; name?: string } => Boolean(item))
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

export function sanitizeAgenticNetworkPolicy(
  value: unknown,
  fallback: 'allow' | 'deny'
): 'allow' | 'deny' {
  return value === 'allow' || value === 'deny' ? value : fallback
}

const AUDIT_ROLES: readonly AuditRole[] = ['recon', 'reviewer', 'skeptic', 'synthesis']
// Audit policy accepts ANY structural provider (incl. gated grok/cursor) —
// the capability resolver excludes unconfigured/unavailable ones at runtime,
// so storing a preference for a provider the user later enables is harmless.
const AUDIT_PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
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
  return Math.max(5_000, Math.min(3_600_000, parsed))
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
  return {
    roundId: requireNonEmptyString(value.roundId, 'Ensemble round id'),
    participantId: requireNonEmptyString(value.participantId, 'Ensemble participant id'),
    provider: assertProviderId(value.provider),
    role: optionalString(value.role) || 'Participant',
    order: optionalNumber(value.order) ?? 0
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

  function sanitizeScheduledTaskForSave(
    task: unknown
  ): Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
    Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>> {
    const input = requireRecord(task, 'Scheduled task')
    const workspace = assertScheduledTaskWorkspaceIdentity(
      requireNonEmptyString(input.workspacePath, 'Scheduled task workspace'),
      input.workspaceId
    )
    return {
      ...input,
      workspaceId: workspace.id,
      workspacePath: deps.canonicalPath(workspace.path),
      provider: assertProviderId(input.provider),
      externalPathGrants: normalizeScheduledTaskExternalGrants(input.externalPathGrants),
      claudeFastMode: typeof input.claudeFastMode === 'boolean' ? input.claudeFastMode : undefined,
      runtimeProfileId: optionalString(input.runtimeProfileId),
      geminiAuthProfileId: optionalStringOrNull(input.geminiAuthProfileId),
      handoffSourceRunId: optionalString(input.handoffSourceRunId)
    } as Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
      Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>>
  }

  function sanitizeScheduledTaskPatch(id: string, partial: unknown): Partial<ScheduledTask> | null {
    const input = requireRecord(partial, 'Scheduled task update')
    const existing = deps.getScheduledTasks().find((task) => task.id === id)
    if (!existing) return null
    const workspace = assertScheduledTaskWorkspaceIdentity(
      existing.workspacePath,
      existing.workspaceId
    )
    if (
      'workspacePath' in input &&
      input.workspacePath !== undefined &&
      deps.canonicalPath(String(input.workspacePath)) !== deps.canonicalPath(workspace.path)
    ) {
      throw new Error('Scheduled task workspace path cannot be changed by the renderer.')
    }
    if (
      'workspaceId' in input &&
      input.workspaceId !== undefined &&
      input.workspaceId !== workspace.id
    ) {
      throw new Error('Scheduled task workspace id cannot be changed by the renderer.')
    }

    const sanitized: Partial<ScheduledTask> = {
      ...(input as Partial<ScheduledTask>),
      workspaceId: workspace.id,
      workspacePath: deps.canonicalPath(workspace.path)
    }
    if ('provider' in input && input.provider !== undefined) {
      sanitized.provider = assertProviderId(input.provider)
    }
    if ('externalPathGrants' in input) {
      sanitized.externalPathGrants = normalizeScheduledTaskExternalGrants(input.externalPathGrants)
    }
    if ('claudeFastMode' in input) {
      sanitized.claudeFastMode =
        typeof input.claudeFastMode === 'boolean' ? input.claudeFastMode : undefined
    }
    if ('runtimeProfileId' in input) {
      sanitized.runtimeProfileId = optionalString(input.runtimeProfileId)
    }
    if ('geminiAuthProfileId' in input) {
      sanitized.geminiAuthProfileId = optionalStringOrNull(input.geminiAuthProfileId)
    }
    if ('handoffSourceRunId' in input) {
      sanitized.handoffSourceRunId = optionalString(input.handoffSourceRunId)
    }
    return sanitized
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

  function sanitizeWorkflowTemplate(value: unknown): WorkflowRunTemplate {
    const input = requireRecord(value, 'Workflow template')
    const workspace = assertScheduledTaskWorkspaceIdentity(
      requireNonEmptyString(input.workspacePath, 'Workflow workspace'),
      input.workspaceId
    )
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    if (!prompt.trim()) throw new Error('Workflow prompt is required.')
    return {
      ...input,
      workspaceId: workspace.id,
      workspacePath: deps.canonicalPath(workspace.path),
      chatId: requireNonEmptyString(input.chatId, 'Workflow chat'),
      provider: assertProviderId(input.provider),
      prompt,
      displayPrompt: optionalString(input.displayPrompt),
      selectedModelType: optionalString(input.selectedModelType) || 'default',
      customModel: optionalString(input.customModel) || '',
      approvalMode: optionalString(input.approvalMode) || 'default',
      sessionTrust: Boolean(input.sessionTrust),
      imageAttachments: Array.isArray(input.imageAttachments)
        ? (input.imageAttachments as any)
        : [],
      externalPathGrants: normalizeScheduledTaskExternalGrants(input.externalPathGrants),
      geminiWorktree: input.geminiWorktree as any,
      codexReasoningEffort: optionalString(input.codexReasoningEffort),
      codexServiceTier: optionalString(input.codexServiceTier),
      claudeFastMode: typeof input.claudeFastMode === 'boolean' ? input.claudeFastMode : undefined,
      kimiThinkingEnabled:
        typeof input.kimiThinkingEnabled === 'boolean' ? input.kimiThinkingEnabled : undefined,
      runtimeProfileId: optionalString(input.runtimeProfileId),
      geminiAuthProfileId: optionalStringOrNull(input.geminiAuthProfileId),
      handoffSourceRunId: optionalString(input.handoffSourceRunId),
      kind: input.kind === 'ensemble' ? 'ensemble' : 'single',
      ensembleSnapshot: input.ensembleSnapshot as any
    } as WorkflowRunTemplate
  }

  function sanitizeWorkflowForSave(
    workflow: unknown
  ): Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'> &
    Partial<
      Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>
    > {
    const input = requireRecord(workflow, 'Workflow')
    const template = sanitizeWorkflowTemplate(input.template)
    const limits = isRecord(input.limits) ? input.limits : {}
    return {
      id: optionalString(input.id),
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

  function sanitizeWorkflowPatch(id: string, partial: unknown): Partial<WorkflowDefinition> | null {
    const existing = deps.getWorkflowDefinitions().find((workflow) => workflow.id === id)
    if (!existing) return null
    const input = requireRecord(partial, 'Workflow update')
    const sanitized: Partial<WorkflowDefinition> = {}
    if ('name' in input) sanitized.name = requireNonEmptyString(input.name, 'Workflow name')
    if ('enabled' in input) sanitized.enabled = input.enabled !== false
    if ('trigger' in input) sanitized.trigger = sanitizeWorkflowTrigger(input.trigger)
    if ('template' in input) sanitized.template = sanitizeWorkflowTemplate(input.template)
    if ('missedRunPolicy' in input) {
      sanitized.missedRunPolicy = input.missedRunPolicy === 'skip' ? 'skip' : 'coalesce'
    }
    if ('concurrencyPolicy' in input) {
      sanitized.concurrencyPolicy = input.concurrencyPolicy === 'enqueue' ? 'enqueue' : 'skip'
    }
    if ('limits' in input && isRecord(input.limits)) {
      sanitized.limits = {
        ...existing.limits,
        ...(Number.isFinite(Number(input.limits.maxRunsPerDay))
          ? { maxRunsPerDay: Math.max(1, Math.trunc(Number(input.limits.maxRunsPerDay))) }
          : {}),
        ...(Number.isFinite(Number(input.limits.maxConsecutiveFailures))
          ? {
              maxConsecutiveFailures: Math.max(
                1,
                Math.trunc(Number(input.limits.maxConsecutiveFailures))
              )
            }
          : {})
      }
    }
    return sanitized
  }

  function sanitizeRuntimeProfileForSave(
    profile: unknown
  ): Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'> {
    const input = requireRecord(profile, 'Runtime profile')
    const env: Record<string, string> = {}
    if (isRecord(input.env)) {
      for (const [key, value] of Object.entries(input.env)) {
        if (typeof key === 'string' && key.trim() && typeof value === 'string') {
          env[key] = value
        }
      }
    }
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
            crossThreadRead: sanitizeAgenticServicePolicy(
              input.agenticServices.crossThreadRead,
              DEFAULT_AGENTIC_SERVICES_FOR_PROFILE.crossThreadRead ?? 'ask'
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
      sanitized.activeProvider = coerceLiveProvider(assertProviderId(sanitized.activeProvider))
    }
    if ('providerRunPauses' in sanitized) {
      sanitized.providerRunPauses = sanitizeProviderRunPauses(sanitized.providerRunPauses)
    }
    if ('autoUpdateEnabled' in sanitized) {
      if (typeof sanitized.autoUpdateEnabled !== 'boolean') {
        delete sanitized.autoUpdateEnabled
      }
    }
    if ('ollamaToolControlTier' in sanitized) {
      const tier = sanitized.ollamaToolControlTier
      if (
        tier !== 'read_only' &&
        tier !== 'approved_edits' &&
        tier !== 'approved_shell' &&
        tier !== 'provider_parity'
      ) {
        delete sanitized.ollamaToolControlTier
      }
    }
    if ('ollamaDefaultRunProfile' in sanitized) {
      const profile = sanitized.ollamaDefaultRunProfile
      if (
        profile !== 'local_scout' &&
        profile !== 'approved_patcher' &&
        profile !== 'verify_with_shell' &&
        profile !== 'provider_parity' &&
        profile !== 'custom'
      ) {
        delete sanitized.ollamaDefaultRunProfile
      }
    }
    if ('ollamaRunProfiles' in sanitized && !isRecord(sanitized.ollamaRunProfiles)) {
      sanitized.ollamaRunProfiles = {}
    }
    if ('userMcpServers' in sanitized) {
      sanitized.userMcpServers = sanitizeUserMcpServers(sanitized.userMcpServers)
    }
    if ('ollamaProviderParityAcknowledgedAt' in sanitized) {
      const acknowledgedAt = sanitized.ollamaProviderParityAcknowledgedAt
      if (typeof acknowledgedAt === 'string' && acknowledgedAt.trim()) {
        sanitized.ollamaProviderParityAcknowledgedAt = acknowledgedAt.trim()
      } else {
        delete sanitized.ollamaProviderParityAcknowledgedAt
      }
    }
    if ('ollamaProviderParityWorkspaceGrants' in sanitized) {
      const grants = isRecord(sanitized.ollamaProviderParityWorkspaceGrants)
        ? sanitized.ollamaProviderParityWorkspaceGrants
        : {}
      sanitized.ollamaProviderParityWorkspaceGrants = Object.fromEntries(
        Object.entries(grants)
          .map(([workspacePath, grantedAt]) => [
            workspacePath.trim(),
            String(grantedAt || '').trim()
          ])
          .filter(([workspacePath, grantedAt]) => workspacePath.length > 0 && grantedAt.length > 0)
      )
    }
    if (
      sanitized.ollamaToolControlTier === 'provider_parity' &&
      !('ollamaProviderParityAcknowledgedAt' in sanitized)
    ) {
      const currentAck = deps.getSettings().ollamaProviderParityAcknowledgedAt
      if (typeof currentAck === 'string' && currentAck.trim()) {
        sanitized.ollamaProviderParityAcknowledgedAt = currentAck.trim()
      } else {
        delete sanitized.ollamaToolControlTier
      }
    }
    if ('agenticServices' in sanitized) {
      const services = requireRecord(sanitized.agenticServices, 'Agentic services')
      const current = deps.getSettings().agenticServices
      sanitized.agenticServices = {
        shellCommands: sanitizeAgenticServicePolicy(services.shellCommands, current.shellCommands),
        fileChanges: sanitizeAgenticServicePolicy(services.fileChanges, current.fileChanges),
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
        crossThreadRead: sanitizeAgenticServicePolicy(
          services.crossThreadRead,
          current.crossThreadRead ?? 'ask'
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
        networkAccess: sanitizeAgenticNetworkPolicy(services.networkAccess, current.networkAccess)
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
    if ('modelUsagePanelView' in sanitized) {
      const value = sanitized.modelUsagePanelView
      if (value !== 'plan' && value !== 'spend' && value !== 'context') delete sanitized.modelUsagePanelView
    }
    if ('appIconVariant' in sanitized) {
      // Drop invalid ids, and refuse a NEW wwdc26 selection once the limited-time
      // window has closed. This gates the incoming patch (an OFFER surface) only —
      // an already-stored wwdc26 value is never touched, so it stays grandfathered.
      const value = sanitized.appIconVariant
      if (!isAppIconVariant(value)) {
        delete sanitized.appIconVariant
      } else if (value === 'wwdc26' && !isWwdc26IconAvailable(Date.now())) {
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
      sanitized.approvalTimeouts = {
        enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : current.enabled,
        perProviderMs: {
          gemini: sanitizeApprovalTimeoutMs(perProvider.gemini, current.perProviderMs.gemini),
          codex: sanitizeApprovalTimeoutMs(perProvider.codex, current.perProviderMs.codex),
          claude: sanitizeApprovalTimeoutMs(perProvider.claude, current.perProviderMs.claude),
          kimi: sanitizeApprovalTimeoutMs(perProvider.kimi, current.perProviderMs.kimi)
        },
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
    if ('localServersDetachSpawns' in sanitized) {
      const value = sanitized.localServersDetachSpawns
      sanitized.localServersDetachSpawns = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('localServersStopOnQuit' in sanitized) {
      const value = sanitized.localServersStopOnQuit
      sanitized.localServersStopOnQuit = typeof value === 'boolean' ? value : Boolean(value)
    }
    if ('messageBridgeEnabled' in sanitized) {
      const value = sanitized.messageBridgeEnabled
      sanitized.messageBridgeEnabled =
        typeof value === 'boolean' ? value : deps.getSettings().messageBridgeEnabled
    }
    if ('messageBridgePollIntervalMs' in sanitized) {
      const value = Number(sanitized.messageBridgePollIntervalMs)
      sanitized.messageBridgePollIntervalMs = Number.isFinite(value)
        ? Math.max(5_000, Math.trunc(value))
        : deps.getSettings().messageBridgePollIntervalMs
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
    return sanitized as Partial<AppSettings>
  }

  return {
    sanitizeScheduledTaskForSave,
    sanitizeScheduledTaskPatch,
    sanitizeWorkflowForSave,
    sanitizeWorkflowPatch,
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
