/*
 * LocalServersService — polls for dev servers running under the user's
 * workspaces and broadcasts snapshots to the renderer. Mirrors the
 * poll+broadcast shape of UpdateService (subscribe / snapshot / publish /
 * setInterval). Detection is delegated to a platform detector; stop actions
 * land in Phase B.
 */

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

/** Servers are long-lived; a 5s cadence is plenty and cheap. */
export const LOCAL_SERVERS_POLL_INTERVAL_MS = 5_000

type Listener = (snapshot: LocalServersSnapshot) => void

export interface LocalServersServiceOptions {
  getWorkspaces: () => LocalServerWorkspace[]
  /** Processes TaskWraith spawned (Phase C). Defaults to none. */
  getTracked?: () => TrackedSpawn[]
  getDeclaredServices?: () => DeclaredLocalService[]
  platform?: NodeJS.Platform
  detector?: LocalServerDetector
  log?: (line: string) => void
  pollIntervalMs?: number
  /** Injectable for tests; defaults to a platform-appropriate kill controller. */
  createController?: (pid: number, pgid?: number) => KillController
}

export class LocalServersService {
  private detector: LocalServerDetector
  private getWorkspaces: () => LocalServerWorkspace[]
  private getTracked: () => TrackedSpawn[]
  private getDeclaredServices: () => DeclaredLocalService[]
  private log: (line: string) => void
  private pollIntervalMs: number
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
    this.log = options.log ?? (() => {})
    this.pollIntervalMs = options.pollIntervalMs ?? LOCAL_SERVERS_POLL_INTERVAL_MS
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
    this.timer = setInterval(() => {
      void this.refreshNow()
    }, this.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
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
      const declaredServices = decorateDeclaredServices(
        this.getDeclaredServices(),
        next.servers
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
    .map((service) => `${service.id}:${service.status}:${service.ports.join(',')}`)
    .sort()
    .join('|')
  return `${runningSignature}#${declaredSignature}`
}

function decorateDeclaredServices(
  services: DeclaredLocalService[],
  servers: LocalServerEntry[]
): DeclaredLocalService[] {
  const runningPorts = new Set(servers.flatMap((server) => server.ports))
  return services.map((service) => ({
    ...service,
    status: service.ports.some((port) => runningPorts.has(port)) ? 'running' : 'unknown'
  }))
}
