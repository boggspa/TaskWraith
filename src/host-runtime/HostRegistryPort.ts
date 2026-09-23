/**
 * Machine-wide Host registry port (Host-lifetime programme, S1a/S1b contract).
 *
 * The production Host publishes one entry describing itself after its
 * discovery file is live, refreshes the entry's counters on a slow awake-time
 * cadence, re-reads it on the same cadence as a self-check, and removes it
 * during cleanup before the profile authority lease is released. The
 * publisher (`HostRegistry.ts`, S1b) owns the file format, the root
 * (`~/.taskwraith/hosts`, overridable by `TASKWRAITH_HOST_REGISTRY_ROOT`), the
 * birth identity, the CLI/executable paths and the `writtenAt`/`beatSeq`
 * stamps; this module is types only so the two slices can land in either
 * order. Until a publisher is wired the production server treats the port as
 * absent and publishes nothing.
 */

import type { HostLifetimePhase } from '../shared/hostProtocol'

/** What the Host itself knows when it publishes; the publisher adds the rest. */
export interface HostRegistryEntryInput {
  readonly profilePath: string
  readonly pid: number
  /** Listener start, ISO-8601 — the same instant the discovery file carries. */
  readonly startedAt: string
  readonly hostId: string
  readonly bootEpoch?: string
  readonly payloadVersion?: string
  readonly socketPath?: string
  readonly discoveryPath?: string
  /** `TASKWRAITH_HOST_PERSIST=1`, so a lingering Host explains itself. */
  readonly persist: boolean
  readonly leaseMode: 'lease'
  readonly holders: number
  readonly implicitHolders: number
  readonly lifetimePhase: HostLifetimePhase
}

/** The counters refreshed on every registry tick. */
export interface HostRegistryEntryRefresh {
  readonly holders: number
  readonly implicitHolders: number
  readonly lifetimePhase: HostLifetimePhase
}

/**
 * Self-check verdicts. `missing` (ENOENT) and `foreign` (readable, but the
 * pid, birth identity or boot epoch name another process) are the two that
 * may stop the Host — and only on two consecutive checks. `unreadable` (EIO,
 * EACCES, malformed) never stops it: a flaky disk or a rename race must not
 * take a healthy Host down.
 */
export type HostRegistryCheckResult = 'present' | 'missing' | 'foreign' | 'unreadable'

export interface HostRegistryPublisherPort {
  /** Called once, after the discovery file is published. */
  publish(entry: HostRegistryEntryInput): void
  /** Called every registry refresh interval of awake time. */
  refresh(patch: HostRegistryEntryRefresh): void
  /** Called on the same cadence as `refresh`, after it. */
  check(): HostRegistryCheckResult
  /** Called during cleanup, before the profile authority lease is released. */
  remove(): void
}
