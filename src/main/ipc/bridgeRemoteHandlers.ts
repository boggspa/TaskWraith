import { ipcMain } from 'electron'
import { resolveDaemonShouldRun } from '../BridgeDaemonSettings'
import type { TailscaleAuthResult } from '../TailscaleAuth'
import type { TailscaleStatus } from '../TailscaleDetector'
import type { TailscaleServeResult, TailscaleServeStatus } from '../TailscaleServe'
import type { RelayProbeResult } from '../remote/relayReachability'

interface BridgeRemoteSettings {
  iosRemoteEnabled?: boolean
  iosRemoteRelayUrl?: string
  iosRemoteManualRelayUrl?: string
}

interface TailscaleWssCandidate {
  dnsName: string
  wssUrl: string
}

interface SelfHostedWssLane {
  wssUrl: string
  relayPort: number
}

interface IosRemoteConfigInput {
  enabled?: boolean
  relayUrl?: string
  manualRelayUrl?: string
  openAtLogin?: boolean
}

export interface IosRemoteTailscaleStatusDeps {
  getSettings: () => BridgeRemoteSettings
  getLiveIosRemoteRelayPort: () => number
  getIosRemoteServeHttpsPort: () => number
  getConfiguredManualRelayInput: () => string
  getConfiguredManualRelayUrl: (relayPort: number) => string | null
  getConfiguredTailscaleWssCandidate: (
    relayPort: number,
    httpsPort: number
  ) => TailscaleWssCandidate | null
  serveWssUrl: (dnsName: string, httpsPort: number) => string
  detectTailscale: () => Promise<TailscaleStatus>
  getTailscaleServeStatus: (input: {
    cliPath: string
    relayPort: number
    httpsPort?: number
  }) => Promise<TailscaleServeStatus>
  getIosRemoteRuntimeActive: () => boolean
}

export interface BridgeRemoteHandlersDeps extends IosRemoteTailscaleStatusDeps {
  updateSettings: (partial: Partial<BridgeRemoteSettings>) => void
  getIosRemoteEnvValue: () => string | undefined
  getIosRemoteRuntimeError: () => string | null
  getOpenAtLogin: () => boolean
  setOpenAtLogin: (openAtLogin: boolean) => void
  getIosRemoteRelayPort: () => number
  getSelfHostedWssLane: () => SelfHostedWssLane | null
  hasEmbeddedRelayHandle: () => boolean
  getIosRemoteTailscaleStatus: () => Promise<Record<string, unknown>>
  restartIosRemoteBridge: (reason: string) => Promise<void>
  stopIosRemoteBridge: () => Promise<void>
  probeRelayFrontDoor: (relayUrl: string) => Promise<RelayProbeResult>
  enableTailscaleServe: (input: {
    cliPath: string
    relayPort: number
    httpsPort?: number
  }) => Promise<TailscaleServeResult>
  disableTailscaleServe: (input: {
    cliPath: string
    httpsPort?: number
  }) => Promise<TailscaleServeResult>
  tailscaleUpWithAuthKey: (input: {
    cliPath: string
    authKey: string
  }) => Promise<TailscaleAuthResult>
  setTailscaleOAuthCredentials: (input: {
    clientId: string
    clientSecret: string
  }) => { ok: true } | { ok: false; error: string }
  clearTailscaleOAuthCredentials: () => void
  tailscaleOAuthStatus: () => {
    configured: boolean
    clientId: string | null
    encryptionAvailable: boolean
  }
}

function configSnapshot(deps: BridgeRemoteHandlersDeps, settings = deps.getSettings()) {
  const resolution = resolveDaemonShouldRun(
    settings.iosRemoteEnabled === true,
    deps.getIosRemoteEnvValue()
  )
  return {
    enabled: settings.iosRemoteEnabled === true,
    relayUrl: settings.iosRemoteRelayUrl || '',
    manualRelayUrl: settings.iosRemoteManualRelayUrl || '',
    effectiveEnabled: resolution.shouldRun,
    envOverride: resolution.envOverride,
    runtimeActive: deps.getIosRemoteRuntimeActive(),
    runtimeError: deps.getIosRemoteRuntimeError(),
    openAtLogin: deps.getOpenAtLogin()
  }
}

export function createIosRemoteTailscaleStatusGetter(
  deps: IosRemoteTailscaleStatusDeps
): () => Promise<Record<string, unknown>> {
  return async () => {
    const tailscale = await deps.detectTailscale()
    const relayPort = deps.getLiveIosRemoteRelayPort()
    const httpsPort = deps.getIosRemoteServeHttpsPort()
    const currentRelayUrl = (deps.getSettings().iosRemoteRelayUrl || '').trim()
    const manualRelayInput = deps.getConfiguredManualRelayInput()
    const manualRelayUrl = deps.getConfiguredManualRelayUrl(relayPort)
    const configuredCandidate = deps.getConfiguredTailscaleWssCandidate(relayPort, httpsPort)
    const serve = tailscale.cliPath
      ? await deps.getTailscaleServeStatus({ cliPath: tailscale.cliPath, relayPort, httpsPort })
      : { configured: false as const }
    const dnsName = tailscale.dnsName ?? serve.dnsName ?? configuredCandidate?.dnsName
    const suggestedUrl = dnsName ? deps.serveWssUrl(dnsName, httpsPort) : null
    const relayUrlMatches = Boolean(suggestedUrl && currentRelayUrl === suggestedUrl)
    const usingSavedRelayFallback = Boolean(
      configuredCandidate && !tailscale.available && !(serve.configured && dnsName)
    )
    return {
      tailscaleAvailable:
        tailscale.available || Boolean(serve.configured && dnsName) || usingSavedRelayFallback,
      tailscaleReason:
        tailscale.available || (serve.configured && dnsName)
          ? null
          : usingSavedRelayFallback
            ? `${tailscale.reason ?? 'Tailscale status is not ready.'} Using the saved relay door for Copy/Test.`
            : (tailscale.reason ?? null),
      dnsName: dnsName ?? null,
      suggestedUrl,
      relayPort,
      serveConfigured: serve.configured,
      serveHttpsPort: serve.httpsPort ?? null,
      serveError: serve.error ?? null,
      relayUrlMatches,
      manualRelayInput,
      manualRelayUrl,
      active: relayUrlMatches && serve.configured,
      runtimeActive: deps.getIosRemoteRuntimeActive(),
      usingSavedRelayFallback
    }
  }
}

export function registerBridgeRemoteHandlers(deps: BridgeRemoteHandlersDeps): void {
  ipcMain.handle('get-ios-remote-config', () => configSnapshot(deps))

  ipcMain.handle('ios-remote-tailscale-status', () => deps.getIosRemoteTailscaleStatus())

  ipcMain.handle('ios-remote-tailscale-enable', async () => {
    const tailscale = await deps.detectTailscale()
    const relayPort = deps.getLiveIosRemoteRelayPort()
    const httpsPort = deps.getIosRemoteServeHttpsPort()
    const configuredCandidate = deps.getConfiguredTailscaleWssCandidate(relayPort, httpsPort)
    if (!tailscale.cliPath) {
      return {
        ok: false,
        message:
          tailscale.reason ||
          'Tailscale is not available — install it and sign in to your tailnet first.'
      }
    }
    if (!tailscale.available && !configuredCandidate) {
      return {
        ok: false,
        message:
          tailscale.reason ||
          'Tailscale is installed but not connected. Sign in to Tailscale and try again.',
        status: await deps.getIosRemoteTailscaleStatus()
      }
    }
    const dnsName = tailscale.dnsName ?? configuredCandidate?.dnsName
    if (!dnsName) {
      return {
        ok: false,
        message:
          'Tailscale is connected, but TaskWraith could not determine this Mac’s MagicDNS name.'
      }
    }
    const relayUrl = deps.serveWssUrl(dnsName, httpsPort)
    deps.updateSettings({
      iosRemoteEnabled: true,
      iosRemoteRelayUrl: relayUrl
    })
    await deps.restartIosRemoteBridge('tailscale enable')

    const lane = deps.getSelfHostedWssLane()
    if (!lane || lane.wssUrl !== relayUrl || !deps.hasEmbeddedRelayHandle()) {
      return {
        ok: false,
        message:
          deps.getIosRemoteRuntimeError() ||
          'TaskWraith could not start its local iOS remote relay. Toggle iOS remote bridge off/on and try again.',
        status: await deps.getIosRemoteTailscaleStatus(),
        relayUrl,
        reachable: false
      }
    }

    const loopback = await deps.probeRelayFrontDoor(`ws://127.0.0.1:${lane.relayPort}`)
    if (!loopback.reachable) {
      await deps.disableTailscaleServe({
        cliPath: tailscale.cliPath,
        httpsPort
      })
      return {
        ok: false,
        message: `TaskWraith's local relay is not answering on ${lane.relayPort}: ${loopback.detail}`,
        status: await deps.getIosRemoteTailscaleStatus(),
        relayUrl,
        reachable: false
      }
    }

    const serve = await deps.getTailscaleServeStatus({
      cliPath: tailscale.cliPath,
      relayPort: lane.relayPort,
      httpsPort
    })
    let enableMessage: string | undefined
    if (!serve.configured) {
      const result = await deps.enableTailscaleServe({
        cliPath: tailscale.cliPath,
        relayPort: lane.relayPort,
        httpsPort
      })
      if (!result.ok) {
        return { ok: false, message: result.message || '`tailscale serve` failed.' }
      }
      enableMessage = result.message
    }
    const probe = await deps.probeRelayFrontDoor(relayUrl)
    const status = await deps.getIosRemoteTailscaleStatus()
    if (!probe.reachable) {
      return {
        ok: false,
        message: `Set the detected relay door (${relayUrl}), but it is not reachable yet: ${probe.detail}`,
        status,
        relayUrl,
        reachable: false
      }
    }
    return {
      ok: true,
      message: enableMessage ?? 'Ready for cellular.',
      status,
      relayUrl,
      reachable: true
    }
  })

  ipcMain.handle('ios-remote-tailscale-test', async () => {
    const status = await deps.getIosRemoteTailscaleStatus()
    const relayUrl =
      typeof status.suggestedUrl === 'string' && status.suggestedUrl ? status.suggestedUrl : null
    if (!relayUrl) {
      return {
        ok: false,
        message:
          status.tailscaleReason ||
          'TaskWraith could not detect this Mac’s Tailscale MagicDNS relay door.',
        status
      }
    }
    const probe = await deps.probeRelayFrontDoor(relayUrl)
    return {
      ok: probe.reachable,
      message: probe.reachable
        ? `Ready for cellular: ${relayUrl}`
        : `${relayUrl} is not reachable yet: ${probe.detail}`,
      relayUrl,
      reachable: probe.reachable,
      status
    }
  })

  ipcMain.handle('ios-remote-tailscale-disable', async () => {
    const tailscale = await deps.detectTailscale()
    if (tailscale.cliPath) {
      const serve = await deps.getTailscaleServeStatus({
        cliPath: tailscale.cliPath,
        relayPort: deps.getIosRemoteRelayPort(),
        httpsPort: deps.getIosRemoteServeHttpsPort()
      })
      if (serve.configured) {
        const result = await deps.disableTailscaleServe({
          cliPath: tailscale.cliPath,
          httpsPort: serve.httpsPort ?? deps.getIosRemoteServeHttpsPort()
        })
        if (!result.ok) {
          return { ok: false, message: result.message || '`tailscale serve off` failed.' }
        }
      }
    }
    const current = (deps.getSettings().iosRemoteRelayUrl || '').trim()
    if (
      tailscale.dnsName &&
      current === deps.serveWssUrl(tailscale.dnsName, deps.getIosRemoteServeHttpsPort())
    ) {
      deps.updateSettings({ iosRemoteRelayUrl: '' })
    }
    return { ok: true, status: await deps.getIosRemoteTailscaleStatus() }
  })

  ipcMain.handle('ios-remote-tailscale-link', async (_event, authKey: string) => {
    const tailscale = await deps.detectTailscale()
    if (!tailscale.cliPath) {
      return {
        ok: false,
        message:
          tailscale.reason ||
          'Tailscale is not installed — install it first, then paste your auth key.'
      }
    }
    if (tailscale.available) {
      return {
        ok: true,
        message: tailscale.tailnetName
          ? `This Mac is already connected to tailnet "${tailscale.tailnetName}" — no linking needed.`
          : 'This Mac is already connected to Tailscale — no linking needed.',
        status: await deps.getIosRemoteTailscaleStatus()
      }
    }
    const result = await deps.tailscaleUpWithAuthKey({ cliPath: tailscale.cliPath, authKey })
    return {
      ok: result.ok,
      message: result.message ?? null,
      status: await deps.getIosRemoteTailscaleStatus()
    }
  })

  ipcMain.handle(
    'ios-remote-tailscale-oauth-set',
    async (_event, input: { clientId?: string; clientSecret?: string }) =>
      deps.setTailscaleOAuthCredentials({
        clientId: input?.clientId ?? '',
        clientSecret: input?.clientSecret ?? ''
      })
  )
  ipcMain.handle('ios-remote-tailscale-oauth-clear', async () => {
    deps.clearTailscaleOAuthCredentials()
    return { ok: true }
  })
  ipcMain.handle('ios-remote-tailscale-oauth-status', () => deps.tailscaleOAuthStatus())

  ipcMain.handle('set-ios-remote-config', async (_, config: IosRemoteConfigInput) => {
    if (typeof config?.openAtLogin === 'boolean') {
      deps.setOpenAtLogin(config.openAtLogin)
    }
    deps.updateSettings({
      ...(typeof config?.enabled === 'boolean' ? { iosRemoteEnabled: config.enabled } : {}),
      ...(typeof config?.relayUrl === 'string' ? { iosRemoteRelayUrl: config.relayUrl.trim() } : {}),
      ...(typeof config?.manualRelayUrl === 'string'
        ? { iosRemoteManualRelayUrl: config.manualRelayUrl.trim() }
        : {})
    })
    const next = deps.getSettings()
    const resolution = resolveDaemonShouldRun(
      next.iosRemoteEnabled === true,
      deps.getIosRemoteEnvValue()
    )
    if (resolution.shouldRun) {
      await deps.restartIosRemoteBridge('settings change')
    } else {
      await deps.stopIosRemoteBridge()
    }
    return configSnapshot(deps, next)
  })
}
