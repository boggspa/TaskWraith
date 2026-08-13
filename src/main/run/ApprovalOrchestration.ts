import type { WebContents } from 'electron'
import type { AgentRunRoute } from './AgentRunTypes'
import { routeWithRunId } from './RunRoute'
import type { ApprovalService, PendingExternalPathDetection } from '../services/ApprovalService'
import type { AuditService } from '../services/AuditService'
import type { PermissionService } from '../PermissionService'
import type { RunManager } from '../RunManager'
import type {
  AgenticServiceId,
  AgentApprovalAction,
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ProviderId,
  RunEventInput
} from '../store/types'
import { effectiveAgenticSettings } from '../NativeApprovalPolicy'
import { shellCommandFromApprovalPreview } from '../ReadOnlyGitShellCommand'
import { isIsolateSharedBranchHold } from '../IsolateSharedBranchHold'
import { shellCommandTierHold } from '../ShellCommandTierPolicy'
import { promptFreeReadOnlyShellReason } from '../PromptFreeReadOnlyShell'
import { agenticServiceBlockedMessage, approvalActionsForPolicy } from '../AgenticServiceMessages'
import { isPlanInstrumentGrantHold, isPostureApprovalOnlyService } from '../EffectiveRunPermissions'
import { isRecord } from '../settings/MainSanitizers'
import { buildRemoteApprovalSummary } from '../RemoteApprovalSummary'
import {
  assertCanvasEvalApprovalReceipt,
  canvasEvalApprovalPayloadForDurableStorage,
  type CanvasEvalApprovalReceipt
} from '../canvas/CanvasEvalAudit'
import { redactCanvasFillValueForDurableStorage } from '../canvas/CanvasFillAudit'
import { toolPermissionRetryApprovalPayloadForDurableStorage } from '../mcp/ToolPermissionRetry'
import { redactAcpApprovalPreviewForDurableStorage } from '../AcpToolApprovalPreview'
import { isAntigravityUserAuthorizedShellCommand } from '../antigravity/AntigravityShellApprovalPolicy'

export interface ApprovalPromptReceipt {
  approvalId: string
}

/**
 * ApprovalOrchestration — M3-3b orchestration-facade extraction (per
 * `design-m3-3b-spec`). This is the TRUST CHOKE POINT: every non-Codex-native
 * agentic-service approval (Gemini/Claude/Kimi tool prompts, host commands,
 * cross-thread reads, external-path grants, MCP tools) flows through
 * `requestAgenticServiceApproval` before it can auto-allow, auto-deny, or prompt.
 *
 * `createApprovalOrchestration(deps)` returns the orchestrator that was inline in
 * index.ts (built once in module scope, so all callsites stay unchanged — the
 * M3-2b factory precedent, not M3-1b's deps-param form). M3-3a made the seam
 * explicit via `RequestAgenticServiceApprovalDeps` (every index.ts-scoped symbol
 * injected — the trust services, the AppStore accessor, the audit/ledger sinks,
 * the push fan-out); M3-3b relocates the body here. The 4 pure cross-module
 * helpers (`effectiveAgenticSettings`, `agenticServiceBlockedMessage`,
 * `isPlanInstrumentGrantHold`, `approvalActionsForPolicy`) carry no index.ts state
 * and are direct-imported.
 *
 * Unlike M3-1/M3-2 (behaviour-preserving), this relocation must be
 * SECURITY-PRESERVING: a reordered/dropped guard is a security regression, not a
 * behaviour change. The body is byte-for-byte the committed code (only the dep
 * prefix `requestAgenticServiceApprovalDeps.` → `deps.` differs), preserving the
 * five ordering invariants verbatim:
 *   1. NETWORK-BLOCK auto-deny fires BEFORE permission resolution.
 *   2. policy DENY is absolute — it sits BEFORE session-YOLO / standing-grant /
 *      bossman, so no later auto-allow can override an explicit deny.
 *   3. the plan-artifact fast-path sits AFTER resolve and BEFORE the plain deny.
 *   4. `registerGeminiTool` (the terminal approval registration read live via
 *      `deps.getApprovalService()`) opens the prompt's REGISTER sequence.
 *   5. `neverAutoAllow` (canvasEval / mediaRecording / approval-only posture
 *      plan-instrument-grant-hold) forces a prompt on every auto-allow path.
 * `ApprovalOrchestration.test.ts` is the security net — it fences these branches
 * because `ApprovalServiceM3Gate` only guards `ApprovalService.resolve()`, never
 * this 306-line orchestration.
 */
export interface RequestAgenticServiceApprovalDeps {
  runManager: RunManager<any>
  permissionService: PermissionService
  auditService: AuditService
  // Lazy accessor (NOT a captured value): approvalService is a whenReady-assigned
  // module-let (null at module-init when this bundle is built). Reading it live —
  // exactly like getSettings below — is what keeps registerGeminiTool firing after
  // whenReady. A by-value capture here freezes null → the terminal approval
  // registration silently no-ops (a security regression on the trust choke point).
  getApprovalService: () => ApprovalService | null
  /** History-clear admission fence, scoped by run/workspace where possible. */
  isApprovalAdmissionBlocked?: (
    runId?: string,
    workspacePath?: string,
    appChatId?: string
  ) => boolean
  getSettings: () => AppSettings
  /**
   * Chat lookup for chat-scoped holds (the Isolate pinned-Shared branch/
   * worktree ask-hold). Optional so existing fixtures keep compiling; when
   * absent the hold never fires — production wiring always provides it.
   */
  getChatById?: (appChatId: string | undefined) => Pick<ChatRecord, 'ensemble'> | null | undefined
  appendDurableRunEventForRoute: (
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    kind: RunEventInput['kind'],
    phase: RunEventInput['phase'],
    summary: string,
    payload?: unknown,
    source?: RunEventInput['source'],
    canvasEvalApproval?: CanvasEvalApprovalReceipt
  ) => void
  recordApprovalLedgerRequest: (
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    payload: {
      id?: string
      approvalId?: string
      requestId?: number | string
      method?: string
      title?: string
      body?: string
      preview?: unknown
      params?: unknown
      actions?: AgentApprovalAction[]
    },
    options?: {
      service?: AgenticServiceId
      workspacePath?: string
      metadata?: Record<string, unknown>
      canvasEvalApproval?: CanvasEvalApprovalReceipt
    }
  ) => void
  safeSendToSender: (
    sender: WebContents | null | undefined,
    channel: string,
    payload: unknown
  ) => boolean
  isSessionYoloEffective: () => boolean
  sessionYoloState: { enabled: boolean; enabledAt: string | null }
  scheduleApprovalTimeout: (args: {
    approvalId: string
    provider: ProviderId
    route?: AgentRunRoute | null
    isMainAuthority?: boolean
    kind?: string
  }) => void
  workspaceIdForApprovalPush: (workspacePath: string | undefined) => string | null
  notifyPairedDevicesOfApproval: (args: {
    approvalId: string
    workspaceId: string | null
    threadId: string
    summary: string
  }) => void
  networkAccessBlockedToolName: (
    toolName: string | null | undefined,
    effectivePermissions?: EffectiveRunPermissions,
    toolArgs?: unknown
  ) => string | null
  networkAccessBlockedMessage: (toolName: string) => string
  canAutoApproveTrustedSessionExternalWrite: (input: {
    provider: ProviderId
    workspacePath: string | undefined
    session: ReturnType<RunManager<any>['get']> | undefined
    effectivePermissions: EffectiveRunPermissions | undefined
    externalPathDetection: PendingExternalPathDetection | undefined
  }) => boolean
  ensembleApprovalContext: (
    identity: EnsembleRunIdentity | undefined,
    service: AgenticServiceId,
    workspacePath: string | undefined
  ) => { label: string; bodyPrefix: string; preview: Record<string, unknown> } | undefined
  planArtifactWriteApprovalMetadata: (input: {
    workflowMode: unknown
    effectivePermissions: EffectiveRunPermissions | undefined
    globalFileChangesPolicy?: string
    service: AgenticServiceId
    workspacePath: string | undefined
    request: {
      preview?: any
    }
  }) => Record<string, unknown> | null
  stampPlanArtifactPathOnPendingPlan: (
    appChatId: string | undefined,
    metadata: Record<string, unknown> | null
  ) => void
  bossmanAutoApprovalMetadata: (input: {
    session: ReturnType<RunManager<any>['get']> | undefined
    ensembleRun: EnsembleRunIdentity | undefined
    service: AgenticServiceId
    workspacePath: string | undefined
    request: {
      method: string
      title: string
      body: string
      preview?: any
      runId?: string
      forcePrompt?: boolean
      externalPathDetection?: PendingExternalPathDetection
    }
    effectivePermissions: EffectiveRunPermissions | undefined
    policy: string
    decision: string
    neverAutoAllow: boolean
  }) => Record<string, unknown> | null
  externalPathApprovalTitle: () => string
  externalPathApprovalBody: (detection: PendingExternalPathDetection) => string
  externalPathApprovalPreview: (detection: PendingExternalPathDetection) => {
    path: string
    basename?: string
    access: 'read' | 'write'
  }
}

export type RequestMainApprovalDeps = Pick<
  RequestAgenticServiceApprovalDeps,
  | 'getApprovalService'
  | 'runManager'
  | 'scheduleApprovalTimeout'
  | 'appendDurableRunEventForRoute'
  | 'recordApprovalLedgerRequest'
  | 'safeSendToSender'
  | 'notifyPairedDevicesOfApproval'
  | 'workspaceIdForApprovalPush'
  | 'isApprovalAdmissionBlocked'
>

export function createMainApprovalOrchestration(deps: RequestMainApprovalDeps) {
  return async (
    sender: WebContents | null,
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    request: {
      method: string
      title: string
      body: string
      preview?: unknown
      workspacePath?: string
      actions?: AgentApprovalAction[]
      remoteIncomplete?: boolean
      resolveAction?: (action: AgentApprovalAction, decisionSource: 'user' | 'system') => void
    }
  ): Promise<boolean> => {
    if (deps.isApprovalAdmissionBlocked?.(route?.appRunId, request.workspacePath, route?.appChatId))
      return false
    if (!sender || sender.isDestroyed()) return false
    const routed = routeWithRunId(provider, route)
    const approvalId = Date.now() + '-' + Math.random().toString(36).slice(2)
    const actions: AgentApprovalAction[] = request.actions || ['accept', 'decline', 'cancel']
    // Ensemble seat attribution — the service path has carried this since AR3;
    // main-authority prompts (tool permission retries, session trust, host
    // reruns) looked anonymous in a multi-seat roster: "Allow Pi to retry…"
    // with no way to tell WHICH Pi seat asked. Derived from the run session,
    // never from caller-supplied text, so a solo approval can't gain a label.
    const mainSession = deps.runManager.get(routed.appRunId)
    const mainEnsembleRun = mainSession?.state?.ensembleRun as EnsembleRunIdentity | undefined
    const mainAttribution =
      mainEnsembleRun &&
      typeof mainEnsembleRun.participantId === 'string' &&
      mainEnsembleRun.participantId &&
      typeof mainEnsembleRun.role === 'string' &&
      mainEnsembleRun.role
        ? {
            title: `${mainEnsembleRun.role}: ${request.title}`,
            preview: {
              participantId: mainEnsembleRun.participantId,
              role: mainEnsembleRun.role,
              ...(mainEnsembleRun.stageRole ? { stageRole: mainEnsembleRun.stageRole } : {}),
              ...(mainEnsembleRun.laneId ? { laneId: mainEnsembleRun.laneId } : {}),
              // Seat number for the renderer's "@Role #N" chip — same field the
              // service gate forwards. Guarded because legacy session snapshots
              // may predate `order` being required on EnsembleRunIdentity.
              ...(typeof mainEnsembleRun.order === 'number' &&
              Number.isInteger(mainEnsembleRun.order) &&
              mainEnsembleRun.order > 0
                ? { order: mainEnsembleRun.order }
                : {})
            }
          }
        : null
    const attributedTitle = mainAttribution?.title ?? request.title
    return new Promise((resolveApproval) => {
      const approvalService = deps.getApprovalService()
      if (!approvalService) {
        resolveApproval(false)
        return
      }
      const registered = approvalService.registerMain(approvalId, {
        provider,
        workspacePath: request.workspacePath,
        runId: routed.appRunId,
        appChatId: routed.appChatId,
        // Without these a paired device is offered Allow for a card reading
        // "Approval requested" — deciding on text it was never shown (the
        // exact failure the Gemini-tool registration documents). The desktop
        // never noticed: its modal reads title/body from the IPC payload
        // below, not from this registration.
        title: attributedTitle,
        body: request.body,
        remoteIncomplete: request.remoteIncomplete,
        allowedActions: actions,
        resolveAction: request.resolveAction,
        resolve: resolveApproval
      })
      if (registered === false) {
        resolveApproval(false)
        return
      }
      deps.runManager.registerApproval(routed.appRunId, approvalId)
      deps.scheduleApprovalTimeout({
        approvalId,
        provider,
        route: routed,
        isMainAuthority: true,
        kind: request.method
      })
      const approvalPayload = {
        provider,
        appRunId: routed.appRunId,
        appChatId: routed.appChatId,
        id: approvalId,
        approvalId,
        method: request.method,
        title: attributedTitle,
        body: request.body,
        preview: {
          ...(isRecord(request.preview) ? request.preview : {}),
          ...(mainAttribution ? { ensembleParticipant: mainAttribution.preview } : {}),
          actions
        },
        actions
      }
      const durableApprovalPayload = redactCanvasFillValueForDurableStorage(
        toolPermissionRetryApprovalPayloadForDurableStorage({
          ...approvalPayload,
          preview:
            redactAcpApprovalPreviewForDurableStorage(approvalPayload.preview) ??
            approvalPayload.preview
        })
      )
      deps.appendDurableRunEventForRoute(
        provider,
        routed,
        'approval_request',
        'control',
        attributedTitle,
        durableApprovalPayload
      )
      deps.recordApprovalLedgerRequest(provider, routed, durableApprovalPayload, {
        workspacePath: request.workspacePath,
        metadata: { mainAuthority: true }
      })
      deps.safeSendToSender(sender, 'agent-approval-request', approvalPayload)
      deps.notifyPairedDevicesOfApproval({
        approvalId,
        workspaceId: deps.workspaceIdForApprovalPush(request.workspacePath),
        threadId: routed.appChatId ?? routed.appRunId ?? approvalId,
        summary: attributedTitle
      })
    })
  }
}

export function createApprovalOrchestration(deps: RequestAgenticServiceApprovalDeps) {
  return async (
    sender: WebContents | null,
    provider: ProviderId,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    request: {
      method: string
      title: string
      body: string
      preview?: any
      runId?: string
      forcePrompt?: boolean
      externalPathDetection?: PendingExternalPathDetection
      resolveAction?: (action: AgentApprovalAction, decisionSource: 'user' | 'system') => void
      /**
       * Main-process-only receipt hook. It exposes the generated prompt id to
       * the executor so signed-elevated operations can bind execution to the
       * exact approval. The callback itself is never copied into durable data.
       */
      onApprovalPromptCreated?: (receipt: ApprovalPromptReceipt) => CanvasEvalApprovalReceipt | void
    }
  ): Promise<boolean> => {
    const session = deps.runManager.get(request.runId)
    if (deps.isApprovalAdmissionBlocked?.(request.runId, workspacePath, session?.appChatId))
      return false
    const settings = deps.getSettings()
    if (request.runId && (!session || deps.runManager.getClaimedTerminalStatus?.(request.runId))) {
      return false
    }
    const effectivePermissions = session?.state?.effectivePermissions as
      | EffectiveRunPermissions
      | undefined
    const workflowMode = (session?.state as { workflowMode?: unknown } | undefined)?.workflowMode
    const ensembleRun = session?.state?.ensembleRun as EnsembleRunIdentity | undefined
    const ensembleApproval = deps.ensembleApprovalContext(ensembleRun, service, workspacePath)
    // 1.0.4-AR3 — carry `appChatId` into every auto-decision so the
    // ledger row is filterable by chat without re-deriving via
    // `approvalRouteContext`. Pre-AR3 the central path passed only
    // `{ appRunId: request.runId }` while the Codex inline path
    // (index.ts:8716+) passed both, leaving Gemini / Claude / Kimi-
    // bridge rows missing the explicit chat-routing breadcrumb. The
    // session lookup already happened above, so the value is in
    // scope and free.
    const appChatId = session?.state?.appChatId
    const auditRoute = { appRunId: request.runId, ...(appChatId ? { appChatId } : {}) }
    const previewToolName =
      request.preview && typeof request.preview === 'object' && !Array.isArray(request.preview)
        ? request.preview.toolName
        : undefined
    const previewParams = isRecord(request.preview)
      ? (request.preview.params ?? request.preview.arguments)
      : undefined
    // The exact surface this request targets, read out of the preview the human
    // is shown — so the grant can only ever mean the window they actually saw.
    // Same shape as the canvas_eval exact-script read further down; the preview
    // is the one place that carries the tool's own args this far.
    const requestSurfaceId = ((): string | undefined => {
      const preview = isRecord(request.preview) ? request.preview : null
      const params = preview && isRecord(preview.params) ? preview.params : null
      const canvasId = params && typeof params.canvasId === 'string' ? params.canvasId.trim() : ''
      return canvasId || undefined
    })()
    const networkBlockedTool = deps.networkAccessBlockedToolName(
      previewToolName,
      effectivePermissions,
      previewParams
    )
    if (networkBlockedTool) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoDeny',
        'policy',
        'request',
        {
          policy: 'deny',
          networkAccess: 'deny',
          toolName: networkBlockedTool,
          rationale: 'Network access is disabled for this run.',
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
        }
      )
      deps.safeSendToSender(sender, 'agent-error', {
        provider,
        error: deps.networkAccessBlockedMessage(networkBlockedTool)
      })
      return false
    }
    const effectiveSettings = effectiveAgenticSettings(settings, effectivePermissions)
    const resolution = deps.permissionService.resolvePermission(
      provider,
      service,
      workspacePath,
      request.runId,
      effectiveSettings,
      requestSurfaceId
    )
    const { policy, workspaceGrantAllowed, sessionGrantAllowed, decision } = resolution
    // Universal read-only shell fast path: strict Git reads and commands the
    // canonical shell proof classifies as inspection-only are allowed under
    // EVERY posture (read_only / plan deny shell; default prompts). AntiGravity
    // also carries the user's exact standing authorization for the bounded
    // maintenance/introspection commands captured in its 2026-08-13 approval
    // screenshots; no other provider or spelling inherits that exception.
    // forcePrompt (caller-demanded human review) still prompts, and
    // policy-'allow' resolutions keep flowing through the ordinary audited
    // path below.
    if (service === 'shellCommands' && !request.forcePrompt && decision !== 'allow') {
      const readOnlyShellCommand = shellCommandFromApprovalPreview(request.preview)
      const shellFastPathReason =
        promptFreeReadOnlyShellReason(readOnlyShellCommand) ||
        (provider === 'antigravity' && isAntigravityUserAuthorizedShellCommand(readOnlyShellCommand)
          ? 'explicit_user_request'
          : null)
      if (shellFastPathReason) {
        deps.auditService.recordAutomaticApprovalDecision(
          provider,
          auditRoute,
          service,
          workspacePath,
          request,
          'autoAllow',
          shellFastPathReason,
          'request',
          {
            policy,
            command: readOnlyShellCommand,
            ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
          }
        )
        return true
      }
    }
    const planArtifactWriteMetadata = deps.planArtifactWriteApprovalMetadata({
      workflowMode,
      effectivePermissions,
      globalFileChangesPolicy: settings.agenticServices?.fileChanges,
      service,
      workspacePath,
      request
    })

    if (decision === 'deny' && planArtifactWriteMetadata) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        'plan_artifact',
        'request',
        { policy, ...planArtifactWriteMetadata }
      )
      deps.stampPlanArtifactPathOnPendingPlan(appChatId, planArtifactWriteMetadata)
      return true
    }

    if (decision === 'deny') {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoDeny',
        'policy',
        'request',
        { policy, ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {}) }
      )
      deps.safeSendToSender(sender, 'agent-error', {
        provider,
        error: agenticServiceBlockedMessage(service)
      })
      return false
    }

    // Phase J3: session-scoped YOLO override. Auto-allows every approval
    // for the rest of the process lifetime (or until the user disables
    // it). Sits AFTER the deny check above so an explicit user opt-out
    // for a service still wins — YOLO is "trust everything ask-policy
    // would have prompted for", not "bypass every guardrail". Audit
    // trail records the bypass with reason `session_yolo` so the user
    // can review what got auto-allowed.
    //
    // 1.0.72 — but YOLO must NOT loosen an explicit read-only run. The deny check
    // above already blocks file/shell, yet YOLO would otherwise auto-allow the
    // 'ask' services a read-only posture leaves open (mcpTools / subThreadDelegation)
    // — silently widening "read-only" into "trust everything". Skip the bypass for
    // read-only sessions so the posture is never weakened by a global toggle.
    // canvasEval (arbitrary eval = RCE) is signed-elevated: NEVER auto-allowed, not
    // even by session-YOLO or a grant. Every eval is individually human-approved
    // (deny above still wins). The Codex gate enforces the same via neverAutoAllow.
    // mediaRecording (future capture) shares the same non-grantable invariant: it is
    // never promoted above its default-deny by session-YOLO/grant/preset.
    // externalPublish is grantable, but read_only / plan keep it approval-only:
    // each publish action prompts, while workspace_write / trusted full_access
    // may auto-allow through the normal audited policy path.
    // plan-preset instruments (canvasInteraction/sketchCanvas/mediaEditing) are
    // approval-only:
    // a standing/session grant must NOT zero-click them under `plan` (standing
    // instrument grants are the conformance-gated W7-b rung), so they join
    // neverAutoAllow here — which forces the prompt on every auto-allow path below.
    const neverAutoAllow =
      service === 'canvasEval' ||
      service === 'mediaRecording' ||
      isPostureApprovalOnlyService(effectivePermissions?.presetId, service) ||
      isPlanInstrumentGrantHold(effectivePermissions?.presetId, service) ||
      // Isolate pinned-Shared: an ensemble seat's branch/worktree creation
      // always asks — the chat-level Isolate setting is user authority no
      // posture, grant, or YOLO may bypass. Ask-hold, not deny: unattended
      // lanes fail safe via the approval timeout.
      (service === 'shellCommands' &&
        isIsolateSharedBranchHold({
          service,
          shellCommand: shellCommandFromApprovalPreview(request.preview),
          isEnsembleRun: Boolean(ensembleRun),
          chat: deps.getChatById?.(appChatId)
        })) ||
      // Slices D/E per-tier shell holds (owner spec 2026-08-04): remote/SSH +
      // raw network egress always ask; `rm -r`-class always asks except a
      // provably in-workspace delete at Full Access; process mutation asks at
      // Full WS Access. Ask-holds, not denies — unattended lanes fail safe
      // via the approval timeout.
      (service === 'shellCommands' &&
        shellCommandTierHold({
          presetId: effectivePermissions?.presetId,
          service,
          shellCommand: shellCommandFromApprovalPreview(request.preview),
          workspacePath
        }))
    const trustedSessionExternalWrite =
      !request.forcePrompt &&
      !neverAutoAllow &&
      decision === 'allow' &&
      deps.canAutoApproveTrustedSessionExternalWrite({
        provider,
        workspacePath,
        session,
        effectivePermissions,
        externalPathDetection: request.externalPathDetection
      })
    if (trustedSessionExternalWrite) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        'trusted_session',
        'session',
        {
          policy,
          externalPathWrite: true,
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
        }
      )
      return true
    }
    // Slice E (owner spec 2026-08-04): outside-workspace READS auto-approve at
    // the write tiers — Full WS Access "auto-approve all reads outside
    // workspace unprompted", and Full Access is a strict superset. Writes keep
    // the external-path grant card. Audited like every automatic approval.
    const externalReadAutoAllowed =
      !request.forcePrompt &&
      !neverAutoAllow &&
      request.externalPathDetection?.access === 'read' &&
      (effectivePermissions?.presetId === 'workspace_write' ||
        effectivePermissions?.presetId === 'full_access')
    if (externalReadAutoAllowed) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        'external_read',
        'request',
        {
          policy,
          externalPathRead: true,
          externalPath: request.externalPathDetection?.path,
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
        }
      )
      return true
    }
    if (
      deps.isSessionYoloEffective() &&
      !effectivePermissions?.readOnly &&
      !request.forcePrompt &&
      !neverAutoAllow
    ) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        'session_yolo',
        'session',
        {
          policy,
          yoloEnabledAt: deps.sessionYoloState.enabledAt,
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
        }
      )
      return true
    }
    if (
      decision === 'allow' &&
      !request.externalPathDetection &&
      !request.forcePrompt &&
      !neverAutoAllow
    ) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        workspaceGrantAllowed
          ? 'workspace_grant'
          : sessionGrantAllowed
            ? 'session_grant'
            : 'policy',
        workspaceGrantAllowed ? 'workspace' : sessionGrantAllowed ? 'session' : 'request',
        { policy, ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {}) }
      )
      return true
    }
    const bossmanAutoMetadata = deps.bossmanAutoApprovalMetadata({
      session,
      ensembleRun,
      service,
      workspacePath,
      request,
      effectivePermissions,
      policy,
      decision,
      neverAutoAllow
    })
    if (bossmanAutoMetadata) {
      deps.auditService.recordAutomaticApprovalDecision(
        provider,
        auditRoute,
        service,
        workspacePath,
        request,
        'autoAllow',
        'bossman_auto',
        'request',
        {
          ...bossmanAutoMetadata,
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
        }
      )
      return true
    }
    if (!sender || sender.isDestroyed()) {
      return false
    }
    if (deps.isApprovalAdmissionBlocked?.(request.runId, workspacePath, session?.appChatId))
      return false

    const approvalId = Date.now() + '-' + Math.random().toString(36).slice(2)
    let canvasEvalApproval: CanvasEvalApprovalReceipt | undefined
    if (service === 'canvasEval') {
      const preview = isRecord(request.preview) ? request.preview : null
      const params = preview && isRecord(preview.params) ? preview.params : null
      const exactScript = params && typeof params.script === 'string' ? params.script : null
      if (exactScript === null || !request.onApprovalPromptCreated) {
        deps.safeSendToSender(sender, 'agent-error', {
          provider,
          error:
            'canvas_eval was blocked because its exact-script approval receipt could not be created.'
        })
        return false
      }
      try {
        const createdReceipt = request.onApprovalPromptCreated({ approvalId })
        canvasEvalApproval = assertCanvasEvalApprovalReceipt(
          exactScript,
          createdReceipt || undefined
        )
      } catch {
        deps.safeSendToSender(sender, 'agent-error', {
          provider,
          error:
            'canvas_eval was blocked because its approval receipt did not match the exact reviewed script.'
        })
        return false
      }
    } else {
      request.onApprovalPromptCreated?.({ approvalId })
    }
    const externalPathDetection = request.externalPathDetection
    const postureApprovalOnly = isPostureApprovalOnlyService(
      effectivePermissions?.presetId,
      service
    )
    const requestOnly =
      service === 'canvasEval' ||
      postureApprovalOnly ||
      isPlanInstrumentGrantHold(effectivePermissions?.presetId, service) ||
      (request.forcePrompt === true && !externalPathDetection)
    const actions: AgentApprovalAction[] = externalPathDetection
      ? ['grantExternalPathRead', 'grantExternalPathEdit', 'declineExternalPath']
      : requestOnly
        ? ['accept', 'decline', 'cancel']
        : approvalActionsForPolicy(policy, workspacePath, service)
    const baseTitle = externalPathDetection ? deps.externalPathApprovalTitle() : request.title
    const baseBody = externalPathDetection
      ? deps.externalPathApprovalBody(externalPathDetection)
      : request.body
    const title = ensembleApproval ? `${ensembleApproval.label}: ${baseTitle}` : baseTitle
    const body = ensembleApproval ? `${ensembleApproval.bodyPrefix}\n\n${baseBody}` : baseBody
    // Built from the preview's STRUCTURED fields, not from `body`: the remote
    // card gets 400 chars with newlines collapsed, and the desktop body leads
    // with a 600-char agent `intent` (the ensemble prefix alone eats 41%), so
    // reusing it truncated the recipients away entirely.
    const remoteSummary = buildRemoteApprovalSummary(request.preview)
    return new Promise((resolveApproval) => {
      const approvalService = deps.getApprovalService()
      if (!approvalService) {
        resolveApproval(false)
        return
      }
      const registered = approvalService.registerGeminiTool(approvalId, {
        provider,
        service,
        workspacePath,
        runId: request.runId,
        // Carried so an "allow for session" can be bound to the surface the user
        // was looking at. Without it the canvasId is lost between request and
        // response, and the grant reverts to meaning "every canvas".
        ...(requestSurfaceId ? { surfaceId: requestSurfaceId } : {}),
        // The same strings the desktop modal shows, so a paired device is
        // deciding on the same facts rather than a generic placeholder.
        title,
        body,
        ...(remoteSummary.text ? { remoteBody: remoteSummary.text } : {}),
        ...(remoteSummary.complete ? {} : { remoteIncomplete: true }),
        externalPathDetection,
        requestOnly,
        allowedActions: actions,
        resolveAction: request.resolveAction,
        resolve: resolveApproval
      })
      if (registered === false) {
        resolveApproval(false)
        return
      }
      deps.runManager.registerApproval(request.runId, approvalId)
      deps.scheduleApprovalTimeout({
        approvalId,
        provider,
        route: {
          appRunId: request.runId,
          appChatId: deps.runManager.get(request.runId)?.appChatId
        },
        kind: request.method
      })
      const approvalPayload = {
        provider,
        service,
        appRunId: session?.runId,
        appChatId: session?.appChatId,
        id: approvalId,
        approvalId,
        method: request.method,
        title,
        body,
        preview: {
          ...(request.preview || {}),
          ...(service === 'canvasEval'
            ? {
                securityClass: 'signed-elevated',
                requiresExactDesktopReview: true,
                toolName: 'canvas_eval'
              }
            : {}),
          actions,
          ...(requestOnly
            ? {
                requestOnly: true,
                requestOnlyReason: postureApprovalOnly
                  ? 'run-posture-approval-only'
                  : 'This approval is per-call only; session/workspace grants are disabled for this request.'
              }
            : {}),
          ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {}),
          ...(externalPathDetection
            ? {
                externalPathDetection: deps.externalPathApprovalPreview(externalPathDetection)
              }
            : {})
        },
        actions
      }
      const durableApprovalPayload = redactCanvasFillValueForDurableStorage(
        canvasEvalApprovalPayloadForDurableStorage(
          service,
          {
            ...approvalPayload,
            preview:
              service === 'canvasEval'
                ? approvalPayload.preview
                : (redactAcpApprovalPreviewForDurableStorage(approvalPayload.preview) ??
                  approvalPayload.preview)
          },
          approvalId,
          canvasEvalApproval || undefined
        )
      )
      const durableCanvasPreview = isRecord(durableApprovalPayload.preview)
        ? durableApprovalPayload.preview
        : null
      const liveApprovalPayload =
        service === 'canvasEval' && durableCanvasPreview?.canvasEvalReceipt
          ? {
              ...approvalPayload,
              preview: {
                ...approvalPayload.preview,
                canvasEvalReceipt: durableCanvasPreview.canvasEvalReceipt
              }
            }
          : approvalPayload
      deps.appendDurableRunEventForRoute(
        provider,
        { appRunId: session?.runId, appChatId: session?.appChatId },
        'approval_request',
        'control',
        title,
        durableApprovalPayload,
        undefined,
        canvasEvalApproval || undefined
      )
      deps.recordApprovalLedgerRequest(
        provider,
        { appRunId: session?.runId, appChatId: session?.appChatId },
        durableApprovalPayload,
        {
          service,
          workspacePath,
          metadata: {
            policy,
            ...(ensembleApproval ? { ensembleParticipant: ensembleApproval.preview } : {})
          },
          canvasEvalApproval: canvasEvalApproval || undefined
        }
      )
      deps.safeSendToSender(sender, 'agent-approval-request', liveApprovalPayload)
      // Fan out a wake-push to any paired iOS device so the user can
      // approve the agentic-service request away from the desktop.
      deps.notifyPairedDevicesOfApproval({
        approvalId,
        workspaceId: deps.workspaceIdForApprovalPush(workspacePath),
        threadId: session?.appChatId ?? request.runId ?? approvalId,
        summary: title
      })
    })
  }
}
