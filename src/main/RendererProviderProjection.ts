import type {
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  ProviderApiKeyStatus,
  ProviderCapabilityContract,
  ProviderToolingCapability
} from './store/types'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function safeText(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxChars) : undefined
}

function optionalBoolean(
  output: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (typeof source[key] === 'boolean') output[key] = source[key]
}

function safeOllamaModels(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 500).map((candidate) => {
    const model = record(candidate)
    const output: Record<string, unknown> = {}
    for (const key of ['id', 'name', 'model', 'label', 'modifiedAt', 'modified_at', 'digest']) {
      const text = safeText(model[key], 500)
      if (text) output[key] = text
    }
    if (typeof model.size === 'number' && Number.isFinite(model.size)) output.size = model.size
    const details = record(model.details)
    const safeDetails: Record<string, unknown> = {}
    for (const key of ['format', 'family', 'parameter_size', 'quantization_level']) {
      const text = safeText(details[key], 160)
      if (text) safeDetails[key] = text
    }
    if (Object.keys(safeDetails).length > 0) output.details = safeDetails
    return output
  })
}

/** Minimal status required by secondary composers; account, quota, path, and error payloads stay main-only. */
export function rendererSafeProviderStatus(status: unknown): Record<string, unknown> {
  const source = record(status)
  const output: Record<string, unknown> = {}
  for (const key of ['provider', 'label', 'version', 'appServer', 'authState']) {
    const text = safeText(source[key])
    if (text) output[key] = text
  }
  for (const key of [
    'available',
    'setupRequired',
    'apiKeyConfigured',
    'configured',
    'authenticated',
    'requiresOpenaiAuth',
    'supportsSessions',
    'supportsApprovals',
    'supportsQuota',
    'supportsMcpStatus'
  ]) {
    optionalBoolean(output, source, key)
  }
  if (typeof source.modelCount === 'number' && Number.isFinite(source.modelCount)) {
    output.modelCount = Math.max(0, Math.trunc(source.modelCount))
  }
  const models = safeOllamaModels(source.models)
  if (models) output.models = models
  return output
}

export function rendererSafeProviderMcpStatus(status: unknown): unknown {
  if (status == null) return null
  const source = record(status)
  const output: Record<string, unknown> = {}
  for (const key of ['provider', 'status', 'state', 'source', 'serverName']) {
    const text = safeText(source[key])
    if (text) output[key] = text
  }
  for (const key of ['available', 'enabled', 'installed', 'providerManaged']) {
    optionalBoolean(output, source, key)
  }
  const servers = Array.isArray(source.data)
    ? source.data
    : Array.isArray(source.servers)
      ? source.servers
      : []
  if (servers.length > 0) {
    output.serverCount = servers.length
    output.toolCount = servers.reduce((total, candidate) => {
      const server = record(candidate)
      return total + (Array.isArray(server.tools) ? server.tools.length : 0)
    }, 0)
  }
  if (typeof source.toolCount === 'number' && Number.isFinite(source.toolCount)) {
    output.toolCount = Math.max(0, Math.trunc(source.toolCount))
  }
  return output
}

function safeToolingCapability(
  capability: ProviderToolingCapability
): ProviderToolingCapability {
  return {
    id: capability.id,
    label: capability.label,
    state: capability.state,
    source: capability.source,
    ...(capability.enforcedByTaskWraith !== undefined
      ? { enforcedByTaskWraith: capability.enforcedByTaskWraith }
      : {}),
    ...(capability.enforcement ? { enforcement: capability.enforcement } : {}),
    ...(capability.policy ? { policy: capability.policy } : {}),
    requiresApproval: capability.requiresApproval,
    tools: []
  }
}

export function rendererSafeProviderCapabilityContract(
  contract: ProviderCapabilityContract
): ProviderCapabilityContract {
  return {
    provider: contract.provider,
    label: contract.label,
    refreshedAt: contract.refreshedAt,
    availability: {
      available: contract.availability.available,
      ...(contract.availability.setupRequired !== undefined
        ? { setupRequired: contract.availability.setupRequired }
        : {}),
      ...(contract.availability.version ? { version: contract.availability.version } : {}),
      ...(contract.availability.authState
        ? { authState: contract.availability.authState }
        : {}),
      ...(contract.availability.appServer
        ? { appServer: contract.availability.appServer }
        : {})
    },
    tools: Object.fromEntries(
      Object.entries(contract.tools).map(([id, capability]) => [
        id,
        safeToolingCapability(capability)
      ])
    ) as ProviderCapabilityContract['tools'],
    approvals: {
      requestedMode: contract.approvals.requestedMode,
      effectiveMode: contract.approvals.effectiveMode,
      providerMode: contract.approvals.providerMode,
      inAppApprovals: contract.approvals.inAppApprovals,
      supportsWorkspaceGrants: contract.approvals.supportsWorkspaceGrants,
      notes: []
    },
    mcp: {
      state: contract.mcp.state,
      source: contract.mcp.source,
      available: contract.mcp.available,
      ...(contract.mcp.enabled !== undefined ? { enabled: contract.mcp.enabled } : {}),
      ...(contract.mcp.installed !== undefined ? { installed: contract.mcp.installed } : {}),
      ...(contract.mcp.serverName ? { serverName: contract.mcp.serverName } : {}),
      tools: []
    },
    warnings: contract.warnings.map((warning) => ({
      id: warning.id,
      severity: warning.severity,
      title: warning.title,
      message: 'Open the main window for provider diagnostic details.'
    }))
  }
}

export function rendererSafeProviderApiKeyStatus(
  status: ProviderApiKeyStatus
): ProviderApiKeyStatus {
  return {
    available: status.available,
    authState: status.authState,
    apiKeyConfigured: status.apiKeyConfigured,
    encryptionAvailable: status.encryptionAvailable,
    ...(status.version ? { version: status.version } : {})
  }
}

export function rendererSafeGeminiAuthProfile(
  profile: GeminiAuthProfileSummary
): GeminiAuthProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    kind: profile.kind,
    configured: profile.configured,
    isDefault: profile.isDefault,
    authState: profile.authState,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.lastUsedAt ? { lastUsedAt: profile.lastUsedAt } : {}),
    ...(profile.oauthConfigured !== undefined
      ? { oauthConfigured: profile.oauthConfigured }
      : {})
  }
}

export function rendererSafeGeminiAuthStatus(status: GeminiAuthStatus): GeminiAuthStatus {
  return {
    ...rendererSafeProviderApiKeyStatus(status),
    ...(status.activeProfileId ? { activeProfileId: status.activeProfileId } : {}),
    ...(status.activeProfileLabel ? { activeProfileLabel: status.activeProfileLabel } : {}),
    profiles: status.profiles.map(rendererSafeGeminiAuthProfile)
  }
}
