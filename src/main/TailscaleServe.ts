/*
 * TailscaleServe — thin wrapper over `tailscale serve` so the app can put a
 * TLS front door on the embedded relay with one click.
 *
 * Why: the embedded relay is plain ws:// and iOS ATS only permits cleartext
 * to local-network hosts — so off-LAN (cellular) phones need wss://.
 * `tailscale serve` terminates HTTPS at tailscaled using the tailnet's
 * managed *.ts.net certificate and reverse-proxies (WebSocket-aware) to a
 * local port. The app then advertises wss://<dnsName> in the pairing QR
 * while the relay itself keeps listening on loopback.
 *
 * Scope: status / enable / disable for OUR proxy mapping only. `exec` is
 * injectable for tests; nothing here throws — failures come back as
 * { ok: false, message } with the CLI's own wording (it has good errors,
 * e.g. the "HTTPS is not enabled on this tailnet" guidance).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type ServeExec = (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ServeExec = async (cmd, args) => {
  const result = await execFileAsync(cmd, args, { timeout: 15_000 })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

export interface TailscaleServeStatus {
  /** True when an HTTPS handler proxies to 127.0.0.1:<port>. */
  configured: boolean
  /** MagicDNS host for the matching serve front door, when the CLI reports it. */
  dnsName?: string
  /** The HTTPS port the front door answers on (usually 443). */
  httpsPort?: number
  /** The proxy target found (diagnostic). */
  proxyTarget?: string
  /** Set when the status read itself failed. */
  error?: string
}

/** Narrow shape of `tailscale serve status --json` (a ServeConfig). */
interface ServeConfigRaw {
  TCP?: Record<string, unknown>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

function parseServeHostPort(hostPort: string): { host?: string; port?: number } {
  const trimmed = hostPort.trim()
  if (!trimmed) return {}
  const bracketed = trimmed.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) }
  const idx = trimmed.lastIndexOf(':')
  if (idx < 0) return { host: trimmed }
  const host = trimmed.slice(0, idx)
  const port = Number(trimmed.slice(idx + 1))
  return {
    host: host || undefined,
    port: Number.isInteger(port) && port > 0 ? port : undefined
  }
}

/** Does the current serve config already front our relay port? */
export async function getTailscaleServeStatus(input: {
  cliPath: string
  relayPort: number
  /** When set, only consider a handler on THIS front-door port — so a dev build
   * (:8443) and a release build (:443) each see/heal/tear-down only their own
   * mapping instead of fighting over one shared :443 handler. */
  httpsPort?: number
  exec?: ServeExec
}): Promise<TailscaleServeStatus> {
  const exec = input.exec ?? defaultExec
  let stdout: string
  try {
    ;({ stdout } = await exec(input.cliPath, ['serve', 'status', '--json']))
  } catch (err) {
    return { configured: false, error: err instanceof Error ? err.message : String(err) }
  }
  const trimmed = stdout.trim()
  // No serve config at all → CLI prints prose or an empty/null JSON.
  if (!trimmed || !trimmed.startsWith('{')) return { configured: false }
  let raw: ServeConfigRaw
  try {
    raw = JSON.parse(trimmed) as ServeConfigRaw
  } catch {
    return { configured: false, error: 'unparseable `tailscale serve status --json` output' }
  }
  for (const [hostPort, site] of Object.entries(raw.Web ?? {})) {
    const parsed = parseServeHostPort(hostPort)
    const frontDoorPort = parsed.port ?? 443
    // Scope to OUR front-door port (when given) so dev/release don't match each
    // other's handler — without this the loser keeps re-asserting serve to its
    // own relay port, clobbering the winner's :443 mapping in a ping-pong.
    if (input.httpsPort !== undefined && frontDoorPort !== input.httpsPort) continue
    for (const handler of Object.values(site?.Handlers ?? {})) {
      const proxy = handler?.Proxy ?? ''
      if (
        proxy === `http://127.0.0.1:${input.relayPort}` ||
        proxy === `http://localhost:${input.relayPort}` ||
        proxy === `127.0.0.1:${input.relayPort}`
      ) {
        return {
          configured: true,
          ...(parsed.host ? { dnsName: parsed.host } : {}),
          httpsPort: Number.isInteger(frontDoorPort) && frontDoorPort > 0 ? frontDoorPort : 443,
          proxyTarget: proxy
        }
      }
    }
  }
  return { configured: false }
}

export interface TailscaleServeResult {
  ok: boolean
  /** CLI output (stderr preferred — that's where guidance lands). */
  message?: string
}

/** Put the HTTPS front door up: https://<dnsName>:<httpsPort> → 127.0.0.1:<port>.
 * `--bg` persists the mapping across tailscaled restarts. `httpsPort` defaults to
 * 443 (the release front door); a dev build passes a DISTINCT port (e.g. 8443) so
 * the two builds get SEPARATE :443 / :8443 handlers on one machine instead of
 * clobbering the single shared mapping last-writer-wins (the tailnet cert covers
 * the MagicDNS name on any port, so :8443 needs no extra setup). */
export async function enableTailscaleServe(input: {
  cliPath: string
  relayPort: number
  httpsPort?: number
  exec?: ServeExec
}): Promise<TailscaleServeResult> {
  const exec = input.exec ?? defaultExec
  try {
    const { stdout, stderr } = await exec(input.cliPath, [
      'serve',
      '--bg',
      `--https=${input.httpsPort ?? 443}`,
      String(input.relayPort)
    ])
    return { ok: true, message: (stderr || stdout).trim() || undefined }
  } catch (err) {
    // execFile errors carry the CLI's stderr — surface it verbatim; the
    // common first-run failure is tailnet HTTPS certs not being enabled,
    // and the CLI's message includes the admin-console link to fix it.
    const anyErr = err as Error & { stderr?: string; stdout?: string }
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim()
    return { ok: false, message: detail }
  }
}

/** Take the front door down (our mapping only — `serve reset` would nuke
 * unrelated serve config the user might have). */
export async function disableTailscaleServe(input: {
  cliPath: string
  httpsPort?: number
  exec?: ServeExec
}): Promise<TailscaleServeResult> {
  const exec = input.exec ?? defaultExec
  try {
    const { stdout, stderr } = await exec(input.cliPath, [
      'serve',
      `--https=${input.httpsPort ?? 443}`,
      'off'
    ])
    return { ok: true, message: (stderr || stdout).trim() || undefined }
  } catch (err) {
    const anyErr = err as Error & { stderr?: string; stdout?: string }
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim()
    return { ok: false, message: detail }
  }
}
