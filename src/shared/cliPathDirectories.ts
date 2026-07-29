/**
 * Normalization for the user-owned "extra CLI directories" setting.
 *
 * WHY THIS EXISTS
 * ---------------
 * TaskWraith discovers every external binary — provider CLIs, `gh`, `git`,
 * ffmpeg, poppler — through one candidate-directory list (see
 * `main/providers/CliSearchDirs.ts`). That list augments the inherited PATH with
 * well-known install roots, because a Finder-launched macOS app inherits the
 * minimal launchd PATH and never sees `/opt/homebrew/bin`. The well-known roots
 * cover most installs, but not all of them: testers who keep CLIs under a
 * version manager (asdf/mise/volta/nvm shims), a custom npm prefix, or a
 * non-standard Homebrew prefix end up with tools that work in their shell and
 * are invisible to TaskWraith. They then maintain a second, parallel install
 * just for this app.
 *
 * This setting is the escape hatch: an explicit, user-owned list of directories
 * that gets searched FIRST, before the inherited PATH and the built-in roots.
 * Search-first is the whole point — the user is correcting a wrong resolution,
 * so their answer has to beat the default one.
 *
 * Node-builtin-free (string-only) so the renderer editor, the main-process
 * sanitizer, and the resolver all agree on what a valid entry is. One
 * normalizer, three call sites — the alternative is three subtly different
 * ideas of "valid directory" and a setting that looks saved but never applies.
 */

/** Upper bound on stored entries. Generous for real use, bounded for a forged patch. */
export const MAX_CLI_PATH_DIRECTORIES = 24

/** Upper bound on one entry's length. */
export const MAX_CLI_PATH_DIRECTORY_LENGTH = 1024

/**
 * Why a candidate directory was rejected, or null when it is acceptable.
 *
 * Returned rather than thrown so the editor can show the reason inline while
 * the sanitizer silently drops the same entry.
 */
export function cliPathDirectoryRejection(value: unknown): string | null {
  if (typeof value !== 'string') return 'Not a path.'
  const trimmed = value.trim()
  if (!trimmed) return 'Empty path.'
  if (trimmed.length > MAX_CLI_PATH_DIRECTORY_LENGTH) return 'Path is too long.'
  // Control characters would corrupt the joined PATH string, and a literal
  // path separator means the user pasted a whole PATH into one row.
  if (/[\0\r\n\t]/.test(trimmed)) return 'Path contains control characters.'
  if (trimmed.includes(':') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return 'Enter one directory per row, not a full PATH.'
  }
  if (trimmed.includes(';')) return 'Enter one directory per row, not a full PATH.'
  // Relative entries would resolve against whatever cwd the spawn happens to
  // use, which is a different directory per run — never what the user meant.
  const isPosixAbsolute = trimmed.startsWith('/')
  const isHomeRelative = trimmed === '~' || trimmed.startsWith('~/')
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  if (!isPosixAbsolute && !isHomeRelative && !isWindowsAbsolute) {
    return 'Use an absolute directory (or one starting with ~/).'
  }
  return null
}

/** True when the entry is storable. */
export function isValidCliPathDirectory(value: unknown): value is string {
  return cliPathDirectoryRejection(value) === null
}

/**
 * Strip trailing separators so `/opt/homebrew/bin/` and `/opt/homebrew/bin`
 * de-duplicate against each other — but never strip a root (`/`, `C:\`), where
 * the separator IS the path.
 */
function trimTrailingSeparators(value: string): string {
  const stripped = value.replace(/[/\\]+$/, '')
  if (!stripped) return value
  // `C:` alone is a drive-relative path on Windows, not the drive root.
  if (/^[A-Za-z]:$/.test(stripped)) return value
  return stripped
}

/**
 * Trim, drop invalid entries, de-duplicate, and cap the list.
 *
 * Order is preserved: the user's ordering is their search priority, so a stable
 * de-dupe (first occurrence wins) is the only correct one.
 */
export function normalizeCliPathDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const candidate of value) {
    if (!isValidCliPathDirectory(candidate)) continue
    const entry = trimTrailingSeparators(candidate.trim())
    if (seen.has(entry)) continue
    seen.add(entry)
    normalized.push(entry)
    if (normalized.length >= MAX_CLI_PATH_DIRECTORIES) break
  }
  return normalized
}

/**
 * Expand a leading `~` against the supplied home directory.
 *
 * Kept here (not in the resolver) so the editor can show the user the real
 * directory that will be searched. `homeDir` is injected rather than read from
 * `os` to keep this module Node-builtin-free.
 */
export function expandCliPathDirectory(entry: string, homeDir: string): string {
  const trimmed = entry.trim()
  if (!homeDir) return trimmed
  if (trimmed === '~') return homeDir
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const suffix = trimmed.slice(2)
    const separator = homeDir.endsWith('/') || homeDir.endsWith('\\') ? '' : '/'
    return `${homeDir}${separator}${suffix}`
  }
  return trimmed
}

/**
 * Split a pasted PATH-style string into candidate rows.
 *
 * Paste-a-whole-PATH is the single most likely thing a user does here, so the
 * editor accepts it and splits rather than rejecting the whole paste.
 *
 * `;` and newlines always separate. `:` separates too — but only in a segment
 * that is not itself a Windows path: a drive colon sits at segment position 1
 * (`C:\tools`), and splitting on it would mangle every Windows paste.
 */
export function splitPastedCliPath(value: string): string[] {
  return value
    .split(/[;\r\n]+/)
    .flatMap((segment) => {
      const trimmed = segment.trim()
      return /^[A-Za-z]:([\\/]|$)/.test(trimmed) ? [trimmed] : trimmed.split(':')
    })
    .map((entry) => entry.trim())
    .filter(Boolean)
}
