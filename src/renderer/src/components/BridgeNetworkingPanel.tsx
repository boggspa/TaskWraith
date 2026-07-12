import React, { useCallback, useEffect, useState } from 'react'
import { PillButton } from './PillButton'

const TAILSCALE_MACHINES_URL = 'https://login.tailscale.com/admin/machines'
const TAILSCALE_DNS_URL = 'https://login.tailscale.com/admin/dns'
const TAILSCALE_MAGICDNS_HELP_URL = 'https://tailscale.com/kb/1081/magicdns'
const TAILSCALE_SERVE_HELP_URL = 'https://tailscale.com/kb/1312/serve'

/**
 * BridgeNetworkingPanel — Phase E3 Settings → "Bridge Networking" pane.
 *
 * Shows LAN + Tailscale status for the iPhone bridge so the user can
 * see at a glance:
 *   - Whether the bridge daemon is enabled (LAN visibility).
 *   - Whether Tailscale is installed/logged-in/connected.
 *   - The IP a paired iPhone uses to reach the desktop from off-LAN.
 *
 * The detection result is cached by main for ~5s so toggling the
 * panel doesn't hammer `tailscale status --json`.
 *
 * Scope note: this panel currently reports detection only. The
 * actual daemon-side bind-on-tailnet-IP is a separate Swift slice
 * (planned follow-up) — the iOS app would still need to learn the
 * tailnet IP via pairing handshake. For now the user surfaces the
 * IP here so they can verify off-LAN reachability manually.
 */

interface BridgeNetworkingStatus {
  lan: {
    enabled: boolean
    running: boolean
    settingEnabled: boolean
    effectiveEnabled: boolean
    envOverride: 'force-on' | 'force-off' | null
    status: 'running' | 'stopped'
    pid?: number | null
    startedAt?: string | null
    lastError?: string | null
    bonjourServiceType: string | null
    hostname: string
    localOnly?: boolean
    nativeCapabilities?: {
      bridge: { available: boolean; reason?: string }
    }
  }
  tailscale: {
    available: boolean
    cliPath?: string
    version?: string
    tailnetIPv4?: string
    tailnetIPv6?: string
    hostname?: string
    tailnetName?: string
    magicDNSEnabled?: boolean
    reason?: string
  }
}

export function BridgeNetworkingPanel({
  onRemoteBridgeChanged
}: {
  /** Bridge restarts invalidate the rendered pairing session, while a
   * successful relay test can make a previously omitted WSS door advertisable.
   * Let the owner mint a fresh bootstrap after either change. */
  onRemoteBridgeChanged?: () => void
} = {}): React.JSX.Element {
  const [status, setStatus] = useState<BridgeNetworkingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingDaemon, setSavingDaemon] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [iosRemoteRefreshSignal, setIosRemoteRefreshSignal] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = (await window.api.bridgeNetworkingStatus()) as BridgeNetworkingStatus
      setStatus(result)
      setIosRemoteRefreshSignal((value) => value + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => refresh())
  }, [refresh])

  const lan = status?.lan
  const nativeBridgeUnavailable = Boolean(
    lan?.nativeCapabilities && !lan.nativeCapabilities.bridge.available
  )
  const daemonSwitchDisabled =
    loading || savingDaemon || Boolean(lan?.envOverride) || nativeBridgeUnavailable
  const daemonSwitchChecked = lan?.envOverride
    ? lan.effectiveEnabled
    : (lan?.settingEnabled ?? true)
  const daemonHelper =
    lan?.envOverride === 'force-on'
      ? 'Enabled by TASKWRAITH_BRIDGE_DAEMON.'
      : lan?.envOverride === 'force-off'
        ? 'Disabled by environment override.'
        : nativeBridgeUnavailable
          ? lan?.nativeCapabilities?.bridge.reason || 'Native bridge unavailable on this host.'
          : 'Runs on launch and serves local macOS-native tools.'
  const daemonPillLabel = lan?.running
    ? 'Running'
    : lan?.effectiveEnabled && !lan?.lastError
      ? 'Starting'
      : 'Stopped'
  const daemonPillKind = lan?.running
    ? 'ok'
    : lan?.effectiveEnabled && !lan?.lastError
      ? 'warn'
      : 'idle'

  const setDaemonEnabled = async (enabled: boolean): Promise<void> => {
    try {
      setSavingDaemon(true)
      setError(null)
      const result = (await window.api.setBridgeDaemonEnabled(enabled)) as BridgeNetworkingStatus
      setStatus(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingDaemon(false)
    }
  }

  return (
    <div className="bridge-networking-panel">
      <div className="bridge-networking-header">
        <label className="settings-label">Bridge networking</label>
        <div className="settings-hint">
          Local native bridge status for Screen Watch, Appwatch, AppleEvents, editor handoff, and
          creative-app tools.
        </div>
      </div>

      {error && <div className="settings-error">{error}</div>}

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Bridge daemon</span>
          <StatusPill kind={daemonPillKind} label={daemonPillLabel} />
        </header>
        <label className="settings-service-row settings-fx-toggle">
          <span>
            Enable bridge daemon
            <small>{daemonHelper}</small>
          </span>
          <input
            type="checkbox"
            checked={daemonSwitchChecked}
            disabled={daemonSwitchDisabled}
            onChange={(event) => void setDaemonEnabled(event.target.checked)}
          />
        </label>
        {lan?.lastError && (
          <div className="settings-hint bridge-networking-reason">{lan.lastError}</div>
        )}
        <div className="settings-hint bridge-networking-reason">
          Human collaboration shares and projected sessions rely on this bridge path, so keep it
          running for reliable invite-based remote access outside your local network.
        </div>
      </section>

      <IosRemoteBridgeSection
        refreshSignal={iosRemoteRefreshSignal}
        onRemoteBridgeChanged={onRemoteBridgeChanged}
      />

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Local bridge</span>
          <StatusPill
            kind={lan?.running ? 'ok' : 'idle'}
            label={lan?.running ? 'Local only' : 'Stopped'}
          />
        </header>
        {lan && (
          <dl className="bridge-networking-fields">
            <Field label="Transport" value="Local stdio" />
            <Field label="Hostname" value={lan.hostname} />
            {lan.pid && <Field label="Daemon PID" value={String(lan.pid)} />}
            {lan.nativeCapabilities?.bridge.reason && (
              <Field label="Capability" value={lan.nativeCapabilities.bridge.reason} />
            )}
          </dl>
        )}
        {!lan?.running && (
          <div className="settings-hint">
            Native bridge tools stay disabled until the local daemon is running.
          </div>
        )}
      </section>

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Tailscale</span>
          <StatusPill
            kind={status?.tailscale.available ? 'ok' : status?.tailscale.cliPath ? 'warn' : 'idle'}
            label={
              status?.tailscale.available
                ? 'Connected'
                : status?.tailscale.cliPath
                  ? 'Installed, not ready'
                  : 'Not installed'
            }
          />
        </header>
        {status?.tailscale.available ? (
          <dl className="bridge-networking-fields">
            {status.tailscale.tailnetIPv4 && (
              <Field label="Tailnet IPv4" value={status.tailscale.tailnetIPv4} copyable />
            )}
            {status.tailscale.tailnetIPv6 && (
              <Field label="Tailnet IPv6" value={status.tailscale.tailnetIPv6} copyable />
            )}
            {status.tailscale.hostname && (
              <Field label="Tailscale hostname" value={status.tailscale.hostname} />
            )}
            {status.tailscale.tailnetName && (
              <Field label="Tailnet" value={status.tailscale.tailnetName} />
            )}
            {status.tailscale.magicDNSEnabled !== undefined && (
              <Field
                label="Magic DNS"
                value={status.tailscale.magicDNSEnabled ? 'enabled' : 'disabled'}
              />
            )}
            {status.tailscale.version && (
              <Field label="CLI version" value={status.tailscale.version} />
            )}
          </dl>
        ) : (
          <>
            {status?.tailscale.reason && (
              <div className="settings-hint bridge-networking-reason">
                {status.tailscale.reason}
              </div>
            )}
            {!status?.tailscale.cliPath && (
              <div className="settings-hint">
                <a
                  href="https://tailscale.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className="bridge-networking-install-link"
                >
                  Install Tailscale
                </a>{' '}
                to enable off-LAN bridge access. Tailscale gives this Mac a stable IP your iPhone
                can reach from any network.
              </div>
            )}
          </>
        )}
      </section>

      <div className="bridge-networking-actions">
        <PillButton
          size="compact"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </PillButton>
      </div>
    </div>
  )
}

interface IosRemoteConfig {
  enabled: boolean
  relayUrl: string
  manualRelayUrl: string
  effectiveEnabled: boolean
  envOverride: string | null
  runtimeActive: boolean
  /** Startup failure that held the bridge down (identity unreadable /
   * unprotectable) — rendered instead of a silent "Off" pill. */
  runtimeError?: string | null
  openAtLogin?: boolean
}

interface IosRemoteTailscaleStatus {
  tailscaleAvailable: boolean
  tailscaleReason: string | null
  dnsName: string | null
  suggestedUrl: string | null
  relayPort: number
  serveConfigured: boolean
  serveHttpsPort: number | null
  serveError: string | null
  relayUrlMatches: boolean
  manualRelayInput: string
  manualRelayUrl: string | null
  active: boolean
  directRelayUrl?: string | null
  directAvailable?: boolean
  cellularReady?: boolean
  runtimeActive: boolean
  usingSavedRelayFallback?: boolean
}

interface TailscaleOAuthStatus {
  configured: boolean
  clientId: string | null
  encryptionAvailable: boolean
}

/** iOS remote bridge (relay + E2EE) — settings-first gating so login-item
 * launches keep the bridge alive without shell env. Main applies settings
 * changes immediately by restarting the bridge runtime. */
function IosRemoteBridgeSection({
  refreshSignal,
  onRemoteBridgeChanged
}: {
  refreshSignal: number
  onRemoteBridgeChanged?: () => void
}): React.JSX.Element {
  const [config, setConfig] = useState<IosRemoteConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [sectionError, setSectionError] = useState<string | null>(null)
  const [tailscale, setTailscale] = useState<IosRemoteTailscaleStatus | null>(null)
  const [tailscaleBusy, setTailscaleBusy] = useState(false)
  const [tailscaleTestBusy, setTailscaleTestBusy] = useState(false)
  const [tailscaleMessage, setTailscaleMessage] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  const [tailscaleCopied, setTailscaleCopied] = useState(false)
  // QR-optional discovery: host-side Tailscale OAuth credential so a paired
  // phone can ask this host to enumerate the tailnet. The secret is write-only
  // (encrypted at rest, never read back) — status reports only whether it's set.
  const [oauthStatus, setOauthStatus] = useState<TailscaleOAuthStatus | null>(null)
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthMessage, setOauthMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = (await window.api.getIosRemoteConfig?.()) as IosRemoteConfig | undefined
        if (!cancelled && result) setConfig(result)
      } catch (err) {
        if (!cancelled) setSectionError(err instanceof Error ? err.message : String(err))
      }
      try {
        const ts = (await window.api.iosRemoteTailscaleStatus?.()) as
          | IosRemoteTailscaleStatus
          | undefined
        if (!cancelled && ts) setTailscale(ts)
      } catch {
        // Detection is best-effort; the row degrades to "unavailable".
      }
      try {
        const oauth = (await window.api.iosRemoteTailscaleOAuthStatus?.()) as
          | TailscaleOAuthStatus
          | undefined
        if (!cancelled && oauth) {
          setOauthStatus(oauth)
          setOauthClientId(oauth.clientId ?? '')
        }
      } catch {
        // Best-effort; the discovery card degrades to "not configured".
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshSignal])

  const enableDetectedTailscaleRelay = async (): Promise<void> => {
    try {
      setTailscaleBusy(true)
      setTailscaleMessage(null)
      const result = await window.api.iosRemoteTailscaleEnable?.()
      if (result?.status) setTailscale(result.status as unknown as IosRemoteTailscaleStatus)
      // This action can restart the bridge before a later Serve/probe step
      // reports failure. Refresh config + the pairing bootstrap regardless of
      // the final readiness result so the QR never points at the disposed
      // pre-action session.
      const refreshed = (await window.api.getIosRemoteConfig?.()) as IosRemoteConfig | undefined
      if (refreshed) setConfig(refreshed)
      onRemoteBridgeChanged?.()
      if (!result?.ok) {
        setTailscaleMessage({
          kind: 'error',
          text: result?.message || 'Tailscale command failed.'
        })
      } else {
        setTailscaleMessage({
          kind: 'ok',
          text: 'The optional WSS door is ready. The pairing QR above was refreshed.'
        })
      }
    } catch (err) {
      setTailscaleMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTailscaleBusy(false)
    }
  }

  const disableTailscaleRemote = async (): Promise<void> => {
    try {
      setTailscaleBusy(true)
      setTailscaleMessage(null)
      const result = await window.api.iosRemoteTailscaleDisable?.()
      if (result?.status) setTailscale(result.status as unknown as IosRemoteTailscaleStatus)
      if (!result?.ok) {
        setTailscaleMessage({
          kind: 'error',
          text: result?.message || 'Tailscale command failed.'
        })
      } else {
        const refreshed = (await window.api.getIosRemoteConfig?.()) as IosRemoteConfig | undefined
        if (refreshed) setConfig(refreshed)
      }
    } catch (err) {
      setTailscaleMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTailscaleBusy(false)
    }
  }

  const testDetectedTailscaleRelay = async (): Promise<void> => {
    try {
      setTailscaleTestBusy(true)
      setTailscaleMessage(null)
      const result = await window.api.iosRemoteTailscaleTest?.()
      if (result?.status) setTailscale(result.status as unknown as IosRemoteTailscaleStatus)
      setTailscaleMessage({
        kind: result?.ok ? 'ok' : 'error',
        text: result?.ok
          ? 'Cellular is ready. The pairing QR above was refreshed.'
          : result?.message || 'Test failed.'
      })
      // A user may have fixed Serve outside TaskWraith while the visible QR
      // still contains the earlier LAN-only candidate set. A successful live
      // test is the proof needed to mint a Cellular-ready bootstrap now.
      if (result?.ok) onRemoteBridgeChanged?.()
    } catch (err) {
      setTailscaleMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTailscaleTestBusy(false)
    }
  }

  const copyDetectedTailscaleRelay = async (): Promise<void> => {
    const value = tailscale?.suggestedUrl
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setTailscaleCopied(true)
      window.setTimeout(() => setTailscaleCopied(false), 1200)
    } catch {
      setTailscaleMessage({ kind: 'error', text: 'Could not copy the detected relay door.' })
    }
  }

  const saveOauth = async (): Promise<void> => {
    try {
      setOauthBusy(true)
      setOauthMessage(null)
      const result = await window.api.iosRemoteTailscaleOAuthSet?.({
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret.trim()
      })
      if (!result?.ok) {
        setOauthMessage(result?.error || 'Could not save the OAuth client.')
        return
      }
      // The secret is never read back; clear the input so it isn't left on screen.
      setOauthClientSecret('')
      const refreshed = (await window.api.iosRemoteTailscaleOAuthStatus?.()) as
        | TailscaleOAuthStatus
        | undefined
      if (refreshed) setOauthStatus(refreshed)
    } catch (err) {
      setOauthMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setOauthBusy(false)
    }
  }

  const clearOauth = async (): Promise<void> => {
    try {
      setOauthBusy(true)
      setOauthMessage(null)
      await window.api.iosRemoteTailscaleOAuthClear?.()
      setOauthClientId('')
      setOauthClientSecret('')
      const refreshed = (await window.api.iosRemoteTailscaleOAuthStatus?.()) as
        | TailscaleOAuthStatus
        | undefined
      if (refreshed) setOauthStatus(refreshed)
    } catch (err) {
      setOauthMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setOauthBusy(false)
    }
  }

  const save = async (patch: {
    enabled?: boolean
    relayUrl?: string
    manualRelayUrl?: string
    openAtLogin?: boolean
  }): Promise<void> => {
    try {
      setSaving(true)
      setSectionError(null)
      const result = (await window.api.setIosRemoteConfig?.(patch)) as IosRemoteConfig | undefined
      if (result) {
        setConfig(result)
        // set-ios-remote-config applies the change immediately by restarting
        // (or stopping) the bridge. Its old pairing session is therefore no
        // longer valid even when the resulting settings values look unchanged.
        onRemoteBridgeChanged?.()
        const ts = (await window.api.iosRemoteTailscaleStatus?.()) as
          | IosRemoteTailscaleStatus
          | undefined
        if (ts) setTailscale(ts)
      }
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const pillKind = config?.runtimeActive
    ? 'ok'
    : config?.runtimeError
      ? 'err'
      : config?.effectiveEnabled
        ? 'warn'
        : 'idle'
  const pillLabel = config?.runtimeActive
    ? 'Running'
    : config?.runtimeError
      ? 'Failed to start'
      : config?.effectiveEnabled
        ? 'On after restart'
        : 'Off'
  const switchChecked = config?.envOverride
    ? Boolean(config.effectiveEnabled)
    : (config?.enabled ?? false)
  const configuredWssUrl = config?.relayUrl.trim().startsWith('wss://')
    ? config.relayUrl.trim()
    : null
  const relayDoorExample =
    tailscale?.suggestedUrl || configuredWssUrl || 'wss://<this-mac-magicdns-name>'

  return (
    <section className="bridge-networking-section">
      <header className="bridge-networking-section-header">
        <span className="bridge-networking-section-title">iOS remote bridge</span>
        <StatusPill kind={pillKind} label={pillLabel} />
      </header>
      {sectionError && <div className="settings-error">{sectionError}</div>}
      {config?.runtimeError && <div className="settings-error">{config.runtimeError}</div>}
      <label className="settings-service-row settings-fx-toggle">
        <span>
          Enable iOS remote bridge
          <small>
            Pair an iPhone/iPad over the encrypted relay. Settings-based, so login-item launches
            keep it alive — no shell environment needed. Once a device is paired, TaskWraith keeps
            the computer awake for remote threads while still allowing the screen to lock and turn
            off.
            {config?.envOverride
              ? ` Currently forced ${config.envOverride === 'force-on' ? 'ON' : 'OFF'} by IOS_REMOTE_TRUE.`
              : ''}
          </small>
        </span>
        <input
          type="checkbox"
          checked={switchChecked}
          disabled={saving || config === null || config.envOverride !== null}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
      </label>
      <div className="settings-service-row bridge-networking-detected-relay-row">
        <span>
          Tailscale remote access
          <small>
            {tailscale === null
              ? 'Checking Tailscale…'
              : !tailscale.tailscaleAvailable
                ? tailscale.tailscaleReason ||
                  'Tailscale not detected — install it and sign in to enable off-LAN access.'
                : tailscale.directAvailable
                  ? 'Ready for Cellular directly over Tailscale — no Serve setup required. WSS is optional defense-in-depth.'
                  : tailscale.active
                    ? 'Ready for Cellular through the optional Tailscale Serve WSS door.'
                    : tailscale.usingSavedRelayFallback
                      ? tailscale.tailscaleReason ||
                        'The optional WSS address is saved but not live. Direct Tailscale IP remains the preferred zero-setup route when available.'
                      : 'Connect Tailscale on the Mac and phone for zero-setup Cellular access. You can optionally add a WSS front door.'}
          </small>
          {tailscale?.directRelayUrl && (
            <code className="bridge-networking-detected-relay-url">
              {tailscale.directRelayUrl}
            </code>
          )}
          {!tailscale?.directRelayUrl && tailscale?.suggestedUrl && (
            <code className="bridge-networking-detected-relay-url">{tailscale.suggestedUrl}</code>
          )}
        </span>
        <span className="bridge-networking-detected-relay-actions">
          {tailscale?.cellularReady && <StatusPill kind="ok" label="Cellular ready" />}
          {tailscale && !tailscale.cellularReady && tailscale.suggestedUrl && (
            <StatusPill kind="warn" label="Cellular not ready" />
          )}
          <PillButton
            variant="primary"
            size="compact"
            disabled={
              tailscaleBusy ||
              tailscale === null ||
              !tailscale.tailscaleAvailable ||
              !tailscale.suggestedUrl
            }
            onClick={() => void enableDetectedTailscaleRelay()}
          >
            {tailscaleBusy
              ? 'Working…'
              : tailscale?.active || tailscale?.relayUrlMatches
                ? 'Repair WSS'
                : 'Add WSS'}
          </PillButton>
          <PillButton
            size="compact"
            disabled={!tailscale?.suggestedUrl}
            onClick={() => void copyDetectedTailscaleRelay()}
          >
            {tailscaleCopied ? 'Copied' : 'Copy WSS'}
          </PillButton>
          <PillButton
            size="compact"
            disabled={
              tailscaleTestBusy || (!tailscale?.directRelayUrl && !tailscale?.suggestedUrl)
            }
            onClick={() => void testDetectedTailscaleRelay()}
          >
            {tailscaleTestBusy ? 'Testing…' : 'Test'}
          </PillButton>
          {tailscale?.active && (
            <PillButton
              variant="danger"
              size="compact"
              disabled={tailscaleBusy}
              onClick={() => void disableTailscaleRemote()}
            >
              Disable
            </PillButton>
          )}
        </span>
      </div>
      {tailscaleMessage && (
        <div
          className={`tailscale-link-message is-${tailscaleMessage.kind}`}
          role="status"
          aria-live="polite"
        >
          {tailscaleMessage.text}
        </div>
      )}
      <div className="bridge-networking-relay-help">
        <div className="bridge-networking-relay-help-title">
          Phone ready but still cannot connect?
        </div>
        <p>
          Confirm the Mac and phone can see each other on the same tailnet (or through a device
          share), then find this Mac in the Tailscale app or on the{' '}
          <a href={TAILSCALE_MACHINES_URL} target="_blank" rel="noreferrer">
            Machines page
          </a>
          . TaskWraith normally connects directly to the Mac&apos;s Tailscale IP at{' '}
          <code>{tailscale?.directRelayUrl || 'ws://100.x.y.z:8787'}</code>; no Serve setup is
          required.
        </p>
        <p>
          Optional: add a TLS/hostname WSS door with Add WSS. If that setup fails, open{' '}
          <a href={TAILSCALE_DNS_URL} target="_blank" rel="noreferrer">
            Tailscale DNS
          </a>{' '}
          to enable HTTPS, then return here and press Repair WSS. The optional address is{' '}
          <code>{relayDoorExample}</code>.
        </p>
        <div className="bridge-networking-relay-help-links">
          <a href={TAILSCALE_MAGICDNS_HELP_URL} target="_blank" rel="noreferrer">
            MagicDNS help
          </a>
          <a href={TAILSCALE_SERVE_HELP_URL} target="_blank" rel="noreferrer">
            Serve help
          </a>
        </div>
      </div>
      <details className="bridge-networking-advanced-relay">
        <summary>Advanced relay settings</summary>
        <label className="settings-service-row">
          <span>
            Optional WSS relay URL
            <small>
              Usually managed by Add WSS above. Direct Tailscale IP access does not need this.
              Edit only for a separate hosted relay or custom Tailscale Serve address.
            </small>
          </span>
          <input
            type="text"
            className="settings-text-input"
            placeholder="wss://relay.example.com"
            defaultValue={config?.relayUrl ?? ''}
            disabled={saving || config === null}
            onBlur={(event) => {
              if ((config?.relayUrl ?? '') !== event.target.value.trim()) {
                void save({ relayUrl: event.target.value })
              }
            }}
          />
        </label>
        <label className="settings-service-row">
          <span>
            Extra advertised relay door
            <small>
              Optional fallback advertised alongside LAN and the detected Tailscale door. Enter
              this computer&apos;s host/IP or a full ws(s):// URL, never the phone&apos;s address.
              {tailscale?.manualRelayInput && tailscale.manualRelayUrl
                ? ` Current candidate: ${tailscale.manualRelayUrl}.`
                : tailscale?.manualRelayInput
                  ? ' The current value could not be parsed as a relay URL.'
                  : ''}
            </small>
          </span>
          <input
            type="text"
            className="settings-text-input"
            placeholder="wss://your-mac.tailnet.ts.net or 100.x.y.z"
            defaultValue={config?.manualRelayUrl ?? ''}
            disabled={saving || config === null}
            onBlur={(event) => {
              if ((config?.manualRelayUrl ?? '') !== event.target.value.trim()) {
                void save({ manualRelayUrl: event.target.value })
              }
            }}
          />
        </label>
      </details>
      <div className="settings-service-row">
        <span>
          Let phones find this host on your tailnet
          <small>
            Discovery only — this does not enable Cellular access or configure Tailscale Serve. Add
            an optional Tailscale OAuth client (scope <code>devices:core:read</code>) and an
            already-paired phone can discover your other TaskWraith computers and pair with them
            without scanning each QR. The secret is stored encrypted on this Mac and never sent to
            the phone — the host enumerates the tailnet on its behalf.
            {oauthStatus && !oauthStatus.encryptionAvailable
              ? ' ⚠︎ Keychain encryption is unavailable on this Mac, so the secret can’t be stored safely — discovery is disabled until that’s resolved.'
              : ''}
          </small>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {oauthStatus?.configured ? (
            <StatusPill kind="ok" label="Configured" />
          ) : (
            <StatusPill kind="idle" label="Not set up" />
          )}
        </span>
      </div>
      <label className="settings-service-row">
        <span>Tailscale OAuth client ID</span>
        <input
          type="text"
          className="settings-text-input"
          placeholder="k123abc…"
          autoComplete="off"
          value={oauthClientId}
          disabled={oauthBusy}
          onChange={(event) => setOauthClientId(event.target.value)}
        />
      </label>
      <label className="settings-service-row">
        <span>
          OAuth client secret
          <small>
            {oauthStatus?.configured
              ? 'A secret is stored. Paste a new one to replace it, or Clear to remove discovery.'
              : 'tskey-client-… — generated in the Tailscale admin console (Settings → OAuth clients).'}
          </small>
        </span>
        <input
          type="password"
          className="settings-text-input"
          placeholder={oauthStatus?.configured ? '•••••••• (unchanged)' : 'tskey-client-…'}
          autoComplete="off"
          value={oauthClientSecret}
          disabled={oauthBusy}
          onChange={(event) => setOauthClientSecret(event.target.value)}
        />
      </label>
      <div className="settings-service-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {oauthStatus?.configured && (
          <PillButton
            variant="danger"
            size="compact"
            disabled={oauthBusy}
            onClick={() => void clearOauth()}
          >
            Clear
          </PillButton>
        )}
        <PillButton
          variant="primary"
          size="compact"
          disabled={
            oauthBusy ||
            !oauthClientId.trim() ||
            !oauthClientSecret.trim() ||
            oauthStatus?.encryptionAvailable === false
          }
          onClick={() => void saveOauth()}
        >
          {oauthBusy ? 'Saving…' : 'Save'}
        </PillButton>
      </div>
      {oauthMessage && <div className="settings-error">{oauthMessage}</div>}
      <label className="settings-service-row settings-fx-toggle">
        <span>
          Start TaskWraith at login
          <small>
            With the bridge enabled, the app keeps running after the window closes —
            together these make your Mac reachable from the phone without babysitting.
          </small>
        </span>
        <input
          type="checkbox"
          checked={config?.openAtLogin ?? false}
          disabled={saving || config === null}
          onChange={(event) => void save({ openAtLogin: event.target.checked })}
        />
      </label>
    </section>
  )
}

function StatusPill({
  kind,
  label
}: {
  kind: 'ok' | 'warn' | 'idle' | 'err'
  label: string
}): React.JSX.Element {
  return <span className={`bridge-networking-pill bridge-networking-pill-${kind}`}>{label}</span>
}

function Field({
  label,
  value,
  copyable = false
}: {
  label: string
  value: string
  copyable?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard rejected — silently fall through; user can still
      // select-and-copy the displayed text.
    }
  }
  return (
    <div className="bridge-networking-field">
      <dt className="bridge-networking-field-label">{label}</dt>
      <dd className="bridge-networking-field-value">
        <span>{value}</span>
        {copyable && (
          <button type="button" className="bridge-networking-copy-btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </dd>
    </div>
  )
}
