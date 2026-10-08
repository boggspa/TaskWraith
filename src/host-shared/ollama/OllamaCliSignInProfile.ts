/**
 * The Host's reads of main's Ollama settings.
 *
 * Main records the daemon's last definitive account answer in the profile's
 * `settings.json` (`ollamaCliSignIn`, see `OllamaCliSignInMemory`), next to the
 * user's `ollamaBaseUrl`. The Host shares that profile directory but has no
 * settings store of its own, so it reads both straight from the file —
 * read-only, size-bounded, symlink-refusing, tolerant of an absent or
 * malformed file — and applies them exactly as main does. Only the sign-in
 * flag, plan name and daemon URL are ever read; the normalisers drop
 * everything else.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeOllamaCliSignIn, type OllamaCliSignInRecord } from './OllamaCliSignInMemory'

export const HOST_PROFILE_SETTINGS_FILENAME = 'settings.json'
const MAX_SETTINGS_JSON_BYTES = 4 * 1024 * 1024

function readBoundedJson(path: string): unknown {
  let descriptor: number | null = null
  try {
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2) return null
    if (before.size > MAX_SETTINGS_JSON_BYTES) return null
    descriptor = openSync(
      path,
      constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0)
    )
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_SETTINGS_JSON_BYTES) return null
    // O_NOFOLLOW is unavailable on Windows. Bind the opened descriptor to the
    // inspected file, then ensure its name has not become a symlink or replacement.
    if (opened.dev !== before.dev || opened.ino !== before.ino) return null
    const text = readFileSync(descriptor, 'utf8')
    const named = lstatSync(path, { bigint: true })
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      return null
    }
    return JSON.parse(text) as unknown
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

/**
 * A reader of the profile's `ollamaBaseUrl` for a provider to call per catalog
 * fetch and per run. It answers null when the settings name no usable URL, so
 * the caller keeps its default daemon, the one main falls back to. A settings
 * file it cannot read or parse (mid-rewrite, out of descriptors) keeps the URL
 * it last read, as main keeps its settings in memory, rather than sending a
 * run to the default daemon.
 */
export function createProfileOllamaBaseUrlReader(profilePath: string): () => string | null {
  let last: string | null = null
  return () => {
    const settings = readBoundedJson(join(profilePath, HOST_PROFILE_SETTINGS_FILENAME))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return last
    last = normalizeProfileOllamaBaseUrl((settings as { ollamaBaseUrl?: unknown }).ollamaBaseUrl)
    return last
  }
}

/** Main's `normalizeOllamaBaseUrl`, with null where main uses its default. */
function normalizeProfileOllamaBaseUrl(raw: unknown): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}
