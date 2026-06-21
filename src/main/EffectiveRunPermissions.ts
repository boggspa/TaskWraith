import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AgenticServicesSettings,
  AgenticWorkspaceGrant,
  AppSettings,
  EffectiveRunPermissions,
  ExternalPathGrant,
  PermissionOverrides,
  PermissionPreset,
  PermissionPresetId,
  ProviderId
} from './store/types'
import { coalesceExternalPathGrants, stripExternalPathGrantOrder } from './store/ExternalPathGrants'

const AGENTIC_SERVICE_IDS: AgenticServiceId[] = [
  'shellCommands',
  'fileChanges',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'canvasEval'
]

export const DEFAULT_PERMISSION_PRESETS: Record<PermissionPresetId, PermissionPreset> = {
  read_only: {
    id: 'read_only',
    label: 'Read only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      // Load-bearing: with canvas_click/fill now on their own service, the gate's
      // mcpTools->shellCommands read-only reroute no longer fires for them, so the
      // read-only DENY must come from THIS preset entry.
      canvasInteraction: 'deny',
      // Cross-thread reads are denied under read-only — no reaching into other
      // threads'/workspaces' run history from a read-only seat.
      crossThreadRead: 'deny',
      // Arbitrary canvas_eval is RCE — never available under read-only.
      canvasEval: 'deny'
    },
    networkAccess: 'deny'
  },
  default: {
    id: 'default',
    label: 'Default',
    approvalMode: 'default'
  },
  workspace_write: {
    id: 'workspace_write',
    label: 'Workspace write',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'workspace'
    }
  },
  full_access: {
    id: 'full_access',
    label: 'Full access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'allow',
      // Cross-thread reads are grantable; Full access auto-allows them.
      crossThreadRead: 'allow'
      // DELIBERATELY no canvasEval here: even Full access must NOT auto-allow
      // arbitrary eval (RCE). It stays at the settings default ('ask') so every
      // eval still prompts. Do not add canvasEval: 'allow' — the non-grantable +
      // never-YOLO guards assume eval never resolves to an automatic allow.
    },
    networkAccess: 'allow'
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    approvalMode: 'default'
  }
}

export interface ResolveEffectiveRunPermissionsInput {
  provider: ProviderId
  workspacePath?: string
  settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  presetId?: PermissionPresetId | string | null
  overrides?: PermissionOverrides | null
  explicitExternalPathGrants?: ExternalPathGrant[]
}

export function resolveEffectiveRunPermissions(
  input: ResolveEffectiveRunPermissionsInput
): EffectiveRunPermissions {
  const presetId = normalizePresetId(input.presetId)
  const preset = DEFAULT_PERMISSION_PRESETS[presetId]
  const baseServices = servicesFromSettings(input.settings.agenticServices)
  const workspaceGrantServiceIds = workspaceGrantServiceIdsFor(
    input.settings.agenticWorkspaceGrants || [],
    input.provider,
    input.workspacePath
  )
  const presetServices = preset.agenticServices || {}
  const overrideServices = input.overrides?.agenticServices || {}
  const agenticServices: Record<AgenticServiceId, AgenticServicePolicy> = { ...baseServices }
  for (const service of AGENTIC_SERVICE_IDS) {
    const next = overrideServices[service] || presetServices[service] || agenticServices[service]
    agenticServices[service] = preserveExplicitDeny(baseServices[service], next)
    if (workspaceGrantServiceIds.includes(service) && agenticServices[service] === 'ask') {
      agenticServices[service] = 'workspace'
    }
  }

  const networkAccess =
    input.settings.agenticServices?.networkAccess === 'deny'
      ? 'deny'
      : input.overrides?.networkAccess ||
        preset.networkAccess ||
        input.settings.agenticServices?.networkAccess ||
        'allow'

  const approvalMode =
    input.overrides?.approvalMode ||
    preset.approvalMode ||
    (presetId === 'read_only' ? 'plan' : 'default')

  // 1.0.6-EW66 — strip the renderer-only `order` field: effective
  // run permissions feed execution, not the composer workspace list.
  const externalPathGrants = stripExternalPathGrantOrder(
    coalesceExternalPathGrants([
      ...(input.explicitExternalPathGrants || []),
      ...(input.overrides?.externalPathGrants || [])
    ])
  ).filter((grant) => grant.provider === input.provider)

  return {
    presetId,
    approvalMode,
    agenticServices,
    networkAccess,
    externalPathGrants,
    workspaceGrantServiceIds,
    readOnly: approvalMode === 'plan' || presetId === 'read_only'
  }
}

function normalizePresetId(value: unknown): PermissionPresetId {
  return typeof value === 'string' && value in DEFAULT_PERMISSION_PRESETS
    ? (value as PermissionPresetId)
    : 'default'
}

function servicesFromSettings(
  settings: AgenticServicesSettings
): Record<AgenticServiceId, AgenticServicePolicy> {
  return {
    shellCommands: normalizePolicy(settings?.shellCommands, 'ask'),
    fileChanges: normalizePolicy(settings?.fileChanges, 'ask'),
    mcpTools: normalizePolicy(settings?.mcpTools, 'ask'),
    subThreadDelegation: normalizePolicy(settings?.subThreadDelegation, 'ask'),
    canvasInteraction: normalizePolicy(settings?.canvasInteraction, 'ask'),
    crossThreadRead: normalizePolicy(settings?.crossThreadRead, 'ask'),
    // canvasEval (RCE) is non-grantable / never-auto-allowed. Clamp the stored
    // policy so it can only ever be 'ask' or 'deny' — a settings value (or import)
    // of 'allow'/'workspace' must not be able to contradict that guarantee at the
    // policy layer, even though both approval gates would also override it.
    canvasEval: clampNonGrantablePolicy(normalizePolicy(settings?.canvasEval, 'ask'))
  }
}

function clampNonGrantablePolicy(policy: AgenticServicePolicy): AgenticServicePolicy {
  return policy === 'allow' || policy === 'workspace' ? 'ask' : policy
}

function normalizePolicy(value: unknown, fallback: AgenticServicePolicy): AgenticServicePolicy {
  return value === 'ask' || value === 'workspace' || value === 'allow' || value === 'deny'
    ? value
    : fallback
}

function preserveExplicitDeny(
  globalPolicy: AgenticServicePolicy,
  requestedPolicy: AgenticServicePolicy
): AgenticServicePolicy {
  return globalPolicy === 'deny' ? 'deny' : requestedPolicy
}

function workspaceGrantServiceIdsFor(
  grants: AgenticWorkspaceGrant[],
  provider: ProviderId,
  workspacePath?: string
): AgenticServiceId[] {
  if (!workspacePath) return []
  const serviceIds = new Set<AgenticServiceId>()
  for (const grant of grants) {
    if (grant.provider !== provider) continue
    if (grant.workspacePath !== workspacePath) continue
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) continue
    // canvasEval (RCE) is non-grantable: a stale/forged workspace grant must never
    // promote eval to an automatic allow. PermissionService enforces the same for
    // session grants; this is the workspace-grant half of that guarantee.
    if (grant.service === 'canvasEval') continue
    serviceIds.add(grant.service)
  }
  return [...serviceIds]
}
