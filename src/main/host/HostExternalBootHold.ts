/**
 * Holds an external Host across Electron main's boot (Host-lifetime programme,
 * S1a review F2; per profile and released by main's lease since S2).
 *
 * A Host with no holder runs its last-lease grace (45 s of awake time) and
 * then exits. The supervisor's readiness probe used to close as soon as it saw
 * a welcome, before `import('./index')`, and main's own lease socket cannot
 * finish its handshake until main's synchronous start-up yields to I/O. On a
 * slow or loaded boot that gap outlasts the grace: the Host exits idle while
 * the app is still starting, main finds nothing, and nothing relaunches the
 * Host for that session.
 *
 * So the spawner keeps its authenticated probe connection open — an implicit
 * holder, which never lapses — from readiness until main's own lease is held,
 * and only then lets it go. The release is main's explicit lease acquire
 * (`HostLeaseReasons` calls `releaseExternalHostBootHold` when its lease
 * client reports `held`, or `legacy` for a Host that predates leases and has
 * no grace to outlast). Main's broker sockets decline the lease, so their
 * connect no longer counts. The supervisor's own close releases its hold too
 * (teardown, an explicit stop, a failed preparation), and so does the process
 * exit, which closes the socket.
 *
 * Holds are kept per canonical profile path: a supervisor for another profile
 * replaces nothing here, and a lease on one profile lets go of that profile's
 * hold only. The hands-off is process-wide within a profile because the two
 * ends never meet: the supervisor runs in the bootstrap, the lease in the
 * dynamically imported main graph.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** The held connection: an authenticated client, closed exactly once. */
export interface HostExternalHeldConnection {
  close(): void
}

interface Hold {
  readonly owner: object
  readonly connection: HostExternalHeldConnection
}

const holds = new Map<string, Hold>()

function profileKey(profilePath: string): string {
  const absolute = resolve(profilePath)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function closeQuietly(connection: HostExternalHeldConnection): void {
  try {
    connection.close()
  } catch {
    // Best effort: a connection that cannot close is already gone.
  }
}

/**
 * Keep `connection` open for `owner` until main's lease on `profilePath` is
 * held. Replaces an earlier hold for the same profile only.
 */
export function holdExternalHostForBoot(
  profilePath: string,
  owner: object,
  connection: HostExternalHeldConnection
): void {
  const key = profileKey(profilePath)
  const previous = holds.get(key)
  holds.set(key, { owner, connection })
  if (previous && previous.connection !== connection) closeQuietly(previous.connection)
}

/**
 * Let `profilePath`'s hold go. With `owner`, only that owner's hold (a
 * supervisor closing itself); without, whichever hold that profile has (main's
 * lease is held). Returns whether a hold was released.
 */
export function releaseExternalHostBootHold(profilePath: string, owner?: object): boolean {
  const key = profileKey(profilePath)
  const held = holds.get(key)
  if (!held || (owner !== undefined && held.owner !== owner)) return false
  holds.delete(key)
  closeQuietly(held.connection)
  return true
}

/** Whether a boot hold is open for `profilePath`, or for any profile (diagnostics and tests). */
export function hasExternalHostBootHold(profilePath?: string): boolean {
  return profilePath === undefined ? holds.size > 0 : holds.has(profileKey(profilePath))
}

/** Test teardown: close and forget every hold. */
export function releaseAllExternalHostBootHolds(): void {
  for (const [key, held] of [...holds]) {
    holds.delete(key)
    closeQuietly(held.connection)
  }
}
