import type { JSX } from 'react'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/**
 * TailscaleSetupPanel — onboarding + guided setup for the supported beyond-LAN
 * transport. Past the local network, paired iPhones/iPads reach this Mac over
 * Tailscale, so both devices must sit on the same tailnet.
 *
 * (A) Signposts how to pair both devices. The guided auth-key link for users
 * who already run a Tailscale fleet is added in a later slice. Distinct from
 * BridgeNetworkingPanel's Tailscale *status* block — this is the "how do I set
 * it up" surface.
 */
export function TailscaleSetupPanel(): JSX.Element {
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
            Done — both devices now share a private, encrypted network, so TaskWraith reaches this
            Mac from anywhere the phone has signal, with no port-forwarding.
          </li>
        </ol>
        <div className="settings-hint">
          Keep Tailscale running on the phone (it idles in the background) so off-LAN runs connect
          instantly.
        </div>
      </section>
    </div>
  )
}
