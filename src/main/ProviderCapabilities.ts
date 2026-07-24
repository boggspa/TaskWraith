import type {
  AgenticNetworkPolicy,
  AgenticServicePolicy,
  AgenticServicesSettings,
  AppSettings,
  GeminiMcpBridgeStatus,
  ProviderCapabilityContract,
  ProviderApprovalCapability,
  ProviderCapabilityState,
  ProviderCapabilityWarning,
  ProviderId,
  ProviderMcpCapability,
  ProviderToolingCapability,
  ProviderToolingCapabilityId
} from './store/types'
import { TASKWRAITH_MCP_TOOLS } from './TaskWraithMcpTools'
import { GATEWAY_MCP_ADVERTISE_TOOLS } from './mcp/McpToolProfiles'
import { providerLabel } from './ProviderAdapters'
import { buildUserMcpLaunchServers } from './UserMcpServers'

export const TASKWRAITH_GEMINI_MCP_TOOLS = TASKWRAITH_MCP_TOOLS

const TOOLING_LABELS: Record<ProviderToolingCapabilityId, string> = {
  shellCommands: 'Shell commands',
  fileChanges: 'File changes',
  externalPublish: 'External publishing',
  mcpTools: 'MCP and tool calls',
  creativeApps: 'Creative app tools',
  networkAccess: 'Network access',
  elicit: 'Ask the user',
  delegate: 'Delegate to sub-thread'
}

/** The original five "functional control" rows whose TaskWraith-enforcement is
 * tallied across the renderer (ToolingContractCard `enforcedCount`,
 * SettingsPanel contract hint) and main (ProviderPreflightService delegated
 * chip, DelegationAudit policy label). The `elicit` / `delegate` rows are
 * DISPLAY-only additions and are intentionally excluded from these tallies so
 * promoting `subThreadDelegation` to a first-class row does not double-count
 * against its existing settings gate or inflate the enforced/delegated counts.
 * Consumers that tally enforcement MUST iterate this list rather than
 * `Object.values(contract.tools)`. */
export const TOOLING_CONTROL_IDS = [
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'creativeApps',
  'networkAccess'
] as const satisfies readonly ProviderToolingCapabilityId[]

export type ToolingControlId = (typeof TOOLING_CONTROL_IDS)[number]

/** The five functional-control rows of a contract, in canonical order. Tally
 * sites (enforced/delegated counts) MUST use this rather than
 * `Object.values(contract.tools)` so the DISPLAY-only `elicit` / `delegate`
 * rows never shift the enforced/delegated numerator or denominator. */
export function toolingControlRows(
  tools: Record<ProviderToolingCapabilityId, ProviderToolingCapability>
): ProviderToolingCapability[] {
  return TOOLING_CONTROL_IDS.map((id) => tools[id])
}

interface BuildProviderCapabilityContractInput {
  provider: ProviderId
  settings: Pick<
    AppSettings,
    'agenticServices' | 'geminiMcpBridgeEnabled' | 'codexSandboxFallback' | 'userMcpServers'
  >
  workspacePath?: string
  approvalMode?: string
  status?: unknown
  mcpStatus?: unknown
  geminiMcpBridgeStatus?: GeminiMcpBridgeStatus | null
  refreshedAt?: string
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {}
}

function serviceState(policy?: AgenticServicePolicy): ProviderCapabilityState {
  if (policy === 'deny') return 'blocked'
  if (policy === 'allow') return 'available'
  return 'gated'
}

function networkState(policy?: AgenticNetworkPolicy): ProviderCapabilityState {
  return policy === 'deny' ? 'blocked' : 'available'
}

function serviceRequiresApproval(policy?: AgenticServicePolicy): boolean {
  return policy === 'ask' || policy === 'workspace' || !policy
}

function serviceCapability(
  id: ProviderToolingCapabilityId,
  policy: AgenticServicePolicy | undefined,
  source: ProviderToolingCapability['source'],
  tools: string[],
  details?: string
): ProviderToolingCapability {
  return {
    id,
    label: TOOLING_LABELS[id],
    state: serviceState(policy),
    source,
    enforcedByTaskWraith: source === 'taskwraith' || source === 'bridge' || source === 'settings',
    enforcement: source,
    policy,
    requiresApproval: serviceRequiresApproval(policy),
    tools,
    details
  }
}

function unavailableCapability(
  id: ProviderToolingCapabilityId,
  source: ProviderToolingCapability['source'],
  details: string
): ProviderToolingCapability {
  return {
    id,
    label: TOOLING_LABELS[id],
    state: 'unavailable',
    source,
    enforcedByTaskWraith: false,
    enforcement: 'none',
    requiresApproval: false,
    tools: [],
    details
  }
}

function delegatedCapability(
  id: ProviderToolingCapabilityId,
  policy: AgenticServicePolicy | undefined,
  tools: string[],
  details: string
): ProviderToolingCapability {
  return {
    id,
    label: TOOLING_LABELS[id],
    state: policy === 'deny' ? 'blocked' : 'delegated',
    source: policy === 'deny' ? 'settings' : 'provider',
    enforcedByTaskWraith: false,
    enforcement: policy === 'deny' ? 'best_effort' : 'provider',
    policy,
    requiresApproval: policy !== 'allow' && policy !== 'deny',
    tools,
    details
  }
}

/** `ask_user_question` (the `ui_elicitation` tool class) lets a participant
 * ask the user a clarifying question mid-run. It is a universally
 * auto-allowed TaskWraith MCP tool (see TaskWraithMcpTools `ask_user_question`),
 * so it carries no service-policy gate — it is reachable whenever the TaskWraith
 * MCP bridge is advertised to the provider, and provider-managed otherwise.
 * DISPLAY-only row: excluded from the enforced/delegated tallies. */
function elicitCapability(
  source: ProviderToolingCapability['source'],
  mcpAvailable: boolean,
  details: string,
  unavailableDetails?: string
): ProviderToolingCapability {
  const bridgeBacked = source === 'bridge' || source === 'taskwraith'
  if (bridgeBacked && !mcpAvailable) {
    return unavailableCapability('elicit', source, unavailableDetails || details)
  }
  return {
    id: 'elicit',
    label: TOOLING_LABELS.elicit,
    state: bridgeBacked ? 'available' : 'delegated',
    source,
    enforcedByTaskWraith: bridgeBacked,
    enforcement: bridgeBacked ? source : 'provider',
    requiresApproval: false,
    tools: ['ask_user_question'],
    details
  }
}

/** `delegate_to_subthread` (`subThreadDelegation`) lets a participant spawn a
 * cross-provider sub-thread. It IS gated by the existing
 * `agenticServices.subThreadDelegation` settings policy (see the
 * SettingsPanel tool→service map). Promoting it to a first-class row must NOT
 * change that gate or the enforcement tallies, so this is a DISPLAY-only row
 * excluded from `TOOLING_CONTROL_IDS`; the gate semantics stay in
 * PermissionService / EffectiveRunPermissions exactly as before. Its state is
 * derived from the same `subThreadDelegation` policy the gate already reads. */
function delegateCapability(
  source: ProviderToolingCapability['source'],
  policy: AgenticServicePolicy | undefined,
  mcpAvailable: boolean,
  details: string,
  unavailableDetails?: string
): ProviderToolingCapability {
  const bridgeBacked = source === 'bridge' || source === 'taskwraith'
  if (bridgeBacked && !mcpAvailable) {
    return unavailableCapability('delegate', source, unavailableDetails || details)
  }
  if (!bridgeBacked) {
    return {
      id: 'delegate',
      label: TOOLING_LABELS.delegate,
      state: policy === 'deny' ? 'blocked' : 'delegated',
      source,
      enforcedByTaskWraith: false,
      enforcement: policy === 'deny' ? 'best_effort' : 'provider',
      policy,
      requiresApproval: policy !== 'allow' && policy !== 'deny',
      tools: ['delegate_to_subthread'],
      details
    }
  }
  return {
    id: 'delegate',
    label: TOOLING_LABELS.delegate,
    state: serviceState(policy),
    source,
    enforcedByTaskWraith: true,
    enforcement: source,
    policy,
    requiresApproval: serviceRequiresApproval(policy),
    tools: ['delegate_to_subthread'],
    details
  }
}

function networkCapability(policy?: AgenticNetworkPolicy): ProviderToolingCapability {
  return {
    id: 'networkAccess',
    label: TOOLING_LABELS.networkAccess,
    state: networkState(policy),
    source: 'settings',
    enforcedByTaskWraith: false,
    enforcement: policy === 'deny' ? 'best_effort' : 'none',
    policy,
    requiresApproval: false,
    tools: [],
    details:
      policy === 'deny'
        ? 'TaskWraith settings request network blocking where provider transport supports it.'
        : 'Network access is allowed by TaskWraith settings.'
  }
}

function creativeAppsCapability(policy?: AgenticServicePolicy): ProviderToolingCapability {
  return {
    id: 'creativeApps',
    label: TOOLING_LABELS.creativeApps,
    state: serviceState(policy),
    source: 'bridge',
    enforcedByTaskWraith: true,
    enforcement: 'bridge',
    policy,
    requiresApproval: serviceRequiresApproval(policy),
    tools: [
      'creative_app_status',
      'creative_app_capabilities',
      'creative_project_snapshot',
      'creative_timeline_validate',
      'creative_timeline_ir',
      'creative_timeline_diff'
    ],
    details:
      'TaskWraith exposes read-only creative app discovery, snapshots, and validation; future apply/control tools will route through the same approval model.'
  }
}

function warning(
  id: string,
  severity: ProviderCapabilityWarning['severity'],
  title: string,
  message: string
): ProviderCapabilityWarning {
  return { id, severity, title, message }
}

function mcpToolNamesFromStatus(value: unknown): string[] {
  const record = asRecord(value)
  const servers = Array.isArray(record.data) ? record.data : []
  const names = new Set<string>()
  for (const server of servers) {
    const serverRecord = asRecord(server)
    const tools = serverRecord.tools
    if (tools && typeof tools === 'object') {
      Object.keys(tools).forEach((name) => names.add(name))
    }
  }
  return [...names].sort()
}

function codexMcpCapability(
  mcpStatus: unknown,
  enabled: boolean,
  userServerCount = 0
): ProviderMcpCapability {
  const record = asRecord(mcpStatus)
  const tools = mcpToolNamesFromStatus(mcpStatus)
  const serverCount = Array.isArray(record.data) ? record.data.length : 0
  if (!enabled) {
    if (userServerCount > 0) {
      return {
        state: 'available',
        source: 'provider',
        available: true,
        enabled: true,
        installed: true,
        serverName: 'User MCP servers',
        tools,
        message:
          serverCount > 0
            ? `${serverCount} Codex MCP server${serverCount === 1 ? '' : 's'} reported by app-server. The built-in TaskWraith MCP bridge is disabled.`
            : `${userServerCount} user-managed MCP server${userServerCount === 1 ? '' : 's'} will be registered for Codex when the app-server starts. Reopen Codex or restart the app-server after changing MCP servers. The built-in TaskWraith MCP bridge is disabled.`
      }
    }
    return {
      state: 'unavailable',
      source: 'provider',
      available: false,
      enabled: false,
      installed: false,
      serverName: 'TaskWraith',
      tools: [],
      message: 'TaskWraith MCP registration for Codex is disabled in Settings.'
    }
  }
  return {
    state: 'available',
    source: 'provider',
    available: true,
    enabled: true,
    installed: true,
    serverName: 'TaskWraith',
    tools: tools.length > 0 ? tools : [...GATEWAY_MCP_ADVERTISE_TOOLS],
    message:
      serverCount > 0
        ? `${serverCount} Codex MCP server${serverCount === 1 ? '' : 's'} reported by app-server.`
        : 'TaskWraith registers the MCP bridge for Codex runs; this app-server did not expose a live server listing.'
  }
}

function geminiMcpCapability(
  status: GeminiMcpBridgeStatus | null | undefined
): ProviderMcpCapability {
  const enabled = Boolean(status?.enabled)
  const installed = Boolean(status?.installed)
  const available = Boolean(status?.available)
  return {
    state: available ? 'available' : 'unavailable',
    source: 'bridge',
    available,
    enabled,
    installed,
    serverName: status?.serverName || 'TaskWraith',
    tools: available ? [...TASKWRAITH_GEMINI_MCP_TOOLS] : [],
    message:
      status?.message ||
      (enabled
        ? 'TaskWraith MCP bridge is not available for Gemini.'
        : 'TaskWraith MCP bridge is disabled.')
  }
}

function geminiMcpUnavailableTitle(status: GeminiMcpBridgeStatus | null | undefined): string {
  if (!status?.enabled) return 'TaskWraith MCP bridge disabled'
  if (!status.installed) return 'TaskWraith MCP bridge not installed'
  if (status.error) return 'TaskWraith MCP bridge status failed'
  return 'TaskWraith MCP bridge unavailable'
}

/** Provider-managed MCP fallback: the provider resolves its own tools (no
 * structured TaskWraith MCP surface to report), and TaskWraith does not inject
 * host tools here. Factual/calm copy — NOT an error. Used for any provider
 * without a dedicated capability builder; cursor/grok have their own below. */
function providerManagedMcpCapability(provider: ProviderId): ProviderMcpCapability {
  return {
    state: 'delegated',
    source: 'provider-managed',
    available: false,
    installed: false,
    tools: [],
    message: `${providerLabel(provider)} MCP is provider-managed. TaskWraith host tools aren't injected into this provider.`
  }
}

function ollamaLocalMcpCapability(input: {
  enabled: boolean
  blocked: boolean
  hasWorkspace: boolean
  tools: string[]
  tierLabel: string
}): ProviderMcpCapability {
  if (input.blocked) {
    return {
      state: 'blocked',
      source: 'taskwraith',
      available: false,
      enabled: false,
      installed: true,
      serverName: 'TaskWraith-local',
      tools: [],
      message:
        'Ollama workspace tools are blocked by TaskWraith MCP/tool settings.'
    }
  }
  if (!input.hasWorkspace) {
    return {
      state: 'unavailable',
      source: 'taskwraith',
      available: false,
      enabled: input.enabled,
      installed: true,
      serverName: 'TaskWraith-local',
      tools: [],
      message:
        'Ollama tools require a workspace thread so paths can be scoped by TaskWraith.'
    }
  }
  return {
    state: input.enabled ? 'available' : 'unavailable',
    source: 'taskwraith',
    available: input.enabled,
    enabled: input.enabled,
    installed: true,
    serverName: 'TaskWraith-local',
    tools: input.enabled ? input.tools : [],
    message: input.enabled
      ? `Ollama uses a TaskWraith-controlled local tool loop with ${input.tierLabel} tools.`
      : 'Ollama local tools are not enabled.'
  }
}

function bridgeRequiredForWriteMode(approvalMode: string | null | undefined): boolean {
  return typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
}

/** Grok ACP runs can receive the shared TaskWraith MCP bridge directly in
 * session/new. Write-capable seats get the full governed tool list; read-only
 * seats stay safe-subset unless explicitly advertised. */
function grokMcpCapability(input: {
  enabledBySetting: boolean
  requiredForRun: boolean
}): ProviderMcpCapability {
  const enabled = input.requiredForRun
  return {
    state: enabled ? 'available' : 'unavailable',
    source: 'bridge',
    available: enabled,
    enabled,
    installed: enabled,
    serverName: 'TaskWraith',
    tools: enabled ? [...GATEWAY_MCP_ADVERTISE_TOOLS] : [],
    message:
      input.requiredForRun
        ? 'TaskWraith will advertise a brokered MCP server through Grok ACP for this write-capable run. Mutating MCP tools are executed by TaskWraith after approval and workspace/path checks; no manual Grok MCP install is required.'
        : input.enabledBySetting
          ? 'TaskWraith MCP bridge preference is on, but read-only Grok safe-subset advertising remains behind the separate Grok read-only gate. Write-capable Grok ACP runs auto-inject the scoped bridge when needed.'
          : 'TaskWraith MCP registration for Grok is off for this read-only run; write-capable Grok ACP runs auto-inject the scoped bridge when needed.'
  }
}

function cliTaskWraithMcpCapability(
  provider: ProviderId,
  mcpStatus: unknown
): ProviderMcpCapability {
  const record = asRecord(mcpStatus)
  const enabled = Boolean(record.enabled)
  const available = Boolean(record.available)
  const source =
    record.source === 'provider' || record.source === 'provider-managed' ? 'provider' : 'bridge'
  const tools = Array.isArray(record.tools)
    ? record.tools.map((tool) => String(tool || '')).filter(Boolean)
    : []
  return {
    state: available ? 'available' : enabled ? 'gated' : 'unavailable',
    source,
    available,
    enabled,
    installed: available,
    serverName:
      typeof record.serverName === 'string'
        ? record.serverName
        : source === 'provider'
          ? 'User MCP servers'
          : 'TaskWraith',
    tools: available ? tools : [],
    message:
      typeof record.message === 'string'
        ? record.message
        : available
          ? source === 'provider'
            ? `${providerLabel(provider)} launches user-managed MCP servers through provider MCP configuration.`
            : `TaskWraith registers the TaskWraith MCP bridge for ${providerLabel(provider)} runs.`
          : `TaskWraith MCP bridge is not available for ${providerLabel(provider)}.`
  }
}

function approvalContract(
  provider: ProviderId,
  requestedMode: string,
  effectiveMode: string
): ProviderApprovalCapability {
  if (provider === 'cursor') {
    return {
      requestedMode,
      effectiveMode,
      providerMode: 'native Cursor tools bounded by the OS sandbox',
      inAppApprovals: false,
      supportsWorkspaceGrants: true,
      notes: [
        'Cursor runs its native tools contained by the native OS sandbox (--sandbox enabled) plus a read-only mode for read seats. Native per-tool calls are not individually mediated; the sandbox is an honest partial backstop (it blocks $HOME-root sensitive dirs for a normal project workspace, but not a workspace placed directly under $HOME). Brokered TaskWraith MCP tools route through TaskWraith approvals, where workspace Tool Grants apply.'
      ]
    }
  }
  if (provider === 'ollama') {
    // Ollama receives the same compact gateway profile as remote providers;
    // canonical targets still use the standard permission role and approvals.
    return {
      requestedMode,
      effectiveMode,
      providerMode: 'local TaskWraith-controlled gateway tool surface',
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: [
        'Ollama runs through TaskWraith local HTTP with the compact gateway surface and on-demand access to hidden first-party capabilities. Canonical targets retain TaskWraith intent checks, the run permission role, approval policy, and audit events.'
      ]
    }
  }
  if (provider === 'codex') {
    return {
      requestedMode,
      effectiveMode,
      providerMode:
        requestedMode === 'plan'
          ? 'read-only / never'
          : requestedMode === 'auto_edit'
            ? 'workspace-write / gated by settings'
            : 'workspace-write / on-request',
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: ['Codex app-server permission requests are routed through TaskWraith approval cards.']
    }
  }
  if (provider === 'gemini') {
    return {
      requestedMode,
      effectiveMode,
      providerMode: effectiveMode,
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: [
        'TaskWraith-managed Gemini MCP tools use TaskWraith approval cards when the bridge is available.'
      ]
    }
  }
  if (provider === 'kimi') {
    return {
      requestedMode,
      effectiveMode,
      providerMode:
        requestedMode === 'plan'
          ? 'ACP read-only with authenticated TaskWraith gateway'
          : 'ACP governed authenticated TaskWraith gateway',
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: [
        'Managed Kimi turns deny native filesystem, shell, egress, and fan-out tools. Workspace actions use the authenticated per-run TaskWraith HTTP MCP gateway and its approval/workspace-grant policy.'
      ]
    }
  }
  if (provider === 'antigravity') {
    return {
      requestedMode,
      effectiveMode,
      providerMode:
        requestedMode === 'plan'
          ? 'official agy print mode with --sandbox --mode plan'
          : 'official agy print mode with --sandbox --mode accept-edits',
      inAppApprovals: false,
      supportsWorkspaceGrants: false,
      notes: [
        'TaskWraith gates AntiGravity run admission and owns cancellation/audit lifecycle. The official agy CLI has no supported per-tool approval bridge in this transport; no credential access or permission-bypass flag is used.'
      ]
    }
  }
  return {
    requestedMode,
    effectiveMode,
    providerMode:
      requestedMode === 'plan' ? 'plan' : requestedMode === 'auto_edit' ? 'acceptEdits' : 'default',
    inAppApprovals: false,
    supportsWorkspaceGrants: false,
    notes: ['Claude Code permission handling is provider-managed in this build.']
  }
}

function effectiveGeminiMode(requestedMode: string, services: AgenticServicesSettings): string {
  if (requestedMode === 'plan') return requestedMode
  if (services.shellCommands === 'deny' || services.fileChanges === 'deny') return 'plan'
  return requestedMode
}

export function buildProviderCapabilityContract({
  provider,
  settings,
  workspacePath,
  approvalMode = 'default',
  status,
  mcpStatus,
  geminiMcpBridgeStatus,
  refreshedAt = new Date().toISOString()
}: BuildProviderCapabilityContractInput): ProviderCapabilityContract {
  const services = settings.agenticServices
  const warnings: ProviderCapabilityWarning[] = []
  const label = providerLabel(provider)
  const requestedMode = approvalMode || 'default'
  // Cursor is always available: there is no per-build fingerprint gate (it was
  // brittle — provider auto-updates broke the exact-SHA match). Containment lives
  // on the run itself (runCursorProvider's contained --sandbox argv), not in an
  // availability gate.
  const cursorSecurityUnavailable = false
  const effectiveMode =
    provider === 'gemini'
      ? effectiveGeminiMode(requestedMode, services)
      : cursorSecurityUnavailable
        ? 'unavailable'
        : requestedMode
  const statusRecord = asRecord(status)
  const cursorSecurityUnavailableMessage =
    'Cursor managed runs are disabled until an exact-build containment canary covers provider-managed account/team hooks, skills, plugins, and MCP startup sources.'
  const setupRequired = Boolean(statusRecord.setupRequired) || cursorSecurityUnavailable
  const explicitlyUnavailable = statusRecord.available === false || setupRequired

  const availability = {
    available: !explicitlyUnavailable,
    setupRequired,
    binaryPath: typeof statusRecord.binaryPath === 'string' ? statusRecord.binaryPath : null,
    binarySource:
      typeof statusRecord.binarySource === 'string' ? statusRecord.binarySource : undefined,
    version: typeof statusRecord.version === 'string' ? statusRecord.version : undefined,
    authState: typeof statusRecord.authState === 'string' ? statusRecord.authState : undefined,
    appServer: typeof statusRecord.appServer === 'string' ? statusRecord.appServer : undefined,
    error: cursorSecurityUnavailable
      ? cursorSecurityUnavailableMessage
      : typeof statusRecord.error === 'string'
        ? statusRecord.error
        : undefined
  }

  if (explicitlyUnavailable) {
    warnings.push(
      warning(
        `${provider}-unavailable`,
        'error',
        `${label} unavailable`,
        availability.error ||
          `${label} is not ready. Check the binary path and provider login state.`
      )
    )
  }

  let shellCommands: ProviderToolingCapability
  let fileChanges: ProviderToolingCapability
  let externalPublish: ProviderToolingCapability
  let mcpTools: ProviderToolingCapability
  let elicit: ProviderToolingCapability
  let delegate: ProviderToolingCapability
  let mcp: ProviderMcpCapability

  if (provider === 'gemini') {
    mcp = geminiMcpCapability(geminiMcpBridgeStatus)
    if (mcp.available) {
      shellCommands = serviceCapability(
        'shellCommands',
        services.shellCommands,
        'bridge',
        ['run_shell_command', 'get_diagnostics'],
        'Gemini uses the TaskWraith MCP bridge for host shell commands.'
      )
      fileChanges = serviceCapability(
        'fileChanges',
        services.fileChanges,
        'bridge',
        ['write_file', 'replace'],
        'Gemini uses the TaskWraith MCP bridge for workspace file writes and replacements.'
      )
      externalPublish = serviceCapability(
        'externalPublish',
        services.externalPublish,
        'bridge',
        ['git_push', 'git_create_pr'],
        'Gemini uses the TaskWraith MCP bridge for external publishing actions.'
      )
      mcpTools = serviceCapability(
        'mcpTools',
        services.mcpTools,
        'bridge',
        ['read_file', 'list_directory'],
        'Gemini uses the TaskWraith MCP bridge for workspace read/list tools.'
      )
      elicit = elicitCapability(
        'bridge',
        true,
        'Gemini can ask the user a clarifying question through the TaskWraith MCP bridge (auto-allowed).'
      )
      delegate = delegateCapability(
        'bridge',
        services.subThreadDelegation,
        true,
        'Gemini can spawn cross-provider sub-threads through the TaskWraith MCP bridge, gated by the sub-thread delegation setting.'
      )
    } else {
      shellCommands = unavailableCapability(
        'shellCommands',
        'bridge',
        'TaskWraith shell tools are not advertised to Gemini until the MCP bridge is enabled, installed, and available.'
      )
      fileChanges = unavailableCapability(
        'fileChanges',
        'bridge',
        'TaskWraith file editing tools are not advertised to Gemini until the MCP bridge is enabled, installed, and available.'
      )
      externalPublish = unavailableCapability(
        'externalPublish',
        'bridge',
        'TaskWraith external publishing tools are not advertised to Gemini until the MCP bridge is enabled, installed, and available.'
      )
      mcpTools = unavailableCapability(
        'mcpTools',
        'bridge',
        'TaskWraith MCP tools are not advertised to Gemini until the bridge is enabled, installed, and available.'
      )
      elicit = elicitCapability(
        'bridge',
        false,
        'Gemini cannot ask the user through TaskWraith until the MCP bridge is enabled, installed, and available.'
      )
      delegate = delegateCapability(
        'bridge',
        services.subThreadDelegation,
        false,
        'Gemini cannot delegate to sub-threads through TaskWraith until the MCP bridge is enabled, installed, and available.'
      )
      warnings.push(
        warning(
          mcp.enabled ? 'gemini-bridge-unavailable' : 'gemini-bridge-disabled',
          'warning',
          geminiMcpUnavailableTitle(geminiMcpBridgeStatus),
          mcp.message || 'Gemini will only have provider-native tools for this run.'
        )
      )
    }
    if (requestedMode !== effectiveMode) {
      warnings.push(
        warning(
          'gemini-approval-mode-downgraded',
          'warning',
          'Gemini approval mode adjusted',
          `Requested ${requestedMode}, but TaskWraith service settings block write-capable Gemini modes, so this run will use ${effectiveMode}.`
        )
      )
    }
  } else if (provider === 'codex') {
    const codexUserMcpServerCount = buildUserMcpLaunchServers(settings.userMcpServers, [
      'stdio',
      'http'
    ]).length
    mcp = codexMcpCapability(
      mcpStatus,
      Boolean(settings.geminiMcpBridgeEnabled),
      codexUserMcpServerCount
    )
    shellCommands = serviceCapability(
      'shellCommands',
      services.shellCommands,
      'taskwraith',
      ['run_shell_command', 'get_diagnostics'],
      'Codex command approvals are routed through TaskWraith.'
    )
    fileChanges = serviceCapability(
      'fileChanges',
      services.fileChanges,
      'taskwraith',
      ['edit_file', 'create_file', 'delete_file'],
      'Codex file approvals and diffs are routed through TaskWraith.'
    )
    externalPublish = serviceCapability(
      'externalPublish',
      services.externalPublish,
      'taskwraith',
      ['git_push', 'git_create_pr'],
      'Codex external publishing approvals are routed through TaskWraith.'
    )
    mcpTools = serviceCapability('mcpTools', services.mcpTools, 'provider', mcp.tools, mcp.message)
    elicit = elicitCapability(
      'taskwraith',
      true,
      'Codex can ask the user a clarifying question through the TaskWraith MCP tool surface (auto-allowed).'
    )
    delegate = delegateCapability(
      'taskwraith',
      services.subThreadDelegation,
      true,
      'Codex can spawn cross-provider sub-threads through TaskWraith, gated by the sub-thread delegation setting.'
    )
    if (settings.codexSandboxFallback === 'ask_rerun') {
      warnings.push(
        warning(
          'codex-sandbox-fallback',
          'info',
          'Codex sandbox fallback enabled',
          'Swift/Xcode-style sandbox collisions can be rerun once from the host process after explicit approval.'
        )
      )
    }
  } else if (provider === 'ollama') {
    // Ollama advertises the same compact gateway profile as remote providers;
    // hidden canonical tools remain reachable on demand through the gateway.
    const ollamaTierTools = [...GATEWAY_MCP_ADVERTISE_TOOLS]
    const ollamaFileTools = ollamaTierTools.filter((tool) =>
      [
        'write_file',
        'replace',
        'create_directory',
        'delete_path',
        'move_path',
        'rename_path',
        'apply_patch'
      ].includes(tool)
    )
    const ollamaShellTools = ollamaTierTools.filter((tool) =>
      ['run_shell_command', 'run_task', 'get_diagnostics'].includes(tool)
    )
    mcp = ollamaLocalMcpCapability({
      enabled: services.mcpTools !== 'deny',
      blocked: services.mcpTools === 'deny',
      hasWorkspace: Boolean(workspacePath),
      tools: ollamaTierTools,
      tierLabel: 'gateway tool surface'
    })
    shellCommands =
      mcp.available && ollamaShellTools.length > 0
        ? serviceCapability(
            'shellCommands',
            services.shellCommands,
            'taskwraith',
            ollamaShellTools,
            'Ollama shell commands are routed through TaskWraith approval policy (by the run permission role).'
          )
        : unavailableCapability(
            'shellCommands',
            'taskwraith',
            'Ollama local mode does not expose shell commands at this tier.'
          )
    fileChanges =
      mcp.available && ollamaFileTools.length > 0
        ? serviceCapability(
            'fileChanges',
            services.fileChanges,
            'taskwraith',
            ollamaFileTools,
            'Ollama file edits are routed through TaskWraith approval policy (by the run permission role).'
          )
        : unavailableCapability(
            'fileChanges',
            'taskwraith',
            'Ollama local mode does not expose file edits or patch tools at this tier.'
          )
    externalPublish = serviceCapability(
      'externalPublish',
      services.externalPublish,
      'taskwraith',
      ['git_push', 'git_create_pr'],
      'Ollama external publishing actions require a modal approval through TaskWraith.'
    )
    mcpTools = mcp.available
      ? serviceCapability(
          'mcpTools',
          services.mcpTools,
          'taskwraith',
          mcp.tools,
          mcp.message
        )
      : unavailableCapability(
          'mcpTools',
          'taskwraith',
          mcp.message || 'Ollama read-only tools are not available.'
        )
    elicit = elicitCapability(
      'taskwraith',
      mcp.available && mcp.tools.includes('ask_user_question'),
      'Ollama can ask the user clarifying questions through TaskWraith local tools without write or shell access.',
      'Ollama user-question tools require a workspace thread with TaskWraith local tools enabled.'
    )
    delegate = unavailableCapability(
      'delegate',
      'taskwraith',
      'Ollama local mode cannot spawn sub-threads.'
    )
  } else if (provider === 'antigravity') {
    mcp = {
      state: 'unavailable',
      source: 'unsupported',
      available: false,
      enabled: false,
      installed: false,
      tools: [],
      message:
        'AntiGravity S3 uses only the official agy print-mode transport; TaskWraith does not attach MCP servers, plugins, or hooks.'
    }
    shellCommands = delegatedCapability(
      'shellCommands',
      services.shellCommands,
      ['official_agy_sandbox'],
      'AntiGravity sandboxed native command behavior is provider-managed; TaskWraith does not claim per-tool interception for this CLI transport.'
    )
    fileChanges = delegatedCapability(
      'fileChanges',
      services.fileChanges,
      ['official_agy_accept_edits'],
      'AntiGravity file changes are available only in the explicitly write-capable, sandboxed official agy mode; TaskWraith does not claim per-tool interception.'
    )
    externalPublish = delegatedCapability(
      'externalPublish',
      services.externalPublish,
      ['official_agy_sandbox'],
      'AntiGravity publishing behavior remains provider-managed inside the official sandboxed CLI transport.'
    )
    mcpTools = unavailableCapability(
      'mcpTools',
      'provider',
      'No TaskWraith MCP bridge, plugin, or hook is attached to the AntiGravity print-mode transport.'
    )
    elicit = unavailableCapability(
      'elicit',
      'provider',
      'The AntiGravity print-mode transport does not expose a supported TaskWraith user-question bridge.'
    )
    delegate = unavailableCapability(
      'delegate',
      'provider',
      'The AntiGravity print-mode transport does not expose TaskWraith sub-thread delegation.'
    )
  } else {
    const bridgeRequired = bridgeRequiredForWriteMode(effectiveMode)
    mcp =
      provider === 'claude' || provider === 'kimi'
        ? cliTaskWraithMcpCapability(provider, mcpStatus)
        : provider === 'grok'
            ? grokMcpCapability({
                enabledBySetting: Boolean(settings.geminiMcpBridgeEnabled),
                requiredForRun: bridgeRequired
              })
            : providerManagedMcpCapability(provider)
    const taskWraithBridgeProvider =
      (provider === 'kimi' || provider === 'grok') && mcp.available
    const kimiGatewayUnavailable = provider === 'kimi' && !mcp.available
    shellCommands = taskWraithBridgeProvider
      ? serviceCapability(
          'shellCommands',
          services.shellCommands,
          'bridge',
          ['run_shell_command', 'get_diagnostics'],
          `${label} should use the TaskWraith MCP bridge for host shell commands.`
        )
      : kimiGatewayUnavailable
        ? unavailableCapability(
            'shellCommands',
            'bridge',
            `${label} managed runs fail closed until the mandatory authenticated per-run TaskWraith gateway is available.`
          )
        : delegatedCapability(
            'shellCommands',
            services.shellCommands,
            provider === 'claude' ? ['provider_shell'] : ['provider_shell_or_native_tool'],
            `${label} shell command handling is delegated to the provider CLI.`
          )
    fileChanges = taskWraithBridgeProvider
      ? serviceCapability(
          'fileChanges',
          services.fileChanges,
          'bridge',
          [
            'write_file',
            'replace',
            'create_directory',
            'delete_path',
            'move_path',
            'rename_path',
            'apply_patch'
          ],
          `${label} should use the TaskWraith MCP bridge for workspace file changes.`
        )
      : kimiGatewayUnavailable
        ? unavailableCapability(
            'fileChanges',
            'bridge',
            `${label} native file tools are denied; file changes require the mandatory authenticated per-run TaskWraith gateway.`
          )
        : delegatedCapability(
            'fileChanges',
            services.fileChanges,
            provider === 'claude' ? ['provider_file_edit'] : ['provider_file_edit_or_native_tool'],
            `${label} file edit handling is delegated to the provider CLI.`
          )
    externalPublish = taskWraithBridgeProvider
      ? serviceCapability(
          'externalPublish',
          services.externalPublish,
          'bridge',
          ['git_push', 'git_create_pr'],
          `${label} should use the TaskWraith MCP bridge for external publishing.`
        )
      : kimiGatewayUnavailable
        ? unavailableCapability(
            'externalPublish',
            'bridge',
            `${label} native publishing tools are denied; publishing requires the governed TaskWraith gateway.`
          )
        : delegatedCapability(
            'externalPublish',
            services.externalPublish,
            ['provider_git_or_release_tool'],
            `${label} external publishing is delegated to the provider CLI but gated by TaskWraith when observable.`
          )
    mcpTools =
      kimiGatewayUnavailable
        ? unavailableCapability(
            'mcpTools',
            'bridge',
            'The mandatory authenticated per-run TaskWraith gateway is unavailable, so managed Kimi execution is not launched.'
          )
        : provider === 'claude' || provider === 'kimi' || taskWraithBridgeProvider
          ? mcp.source === 'provider'
            ? delegatedCapability(
                'mcpTools',
                services.mcpTools,
                mcp.tools,
                mcp.message || `${label} MCP servers are provider-managed.`
              )
            : serviceCapability('mcpTools', services.mcpTools, 'bridge', mcp.tools, mcp.message)
          : delegatedCapability(
              'mcpTools',
              services.mcpTools,
              mcp.tools,
              mcp.message || `${label} MCP status is unavailable.`
            )
    const taskWraithMcpToolsAvailable =
      taskWraithBridgeProvider ||
      mcp.tools.includes('ask_user_question') ||
      mcp.tools.includes('delegate_to_subthread')
    if (provider === 'claude' || provider === 'kimi' || taskWraithBridgeProvider) {
      elicit = elicitCapability(
        'bridge',
        taskWraithMcpToolsAvailable && mcp.tools.includes('ask_user_question'),
        `${label} can ask the user a clarifying question through the TaskWraith MCP bridge (auto-allowed).`,
        `TaskWraith cannot route ${label} user questions until the TaskWraith MCP bridge is available.`
      )
      delegate = delegateCapability(
        'bridge',
        services.subThreadDelegation,
        taskWraithMcpToolsAvailable && mcp.tools.includes('delegate_to_subthread'),
        `${label} can spawn cross-provider sub-threads through the TaskWraith MCP bridge, gated by the sub-thread delegation setting.`,
        `TaskWraith cannot route ${label} sub-thread delegation until the TaskWraith MCP bridge is available.`
      )
    } else {
      elicit = elicitCapability(
        'provider',
        false,
        `${label} user-question handling is delegated to the provider CLI; TaskWraith does not advertise its elicitation tool here yet.`
      )
      delegate = delegateCapability(
        'provider',
        services.subThreadDelegation,
        false,
        `${label} sub-thread delegation is delegated to the provider CLI; TaskWraith does not advertise its delegation tool here yet.`
      )
    }
    if (!taskWraithBridgeProvider) {
      warnings.push(
        warning(
          `${provider}-provider-managed-tools`,
          'info',
          `${label} tools are provider-managed`,
          `${label} can run with TaskWraith routing, but full shell/file/MCP tool introspection depends on provider CLI events.`
        )
      )
    }
  }

  const networkAccess = networkCapability(services.networkAccess)
  const creativeApps = creativeAppsCapability(services.mcpTools)
  if (networkAccess.state === 'blocked') {
    warnings.push(
      warning(
        `${provider}-network-blocked`,
        'warning',
        'Network access blocked',
        `${label} will be launched with TaskWraith network policy set to block where that provider transport supports it.`
      )
    )
  }

  for (const tool of [shellCommands, fileChanges, externalPublish, mcpTools]) {
    if (tool.state === 'blocked') {
      warnings.push(
        warning(
          `${provider}-${tool.id}-blocked`,
          'warning',
          `${tool.label} blocked`,
          `${tool.label} are blocked by TaskWraith settings for ${label}.`
        )
      )
    }
  }

  // Tier retirement (2026-07): the Ollama Tier-4 "parity not granted" downgrade
  // warning is gone — there is no tier to downgrade; the full surface is always
  // advertised and governed by the run permission role.

  return {
    provider,
    label,
    refreshedAt,
    workspacePath,
    availability,
    tools: {
      shellCommands,
      fileChanges,
      externalPublish,
      mcpTools,
      creativeApps,
      networkAccess,
      elicit,
      delegate
    },
    approvals: approvalContract(provider, requestedMode, effectiveMode),
    mcp,
    warnings
  }
}
