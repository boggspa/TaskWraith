// macOS App Translocation detection.
//
// Gatekeeper runs a QUARANTINED app bundle from a randomised read-only mount
// under `.../T/AppTranslocation/<UUID>/d/` instead of from where the user put
// it. The mount's UUID changes per launch and the mount is torn down when that
// launch exits, so any path derived from `process.execPath` while translocated
// is valid only for the lifetime of that one process.
//
// That matters here because TaskWraith hands its own executable path to
// provider CLIs as an MCP server `command`. A translocated path passes an
// `access(X_OK)` check in the parent and then fails in the child as
// `[Errno 2] No such file or directory`, which surfaces to the user as
// "MCP servers failed to connect" on every single turn. Worse, the providers
// that persist that command (Cursor's `~/.cursor/mcp.json`, Gemini's
// `~/.gemini/settings.json`, the agy config) write a path that is already dead
// by the next launch.
//
// Pure module: a substring test plus copy, no fs and no Electron, so the
// decision is unit-testable and can be made before anything is written.

/**
 * The literal macOS inserts into a translocated path. Stable since 10.12 and
 * the only reliable signal — every self-location API Electron offers
 * (`process.execPath`, `process.resourcesPath`, `app.getAppPath()`) resolves
 * INSIDE the translocated mount and so cannot be used to detect it.
 */
export const APP_TRANSLOCATION_PATH_MARKER = '/AppTranslocation/'

/** Whether a path lives inside a Gatekeeper translocation mount. */
export function pathIsAppTranslocated(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.includes(APP_TRANSLOCATION_PATH_MARKER)
}

/**
 * Why the MCP bridge is refused, and what the user does about it.
 *
 * Deliberately names the remedy rather than the mechanism: the failure the user
 * actually sees is a provider reporting a missing file, and nothing about that
 * message suggests "the app is running from the wrong place".
 */
export function appTranslocationRemedyMessage(): string {
  return (
    'macOS is running TaskWraith from a temporary Gatekeeper copy (App Translocation), ' +
    'so its executable path stops existing as soon as the app quits and provider CLIs ' +
    'cannot launch the TaskWraith MCP bridge. Move TaskWraith.app into /Applications, ' +
    'quit it completely, then reopen it from there. If it still happens, run ' +
    '`xattr -dr com.apple.quarantine /Applications/TaskWraith.app` and relaunch.'
  )
}
