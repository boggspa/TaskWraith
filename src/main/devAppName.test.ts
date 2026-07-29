import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMcpBridgeRouteEnv,
  MCP_BRIDGE_ENDPOINT_ENV_KEYS,
  MCP_BRIDGE_ENTRY_ARG,
  MCP_BRIDGE_ROUTE_FROM_ENV_ARG
} from './mcp/McpBridgeRoute'

const fakeApp = vi.hoisted(() => {
  const paths: Record<string, string> = {
    appData: '/tmp/taskwraith-dev-app-name-test-app-data',
    userData: '/tmp/taskwraith-dev-app-name-test-user-data'
  }
  return {
    isPackaged: false,
    getPath: (name: string) => paths[name] || '',
    setName: vi.fn(),
    setPath: vi.fn((name: string, value: string) => {
      paths[name] = value
    }),
    exit: vi.fn()
  }
})

vi.mock('electron', () => ({ app: fakeApp }))

import {
  instanceRelayPortOffset,
  isStaticMcpBridgeRouteLaunch,
  resolveDevAppNamePosture
} from './devAppName'

// resolve() so the fixture is CANONICAL on the host. readSocketPath in
// McpBridgeRoute deliberately rejects any socket path where
// `resolve(value) !== value` — a guard against non-canonical and traversal
// forms — and on Windows `resolve('/Users/...')` prefixes the current drive,
// so the literal POSIX form failed that check and every route built from it.
const appDataPath = resolve('/Users/example/Library/Application Support')
const temporaryDirectory = '/tmp'
const isolatedInstanceIdKey = MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId

// The Electron app-path in a dev static-bridge argv gets the SAME canonicality
// guard as a socket path: isDevStaticMcpBridgeProcessArgv (McpBridgeRoute.ts:423)
// requires `resolve(appPath) === appPath`. A POSIX literal fails that on Windows,
// the argv stops being exact route grammar, and the posture comes back `invalid`
// — which reads as a rejected dev profile rather than an unresolvable fixture.
function staticBridgeArgv(): string[] {
  return [
    resolve('/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'),
    MCP_BRIDGE_ENTRY_ARG,
    MCP_BRIDGE_ROUTE_FROM_ENV_ARG
  ]
}

function staticDevBridgeArgv(): string[] {
  return [
    resolve('/Applications/Electron.app/Contents/MacOS/Electron'),
    resolve('/Applications/TaskWraith Dev.app/Contents/Resources/app.asar'),
    MCP_BRIDGE_ENTRY_ARG,
    MCP_BRIDGE_ROUTE_FROM_ENV_ARG
  ]
}

function staticBridgeEnvironment(instanceId?: string): Record<string, string> {
  const profileRoot = instanceId
    ? join(appDataPath, 'TaskWraith Instances', instanceId)
    : join(appDataPath, 'TaskWraith')
  const built = buildMcpBridgeRouteEnv({
    parentProvider: 'cursor',
    route: { appRunId: 'static-run', appChatId: 'static-chat' },
    workspacePath: '/workspace/static-route',
    endpoint: {
      socketPath: join(profileRoot, 'taskwraith-gemini-mcp.sock'),
      brokerToken: 'b'.repeat(64),
      instanceEpoch: 'c'.repeat(32),
      bridgeLogEpoch: 3,
      ...(instanceId ? { isolatedInstanceId: instanceId } : {})
    },
    profile: {}
  })
  if (!built.ok) throw new Error('Expected a valid static bridge route environment.')
  return built.env
}

function staticDevBridgeEnvironment(devInstanceId = ''): Record<string, string> {
  const appName = devInstanceId ? `TaskWraith Dev ${devInstanceId}` : 'TaskWraith Dev'
  const built = buildMcpBridgeRouteEnv({
    parentProvider: 'cursor',
    route: { appRunId: 'dev-static-run', appChatId: 'dev-static-chat' },
    workspacePath: '/workspace/dev-static-route',
    endpoint: {
      socketPath: join(appDataPath, appName, 'taskwraith-gemini-mcp.sock'),
      brokerToken: 'd'.repeat(64),
      instanceEpoch: 'e'.repeat(32),
      bridgeLogEpoch: 4
    },
    profile: {}
  })
  if (!built.ok) throw new Error('Expected a valid development static bridge route environment.')
  return built.env
}

describe('devAppName packaged-private posture seam', () => {
  it('accepts the dedicated endpoint identity only for the exact static bridge helper shape', () => {
    expect(isolatedInstanceIdKey).toBeTypeOf('string')
    const instanceId = 'a'.repeat(32)
    const posture = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: {
        ...staticBridgeEnvironment(instanceId),
        TASKWRAITH_INSTANCE_ID: 'ambient-dev-id-must-not-matter'
      }
    })

    expect(posture).toMatchObject({
      kind: 'packaged-isolated',
      instanceId,
      userDataPath: join(appDataPath, 'TaskWraith Instances', instanceId)
    })
  })

  it('ignores endpoint and ambient identity variables for an ordinary packaged app launch', () => {
    const posture = resolveDevAppNamePosture({
      isPackaged: true,
      argv: ['/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'],
      appDataPath,
      temporaryDirectory,
      env: {
        [isolatedInstanceIdKey]: 'not-an-opaque-instance-id',
        TASKWRAITH_INSTANCE_ID: 'ambient-dev-id-must-not-matter'
      }
    })

    expect(posture).toEqual({ kind: 'production', isPackaged: true, isPrivateProfile: false })
  })

  it('fails closed when an exact static helper has missing or malformed private identity', () => {
    const missing = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: {}
    })
    const malformed = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: { [isolatedInstanceIdKey]: 'not-an-opaque-instance-id' }
    })

    expect(missing).toMatchObject({ kind: 'invalid', reason: 'invalid-packaged-isolated-instance' })
    expect(malformed).toMatchObject({
      kind: 'invalid',
      reason: 'invalid-packaged-isolated-instance'
    })
  })

  it('keeps an explicitly primary static helper in the primary packaged profile', () => {
    const posture = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: staticBridgeEnvironment()
    })

    expect(posture).toEqual({ kind: 'production', isPackaged: true, isPrivateProfile: false })
  })

  it('keeps route helper admission exact and gives isolated profiles a deterministic relay offset', () => {
    expect(isStaticMcpBridgeRouteLaunch(staticBridgeArgv())).toBe(true)
    expect(isStaticMcpBridgeRouteLaunch([...staticBridgeArgv(), '--extra'])).toBe(false)

    const first = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: staticBridgeEnvironment('a'.repeat(32))
    })
    const second = resolveDevAppNamePosture({
      isPackaged: true,
      argv: staticBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: staticBridgeEnvironment('b'.repeat(32))
    })

    expect(instanceRelayPortOffset(first)).toBe(instanceRelayPortOffset(first))
    expect(instanceRelayPortOffset(first)).toBeGreaterThanOrEqual(1_000)
    expect(instanceRelayPortOffset(first)).not.toBe(instanceRelayPortOffset(second))
  })

  it('refuses malformed static route grammar before it can resolve the primary profile', () => {
    const env = staticBridgeEnvironment()
    const invalidArgv = [
      [...staticBridgeArgv(), '--extra'],
      [staticBridgeArgv()[0], MCP_BRIDGE_ROUTE_FROM_ENV_ARG, MCP_BRIDGE_ENTRY_ARG],
      [staticBridgeArgv()[0], '--agentbench-gemini-mcp-bridge', MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
      [...staticBridgeArgv(), MCP_BRIDGE_ROUTE_FROM_ENV_ARG]
    ]

    for (const argv of invalidArgv) {
      expect(
        resolveDevAppNamePosture({
          isPackaged: true,
          argv,
          appDataPath,
          temporaryDirectory,
          env
        })
      ).toMatchObject({ kind: 'invalid', reason: 'invalid-packaged-isolated-instance' })
    }
  })

  it('refuses a primary selector paired with an isolated endpoint before profile selection', () => {
    const isolatedInstanceId = 'd'.repeat(32)
    const mismatched = {
      ...staticBridgeEnvironment(isolatedInstanceId),
      [isolatedInstanceIdKey]: ''
    }

    expect(
      resolveDevAppNamePosture({
        isPackaged: true,
        argv: staticBridgeArgv(),
        appDataPath,
        temporaryDirectory,
        env: mismatched
      })
    ).toMatchObject({ kind: 'invalid', reason: 'invalid-packaged-isolated-instance' })
  })

  it('refuses a same-id isolated endpoint from a foreign profile root before userData selection', () => {
    const instanceId = 'e'.repeat(32)
    const foreignRoot = resolve('/private/foreign/TaskWraith Instances', instanceId)
    const env = {
      ...staticBridgeEnvironment(instanceId),
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: join(foreignRoot, 'taskwraith-gemini-mcp.sock')
    }

    expect(
      resolveDevAppNamePosture({
        isPackaged: true,
        argv: staticBridgeArgv(),
        appDataPath,
        temporaryDirectory,
        env
      })
    ).toMatchObject({ kind: 'invalid', reason: 'invalid-packaged-isolated-instance' })
  })

  it('accepts only exact Electron app-path framing and binds a dev static helper to its own profile', () => {
    const devInstanceId = 'workbench'
    const isolatedDev = resolveDevAppNamePosture({
      isPackaged: false,
      argv: staticDevBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: {
        ...staticDevBridgeEnvironment(devInstanceId),
        TASKWRAITH_INSTANCE_ID: devInstanceId
      }
    })
    const primaryDev = resolveDevAppNamePosture({
      isPackaged: false,
      argv: staticDevBridgeArgv(),
      appDataPath,
      temporaryDirectory,
      env: staticDevBridgeEnvironment()
    })

    expect(isolatedDev).toMatchObject({
      kind: 'development',
      devInstanceId,
      userDataPath: join(appDataPath, `TaskWraith Dev ${devInstanceId}`)
    })
    expect(primaryDev).toMatchObject({
      kind: 'development',
      devInstanceId: '',
      userDataPath: join(appDataPath, 'TaskWraith Dev')
    })

    const invalidArgv = [
      [...staticDevBridgeArgv(), '--extra'],
      [
        staticDevBridgeArgv()[0],
        MCP_BRIDGE_ENTRY_ARG,
        staticDevBridgeArgv()[1],
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ],
      [
        staticDevBridgeArgv()[0],
        staticDevBridgeArgv()[1],
        '--agentbench-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ],
      [...staticDevBridgeArgv(), MCP_BRIDGE_ROUTE_FROM_ENV_ARG]
    ]
    for (const argv of invalidArgv) {
      expect(
        resolveDevAppNamePosture({
          isPackaged: false,
          argv,
          appDataPath,
          temporaryDirectory,
          env: staticDevBridgeEnvironment(devInstanceId)
        })
      ).toMatchObject({ kind: 'invalid', isPackaged: false })
    }
  })
})
