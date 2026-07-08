import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  createIosRemoteTailscaleStatusGetter,
  registerBridgeRemoteHandlers,
  type BridgeRemoteHandlersDeps
} from './bridgeRemoteHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps(overrides: Partial<BridgeRemoteHandlersDeps> = {}) {
  const settings = {
    iosRemoteEnabled: true,
    iosRemoteRelayUrl: 'wss://mac.tail.ts.net:8443',
    iosRemoteManualRelayUrl: 'manual.tail.ts.net'
  }
  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((partial) => Object.assign(settings, partial)),
    getIosRemoteEnvValue: vi.fn(() => undefined),
    getIosRemoteRuntimeActive: vi.fn(() => true),
    getIosRemoteRuntimeError: vi.fn(() => null),
    getOpenAtLogin: vi.fn(() => true),
    setOpenAtLogin: vi.fn(),
    getIosRemoteRelayPort: vi.fn(() => 8787),
    getLiveIosRemoteRelayPort: vi.fn(() => 8788),
    getIosRemoteServeHttpsPort: vi.fn(() => 8443),
    getConfiguredManualRelayInput: vi.fn(() => settings.iosRemoteManualRelayUrl),
    getConfiguredManualRelayUrl: vi.fn(() => 'wss://manual.tail.ts.net:8443'),
    getConfiguredTailscaleWssCandidate: vi.fn(() => ({
      dnsName: 'mac.tail.ts.net',
      wssUrl: 'wss://mac.tail.ts.net:8443'
    })),
    serveWssUrl: vi.fn((dnsName: string, httpsPort: number) =>
      httpsPort === 443 ? `wss://${dnsName}` : `wss://${dnsName}:${httpsPort}`
    ),
    detectTailscale: vi.fn(async () => ({
      available: true,
      cliPath: '/usr/bin/tailscale',
      dnsName: 'mac.tail.ts.net'
    })),
    getTailscaleServeStatus: vi.fn(async () => ({
      configured: true,
      httpsPort: 8443,
      dnsName: 'mac.tail.ts.net'
    })),
    enableTailscaleServe: vi.fn(async () => ({ ok: true, message: 'enabled' })),
    disableTailscaleServe: vi.fn(async () => ({ ok: true, message: 'disabled' })),
    tailscaleUpWithAuthKey: vi.fn(async () => ({ ok: true, message: 'linked' })),
    probeRelayFrontDoor: vi.fn(async () => ({ reachable: true, detail: 'HTTP 200' })),
    getSelfHostedWssLane: vi.fn(() => ({
      wssUrl: 'wss://mac.tail.ts.net:8443',
      relayPort: 8788
    })),
    hasEmbeddedRelayHandle: vi.fn(() => true),
    getIosRemoteTailscaleStatus: vi.fn(async () => ({
      suggestedUrl: 'wss://mac.tail.ts.net:8443',
      tailscaleReason: null
    })),
    restartIosRemoteBridge: vi.fn(async () => undefined),
    stopIosRemoteBridge: vi.fn(async () => undefined),
    setTailscaleOAuthCredentials: vi.fn(() => ({ ok: true as const })),
    clearTailscaleOAuthCredentials: vi.fn(),
    tailscaleOAuthStatus: vi.fn(() => ({
      configured: true,
      clientId: 'client-1',
      encryptionAvailable: true
    })),
    ...overrides
  } as BridgeRemoteHandlersDeps

  return { deps, settings }
}

describe('createIosRemoteTailscaleStatusGetter', () => {
  it('reports a saved Tailscale relay door as a copy/test fallback', async () => {
    const { deps } = createDeps({
      detectTailscale: vi.fn(async () => ({
        available: false,
        reason: 'Tailscale is not connected'
      })),
      getTailscaleServeStatus: vi.fn(async () => ({ configured: false }))
    })
    const getStatus = createIosRemoteTailscaleStatusGetter(deps)

    await expect(getStatus()).resolves.toMatchObject({
      tailscaleAvailable: true,
      tailscaleReason:
        'Tailscale is not connected Using the saved relay door for Copy/Test.',
      dnsName: 'mac.tail.ts.net',
      suggestedUrl: 'wss://mac.tail.ts.net:8443',
      serveConfigured: false,
      manualRelayInput: 'manual.tail.ts.net',
      manualRelayUrl: 'wss://manual.tail.ts.net:8443',
      runtimeActive: true,
      usingSavedRelayFallback: true
    })
  })
})

describe('registerBridgeRemoteHandlers', () => {
  it('registers the iOS remote config and Tailscale IPC surface', () => {
    registerBridgeRemoteHandlers(createDeps().deps)

    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'get-ios-remote-config',
      'ios-remote-tailscale-status',
      'ios-remote-tailscale-enable',
      'ios-remote-tailscale-test',
      'ios-remote-tailscale-disable',
      'ios-remote-tailscale-link',
      'ios-remote-tailscale-oauth-set',
      'ios-remote-tailscale-oauth-clear',
      'ios-remote-tailscale-oauth-status',
      'set-ios-remote-config'
    ])
  })

  it('reads and writes remote bridge config through injected app settings', async () => {
    const { deps } = createDeps()
    registerBridgeRemoteHandlers(deps)

    expect(handlerFor('get-ios-remote-config')({})).toMatchObject({
      enabled: true,
      relayUrl: 'wss://mac.tail.ts.net:8443',
      manualRelayUrl: 'manual.tail.ts.net',
      effectiveEnabled: true,
      envOverride: null,
      runtimeActive: true,
      runtimeError: null,
      openAtLogin: true
    })

    await expect(
      handlerFor('set-ios-remote-config')({}, {
        enabled: false,
        relayUrl: ' ws://relay.local:8787 ',
        manualRelayUrl: ' manual.local ',
        openAtLogin: false
      })
    ).resolves.toMatchObject({
      enabled: false,
      relayUrl: 'ws://relay.local:8787',
      manualRelayUrl: 'manual.local',
      effectiveEnabled: false
    })
    expect(deps.setOpenAtLogin).toHaveBeenCalledWith(false)
    expect(deps.updateSettings).toHaveBeenCalledWith({
      iosRemoteEnabled: false,
      iosRemoteRelayUrl: 'ws://relay.local:8787',
      iosRemoteManualRelayUrl: 'manual.local'
    })
    expect(deps.stopIosRemoteBridge).toHaveBeenCalledOnce()
    expect(deps.restartIosRemoteBridge).not.toHaveBeenCalled()
  })

  it('enables the Tailscale front door after restarting the local relay', async () => {
    const { deps } = createDeps({
      getTailscaleServeStatus: vi.fn(async () => ({ configured: false }))
    })
    registerBridgeRemoteHandlers(deps)

    await expect(handlerFor('ios-remote-tailscale-enable')({})).resolves.toMatchObject({
      ok: true,
      message: 'enabled',
      relayUrl: 'wss://mac.tail.ts.net:8443',
      reachable: true
    })
    expect(deps.updateSettings).toHaveBeenCalledWith({
      iosRemoteEnabled: true,
      iosRemoteRelayUrl: 'wss://mac.tail.ts.net:8443'
    })
    expect(deps.restartIosRemoteBridge).toHaveBeenCalledWith('tailscale enable')
    expect(deps.probeRelayFrontDoor).toHaveBeenCalledWith('ws://127.0.0.1:8788')
    expect(deps.enableTailscaleServe).toHaveBeenCalledWith({
      cliPath: '/usr/bin/tailscale',
      relayPort: 8788,
      httpsPort: 8443
    })
    expect(deps.probeRelayFrontDoor).toHaveBeenCalledWith('wss://mac.tail.ts.net:8443')
  })

  it('tests the suggested relay door reachability', async () => {
    const { deps } = createDeps()
    registerBridgeRemoteHandlers(deps)

    await expect(handlerFor('ios-remote-tailscale-test')({})).resolves.toMatchObject({
      ok: true,
      message: 'Ready for cellular: wss://mac.tail.ts.net:8443',
      relayUrl: 'wss://mac.tail.ts.net:8443',
      reachable: true
    })
    expect(deps.getIosRemoteTailscaleStatus).toHaveBeenCalledOnce()
    expect(deps.probeRelayFrontDoor).toHaveBeenCalledWith('wss://mac.tail.ts.net:8443')
  })

  it('disables the Tailscale front door and clears the matching saved relay URL', async () => {
    const { deps } = createDeps()
    registerBridgeRemoteHandlers(deps)

    await expect(handlerFor('ios-remote-tailscale-disable')({})).resolves.toMatchObject({
      ok: true
    })
    expect(deps.disableTailscaleServe).toHaveBeenCalledWith({
      cliPath: '/usr/bin/tailscale',
      httpsPort: 8443
    })
    expect(deps.updateSettings).toHaveBeenCalledWith({ iosRemoteRelayUrl: '' })
  })

  it('links Tailscale with an auth key when the node is not already connected', async () => {
    const { deps } = createDeps({
      detectTailscale: vi.fn(async () => ({
        available: false,
        cliPath: '/usr/bin/tailscale',
        reason: 'not connected'
      }))
    })
    registerBridgeRemoteHandlers(deps)

    await expect(handlerFor('ios-remote-tailscale-link')({}, 'tskey-auth-123')).resolves.toEqual({
      ok: true,
      message: 'linked',
      status: {
        suggestedUrl: 'wss://mac.tail.ts.net:8443',
        tailscaleReason: null
      }
    })
    expect(deps.tailscaleUpWithAuthKey).toHaveBeenCalledWith({
      cliPath: '/usr/bin/tailscale',
      authKey: 'tskey-auth-123'
    })
  })

  it('delegates host-side Tailscale OAuth custody handlers', async () => {
    const { deps } = createDeps()
    registerBridgeRemoteHandlers(deps)

    await expect(
      handlerFor('ios-remote-tailscale-oauth-set')({}, {
        clientId: 'client-1',
        clientSecret: 'secret-1'
      })
    ).resolves.toEqual({ ok: true })
    expect(deps.setTailscaleOAuthCredentials).toHaveBeenCalledWith({
      clientId: 'client-1',
      clientSecret: 'secret-1'
    })

    await expect(handlerFor('ios-remote-tailscale-oauth-clear')({})).resolves.toEqual({ ok: true })
    expect(deps.clearTailscaleOAuthCredentials).toHaveBeenCalledOnce()
    expect(handlerFor('ios-remote-tailscale-oauth-status')({})).toEqual({
      configured: true,
      clientId: 'client-1',
      encryptionAvailable: true
    })
  })
})
