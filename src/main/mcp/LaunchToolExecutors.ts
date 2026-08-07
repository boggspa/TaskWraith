/**
 * MCP executor for the `launch_*` tool family — the agent-facing surface over the
 * "Run Button" launch subsystem (LaunchManager + launchTargets discovery).
 *
 * SAFETY MODEL (discovered-targets-only): an agent can only START a target that
 * TaskWraith already DISCOVERED from repo-controlled config (package.json scripts,
 * .vscode tasks/launch, Package.swift, .xcodeproj) — it passes a `targetId`, never
 * a forged/arbitrary command. The executor re-discovers for the RUN's workspace
 * (ctx.workspacePath, never an agent-supplied path) and looks the target up by id;
 * the launch itself flows through LaunchManager.startTarget, which performs its own
 * `shellCommands` + forcePrompt approval (showing the exact resolved command, cwd)
 * and the cwd-jail / env-strip / shell-only-for-vscode-task guards. The launch_*
 * tools are ALSO classified `shellCommands` (workspace_write) at the MCP gate, so a
 * read-only / shell-denied run can never reach them.
 *
 * The controller is injected so the executor is unit-testable without Electron /
 * the real LaunchManager.
 */
import type { McpToolExecutionResult } from './McpBridgeRuntime'
import type { LaunchTarget } from '../launchTargets/types'
import type { LaunchAttempt } from '../launch/types'

export const LAUNCH_MCP_TOOL_NAMES = [
  'launch_list_targets',
  'launch_start',
  'launch_adopt',
  'launch_stop',
  'launch_status'
] as const

export type LaunchMcpToolName = (typeof LAUNCH_MCP_TOOL_NAMES)[number]

const LAUNCH_TOOL_NAME_SET: ReadonlySet<string> = new Set(LAUNCH_MCP_TOOL_NAMES)

export function isLaunchMcpToolName(name: string): name is LaunchMcpToolName {
  return LAUNCH_TOOL_NAME_SET.has(name)
}

export interface LaunchToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  assertMutationAuthorized?: () => void | Promise<void>
  /**
   * The run's approval surface (an Electron WebContents). Opaque here to keep this
   * module electron-free; the real controller passes it to LaunchManager.startTarget
   * so its shellCommands+forcePrompt approval actually reaches the human (a null
   * sender would auto-DENY the launch).
   */
  sender?: unknown
  /**
   * Refuses the call when an Ensemble participant lacks Boss/Captain
   * authority. Absent means solo-thread semantics (no ranking to enforce).
   */
  assertAppDriveAuthority?: () => { ok: true } | { ok: false; reason: string }
}

export interface LaunchStartOutcome {
  ok: boolean
  attempt?: LaunchAttempt
  error?: string
}

/** Narrow seam over LaunchManager + discovery — the real impl lives in index.ts. */
export interface LaunchController {
  /** Discover runnable targets for a workspace (repo-controlled config). */
  listTargets(workspacePath: string | undefined): Promise<LaunchTarget[]>
  /** Start a discovered target (self-gates shellCommands+forcePrompt inside). */
  start(input: {
    provider: string
    target: LaunchTarget
    chatId?: string
    runId?: string
    /** Approval surface (Electron WebContents) — required for the human prompt. */
    sender?: unknown
    assertMutationAuthorized?: () => void | Promise<void>
  }): Promise<LaunchStartOutcome>
  /**
   * Record a process the run already started so Screen Watch / App Drive can
   * target it. Optional: a build without it refuses adoption rather than
   * pretending the process is unknown.
   */
  adopt?(input: {
    provider: string
    pid: number
    workspacePath: string | undefined
    chatId?: string
    runId?: string
    label?: string
    sender?: unknown
    assertMutationAuthorized?: () => void | Promise<void>
  }): Promise<LaunchStartOutcome>
  /** Stop a running attempt by id. */
  stop(attemptId: string): Promise<LaunchStartOutcome>
  /** All known launch attempts (newest-first is the store's responsibility). */
  attempts(): LaunchAttempt[]
}

export interface LaunchToolExecutorDeps {
  controller: LaunchController
}

export interface LaunchToolExecutors {
  executeLaunchTool: (
    toolName: LaunchMcpToolName,
    rawArgs: unknown,
    context: LaunchToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asPositiveInteger(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : Number(typeof value === 'string' ? value : Number.NaN)
  return Number.isSafeInteger(n) && n > 1 ? n : undefined
}

function asOptString(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s : undefined
}

/** Trim a LaunchTarget to the safe, model-useful fields (no env, no raw evidence dump). */
function targetView(t: LaunchTarget): Record<string, unknown> {
  return {
    targetId: t.id,
    label: t.label,
    kind: t.kind,
    source: t.source,
    platform: t.platform,
    command: t.command?.raw,
    longRunning: t.command?.longRunning ?? false,
    runnable: Boolean(t.command) && t.blockers.length === 0,
    url: t.url,
    primaryPort: t.primaryPort,
    blockers: t.blockers
  }
}

/** Trim a LaunchAttempt to the fields an agent needs (status, urls, error). */
function attemptView(a: LaunchAttempt): Record<string, unknown> {
  return {
    attemptId: a.id,
    targetId: a.targetId,
    label: a.targetLabel,
    status: a.status,
    detectedUrls: a.detectedUrls ?? [],
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    error: a.lastError
  }
}

function jsonResult(value: Record<string, unknown>): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return { text, structuredContent: value, content: [{ type: 'text', text }] }
}

function fail(toolName: LaunchMcpToolName, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

export function createLaunchToolExecutors(deps: LaunchToolExecutorDeps): LaunchToolExecutors {
  const { controller } = deps

  /** Attempts the calling chat owns. A missing chat id is NOT an ownership bucket:
   * unattributed/global attempts are intentionally invisible to agent MCP tools. */
  function ownAttempts(context: LaunchToolContext): LaunchAttempt[] {
    const chat = context.appChatId
    if (!chat) return []
    return controller.attempts().filter((a) => a.chatId === chat)
  }

  function ownsAttempt(attempt: LaunchAttempt, context: LaunchToolContext): boolean {
    return Boolean(context.appChatId) && attempt.chatId === context.appChatId
  }

  async function executeLaunchTool(
    toolName: LaunchMcpToolName,
    rawArgs: unknown,
    context: LaunchToolContext,
    parentProvider: string
  ): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    try {
      switch (toolName) {
        case 'launch_list_targets': {
          const targets = await controller.listTargets(context.workspacePath)
          return jsonResult({
            ok: true,
            tool: toolName,
            targets: targets.map(targetView)
          })
        }
        case 'launch_start': {
          const targetId = asOptString(args.targetId)
          if (!targetId) return fail(toolName, '`targetId` is required (from launch_list_targets).')
          if (!context.appChatId) {
            return fail(toolName, 'Launch tools require a chat-scoped run.')
          }
          // Re-discover for THIS run's workspace and find the target by id — the
          // agent can only start a discovered (repo-controlled) target, never a
          // command of its own choosing.
          const targets = await controller.listTargets(context.workspacePath)
          const target = targets.find((t) => t.id === targetId)
          if (!target) return fail(toolName, `Launch target "${targetId}" was not found.`)
          const outcome = await controller.start({
            provider: parentProvider,
            target,
            chatId: context.appChatId,
            runId: context.appRunId,
            sender: context.sender,
            ...(context.assertMutationAuthorized
              ? { assertMutationAuthorized: context.assertMutationAuthorized }
              : {})
          })
          if (!outcome.ok || !outcome.attempt) {
            return fail(toolName, outcome.error || 'Launch failed.')
          }
          // LaunchManager may return an already-active attempt for the same
          // target+workspace before approval. Never leak another chat's attempt
          // id/URLs through launch_start; status/stop have the same ownership rule.
          if (!ownsAttempt(outcome.attempt, context)) {
            return fail(toolName, 'Launch target is unavailable.')
          }
          return jsonResult({ ok: true, tool: toolName, ...attemptView(outcome.attempt) })
        }
        case 'launch_adopt': {
          const pid = asPositiveInteger(args.pid)
          if (!pid) {
            return fail(toolName, '`pid` is required: the process id you started.')
          }
          if (!context.appChatId || !context.appRunId) {
            return fail(toolName, 'Launch tools require a chat-scoped run.')
          }
          // Driving a real app is a control action, so inside an Ensemble it
          // belongs to the Boss and its Captains.
          const authority = context.assertAppDriveAuthority?.()
          if (authority && !authority.ok) return fail(toolName, authority.reason)
          if (!controller.adopt) {
            return fail(toolName, 'Process adoption is unavailable in this build.')
          }
          const outcome = await controller.adopt({
            provider: parentProvider,
            pid,
            workspacePath: context.workspacePath,
            chatId: context.appChatId,
            runId: context.appRunId,
            ...(asOptString(args.label) ? { label: asOptString(args.label) } : {}),
            sender: context.sender,
            ...(context.assertMutationAuthorized
              ? { assertMutationAuthorized: context.assertMutationAuthorized }
              : {})
          })
          if (!outcome.ok || !outcome.attempt) {
            return fail(toolName, outcome.error || 'Adoption failed.')
          }
          if (!ownsAttempt(outcome.attempt, context)) {
            return fail(toolName, 'Adoption failed.')
          }
          return jsonResult({
            ok: true,
            tool: toolName,
            ...attemptView(outcome.attempt),
            next: 'Ask the user to attach this window in Screen Watch and approve View & Control, then call canvas_open_launch with this attemptId.'
          })
        }
        case 'launch_stop': {
          const attemptId = asOptString(args.attemptId)
          if (!attemptId) return fail(toolName, '`attemptId` is required.')
          // Chat-scope: an agent may only stop an attempt its OWN chat started.
          // (Same opaque message for not-owned and truly-missing — no existence
          // oracle for other chats' attempts.)
          if (!ownAttempts(context).some((a) => a.id === attemptId)) {
            return fail(toolName, `Launch attempt "${attemptId}" was not found.`)
          }
          const outcome = await controller.stop(attemptId)
          if (!outcome.ok) return fail(toolName, outcome.error || 'Stop failed.')
          return jsonResult({
            ok: true,
            tool: toolName,
            ...(outcome.attempt ? attemptView(outcome.attempt) : { attemptId })
          })
        }
        case 'launch_status': {
          const attemptId = asOptString(args.attemptId)
          // Chat-scope: only surface attempts this chat started — never another
          // chat's/workspace's labels, ports, or enumerable attemptIds.
          const mine = ownAttempts(context)
          const attempts = attemptId ? mine.filter((a) => a.id === attemptId) : mine
          return jsonResult({ ok: true, tool: toolName, attempts: attempts.map(attemptView) })
        }
        default: {
          return fail(toolName, `Unknown launch tool "${toolName}".`)
        }
      }
    } catch (err) {
      return fail(toolName, err instanceof Error ? err.message : String(err))
    }
  }

  return { executeLaunchTool }
}
