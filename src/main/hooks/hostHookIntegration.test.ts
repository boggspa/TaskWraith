import { describe, expect, it, vi } from 'vitest'
import type { EffectiveHookCommand, EffectiveHooksSnapshot } from '../../shared/hooks/HookTypes'
import {
  HOOK_ENV_ALLOWLIST,
  buildMinimalHookEnv,
  createHookRunEventEmitter,
  createHostShellHookRunner,
  withHostToolHooks,
  type HostHookIntegrationDeps
} from './hostHookIntegration'
import type { HostShellHookRunEvent } from './HostShellHookRunner'

const WORKSPACE = '/tmp/tw-hook-integration-ws'

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
    ...(overrides.onError !== undefined ? { onError: overrides.onError } : {})
  }
}

function snapshot(hooks: EffectiveHookCommand[]): EffectiveHooksSnapshot {
  return {
    schemaVersion: 1,
    workspacePath: WORKSPACE,
    hooks
  }
}

describe('buildMinimalHookEnv', () => {
  it('allows only the documented scrub allowlist and drops secrets', () => {
    const env = buildMinimalHookEnv({
      PATH: '/usr/bin',
      HOME: '/Users/tw',
      USER: 'tw',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      SECRET_TOKEN: 'should-not-pass',
      AWS_SECRET_ACCESS_KEY: 'nope',
      NODE_OPTIONS: '--require ./evil.js'
    })
    expect(Object.keys(env).sort()).toEqual([...HOOK_ENV_ALLOWLIST].sort())
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/tw')
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})

describe('createHostShellHookRunner workspace gate', () => {
  function deps(
    hooks: EffectiveHookCommand[],
    overrides: Partial<HostHookIntegrationDeps> = {}
  ): {
    deps: HostHookIntegrationDeps
    runShell: ReturnType<typeof vi.fn>
  } {
    const runShell = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    return {
      deps: {
        hooksStore: {
          resolveEffectiveHooks: () => snapshot(hooks)
        },
        runShell,
        ...overrides
      },
      runShell
    }
  }

  it('skips workspace-sourced hooks by default (allowWorkspaceHooks false)', async () => {
    const { deps: integrationDeps, runShell } = deps([
      makeHook({
        id: 'user-start',
        event: 'SessionStart',
        command: 'echo user',
        scope: 'user',
        source: 'user'
      }),
      makeHook({
        id: 'ws-start',
        event: 'SessionStart',
        command: 'echo workspace',
        scope: 'workspace',
        source: 'workspace'
      })
    ])

    const runner = createHostShellHookRunner(WORKSPACE, integrationDeps)
    await runner.runSessionStart()

    const commands = runShell.mock.calls.map((call) => call[0].command)
    expect(commands).toEqual(['echo user'])
  })

  it('runs workspace hooks only when allowWorkspaceHooks is true', async () => {
    const { deps: integrationDeps, runShell } = deps(
      [
        makeHook({
          id: 'user-start',
          event: 'SessionStart',
          command: 'echo user',
          scope: 'user',
          source: 'user'
        }),
        makeHook({
          id: 'ws-start',
          event: 'SessionStart',
          command: 'echo workspace',
          scope: 'workspace',
          source: 'workspace'
        })
      ],
      { allowWorkspaceHooks: true }
    )

    const runner = createHostShellHookRunner(WORKSPACE, integrationDeps)
    await runner.runSessionStart()

    const commands = runShell.mock.calls.map((call) => call[0].command)
    expect(commands).toEqual(['echo user', 'echo workspace'])
  })
})

describe('createHookRunEventEmitter', () => {
  const sampleEvent: HostShellHookRunEvent = {
    kind: 'hook_start',
    event: 'PreToolUse',
    hookId: 'pre-1',
    command: 'echo pre',
    toolName: 'read_file'
  }

  it('appends a lifecycle durable event when appRunId is present', () => {
    const append = vi.fn()
    const emit = createHookRunEventEmitter({
      append,
      appRunId: 'run-123',
      appChatId: 'chat-456'
    })

    emit(sampleEvent)

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-123',
        chatId: 'chat-456',
        kind: 'lifecycle',
        phase: 'control',
        source: 'main',
        payload: expect.objectContaining({
          kind: 'hook_start',
          hookId: 'pre-1',
          event: 'PreToolUse',
          hostHookEvent: true
        })
      })
    )
  })

  it('falls back to console.debug when appRunId is missing', () => {
    const append = vi.fn()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const emit = createHookRunEventEmitter({
      append,
      appChatId: 'chat-only'
    })

    emit(sampleEvent)

    expect(append).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('[hooks]'),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    debug.mockRestore()
  })

  it('denies by default when askBeforeHookCommands is on and requestApproval is omitted', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    const runner = createHostShellHookRunner(WORKSPACE, {
      hooksStore: {
        resolveEffectiveHooks: () =>
          snapshot([
            makeHook({
              id: 'ask-me',
              event: 'Stop',
              command: 'echo ask',
              scope: 'user',
              source: 'user'
            })
          ])
      },
      runShell,
      askBeforeHookCommands: true
    })

    const outcome = await runner.runStop({ status: 'done' })
    expect(outcome.blocked).toBe(false)
    expect(runShell).not.toHaveBeenCalled()
  })
})

describe('withHostToolHooks', () => {
  it('blocks run when PreToolUse fails closed and skips Post', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'nope' }))
    const run = vi.fn(async () => 'should-not-run')
    const result = await withHostToolHooks({
      workspacePath: WORKSPACE,
      toolName: 'run_shell_command',
      deps: {
        hooksStore: {
          resolveEffectiveHooks: () =>
            snapshot([
              makeHook({
                id: 'block-shell',
                event: 'PreToolUse',
                command: 'exit 2',
                matcher: 'run_shell',
                onError: 'block'
              }),
              makeHook({
                id: 'post-shell',
                event: 'PostToolUse',
                command: 'echo post'
              })
            ])
        },
        runShell,
        allowWorkspaceHooks: false
      },
      run,
      outcomeFromResult: () => 'ok'
    })

    expect(result).toEqual(
      expect.objectContaining({
        blocked: true,
        reason: expect.stringContaining('block-shell')
      })
    )
    expect(run).not.toHaveBeenCalled()
    expect(runShell.mock.calls.map((call) => String(call[0]?.command))).toEqual(['exit 2'])
  })

  it('runs the tool and fire-and-forgets PostToolUse with outcome', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    const run = vi.fn(async () => ({ decision: 'accept' as const }))
    const result = await withHostToolHooks({
      workspacePath: WORKSPACE,
      toolName: 'apply_patch',
      deps: {
        hooksStore: {
          resolveEffectiveHooks: () =>
            snapshot([
              makeHook({
                id: 'pre-ok',
                event: 'PreToolUse',
                command: 'echo pre'
              }),
              makeHook({
                id: 'post-ok',
                event: 'PostToolUse',
                command: 'echo post'
              })
            ])
        },
        runShell,
        allowWorkspaceHooks: false
      },
      run,
      outcomeFromResult: (value) => value.decision
    })

    expect(result).toEqual({ blocked: false, result: { decision: 'accept' } })
    expect(run).toHaveBeenCalledOnce()
    // Post is fire-and-forget — drain microtasks/macrotasks.
    await vi.waitFor(() => {
      const commands = runShell.mock.calls.map((call) => String(call[0]?.command))
      expect(commands).toEqual(['echo pre', 'echo post'])
    })
  })

  it('skips Post when outcomeFromResult returns null (deferred ask path)', async () => {
    const runShell = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    const result = await withHostToolHooks({
      workspacePath: WORKSPACE,
      toolName: 'run_shell_command',
      deps: {
        hooksStore: {
          resolveEffectiveHooks: () =>
            snapshot([
              makeHook({ id: 'pre', event: 'PreToolUse', command: 'echo pre' }),
              makeHook({ id: 'post', event: 'PostToolUse', command: 'echo post' })
            ])
        },
        runShell
      },
      run: async () => 'ask' as const,
      outcomeFromResult: () => null
    })

    expect(result).toEqual({ blocked: false, result: 'ask' })
    await Promise.resolve()
    await Promise.resolve()
    expect(runShell.mock.calls.map((call) => String(call[0]?.command))).toEqual(['echo pre'])
  })

  it('skips hooks entirely without workspace or hooksStore and still runs', async () => {
    const run = vi.fn(async () => 42)
    const result = await withHostToolHooks({
      workspacePath: '',
      toolName: 'read_file',
      run
    })
    expect(result).toEqual({ blocked: false, result: 42 })
    expect(run).toHaveBeenCalledOnce()
  })
})
