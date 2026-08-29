/**
 * Persisted TUI preferences.
 *
 * The TUI had no settings before this: every option was a flag or an
 * environment variable, which is fine for options you pass deliberately and
 * useless for a theme you pick once from a menu. A `/theme` that does not
 * survive the next launch is a preview, not a preference.
 *
 * Deliberately NOT stored in the Host's userData directory. That directory is
 * profile data belonging to the Host, keyed by `--dev`, and a colour preference
 * is neither: it belongs to the person at the terminal, and should not change
 * when they point the client at a different profile.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TuiSettings {
  /** Theme name or alias, exactly as the user chose it. `auto` is preserved. */
  theme?: string
}

/**
 * Where preferences live.
 *
 * XDG rather than the app's userData, and the same resolution the Host already
 * uses for third-party CLI config. `TASKWRAITH_TUI_CONFIG` overrides it outright,
 * which is what the tests use and what a sandboxed run needs.
 */
export function tuiSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.TASKWRAITH_TUI_CONFIG || '').trim()
  if (override) return override
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'taskwraith', 'tui.json')
}

/**
 * Read preferences, treating every failure as "no preferences".
 *
 * A corrupt or unreadable settings file must never stop the TUI from starting.
 * The cost of ignoring it is one forgotten preference; the cost of throwing is
 * a client that cannot launch until the user finds and deletes a file whose
 * location they were never told.
 */
export function readTuiSettings(path = tuiSettingsPath()): TuiSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as TuiSettings
  } catch {
    return {}
  }
}

/**
 * Merge `changes` into the stored preferences and write them back.
 *
 * Merged rather than replaced so a newer client's keys survive an older
 * client's write. Same reason the read above tolerates unknown keys: two
 * versions of this CLI will share one file on the same machine.
 *
 * Returns whether the write landed. Callers surface that to the user rather
 * than throwing — failing to persist a theme should not end the session, but
 * silently doing nothing would leave them to discover it at the next launch.
 */
export function writeTuiSettings(changes: TuiSettings, path = tuiSettingsPath()): boolean {
  try {
    const merged = { ...readTuiSettings(path), ...changes }
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename: a crash mid-write leaves the previous settings intact
    // rather than a truncated file that the reader above would discard whole.
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    return false
  }
}
