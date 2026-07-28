import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import {
  applyMcpBridgeProfileArgvToEnv,
  bridgeSubprocessLogPathForSocket,
  GEMINI_MCP_AUDIT_SUBSET_ARG,
  GEMINI_MCP_BRIDGE_ARG,
  GEMINI_MCP_SAFE_SUBSET_ARG,
  McpBridgeRuntime,
  startGeminiMcpBridgeProcess
} from './McpBridgeRuntime'
import {
  buildMcpBridgeRouteEnv,
  MCP_BRIDGE_ENDPOINT_ENV_KEYS,
  MCP_BRIDGE_PROFILE_ENV_KEYS,
  MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
  parseMcpBridgeRouteFromEnv
} from './McpBridgeRoute'

const tokenA = 'a'.repeat(64)
const tokenB = 'b'.repeat(64)
const epochA = 'c'.repeat(32)
const epochB = 'd'.repeat(32)

function privateDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(join(tmpdir(), prefix))
  fs.chmodSync(directory, 0o700)
  return directory
}

function runtimeFor(input: { socketPath: string; brokerToken: string; instanceEpoch: string }) {
  return new McpBridgeRuntime({
    getGeminiMcpSocketPath: () => input.socketPath,
    getGeminiMcpBrokerToken: () => input.brokerToken,
    getInstanceEpoch: () => input.instanceEpoch,
    getAppPath: () => '/Applications/TaskWraith.app/Contents/Resources/app.asar',
    getProcessExecPath: () => '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    isDev: () => false,
    isPackaged: () => true
  } as never)
}

function staticRouteEnvironment(input: {
  socketPath: string
  brokerToken?: string
  instanceEpoch?: string
  isolatedInstanceId?: string
  profile?: Record<string, boolean>
}): Record<string, string> {
  const built = buildMcpBridgeRouteEnv({
    parentProvider: 'cursor',
    route: { appRunId: 'run-static', appChatId: 'chat-static' },
    workspacePath: '/workspace/static',
    endpoint: {
      socketPath: input.socketPath,
      brokerToken: input.brokerToken || tokenA,
      instanceEpoch: input.instanceEpoch || epochA,
      bridgeLogEpoch: 0,
      ...(input.isolatedInstanceId ? { isolatedInstanceId: input.isolatedInstanceId } : {})
    },
    profile: input.profile || {}
  })
  if (!built.ok) throw new Error('Expected valid static bridge route environment.')
  return built.env
}

function createIsolatedSocket(
  prefix: string,
  instanceId: string
): {
  directory: string
  profileRoot: string
  socketPath: string
} {
  const directory = privateDirectory(prefix)
  const profileParent = join(directory, 'TaskWraith Instances')
  const profileRoot = join(profileParent, instanceId)
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 })
  fs.chmodSync(profileParent, 0o700)
  fs.chmodSync(profileRoot, 0o700)
  return {
    directory,
    profileRoot,
    socketPath: join(profileRoot, 'taskwraith-gemini-mcp.sock')
  }
}

describe('MCP bridge packaged instance isolation', () => {
  it('keeps persisted registration argv static while each provider run receives isolated live authority', () => {
    const directoryA = privateDirectory('taskwraith-mcp-instance-a-')
    const directoryB = privateDirectory('taskwraith-mcp-instance-b-')
    const isolatedInstanceId = 'e'.repeat(32)
    try {
      const isolatedProfileRoot = join(directoryA, 'TaskWraith Instances', isolatedInstanceId)
      fs.mkdirSync(isolatedProfileRoot, { recursive: true, mode: 0o700 })
      fs.chmodSync(join(directoryA, 'TaskWraith Instances'), 0o700)
      fs.chmodSync(isolatedProfileRoot, 0o700)
      const runtimeA = runtimeFor({
        socketPath: join(isolatedProfileRoot, 'taskwraith-gemini-mcp.sock'),
        brokerToken: tokenA,
        instanceEpoch: epochA
      })
      const runtimeB = runtimeFor({
        socketPath: join(directoryB, 'taskwraith-gemini-mcp.sock'),
        brokerToken: tokenB,
        instanceEpoch: epochB
      })
      const staticA = runtimeA.taskwraithMcpBridgeStaticRegistrationArgs()
      const staticB = runtimeB.taskwraithMcpBridgeStaticRegistrationArgs()
      const environmentA = runtimeA.buildProviderRunMcpBridgeEnv({
        parentProvider: 'cursor',
        route: { appRunId: 'run-a', appChatId: 'chat-a' },
        workspacePath: '/workspace/a',
        profile: { gatewaySubset: true },
        isolatedInstanceId
      })
      const environmentB = runtimeB.buildProviderRunMcpBridgeEnv({
        parentProvider: 'cursor',
        route: { appRunId: 'run-b', appChatId: 'chat-b' },
        workspacePath: '/workspace/b',
        profile: { safeSubset: true }
      })

      expect(staticA).toEqual([GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG])
      expect(staticB).toEqual(staticA)
      expect(JSON.stringify(staticA)).not.toContain(tokenA)
      expect(JSON.stringify(staticA)).not.toContain(epochA)
      expect(JSON.stringify(staticA)).not.toContain(directoryA)
      expect(environmentA[MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]).toBe(tokenA)
      expect(environmentB[MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]).toBe(tokenB)
      expect(environmentA[MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]).toBe(epochA)
      expect(environmentB[MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]).toBe(epochB)
      expect(parseMcpBridgeRouteFromEnv(environmentA)).toMatchObject({
        ok: true,
        value: { endpoint: { isolatedInstanceId } }
      })
      expect(parseMcpBridgeRouteFromEnv(environmentB)).toMatchObject({ ok: true })
      expect(
        bridgeSubprocessLogPathForSocket(join(isolatedProfileRoot, 'taskwraith-gemini-mcp.sock'))
      ).not.toBe(bridgeSubprocessLogPathForSocket(join(directoryB, 'taskwraith-gemini-mcp.sock')))
      expect(runtimeA.getBridgeSubprocessLogPath()).toBe(
        join(isolatedProfileRoot, 'bridge-logs', 'bridge-subprocess.log')
      )
    } finally {
      fs.rmSync(directoryA, { recursive: true, force: true })
      fs.rmSync(directoryB, { recursive: true, force: true })
    }
  })

  it('requires the boot instance epoch on generic broker requests while preserving run-bound Pi credentials', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => tokenA,
      getInstanceEpoch: () => epochA,
      executeGeminiMcpTool
    } as never)

    await expect(
      runtime.handleGeminiMcpBrokerRequest({ token: tokenA, tool: 'read_file' })
    ).resolves.toEqual({ ok: false, error: 'TaskWraith MCP broker authentication failed.' })
    await expect(
      runtime.handleGeminiMcpBrokerRequest({
        token: tokenA,
        instanceEpoch: epochB,
        tool: 'read_file'
      })
    ).resolves.toEqual({ ok: false, error: 'TaskWraith MCP broker authentication failed.' })

    await runtime.handleGeminiMcpBrokerRequest({
      token: tokenA,
      instanceEpoch: epochA,
      tool: 'read_file',
      arguments: { path: 'README.md' },
      appRunId: 'run-a',
      appChatId: 'chat-a'
    })
    expect(executeGeminiMcpTool).toHaveBeenCalledOnce()

    const piCredential = runtime.issuePiEnsembleCoordinationCredential({
      appRunId: 'pi-run',
      appChatId: 'pi-chat'
    })
    await runtime.handleGeminiMcpBrokerRequest({
      token: piCredential,
      tool: 'ensemble_yield',
      arguments: { target: 'Reviewer' },
      appRunId: 'pi-run',
      appChatId: 'pi-chat'
    })
    expect(executeGeminiMcpTool).toHaveBeenCalledTimes(2)
  })

  it('recognizes static Gemini registrations as current instead of comparing a live endpoint', () => {
    const directory = privateDirectory('taskwraith-mcp-static-registration-')
    try {
      const runtime = runtimeFor({
        socketPath: join(directory, 'taskwraith-gemini-mcp.sock'),
        brokerToken: tokenA,
        instanceEpoch: epochA
      })
      const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
      const staticArgs = runtime.taskwraithMcpBridgeStaticRegistrationArgs()
      const server = {
        command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
        args: staticArgs,
        trust: true,
        includeTools: [...TASKWRAITH_MCP_TOOLS]
      }

      expect(runtime.geminiMcpBridgeServerNeedsRepair(server, socketPath)).toBe(false)
      expect(
        runtime.hasStaleGeminiMcpBridgeRegistration(
          `TaskWraith ${server.command} ${staticArgs.join(' ')}`,
          socketPath
        )
      ).toBe(false)
      expect(
        runtime.geminiMcpBridgeServerNeedsRepair(
          { ...server, args: runtime.taskwraithMcpBridgeArgs(socketPath) },
          socketPath
        )
      ).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails route-from-env bootstrap before attaching bridge process handlers when authority is incomplete', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const exit = vi.fn()
    const getDefaultSocketPath = vi.fn(() => '/private/primary/taskwraith-gemini-mcp.sock')
    startGeminiMcpBridgeProcess({
      getDefaultSocketPath,
      getAppVersion: () => 'test',
      getMcpToolDefinitions: () => [],
      argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
      env: {
        [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: '/private/primary/taskwraith-gemini-mcp.sock'
      },
      stdin: stdin as never,
      stdout: stdout as never,
      exit
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(getDefaultSocketPath).not.toHaveBeenCalled()
    expect(stdin.listenerCount('data')).toBe(0)
    expect(stdin.listenerCount('end')).toBe(0)
  })

  it('clears ambient direct bridge profile flags unless immutable argv selects them', () => {
    const env = Object.fromEntries(
      Object.values(MCP_BRIDGE_PROFILE_ENV_KEYS).map((key) => [key, '1'])
    ) as Record<string, string | undefined>
    applyMcpBridgeProfileArgvToEnv(['taskwraith', GEMINI_MCP_BRIDGE_ARG], env)
    for (const envKey of Object.values(MCP_BRIDGE_PROFILE_ENV_KEYS)) {
      expect(env[envKey]).toBe('0')
    }

    applyMcpBridgeProfileArgvToEnv(
      [
        'taskwraith',
        GEMINI_MCP_BRIDGE_ARG,
        GEMINI_MCP_SAFE_SUBSET_ARG,
        GEMINI_MCP_AUDIT_SUBSET_ARG
      ],
      env
    )
    expect(env[MCP_BRIDGE_PROFILE_ENV_KEYS.safeSubset]).toBe('1')
    expect(env[MCP_BRIDGE_PROFILE_ENV_KEYS.auditSubset]).toBe('1')
    expect(env[MCP_BRIDGE_PROFILE_ENV_KEYS.gatewaySubset]).toBe('0')

    const staticEnv = { ...env }
    applyMcpBridgeProfileArgvToEnv(
      ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
      staticEnv
    )
    expect(staticEnv).toEqual(env)
  })

  it('rejects extra, reordered, legacy, and duplicate static route argv before handlers or logs', () => {
    const directory = privateDirectory('taskwraith-mcp-static-grammar-')
    try {
      const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
      const env = staticRouteEnvironment({ socketPath })
      const invalidArgv = [
        ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG, '--extra'],
        ['taskwraith', MCP_BRIDGE_ROUTE_FROM_ENV_ARG, GEMINI_MCP_BRIDGE_ARG],
        ['taskwraith', '--agentbench-gemini-mcp-bridge', MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
        [
          'taskwraith',
          GEMINI_MCP_BRIDGE_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG
        ],
        [
          '/Applications/Electron.app/Contents/MacOS/Electron',
          '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar',
          GEMINI_MCP_BRIDGE_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
          '--extra'
        ],
        [
          '/Applications/Electron.app/Contents/MacOS/Electron',
          GEMINI_MCP_BRIDGE_ARG,
          '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar',
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG
        ],
        [
          '/Applications/Electron.app/Contents/MacOS/Electron',
          '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar',
          '--agentbench-gemini-mcp-bridge',
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG
        ],
        [
          '/Applications/Electron.app/Contents/MacOS/Electron',
          '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar',
          GEMINI_MCP_BRIDGE_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG
        ]
      ]

      for (const argv of invalidArgv) {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const exit = vi.fn()
        const brokerRequest = vi.fn()
        const getDefaultSocketPath = vi.fn(() => '/private/must-not-fallback.sock')
        startGeminiMcpBridgeProcess({
          getDefaultSocketPath,
          getAppVersion: () => 'test',
          getMcpToolDefinitions: () => [],
          argv,
          env: { ...env },
          stdin: stdin as never,
          stdout: stdout as never,
          brokerRequest,
          exit
        })

        expect(exit).toHaveBeenCalledWith(1)
        expect(getDefaultSocketPath).not.toHaveBeenCalled()
        expect(brokerRequest).not.toHaveBeenCalled()
        expect(stdin.listenerCount('data')).toBe(0)
        expect(stdin.listenerCount('end')).toBe(0)
        expect(stdin.listenerCount('close')).toBe(0)
        expect(stdout.listenerCount('error')).toBe(0)
      }
      expect(fs.existsSync(join(directory, 'bridge-logs'))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects mismatched or empty isolated route identities before primary fallback or log setup', () => {
    const isolatedInstanceId = 'e'.repeat(32)
    const isolated = createIsolatedSocket('taskwraith-mcp-isolated-bind-', isolatedInstanceId)
    try {
      const validEnv = staticRouteEnvironment({
        socketPath: isolated.socketPath,
        isolatedInstanceId
      })
      const invalidEnvs = [
        {
          ...validEnv,
          [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: 'f'.repeat(32)
        },
        {
          ...validEnv,
          [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: ''
        }
      ]

      for (const env of invalidEnvs) {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const exit = vi.fn()
        const getDefaultSocketPath = vi.fn(() => '/private/must-not-fallback.sock')
        startGeminiMcpBridgeProcess({
          getDefaultSocketPath,
          getAppVersion: () => 'test',
          getMcpToolDefinitions: () => [],
          argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
          env,
          stdin: stdin as never,
          stdout: stdout as never,
          exit
        })
        expect(exit).toHaveBeenCalledWith(1)
        expect(getDefaultSocketPath).not.toHaveBeenCalled()
        expect(stdin.listenerCount('data')).toBe(0)
        expect(stdin.listenerCount('end')).toBe(0)
      }
      expect(fs.existsSync(join(isolated.profileRoot, 'bridge-logs'))).toBe(false)
    } finally {
      fs.rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  it('rejects an otherwise valid isolated endpoint from a different profile root', () => {
    const isolatedInstanceId = 'e'.repeat(32)
    const local = createIsolatedSocket('taskwraith-mcp-isolated-local-', isolatedInstanceId)
    const foreign = createIsolatedSocket('taskwraith-mcp-isolated-foreign-', isolatedInstanceId)
    try {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const exit = vi.fn()
      startGeminiMcpBridgeProcess({
        getDefaultSocketPath: () => local.socketPath,
        getAppVersion: () => 'test',
        getMcpToolDefinitions: () => [],
        argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
        env: staticRouteEnvironment({
          socketPath: foreign.socketPath,
          isolatedInstanceId
        }),
        stdin: stdin as never,
        stdout: stdout as never,
        exit
      })

      expect(exit).toHaveBeenCalledWith(1)
      expect(stdin.listenerCount('data')).toBe(0)
      expect(fs.existsSync(join(local.profileRoot, 'bridge-logs'))).toBe(false)
      expect(fs.existsSync(join(foreign.profileRoot, 'bridge-logs'))).toBe(false)
    } finally {
      fs.rmSync(local.directory, { recursive: true, force: true })
      fs.rmSync(foreign.directory, { recursive: true, force: true })
    }
  })

  it('routes an exact static helper through its isolated broker and log namespace', async () => {
    const isolatedInstanceId = 'e'.repeat(32)
    const isolated = createIsolatedSocket('taskwraith-mcp-static-happy-', isolatedInstanceId)
    try {
      const env = staticRouteEnvironment({
        socketPath: isolated.socketPath,
        isolatedInstanceId,
        profile: { gatewaySubset: true }
      })
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const exit = vi.fn()
      const brokerRequest = vi.fn(async () => ({ ok: true, text: 'isolated route accepted' }))
      let output = ''
      stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })

      startGeminiMcpBridgeProcess({
        getDefaultSocketPath: () => isolated.socketPath,
        getAppVersion: () => 'test',
        getMcpToolDefinitions: () => [{ name: 'read_file' }],
        argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
        env,
        stdin: stdin as never,
        stdout: stdout as never,
        brokerRequest,
        exit
      })
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'static-route-call',
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: 'README.md' } }
        })}\n`
      )

      await vi.waitFor(() => expect(brokerRequest).toHaveBeenCalledOnce())
      expect(brokerRequest).toHaveBeenCalledWith(
        isolated.socketPath,
        expect.objectContaining({
          token: tokenA,
          instanceEpoch: epochA,
          appRunId: 'run-static',
          appChatId: 'chat-static',
          parentProvider: 'cursor'
        })
      )
      await vi.waitFor(() => expect(output).toContain('isolated route accepted'))
      expect(
        fs.existsSync(join(isolated.profileRoot, 'bridge-logs', 'bridge-subprocess.log'))
      ).toBe(true)
      stdin.end()
    } finally {
      fs.rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  it('runs the exact Electron app-path static grammar without accepting a legacy suffix', async () => {
    const directory = privateDirectory('taskwraith-mcp-dev-static-happy-')
    try {
      const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
      const env = staticRouteEnvironment({ socketPath })
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const exit = vi.fn()
      const brokerRequest = vi.fn(async () => ({ ok: true, text: 'dev static route accepted' }))
      let output = ''
      stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })

      startGeminiMcpBridgeProcess({
        getDefaultSocketPath: () => socketPath,
        getAppVersion: () => 'test',
        getMcpToolDefinitions: () => [{ name: 'read_file' }],
        argv: [
          '/Applications/Electron.app/Contents/MacOS/Electron',
          '/Applications/TaskWraith Dev.app/Contents/Resources/app.asar',
          GEMINI_MCP_BRIDGE_ARG,
          MCP_BRIDGE_ROUTE_FROM_ENV_ARG
        ],
        env,
        stdin: stdin as never,
        stdout: stdout as never,
        brokerRequest,
        exit
      })
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'dev-static-route-call',
          method: 'tools/call',
          params: { name: 'read_file', arguments: { path: 'README.md' } }
        })}\n`
      )

      await vi.waitFor(() => expect(brokerRequest).toHaveBeenCalledOnce())
      expect(brokerRequest).toHaveBeenCalledWith(
        socketPath,
        expect.objectContaining({
          appRunId: 'run-static',
          appChatId: 'chat-static',
          parentProvider: 'cursor'
        })
      )
      await vi.waitFor(() => expect(output).toContain('dev static route accepted'))
      expect(exit).not.toHaveBeenCalledWith(1)
      stdin.end()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
