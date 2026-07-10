/**
 * PairingPage — iOS bridge pairing flow refactored into a Settings
 * tab page (post-1.0.2 settings full-app takeover).
 *
 * Logic mirrors the original `PairingSheet`:
 *   - On mount, asks main to call `bridge.beginPairing` on the Swift
 *     daemon for the current device label.
 *   - Renders the returned `PairingBootstrapPayload` as a scannable QR
 *     (primary path) and a copyable JSON blob (fallback for the iOS
 *     "Paste JSON instead" affordance).
 *   - Clicking the QR maximises it into a screen-filling overlay so
 *     the iPad camera can scan from a comfortable distance.
 *
 * Differences from the old sheet:
 *   - No backdrop, no close button — the Settings sidebar's
 *     "← Back to app" + the existing Escape-to-back handler handle
 *     dismissal.
 *   - No focus management on mount (no close button to focus).
 *   - Internal layout classes use the `.pairing-page__*` namespace
 *     (form fields, QR pane sizing, etc.) — renamed from the legacy
 *     `.pairing-page__*` prefix once the modal-sheet form-factor was
 *     retired in 1.0.2 + the page became the only consumer. The outer
 *     chrome lives under the `.pairing-page` wrapper.
 *
 * The `IncomingPairingPrompt` modal that owns the 6-digit verification
 * step is unchanged and continues to layer on top of whatever screen
 * the user is on (chat surface, Settings, etc.).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import ghostMarkRaw from '../assets/taskwraith-ghost-mark.svg?raw'
import { embedQrCenterLogo } from '../lib/qrGhostLogo'
import { PairedDevicesPanel } from './PairedDevicesPanel'
import { BridgeNetworkingPanel } from './BridgeNetworkingPanel'
import { ApnsConfigPanel } from './ApnsConfigPanel'
import { TailscaleSetupPanel } from './TailscaleSetupPanel'

interface BootstrapState {
  /** Pretty-printed JSON for display + copy. */
  json: string
  /** SVG markup of the QR rendered from the JSON. */
  qrSvg: string
}

const DISPLAY_NAME_STORAGE_KEY = 'taskwraith-pairing-display-name'

// APNs off-LAN wake is hidden: it needs a developer-issued .p8 that virtually
// nobody configures, and Tailscale is the supported beyond-LAN path. Flip to
// true to bring the credentials panel back.
// TEMP (2026-06-21): re-enabled for local Tier-1 .p8 testing. REVERT TO false
// before shipping — this panel is intentionally hidden for end users.
const APNS_PANEL_ENABLED = true

export function PairingPage(): JSX.Element {
  const [displayName, setDisplayName] = useState<string>(() => {
    return window.localStorage?.getItem(DISPLAY_NAME_STORAGE_KEY) || 'iPad'
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [copied, setCopied] = useState(false)
  const [maximised, setMaximised] = useState(false)
  const formRef = useRef<HTMLFormElement | null>(null)

  const refresh = useCallback(async (name: string, options?: { force?: boolean }) => {
    setLoading(true)
    setError(null)
    setWarning(null)
    setBootstrap(null)
    try {
      // Mount/remount re-issues the LIVE pairing session (a copied payload
      // stays valid across tab switches); only the explicit Refresh QR
      // button forces a fresh session.
      const result = await window.api.bridgeBeginPairing(name, options)
      if (!result.ok || !result.bootstrap) {
        setError(result.error || 'Failed to begin pairing — no bootstrap returned.')
        return
      }
      // T70 — a degraded-but-working bootstrap (a relay door was probed
      // dead and left out of the QR) pairs fine; surface why remotely or
      // locally it may not reach until the other door is fixed.
      const warningText = (result as { warning?: unknown }).warning
      if (typeof warningText === 'string' && warningText) {
        setWarning(warningText)
      }
      // The Swift daemon returns `BeginPairingResult` =
      //   { pairingSessionID, bootstrapPayload }
      // but the iOS PairingFlow.scan(bootstrapJSON:) expects a bare
      // `PairingBootstrapPayload`. Unwrap before encoding into the QR
      // / paste-JSON so the iPad scanner gets exactly the shape it
      // decodes. Fallback to the wrapper if the field is missing
      // (forward-compat: a future daemon shape might inline).
      const wrapper = result.bootstrap as { bootstrapPayload?: unknown }
      const innerPayload =
        wrapper && typeof wrapper === 'object' && 'bootstrapPayload' in wrapper
          ? wrapper.bootstrapPayload
          : result.bootstrap
      const json = JSON.stringify(innerPayload, null, 2)
      const rawQrSvg = await QRCode.toString(json, {
        type: 'svg',
        // H-level error correction (~30% recoverable): the center ghost
        // mark obscures ~4% of the modules (see qrGhostLogo.ts for the
        // budget math), and H leaves MORE glare/reflection slack on top
        // of that than the previous unbranded 'Q' (~25%) setup had. The
        // extra module density is negligible at on-screen sizes — and
        // the maximise overlay exists for hard cases.
        errorCorrectionLevel: 'H',
        margin: 2,
        color: { dark: '#1f2328', light: '#ffffff00' }
      })
      // Brand the QR with the ghost mark baked into the SVG string —
      // both the inline pane and the maximise overlay render this one
      // string, so they stay visually identical for the scanner.
      const qrSvg = embedQrCenterLogo(rawQrSvg, ghostMarkRaw)
      setBootstrap({ json, qrSvg })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshAfterRemoteBridgeChange = useCallback(() => {
    // Relay/config actions may dispose the pending pairing client or make a
    // previously omitted WSS door reachable. Replace the visible QR so camera
    // and manual setup always receive the current session + candidate set.
    void refresh(displayName, { force: true })
  }, [displayName, refresh])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh(displayName)
    })
    return () => {
      cancelled = true
    }
    // Intentional: only fire on mount + on explicit "Refresh" clicks
    // — displayName changes shouldn't auto-refresh until the user
    // commits via the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc while the maximise overlay is open dismisses just the overlay
  // (the host's existing Escape handler returns the user to the app
  // surface — we don't want one tap to do both).
  useEffect(() => {
    if (!maximised) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMaximised(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [maximised])

  const onCopyJson = useCallback(async () => {
    if (!bootstrap) return
    try {
      await navigator.clipboard.writeText(bootstrap.json)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard rejected — user can still select-and-copy from the visible textarea.
    }
  }, [bootstrap])

  const onDisplayNameSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      const trimmed = displayName.trim() || 'iOS device'
      window.localStorage?.setItem(DISPLAY_NAME_STORAGE_KEY, trimmed)
      void refresh(trimmed, { force: true })
    },
    [displayName, refresh]
  )

  return (
    <div className="pairing-page" aria-label="iOS pairing">
      <header className="pairing-page__header pairing-page__header">
        <div className="pairing-page__header-titles">
          <h2 className="pairing-page__title">Pair with iPhone / iPad</h2>
          <p className="pairing-page__subtitle">
            Open TaskWraith on iPhone or iPad, then scan the QR or copy the manual setup payload. The
            6-digit code appears after the device sends its response.
          </p>
        </div>
      </header>

      <form className="pairing-page__name-form" onSubmit={onDisplayNameSubmit} ref={formRef}>
        <label className="pairing-page__name-label">
          <span>Device label</span>
          <input
            type="text"
            className="pairing-page__name-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={48}
            placeholder="iPad"
            spellCheck={false}
            disabled={loading}
          />
        </label>
        <button
          type="submit"
          className="btn btn-sm"
          disabled={loading || !displayName.trim()}
          title="Generate a fresh pairing QR for this device label"
        >
          {loading ? 'Generating…' : 'Refresh QR'}
        </button>
      </form>

      {error && <div className="settings-error pairing-page__error">{error}</div>}

      {!error && warning && (
        <div className="settings-warning pairing-page__warning" role="status">
          {warning}
        </div>
      )}

      {!error && (
        <div className="pairing-page__body">
          <div className="pairing-page__qr-pane">
            {loading || !bootstrap ? (
              <div className="pairing-page__qr-placeholder">
                {loading ? 'Generating QR…' : 'No QR available'}
              </div>
            ) : (
              <button
                type="button"
                className="pairing-page__qr pairing-page__qr--clickable"
                onClick={() => setMaximised(true)}
                title="Click to maximise for easier camera scanning"
                aria-label="Maximize pairing QR code for scanning"
                // dangerouslySetInnerHTML is intentional — `qrcode`
                // returns a self-contained SVG string we want to
                // render inline so it scales crisply with the panel.
                dangerouslySetInnerHTML={{ __html: bootstrap.qrSvg }}
              />
            )}
            <div className="pairing-page__hint">
              Camera pairing is optional. <strong>Click the QR to maximise</strong> for easier
              scanning, or use Manual setup when an iPad camera cannot read the screen. Pairing
              expires in a few minutes.
            </div>
          </div>

          <div className="pairing-page__fallback-pane">
            <div className="pairing-page__fallback-label">Manual setup payload</div>
            <textarea
              className="pairing-page__json"
              readOnly
              value={bootstrap?.json ?? ''}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="pairing-page__fallback-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void onCopyJson()}
                disabled={!bootstrap}
              >
                {copied ? 'Copied' : 'Copy setup payload'}
              </button>
              <div className="pairing-page__hint pairing-page__hint--inline">
                Paste this into the iOS Manual setup field. Do not paste the 6-digit verification
                code here.
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="pairing-page__footer pairing-page__footer">
        <span className="pairing-page__footer-hint">
          After the device sends its response, verify the 6-digit code on both screens before
          confirming. Refresh the payload if pairing expires.
        </span>
      </footer>

      <section className="pairing-page__section pairing-page__devices">
        <header className="pairing-page__section-header">
          <h3 className="pairing-page__section-title">Paired devices</h3>
          <p className="pairing-page__section-subtitle">
            iPhones and iPads that have completed pairing with this Mac. You can pair multiple
            devices; each keeps its own encrypted session. Remove a device to revoke access until it
            pairs again.
          </p>
        </header>
        <PairedDevicesPanel />
      </section>

      <section className="pairing-page__section pairing-page__tailscale">
        <header className="pairing-page__section-header">
          <h3 className="pairing-page__section-title">Tailscale · remote access</h3>
          <p className="pairing-page__section-subtitle">
            The recommended way to reach this Mac from your iPhone or iPad beyond the local
            network — free, encrypted, and no port-forwarding.
          </p>
        </header>
        <TailscaleSetupPanel />
      </section>

      {/*
        Bridge daemon networking + APNs (off-LAN wake). Both are
        paired-device infrastructure — Bonjour publishes the Mac on the
        local network so iOS can reach it; APNs handles the wake path
        when the iPad isn't on the same network. Used to be its own
        "Bridge Networking" tab; consolidated here. Sits below the
        Tailscale helper so remote-access setup reads top-to-bottom.
      */}
      <section className="pairing-page__section pairing-page__networking">
        <header className="pairing-page__section-header">
          <h3 className="pairing-page__section-title">Bridge networking</h3>
          <p className="pairing-page__section-subtitle">
            How the desktop daemon advertises itself to paired iOS devices, and how off-LAN devices
            reach the Mac over Tailscale.
          </p>
        </header>
        <BridgeNetworkingPanel onRemoteBridgeChanged={refreshAfterRemoteBridgeChange} />
        {APNS_PANEL_ENABLED && <ApnsConfigPanel />}
      </section>

      {/* Maximised QR overlay — covers the screen so the iPad camera
          can comfortably scan from any reasonable distance. Click /
          Esc dismisses (and stops propagation so the host's Escape
          handler doesn't also kick the user out of Settings). */}
      {maximised && bootstrap && (
        <div
          className="pairing-page__maximise"
          role="button"
          tabIndex={0}
          aria-label="Minimise QR code"
          onClick={() => setMaximised(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setMaximised(false)
            }
          }}
        >
          <div
            className="pairing-page__maximise-qr"
            dangerouslySetInnerHTML={{ __html: bootstrap.qrSvg }}
          />
          <div className="pairing-page__maximise-hint">
            Click anywhere to close · Point your device camera at the QR
          </div>
        </div>
      )}
    </div>
  )
}
