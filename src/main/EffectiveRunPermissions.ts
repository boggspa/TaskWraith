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
import { isPreviewRiskModel } from '../shared/previewModelCatalog'

const AGENTIC_SERVICE_IDS: AgenticServiceId[] = [
  'shellCommands',
  'fileChanges',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'mediaEditing',
  'mediaRecording',
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
      // Media editing (transcode/encode/probe/mix etc.) is mutating/compute; with
      // media now on its OWN service the gate's mcpTools->shellCommands read-only
      // reroute no longer fires for it, so the read-only DENY must come from THIS
      // preset entry (mirrors canvasInteraction). The deny-survival line in
      // effectiveAgenticSettings preserves it across the key-by-key rebuild.
      mediaEditing: 'deny',
      // Media recording (future capture) is denied under read-only too.
      mediaRecording: 'deny',
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
      fileChanges: 'workspace',
      // Media editing follows shell/file: workspace-scoped auto-allow under
      // workspace_write. DELIBERATELY no mediaRecording here — capture is
      // non-grantable and stays at its default-deny.
      mediaEditing: 'workspace'
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
      crossThreadRead: 'allow',
      // Media editing is grantable; Full access auto-allows it (parity with
      // shell/file). DELIBERATELY no mediaRecording here — modelled on canvasEval:
      // even Full access must NOT auto-allow capture; it stays at its default-deny
      // so every (future) mic/camera capture still prompts/denies.
      mediaEditing: 'allow'
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
  model?: string | null
  settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  presetId?: PermissionPresetId | string | null
  overrides?: PermissionOverrides | null
  explicitExternalPathGrants?: ExternalPathGrant[]
}

const PREVIEW_RISK_PROMPT_SERVICES: AgenticServiceId[] = [
  'shellCommands',
  'fileChanges',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'mediaEditing'
]

export function resolveEffectiveRunPermissions(
  input: ResolveEffectiveRunPermissionsInput
): EffectiveRunPermissions {
  const presetId = normalizePresetId(input.presetId)
  const preset = DEFAULT_PERMISSION_PRESETS[presetId]
  const previewRiskModel = isPreviewRiskModel(input.provider, input.model)
  const baseServices = servicesFromSettings(input.settings.agenticServices)
  let workspaceGrantServiceIds = workspaceGrantServiceIdsFor(
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

  if (previewRiskModel) {
    const promptServices = new Set(PREVIEW_RISK_PROMPT_SERVICES)
    for (const service of promptServices) {
      if (agenticServices[service] !== 'deny') {
        agenticServices[service] = 'ask'
      }
    }
    workspaceGrantServiceIds = workspaceGrantServiceIds.filter(
      (service) => !promptServices.has(service)
    )
  }

  const networkAccess =
    previewRiskModel
      ? 'deny'
      : input.settings.agenticServices?.networkAccess === 'deny'
      ? 'deny'
      : input.overrides?.networkAccess ||
        preset.networkAccess ||
        input.settings.agenticServices?.networkAccess ||
        'allow'

  let approvalMode =
    input.overrides?.approvalMode ||
    preset.approvalMode ||
    (presetId === 'read_only' ? 'plan' : 'default')
  if (previewRiskModel && approvalMode !== 'plan') {
    approvalMode = 'default'
  }

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
    // Media editing defaults to 'ask' (grantable, like crossThreadRead).
    mediaEditing: normalizePolicy(settings?.mediaEditing, 'ask'),
    // Media recording is the default-deny, non-grantable capture scaffold. Default
    // 'deny' (default-closed) and clamp any stored 'allow'/'workspace' down to 'ask'
    // so a settings value / import can't promote capture above prompt — exactly like
    // canvasEval. (Capture tools don't exist yet, but the posture is enforced now.)
    mediaRecording: clampNonGrantablePolicy(normalizePolicy(settings?.mediaRecording, 'deny')),
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
    // mediaRecording (future capture) is non-grantable for the same reason — a
    // stored/forged grant must never promote capture above its default-deny.
    if (grant.service === 'canvasEval' || grant.service === 'mediaRecording') continue
    serviceIds.add(grant.service)
  }
  return [...serviceIds]
}
