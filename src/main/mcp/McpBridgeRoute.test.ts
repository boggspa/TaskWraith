import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildMcpBridgeRouteEnv,
  buildStaticMcpBridgeRegistrationArgv,
  hasMcpBridgeRouteFromEnvArg,
  isDevStaticMcpBridgeProcessArgv,
  isStaticMcpBridgeRegistrationArgv,
  MCP_BRIDGE_ENDPOINT_ENV_KEYS,
  MCP_BRIDGE_PROFILE_ENV_KEYS,
  MCP_BRIDGE_ROUTE_ENV_KEYS,
  MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
  normalizeMcpBridgeParentProvider,
  normalizeMcpBridgeRoute,
  parseMcpBridgeRouteFromEnv
} from './McpBridgeRoute'

// Socket-path fixtures must be CANONICAL ON THE HOST, not POSIX literals.
// readSocketPath (McpBridgeRoute.ts:178) rejects any value where
// `resolve(value) !== value`, which is what makes a traversal or
// non-canonical form inert. On Windows `resolve('/private/a/...')` prefixes
// the current drive, so a POSIX literal fails its OWN guard and every route
// built from it comes back `ok: false` — six cases here plus the dev-bridge
// seam in devAppName.test.ts, none of them about routing.
// Deliberately NOT resolved elsewhere in this file: the `../Resources/app.asar`
// and `relative-app-path` fixtures must stay non-canonical, because rejecting
// exactly those forms is what the guard is for.
const DEV_APP_ASAR_PATH = resolve('/Applications/TaskWraith Dev.app/Contents/Resources/app.asar')
const socketA = resolve('/private/a/taskwraith-gemini-mcp.sock')
const socketB = resolve('/private/b/taskwraith-gemini-mcp.sock')
const socketPrimary = resolve('/private/primary/taskwraith-gemini-mcp.sock')
const tokenA = 'a'.repeat(64)
const tokenB = 'b'.repeat(64)
const instanceEpochA = 'c'.repeat(32)
const instanceEpochB = 'd'.repeat(32)

function buildLiveEnvironment(input: {
  socketPath: string
  brokerToken: string
  instanceEpoch: string
  bridgeLogEpoch: number
  parentProvider?: string
}) {
  return buildMcpBridgeRouteEnv({
    parentProvider: input.parentProvider || 'cursor',
    route: { appRunId: 'run-123', appChatId: 'chat-456' },
    workspacePath: '/repo with spaces',
    endpoint: {
      socketPath: input.socketPath,
      brokerToken: input.brokerToken,
      instanceEpoch: input.instanceEpoch,
      bridgeLogEpoch: input.bridgeLogEpoch
    },
    profile: {
      safeSubset: true,
      gatewaySubset: true,
      sketchDirect: true,
      orchestrationDirect: true
    }
  })
}

describe('MCP bridge route-from-env authority', () => {
  it('keeps persisted registration argv byte-identical while A and B resolve separate live endpoints', () => {
    const builtA = buildLiveEnvironment({
      socketPath: socketA,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 7
    })
    const builtB = buildLiveEnvironment({
      socketPath: socketB,
      brokerToken: tokenB,
      instanceEpoch: instanceEpochB,
      bridgeLogEpoch: 11
    })

    expect(builtA.ok).toBe(true)
    expect(builtB.ok).toBe(true)
    if (!builtA.ok || !builtB.ok) throw new Error('Expected valid live endpoint environments.')

    const parsedA = parseMcpBridgeRouteFromEnv({
      ...builtA.env,
      TASKWRAITH_INSTANCE_ID: 'must-not-be-read'
    })
    const parsedB = parseMcpBridgeRouteFromEnv(builtB.env)
    expect(parsedA).toMatchObject({ ok: true })
    expect(parsedB).toMatchObject({ ok: true })
    if (!parsedA.ok || !parsedB.ok) throw new Error('Expected parsed endpoint authority.')

    expect(parsedA.value.endpoint).toEqual({
      socketPath: socketA,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 7
    })
    expect(parsedB.value.endpoint).toEqual({
      socketPath: socketB,
      brokerToken: tokenB,
      instanceEpoch: instanceEpochB,
      bridgeLogEpoch: 11
    })
    expect(parsedA.value.profile).toMatchObject({ safeSubset: true, gatewaySubset: true })
    expect(parsedA.value.profile.planSubset).toBe(false)
    expect(parsedA.value.profile.sketchDirect).toBe(true)
    expect(parsedA.value.profile.orchestrationDirect).toBe(true)
    expect(builtA.env[MCP_BRIDGE_PROFILE_ENV_KEYS.sketchDirect]).toBe('1')
    expect(builtA.env[MCP_BRIDGE_PROFILE_ENV_KEYS.orchestrationDirect]).toBe('1')
    expect(parsedA.value).toMatchObject({
      route: { appRunId: 'run-123', appChatId: 'chat-456' },
      parentProvider: 'cursor',
      workspacePath: '/repo with spaces'
    })

    const persistedA = buildStaticMcpBridgeRegistrationArgv()
    const persistedB = buildStaticMcpBridgeRegistrationArgv()
    expect(persistedA).toEqual(persistedB)
    expect(persistedA).toEqual(['--taskwraith-gemini-mcp-bridge', MCP_BRIDGE_ROUTE_FROM_ENV_ARG])
    expect(persistedA.join(' ')).not.toMatch(/socket|token|epoch|subset|profile/i)
  })

  it('requires every endpoint field and returns no secret-bearing error detail', () => {
    const built = buildLiveEnvironment({
      socketPath: socketA,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 7
    })
    if (!built.ok) throw new Error('Expected valid endpoint environment.')

    const missingToken = { ...built.env }
    delete missingToken[MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]
    const missing = parseMcpBridgeRouteFromEnv(missingToken)
    const malformed = parseMcpBridgeRouteFromEnv({
      ...built.env,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: 'relative.sock',
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]: 'not-a-valid-token',
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]: 'not-an-opaque-epoch',
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.bridgeLogEpoch]: '07'
    })

    expect(missing).toEqual({ ok: false, reason: 'missing-endpoint-authority' })
    expect(malformed).toEqual({ ok: false, reason: 'invalid-endpoint-authority' })
    expect(JSON.stringify(missing)).not.toContain(tokenA)
    expect(JSON.stringify(malformed)).not.toContain(tokenA)
  })

  it('carries a packaged isolated profile id only in live endpoint env and keeps primary explicit', () => {
    const isolatedInstanceId = 'e'.repeat(32)
    const isolatedSocketPath = resolve(
      `/private/TaskWraith Instances/${isolatedInstanceId}/taskwraith-gemini-mcp.sock`
    )
    const isolated = buildMcpBridgeRouteEnv({
      parentProvider: 'cursor',
      route: { appRunId: 'run-isolated', appChatId: 'chat-isolated' },
      workspacePath: `/private/TaskWraith Instances/${isolatedInstanceId}`,
      endpoint: {
        socketPath: isolatedSocketPath,
        brokerToken: tokenA,
        instanceEpoch: instanceEpochA,
        bridgeLogEpoch: 3,
        isolatedInstanceId
      },
      profile: {}
    })
    expect(isolated.ok).toBe(true)
    if (!isolated.ok) throw new Error('Expected valid isolated bridge environment.')
    expect(isolated.env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]).toBe(isolatedInstanceId)
    expect(parseMcpBridgeRouteFromEnv(isolated.env)).toMatchObject({
      ok: true,
      value: { endpoint: { isolatedInstanceId } }
    })

    const primary = buildLiveEnvironment({
      socketPath: socketPrimary,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 4
    })
    expect(primary.ok).toBe(true)
    if (!primary.ok) throw new Error('Expected valid primary bridge environment.')
    expect(primary.env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]).toBe('')

    const malformed = {
      ...isolated.env,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: 'not-a-packaged-instance'
    }
    expect(parseMcpBridgeRouteFromEnv(malformed)).toEqual({
      ok: false,
      reason: 'invalid-endpoint-authority'
    })

    const mismatched = {
      ...isolated.env,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: 'f'.repeat(32)
    }
    const emptySelector = {
      ...isolated.env,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: ''
    }
    expect(parseMcpBridgeRouteFromEnv(mismatched)).toEqual({
      ok: false,
      reason: 'invalid-endpoint-authority'
    })
    expect(parseMcpBridgeRouteFromEnv(emptySelector)).toEqual({
      ok: false,
      reason: 'invalid-endpoint-authority'
    })

    expect(
      buildMcpBridgeRouteEnv({
        endpoint: {
          socketPath: socketPrimary,
          brokerToken: tokenA,
          instanceEpoch: instanceEpochA,
          bridgeLogEpoch: 4,
          isolatedInstanceId
        },
        profile: {}
      })
    ).toEqual({ ok: false, reason: 'invalid-endpoint-authority' })
  })

  it('requires an explicit complete profile environment and never inherits a stale widening flag', () => {
    const built = buildLiveEnvironment({
      socketPath: socketA,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 7
    })
    if (!built.ok) throw new Error('Expected valid endpoint environment.')

    const missingProfile = { ...built.env }
    delete missingProfile[MCP_BRIDGE_PROFILE_ENV_KEYS.gatewaySubset]
    const missingSketchProfile = { ...built.env }
    delete missingSketchProfile[MCP_BRIDGE_PROFILE_ENV_KEYS.sketchDirect]
    const missingOrchestrationProfile = { ...built.env }
    delete missingOrchestrationProfile[MCP_BRIDGE_PROFILE_ENV_KEYS.orchestrationDirect]
    const malformedProfile = {
      ...built.env,
      [MCP_BRIDGE_PROFILE_ENV_KEYS.safeSubset]: 'yes'
    }

    expect(parseMcpBridgeRouteFromEnv(missingProfile)).toEqual({
      ok: false,
      reason: 'invalid-profile-environment'
    })
    expect(parseMcpBridgeRouteFromEnv(missingSketchProfile)).toEqual({
      ok: false,
      reason: 'invalid-profile-environment'
    })
    expect(parseMcpBridgeRouteFromEnv(missingOrchestrationProfile)).toEqual({
      ok: false,
      reason: 'invalid-profile-environment'
    })
    expect(parseMcpBridgeRouteFromEnv(malformedProfile)).toEqual({
      ok: false,
      reason: 'invalid-profile-environment'
    })
  })

  it('makes the static mode exact and makes builder failures fail closed', () => {
    expect(hasMcpBridgeRouteFromEnvArg([MCP_BRIDGE_ROUTE_FROM_ENV_ARG])).toBe(true)
    expect(hasMcpBridgeRouteFromEnvArg([])).toBe(false)
    expect(
      hasMcpBridgeRouteFromEnvArg([MCP_BRIDGE_ROUTE_FROM_ENV_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG])
    ).toBe(false)
    expect(isStaticMcpBridgeRegistrationArgv(buildStaticMcpBridgeRegistrationArgv())).toBe(true)
    expect(
      isStaticMcpBridgeRegistrationArgv([
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
        '--taskwraith-gemini-mcp-bridge'
      ])
    ).toBe(false)
    expect(
      isDevStaticMcpBridgeProcessArgv([
        '/Applications/Electron.app/Contents/MacOS/Electron',
        DEV_APP_ASAR_PATH,
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ])
    ).toBe(true)
    expect(
      isDevStaticMcpBridgeProcessArgv([
        '/Applications/Electron.app/Contents/MacOS/Electron',
        // Resolved on purpose: this case must fail for the EXTRA ARGUMENT, not
        // because an unresolvable fixture already failed the canonicality guard.
        DEV_APP_ASAR_PATH,
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
        '--extra'
      ])
    ).toBe(false)
    expect(
      isDevStaticMcpBridgeProcessArgv([
        '/Applications/Electron.app/Contents/MacOS/Electron',
        '/Applications/TaskWraith Dev.app/Contents/Resources/../Resources/app.asar',
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ])
    ).toBe(false)
    expect(
      isDevStaticMcpBridgeProcessArgv([
        '/Applications/Electron.app/Contents/MacOS/Electron',
        'relative-app-path',
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ])
    ).toBe(false)
    expect(
      isStaticMcpBridgeRegistrationArgv([
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
        '--socket'
      ])
    ).toBe(false)
    expect(
      isStaticMcpBridgeRegistrationArgv([
        '--taskwraith-gemini-mcp-bridge',
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
        MCP_BRIDGE_ROUTE_FROM_ENV_ARG
      ])
    ).toBe(false)
    expect(buildMcpBridgeRouteEnv({})).toEqual({
      ok: false,
      reason: 'missing-endpoint-authority'
    })
  })

  it('keeps only valid provider stamps and bounded opaque route identifiers', () => {
    expect(normalizeMcpBridgeParentProvider('pi')).toBe('pi')
    expect(normalizeMcpBridgeParentProvider('ollama')).toBe('ollama')
    expect(
      normalizeMcpBridgeRoute({
        appRunId: 'r'.repeat(513),
        appChatId: 'chat-456'
      })
    ).toEqual({ appChatId: 'chat-456' })

    const built = buildLiveEnvironment({
      socketPath: socketA,
      brokerToken: tokenA,
      instanceEpoch: instanceEpochA,
      bridgeLogEpoch: 7,
      parentProvider: 'not-a-provider'
    })
    if (!built.ok) throw new Error('Expected valid endpoint environment.')
    expect(built.env[MCP_BRIDGE_ROUTE_ENV_KEYS.parentProvider]).toBe('gemini')
    expect(built.env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]).toBe(tokenA)
  })
})
