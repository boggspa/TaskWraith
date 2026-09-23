/**
 * Holds an external Host across Electron main's boot (Host-lifetime programme,
 * S1a review F2).
 *
 * A Host with no holder runs its last-lease grace (45 s of awake time) and
 * then exits. The supervisor's readiness probe used to close as soon as it saw
 * a welcome, before `import('./index')`, and main's own first socket cannot
 * finish its handshake until main's synchronous start-up yields to I/O. On a
 * slow or loaded boot that gap outlasts the grace: the Host exits idle while
 * the app is still starting, main's broker then finds nothing, and nothing
 * relaunches the Host for that session.
 *
 * So the spawner keeps its authenticated probe connection open — an implicit
 * holder, which never lapses — from readiness until main's own lasting client
 * has authenticated, and only then lets it go. The hands-off is process-wide
 * because the two ends never meet: the supervisor runs in the bootstrap, the
 * broker in the dynamically imported main graph. Main's brokers are all
 * lasting clients, so the first one to authenticate releases the hold. The
 * supervisor's own close releases it too (teardown, an explicit stop, a failed
 * preparation), and so does the process exit, which closes the socket.
 *
 * S2 moves the release onto main's explicit lease client.
 */

/** The held connection: an authenticated client, closed exactly once. */
export interface HostExternalHeldConnection {
  close(): void
}

let held: { readonly owner: object; readonly connection: HostExternalHeldConnection } | null = null

function closeQuietly(connection: HostExternalHeldConnection): void {
  try {
    connection.close()
  } catch {
    // Best effort: a connection that cannot close is already gone.
  }
}

/** Keep `connection` open for `owner` until main's client authenticates. Replaces any earlier hold. */
export function holdExternalHostForBoot(
  owner: object,
  connection: HostExternalHeldConnection
): void {
  const previous = held
  held = { owner, connection }
  if (previous && previous.connection !== connection) closeQuietly(previous.connection)
}

/**
 * Let the hold go. With `owner`, only that owner's hold (a supervisor closing
 * itself); without, whichever hold there is (main's client authenticated).
 * Returns whether a hold was released.
 */
export function releaseExternalHostBootHold(owner?: object): boolean {
  if (!held || (owner !== undefined && held.owner !== owner)) return false
  const { connection } = held
  held = null
  closeQuietly(connection)
  return true
}

/** Whether a boot hold is currently open (diagnostics and tests). */
export function hasExternalHostBootHold(): boolean {
  return held !== null
}
