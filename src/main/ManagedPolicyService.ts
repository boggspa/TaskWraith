import type {
  AgenticServicesSettings,
  AppSettings,
  ProductUpdateChannel,
  CodexSandboxFallbackMode
} from './store/types'

export const MANAGED_POLICY_SETTING_KEYS = [
  'agenticServices',
  'agenticWorkspaceGrants',
  'approvalTimeouts',
  'autoUpdateEnabled',
  'codexSandboxFallback',
  'geminiMcpBridgeEnabled',
  'updateChannel',
  'userMcpServers'
] as const

export type ManagedPolicySettingKey = (typeof MANAGED_POLICY_SETTING_KEYS)[number]

type ManagedPolicySettings = Partial<
  Pick<
    AppSettings,
    | 'autoUpdateEnabled'
    | 'codexSandboxFallback'
    | 'geminiMcpBridgeEnabled'
    | 'updateChannel'
    | 'userMcpServers'
    | 'agenticWorkspaceGrants'
  >
> & {
  agenticServices?: Partial<AgenticServicesSettings>
  approvalTimeouts?: {
    enabled?: boolean
    perProviderMs?: Partial<AppSettings['approvalTimeouts']['perProviderMs']>
    mainAuthorityMs?: number
  }
}

export interface ManagedPolicyDocument {
  schemaVersion?: 1
  organizationName?: string
  lockedSettings?: ManagedPolicySettingKey[]
  settings?: ManagedPolicySettings
}

export interface ManagedPolicySnapshot {
  active: boolean
  source: 'none' | 'env-json' | 'env-path'
  organizationName?: string
  lockedSettings: ManagedPolicySettingKey[]
  enforcedSettings: ManagedPolicySettingKey[]
  errors: string[]
}

export interface ManagedPolicyLoadDeps {
  env?: NodeJS.ProcessEnv
  readFileSync?: (path: string, encoding: 'utf8') => string
}

const settingKeySet = new Set<string>(MANAGED_POLICY_SETTING_KEYS)
const updateChannels = new Set<ProductUpdateChannel>(['debug', 'stable', 'nightly'])
const sandboxFallbacks = new Set<CodexSandboxFallbackMode>(['ask_rerun', 'off'])
const servicePolicies = new Set(['ask', 'workspace', 'allow', 'deny'])
const networkPolicies = new Set(['allow', 'deny'])
const agenticServiceKeys = [
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'canvasEval',
  'crossThreadRead',
  'mediaEditing',
  'mediaRecording',
  'networkAccess'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sanitizePositiveMs(value: unknown): number | undefined {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1_000, Math.min(10 * 60 * 1000, Math.round(numeric)))
}

function sanitizeAgenticServices(value: unknown): Partial<AgenticServicesSettings> | undefined {
  if (!isRecord(value)) return undefined
  const services: Partial<AgenticServicesSettings> = {}
  for (const key of agenticServiceKeys) {
    const raw = value[key]
    if (key === 'networkAccess') {
      if (networkPolicies.has(String(raw))) {
        services.networkAccess = raw as AgenticServicesSettings['networkAccess']
      }
    } else if (servicePolicies.has(String(raw))) {
      services[key] = raw as NonNullable<AgenticServicesSettings[typeof key]>
    }
  }
  return Object.keys(services).length > 0 ? services : undefined
}

function sanitizeApprovalTimeouts(value: unknown): ManagedPolicySettings['approvalTimeouts'] {
  if (!isRecord(value)) return undefined
  const perProvider = isRecord(value.perProviderMs) ? value.perProviderMs : {}
  const perProviderMs: Partial<AppSettings['approvalTimeouts']['perProviderMs']> = {}
  for (const provider of ['gemini', 'codex', 'claude', 'kimi'] as const) {
    const sanitized = sanitizePositiveMs(perProvider[provider])
    if (sanitized !== undefined) perProviderMs[provider] = sanitized
  }
  const mainAuthorityMs = sanitizePositiveMs(value.mainAuthorityMs)
  const output: ManagedPolicySettings['approvalTimeouts'] = {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Object.keys(perProviderMs).length > 0 ? { perProviderMs } : {}),
    ...(mainAuthorityMs !== undefined ? { mainAuthorityMs } : {})
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function sanitizeManagedSettings(value: unknown): ManagedPolicySettings {
  if (!isRecord(value)) return {}
  const settings: ManagedPolicySettings = {}
  if (typeof value.autoUpdateEnabled === 'boolean') {
    settings.autoUpdateEnabled = value.autoUpdateEnabled
  }
  if (updateChannels.has(String(value.updateChannel))) {
    settings.updateChannel = value.updateChannel as ProductUpdateChannel
  }
  if (typeof value.geminiMcpBridgeEnabled === 'boolean') {
    settings.geminiMcpBridgeEnabled = value.geminiMcpBridgeEnabled
  }
  if (sandboxFallbacks.has(String(value.codexSandboxFallback))) {
    settings.codexSandboxFallback = value.codexSandboxFallback as CodexSandboxFallbackMode
  }
  const agenticServices = sanitizeAgenticServices(value.agenticServices)
  if (agenticServices) settings.agenticServices = agenticServices
  const approvalTimeouts = sanitizeApprovalTimeouts(value.approvalTimeouts)
  if (approvalTimeouts) settings.approvalTimeouts = approvalTimeouts
  if (Array.isArray(value.userMcpServers)) {
    // First managed-policy slice only supports disabling local user MCP servers.
    settings.userMcpServers = []
  }
  if (Array.isArray(value.agenticWorkspaceGrants)) {
    // Managed installs should not inherit user/workspace grants unless a later
    // signed policy format explicitly models them.
    settings.agenticWorkspaceGrants = []
  }
  return settings
}

function sanitizeLockedSettings(value: unknown): ManagedPolicySettingKey[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((entry): entry is ManagedPolicySettingKey => settingKeySet.has(String(entry)))
        .map((entry) => entry as ManagedPolicySettingKey)
    )
  )
}

export function parseManagedPolicyDocument(raw: unknown): ManagedPolicyDocument {
  if (!isRecord(raw)) return {}
  const settings = sanitizeManagedSettings(raw.settings)
  const document: ManagedPolicyDocument = {
    ...(raw.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
    ...(typeof raw.organizationName === 'string' && raw.organizationName.trim()
      ? { organizationName: raw.organizationName.trim().slice(0, 120) }
      : {}),
    lockedSettings: sanitizeLockedSettings(raw.lockedSettings),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
  return document
}

function settingKeysFromSettings(settings: ManagedPolicySettings | undefined): ManagedPolicySettingKey[] {
  if (!settings) return []
  return Object.keys(settings).filter((key): key is ManagedPolicySettingKey =>
    settingKeySet.has(key)
  )
}

export class ManagedPolicyService {
  constructor(
    private readonly source: ManagedPolicySnapshot['source'] = 'none',
    private readonly document: ManagedPolicyDocument = {},
    private readonly errors: string[] = []
  ) {}

  static none(): ManagedPolicyService {
    return new ManagedPolicyService('none')
  }

  snapshot(): ManagedPolicySnapshot {
    const enforcedSettings = settingKeysFromSettings(this.document.settings)
    const lockedSettings = Array.from(
      new Set([...(this.document.lockedSettings || []), ...enforcedSettings])
    )
    return {
      active: this.source !== 'none' && (lockedSettings.length > 0 || this.errors.length > 0),
      source: this.source,
      ...(this.document.organizationName ? { organizationName: this.document.organizationName } : {}),
      lockedSettings,
      enforcedSettings,
      errors: [...this.errors]
    }
  }

  filterSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
    const locked = new Set(this.snapshot().lockedSettings)
    if (locked.size === 0) return patch
    const filtered: Partial<AppSettings> = { ...patch }
    for (const key of locked) {
      delete filtered[key]
    }
    return filtered
  }

  enforcedSettingsPatch(settings: AppSettings): Partial<AppSettings> {
    const policy = this.document.settings
    if (!policy) return {}
    const patch: Partial<AppSettings> = {}
    if (
      policy.autoUpdateEnabled !== undefined &&
      policy.autoUpdateEnabled !== settings.autoUpdateEnabled
    ) {
      patch.autoUpdateEnabled = policy.autoUpdateEnabled
    }
    if (policy.updateChannel && policy.updateChannel !== settings.updateChannel) {
      patch.updateChannel = policy.updateChannel
    }
    if (
      policy.geminiMcpBridgeEnabled !== undefined &&
      policy.geminiMcpBridgeEnabled !== settings.geminiMcpBridgeEnabled
    ) {
      patch.geminiMcpBridgeEnabled = policy.geminiMcpBridgeEnabled
    }
    if (
      policy.codexSandboxFallback &&
      policy.codexSandboxFallback !== settings.codexSandboxFallback
    ) {
      patch.codexSandboxFallback = policy.codexSandboxFallback
    }
    if (policy.agenticServices) {
      const nextServices = { ...settings.agenticServices, ...policy.agenticServices }
      if (!jsonEqual(nextServices, settings.agenticServices)) patch.agenticServices = nextServices
    }
    if (policy.approvalTimeouts) {
      const nextTimeouts = {
        ...settings.approvalTimeouts,
        ...(policy.approvalTimeouts.enabled !== undefined
          ? { enabled: policy.approvalTimeouts.enabled }
          : {}),
        perProviderMs: {
          ...settings.approvalTimeouts.perProviderMs,
          ...(policy.approvalTimeouts.perProviderMs || {})
        },
        ...(policy.approvalTimeouts.mainAuthorityMs !== undefined
          ? { mainAuthorityMs: policy.approvalTimeouts.mainAuthorityMs }
          : {})
      }
      if (!jsonEqual(nextTimeouts, settings.approvalTimeouts)) patch.approvalTimeouts = nextTimeouts
    }
    if (policy.userMcpServers && !jsonEqual(policy.userMcpServers, settings.userMcpServers || [])) {
      patch.userMcpServers = policy.userMcpServers
    }
    if (
      policy.agenticWorkspaceGrants &&
      !jsonEqual(policy.agenticWorkspaceGrants, settings.agenticWorkspaceGrants || [])
    ) {
      patch.agenticWorkspaceGrants = policy.agenticWorkspaceGrants
    }
    return patch
  }

  effectiveSettings(settings: AppSettings): AppSettings {
    const patch = this.enforcedSettingsPatch(settings)
    return Object.keys(patch).length === 0 ? settings : ({ ...settings, ...patch } as AppSettings)
  }
}

export function loadManagedPolicyFromEnvironment(
  deps: ManagedPolicyLoadDeps = {}
): ManagedPolicyService {
  const env = deps.env || process.env
  const readFileSync = deps.readFileSync
  const rawJson = env.TASKWRAITH_MANAGED_POLICY_JSON
  const policyPath = env.TASKWRAITH_MANAGED_POLICY_PATH
  if (rawJson && rawJson.trim()) {
    try {
      return new ManagedPolicyService('env-json', parseManagedPolicyDocument(JSON.parse(rawJson)))
    } catch (error) {
      return new ManagedPolicyService('env-json', {}, [
        error instanceof Error ? error.message : String(error)
      ])
    }
  }
  if (policyPath && policyPath.trim() && readFileSync) {
    try {
      return new ManagedPolicyService(
        'env-path',
        parseManagedPolicyDocument(JSON.parse(readFileSync(policyPath.trim(), 'utf8')))
      )
    } catch (error) {
      return new ManagedPolicyService('env-path', {}, [
        error instanceof Error ? error.message : String(error)
      ])
    }
  }
  return ManagedPolicyService.none()
}
