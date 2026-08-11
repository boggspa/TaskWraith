import { resolve } from 'path'
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
  'sketchCanvas',
  'meshCanvas',
  'simulatorCanvas',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'mediaRecording',
  'canvasEval',
  'webBrowsing'
]

// The standard user-facing tool surface follows one permission ladder. Ask and
// Plan always present the approval modal; Accept Edits and higher authorize the
// same services for the run without a second grant decision (one carve-out:
// externalPublish stays 'ask' under Accept Edits — see the preset map). Keep
// this list separate from AGENTIC_SERVICE_IDS: cross-thread messaging, eval,
// and capture retain their existing specialist policies.
export const LINEAR_PERMISSION_SERVICES: readonly AgenticServiceId[] = [
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'sketchCanvas',
  'meshCanvas',
  'simulatorCanvas',
  'mediaEditing',
  'webBrowsing'
]

// `read_only` ("Ask") and `plan` ("Plan") are both read-only provider
// postures (`approvalMode: 'plan'`, `readOnly: true`). Brokered standard tools
// remain reachable through an attended per-invocation approval modal. Native
// mutating tools stay physically contained by the provider's plan mode.
const READ_ONLY_AGENTIC_SERVICES: PermissionPreset['agenticServices'] = {
  shellCommands: 'ask',
  fileChanges: 'ask',
  externalPublish: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  sketchCanvas: 'ask',
  meshCanvas: 'ask',
  simulatorCanvas: 'ask',
  crossThreadRead: 'ask',
  threadMessage: 'ask',
  mediaEditing: 'ask',
  // Media recording (future capture) stays non-grantable and DENIED — the one
  // deliberate exception to "no auto-deny": there is no attended capture flow
  // for a human to meaningfully approve yet.
  mediaRecording: 'deny',
  // canvas_eval is RCE; it remains non-grantable (isNonGrantableService), so
  // this ASK can never be promoted to an automatic allow — every call prompts
  // with the script shown on the desktop approval.
  canvasEval: 'ask',
  webBrowsing: 'ask'
}

// Plan shares Ask's attended policy for the standard ladder. Unrelated
// cross-thread, eval, and capture permissions deliberately keep their existing
// Plan restrictions.
const PLAN_AGENTIC_SERVICES: PermissionPreset['agenticServices'] = {
  shellCommands: 'ask',
  fileChanges: 'ask',
  externalPublish: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  sketchCanvas: 'ask',
  meshCanvas: 'ask',
  simulatorCanvas: 'ask',
  crossThreadRead: 'deny',
  threadMessage: 'deny',
  mediaEditing: 'ask',
  mediaRecording: 'deny',
  canvasEval: 'deny',
  webBrowsing: 'ask'
}

export const DEFAULT_PERMISSION_PRESETS: Record<PermissionPresetId, PermissionPreset> = {
  read_only: {
    id: 'read_only',
    label: 'Ask',
    approvalMode: 'plan',
    agenticServices: READ_ONLY_AGENTIC_SERVICES,
    // Web reads (web_search/web_fetch/github_ci_status) are non-mutating retrospection — a
    // Ask seat may reach the live web. networkAccess gates ONLY the
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
    label: 'Accept Edits',
    approvalMode: 'default',
    // Accept Edits' defining behavior (user decisions 2026-08-04 / 2026-08-09):
    // choosing the preset IS the run-level authorization for the standard
    // brokered tool surface. Shell, files, publishing, tool calls,
    // delegation, Canvas surfaces, media editing, and browser navigation stay
    // fluid instead of presenting a second grant decision.
    //
    // Security that still holds under this posture:
    //   - every global service 'deny' remains absolute (preserveExplicitDeny)
    //   - tool executors reject outside-workspace paths; external-path
    //     detection force-prompts (never auto-allows escapes)
    //   - Canvas refuses credential/OTP fields and yields to recent human input
    //   - canvasEval, recording, and cross-thread actions keep their existing
    //     specialist policies
    //   - preview-risk models clamp these services back to 'ask'
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      // Accept Edits auto-allows basic workspace mutations (fileChanges) but
      // still prompts for external publishing so push/PR actions require a
      // second authorization.
      externalPublish: 'ask',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      // Ordinary browser actuation. Surface ownership, stale-observation,
      // recent-human-input, and credential-field guards remain executor-level
      // invariants; this removes only the redundant per-click approval card.
      canvasInteraction: 'allow',
      sketchCanvas: 'allow',
      // Chat-owned Mesh Canvas authoring remains inside TaskWraith's durable
      // scene store; workspace imports are jailed and copied into its vault.
      meshCanvas: 'allow',
      // Same Accept Edits authorization for Simulator Canvas control.
      simulatorCanvas: 'allow',
      mediaEditing: 'allow',
      // Opening/navigating public websites in the sandboxed Canvas Browser.
      webBrowsing: 'allow'
    }
  },
  workspace_write: {
    id: 'workspace_write',
    label: 'Full WS Access',
    approvalMode: 'auto_edit',
    // Selecting Full WS Access IS the user's run-level authorization for
    // in-workspace shell / file / media edits. Policy value 'workspace' still
    // means "prompt until a separate standing workspace grant exists", which
    // double-taxed users: they chose the preset and still got a card on every
    // edit (most painful on tool-heavy seats like Grok). Use 'allow' so the
    // signed run posture auto-approves these services without a second grant.
    //
    // Security that still holds under this posture:
    //   - global agenticServices deny remains absolute (preserveExplicitDeny)
    //   - tool executors reject outside-workspace paths
    //   - external-path detection force-prompts (never auto-allows escapes)
    //   - canvasEval / mediaRecording stay non-grantable ask/deny
    //   - isFullShellAccessGranted still requires presetId === 'full_access',
    //     so Full WS Access never drops provider sandboxing to danger-full-access
    //   - preview-risk models clamp these services back to 'ask'
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      mcpTools: 'allow',
      // Media editing follows shell/file auto-allow under workspace_write.
      // DELIBERATELY no mediaRecording here — capture is non-grantable and
      // stays at its default-deny.
      mediaEditing: 'allow',
      // Higher permission tiers retain Accept Edits' ordinary browser control.
      // Credential fields and eval stay outside this authorization.
      canvasInteraction: 'allow',
      // Chat-owned Mesh Canvas authoring/import is workspace bounded: source
      // assets are jailed to this workspace and copied into TaskWraith's vault.
      meshCanvas: 'allow',
      // Sketch documents are chat-owned, structured UI state with no shell,
      // filesystem, or network execution surface.
      sketchCanvas: 'allow',
      externalPublish: 'allow',
      // Browser navigation adds no egress a workspace_write seat lacks (shell
      // 'allow' already reaches the network); the surface itself stays
      // sandboxed + SSRF-guarded.
      webBrowsing: 'allow',
      // Full WS Access also authorizes standard brokered sub-thread delegation
      // and Simulator Canvas control.
      subThreadDelegation: 'allow',
      simulatorCanvas: 'allow'
    }
  },
  full_access: {
    id: 'full_access',
    label: 'Full Access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      externalPublish: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'allow',
      sketchCanvas: 'allow',
      meshCanvas: 'allow',
      simulatorCanvas: 'allow',
      // Cross-thread reads are grantable; Full access auto-allows them.
      crossThreadRead: 'allow',
      // Queued thread messages are grantable; Full access auto-allows them. A WAKE
      // request is NOT covered by this — ThreadMessagePermission keeps waking off
      // the grant path entirely.
      threadMessage: 'allow',
      // Media editing is grantable; Full access auto-allows it (parity with
      // shell/file). DELIBERATELY no mediaRecording here — modelled on canvasEval:
      // even Full access must NOT auto-allow capture; it stays at its default-deny
      // so every (future) mic/camera capture still prompts/denies.
      mediaEditing: 'allow',
      // Browser navigation is grantable; Full Access auto-allows it (it
      // already auto-allows the strictly-more-powerful mcpTools surface).
      webBrowsing: 'allow'
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
  'sketchCanvas',
  'simulatorCanvas',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'webBrowsing'
]

// Plan's standard services stay ASK and must not be zero-clicked by a standing
// grant minted under Accept Edits / Full WS / Full Access. External publishing
// is held by POSTURE_APPROVAL_ONLY_SERVICES below; every other standard service
// is held here. Kept exported so the approval gate folds them into
// neverAutoAllow.
export const PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES: ReadonlySet<AgenticServiceId> =
  new Set<AgenticServiceId>([
    'shellCommands',
    'fileChanges',
    'mcpTools',
    'subThreadDelegation',
    'canvasInteraction',
    'sketchCanvas',
    'meshCanvas',
    'simulatorCanvas',
    'mediaEditing',
    'webBrowsing'
  ])

// The Ask tier's defining property is PER-INVOCATION human approval: anything
// the map asks for must genuinely prompt, so a standing workspace grant or an
// in-run session grant minted under `default`+ must NOT silently auto-allow it
// on a read_only ("Ask") seat. Every asked mutating service joins the hold.
// External publishing is already held for read_only/plan via
// POSTURE_APPROVAL_ONLY_SERVICES below.
export const READ_ONLY_APPROVAL_ONLY_INSTRUMENT_SERVICES: ReadonlySet<AgenticServiceId> =
  new Set<AgenticServiceId>([
    'shellCommands',
    'fileChanges',
    'mcpTools',
    'subThreadDelegation',
    'simulatorCanvas',
    'canvasInteraction',
    'sketchCanvas',
    'meshCanvas',
    'crossThreadRead',
    'threadMessage',
    'mediaEditing',
    'canvasEval',
    'webBrowsing'
  ])

const POSTURE_APPROVAL_ONLY_SERVICES: ReadonlySet<AgenticServiceId> = new Set<AgenticServiceId>([
  'externalPublish'
])

/**
 * Should a would-be automatic approval of `service` be downgraded to a
 * per-invocation prompt because the run is on the `plan` or `read_only` preset
 * and the service belongs to its approval-only set?
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
  if (!service) return false
  if (presetId === 'plan') return PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES.has(service)
  // read_only carries the same hold so a grant minted under default can never
  // silently auto-allow an Ask-seat prompt.
  if (presetId === 'read_only') return READ_ONLY_APPROVAL_ONLY_INSTRUMENT_SERVICES.has(service)
  return false
}

export function isPostureApprovalOnlyService(
  presetId: string | null | undefined,
  service: AgenticServiceId | null | undefined
): boolean {
  return (
    (presetId === 'plan' || presetId === 'read_only') &&
    !!service &&
    POSTURE_APPROVAL_ONLY_SERVICES.has(service)
  )
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
      !isPlanInstrumentGrantHold(presetId, service)
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

  const networkAccess = previewRiskModel
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
    externalPublish: normalizePolicy(settings?.externalPublish, 'ask'),
    mcpTools: normalizePolicy(settings?.mcpTools, 'ask'),
    subThreadDelegation: normalizePolicy(settings?.subThreadDelegation, 'ask'),
    canvasInteraction: normalizePolicy(settings?.canvasInteraction, 'ask'),
    // First-class Sketch edits are intentionally prompt-free at Accept
    // Edits. Ask/Plan presets override this base value above.
    sketchCanvas: normalizePolicy(settings?.sketchCanvas, 'allow'),
    meshCanvas: normalizePolicy(settings?.meshCanvas, 'ask'),
    simulatorCanvas: normalizePolicy(settings?.simulatorCanvas, 'ask'),
    crossThreadRead: normalizePolicy(settings?.crossThreadRead, 'ask'),
    // Thread messages default to 'ask' (grantable, like crossThreadRead).
    threadMessage: normalizePolicy(settings?.threadMessage, 'ask'),
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
    canvasEval: clampNonGrantablePolicy(normalizePolicy(settings?.canvasEval, 'ask')),
    // Browser navigation defaults to 'ask' (grantable, like crossThreadRead).
    webBrowsing: normalizePolicy(settings?.webBrowsing, 'ask')
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
  // Match PermissionService storage: grants are stored under path.resolve(...).
  // Strict string equality misses trailing-slash / relative-path variants.
  const normalizedWorkspace = resolve(workspacePath)
  const serviceIds = new Set<AgenticServiceId>()
  for (const grant of grants) {
    // Lockstep with PermissionService.hasWorkspaceGrant: 'agents' rows cover
    // every provider; legacy per-provider rows match only their own. If the
    // resolver and the gate disagree here, unattended lanes resolve 'ask',
    // time out, and auto-deny — the exact silent-failure the wildcard fixes.
    if (grant.provider !== 'agents' && grant.provider !== provider) continue
    if (!grant.workspacePath || resolve(grant.workspacePath) !== normalizedWorkspace) continue
    if (grant.expiresAt) {
      const expiresAt = Date.parse(grant.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue
    }
    // Non-grantable services: stale/forged workspace grants must never promote
    // these above a per-action prompt. PermissionService enforces the same for
    // session grants.
    //
    // canvasInteraction is here for a different reason: it IS grantable, but
    // only ever bound to one surface. There is no workspace tier for it —
    // "click anything, in any chat, in this workspace, until revoked" is not a
    // scope a user can meaningfully consent to, and it would outlive every
    // surface it was given for. PermissionService.hasWorkspaceGrant refuses it
    // too, so a grant persisted by an older build cannot promote a canvas
    // interaction from either direction.
    if (
      grant.service === 'canvasEval' ||
      grant.service === 'mediaRecording' ||
      grant.service === 'canvasInteraction'
    )
      continue
    serviceIds.add(grant.service)
  }
  return [...serviceIds]
}
