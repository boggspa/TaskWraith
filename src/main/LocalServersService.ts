/*
 * LocalServersService — polls for dev servers running under the user's
 * workspaces and broadcasts snapshots to the renderer. Mirrors the
 * poll+broadcast shape of UpdateService (subscribe / snapshot / publish /
 * setInterval). Detection is delegated to a platform detector; stop actions
 * land in Phase B.
 */

import * as http from 'http'
import * as https from 'https'
import { createDetectorForPlatform } from './localServers/detector'
import {
  createUnixKillController,
  createWindowsKillController,
  escalateKill,
  type KillController
} from './localServers/killer'
import type {
  DeclaredLocalService,
  LocalServerDetector,
  LocalServerEntry,
  LocalServersSnapshot,
  LocalServerWorkspace,
  TrackedSpawn
} from './localServers/types'

/** Servers are long-lived; a 5s cadence is plenty and cheap while the window
 * is active. Hidden/blurred/minimized windows drop to the inactive cadence:
 * every tick spawns lsof (plus a full ps when listeners exist), which is pure
 * battery/CPU-wakeup drain when nobody can see the panel. No remote/iOS
 * surface consumes this feed (verified 2026-07-10); on-demand callers use
 * snapshot()/refreshNow() and stay fresh regardless of cadence. */
export const LOCAL_SERVERS_POLL_INTERVAL_MS = 5_000
export const LOCAL_SERVERS_INACTIVE_POLL_INTERVAL_MS = 60_000
const DECLARED_SERVICE_HEALTH_TIMEOUT_MS = 750

type Listener = (snapshot: LocalServersSnapshot) => void
type DeclaredServiceHealthProbe = (service: DeclaredLocalService) => Promise<boolean>

export interface LocalServersServiceOptions {
  getWorkspaces: () => LocalServerWorkspace[]
  /** Processes TaskWraith spawned (Phase C). Defaults to none. */
  getTracked?: () => TrackedSpawn[]
  getDeclaredServices?: () => DeclaredLocalService[]
  probeDeclaredServiceHealth?: DeclaredServiceHealthProbe
  platform?: NodeJS.Platform
  detector?: LocalServerDetector
  log?: (line: string) => void
  pollIntervalMs?: number
  inactivePollIntervalMs?: number
  /** Injectable for tests; defaults to a platform-appropriate kill controller. */
  createController?: (pid: number, pgid?: number) => KillController
}

export class LocalServersService {
  private detector: LocalServerDetector
  private getWorkspaces: () => LocalServerWorkspace[]
  private getTracked: () => TrackedSpawn[]
  private getDeclaredServices: () => DeclaredLocalService[]
  private probeDeclaredServiceHealth: DeclaredServiceHealthProbe
  private log: (line: string) => void
  private pollIntervalMs: number
  private inactivePollIntervalMs: number
  private windowActive = true
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private current: LocalServersSnapshot
  private lastSignature = ''
  private sampling = false
  private createController: (pid: number, pgid?: number) => KillController

  constructor(options: LocalServersServiceOptions) {
    const platform = options.platform || process.platform
    this.detector = options.detector || createDetectorForPlatform(platform)
    this.getWorkspaces = options.getWorkspaces
    this.getTracked = options.getTracked || (() => [])
    this.getDeclaredServices = options.getDeclaredServices || (() => [])
    this.probeDeclaredServiceHealth =
      options.probeDeclaredServiceHealth || probeDeclaredLocalServiceHealth
    this.log = options.log ?? (() => {})
    this.pollIntervalMs = options.pollIntervalMs ?? LOCAL_SERVERS_POLL_INTERVAL_MS
    this.inactivePollIntervalMs =
      options.inactivePollIntervalMs ?? LOCAL_SERVERS_INACTIVE_POLL_INTERVAL_MS
    this.createController =
      options.createController ||
      ((pid, pgid) =>
        platform === 'win32'
          ? createWindowsKillController(pid)
          : createUnixKillController(pid, pgid))
    this.current = {
      sampledAt: new Date().toISOString(),
      servers: [],
      platform,
      detectionAvailable: true
    }
  }

  snapshot(): LocalServersSnapshot {
    return this.current
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Begin periodic sampling. Immediately samples once, then on an interval. */
  start(): void {
    if (this.timer) return
    void this.refreshNow()
    this.armTimer()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Swap cadence with window focus/visibility (AppShellStatsService
   * pattern). Returning to active refreshes immediately so the panel is
   * fresh the moment the user could be looking at it. */
  setWindowActive(active: boolean): void {
    if (this.windowActive === active) return
    this.windowActive = active
    if (!this.timer) return
    this.armTimer()
    if (active) void this.refreshNow()
  }

  private armTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.refreshNow()
    }, this.windowActive ? this.pollIntervalMs : this.inactivePollIntervalMs)
  }

  /** Sample once now. Publishes only when the server set changed (or first). */
  async refreshNow(): Promise<LocalServersSnapshot> {
    if (this.sampling) return this.current
    this.sampling = true
    try {
      const next = await this.detector.detect({
        workspaces: this.getWorkspaces(),
        tracked: this.getTracked()
      })
      const declaredServices = await decorateDeclaredServices(
        this.getDeclaredServices(),
        next.servers,
        this.probeDeclaredServiceHealth
      )
      if (declaredServices.length > 0) next.declaredServices = declaredServices
      const signature = signatureOf(next.servers, next.declaredServices || [])
      const changed = signature !== this.lastSignature
      this.current = next
      if (changed) {
        this.lastSignature = signature
        this.publish()
      }
      return next
    } catch (err) {
      // Keep the prior snapshot on failure (don't flap to empty).
      this.log(
        `[LocalServersService] detect failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return this.current
    } finally {
      this.sampling = false
    }
  }

  /**
   * Stop one surfaced server. SAFETY: only acts on a pid present in the current
   * snapshot (i.e. workspace-scoped or tracked) — there is no path to signal an
   * arbitrary pid. Re-samples after.
   */
  async stopServer(pid: number): Promise<{ ok: boolean }> {
    const ok = await this.killOne(pid)
    await this.refreshNow()
    return { ok }
  }

  /** Stop every server in the current snapshot. */
  async stopAll(): Promise<{ stopped: number }> {
    const pids = this.current.servers.map((s) => s.pid)
    let stopped = 0
    for (const pid of pids) {
      if (await this.killOne(pid)) stopped += 1
    }
    await this.refreshNow()
    return { stopped }
  }

  private async killOne(pid: number): Promise<boolean> {
    // Guard: never signal a pid we aren't currently surfacing.
    const entry = this.current.servers.find((s) => s.pid === pid)
    if (!entry) return false
    const controller = this.createController(pid, entry.pgid)
    try {
      const result = await escalateKill(controller)
      return result.ok
    } catch (err) {
      this.log(
        `[LocalServersService] stop ${pid} failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }

  private publish(): void {
    const snap = this.current
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch (err) {
        this.log(
          `[LocalServersService] listener threw: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}

/** Stable signature of the surfaced set so we only broadcast on real change. */
function signatureOf(
  servers: LocalServerEntry[],
  declaredServices: DeclaredLocalService[] = []
): string {
  const runningSignature = servers
    .map((s) => `${s.pid}:${s.ports.join(',')}:${s.origin}`)
    .sort()
    .join('|')
  const declaredSignature = declaredServices
    .map(
      (service) =>
        `${service.id}:${service.status}:${service.ports.join(',')}:${service.healthCheck?.url || ''}:${service.healthCheck?.commandHint || ''}:${(service.launchTargetHints || []).join(',')}`
    )
    .sort()
    .join('|')
  return `${runningSignature}#${declaredSignature}`
}

async function decorateDeclaredServices(
  services: DeclaredLocalService[],
  servers: LocalServerEntry[],
  probeHealth: DeclaredServiceHealthProbe
): Promise<DeclaredLocalService[]> {
  const runningPorts = new Set(servers.flatMap((server) => server.ports))
  return Promise.all(
    services.map(async (service) => {
      const portRunning = service.ports.some((port) => runningPorts.has(port))
      const healthRunning = portRunning ? false : await probeHealth(service).catch(() => false)
      return {
        ...service,
        status: portRunning || healthRunning ? 'running' : 'unknown'
      }
    })
  )
}

export async function probeDeclaredLocalServiceHealth(
  service: DeclaredLocalService
): Promise<boolean> {
  const rawUrl = service.healthCheck?.url?.trim()
  if (!rawUrl) return false
  const resolvedUrl = rawUrl.replace(/<port>/g, String(service.ports[0] ?? ''))
  let url: URL
  try {
    url = new URL(resolvedUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!isLoopbackHost(url.hostname)) return false
  return requestHealth(url)
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  )
}

function requestHealth(url: URL): Promise<boolean> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const req = client.request(url, { method: 'GET' }, (res) => {
      res.resume()
      finish((res.statusCode || 0) < 500)
    })
    req.setTimeout(DECLARED_SERVICE_HEALTH_TIMEOUT_MS, () => {
      req.destroy()
      finish(false)
    })
    req.on('error', () => finish(false))
    req.end()
  })
}
