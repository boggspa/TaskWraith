/**
 * The CLI runner's `launchRefusal` hook, executed.
 *
 * The hook is a provider's last word before its child starts: the Desktop agy
 * send passes a live AntiGravity consent read there. Where the read sits is
 * pinned structurally in AntigravityProviderRuntime.integration.test.ts. This
 * suite runs the runner itself (lifted out of index.ts, which tests cannot
 * import) so a refusal is held to what the runner's other pre-spawn failures
 * do: the renderer gets the refusing sentence, a failed result marked
 * setupRequired and an exit; the run is settled; the transport closes, so the
 * send resolves; and a write-capable run's setup guard is released. A hook
 * that throws must refuse the same way rather than reject with all of that
 * left undone.
 */
import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_OPT_IN_REQUIRED_MESSAGE,
  antigravityLaunchConsentRefusal
} from './antigravity/AntigravityProviderRuntime'
import { liftMainFunctions } from './mainFunctionHarness.testutil'
import { MainSourceProbe } from './mainSourceProbe.testutil'
import { createProviderTransportCloseOperation } from './run/ProviderOperationRegistry'
import { settleProviderRunWithoutTransport } from './run/ProviderRunLifecycleOwnership'
import { routeWithRunId } from './run/RunRoute'

const probe = new MainSourceProbe('src/main/index.ts', new URL('./index.ts', import.meta.url))

type Runner = (...args: unknown[]) => Promise<void>

function runnerWorld() {
  const world = {
    renderer: [] as Array<{ kind: 'error' | 'line' | 'exit'; value: unknown }>,
    settled: [] as Array<[string, string]>,
    denied: 0,
    guardReleased: 0,
    transportClosed: 0,
    spawns: [] as string[],
    logged: [] as unknown[][]
  }
  const { runCliProviderProcess } = liftMainFunctions<{ runCliProviderProcess: Runner }>(
    probe,
    [
      'runCliProviderProcess',
      'settleVisibleProviderSetupFailure',
      'projectVisibleProviderSetupFailure'
    ],
    {
      routeWithRunId,
      // A write-capable run, so the runner holds a workspace-lock setup guard
      // that every pre-spawn failure must release.
      providerRunRequiresCoarseWorkspaceLock: () => true,
      workspaceLockProviderCoordinator: {
        get: () => ({ owner: { lifecycle: 'launching-child' } }),
        launchOwnerId: () => 'owner-1',
        releaseSetupFailure: async () => {
          world.guardReleased += 1
        }
      },
      workspaceLockRunLifecycle: { begin: () => ({ finish: () => undefined }) },
      poisonWorkspaceLockMutationAdmission: () => undefined,
      createProviderTransportCloseOperation: (cleanup?: () => Promise<void> | void) => {
        const close = createProviderTransportCloseOperation(cleanup)
        return {
          operation: close.operation,
          markTransportClosed: () => {
            world.transportClosed += 1
            close.markTransportClosed()
          }
        }
      },
      providerTransportLaunchAuthorized: () => true,
      settleDeniedProviderTransportLaunch: () => {
        world.denied += 1
      },
      normalizeCliProviderModel: (_provider: string, model?: string) => model ?? '',
      registerRunSession: () => ({}),
      providerContextDiagnostics: { configureClaude: () => undefined },
      providerTransportOperations: { track: (_runId: string, operation: unknown) => operation },
      emitProviderCapabilityWarnings: async () => undefined,
      sendAgentCompatLine: (_sender: unknown, _provider: unknown, line: unknown) => {
        world.renderer.push({ kind: 'line', value: line })
      },
      sendAgentCompatError: (_sender: unknown, _provider: unknown, message: unknown) => {
        world.renderer.push({ kind: 'error', value: message })
      },
      sendAgentCompatExit: (_sender: unknown, _provider: unknown, code: unknown) => {
        world.renderer.push({ kind: 'exit', value: code })
      },
      providerDisplayName: (provider: string) =>
        provider === 'antigravity' ? 'AntiGravity' : provider,
      settleProviderRunWithoutTransport,
      runManager: {
        getClaimedTerminalStatus: () => undefined,
        finish: (runId: string, status: string) => {
          world.settled.push([runId, status])
        },
        confirmTerminalStatus: () => undefined
      },
      withExactWorkspaceLockOwnerEnv: (env: unknown) => env,
      createCliProviderRunEnv: () => ({}),
      spawn: (command: string) => {
        world.spawns.push(command)
        throw new Error('the spawn was reached')
      },
      console: {
        error: (...args: unknown[]) => {
          world.logged.push(args)
        },
        warn: () => undefined,
        log: () => undefined,
        info: () => undefined,
        debug: () => undefined
      }
    }
  )

  // Resolves 'settled' only once the send's transport operation settles, which
  // a refusal that leaves the transport open never does.
  const send = async (launchRefusal: () => string | null): Promise<string> => {
    const run = runCliProviderProcess(
      { sender: { id: 1 } },
      'antigravity',
      '/opt/agy',
      ['--print'],
      {
        provider: 'antigravity',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        prompt: 'inspect the repo',
        model: 'gemini-3.7-flash-high',
        workspace: '/workspace',
        scope: 'workspace'
      },
      {
        fallback: false,
        requireExistingRun: true,
        resolvedEnv: { PATH: '/usr/bin' },
        launchRefusal
      }
    ).then(
      () => 'settled',
      (error: Error) => `rejected: ${error.message}`
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('still open'), 250)
    })
    try {
      return await Promise.race([run, open])
    } finally {
      clearTimeout(timer)
    }
  }
  // The init line is the runner's ordinary start projection, not the refusal.
  const refusalProjection = () =>
    world.renderer
      .filter(
        (entry) => !(entry.kind === 'line' && (entry.value as { type?: string }).type === 'init')
      )
      .map((entry) =>
        entry.kind === 'line'
          ? {
              kind: entry.kind,
              type: (entry.value as { type?: string }).type,
              status: (entry.value as { status?: string }).status,
              setupRequired: (entry.value as { setupRequired?: boolean }).setupRequired
            }
          : entry
      )
  return { world, send, refusalProjection }
}

describe('the CLI runner launch refusal', () => {
  it('control: a hook that permits reaches the spawn', async () => {
    const { world, send } = runnerWorld()
    const hookCalls: number[] = []

    await send(() => {
      hookCalls.push(world.spawns.length)
      return null
    })

    // Asked once, before the spawn, and the spawn follows. Without this the
    // refusal cases' "no spawn" could be satisfied by a harness that never
    // gets that far.
    expect(hookCalls).toEqual([0])
    expect(world.spawns).toEqual(['/opt/agy'])
  })

  it('a refusal settles like every other pre-spawn failure: sentence, setupRequired, exit, closed transport, released guard', async () => {
    const { world, send, refusalProjection } = runnerWorld()
    const withdrawn = { antigravityEnabled: false, antigravityOptInAcceptedAt: null }

    const outcome = await send(() => antigravityLaunchConsentRefusal(withdrawn as never))

    expect(world.spawns).toEqual([])
    expect(refusalProjection()).toEqual([
      { kind: 'error', value: ANTIGRAVITY_OPT_IN_REQUIRED_MESSAGE },
      { kind: 'line', type: 'result', status: 'failed', setupRequired: true },
      { kind: 'exit', value: 1 }
    ])
    expect(world.settled).toEqual([['run-1', 'failed']])
    expect(world.transportClosed).toBe(1)
    expect(outcome).toBe('settled')
    expect(world.guardReleased).toBe(1)
    expect(world.denied).toBe(0)
  })

  it('a hook that throws refuses the same way, and the error is logged', async () => {
    const { world, send, refusalProjection } = runnerWorld()
    const failure = new Error('settings read failed (ENOSPC)')

    const outcome = await send(() => {
      throw failure
    })

    expect(outcome).toBe('settled')
    expect(world.spawns).toEqual([])
    expect(refusalProjection()).toEqual([
      {
        kind: 'error',
        value:
          'AntiGravity could not confirm that it may start, so it was not started: settings read failed (ENOSPC)'
      },
      { kind: 'line', type: 'result', status: 'failed', setupRequired: true },
      { kind: 'exit', value: 1 }
    ])
    expect(world.settled).toEqual([['run-1', 'failed']])
    expect(world.transportClosed).toBe(1)
    expect(world.guardReleased).toBe(1)
    expect(world.logged).toEqual([['[antigravity] launch refusal check failed:', failure]])
  })
})
