/*
 * relayAdvertise — pick the address the embedded relay should advertise in
 * the pairing QR. The URL is consumed by the PHONE, so it must be an address
 * the phone can actually reach AND that iOS App Transport Security permits.
 *
 * The embedded relay is ALWAYS cleartext ws:// (no TLS). iOS ATS only allows
 * cleartext to local-network hosts (NSAllowsLocalNetworking), so:
 *
 *   1. The first non-internal private LAN IPv4 (192.168/10/172.16-31) —
 *      same-Wi-Fi pairing. ATS treats it as local, so cleartext ws:// works.
 *   2. Otherwise the Mac's Tailscale IP (100.64.0.0/10 CGNAT) — reachable
 *      across networks BUT ATS blocks cleartext to it, so a real device can't
 *      use the embedded relay there; it's a last-ditch hint and the pairing
 *      UI warns that remote use needs a wss:// relay (`tailscale cert`).
 *   3. Otherwise loopback — only the simulator can reach that; we log it.
 *
 * (Tailscale used to be #1 — wrong once ATS stopped permitting cleartext to
 * CGNAT: the QR advertised an address the iOS preflight correctly refuses.)
 *
 * Pure given an interface map (injectable for tests).
 */

import os from 'os'

type InterfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>

function isTailscaleAddress(address: string): boolean {
  // 100.64.0.0/10 — second octet 64..127.
  const octets = address.split('.').map(Number)
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

function isPrivateAddress(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4) return false
  if (octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return false
}

export function pickRelayAdvertiseHost(
  interfaces: InterfaceMap = os.networkInterfaces()
): { host: string; kind: 'tailscale' | 'lan' | 'loopback' } {
  const candidates: os.NetworkInterfaceInfo[] = []
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      candidates.push(info)
    }
  }
  // LAN first: ATS permits cleartext ws:// only to local-network hosts, so a
  // same-Wi-Fi LAN IP is the only address a real device can use against the
  // embedded (always-cleartext) relay.
  const lan = candidates.find((info) => isPrivateAddress(info.address))
  if (lan) return { host: lan.address, kind: 'lan' }
  const tailscale = candidates.find((info) => isTailscaleAddress(info.address))
  if (tailscale) return { host: tailscale.address, kind: 'tailscale' }
  return { host: '127.0.0.1', kind: 'loopback' }
}

export function embeddedRelayUrl(port: number, interfaces?: InterfaceMap): string {
  const { host } = pickRelayAdvertiseHost(interfaces)
  return `ws://${host}:${port}`
}

export function isTailscaleDnsName(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  return normalized.endsWith('.ts.net') || normalized.endsWith('.beta.tailscale.net')
}

function isPlainIpv4(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

function isBareHost(input: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(input)
}

export function normalizeManualRelayUrl(input: string, defaultPort: number): string | null {
  const trimmed = input.trim()
  if (!trimmed || /[\s\0]/.test(trimmed)) return null

  const withScheme =
    isBareHost(trimmed) && isTailscaleDnsName(trimmed)
      ? `wss://${trimmed}`
      : isBareHost(trimmed)
        ? `ws://${trimmed}`
        : trimmed

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol === 'http:') parsed.protocol = 'ws:'
  else if (protocol === 'https:') parsed.protocol = 'wss:'
  else if (protocol !== 'ws:' && protocol !== 'wss:') return null

  if (!parsed.hostname) return null
  parsed.username = ''
  parsed.password = ''
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''

  if (!parsed.port && parsed.protocol === 'ws:') {
    parsed.port = String(defaultPort)
  }

  // Bare MagicDNS names default to Tailscale Serve's HTTPS front door. Bare IPs
  // stay ws:// because certificates do not validate against tailnet IP literals.
  if (!parsed.port && parsed.protocol === 'wss:' && isPlainIpv4(parsed.hostname)) {
    parsed.port = String(defaultPort)
  }

  return parsed.toString().replace(/\/$/, '')
}

export function isPlainTailscaleRelayUrl(relayUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return false
  }
  return parsed.protocol === 'ws:' && isTailscaleAddress(parsed.hostname)
}

export function parseTailscaleWssRelayUrl(relayUrl: string): { dnsName: string } | null {
  let parsed: URL
  try {
    parsed = new URL(relayUrl.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'wss:') return null
  const dnsName = parsed.hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!isTailscaleDnsName(dnsName)) return null
  return { dnsName }
}

export function mergeRelayUrls(...groups: Array<Array<string | null | undefined>>): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const group of groups) {
    for (const value of group) {
      const url = value?.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      merged.push(url)
    }
  }
  return merged
}

function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

export function isLocalPlainRelayUrl(
  relayUrl: string,
  interfaces: InterfaceMap = os.networkInterfaces(),
  hostname: string = os.hostname()
): boolean {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'ws:') return false

  const host = normaliseHost(parsed.hostname)
  const bareHostname = normaliseHost(hostname).replace(/\.local$/, '')
  const localHostnames = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    normaliseHost(hostname),
    bareHostname,
    `${bareHostname}.local`
  ])
  if (localHostnames.has(host)) return true

  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (normaliseHost(info.address) === host) return true
    }
  }
  return false
}
