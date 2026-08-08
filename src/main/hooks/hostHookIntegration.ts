/**
 * Host shell hook fire-point helpers (Wave A).
 *
 * Constructs a HostShellHookRunner with an injected bash shell and optional
 * approval callback. SessionStart / Stop are the first exported events; Pre/Post
 * ToolUse helpers are exported for a later central MCP dispatch wrapper.
 *
 * SessionStart: `runSessionStartHooksForWorkspace` is the awaitable helper.
 * PromptComposition injects `sessionStartContext` when supplied. Main's
 * ComposerService awaits `resolveSessionStartContext` on compose (once per
 * workspace) so the same turn can include SessionStart stdout.
 *
 * Pre/Post are wired from `executeGeminiMcpTool`, Codex native approval
 * (`handleCodexServerRequest` via `withHostToolHooks`), and Claude
 * `canUseClaudeSdkTool` for provider-native tools only (MCP stays on the
 * dispatcher to avoid double-fire).
 *
 * Trust note: workspace `.taskwraith/hooks.json` is agent-writable. Host
 * execution defaults to user-scoped hooks only. Workspace hooks run only when
 * Settings → Hooks → "Trust workspace hooks" is on (`AppSettings.trustWorkspaceHooks`),
 * which main passes as `allowWorkspaceHooks: true`.
 *
 * Durable audit: callers should pass `emitRunEvent` from
 * `createHookRunEventEmitter({ append, appChatId?, appRunId? })` so hook
 * start/end/skip/block events land in the run-event ledger when a run id is
 * known; otherwise the adapter logs via `console.debug`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EffectiveHooksSnapshot } from '../../shared/hooks/HookTypes'
import type { HooksStore } from './HooksStore'
import {
  HostShellHookRunner,
  type HookRunOutcome,
  type HostShellHookRunEvent,
  type HookShellResult,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type StopHookInput
} from './HostShellHookRunner'

const execFileAsync = promisify(execFile)

/** Minimal env keys passed to hook shell processes — never full `process.env`. */
export const HOOK_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const

export function buildMinimalHookEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of HOOK_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
  return env
}

/** Durable run-event shape written by `createHookRunEventEmitter`. */
export interface HookDurableRunEventAppendInput {
  runId: string
  chatId?: string
  kind: 'lifecycle'
  phase: 'control'
  source: 'main'
  summary: string
  payload: Omit<HostShellHookRunEvent, 'stdout' | 'stderr'> & {
    hostHookEvent: true
  }
}

export interface CreateHookRunEventEmitterOptions {
  /** Call site wires this to `appendDurableRunEvent` / `appendDurableRunEventForRoute`. */
  append: (input: HookDurableRunEventAppendInput) => void
  appChatId?: string
  appRunId?: string
}

/**
 * Adapts HostShellHookRunner emit callbacks onto the durable run-event ledger.
 * Without a non-empty `appRunId`, events are `console.debug`'d only.
 */
export function createHookRunEventEmitter(
  options: CreateHookRunEventEmitterOptions
): (event: HostShellHookRunEvent) => void {
  return (event) => {
    const runId = typeof options.appRunId === 'string' ? options.appRunId.trim() : ''
    if (!runId) {
      console.debug(
        '[hooks] run-event (no run id)',
        event.kind,
        event.hookId,
        event.event
      )
      return
    }
    const chatId = typeof options.appChatId === 'string' ? options.appChatId.trim() : ''
    const { stdout: _stdout, stderr: _stderr, ...safeEvent } = event
    options.append({
      runId,
      ...(chatId ? { chatId } : {}),
      kind: 'lifecycle',
      phase: 'control',
      source: 'main',
      summary: `Host hook ${event.kind} (${event.event}): ${event.hookId}`,
      payload: {
        ...safeEvent,
        hostHookEvent: true
      }
    })
  }
}

export interface HostHookIntegrationDeps {
  hooksStore: Pick<HooksStore, 'resolveEffectiveHooks'>
  /** Defaults to `bash -lc` with the hook timeout and scrubbed env. */
  runShell?: (input: {
    cwd: string
    command: string
    timeoutMs: number
  }) => Promise<HookShellResult>
  /**
   * Optional approval gate. When omitted, hooks run without asking
   * (Settings-managed commands are treated as user-authored policy).
   * Pass a callback to require per-command confirmation.
   */
  requestApproval?: (command: string) => boolean | Promise<boolean>
  /**
   * When true (Settings → Hooks → Ask before hook commands), every hook
   * command must pass `requestApproval`. If that callback is omitted, hooks
   * deny-by-default (fail closed) rather than running unattended.
   */
  askBeforeHookCommands?: boolean
  emitRunEvent?: (event: HostShellHookRunEvent) => void
  /**
   * When false/omitted (v1 default), only `scope === 'user'` hooks execute.
   * Workspace `.taskwraith/hooks.json` is agent-writable and is not auto-run
   * until a caller opts in with `true`.
   */
  allowWorkspaceHooks?: boolean
}

/**
 * Build integration deps for Pre/Post/Stop/SessionStart call sites.
 * Applies the ask-before deny stub when the setting is on but no approval
 * callback was supplied.
 */
export function resolveHostHookIntegrationDeps(
  deps: HostHookIntegrationDeps
): HostHookIntegrationDeps {
  if (deps.askBeforeHookCommands !== true) {
    return deps
  }
  if (deps.requestApproval) {
    return deps
  }
  // TODO(hooks-approval): SessionStart (compose-time, no run id) and other
  // sites without a reachable requestAgenticServiceApproval path should grow
  // a dedicated dialog. Until then, ask-before without a callback denies.
  return {
    ...deps,
    requestApproval: async () => false
  }
}

export type WithHostToolHooksBlocked = { blocked: true; reason: string }
export type WithHostToolHooksOk<T> = { blocked: false; result: T }
export type WithHostToolHooksResult<T> = WithHostToolHooksBlocked | WithHostToolHooksOk<T>

export interface WithHostToolHooksOptions<T> {
  workspacePath?: string | null
  toolName: string
  allowWorkspaceHooks?: boolean
  argsSummary?: string
  /** When omitted/null and `deps` is absent, Pre/Post are skipped and `run` executes. */
  hooksStore?: HostHookIntegrationDeps['hooksStore'] | null
  /**
   * Full runner deps (e.g. from main's `buildHostHookCallDeps`). When set,
   * takes precedence over bare `hooksStore` / `allowWorkspaceHooks`.
   */
  deps?: HostHookIntegrationDeps | null
  run: () => Promise<T> | T
  /**
   * Maps `run`'s result to PostToolUse `outcome`. Return `null` to skip Post
   * (e.g. Codex ask-path deferred until the user decides).
   */
  outcomeFromResult?: (result: T) => string | null | undefined
  onHookError?: (phase: 'pre' | 'post', error: unknown) => void
}

/**
 * Await PreToolUse (fail-closed on block/throw), run the native/tool decision,
 * then fire-and-forget PostToolUse with an optional outcome.
 *
 * Skips hooks when workspace path or hooksStore is missing — same gate as
 * `executeGeminiMcpTool`.
 */
export async function withHostToolHooks<T>(
  options: WithHostToolHooksOptions<T>
): Promise<WithHostToolHooksResult<T>> {
  const workspacePath =
    typeof options.workspacePath === 'string' ? options.workspacePath.trim() : ''
  const integrationDeps: HostHookIntegrationDeps | null = options.deps
    ? options.deps
    : options.hooksStore
      ? {
          hooksStore: options.hooksStore,
          allowWorkspaceHooks: options.allowWorkspaceHooks === true
        }
      : null

  const runTool = async (): Promise<WithHostToolHooksOk<T>> => {
    const result = await options.run()
    return { blocked: false, result }
  }

  if (!workspacePath || !integrationDeps) {
    return runTool()
  }

  try {
    const pre = await runPreToolUseHooks(
      workspacePath,
      {
        toolName: options.toolName,
        ...(options.argsSummary !== undefined ? { argsSummary: options.argsSummary } : {})
      },
      integrationDeps
    )
    if (pre.blocked) {
      return {
        blocked: true,
        reason: pre.reason || 'Blocked by TaskWraith PreToolUse hook.'
      }
    }
  } catch (error) {
    options.onHookError?.('pre', error)
    return {
      blocked: true,
      reason:
        error instanceof Error ? error.message : 'PreToolUse hook failed closed.'
    }
  }

  const ok = await runTool()
  const mapped = options.outcomeFromResult?.(ok.result)
  if (mapped !== null) {
    void runPostToolUseHooks(
      workspacePath,
      {
        toolName: options.toolName,
        ...(typeof mapped === 'string' ? { outcome: mapped } : {})
      },
      integrationDeps
    ).catch((error) => {
      options.onHookError?.('post', error)
    })
  }
  return ok
}

async function defaultRunShell(input: {
  cwd: string
  command: string
  timeoutMs: number
}): Promise<HookShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', input.command], {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: buildMinimalHookEnv()
    })
    return {
      exitCode: 0,
      stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
      stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '')
    }
  } catch (error) {
    const err = error as {
      code?: number | string
      killed?: boolean
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }
    const exitCode = typeof err.code === 'number' ? err.code : err.killed ? 124 : 1
    return {
      exitCode,
      stdout: typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? ''),
      stderr:
        typeof err.stderr === 'string'
          ? err.stderr
          : String(err.stderr ?? err.message ?? 'hook command failed')
    }
  }
}

function filterHooksForExecution(
  snapshot: EffectiveHooksSnapshot,
  allowWorkspaceHooks: boolean
): EffectiveHooksSnapshot {
  if (allowWorkspaceHooks) return snapshot
  return {
    ...snapshot,
    hooks: (snapshot.hooks ?? []).filter((hook) => hook.scope === 'user')
  }
}

export function createHostShellHookRunner(
  workspacePath: string,
  deps: HostHookIntegrationDeps
): HostShellHookRunner {
  const resolved = resolveHostHookIntegrationDeps(deps)
  const allowWorkspaceHooks = resolved.allowWorkspaceHooks === true
  return new HostShellHookRunner({
    workspacePath,
    getEffectiveHooks: async (path) => {
      const effective = await resolved.hooksStore.resolveEffectiveHooks(path)
      return filterHooksForExecution(effective, allowWorkspaceHooks)
    },
    runShell: resolved.runShell ?? defaultRunShell,
    ...(resolved.requestApproval ? { requestApproval: resolved.requestApproval } : {}),
    ...(resolved.emitRunEvent ? { emitRunEvent: resolved.emitRunEvent } : {})
  })
}

export async function runSessionStartHooksForWorkspace(
  workspacePath: string,
  deps: HostHookIntegrationDeps
): Promise<HookRunOutcome> {
  return createHostShellHookRunner(workspacePath, deps).runSessionStart()
}

export async function runPreToolUseHooks(
  workspacePath: string,
  input: PreToolUseHookInput,
  deps: HostHookIntegrationDeps
): Promise<HookRunOutcome> {
  return createHostShellHookRunner(workspacePath, deps).runPreToolUse(input)
}

export async function runPostToolUseHooks(
  workspacePath: string,
  input: PostToolUseHookInput,
  deps: HostHookIntegrationDeps
): Promise<HookRunOutcome> {
  return createHostShellHookRunner(workspacePath, deps).runPostToolUse(input)
}

export async function runStopHooks(
  workspacePath: string,
  input: StopHookInput,
  deps: HostHookIntegrationDeps
): Promise<HookRunOutcome> {
  return createHostShellHookRunner(workspacePath, deps).runStop(input)
}
