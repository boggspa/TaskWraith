import { describe, expect, it, vi } from 'vitest'
import type { EffectiveHookCommand, EffectiveHooksSnapshot } from '../../shared/hooks/HookTypes'
import {
  HOOK_ENV_ALLOWLIST,
  buildMinimalHookEnv,
  createHostShellHookRunner,
  type HostHookIntegrationDeps
} from './hostHookIntegration'

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
