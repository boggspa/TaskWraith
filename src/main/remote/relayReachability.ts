/*
 * relayReachability — "never advertise a dead front door."
 *
 * The pairing QR/bootstrap tells the PHONE where to dial (advertiseRelayUrl);
 * the Mac itself talks to the embedded relay over loopback, so nothing on the
 * Mac side notices when the advertised origin isn't actually answering (e.g.
 * `tailscale serve` was never enabled, got reset, or proxies the wrong port).
 * The observed failure mode is the worst kind: pairing UI looks perfect, the
 * phone gets NSURLError -1004 "Could not connect to the server."
 *
 * This module dials the advertised origin the way the phone would (TLS for
 * wss://, plain HTTP for ws://) and reports whether the RELAY answered. Most
 * HTTP statuses — 404 included — count as reachable: we are proving a relay
 * listener exists at the origin, not probing application health (the relay
 * only speaks WebSocket upgrades on its session paths anyway).
 *
 * The ONE exception is a GATEWAY error (502 Bad Gateway / 504 Gateway Timeout):
 * `tailscale serve` terminates TLS itself, so when its loopback relay target is
 * dead (never bound, crashed, or pointed at the wrong port) the front door
 * still answers — with a 502 — and the phone's WS UPGRADE through it returns
 * 502 instead of 101, surfacing as NSURLErrorBadServerResponse ("bad response
 * from the server"). The relay process never authors 502/504 (it speaks
 * 200/404/405/503 + WS upgrades), so those two statuses mean "serve is up but
 * the relay behind it is down" — a dead door that must NOT be advertised. 503
 * (the relay's own at-capacity reply) means the relay IS up, so it stays
 * reachable.
 *
 * The Mac can meaningfully dial its own Tailscale front door because it is a
 * tailnet member too; a TLS round-trip that returns a NON-gateway status proves
 * serve termination AND that the relay behind the proxy actually answered.
 *
 * `request` is injectable so tests never open sockets.
 */

import http from 'node:http'
import https from 'node:https'

export interface RelayProbeResult {
  reachable: boolean
  /** Failure detail (error code/message) or the HTTP status that answered. */
  detail: string
}

export type RelayProbeRequest = (
  url: URL,
  timeoutMs: number
) => Promise<{ statusCode: number | null }>

const defaultRequest: RelayProbeRequest = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      { method: 'GET', timeout: timeoutMs },
      (res) => {
        // Drain so the socket can close cleanly; the status alone is the answer.
        res.resume()
        resolve({ statusCode: res.statusCode ?? null })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    req.end()
  })

/** Map a relay ws(s):// origin to the http(s):// URL the probe dials. */
export function probeUrlForRelay(relayUrl: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return null
  }
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else return null
  parsed.pathname = '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

export interface AdvertisableRelaySelection {
  /** Candidates that answered, in the caller's preference order. */
  advertisable: string[]
  /** One line per dropped candidate — surfaced on the pairing page. */
  warnings: string[]
}

/**
 * Probe an ordered candidate list (LAN first, wss front door second) and
 * keep only the doors that answer FROM THE MAC. The LAN probe proves the
 * relay process is up; the wss probe proves serve termination + proxy
 * wiring end-to-end (the Mac is a tailnet member, so dialing its own front
 * door exercises the same path a remote phone uses). Phone-side
 * reachability (is the phone actually on that Wi-Fi / tailnet?) is the
 * phone's candidate walk — this filter only removes doors that are dead
 * for EVERYONE, with a warning the pairing page shows per drop.
 */
export async function selectAdvertisableRelayUrls(
  candidates: string[],
  options: { timeoutMs?: number; probe?: typeof probeRelayFrontDoor } = {}
): Promise<AdvertisableRelaySelection> {
  const probe = options.probe ?? probeRelayFrontDoor
  const advertisable: string[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    const result = await probe(candidate, { timeoutMs: options.timeoutMs })
    if (result.reachable) {
      advertisable.push(candidate)
    } else {
      warnings.push(`${candidate} isn't answering (${result.detail})`)
    }
  }
  return { advertisable, warnings }
}

/**
 * Dial the advertised relay origin once. Reachable = any HTTP response.
 * Unreachable carries the dial failure verbatim (ECONNREFUSED, timeout,
 * ENOTFOUND, TLS alert, …) so the pairing surface can show the real reason.
 */
export async function probeRelayFrontDoor(
  relayUrl: string,
  options: { timeoutMs?: number; request?: RelayProbeRequest } = {}
): Promise<RelayProbeResult> {
  const probeUrl = probeUrlForRelay(relayUrl)
  if (!probeUrl) {
    return { reachable: false, detail: `not a ws:// or wss:// URL: ${relayUrl}` }
  }
  const timeoutMs = options.timeoutMs ?? 3_000
  const request = options.request ?? defaultRequest
  try {
    const { statusCode } = await request(probeUrl, timeoutMs)
    // 502/504 = a `tailscale serve` (or other reverse-proxy) front door that
    // answered TLS but whose backend relay is dead. The relay never authors
    // these — so the door is alive, the relay is NOT, and advertising it would
    // hand the phone a 502 on its WS upgrade (NSURLErrorBadServerResponse). Drop
    // it. 503 stays reachable: that's the relay's OWN at-capacity reply (alive).
    if (statusCode === 502 || statusCode === 504) {
      return {
        reachable: false,
        detail: `HTTP ${statusCode} from ${probeUrl.host} — its relay is down (serve front door is up, but nothing is answering behind it)`
      }
    }
    return { reachable: true, detail: `HTTP ${statusCode ?? '?'} from ${probeUrl.host}` }
  } catch (err) {
    const anyErr = err as Error & { code?: string }
    const detail = anyErr.code ? `${anyErr.code}: ${anyErr.message}` : anyErr.message || String(err)
    return { reachable: false, detail }
  }
}
