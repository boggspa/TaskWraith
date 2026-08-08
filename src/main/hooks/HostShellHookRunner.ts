/**
 * Host-mediated shell hook runner (Wave A3).
 *
 * Executes effective HookCommands at SessionStart / PreToolUse / PostToolUse /
 * Stop. Shell execution and approval are injected — this module is not wired
 * into index.ts yet.
 */
import type {
  EffectiveHookCommand,
  EffectiveHooksSnapshot,
  HookEvent,
  HookOnError
} from '../../shared/hooks/HookTypes'

/** Cap for SessionStart stdout collected for prompt injection. */
export const SESSION_START_STDOUT_CAP_BYTES = 8_192

const DEFAULT_HOOK_TIMEOUT_MS = 30_000

export interface HookShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface HostShellHookRunEvent {
  kind: 'hook_start' | 'hook_end' | 'hook_skipped' | 'hook_blocked'
  event: HookEvent
  hookId: string
  command: string
  exitCode?: number
  stdout?: string
  stderr?: string
  reason?: string
  toolName?: string
}

export interface HostShellHookRunnerOptions {
  workspacePath: string
  getEffectiveHooks: (
    workspacePath: string
  ) => EffectiveHooksSnapshot | Promise<EffectiveHooksSnapshot>
  runShell: (input: { cwd: string; command: string; timeoutMs: number }) => Promise<HookShellResult>
  emitRunEvent?: (event: HostShellHookRunEvent) => void
  requestApproval?: (command: string) => boolean | Promise<boolean>
}

export interface HookRunResultEntry {
  hookId: string
  exitCode: number
  stdout: string
  stderr: string
}

export interface HookRunOutcome {
  blocked: boolean
  reason?: string
  results: HookRunResultEntry[]
  /** SessionStart only: capped stdout for prompt injection. */
  sessionStartContext?: string
}

export interface PreToolUseHookInput {
  toolName: string
  argsSummary?: string
}

export interface PostToolUseHookInput {
  toolName: string
  outcome?: string
}

export interface StopHookInput {
  status?: string
}

function defaultOnError(event: HookEvent): HookOnError {
  return event === 'PreToolUse' ? 'block' : 'continue'
}

/**
 * Matcher is substring/glob-lite against toolName:
 * - missing / empty → match all
 * - `*` → match all
 * - contains `*` → anchored glob (`*` → `.*`)
 * - otherwise → substring includes
 */
export function matchesHookTool(matcher: string | undefined, toolName: string): boolean {
  if (typeof matcher !== 'string') return true
  const trimmed = matcher.trim()
  if (!trimmed || trimmed === '*') return true
  if (trimmed.includes('*')) {
    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(toolName)
  }
  return toolName.includes(trimmed)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end -= 1
  }
  return value.slice(0, end)
}

function joinSessionStartStdout(chunks: string[]): string {
  if (chunks.length === 0) return ''
  return truncateUtf8(chunks.join('\n'), SESSION_START_STDOUT_CAP_BYTES)
}

function blockReason(hook: EffectiveHookCommand, result: HookShellResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
  return `Hook '${hook.id}' blocked the action (${detail}).`
}

export class HostShellHookRunner {
  private readonly workspacePath: string
  private readonly getEffectiveHooks: HostShellHookRunnerOptions['getEffectiveHooks']
  private readonly runShell: HostShellHookRunnerOptions['runShell']
  private readonly emitRunEvent?: HostShellHookRunnerOptions['emitRunEvent']
  private readonly requestApproval?: HostShellHookRunnerOptions['requestApproval']

  constructor(options: HostShellHookRunnerOptions) {
    if (typeof options.workspacePath !== 'string' || !options.workspacePath.trim()) {
      throw new Error('workspacePath is required.')
    }
    this.workspacePath = options.workspacePath.trim()
    this.getEffectiveHooks = options.getEffectiveHooks
    this.runShell = options.runShell
    this.emitRunEvent = options.emitRunEvent
    this.requestApproval = options.requestApproval
  }

  async runSessionStart(): Promise<HookRunOutcome> {
    return this.runEvent('SessionStart')
  }

  async runPreToolUse(input: PreToolUseHookInput): Promise<HookRunOutcome> {
    return this.runEvent('PreToolUse', { toolName: input.toolName, argsSummary: input.argsSummary })
  }

  async runPostToolUse(input: PostToolUseHookInput): Promise<HookRunOutcome> {
    return this.runEvent('PostToolUse', { toolName: input.toolName, outcome: input.outcome })
  }

  async runStop(input: StopHookInput = {}): Promise<HookRunOutcome> {
    return this.runEvent('Stop', { status: input.status })
  }

  private async runEvent(
    event: HookEvent,
    context: {
      toolName?: string
      argsSummary?: string
      outcome?: string
      status?: string
    } = {}
  ): Promise<HookRunOutcome> {
    const effective = await this.getEffectiveHooks(this.workspacePath)
    const hooks = (effective.hooks ?? []).filter((hook) => {
      if (!hook.enabled || hook.event !== event) return false
      if (event === 'PreToolUse' || event === 'PostToolUse') {
        return matchesHookTool(hook.matcher, context.toolName ?? '')
      }
      return true
    })

    const results: HookRunResultEntry[] = []
    const sessionChunks: string[] = []

    for (const hook of hooks) {
      if (this.requestApproval) {
        const allowed = await this.requestApproval(hook.command)
        if (!allowed) {
          this.emit?.({
            kind: 'hook_skipped',
            event,
            hookId: hook.id,
            command: hook.command,
            reason: 'approval_denied',
            toolName: context.toolName
          })
          continue
        }
      }

      this.emit?.({
        kind: 'hook_start',
        event,
        hookId: hook.id,
        command: hook.command,
        toolName: context.toolName
      })

      const timeoutMs =
        typeof hook.timeoutMs === 'number' && hook.timeoutMs > 0
          ? hook.timeoutMs
          : DEFAULT_HOOK_TIMEOUT_MS

      let shellResult: HookShellResult
      try {
        shellResult = await this.runShell({
          cwd: this.workspacePath,
          command: hook.command,
          timeoutMs
        })
      } catch (error) {
        shellResult = {
          exitCode: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error)
        }
      }

      results.push({
        hookId: hook.id,
        exitCode: shellResult.exitCode,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr
      })

      this.emit?.({
        kind: 'hook_end',
        event,
        hookId: hook.id,
        command: hook.command,
        exitCode: shellResult.exitCode,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr,
        toolName: context.toolName
      })

      if (event === 'SessionStart' && shellResult.exitCode === 0 && shellResult.stdout) {
        sessionChunks.push(shellResult.stdout)
      }

      const onError = hook.onError ?? defaultOnError(event)
      if (onError === 'block' && shellResult.exitCode !== 0) {
        const reason = blockReason(hook, shellResult)
        this.emit?.({
          kind: 'hook_blocked',
          event,
          hookId: hook.id,
          command: hook.command,
          exitCode: shellResult.exitCode,
          stderr: shellResult.stderr,
          reason,
          toolName: context.toolName
        })
        const outcome: HookRunOutcome = {
          blocked: true,
          reason,
          results
        }
        if (event === 'SessionStart') {
          outcome.sessionStartContext = joinSessionStartStdout(sessionChunks)
        }
        return outcome
      }
    }

    const outcome: HookRunOutcome = {
      blocked: false,
      results
    }
    if (event === 'SessionStart') {
      outcome.sessionStartContext = joinSessionStartStdout(sessionChunks)
    }
    return outcome
  }

  private emit(event: HostShellHookRunEvent): void {
    try {
      this.emitRunEvent?.(event)
    } catch {
      // Audit emission must never break hook execution.
    }
  }
}
