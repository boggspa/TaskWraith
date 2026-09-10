import { homedir } from 'os'
import { join } from 'path'
import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'fs'

export interface GraftTerminalKeychainAccessOptions {
  /** Platform override (tests). Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /**
   * Real user keychain directory to graft (tests). Defaults to
   * `~/Library/Keychains` on macOS.
   */
  readonly realKeychainsDir?: string
}

/**
 * Graft macOS keychain access into an isolated terminal home.
 *
 * Thread Home terminals run with HOME relocated to a per-workspace directory
 * under userData, so `$HOME/Library/Keychains` does not exist and every CLI
 * that stores credentials in the login keychain fails — Muse reports
 * "keychain write failed (os status -60006)" behind a "Keychain Not Found"
 * dialog, and the same missing-keychain failure hits any CLI that writes
 * through the Security framework. The CLI resolves the keychain through
 * `$HOME/Library/Keychains` (confirmed for Muse Code 1.0.1 in the seat-home
 * lane), so one symlink restores reads and writes: the secret itself is never
 * read or copied by TaskWraith — securityd and the item ACLs still gate the
 * actual unlock.
 *
 * Returns the graft link path, or null when grafting is skipped (non-macOS,
 * or no real keychain directory to graft). Idempotent: an existing link that
 * already resolves to the expected directory is kept; anything else at that
 * path is removed first so a graft can never be silently redirected at a
 * keychain the terminal was not meant to reach.
 */
export function graftTerminalKeychainAccess(
  home: string,
  options: GraftTerminalKeychainAccessOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return null

  const realKeychainsDir = options.realKeychainsDir ?? join(homedir(), 'Library', 'Keychains')
  try {
    if (!statSync(realKeychainsDir).isDirectory()) return null
  } catch {
    // No user keychain directory — leave the terminal home untouched and let
    // the CLI report its own credential state.
    return null
  }

  const libraryDir = join(home, 'Library')
  mkdirSync(libraryDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(libraryDir, 0o700)
  const linkPath = join(libraryDir, 'Keychains')
  try {
    const existing = lstatSync(linkPath)
    if (existing.isSymbolicLink() && readlinkSync(linkPath) === realKeychainsDir) return linkPath
    rmSync(linkPath, { recursive: true, force: true })
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  symlinkSync(realKeychainsDir, linkPath)
  return linkPath
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
