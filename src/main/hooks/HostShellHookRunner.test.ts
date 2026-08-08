import { describe, expect, it, vi } from 'vitest'
import type { EffectiveHookCommand, EffectiveHooksSnapshot } from '../../shared/hooks/HookTypes'
import {
  HostShellHookRunner,
  SESSION_START_STDOUT_CAP_BYTES,
  type HostShellHookRunnerOptions,
  type HookShellResult
} from './HostShellHookRunner'

const WORKSPACE = '/tmp/tw-hooks-ws'

function makeHook(
  overrides: Partial<EffectiveHookCommand> & Pick<EffectiveHookCommand, 'id' | 'event' | 'command'>
): EffectiveHookCommand {
  return {
    id: overrides.id,
    event: overrides.event,
    command: overrides.command,
    enabled: overrides.enabled ?? true,
    scope: overrides.scope ?? 'user',
    source: overrides.source ?? 'user',
    ...(overrides.matcher !== undefined ? { matcher: overrides.matcher } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.onError !== undefined ? { onError: overrides.onError } : {}),
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {})
  }
}

function snapshot(hooks: EffectiveHookCommand[]): EffectiveHooksSnapshot {
  return {
    schemaVersion: 1,
    workspacePath: WORKSPACE,
    hooks
  }
}

function createRunner(
  hooks: EffectiveHookCommand[],
  overrides: Partial<HostShellHookRunnerOptions> & {
    runShell?: HostShellHookRunnerOptions['runShell']
  } = {}
): {
  runner: HostShellHookRunner
  runShell: ReturnType<typeof vi.fn>
  emitRunEvent: ReturnType<typeof vi.fn>
} {
  const runShell =
    overrides.runShell ??
    vi.fn(
      async (): Promise<HookShellResult> => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
      })
    )
  const emitRunEvent = overrides.emitRunEvent ?? vi.fn()
  const runner = new HostShellHookRunner({
    workspacePath: WORKSPACE,
    getEffectiveHooks: overrides.getEffectiveHooks ?? (async () => snapshot(hooks)),
    runShell,
    emitRunEvent,
    ...(overrides.requestApproval ? { requestApproval: overrides.requestApproval } : {})
  })
  return {
    runner,
    runShell: runShell as ReturnType<typeof vi.fn>,
    emitRunEvent: emitRunEvent as ReturnType<typeof vi.fn>
  }
}

describe('HostShellHookRunner matcher', () => {
  it('runs only PreToolUse hooks whose matcher matches the tool name', async () => {
    const { runner, runShell } = createRunner([
      makeHook({
        id: 'shell-only',
        event: 'PreToolUse',
        command: 'echo shell',
        matcher: 'run_shell'
      }),
      makeHook({
        id: 'write-glob',
        event: 'PreToolUse',
        command: 'echo write',
        matcher: 'write_*'
      }),
      makeHook({
        id: 'star',
        event: 'PreToolUse',
        command: 'echo star',
        matcher: '*'
      }),
      makeHook({
        id: 'no-matcher',
        event: 'PreToolUse',
        command: 'echo any'
      }),
      makeHook({
        id: 'wrong-event',
        event: 'PostToolUse',
        command: 'echo post',
        matcher: '*'
      })
    ])

    await runner.runPreToolUse({ toolName: 'run_shell_command' })

    const commands = runShell.mock.calls.map((call) => call[0].command)
    expect(commands).toEqual(['echo shell', 'echo star', 'echo any'])
  })

  it('matches write_* glob-lite against write_file', async () => {
    const { runner, runShell } = createRunner([
      makeHook({
        id: 'write-glob',
        event: 'PreToolUse',
        command: 'echo write',
        matcher: 'write_*'
      })
    ])

    await runner.runPreToolUse({ toolName: 'write_file' })
    expect(runShell).toHaveBeenCalledTimes(1)
    expect(runShell.mock.calls[0][0].command).toBe('echo write')
  })
})

describe('HostShellHookRunner onError block vs continue', () => {
  it('defaults PreToolUse onError to block and stops on non-zero exit', async () => {
    const { runner, runShell } = createRunner(
      [
        makeHook({
          id: 'first',
          event: 'PreToolUse',
          command: 'echo first'
        }),
        makeHook({
          id: 'second',
          event: 'PreToolUse',
          command: 'echo second'
        })
      ],
      {
        runShell: vi.fn(async ({ command }): Promise<HookShellResult> => {
          if (command === 'echo first') {
            return { exitCode: 2, stdout: '', stderr: 'denied' }
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        })
      }
    )

    const outcome = await runner.runPreToolUse({ toolName: 'read_file' })
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toMatch(/first/i)
    expect(runShell).toHaveBeenCalledTimes(1)
  })

  it('continues PostToolUse failures by default and does not block', async () => {
    const { runner, runShell } = createRunner(
      [
        makeHook({
          id: 'first',
          event: 'PostToolUse',
          command: 'echo first'
        }),
        makeHook({
          id: 'second',
          event: 'PostToolUse',
          command: 'echo second'
        })
      ],
      {
        runShell: vi.fn(async ({ command }): Promise<HookShellResult> => {
          if (command === 'echo first') {
            return { exitCode: 1, stdout: '', stderr: 'oops' }
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        })
      }
    )

    const outcome = await runner.runPostToolUse({ toolName: 'read_file', outcome: 'ok' })
    expect(outcome.blocked).toBe(false)
    expect(runShell).toHaveBeenCalledTimes(2)
  })

  it('honours explicit onError continue on PreToolUse', async () => {
    const { runner, runShell } = createRunner(
      [
        makeHook({
          id: 'first',
          event: 'PreToolUse',
          command: 'echo first',
          onError: 'continue'
        }),
        makeHook({
          id: 'second',
          event: 'PreToolUse',
          command: 'echo second'
        })
      ],
      {
        runShell: vi.fn(async ({ command }): Promise<HookShellResult> => {
          if (command === 'echo first') {
            return { exitCode: 1, stdout: '', stderr: 'soft' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        })
      }
    )

    const outcome = await runner.runPreToolUse({ toolName: 'read_file' })
    expect(outcome.blocked).toBe(false)
    expect(runShell).toHaveBeenCalledTimes(2)
  })

  it('blocks PostToolUse when onError is block and exit is non-zero', async () => {
    const { runner } = createRunner(
      [
        makeHook({
          id: 'strict',
          event: 'PostToolUse',
          command: 'echo strict',
          onError: 'block'
        })
      ],
      {
        runShell: vi.fn(
          async (): Promise<HookShellResult> => ({
            exitCode: 9,
            stdout: '',
            stderr: 'nope'
          })
        )
      }
    )

    const outcome = await runner.runPostToolUse({ toolName: 'write_file' })
    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toMatch(/strict/i)
  })
})

describe('HostShellHookRunner SessionStart stdout cap', () => {
  it('caps injected SessionStart stdout at SESSION_START_STDOUT_CAP_BYTES', async () => {
    const oversized = 'x'.repeat(SESSION_START_STDOUT_CAP_BYTES + 2048)
    const { runner } = createRunner(
      [
        makeHook({
          id: 'ctx',
          event: 'SessionStart',
          command: 'echo context'
        })
      ],
      {
        runShell: vi.fn(
          async (): Promise<HookShellResult> => ({
            exitCode: 0,
            stdout: oversized,
            stderr: ''
          })
        )
      }
    )

    const outcome = await runner.runSessionStart()
    expect(outcome.blocked).toBe(false)
    expect(outcome.sessionStartContext).toBeDefined()
    expect(Buffer.byteLength(outcome.sessionStartContext!, 'utf8')).toBe(
      SESSION_START_STDOUT_CAP_BYTES
    )
  })

  it('concatenates multiple SessionStart stdout streams before capping', async () => {
    const half = 'a'.repeat(SESSION_START_STDOUT_CAP_BYTES - 10)
    const more = 'b'.repeat(64)
    let call = 0
    const { runner } = createRunner(
      [
        makeHook({ id: 'a', event: 'SessionStart', command: 'echo a' }),
        makeHook({ id: 'b', event: 'SessionStart', command: 'echo b' })
      ],
      {
        runShell: vi.fn(async (): Promise<HookShellResult> => {
          call += 1
          return {
            exitCode: 0,
            stdout: call === 1 ? half : more,
            stderr: ''
          }
        })
      }
    )

    const outcome = await runner.runSessionStart()
    expect(Buffer.byteLength(outcome.sessionStartContext!, 'utf8')).toBe(
      SESSION_START_STDOUT_CAP_BYTES
    )
    expect(outcome.sessionStartContext!.startsWith(half)).toBe(true)
  })
})

describe('HostShellHookRunner approval + run events', () => {
  it('skips a hook when requestApproval returns false', async () => {
    const { runner, runShell, emitRunEvent } = createRunner(
      [makeHook({ id: 'needs-ask', event: 'Stop', command: 'echo stop' })],
      {
        requestApproval: async () => false
      }
    )

    const outcome = await runner.runStop({ status: 'done' })
    expect(outcome.blocked).toBe(false)
    expect(runShell).not.toHaveBeenCalled()
    expect(emitRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'hook_skipped',
        hookId: 'needs-ask',
        event: 'Stop'
      })
    )
  })

  it('emits start and end run events around a successful hook', async () => {
    const { runner, emitRunEvent } = createRunner([
      makeHook({ id: 'ok', event: 'Stop', command: 'echo stop' })
    ])

    await runner.runStop({ status: 'cancelled' })
    expect(emitRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'hook_start', hookId: 'ok', event: 'Stop' })
    )
    expect(emitRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'hook_end',
        hookId: 'ok',
        event: 'Stop',
        exitCode: 0
      })
    )
  })

  it('passes workspace cwd and hook timeoutMs to runShell', async () => {
    const { runner, runShell } = createRunner([
      makeHook({
        id: 'timed',
        event: 'SessionStart',
        command: 'echo timed',
        timeoutMs: 12_345
      })
    ])

    await runner.runSessionStart()
    expect(runShell).toHaveBeenCalledWith({
      cwd: WORKSPACE,
      command: 'echo timed',
      timeoutMs: 12_345
    })
  })
})
