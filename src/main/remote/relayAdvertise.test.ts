import { describe, it, expect } from 'vitest'
import os from 'os'
import {
  embeddedRelayUrl,
  isLocalPlainRelayUrl,
  mergeRelayUrls,
  normalizeManualRelayUrl,
  pickRelayAdvertiseHost
} from './relayAdvertise'

function iface(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`
  }
}

describe('pickRelayAdvertiseHost', () => {
  it('prefers a LAN address over Tailscale (ATS blocks cleartext to CGNAT)', () => {
    const picked = pickRelayAdvertiseHost({
      en0: [iface('192.168.1.50')],
      utun4: [iface('100.99.131.73')]
    })
    expect(picked).toEqual({ host: '192.168.1.50', kind: 'lan' })
  })

  it('falls back to Tailscale only when no LAN address exists', () => {
    const picked = pickRelayAdvertiseHost({ utun4: [iface('100.99.131.73')] })
    expect(picked).toEqual({ host: '100.99.131.73', kind: 'tailscale' })
  })

  it('recognises private LAN ranges (10.x / 172.16-31 / 192.168)', () => {
    expect(pickRelayAdvertiseHost({ en0: [iface('192.168.1.50')] }).kind).toBe('lan')
    expect(pickRelayAdvertiseHost({ en0: [iface('10.0.0.7')] }).host).toBe('10.0.0.7')
    expect(pickRelayAdvertiseHost({ en0: [iface('172.20.1.2')] }).kind).toBe('lan')
    // 172.32.x is NOT private — must not be picked over loopback.
    expect(pickRelayAdvertiseHost({ en0: [iface('172.32.1.2')] }).kind).toBe('loopback')
  })

  it('ignores internal interfaces and lands on loopback when nothing qualifies', () => {
    const picked = pickRelayAdvertiseHost({ lo0: [iface('127.0.0.1', true)] })
    expect(picked).toEqual({ host: '127.0.0.1', kind: 'loopback' })
  })

  it('100.x addresses outside 100.64/10 are not treated as Tailscale', () => {
    const picked = pickRelayAdvertiseHost({
      en0: [iface('100.20.1.1'), iface('192.168.1.9')]
    })
    expect(picked).toEqual({ host: '192.168.1.9', kind: 'lan' })
  })

  it('embeddedRelayUrl composes ws://host:port', () => {
    expect(embeddedRelayUrl(8787, { utun4: [iface('100.99.131.73')] })).toBe(
      'ws://100.99.131.73:8787'
    )
  })
})

describe('isLocalPlainRelayUrl', () => {
  it('matches configured ws:// relay URLs that point at this Mac', () => {
    const interfaces = {
      en0: [iface('192.168.1.50')],
      utun4: [iface('100.99.131.73')]
    }

    expect(isLocalPlainRelayUrl('ws://100.99.131.73:8787', interfaces)).toBe(true)
    expect(isLocalPlainRelayUrl('ws://192.168.1.50:8787', interfaces)).toBe(true)
    expect(isLocalPlainRelayUrl('ws://localhost:8787', interfaces)).toBe(true)
  })

  it('matches local hostnames without treating remote relay URLs as local', () => {
    expect(isLocalPlainRelayUrl('ws://Chriss-Mac-Studio.local:8787', {}, 'Chriss-Mac-Studio')).toBe(
      true
    )
    expect(isLocalPlainRelayUrl('ws://relay.example.com:8787', {}, 'Chriss-Mac-Studio')).toBe(
      false
    )
    expect(isLocalPlainRelayUrl('wss://100.99.131.73:8787', { utun4: [iface('100.99.131.73')] })).toBe(
      false
    )
  })
})

describe('normalizeManualRelayUrl', () => {
  it('normalizes bare LAN or tailnet IPs to the embedded relay port', () => {
    expect(normalizeManualRelayUrl('100.99.131.73', 8787)).toBe('ws://100.99.131.73:8787')
    expect(normalizeManualRelayUrl('192.168.1.50:8787', 8788)).toBe(
      'ws://192.168.1.50:8787'
    )
  })

  it('defaults bare Tailscale DNS names to the wss front door', () => {
    expect(normalizeManualRelayUrl('studio.example.ts.net', 8787)).toBe(
      'wss://studio.example.ts.net'
    )
    expect(normalizeManualRelayUrl('studio.example.beta.tailscale.net.', 8787)).toBe(
      'wss://studio.example.beta.tailscale.net.'
    )
  })

  it('accepts explicit websocket/http schemes and strips path material', () => {
    expect(normalizeManualRelayUrl('https://studio.example.ts.net/path?x=1#frag', 8787)).toBe(
      'wss://studio.example.ts.net'
    )
    expect(normalizeManualRelayUrl('http://192.168.1.50:8787/status', 8788)).toBe(
      'ws://192.168.1.50:8787'
    )
  })

  it('rejects empty, malformed, or non-websocket relay values', () => {
    expect(normalizeManualRelayUrl('', 8787)).toBeNull()
    expect(normalizeManualRelayUrl('not a host', 8787)).toBeNull()
    expect(normalizeManualRelayUrl('file:///tmp/relay.sock', 8787)).toBeNull()
  })
})

describe('mergeRelayUrls', () => {
  it('dedupes candidates while preserving caller order', () => {
    expect(
      mergeRelayUrls(
        ['wss://studio.example.ts.net', 'ws://192.168.1.50:8787'],
        ['ws://192.168.1.50:8787', null, ' ws://100.99.131.73:8787 ']
      )
    ).toEqual([
      'wss://studio.example.ts.net',
      'ws://192.168.1.50:8787',
      'ws://100.99.131.73:8787'
    ])
  })
})
