/**
 * The Host's read of the remembered `ollama signin`.
 *
 * Main records the daemon's last definitive account answer in the profile's
 * `settings.json` (`ollamaCliSignIn`, see `OllamaCliSignInMemory`). The Host
 * shares that profile directory but has no settings store of its own, so it
 * reads the record straight from the file — read-only, size-bounded,
 * symlink-refusing, tolerant of an absent or malformed file — and folds it
 * into its catalogue exactly as main does. Only the sign-in flag and plan name
 * are ever read; the normaliser drops everything else.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeOllamaCliSignIn, type OllamaCliSignInRecord } from './OllamaCliSignInMemory'

export const HOST_PROFILE_SETTINGS_FILENAME = 'settings.json'
const MAX_SETTINGS_JSON_BYTES = 4 * 1024 * 1024

function readBoundedJson(path: string): unknown {
  let descriptor: number | null = null
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2) return null
    if (before.size > MAX_SETTINGS_JSON_BYTES) return null
    descriptor = openSync(
      path,
      constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0)
    )
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_SETTINGS_JSON_BYTES) return null
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** The remembered CLI sign-in from `<profilePath>/settings.json`, or null. */
export function readRememberedOllamaCliSignIn(profilePath: string): OllamaCliSignInRecord | null {
  const settings = readBoundedJson(join(profilePath, HOST_PROFILE_SETTINGS_FILENAME))
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  return normalizeOllamaCliSignIn((settings as { ollamaCliSignIn?: unknown }).ollamaCliSignIn)
}
