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
 * Pre/Post are wired from `executeGeminiMcpTool` (Pre blocks on onError=block;
 * Post is fire-and-forget in finally).
 *
 * Trust note: workspace `.taskwraith/hooks.json` is agent-writable. Host
 * execution defaults to user-scoped hooks only. Workspace hooks run only when
 * Settings → Hooks → "Trust workspace hooks" is on (`AppSettings.trustWorkspaceHooks`),
 * which main passes as `allowWorkspaceHooks: true`.
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
  emitRunEvent?: (event: HostShellHookRunEvent) => void
  /**
   * When false/omitted (v1 default), only `scope === 'user'` hooks execute.
   * Workspace `.taskwraith/hooks.json` is agent-writable and is not auto-run
   * until a caller opts in with `true`.
   */
  allowWorkspaceHooks?: boolean
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
  const allowWorkspaceHooks = deps.allowWorkspaceHooks === true
  return new HostShellHookRunner({
    workspacePath,
    getEffectiveHooks: async (path) => {
      const effective = await deps.hooksStore.resolveEffectiveHooks(path)
      return filterHooksForExecution(effective, allowWorkspaceHooks)
    },
    runShell: deps.runShell ?? defaultRunShell,
    ...(deps.requestApproval ? { requestApproval: deps.requestApproval } : {}),
    ...(deps.emitRunEvent ? { emitRunEvent: deps.emitRunEvent } : {})
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
