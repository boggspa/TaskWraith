import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * TailscaleDetector — Phase E3 detection helper for the bridge daemon.
 *
 * Wraps the `tailscale status --json` CLI invocation so the main
 * process can surface a "is Tailscale available, and what's our
 * tailnet identity?" answer to the renderer. The detected IP is the
 * one a paired iPhone uses to reach the desktop from off-LAN
 * (CodexBridge already supports `quicTailscale` as a transport route).
 *
 * Scope: detection only. The actual daemon-side bind-on-tailnet-IP
 * lives in the Swift `TaskWraithBridgeDaemon` and isn't part of this
 * module. Once that ships, this module's output drives which IP the
 * daemon advertises.
 *
 * Behavior:
 *   - Looks for the `tailscale` CLI on PATH + a couple of known
 *     install locations (macOS GUI app, Homebrew, system).
 *   - If found, runs `tailscale status --json` with a short timeout.
 *   - Parses the result and returns a structured status.
 *   - Never throws; failures map to `available: false` with a reason.
 *
 * Result schema is stable across "Tailscale is installed but not
 * running" / "Tailscale is logged out" / "Tailscale is running and
 * we have an IP" cases so the renderer can branch cleanly.
 */

export interface TailscaleStatus {
  /** True when `tailscale status --json` succeeded AND a tailnet IP
   * is assigned to this machine. False for every "not yet ready" case. */
  available: boolean
  /** Path to the `tailscale` CLI binary, if discovered. */
  cliPath?: string
  /** The Tailscale CLI's reported version, if available. */
  version?: string
  /** The tailnet IPv4 address (e.g. 100.x.x.x). Undefined when
   * Tailscale isn't logged in or hasn't acquired an IP yet. */
  tailnetIPv4?: string
  /** The tailnet IPv6 address (fd7a:...), when present. */
  tailnetIPv6?: string
  /** The machine's tailscale hostname (e.g. "macbook"). */
  hostname?: string
  /** This machine's MagicDNS name WITHOUT the trailing dot
   * (e.g. "mac.tailnet.ts.net") — the hostname a
   * `tailscale serve` HTTPS front door answers on. */
  dnsName?: string
  /** The tailnet's DNS name (e.g. "tail-abc.ts.net"). */
  tailnetName?: string
  /** Magic DNS state — true when the tailnet has DNS resolution
   * enabled. Not strictly necessary for the bridge but a useful UX
   * signal ("you can reach this machine by hostname"). */
  magicDNSEnabled?: boolean
  /** A user-readable explanation when `available` is false. */
  reason?: string
}

const TAILSCALE_CLI_LOCATIONS = [
  // GUI app install on macOS — most common for end users.
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  // Homebrew on Apple Silicon.
  '/opt/homebrew/bin/tailscale',
  // Homebrew on Intel.
  '/usr/local/bin/tailscale',
  // System install.
  '/usr/bin/tailscale'
]

/** Result the CLI returns, narrowed to fields we use. The full schema
 * is much larger; we ignore everything else. */
interface TailscaleStatusRaw {
  Version?: string
  TailscaleIPs?: string[]
  Self?: {
    HostName?: string
    DNSName?: string
    TailscaleIPs?: string[]
  }
  MagicDNSSuffix?: string
  CurrentTailnet?: {
    Name?: string
    MagicDNSEnabled?: boolean
    MagicDNSSuffix?: string
  }
  BackendState?: string
}

export interface DetectTailscaleOptions {
  /** Override the timeout for the CLI invocation. Default 3 seconds —
   * `tailscale status` is normally instant; a slow response usually
   * means the daemon isn't running. */
  timeoutMs?: number
  /** Inject a custom `execFile` for tests. */
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  /** Inject the CLI lookup for tests. Pass an explicit path to skip
   * the filesystem probe and the PATH search. Pass `null` to force
   * "not found". */
  cliPath?: string | null
  /** Inject known-location existence checks for tests. */
  existsFn?: (path: string) => boolean
  /** Inject PATH lookup for tests. */
  whichFn?: (name: string) => Promise<string | null>
  /** Number of extra status attempts after the first one. Default 3
   * because the macOS GUI helper can briefly reject status requests
   * while the Network Extension is waking up. */
  statusRetries?: number
  /** Delay between status attempts. Default 750ms. */
  retryDelayMs?: number
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>
}

type StatusProbeResult =
  | { ok: true; raw: TailscaleStatusRaw }
  | { ok: false; reason: string }

const DEFAULT_STATUS_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 750
const STATUS_ARGS = ['status', '--json', '--peers=false']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeTailscaleStatus(
  cliPath: string,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): Promise<StatusProbeResult> {
  try {
    const { stdout, stderr } = await exec(cliPath, STATUS_ARGS)
    // The CLI returns a human-readable message (e.g. "The Tailscale
    // daemon is not running. Run 'sudo tailscale up'…") instead of
    // JSON when the daemon isn't ready. Detect that shape and surface
    // the message verbatim rather than vomiting "Unexpected token 'T'"
    // at the user. Only fall through to JSON.parse when the stdout
    // actually looks like a JSON object.
    const trimmedStdout = stdout.trim()
    if (!trimmedStdout.startsWith('{')) {
      const diagnostic = trimmedStdout || stderr.trim()
      const firstLine = diagnostic.split('\n')[0].slice(0, 240)
      return {
        ok: false,
        reason: firstLine || 'Tailscale CLI returned no status output.'
      }
    }
    try {
      return { ok: true, raw: JSON.parse(stdout) as TailscaleStatusRaw }
    } catch (parseErr) {
      // Reached only when stdout starts with `{` but isn't valid JSON
      // — genuinely malformed CLI output, worth flagging as a parse
      // problem rather than a daemon-state problem.
      return {
        ok: false,
        reason: `Tailscale status JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      }
    }
  } catch (err) {
    const anyErr = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: unknown }
    const stderr = anyErr.stderr != null ? String(anyErr.stderr).trim() : ''
    const stdout = anyErr.stdout != null ? String(anyErr.stdout).trim() : ''
    const baseMessage = err instanceof Error ? err.message : String(err)
    const code =
      anyErr.code !== undefined && anyErr.code !== null && String(anyErr.code).trim()
        ? `exit ${String(anyErr.code)}`
        : ''
    const detail = (stderr || stdout || baseMessage || code).split('\n')[0].slice(0, 360)
    const suffix = code && !detail.includes(code) ? ` (${code})` : ''
    return {
      ok: false,
      reason: `Tailscale CLI invocation failed: ${detail}${suffix}`
    }
  }
}

async function probeTailscaleStatusWithRetry(
  cliPath: string,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  options: Pick<DetectTailscaleOptions, 'statusRetries' | 'retryDelayMs' | 'sleep'>
): Promise<StatusProbeResult> {
  const retries = Math.max(0, options.statusRetries ?? DEFAULT_STATUS_RETRIES)
  const attempts = retries + 1
  const delayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  const sleepFn = options.sleep ?? sleep
  let lastResult: StatusProbeResult | undefined

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = await probeTailscaleStatus(cliPath, exec)
    if (lastResult.ok) {
      return lastResult
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await sleepFn(delayMs)
    }
  }

  return lastResult ?? { ok: false, reason: 'Tailscale CLI returned no status output.' }
}

async function findTailscaleOnPath(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): Promise<string | null> {
  try {
    const { stdout } = await exec('/usr/bin/env', ['sh', '-lc', 'command -v tailscale'])
    const first = stdout.trim().split('\n')[0]?.trim()
    return first || null
  } catch {
    return null
  }
}

export async function detectTailscale(
  options: DetectTailscaleOptions = {}
): Promise<TailscaleStatus> {
  const exec =
    options.execFn ??
    (async (cmd: string, args: string[]) => {
      const result = await execFileAsync(cmd, args, { timeout: options.timeoutMs ?? 3000 })
      return { stdout: String(result.stdout), stderr: String(result.stderr) }
    })

  // CLI discovery. Prefer an explicit app-bundled binary on macOS because the
  // GUI install usually does NOT put `tailscale` on PATH. Then fall back to
  // Homebrew/system locations and PATH for standalone/package installs.
  let cliPath: string | undefined
  if (options.cliPath === null) {
    return { available: false, reason: 'Tailscale CLI not found (override)' }
  } else if (typeof options.cliPath === 'string') {
    cliPath = options.cliPath
  } else {
    const exists = options.existsFn ?? existsSync
    cliPath = TAILSCALE_CLI_LOCATIONS.find((path) => exists(path))
    if (!cliPath) {
      cliPath =
        (await (options.whichFn ?? ((_name: string) => findTailscaleOnPath(exec)))('tailscale')) ??
        undefined
    }
  }
  if (!cliPath) {
    return {
      available: false,
      reason:
        'Tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and connect to your tailnet to enable off-LAN bridge access.'
    }
  }

  // Run `tailscale status --json`. The macOS GUI app can briefly
  // reject CLI probes while its helper/Network Extension wakes up, so
  // retry once before declaring the installed app unavailable.
  const statusProbe = await probeTailscaleStatusWithRetry(cliPath, exec, options)
  if (!statusProbe.ok) {
    return {
      available: false,
      cliPath,
      reason: statusProbe.reason
    }
  }
  const raw = statusProbe.raw

  // Parse the relevant fields.
  const version = typeof raw.Version === 'string' ? raw.Version : undefined
  const selfIPs = raw.Self?.TailscaleIPs ?? raw.TailscaleIPs ?? []
  const tailnetIPv4 = selfIPs.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
  const tailnetIPv6 = selfIPs.find((ip) => /:/.test(ip))
  const hostname = raw.Self?.HostName
  // Tailscale reports DNSName with a trailing dot ("host.tail-abc.ts.net.").
  const dnsName = raw.Self?.DNSName?.replace(/\.$/, '') || undefined
  const tailnetName = raw.CurrentTailnet?.Name
  const magicDNSEnabled = raw.CurrentTailnet?.MagicDNSEnabled

  // The BackendState field reports daemon health — "Running" with a
  // tailnet IP is the only "ready" combination.
  if (!tailnetIPv4 && !tailnetIPv6) {
    return {
      available: false,
      cliPath,
      version,
      hostname,
      tailnetName,
      magicDNSEnabled,
      reason:
        raw.BackendState === 'NeedsLogin'
          ? 'Tailscale is installed but not logged in. Open Tailscale and sign in to your tailnet.'
          : raw.BackendState === 'Stopped'
            ? 'Tailscale is installed but currently stopped. Open Tailscale and connect.'
            : `Tailscale is installed but not connected (state=${raw.BackendState ?? 'unknown'}).`
    }
  }

  return {
    available: true,
    cliPath,
    version,
    tailnetIPv4,
    tailnetIPv6,
    hostname,
    dnsName,
    tailnetName,
    magicDNSEnabled
  }
}
