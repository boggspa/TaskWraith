/**
 * The official ACP AntiGravity lane, executed around its long waits.
 *
 * `runAntigravityOfficialAcpProvider` reads consent on entry, then awaits the
 * binary resolve (up to 60 s of download and 120 s of extraction) and, for a
 * broker-attached seat, the MCP broker start. The user can stop the run or
 * withdraw consent in Settings during either wait. This lifts the real lane
 * out of index.ts (which tests cannot import), holds each wait, changes the
 * world while it is held, and checks that nothing is spawned: the ACP client
 * spawns synchronously inside `runTurn`, so reaching `runTurn` is reaching the
 * spawn. A Stop settles through the launch fence; a withdrawal settles as a
 * visible setup failure carrying the lane's consent sentence.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAntigravityOptInEnabled } from '../shared/retiredProviders'
import { liftMainFunctions } from './mainFunctionHarness.testutil'
import { MainSourceProbe } from './mainSourceProbe.testutil'
import { settleProviderRunWithoutTransport } from './run/ProviderRunLifecycleOwnership'

const probe = new MainSourceProbe('src/main/index.ts', new URL('./index.ts', import.meta.url))

const OPT_IN_REQUIRED =
  'AntiGravity is not enabled. Accept the AntiGravity opt-in in Settings -> Providers before using the official ACP transport. The binary was not launched.'

type HoldPoint = 'resolve' | 'broker'
type Lane = (...args: unknown[]) => Promise<void>

function acpWorld(options: { broker: boolean }) {
  const world = {
    settings: { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 } as Record<
      string,
      unknown
    >,
    admitted: true,
    holds: {} as Partial<Record<HoldPoint, { release?: () => void }>>,
    runTurns: 0,
    denied: 0,
    renderer: [] as Array<{ kind: 'error' | 'line' | 'exit'; value: unknown }>,
    settled: [] as Array<[string, string]>
  }
  const gate = async (point: HoldPoint): Promise<void> => {
    const hold = world.holds[point]
    if (!hold) return
    await new Promise<void>((release) => {
      hold.release = release
    })
  }
  const off = () => false
  const { runAntigravityOfficialAcpProvider } = liftMainFunctions<{
    runAntigravityOfficialAcpProvider: Lane
  }>(
    probe,
    [
      'runAntigravityOfficialAcpProvider',
      'settleVisibleProviderSetupFailure',
      'projectVisibleProviderSetupFailure'
    ],
    {
      isAntigravityOptInEnabled,
      AppStore: { getSettings: () => world.settings },
      app: { getPath: () => '/taskwraith-user-data', getVersion: () => '0.0.0-test' },
      join,
      createAntigravityAcpDownloadArchive: () => ({}),
      createAntigravityAcpExtractArchive: () => ({}),
      createAntigravityAcpBinaryResolver: () => ({
        resolve: async () => {
          await gate('resolve')
          return { binaryPath: '/taskwraith-user-data/antigravity-acp/agy-acp', args: [] }
        }
      }),
      antigravityAcpWriteCapable: off,
      shouldAdvertiseTaskWraithMcpToAntigravityAcp: () => options.broker,
      antigravityAcpMcpAdvertiseEnabled: () => options.broker,
      taskwraithMcpBridgeCommandStatus: () => ({ available: true, command: 'taskwraith-mcp' }),
      taskwraithMcpBridgeUnavailableMessage: () => 'unavailable',
      mcpBridgeRuntime: {
        startGeminiMcpBroker: async () => {
          await gate('broker')
        }
      },
      taskwraithMcpBridgeArgs: () => [],
      geminiMcpSocketPath: () => 'taskwraith-mcp.sock',
      isCoreTaskWraithMcpProfile: off,
      isGatewayTaskWraithMcpProfile: off,
      isPortableEnsembleControlMcpProfile: off,
      isMeshCanvasDirectTaskWraithMcpProfile: off,
      isMeshTopologyDirectTaskWraithMcpProfile: off,
      isSketchCanvasDirectTaskWraithMcpProfile: off,
      isGatewayV13DirectTaskWraithMcpProfile: off,
      isSoloTaskWraithMcpProfile: off,
      isPermissionOpportunityDirectTaskWraithMcpProfile: off,
      ANTIGRAVITY_ACP_SCOPED_MCP_SERVER_NAME: 'taskwraith-scoped',
      GEMINI_MCP_SERVER_NAME: 'taskwraith',
      GEMINI_MCP_AUDIT_SUBSET_ARG: '--audit',
      GEMINI_MCP_BRIDGE_ENV: 'TASKWRAITH_MCP_BRIDGE',
      providerTransportLaunchAuthorized: () => world.admitted,
      settleDeniedProviderTransportLaunch: () => {
        world.denied += 1
      },
      createAntigravityAcpSpawnProcess: () => () => {
        throw new Error('the ACP client spawns inside runTurn, which this world replaces')
      },
      createAntigravityAcpClient: () => ({
        runTurn: () => {
          world.runTurns += 1
          return { closed: Promise.resolve() }
        }
      }),
      recordProviderToolCapability: () => ({}),
      configureRunManagedToolReceipt: () => undefined,
      createAntigravityAcpPermissionHandler: () => async () => ({ outcome: 'deny' }),
      preflightNativeWorkspaceTool: () => ({ allowed: false }),
      grokReadOnlyShellRequestAllowed: off,
      createAntigravityAcpTurnAbortController: () => new AbortController(),
      sendAgentCompatLine: (_sender: unknown, _provider: unknown, line: unknown) => {
        world.renderer.push({ kind: 'line', value: line })
      },
      sendAgentCompatError: (_sender: unknown, _provider: unknown, message: unknown) => {
        world.renderer.push({ kind: 'error', value: message })
      },
      sendAgentCompatExit: (_sender: unknown, _provider: unknown, code: unknown) => {
        world.renderer.push({ kind: 'exit', value: code })
      },
      settleProviderRunWithoutTransport,
      runManager: {
        getClaimedTerminalStatus: () => undefined,
        finish: (runId: string, status: string) => {
          world.settled.push([runId, status])
        },
        confirmTerminalStatus: () => undefined,
        attachAbortController: () => undefined
      }
    }
  )
  const run = () =>
    runAntigravityOfficialAcpProvider(
      { sender: { id: 1 } },
      {
        provider: 'antigravity',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        prompt: 'inspect the repo',
        model: 'antigravity-acp:gemini-3.7-flash-high',
        workspace: '/workspace',
        scope: 'workspace',
        approvalMode: 'plan',
        taskWraithMcpAdvertised: options.broker
      },
      { appRunId: 'run-1', appChatId: 'chat-1' }
    )
  const holdThen = async (point: HoldPoint, change: () => void): Promise<void> => {
    world.holds[point] = {}
    const lane = run()
    for (let attempt = 0; attempt < 100 && !world.holds[point]?.release; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const release = world.holds[point]?.release
    if (!release) throw new Error(`the lane never reached the ${point} wait`)
    change()
    release()
    await lane
  }
  const withdraw = () => {
    world.settings = {
      ...world.settings,
      antigravityEnabled: false,
      antigravityOptInAcceptedAt: null
    }
  }
  const refusal = () =>
    world.renderer.map((entry) =>
      entry.kind === 'line'
        ? {
            kind: entry.kind,
            status: (entry.value as { status?: string }).status,
            setupRequired: (entry.value as { setupRequired?: boolean }).setupRequired
          }
        : entry
    )
  return { world, run, holdThen, withdraw, refusal }
}

describe('the official ACP lane after its long waits', () => {
  for (const point of ['resolve', 'broker'] as const) {
    it(`control: with nothing changed during the ${point} wait, the lane reaches the spawn`, async () => {
      const { world, holdThen } = acpWorld({ broker: point === 'broker' })

      await holdThen(point, () => {})

      expect(world.runTurns).toBe(1)
      expect(world.renderer).toEqual([])
    })

    it(`consent withdrawn during the ${point} wait: nothing spawns, and the refusal is visible`, async () => {
      const { world, holdThen, withdraw, refusal } = acpWorld({ broker: point === 'broker' })

      await holdThen(point, withdraw)

      expect(world.runTurns).toBe(0)
      expect(refusal()).toEqual([
        { kind: 'error', value: OPT_IN_REQUIRED },
        { kind: 'line', status: 'failed', setupRequired: true },
        { kind: 'exit', value: 1 }
      ])
      expect(world.settled).toEqual([['run-1', 'failed']])
    })

    it(`stopped during the ${point} wait: the launch fence settles the run and nothing spawns`, async () => {
      const { world, holdThen } = acpWorld({ broker: point === 'broker' })

      await holdThen(point, () => {
        world.admitted = false
      })

      expect(world.runTurns).toBe(0)
      expect(world.denied).toBe(1)
      expect(world.renderer).toEqual([])
    })
  }
})
