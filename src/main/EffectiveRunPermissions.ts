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
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'mediaEditing',
  'mediaRecording',
  'canvasEval'
]

// Posture split (roadmap T1 / W7 down-payment). `read_only` and `plan` used to
// share ONE service map, so the two presets were byte-identical and the
// permission lattice lied: the UI offered two postures that enforced the same
// thing. They now have DISTINCT maps and MUST NOT be re-merged.
//
// Both keep `approvalMode: 'plan'` (the provider wire value — Grok/Cursor
// physically run `--mode plan` and cannot write) and `readOnly: true`, so
// NEITHER can edit files, run shell, eval, capture, cross-thread-read, or write
// directly. The ONLY axis on which they differ is which agent INSTRUMENTS a
// human may approve mid-run:
//
//   read_only (the strict floor — "Recon"): no elevation path at all.
//     subThreadDelegation is DENY (a read_only seat cannot spawn a subthread
//     that would inherit no read_only posture — the one real escalation vector),
//     and canvas actuation + media compute stay DENY.
//   plan (the instruments tier): subthread delegation, canvas actuation
//     (canvas_click/fill), and media-compute (transcode/render/probe) are ASK —
//     permitted only through per-invocation human approval. read_only < plan.
//
// canvas_click/fill route to `canvasInteraction` and media tools to
// `mediaEditing` — their OWN services, NOT the generic `mcpTools` service — so
// the gate's `isReadOnlyBlockedTool` mcpTools->shellCommands reroute never fires
// for them and the ASK/DENY verdict comes straight from THESE preset entries.
// (Verified across the Claude/Kimi/Codex/shared-MCP gate sites.) The
// deny-survival line in effectiveAgenticSettings preserves each DENY across the
// key-by-key rebuild.
const READ_ONLY_AGENTIC_SERVICES: PermissionPreset['agenticServices'] = {
  shellCommands: 'deny',
  fileChanges: 'deny',
  externalPublish: 'deny',
  mcpTools: 'ask',
  // No elevation path: a read_only seat may not delegate to a subthread (which
  // would inherit no read_only posture). This is the load-bearing delta from
  // `plan` — it is DENY here, ASK there.
  subThreadDelegation: 'deny',
  // Canvas actuation (canvas_click/fill) mutates the app surface — denied under
  // read_only; approval-queued under `plan`.
  canvasInteraction: 'deny',
  // Cross-thread reads are denied under read-only — no reaching into other
  // threads'/workspaces' run history from a read-only seat. (Not an instrument;
  // stays DENY under `plan` too.)
  crossThreadRead: 'deny',
  // Media editing (transcode/encode/probe/mix etc.) is mutating/compute — denied
  // under read_only; approval-queued under `plan`.
  mediaEditing: 'deny',
  // Media recording (future capture) is non-grantable — denied under both.
  mediaRecording: 'deny',
  // Arbitrary canvas_eval is RCE — never available under read_only OR plan.
  canvasEval: 'deny'
}

// `plan` = read_only PLUS the approval-gated instrument belt (W7 down-payment).
// Strict superset of read_only: it only ever RELAXES read_only's DENY to ASK on
// the instrument services, never the reverse, so plan is always ≥ read_only in
// authority. Delivery is conditional-by-design: `preserveExplicitDeny` clamps
// any of these ASK entries back to DENY when the user's GLOBAL agenticServices
// setting for that service is 'deny' (a global kill switch always wins).
const PLAN_AGENTIC_SERVICES: PermissionPreset['agenticServices'] = {
  shellCommands: 'deny',
  fileChanges: 'deny',
  externalPublish: 'deny',
  mcpTools: 'ask',
  // Plan may delegate to a subthread with per-invocation approval.
  subThreadDelegation: 'ask',
  // Instrument: canvas actuation permitted under plan via human approval.
  canvasInteraction: 'ask',
  // Not an instrument — cross-thread history reads stay denied under plan.
  crossThreadRead: 'deny',
  // Instrument: media compute permitted under plan via human approval.
  mediaEditing: 'ask',
  // Capture is non-grantable — denied under plan too.
  mediaRecording: 'deny',
  // Arbitrary canvas_eval is RCE — never available under plan.
  canvasEval: 'deny'
}

export const DEFAULT_PERMISSION_PRESETS: Record<PermissionPresetId, PermissionPreset> = {
  read_only: {
    id: 'read_only',
    label: 'Read only',
    approvalMode: 'plan',
    agenticServices: READ_ONLY_AGENTIC_SERVICES,
    // Web reads (web_search/web_fetch) are non-mutating retrospection — a
    // Read-Only/Recon seat may reach the live web. networkAccess gates ONLY the
    // web_read tool class (isNetworkAccessBlockedTool); it never touches the
    // file/shell/mcp approval gates, so this is a pure read-capability
    // expansion. The previewRiskModel guard (resolver l.263) and the global
    // networkAccess='deny' kill switch (l.265) still force-deny ahead of this
    // preset value, so a locked-down workspace or a preview model stays offline.
    networkAccess: 'allow'
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    approvalMode: 'plan',
    agenticServices: PLAN_AGENTIC_SERVICES,
    // Plan may also web-read (same rationale as read_only above); still gated by
    // the previewRiskModel + global-deny guards in the resolver's network chain.
    networkAccess: 'allow'
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
      // External publishing is non-grantable: even Full access must prompt for
      // each push / PR / future release-center action.
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
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'mediaEditing'
]

// The `plan` preset relaxes these instrument services from read_only's DENY to
// ASK — but ONLY as per-invocation approval (the W7 down-payment rung). A
// standing workspace grant must NOT silently upgrade them to auto-allow under
// `plan`: standing per-workspace instrument grants are the W7-b rung, gated on
// the instrument-conformance suite, not this change. They stay grantable under
// `default`/`full_access`, where the user opted into that authority tier.
// (subThreadDelegation is deliberately absent — it was already ASK + grantable
// under `plan` before the split, so grant-immunity there would be a regression.)
export const PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES: ReadonlySet<AgenticServiceId> =
  new Set<AgenticServiceId>(['canvasInteraction', 'mediaEditing'])

/**
 * Should a would-be automatic approval of `service` be downgraded to a
 * per-invocation prompt because the run is on the `plan` preset and the service
 * is one of plan's approval-only instruments (canvasInteraction / mediaEditing)?
 *
 * This is the ENFORCEMENT-GATE half of the resolver's `PLAN_APPROVAL_ONLY_*`
 * guard. The resolver keeps these entries at 'ask' (never upgrading to
 * 'workspace') in the resolved map, but the approval gate re-derives grant
 * status straight from the raw grants store — which is preset-blind — so a
 * standing workspace grant or an in-run session grant would otherwise
 * auto-allow these instruments under `plan` with no human approval. Callers
 * fold this into their `neverAutoAllow` flag so EVERY auto-allow path
 * (policy/grant, session-YOLO, Bossman, native preflight) forces the prompt.
 * Under `default` / `full_access` this returns false, so those tiers keep
 * auto-allowing the same tools as before.
 */
export function isPlanInstrumentGrantHold(
  presetId: string | null | undefined,
  service: AgenticServiceId | null | undefined
): boolean {
  return presetId === 'plan' && !!service && PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES.has(service)
}

/**
 * Is this run a genuine, trusted Full-Access grant — the ONLY posture allowed to
 * drop provider sandboxing (Codex `danger-full-access`, Gemini seatbelt off) and
 * reach outside the workspace (login keychain, ~/Library, sibling dirs) for
 * signing / archiving / uploading?
 *
 * True only when BOTH hold on the POST-CLAMP effective permissions:
 *   - `presetId === 'full_access'` — the explicit per-workspace / per-run opt-in.
 *     presetId is part of the HMAC-signed posture, so a tampered or unsigned
 *     payload that forged it would already have been clamped to read_only by
 *     `clampUntrustedRunPosture` before reaching a spawn site; and
 *   - `agenticServices.shellCommands === 'allow'` — so the GLOBAL shellCommands
 *     kill-switch (`preserveExplicitDeny`) still vetoes it: a user who set global
 *     shell to 'deny' keeps the sandbox even on a full_access run.
 *
 * A global `shellCommands: 'allow'` on a NON-full_access preset deliberately does
 * NOT qualify (the presetId gate), keeping the sandbox-drop tied to the explicit
 * Full Access opt-in rather than any write-capable run.
 */
export function isFullShellAccessGranted(
  effectivePermissions: EffectiveRunPermissions | null | undefined
): boolean {
  return (
    effectivePermissions?.presetId === 'full_access' &&
    effectivePermissions?.agenticServices?.shellCommands === 'allow'
  )
}

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
    if (
      workspaceGrantServiceIds.includes(service) &&
      agenticServices[service] === 'ask' &&
      !(presetId === 'plan' && PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES.has(service))
    ) {
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
    externalPublish: clampNonGrantablePolicy(
      normalizePolicy(settings?.externalPublish, 'ask')
    ),
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
    // Non-grantable services: stale/forged workspace grants must never promote
    // these above a per-action prompt. PermissionService enforces the same for
    // session grants.
    if (
      grant.service === 'canvasEval' ||
      grant.service === 'mediaRecording' ||
      grant.service === 'externalPublish'
    )
      continue
    serviceIds.add(grant.service)
  }
  return [...serviceIds]
}
