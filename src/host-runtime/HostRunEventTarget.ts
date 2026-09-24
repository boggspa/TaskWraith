/**
 * Transport-neutral identity for the party that initiated a Host run.
 *
 * The Host runtime treats this as an opaque callback target. Electron's
 * WebContents, a local socket client, and a future paired-device connection
 * can all carry their own delivery mechanics outside the dispatch boundary.
 */
export interface HostRunEventTarget {
  /** Optional transport-local identifier for diagnostics and correlation. */
  readonly id?: string | number
}

/**
 * Minimal event shape required by Host run orchestration.
 *
 * Desktop IPC events are supersets. Host-fed callers can construct this
 * directly without fabricating Electron-only frame or process fields.
 */
export interface HostRunDispatchEvent {
  readonly sender: HostRunEventTarget
}
