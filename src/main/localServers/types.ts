/*
 * Local Servers — shared types.
 *
 * The feature detects long-running dev servers / watchers that agents (or
 * the user) start inside a registered workspace, surfaces them, and lets the
 * user stop them. See `LocalServersService` + the platform detectors.
 */

import type { TaskWraithPluginResourceProvenance } from '../../shared/plugins/PluginTypes'

/** A raw process row from platform detection, before workspace matching. */
export interface ProcessSnapshotRow {
  pid: number
  ppid?: number
  /** Full command line (argv) where the platform can supply it. */
  command: string
  /** Resolved working directory, when the platform can supply it. */
  cwd?: string
  /** Listening TCP ports owned by this pid. */
  ports: number[]
  rssBytes?: number
}

/** Whether TaskWraith's own agents spawned this server, or we merely detected it. */
export type LocalServerOrigin = 'agent-spawned' | 'detected'

/** A surfaced local-server entry (after workspace match / attribution). */
export interface LocalServerEntry {
  /** Stable id for React keys / IPC — the pid as a string. */
  id: string
  pid: number
  ppid?: number
  /** Human label derived from the command, e.g. "next dev", "vite". */
  name: string
  command: string
  ports: number[]
  primaryPort?: number
  cwd?: string
  workspaceId?: string
  workspacePath?: string
  workspaceName?: string
  origin: LocalServerOrigin
  rssBytes?: number
  /** Process group id (from a tracked ancestor) — enables clean group-kill. */
  pgid?: number
  // Attribution (Phase C) — present when origin === 'agent-spawned'.
  chatId?: string
  runId?: string
  provider?: string
  /** ISO timestamp when TaskWraith spawned it (tracked spawns only). */
  startedAt?: string
}

export interface DeclaredLocalService {
  id: string
  label: string
  description?: string
  ports: number[]
  healthCheck?: {
    url?: string
    commandHint?: string
  }
  launchTargetHints?: string[]
  managedByTaskWraith: boolean
  pluginProvenance?: TaskWraithPluginResourceProvenance
  status: 'unknown' | 'running'
}

export interface LocalServersSnapshot {
  sampledAt: string
  servers: LocalServerEntry[]
  declaredServices?: DeclaredLocalService[]
  platform: NodeJS.Platform
  /**
   * False when the platform detector can't enumerate (e.g. `lsof` missing,
   * or Windows where process cwd is unavailable). The UI still shows tracked
   * agent spawns; absence of detected servers is not "none running".
   */
  detectionAvailable: boolean
}

/** A process TaskWraith itself spawned — for attribution + clean reaping (Phase C). */
export interface TrackedSpawn {
  pid: number
  /** Process-group id when spawned detached; enables group-kill. */
  pgid?: number
  workspacePath?: string
  chatId?: string
  runId?: string
  provider?: string
  /** ISO timestamp. */
  startedAt: string
}

/** Minimal workspace shape the detector needs (subset of WorkspaceRecord). */
export interface LocalServerWorkspace {
  id: string
  path: string
  displayName?: string
}

export interface LocalServerDetectorContext {
  workspaces: LocalServerWorkspace[]
  /** Processes TaskWraith spawned (Phase C); surfaced even without a cwd match. */
  tracked?: TrackedSpawn[]
}

export interface LocalServerDetector {
  readonly platform: NodeJS.Platform
  detect(ctx: LocalServerDetectorContext): Promise<LocalServersSnapshot>
}
