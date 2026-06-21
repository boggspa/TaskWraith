/*
 * TailscaleDevices — host-side tailnet device enumeration for QR-optional
 * multi-host discovery.
 *
 * The user provisions a Tailscale OAuth client scoped `devices:core:read` (the
 * minimum needed to LIST devices — it cannot modify the tailnet). We exchange
 * those client credentials for a short-lived access token, then list the
 * tailnet's devices to learn their MagicDNS names. A paired host does this on
 * the phone's behalf (the "connected host is the oracle" model): it then probes
 * each candidate's /v1/hostinfo to find which run TaskWraith and returns that
 * list to the phone over the e2ee channel. The phone NEVER sees this credential.
 *
 * Discovery is a convenience, not an authentication: the 6-digit transcript SAS
 * still gates every pairing, so a wrong/hostile device list at worst offers a
 * host the user must still confirm out-of-band.
 *
 * Security stance (mirrors TailscaleAuth):
 *   - The client secret is a bearer credential: host-side only, never returned
 *     to the renderer/phone, never logged (stored safeStorage-encrypted by the
 *     caller). Any echo of it in error text is stripped before surfacing.
 *   - `fetchImpl` is injectable; nothing here throws for control flow — failures
 *     come back as a typed { ok: false, message } with a redacted message.
 */

import { looksLikeTailscaleOAuthClientSecret } from '../shared/tailscaleAuthKey'

const TS_API_BASE = 'https://api.tailscale.com/api/v2'
/** OAuth client_credentials token endpoint. */
const TS_TOKEN_URL = `${TS_API_BASE}/oauth/token`
/** `-` is Tailscale's alias for "the tailnet the credential belongs to". */
const TS_DEVICES_URL = `${TS_API_BASE}/tailnet/-/devices`

/** Minimal response shape so callers can inject a stub without a DOM `fetch`. */
export interface TailscaleHttpResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

export type TailscaleFetch = (
  url: string,
  init: {
    method: string
    headers?: Record<string, string>
    body?: string
    /** Optional abort signal — discovery probes pass AbortSignal.timeout so a
     * slow/hung tailnet device can't stall the whole fan-out. */
    signal?: AbortSignal
  }
) => Promise<TailscaleHttpResponse>

/** A tailnet machine as the phone-side discovery list cares about it. */
export interface TailnetDevice {
  /** Tailscale device id (stable; not shown to the user). */
  id: string
  /** MagicDNS FQDN with any trailing dot stripped, e.g. "studio.tailnet.ts.net". */
  magicDNSName: string
  /** Short hostname (fallback label). */
  hostname: string
  /** Tailscale-reported OS string ("macOS"/"windows"/"linux"/…), best-effort. */
  os: string
}

export type TailscaleDevicesResult =
  | { ok: true; devices: TailnetDevice[] }
  | { ok: false; message: string }

export const defaultFetch: TailscaleFetch = async (url, init) => {
  // Electron main / Node 18+ ship a global fetch; injected in tests.
  const f = (globalThis as { fetch?: (input: string, init?: unknown) => Promise<TailscaleHttpResponse> }).fetch
  if (!f) throw new Error('global fetch is unavailable in this runtime')
  return f(url, init)
}

/** Strip any verbatim occurrence of the secret/token from surfaced text. */
function redact(text: string, ...secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (s) out = out.split(s).join('tskey-client-…redacted')
  }
  return out
}

/**
 * Exchange OAuth client credentials for a short-lived access token. Returns the
 * token string, or a typed failure with a redacted message.
 */
export async function fetchTailscaleAccessToken(input: {
  clientId: string
  clientSecret: string
  fetchImpl?: TailscaleFetch
}): Promise<{ ok: true; accessToken: string } | { ok: false; message: string }> {
  const clientId = input.clientId.trim()
  const clientSecret = input.clientSecret.trim()
  if (!clientId) return { ok: false, message: 'Missing Tailscale OAuth client id.' }
  if (!looksLikeTailscaleOAuthClientSecret(clientSecret)) {
    return {
      ok: false,
      message:
        'That does not look like a Tailscale OAuth client secret (expected a tskey-client-… value).'
    }
  }
  const fetchImpl = input.fetchImpl ?? defaultFetch
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret
  }).toString()
  let res: TailscaleHttpResponse
  try {
    res = await fetchImpl(TS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, message: redact(`Couldn't reach Tailscale: ${detail}`, clientSecret) }
  }
  const raw = await res.text().catch(() => '')
  if (!res.ok) {
    return {
      ok: false,
      message: redact(
        `Tailscale rejected the OAuth credentials (HTTP ${res.status}). ` +
          `Check the client id/secret and that it has the devices:core:read scope.`,
        clientSecret
      )
    }
  }
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
      return { ok: false, message: 'Tailscale returned no access token.' }
    }
    return { ok: true, accessToken: parsed.access_token }
  } catch {
    return { ok: false, message: 'Tailscale returned an unreadable token response.' }
  }
}

interface RawTailscaleDevice {
  id?: unknown
  name?: unknown
  hostname?: unknown
  os?: unknown
}

function normalizeDevice(raw: RawTailscaleDevice): TailnetDevice | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const name = typeof raw.name === 'string' ? raw.name.replace(/\.$/, '') : ''
  const hostname = typeof raw.hostname === 'string' ? raw.hostname : ''
  const os = typeof raw.os === 'string' ? raw.os : ''
  // The MagicDNS name is what we actually probe; a device without one is useless
  // for discovery (and shouldn't normally happen on a MagicDNS-enabled tailnet).
  if (!name) return null
  return { id, magicDNSName: name, hostname, os }
}

/** List tailnet devices using a previously-obtained access token. */
export async function listTailnetDevices(input: {
  accessToken: string
  fetchImpl?: TailscaleFetch
}): Promise<TailscaleDevicesResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch
  let res: TailscaleHttpResponse
  try {
    res = await fetchImpl(TS_DEVICES_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}` }
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Couldn't reach Tailscale: ${detail}` }
  }
  const raw = await res.text().catch(() => '')
  if (!res.ok) {
    return {
      ok: false,
      message: `Tailscale device list failed (HTTP ${res.status}).`
    }
  }
  try {
    const parsed = JSON.parse(raw) as { devices?: unknown }
    if (!Array.isArray(parsed.devices)) {
      return { ok: false, message: 'Tailscale returned no device list.' }
    }
    const devices = parsed.devices
      .map((d) => normalizeDevice(d as RawTailscaleDevice))
      .filter((d): d is TailnetDevice => d !== null)
    return { ok: true, devices }
  } catch {
    return { ok: false, message: 'Tailscale returned an unreadable device list.' }
  }
}

/**
 * One-shot: client credentials → access token → tailnet device list. This is
 * what the discovery orchestrator calls; the returned MagicDNS names are then
 * probed for /v1/hostinfo to find which run TaskWraith.
 */
export async function enumerateTailnetDevices(input: {
  clientId: string
  clientSecret: string
  fetchImpl?: TailscaleFetch
}): Promise<TailscaleDevicesResult> {
  const token = await fetchTailscaleAccessToken(input)
  if (!token.ok) return token
  return listTailnetDevices({ accessToken: token.accessToken, fetchImpl: input.fetchImpl })
}
