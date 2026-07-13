import type { ChildProcess } from 'child_process'
import type {
  AgentApprovalAction,
  AgenticServiceId,
  ProviderId,
  RunEventKind,
  RunEventPhase
} from '../store/types'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import type { RunManager } from '../RunManager'
import type { PermissionService } from '../PermissionService'
import type { ApprovalTimeoutScheduler, ApprovalTimeoutReason } from '../ApprovalTimeoutScheduler'
import type { BridgeApnsPusher } from '../BridgeApnsPusher'
import type { BridgeApnsTokenStore } from '../BridgeApnsTokenStore'
import { buildMobileApprovalCard, type MobileApprovalCard } from '../RemoteTaskProjection'
import { RemoteAttentionApnsFanout } from '../RemoteAttentionApnsFanout'

/**
 * ApprovalService — Phase B3 extraction.
 *
 * Owns the five pending-approval registries that connect agent
 * runtime side-channels (Codex JSON-RPC, Kimi wire protocol,
 * Gemini tool prompts, TaskWraith main-authority approvals, host-
 * command rerun prompts) to the unified decision-resolution flow.
 *
 * Before B3 these registries were scattered across `index.ts` at
 * module scope with the dispatch logic inline in `whenReady`. The
 * extraction:
 *   - Makes the dispatch testable with mocked deps.
 *   - Puts the wake-push + auto-deny timer integration in one place.
 *   - Establishes the seam where future approval-policy changes
 *     (per-pair preferences, push throttling, approval delegation
 *     hand-offs to a planner agent) land.
 *
 * **What's in scope here:**
 *   - The 5 registries
 *   - `resolve(approvalId, action, options)` — the unified dispatch
 *     that walks all 5 registries and runs provider-specific
 *     completion (matches the previous inline behaviour byte-for-
 *     byte)
 *   - `lookupRoute(approvalId)` — finds the route a pending approval
 *     belongs to (used by the timeout callback)
 *   - `notifyPairedDevicesOfApproval(...)` — APNs wake-push fan-out
 *     gated by the idle detector
 *   - `workspaceIdForPush(...)` — workspace path → id lookup helper
 *   - `scheduleTimeout(...)` — wraps the scheduler with the
 *     user-settings-aware policy resolution
 *
 * **What's NOT in scope (still in index.ts after B3):**
 *   - `resolveApprovalLedgerResponse` / `recordAutomaticApprovalDecision`
 *     — thin wrappers around PermissionService/AppStore that are
 *     called from many places (runXxxProvider, the auto-allow path
 *     in `requestAgenticServiceApproval`, etc.). Moving them ripples
 *     too broadly for this slice; the service consumes them via
 *     injected deps. A follow-up can fold them in.
 *   - The `ApprovalTimeoutScheduler` construction (the `onTimeout`
 *     callback closes over `processAgentApprovalResponse` → kept
 *     near the service wiring for readability).
 *
 * **Behaviour-preservation contract:**
 *   - Every IPC handler that today calls `processAgentApprovalResponse`
 *     now calls `approvalService.resolve(...)` and gets the SAME
 *     boolean return + the SAME side effects (durable event, ledger
 *     update, provider-specific completion).
 *   - The auto-deny timer still passes `decisionSource: 'system'` +
 *     `extraMetadata` (Phase E1.2 contract).
 *   - The wake-push fan-out + the durable-event audit trail
 *     produce identical outputs.
 */

// ──────────────────────────────────────────────────────────────────
// Registry payload types — exported so callers can build them.
// ──────────────────────────────────────────────────────────────────

export interface PendingMainApproval {
  provider: ProviderId
  workspacePath?: string
  runId?: string
  allowedActions?: AgentApprovalAction[]
  resolveAction?: (action: AgentApprovalAction) => void
  resolve: (allowed: boolean) => void
}

export interface PendingGeminiToolApproval {
  provider: ProviderId
  service: AgenticServiceId
  workspacePath?: string
  runId?: string
  externalPathDetection?: PendingExternalPathDetection
  requestOnly?: boolean
  allowedActions?: AgentApprovalAction[]
  resolve: (allowed: boolean) => void
}

export interface PendingExternalPathDetection {
  provider: ProviderId
  path: string
  access: 'read' | 'write'
  basename?: string
  appChatId?: string
}

export interface PendingCodexApproval {
  rpcId: number | string
  method: string
  params: unknown
  service?: AgenticServiceId
  workspacePath?: string
  runId?: string
  allowedActions?: AgentApprovalAction[]
  /**
   * Slice 5 of the external-path-redesign arc. Populated by the
   * registration site (`main/index.ts` Codex elicitation handler)
   * when `detectExternalPath` flagged the tool call as referencing
   * a path outside the workspace. The slice-5.2 resolver reads this
   * payload to issue + persist a signed grant when the user clicks
   * `grantExternalPathRead` / `grantExternalPathEdit` in the modal.
   */
  externalPathDetection?: PendingExternalPathDetection
}

export interface PendingKimiApproval {
  child: ChildProcess
  rpcId: number | string
  params: unknown
  service?: AgenticServiceId
  workspacePath?: string
  runId?: string
  allowedActions?: AgentApprovalAction[]
  externalPathDetection?: PendingExternalPathDetection
}

export interface PendingHostCommandApproval {
  sender: Electron.WebContents
  provider: 'codex'
  command: unknown
  commandText: string
  cwd: string
  workspacePath?: string
  threadId: string
  model: string
  /** Concrete Codex wire effort from the turn that requested this rerun. */
  reasoningEffort?: string
  appRunId?: string
  appChatId?: string
  allowedActions?: AgentApprovalAction[]
  reason: string
  output: string
}

export interface ApprovalRouteLookup {
  provider: ProviderId
  appRunId?: string
  appChatId?: string
}

export interface ResolveOptions {
  /** Typed user input (Codex elicitation / requestUserInput). */
  userInput?: string
  /** Phase E1.2: 'user' vs 'system' for auto-deny attribution. */
  decisionSource?: 'user' | 'system'
  /** Phase E1.2: merged into the ledger record. */
  extraMetadata?: Record<string, unknown>
}

export interface ScheduleTimeoutArgs {
  approvalId: string
  provider: ProviderId
  route?: AgentRunRoute | null
  isMainAuthority?: boolean
  kind?: string
}

export type ApprovalRunEventType = 'approval_pending' | 'approval_resolved'

export interface ApprovalRunEvent {
  type: ApprovalRunEventType
  approvalId: string
  provider: ProviderId
  workspaceId: string
  threadId: string
  appRunId?: string
  appChatId?: string
  action?: AgentApprovalAction
  decisionSource?: 'user' | 'system'
}

// ──────────────────────────────────────────────────────────────────
// Injected dependencies.
// ──────────────────────────────────────────────────────────────────

export interface ApprovalServiceDeps {
  /** Run-state tracking (resolveApproval, get, clearApproval). */
  runManager: RunManager<unknown>
  /** Per-action decision + grant management. */
  permissionService: PermissionService
  /** Durable run-event writer for audit traces. */
  appendDurableRunEventForRoute: (
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    kind: RunEventKind,
    phase: RunEventPhase,
    title: string,
    payload?: unknown
  ) => void
  /** Ledger response writer (Phase E1.2 thread-through). */
  resolveApprovalLedger: (
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system',
    extraMetadata: Record<string, unknown>
  ) => void
  /** Codex RPC client accessor (or null when not running). */
  getCodexClient: () => {
    respond: (rpcId: number | string, payload: unknown) => void
    reject: (rpcId: number | string, reason: string) => void
  } | null
  /** Send a compat-line frame to a renderer (used by host-command
   * decline path). The `state` arg matches the existing function's
   * `route?: AgentRunRoute | null` shape — host-command callers pass
   * the approval record (which has `appRunId` / `appChatId`). */
  sendAgentCompatLine: (
    sender: Electron.WebContents,
    provider: ProviderId,
    line: unknown,
    state?: AgentRunRoute | null
  ) => void
  /** Reply to a pending Kimi wire request. */
  respondToKimiWireRequest: (child: ChildProcess, rpcId: number | string, result: unknown) => void
  /** Execute a previously-pending host command. */
  runApprovedHostCommand: (approvalId: string) => Promise<boolean>
  /** Active CLI provider processes (for Kimi cancel kill cleanup). */
  cliProviderProcesses: Map<ProviderId, ChildProcess>
  /** APNs pusher (or null when not configured). */
  getApnsPusher: () => BridgeApnsPusher | null
  /** APNs token store (or null when not yet ready). */
  getApnsTokenStore: () => BridgeApnsTokenStore | null
  /** Idle detector — when true, suppresses wake-push (user is here). */
  isUserAtDesktop: () => boolean
  /** Workspace path → workspace id mapping. */
  workspaceIdForPath: (workspacePath: string | undefined) => string | null
  /** Bridge-only run-event publisher for Live Activity approval counts. */
  publishApprovalRunEvent: (event: ApprovalRunEvent) => void
  /** Settings lookup for the user-tunable timeout policy. */
  getApprovalTimeoutSettings: () => {
    enabled: boolean
    perProviderMs: Record<ProviderId, number>
    mainAuthorityMs: number
  }
  /** Logger sink. */
  log: (line: string) => void
}

// ──────────────────────────────────────────────────────────────────
// Service.
// ──────────────────────────────────────────────────────────────────

export class ApprovalService {
  private pendingMain = new Map<string, PendingMainApproval>()
  private pendingGeminiTool = new Map<string, PendingGeminiToolApproval>()
  private pendingCodex = new Map<string, PendingCodexApproval>()
  private pendingKimi = new Map<string, PendingKimiApproval>()
  private pendingHostCommand = new Map<string, PendingHostCommandApproval>()
  private scheduler: ApprovalTimeoutScheduler | null = null
  private readonly remoteAttentionFanout: RemoteAttentionApnsFanout

  constructor(private deps: ApprovalServiceDeps) {
    this.remoteAttentionFanout = new RemoteAttentionApnsFanout({
      getTokenStore: deps.getApnsTokenStore,
      getPusher: deps.getApnsPusher,
      isUserAtDesktop: deps.isUserAtDesktop,
      log: deps.log
    })
  }

  /** Late-bound scheduler injection. The scheduler's `onTimeout`
   * callback closes over the service (it calls `resolve(...)` on
   * timeout), creating a constructor-time dependency cycle. The
   * caller constructs the service first, then the scheduler, then
   * wires them together with this method. */
  setScheduler(scheduler: ApprovalTimeoutScheduler): void {
    this.scheduler = scheduler
  }

  // ──── registration ─────────────────────────────────────────────

  registerMain(approvalId: string, info: PendingMainApproval): void {
    this.pendingMain.set(approvalId, info)
    this.emitApprovalRunEvent('approval_pending', approvalId, info.provider, {
      appRunId: info.runId,
      workspacePath: info.workspacePath
    })
  }

  registerGeminiTool(approvalId: string, info: PendingGeminiToolApproval): void {
    this.pendingGeminiTool.set(approvalId, info)
    this.emitApprovalRunEvent('approval_pending', approvalId, info.provider, {
      appRunId: info.runId,
      workspacePath: info.workspacePath
    })
  }

  registerCodex(approvalId: string, info: PendingCodexApproval): void {
    this.pendingCodex.set(approvalId, info)
    this.emitApprovalRunEvent('approval_pending', approvalId, 'codex', {
      appRunId: info.runId,
      workspacePath: info.workspacePath
    })
  }

  /**
   * Slice 5 v2: peek at the pending Codex approval's externalPathDetection
   * payload. The `respond-agent-approval` IPC handler reads this BEFORE
   * resolving so it can issue + persist a signed grant when the user
   * clicks `grantExternalPathRead` / `grantExternalPathEdit` in the modal.
   * Returns undefined when the approval isn't registered or wasn't an
   * external-path prompt.
   */
  getPendingExternalPathDetection(approvalId: string): PendingExternalPathDetection | undefined {
    return (
      this.pendingCodex.get(approvalId)?.externalPathDetection ||
      this.pendingGeminiTool.get(approvalId)?.externalPathDetection ||
      this.pendingKimi.get(approvalId)?.externalPathDetection
    )
  }

  registerKimi(approvalId: string, info: PendingKimiApproval): void {
    this.pendingKimi.set(approvalId, info)
    this.emitApprovalRunEvent('approval_pending', approvalId, 'kimi', {
      appRunId: info.runId,
      workspacePath: info.workspacePath
    })
  }

  registerHostCommand(approvalId: string, info: PendingHostCommandApproval): void {
    this.pendingHostCommand.set(approvalId, info)
    this.emitApprovalRunEvent('approval_pending', approvalId, info.provider, {
      appRunId: info.appRunId,
      appChatId: info.appChatId,
      workspacePath: info.workspacePath,
      threadId: info.threadId
    })
  }

  // ──── accessors for callers that need to peek at registry state ──

  getHostCommand(approvalId: string): PendingHostCommandApproval | undefined {
    return this.pendingHostCommand.get(approvalId)
  }

  deleteHostCommand(approvalId: string): void {
    this.pendingHostCommand.delete(approvalId)
  }

  has(approvalId: string): boolean {
    return (
      this.pendingMain.has(approvalId) ||
      this.pendingGeminiTool.has(approvalId) ||
      this.pendingCodex.has(approvalId) ||
      this.pendingKimi.has(approvalId) ||
      this.pendingHostCommand.has(approvalId)
    )
  }

  /** Scope (workspace/thread) of a pending approval — for the bridge
   * ownership validator. An allowlisted device must not resolve a tool-call
   * approval outside the workspace/thread it presented (the approval id is
   * resolved GLOBALLY by the executor, so the boundary lives here). Reuses
   * the exact projection derivation. Returns null if the id isn't pending. */
  approvalScope(
    approvalId: string
  ): { workspaceId?: string; threadId?: string } | null {
    const card = this.listProjectionCards().find((c) => c.toolCallId === approvalId)
    if (!card) return null
    return {
      workspaceId: card.workspaceId ?? undefined,
      threadId: card.threadId
    }
  }

  listProjectionCards(): MobileApprovalCard[] {
    const cards: MobileApprovalCard[] = []
    for (const [approvalId, info] of this.pendingMain.entries()) {
      cards.push(
        this.projectApprovalCard(approvalId, info.provider, {
          workspacePath: info.workspacePath,
          runId: info.runId,
          title: 'Approval requested',
          body: 'Main-process approval is waiting for a decision.',
          allowedActions: info.allowedActions
        })
      )
    }
    for (const [approvalId, info] of this.pendingGeminiTool.entries()) {
      cards.push(
        this.projectApprovalCard(approvalId, info.provider, {
          workspacePath: info.workspacePath,
          runId: info.runId,
          title: `${info.service} approval requested`,
          body: 'Gemini requested a gated tool or workspace action.',
          allowedActions: info.allowedActions
        })
      )
    }
    for (const [approvalId, info] of this.pendingCodex.entries()) {
      cards.push(
        this.projectApprovalCard(approvalId, 'codex', {
          workspacePath: info.workspacePath,
          runId: info.runId,
          title: String(info.method || info.service || 'Codex approval requested'),
          body: compactJSON(info.params),
          allowedActions: info.allowedActions
        })
      )
    }
    for (const [approvalId, info] of this.pendingKimi.entries()) {
      cards.push(
        this.projectApprovalCard(approvalId, 'kimi', {
          workspacePath: info.workspacePath,
          runId: info.runId,
          title: 'Kimi approval requested',
          body: compactJSON(info.params),
          allowedActions: info.allowedActions
        })
      )
    }
    for (const [approvalId, info] of this.pendingHostCommand.entries()) {
      cards.push(
        this.projectApprovalCard(approvalId, info.provider, {
          workspacePath: info.workspacePath,
          runId: info.appRunId,
          threadId: info.appChatId || info.threadId,
          title: 'Run host command',
          body: `${info.commandText}\n${info.cwd}`,
          allowedActions: info.allowedActions
        })
      )
    }
    return cards
  }

  // ──── route lookup ─────────────────────────────────────────────

  /** Phase E1.2: find which provider's registry holds an approval
   * id, and what its route is. Used by the timeout callback. */
  lookupRoute(approvalId: string): ApprovalRouteLookup | null {
    const main = this.pendingMain.get(approvalId)
    if (main) {
      const session = this.deps.runManager.get(main.runId)
      return { provider: main.provider, appRunId: main.runId, appChatId: session?.appChatId }
    }
    const gemini = this.pendingGeminiTool.get(approvalId)
    if (gemini) {
      const session = this.deps.runManager.get(gemini.runId)
      return { provider: gemini.provider, appRunId: gemini.runId, appChatId: session?.appChatId }
    }
    const host = this.pendingHostCommand.get(approvalId)
    if (host) {
      return { provider: host.provider, appRunId: host.appRunId, appChatId: host.appChatId }
    }
    const kimi = this.pendingKimi.get(approvalId)
    if (kimi) {
      const session = this.deps.runManager.get(kimi.runId)
      return { provider: 'kimi', appRunId: kimi.runId, appChatId: session?.appChatId }
    }
    const codex = this.pendingCodex.get(approvalId)
    if (codex) {
      const session = this.deps.runManager.get(codex.runId)
      return { provider: 'codex', appRunId: codex.runId, appChatId: session?.appChatId }
    }
    return null
  }

  private projectApprovalCard(
    approvalId: string,
    provider: ProviderId,
    input: {
      workspacePath?: string
      runId?: string
      threadId?: string
      title: string
      body?: string
      allowedActions?: AgentApprovalAction[]
    }
  ): MobileApprovalCard {
    const session = input.runId ? this.deps.runManager.get(input.runId) : undefined
    const workspacePath = input.workspacePath ?? session?.workspacePath
    // Stamp the REAL armed auto-deny deadline (per-provider user setting,
    // per-kind overrides included) so remote clients can show a countdown
    // that matches what the desktop will actually do. Absent when timeouts
    // are disabled — the phone then shows no expiry.
    const deadline = this.scheduler?.deadlineFor(approvalId)
    return buildMobileApprovalCard({
      toolCallId: approvalId,
      threadId: input.threadId || session?.appChatId || input.runId,
      workspaceId: workspacePath ? this.deps.workspaceIdForPath(workspacePath) : undefined,
      workspacePath,
      runId: input.runId,
      provider,
      title: input.title,
      body: input.body,
      actions: input.allowedActions,
      expiresAt: deadline ? new Date(deadline).toISOString() : undefined
    })
  }

  // ──── scheduling ───────────────────────────────────────────────

  /** Arm an auto-deny timer for the approval. Reads user settings
   * on every call so live setting changes take effect on the next
   * approval. Best-effort: silent no-op when disabled. */
  scheduleTimeout(args: ScheduleTimeoutArgs): void {
    if (!this.scheduler) return
    if (
      process.env.TASKWRAITH_APPROVAL_TIMEOUT_OFF === '1' ||
      process.env.TASKWRAITH_APPROVAL_TIMEOUT_OFF === 'true'
    ) {
      return
    }
    const userSettings = this.deps.getApprovalTimeoutSettings()
    if (!userSettings.enabled) return
    this.scheduler.updatePolicy({
      defaultTimeoutsMs: {
        gemini: userSettings.perProviderMs.gemini,
        codex: userSettings.perProviderMs.codex,
        claude: userSettings.perProviderMs.claude,
        kimi: userSettings.perProviderMs.kimi,
        grok: userSettings.perProviderMs.grok,
        cursor: userSettings.perProviderMs.cursor,
        ollama: userSettings.perProviderMs.ollama
      },
      mainTimeoutMs: userSettings.mainAuthorityMs
    })
    const { appliedMs, source } = this.scheduler.schedule({
      approvalId: args.approvalId,
      provider: args.provider,
      isMainAuthority: args.isMainAuthority,
      kind: args.kind
    })
    if (args.route?.appRunId) {
      try {
        this.deps.appendDurableRunEventForRoute(
          args.provider,
          args.route,
          'approval_timer_armed',
          'control',
          `Approval timer armed: ${appliedMs}ms`,
          {
            approvalId: args.approvalId,
            appliedMs,
            source,
            isMainAuthority: args.isMainAuthority === true,
            kind: args.kind
          }
        )
      } catch {
        // best-effort
      }
    }
  }

  // ──── wake-push to paired iOS devices ──────────────────────────

  /** Phase C5+E. Fan out a generic APNs attention push to every paired
   * iOS device when the user is away from the desktop. Best-effort:
   * never throws; missing pusher / no tokens / user-at-desktop are all
   * silent no-ops. The approval summary is intentionally ignored here:
   * APNs payloads carry routing identifiers only, never command text,
   * paths, diffs, prompts, or approval summaries. */
  notifyPairedDevices(args: {
    approvalId: string
    workspaceId: string | null
    threadId: string
    summary: string
  }): void {
    void args.summary
    this.remoteAttentionFanout.notify({
      reason: 'approval',
      workspaceId: args.workspaceId,
      threadId: args.threadId,
      approvalId: args.approvalId
    })
  }

  /** Workspace path → opaque id, or null when no privacy-safe id exists. */
  workspaceIdForPush(workspacePath: string | undefined): string | null {
    return this.deps.workspaceIdForPath(workspacePath)
  }

  // ──── the unified resolve dispatch ─────────────────────────────

  /** Walk all 5 registries, run provider-specific completion, and
   * report success. Matches the previous inline
   * `processAgentApprovalResponse` byte-for-byte. */
  async resolve(
    requestId: string,
    action: AgentApprovalAction,
    options?: ResolveOptions
  ): Promise<boolean> {
    const decisionSource = options?.decisionSource ?? 'user'
    const extraMetadata = options?.extraMetadata ?? {}

    // ── Main authority approval ─────────────────────────────────
    const pendingMain = this.pendingMain.get(requestId)
    if (pendingMain) {
      const effectiveMainAction = this.resolveEffectiveApprovalAction(
        requestId,
        action,
        pendingMain.allowedActions
      )
      if (!effectiveMainAction) return false
      action = effectiveMainAction
      // Cancel the auto-deny timer the moment a valid decision lands.
      this.scheduler?.cancel(requestId)
      const session =
        this.deps.runManager.resolveApproval(requestId) ||
        this.deps.runManager.get(pendingMain.runId)
      this.deps.appendDurableRunEventForRoute(
        pendingMain.provider,
        { appRunId: session?.runId || pendingMain.runId, appChatId: session?.appChatId },
        'approval_response',
        'control',
        `Main approval response: ${action}`,
        { requestId, action, workspacePath: pendingMain.workspacePath }
      )
      this.deps.resolveApprovalLedger(requestId, action, decisionSource, extraMetadata)
      this.emitApprovalRunEvent('approval_resolved', requestId, pendingMain.provider, {
        appRunId: session?.runId || pendingMain.runId,
        appChatId: session?.appChatId,
        workspacePath: pendingMain.workspacePath,
        action,
        decisionSource
      })
      this.pendingMain.delete(requestId)
      this.deps.runManager.clearApproval(requestId)
      pendingMain.resolveAction?.(action)
      const allowed =
        action === 'useProviderNative'
          ? true
          : action === 'useTaskWraithSubthread'
            ? false
            : this.deps.permissionService.isApprovedAction(action)
      pendingMain.resolve(allowed)
      return true
    }

    // ── Gemini tool approval ────────────────────────────────────
    const pendingGeminiTool = this.pendingGeminiTool.get(requestId)
    if (pendingGeminiTool) {
      const effectiveToolAction = this.resolveEffectiveApprovalAction(
        requestId,
        action,
        pendingGeminiTool.allowedActions
      )
      if (!effectiveToolAction) return false
      action = effectiveToolAction
      this.scheduler?.cancel(requestId)
      const resolvedAction =
        pendingGeminiTool.requestOnly &&
        (action === 'acceptForSession' || action === 'acceptForWorkspace')
          ? 'accept'
          : action
      const session =
        this.deps.runManager.resolveApproval(requestId) ||
        this.deps.runManager.get(pendingGeminiTool.runId)
      this.deps.appendDurableRunEventForRoute(
        pendingGeminiTool.provider,
        { appRunId: session?.runId || pendingGeminiTool.runId, appChatId: session?.appChatId },
        'approval_response',
        'control',
        `Approval response: ${resolvedAction}`,
        {
          requestId,
          action: resolvedAction,
          requestedAction: action,
          service: pendingGeminiTool.service,
          workspacePath: pendingGeminiTool.workspacePath,
          requestOnly: pendingGeminiTool.requestOnly
        }
      )
      this.deps.resolveApprovalLedger(requestId, resolvedAction, decisionSource, {
        ...extraMetadata,
        ...(resolvedAction !== action ? { requestedAction: action, requestOnly: true } : {})
      })
      this.emitApprovalRunEvent('approval_resolved', requestId, pendingGeminiTool.provider, {
        appRunId: session?.runId || pendingGeminiTool.runId,
        appChatId: session?.appChatId,
        workspacePath: pendingGeminiTool.workspacePath,
        action: resolvedAction,
        decisionSource
      })
      this.pendingGeminiTool.delete(requestId)
      this.deps.runManager.clearApproval(requestId)
      const allowed = this.deps.permissionService.applyApprovalDecision({
        provider: pendingGeminiTool.provider,
        workspacePath: pendingGeminiTool.workspacePath,
        service: pendingGeminiTool.service,
        runId: pendingGeminiTool.runId,
        action: resolvedAction
      })
      pendingGeminiTool.resolve(allowed)
      return true
    }

    // ── Host command rerun approval ─────────────────────────────
    const pendingHostCommand = this.pendingHostCommand.get(requestId)
    if (pendingHostCommand) {
      const effectiveHostAction = this.resolveEffectiveApprovalAction(
        requestId,
        action,
        pendingHostCommand.allowedActions
      )
      if (!effectiveHostAction) return false
      action = effectiveHostAction
      this.scheduler?.cancel(requestId)
      this.deps.appendDurableRunEventForRoute(
        pendingHostCommand.provider,
        { appRunId: pendingHostCommand.appRunId, appChatId: pendingHostCommand.appChatId },
        'approval_response',
        'control',
        `Host command rerun response: ${action}`,
        {
          requestId,
          action,
          command: pendingHostCommand.commandText,
          cwd: pendingHostCommand.cwd
        }
      )
      this.deps.resolveApprovalLedger(requestId, action, decisionSource, extraMetadata)
      this.emitApprovalRunEvent('approval_resolved', requestId, pendingHostCommand.provider, {
        appRunId: pendingHostCommand.appRunId,
        appChatId: pendingHostCommand.appChatId,
        workspacePath: pendingHostCommand.workspacePath,
        threadId: pendingHostCommand.threadId,
        action,
        decisionSource
      })
      this.deps.runManager.clearApproval(requestId)
      if (action === 'accept') {
        return this.deps.runApprovedHostCommand(requestId)
      }
      this.pendingHostCommand.delete(requestId)
      this.deps.sendAgentCompatLine(
        pendingHostCommand.sender,
        'codex',
        {
          type: 'tool_result',
          tool_id: `${requestId}-denied`,
          tool_name: 'run_shell_command',
          status: 'warning',
          output: `User ${action}ed host rerun of ${pendingHostCommand.commandText}.`,
          provider: 'codex'
        },
        pendingHostCommand
      )
      return true
    }

    // ── Kimi wire approval ──────────────────────────────────────
    const pendingKimi = this.pendingKimi.get(requestId)
    if (pendingKimi) {
      const effectiveKimiAction = this.resolveEffectiveApprovalAction(
        requestId,
        action,
        pendingKimi.allowedActions
      )
      if (!effectiveKimiAction) return false
      action = effectiveKimiAction
      this.scheduler?.cancel(requestId)
      const session =
        this.deps.runManager.resolveApproval(requestId) ||
        this.deps.runManager.get(pendingKimi.runId)
      this.deps.appendDurableRunEventForRoute(
        'kimi',
        { appRunId: session?.runId || pendingKimi.runId, appChatId: session?.appChatId },
        'approval_response',
        'control',
        `Kimi approval response: ${action}`,
        {
          requestId,
          action,
          rpcId: pendingKimi.rpcId,
          params: pendingKimi.params,
          service: pendingKimi.service,
          workspacePath: pendingKimi.workspacePath
        }
      )
      this.deps.resolveApprovalLedger(requestId, action, decisionSource, extraMetadata)
      this.emitApprovalRunEvent('approval_resolved', requestId, 'kimi', {
        appRunId: session?.runId || pendingKimi.runId,
        appChatId: session?.appChatId,
        workspacePath: pendingKimi.workspacePath,
        action,
        decisionSource
      })
      this.pendingKimi.delete(requestId)
      this.deps.runManager.clearApproval(requestId)
      const allowed = this.deps.permissionService.applyApprovalDecision({
        provider: 'kimi',
        workspacePath: pendingKimi.workspacePath,
        service: pendingKimi.service,
        runId: pendingKimi.runId,
        action
      })
      const params = pendingKimi.params as { payload?: { id?: string } } | null
      const payload = params?.payload || {}
      const response = allowed
        ? action === 'acceptForSession' || action === 'acceptForWorkspace'
          ? 'approve_for_session'
          : 'approve'
        : 'reject'
      this.deps.respondToKimiWireRequest(pendingKimi.child, pendingKimi.rpcId, {
        request_id: payload.id || requestId,
        response,
        ...(response === 'reject' ? { feedback: `User ${action}ed Kimi approval request.` } : {})
      })
      if (action === 'cancel') {
        pendingKimi.child.kill()
        this.deps.cliProviderProcesses.delete('kimi')
      }
      return true
    }

    // ── Codex approval (the most complex path) ──────────────────
    const pending = this.pendingCodex.get(requestId)
    const codexClient = this.deps.getCodexClient()
    if (!pending || !codexClient) {
      return false
    }
    const effectiveCodexAction = this.resolveEffectiveApprovalAction(
      requestId,
      action,
      pending.allowedActions
    )
    if (!effectiveCodexAction) return false
    action = effectiveCodexAction
    this.scheduler?.cancel(requestId)
    const session =
      this.deps.runManager.resolveApproval(requestId) || this.deps.runManager.get(pending.runId)
    this.deps.appendDurableRunEventForRoute(
      'codex',
      { appRunId: session?.runId || pending.runId, appChatId: session?.appChatId },
      'approval_response',
      'control',
      `Codex approval response: ${action}`,
      {
        requestId,
        action,
        rpcId: pending.rpcId,
        method: pending.method,
        service: pending.service,
        workspacePath: pending.workspacePath
      }
    )
    this.deps.resolveApprovalLedger(requestId, action, decisionSource, extraMetadata)
    this.emitApprovalRunEvent('approval_resolved', requestId, 'codex', {
      appRunId: session?.runId || pending.runId,
      appChatId: session?.appChatId,
      workspacePath: pending.workspacePath,
      action,
      decisionSource
    })
    this.pendingCodex.delete(requestId)
    this.deps.runManager.clearApproval(requestId)

    const params = pending.params as { permissions?: unknown } | null

    if (pending.method === 'item/permissions/requestApproval') {
      const allowed = this.deps.permissionService.applyApprovalDecision({
        provider: 'codex',
        workspacePath: pending.workspacePath,
        service: pending.service,
        runId: pending.runId,
        action
      })
      if (allowed) {
        codexClient.respond(pending.rpcId, {
          permissions: params?.permissions || {},
          scope: action === 'accept' ? 'turn' : 'session'
        })
      } else {
        codexClient.reject(pending.rpcId, `User ${action}ed Codex permission request.`)
      }
      return true
    }

    // Codex CLI's elicitation method name varies by version:
    //   - Older builds:  `mcp/elicitation/request`
    //   - Newer builds:  `mcpServer/elicitation/request`
    //     (deserialised on the Codex side as `McpServerElicitationRequest`)
    // The response shape is the same `{ action, content, _meta }` either way.
    // Without matching both, the resolve path falls through to the generic
    // `{ decision: action }` shape below, which Codex's
    // `McpServerElicitationRequestResponse` deserialiser rejects with
    // `missing field 'action'` — and the tool call comes back as
    // `user rejected MCP tool call` even though the user clicked Accept.
    // Symptom seen in the wild: Codex agents invoking
    // `delegate_to_subthread` always got auto-rejected after the new
    // prompt-level fix made them actually try the tool. See
    // ~/Library/Logs/TaskWraith/bridge-subprocess.log + the codex run's
    // raw events stream for `mcpServer/elicitation/request`.
    if (
      pending.method === 'mcp/elicitation/request' ||
      pending.method === 'mcpServer/elicitation/request'
    ) {
      codexClient.respond(pending.rpcId, {
        action: action === 'acceptForSession' ? 'accept' : action,
        content: options?.userInput ?? null,
        _meta: null
      })
      return true
    }

    if (pending.method === 'tool/requestUserInput') {
      if (action === 'accept' || action === 'acceptForSession') {
        const answers = options?.userInput !== undefined ? { default: options.userInput } : {}
        codexClient.respond(pending.rpcId, { answers })
      } else {
        codexClient.reject(pending.rpcId, `User ${action}ed Codex input request.`)
      }
      return true
    }

    codexClient.respond(pending.rpcId, { decision: action })
    return true
  }

  /** Diagnostic / debugging view of all currently-pending approvals.
   * Returns counts per registry. Useful for the Approval Ledger
   * panel + future "what's currently waiting" surface. */
  pendingCounts(): Record<string, number> {
    return {
      main: this.pendingMain.size,
      geminiTool: this.pendingGeminiTool.size,
      codex: this.pendingCodex.size,
      kimi: this.pendingKimi.size,
      hostCommand: this.pendingHostCommand.size
    }
  }

  private emitApprovalRunEvent(
    type: ApprovalRunEventType,
    approvalId: string,
    provider: ProviderId,
    context: {
      appRunId?: string
      appChatId?: string
      workspacePath?: string
      threadId?: string
      action?: AgentApprovalAction
      decisionSource?: 'user' | 'system'
    }
  ): void {
    try {
      const session = this.deps.runManager.get(context.appRunId)
      const appRunId = session?.runId ?? context.appRunId
      const appChatId = session?.appChatId ?? context.appChatId
      const workspaceId =
        this.deps.workspaceIdForPath(context.workspacePath ?? session?.workspacePath) ?? 'global'
      const threadId = appChatId ?? context.threadId ?? appRunId ?? approvalId
      const event: ApprovalRunEvent = {
        type,
        approvalId,
        provider,
        workspaceId,
        threadId
      }
      if (appRunId) event.appRunId = appRunId
      if (appChatId) event.appChatId = appChatId
      if (context.action) event.action = context.action
      if (context.decisionSource) event.decisionSource = context.decisionSource
      this.deps.publishApprovalRunEvent(event)
    } catch (err) {
      this.deps.log(
        `[ApprovalService] approval run-event publish failed for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Resolve a requested approval action to the effective action the card
   * actually offered, or `null` if it must be rejected.
   *
   * A remote (iOS) client can render a broader accept-tier button than a given
   * card offered — the approval projection does not carry `allowedActions`, so
   * e.g. "Accept for workspace" is tappable on a prompt-on-action (policy
   * 'ask') shell card whose offered set is only accept / acceptForSession /
   * decline. That un-offered `acceptForWorkspace` used to be rejected and the
   * remote approval was silently dropped (the command never ran, even though
   * the user approved). We now DOWN-CLAMP an un-offered accept-tier action to
   * the STRONGEST OFFERED accept tier that is no broader than requested, so the
   * approval is HONORED (the command runs) without ESCALATING the grant scope
   * past what the card offered — a persistent workspace grant is never created
   * from an un-offered `acceptForWorkspace`. Non-accept actions, and accept
   * tiers with no offered fallback, stay rejected.
   */
  private resolveEffectiveApprovalAction(
    approvalId: string,
    action: AgentApprovalAction,
    allowedActions: AgentApprovalAction[] | undefined
  ): AgentApprovalAction | null {
    if (!allowedActions || allowedActions.length === 0) return action
    if (allowedActions.includes(action)) return action
    // Accept tiers, strongest→weakest by grant scope. Clamp down to the
    // strongest offered tier that is no broader than the requested one.
    const ACCEPT_TIERS: AgentApprovalAction[] = ['acceptForWorkspace', 'acceptForSession', 'accept']
    const requestedRank = ACCEPT_TIERS.indexOf(action)
    if (requestedRank >= 0) {
      for (let rank = requestedRank; rank < ACCEPT_TIERS.length; rank++) {
        const tier = ACCEPT_TIERS[rank]
        if (allowedActions.includes(tier)) {
          this.deps.log(
            `[ApprovalService] down-clamped un-offered approval action "${action}" to "${tier}" for ${approvalId}; allowed=${allowedActions.join(',')}`
          )
          return tier
        }
      }
    }
    this.deps.log(
      `[ApprovalService] rejected invalid approval action "${action}" for ${approvalId}; allowed=${allowedActions.join(',')}`
    )
    return null
  }
}

function compactJSON(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = JSON.stringify(value)
    if (!text) return ''
    return text.length <= 400 ? text : `${text.slice(0, 397)}...`
  } catch {
    return String(value)
  }
}

/** Helper for the timeout callback to surface the auto-deny event +
 * dispatch through the service. Lives outside the class so the
 * scheduler's onTimeout closure can be defined cleanly. */
export async function handleApprovalTimeout(
  service: ApprovalService,
  reason: ApprovalTimeoutReason,
  helpers: {
    appendDurableRunEventForRoute: (
      provider: ProviderId,
      route: AgentRunRoute | null | undefined,
      kind: RunEventKind,
      phase: RunEventPhase,
      title: string,
      payload?: unknown
    ) => void
    log: (line: string) => void
    sendTimeoutToRenderer: (snapshot: {
      approvalId: string
      appliedMs: number
      source: ApprovalTimeoutReason['source']
    }) => void
  }
): Promise<void> {
  helpers.log(
    `[ApprovalTimeout] approvalId=${reason.approvalId} auto-deny after ${reason.appliedMs}ms (source=${reason.source})`
  )
  const route = service.lookupRoute(reason.approvalId)
  if (route?.appRunId) {
    try {
      helpers.appendDurableRunEventForRoute(
        route.provider,
        { appRunId: route.appRunId, appChatId: route.appChatId },
        'approval_timer_timeout',
        'control',
        `Approval timer fired after ${reason.appliedMs}ms`,
        {
          approvalId: reason.approvalId,
          appliedMs: reason.appliedMs,
          source: reason.source
        }
      )
    } catch {
      // Run may have been cleared; auto-deny still proceeds.
    }
  }
  try {
    helpers.sendTimeoutToRenderer({
      approvalId: reason.approvalId,
      appliedMs: reason.appliedMs,
      source: reason.source
    })
  } catch {
    // Window may be destroyed; auto-deny still proceeds.
  }
  try {
    await service.resolve(reason.approvalId, 'decline', {
      decisionSource: 'system',
      extraMetadata: {
        autoDeniedByTimeout: true,
        timeoutMs: reason.appliedMs,
        timeoutSource: reason.source
      }
    })
  } catch (err) {
    helpers.log(
      `[ApprovalTimeout] decline path threw for approvalId=${reason.approvalId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
