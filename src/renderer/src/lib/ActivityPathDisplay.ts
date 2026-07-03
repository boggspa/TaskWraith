/**
 * Pure helper that shortens a file path for inline display in activity rows.
 *
 * The full absolute path produced by tool adapters (e.g.
 * `/Users/alice/Documents/Dungeons of Darkness/Sources/DungeonsEngine/SoundSynth.swift`)
 * is verbose and visually collides with right-edge metadata such as
 * `+24 -11 · 75ms`. Activity rows still want to surface enough of the path
 * for the user to identify the file at a glance — typically the
 * workspace-relative segments — while the full path is preserved on hover
 * via the surrounding `title` attribute.
 *
 * Strategy (in priority order):
 *   1. When `workspacePath` is set AND `filePath` lives under it
 *      (segment-aware prefix match), strip the prefix + leading separator.
 *      A path that equals the workspace root collapses to `.`.
 *   2. Otherwise, when the path starts with the macOS/Linux home directory
 *      (`/Users/<user>/`) collapse the home portion to `~/...`. This is a
 *      polish fallback for files outside the workspace — most often docs or
 *      libraries the agent visits during a task.
 *   3. Otherwise return the original path unchanged.
 *
 * Comparison is case-sensitive by default. macOS volumes are typically
 * case-insensitive, but Linux and Windows are not — defaulting to
 * case-sensitive matches what cross-platform code would expect from a
 * deterministic helper. Callers that need looser semantics can normalise
 * before invoking.
 */

const SEPARATOR_RE = /[\\/]+$/
const HOME_PREFIX_RE = /^\/Users\/[^/]+\//
// POSIX root (`/…`), Windows drive (`C:\…` / `C:/…`) or UNC (`\\host\…`).
const ABSOLUTE_PATH_RE = /^(?:[\\/]|[A-Za-z]:[\\/]|\\\\)/

function stripTrailingSeparator(value: string): string {
  return value.replace(SEPARATOR_RE, '')
}

/**
 * True when `value` is already an absolute filesystem path (POSIX, Windows
 * drive, or UNC). A leading `~` is NOT considered absolute — the shell layer
 * does not expand it, so callers must resolve it themselves.
 */
export function isAbsoluteFilePath(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string') return false
  return ABSOLUTE_PATH_RE.test(value.trim())
}

/**
 * Lexically collapse `.` / `..` segments in a POSIX-absolute path so the
 * resolved string we display + hand to the shell layer is honest (e.g.
 * `/repo/src/../../etc/hosts` → `/etc/hosts`) rather than an opaque
 * traversal string. Only touches `/`-rooted paths; Windows / UNC / relative
 * inputs are returned unchanged (the OS still resolves `..` on open, and a
 * correct cross-platform normaliser is out of scope for this display helper).
 */
function normalizePosixTraversal(path: string): string {
  if (!path.startsWith('/')) return path
  const stack: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return `/${stack.join('/')}`
}

/**
 * Inverse of {@link displayPathRelativeToWorkspace}: best-effort resolve of a
 * tool-reported path to an absolute path suitable for `shell.openPath` /
 * reveal-in-Finder.
 *
 *   - A `~`-prefixed path is returned untouched (this helper can't expand the
 *     home dir; joining it onto the workspace would fabricate a wrong path).
 *   - Absolute inputs are returned trimmed, with POSIX `.`/`..` collapsed.
 *   - A relative input is joined onto `workspacePath` (separator inferred from
 *     the root so a Windows workspace keeps its backslashes) and likewise
 *     collapsed.
 *   - With no workspace to anchor a relative path, the trimmed input is
 *     returned as-is; the open will surface a "not found" error rather than
 *     this helper fabricating a wrong absolute path.
 *
 * NOTE: this deliberately does NOT confine the result to the workspace root.
 * Tool traces routinely reference files the agent read OUTSIDE the workspace
 * (docs, libraries, `~/Desktop/...`), and opening those is the intended
 * behaviour — the same as the existing markdown-link / media-reveal file-open
 * affordances, which also open agent-named paths without confinement. The
 * paths originate from the user's own agent's tool calls and are surfaced in
 * full in the hover card before the user clicks.
 *
 * Empty / nullish inputs return ''.
 */
export function resolveWorkspaceAbsolutePath(
  filePath: string | undefined | null,
  workspacePath: string | undefined | null
): string {
  if (!filePath || typeof filePath !== 'string') return ''
  const trimmedPath = filePath.trim()
  if (!trimmedPath) return ''
  if (trimmedPath.startsWith('~')) return trimmedPath
  if (isAbsoluteFilePath(trimmedPath)) return normalizePosixTraversal(trimmedPath)
  if (!workspacePath || typeof workspacePath !== 'string') return trimmedPath
  const root = stripTrailingSeparator(workspacePath.trim())
  if (!root) return trimmedPath
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  // Drop a single leading `./` (or `.\`) before joining; deeper `.`/`..`
  // segments are collapsed lexically afterwards.
  const relative = trimmedPath.replace(/^\.[\\/]/, '')
  return normalizePosixTraversal(`${root}${separator}${relative}`)
}

function startsWithSegment(haystack: string, prefix: string): boolean {
  if (haystack === prefix) return true
  if (!haystack.startsWith(prefix)) return false
  const nextChar = haystack.charAt(prefix.length)
  return nextChar === '/' || nextChar === '\\'
}

/**
 * Collapse a macOS home-directory prefix (`/Users/<user>/…`) to `~/…`,
 * stripping the OS username. Used for compact display AND to keep a user's
 * home path — which embeds their account name — out of anything shared
 * publicly, e.g. the pre-filled GitHub issue produced by the bug reporter.
 * Non-home paths (and bare `/Users` with no user segment) are returned
 * trimmed but otherwise unchanged. Empty / nullish / non-string → ''.
 */
export function tildifyHomePath(filePath: string | undefined | null): string {
  if (!filePath || typeof filePath !== 'string') return ''
  const trimmed = filePath.trim()
  if (!trimmed) return ''
  const homeMatch = trimmed.match(HOME_PREFIX_RE)
  return homeMatch ? `~/${trimmed.slice(homeMatch[0].length)}` : trimmed
}

/**
 * Returns a display-friendly path:
 *   - workspace-relative when the file lives under `workspacePath`
 *   - `~/...` form when the file lives under the macOS home directory
 *   - the original path otherwise
 *
 * Empty / nullish inputs are returned as the empty string so callers can
 * substitute their own fallback label without a runtime crash.
 */
export function displayPathRelativeToWorkspace(
  filePath: string | undefined | null,
  workspacePath: string | undefined | null
): string {
  if (!filePath || typeof filePath !== 'string') return ''
  const trimmedPath = filePath.trim()
  if (!trimmedPath) return ''

  if (workspacePath && typeof workspacePath === 'string') {
    const trimmedWorkspace = stripTrailingSeparator(workspacePath.trim())
    if (trimmedWorkspace) {
      if (trimmedPath === trimmedWorkspace) return '.'
      if (startsWithSegment(trimmedPath, trimmedWorkspace)) {
        // +1 to drop the separator character that follows the prefix match.
        const relative = trimmedPath.slice(trimmedWorkspace.length + 1)
        return relative || '.'
      }
    }
  }

  return tildifyHomePath(trimmedPath)
}
