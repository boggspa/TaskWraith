/*
 * TailnetDiscovery — the host-side "oracle" orchestration for QR-optional
 * multi-host discovery (Slice 5e).
 *
 * An already-paired phone asks a host to find its OTHER TaskWraith machines.
 * The host (which alone holds the Tailscale OAuth credential — see
 * TailscaleDevices) enumerates the tailnet, then probes each device's read-only
 * /v1/hostinfo advertisement (served by the embedded relay behind
 * `tailscale serve` at https://<MagicDNS>). Devices that answer with valid
 * TaskWraith host info become discovery candidates; everything else (no
 * TaskWraith, unreachable, malformed) is silently dropped.
 *
 * Two-sided dedupe, by design:
 *   - HOST drops itself (its own identity pubkey appears in the device list).
 *   - PHONE dedupes the returned list against its OWN paired hosts — the oracle
 *     cannot know which other hosts a phone has already paired with (those
 *     pairings are invisible to it), so that filter lives on the device.
 *
 * Trust is unchanged: discovery only SURFACES candidates. The 6-digit
 * transcript SAS still gates every pairing, so a wrong/hostile list at worst
 * offers a host the user must still confirm. Nothing here is authenticated by
 * the list itself.
 */

import { enumerateTailnetDevices, defaultFetch, type TailscaleFetch } from './TailscaleDevices'

/** A discoverable TaskWraith host as the phone's pairing flow needs it — the
 * PUBLIC subset of a pairing bootstrap (no sessionId; that's minted on demand
 * via /v1/beginpair when the user taps to pair). */
export interface DiscoveredHost {
  /** Raw-32B Ed25519 identity pubkey (base64) — the trust anchor the phone
   * pins; also the dedupe key on both sides. */
  macIdentityPubKey: string
  /** Friendly host label for the picker ("TaskWraith on studio"). */
  macDisplayName?: string
  /** Phone-reachable relay URLs (LAN ws:// first, wss front door second). */
  relayUrls: string[]
  /** Host OS for the per-OS glyph ('mac' | 'windows' | 'linux'). */
  hostPlatform?: string
}

/** Cap on hosts RETURNED so the unicast ack stays inside the relay frame
 * budget (1MB). Personal tailnets are far smaller; truncation is logged. */
const DEFAULT_MAX_HOSTS = 32
/** Cap on devices PROBED so a pathologically large tailnet can't fan out into
 * thousands of concurrent HTTPS requests. Logged when it bites. */
const DEFAULT_MAX_PROBES = 128
/** Per-probe timeout — a slow/hung device must not stall the whole fan-out. */
const DEFAULT_PROBE_TIMEOUT_MS = 4000

const TASKWRAITH_HOSTINFO_PROTOCOL = 'taskwraith-e2ee-v1'
const RAW_IDENTITY_KEY_BYTES = 32
const MAX_DISPLAY_NAME_CHARS = 80
const HOST_PLATFORMS = new Set(['mac', 'windows', 'linux'])

function isRawIdentityPubKeyB64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    return Buffer.from(value, 'base64').length === RAW_IDENTITY_KEY_BYTES
  } catch {
    return false
  }
}

function isAllowedRelayUrl(value: string, magicDNSName?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  if (parsed.protocol === 'ws:') {
    return isLocalRelayHost(parsed.hostname)
  }
  if (parsed.protocol !== 'wss:') return false

  const expected = magicDNSName?.trim().replace(/\.$/, '').toLowerCase()
  if (!expected) return true
  const host = parsed.hostname.toLowerCase()
  return host === expected || host.endsWith(`.${expected}`)
}

function isLocalRelayHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost') return true
  if (host === '::1') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true
  const m = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(host)
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31)
}

function cleanDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_CHARS) return undefined
  return trimmed
}

/** Parse a /v1/hostinfo response body into a DiscoveredHost. Requires the exact
 * TaskWraith protocol, a raw 32-byte identity pubkey, and at least one safe relay
 * URL. Display name + platform are best-effort. Returns null for any non-
 * TaskWraith / malformed body. */
export function parseDiscoveredHost(body: unknown, magicDNSName?: string): DiscoveredHost | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (o.protocol !== TASKWRAITH_HOSTINFO_PROTOCOL) return null
  const macIdentityPubKey =
    typeof o.macIdentityPubKey === 'string' ? o.macIdentityPubKey.trim() : ''
  if (!isRawIdentityPubKeyB64(macIdentityPubKey)) return null
  const relayUrls = Array.isArray(o.relayUrls)
    ? o.relayUrls
        .filter((u): u is string => typeof u === 'string')
        .map((u) => u.trim())
        .filter((u) => isAllowedRelayUrl(u, magicDNSName))
    : []
  if (relayUrls.length === 0) return null
  const macDisplayName = cleanDisplayName(o.macDisplayName)
  const hostPlatform =
    typeof o.hostPlatform === 'string' && HOST_PLATFORMS.has(o.hostPlatform.trim())
      ? o.hostPlatform.trim()
      : undefined
  return { macIdentityPubKey, macDisplayName, relayUrls, hostPlatform }
}

/** Resolve a probe Promise to its value, or to `fallback` if it rejects OR a
 * timeout fires first. The losing branch's timer is always cleared. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

/** Probe one tailnet device's MagicDNS front door for /v1/hostinfo. Any error /
 * non-200 / non-TaskWraith body resolves to null — the device simply isn't a
 * discoverable TaskWraith host. Never throws (control flow stays in the
 * returned value, mirroring TailscaleDevices). */
export async function probeTailnetHost(
  magicDNSName: string,
  fetchImpl: TailscaleFetch,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<DiscoveredHost | null> {
  const name = magicDNSName.trim().replace(/\.$/, '')
  if (!name) return null
  const url = `https://${name}/v1/hostinfo`
  const doProbe = async (): Promise<DiscoveredHost | null> => {
    const init: Parameters<TailscaleFetch>[1] = { method: 'GET' }
    // Real abort when the runtime supports it; the withTimeout race is the
    // backstop either way.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs)
    }
    let res
    try {
      res = await fetchImpl(url, init)
    } catch {
      return null
    }
    if (!res.ok) return null
    const raw = await res.text().catch(() => '')
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    return parseDiscoveredHost(parsed, name)
  }
  return withTimeout(doProbe(), timeoutMs, null)
}

/** Full host-side discovery: enumerate the tailnet, probe every device's
 * /v1/hostinfo in parallel, then return the TaskWraith hosts with self (and any
 * caller-supplied) identities dropped and duplicates collapsed. Read-only and
 * non-throwing — failures come back as { ok: false, reason }. */
export async function discoverTailnetHosts(input: {
  clientId: string
  clientSecret: string
  /** Identity pubkeys to exclude — at minimum THIS host's own (it appears in
   * its own tailnet). The phone does the paired-host dedupe separately. */
  excludeMacIdentityPubKeys?: string[]
  fetchImpl?: TailscaleFetch
  maxHosts?: number
  maxProbes?: number
  probeTimeoutMs?: number
  log?: (line: string) => void
}): Promise<{ ok: true; hosts: DiscoveredHost[] } | { ok: false; reason: string }> {
  const fetchImpl = input.fetchImpl ?? defaultFetch
  const log = input.log ?? (() => undefined)
  const maxHosts = input.maxHosts ?? DEFAULT_MAX_HOSTS
  const maxProbes = input.maxProbes ?? DEFAULT_MAX_PROBES

  const enumeration = await enumerateTailnetDevices({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    fetchImpl
  })
  if (!enumeration.ok) return { ok: false, reason: enumeration.message }

  let devices = enumeration.devices
  if (devices.length > maxProbes) {
    log(
      `[TailnetDiscovery] tailnet has ${devices.length} devices; probing the first ${maxProbes} (cap)`
    )
    devices = devices.slice(0, maxProbes)
  }

  const exclude = new Set(
    (input.excludeMacIdentityPubKeys ?? []).map((k) => k.trim()).filter(Boolean)
  )
  const probed = await Promise.all(
    devices.map((d) => probeTailnetHost(d.magicDNSName, fetchImpl, input.probeTimeoutMs))
  )

  const seen = new Set<string>()
  const hosts: DiscoveredHost[] = []
  let truncated = false
  for (const host of probed) {
    if (!host) continue
    if (exclude.has(host.macIdentityPubKey)) continue // self (+ caller-excluded)
    if (seen.has(host.macIdentityPubKey)) continue // same host on multiple DNS names
    seen.add(host.macIdentityPubKey)
    if (hosts.length >= maxHosts) {
      truncated = true
      continue
    }
    hosts.push(host)
  }
  if (truncated) {
    log(
      `[TailnetDiscovery] found ${seen.size} TaskWraith hosts; returning the first ${maxHosts} (frame-budget cap)`
    )
  }
  return { ok: true, hosts }
}
