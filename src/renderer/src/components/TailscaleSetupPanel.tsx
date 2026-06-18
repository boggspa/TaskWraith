import { useState, type JSX } from 'react'
import { looksLikeTailscaleAuthKey } from '../../../shared/tailscaleAuthKey'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'
const TAILSCALE_AUTHKEY_URL = 'https://login.tailscale.com/admin/settings/keys'

type LinkMessage = { kind: 'ok' | 'warn' | 'error'; text: string }

const KIND_PREFIX: Record<LinkMessage['kind'], string> = { ok: '✓ ', warn: '⚠ ', error: '✕ ' }
const KIND_LABEL: Record<LinkMessage['kind'], string> = {
  ok: 'Success: ',
  warn: 'Warning: ',
  error: 'Error: '
}

/**
 * TailscaleSetupPanel — onboarding + guided setup for the supported beyond-LAN
 * transport. Past the local network, paired iPhones/iPads reach this Mac over
 * Tailscale, so both devices must sit on the same tailnet.
 *
 * (A) Signposts how to pair both devices.
 * (B) For users who already run a Tailscale fleet, a guided auth-key flow that
 *     brings THIS Mac onto their tailnet without the interactive browser
 *     sign-in. Important scope: linking the Mac is only one piece — the phone
 *     still needs its own Tailscale sign-in to the SAME tailnet, and off-LAN
 *     (cellular) reach additionally needs the "Remote access via Tailscale"
 *     control in Bridge networking. The key is sent once to the main process
 *     (used immediately for `tailscale up`, written to a 0600 file off the
 *     argv, never stored or logged) and cleared from the field on success.
 *
 * Distinct from BridgeNetworkingPanel's Tailscale *status* block — this is the
 * "how do I set it up" surface.
 */
export function TailscaleSetupPanel(): JSX.Element {
  const [authKey, setAuthKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<LinkMessage | null>(null)

  const keyLooksValid = looksLikeTailscaleAuthKey(authKey)
  const showFormatHint = authKey.trim().length > 0 && !keyLooksValid

  const linkWithAuthKey = async (): Promise<void> => {
    const key = authKey.trim()
    if (!keyLooksValid || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.api.iosRemoteTailscaleLink?.(key)
      const status = (res?.status ?? {}) as { tailscaleAvailable?: boolean; dnsName?: string | null }
      if (res?.ok) {
        // Don't keep the bearer credential in renderer state any longer.
        setAuthKey('')
        if (status.tailscaleAvailable) {
          setMessage({
            kind: 'ok',
            text:
              res.message ||
              `This Mac is on your tailnet${status.dnsName ? ` as ${status.dnsName}` : ''}.`
          })
        } else {
          // `tailscale up` returned ok but the node isn't reporting connected
          // yet — don't claim success the status can't back up.
          setMessage({
            kind: 'warn',
            text:
              res.message ||
              'Tailscale ran, but this Mac isn’t showing as connected yet — open the Tailscale app and check it’s signed in.'
          })
        }
      } else {
        setMessage({ kind: 'error', text: res?.message || 'Could not link with that auth key.' })
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Linking failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bridge-networking-panel tailscale-setup-panel">
      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Pair both devices on one tailnet</span>
        </header>
        <ol className="tailscale-setup-steps">
          <li>
            Install Tailscale on this Mac and sign in —{' '}
            <a
              href={TAILSCALE_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="bridge-networking-install-link"
            >
              tailscale.com/download
            </a>
            .
          </li>
          <li>
            Install the Tailscale app on the iPhone / iPad and sign into the{' '}
            <strong>same account</strong>.
          </li>
          <li>
            Both devices now share a private, encrypted network. To reach this Mac from cellular
            (off-LAN), also enable <strong>Remote access via Tailscale</strong> in Bridge
            networking above.
          </li>
        </ol>
        <div className="settings-hint">
          Keep Tailscale running on the phone (it idles in the background) so off-LAN runs connect
          instantly.
        </div>
      </section>

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">
            Already on Tailscale? Link with an auth key
          </span>
        </header>
        <div className="settings-hint">
          Skip the browser sign-in: generate an auth key in the{' '}
          <a
            href={TAILSCALE_AUTHKEY_URL}
            target="_blank"
            rel="noreferrer"
            className="bridge-networking-install-link"
          >
            Tailscale admin console
          </a>{' '}
          (for the <strong>same tailnet your phone will join</strong>) and paste it here to bring
          this Mac onto your tailnet. The key is used once and is never stored or logged. If this
          Mac is already connected, no key is needed.
        </div>
        <form
          className="tailscale-link-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault()
            void linkWithAuthKey()
          }}
        >
          <div className="tailscale-link-row">
            <input
              type="password"
              className="settings-input"
              placeholder="tskey-auth-…"
              value={authKey}
              onChange={(event) => {
                setAuthKey(event.target.value)
                if (message) setMessage(null)
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Tailscale auth key"
              disabled={busy}
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !keyLooksValid}>
              {busy ? 'Linking…' : 'Link this Mac'}
            </button>
          </div>
          {showFormatHint && (
            <div className="tailscale-link-message is-warn">
              <span aria-hidden="true">⚠ </span>Expected a Tailscale auth key (a tskey-… value).
            </div>
          )}
          <div className="tailscale-link-message-wrap" role="status" aria-live="polite">
            {message && (
              <span className={`tailscale-link-message is-${message.kind}`}>
                <span className="sr-only">{KIND_LABEL[message.kind]}</span>
                <span aria-hidden="true">{KIND_PREFIX[message.kind]}</span>
                {message.text}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  )
}
