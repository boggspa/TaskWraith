import * as fs from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const PROFILE_MARKERS = ['settings.json', 'chats', 'usage.json', 'workspaces.json']
const LEGACY_PROFILE_NAMES = ['AGBench', 'agbench'] as const
const VOLATILE_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Crashpad',
  'Network Persistent State'
])
const MIGRATION_MARKER = '.taskwraith-userdata-migration'

export interface LegacyUserDataMigrationOptions {
  /** Absolute, normalized TaskWraith profile path supplied by the bootstrap owner. */
  readonly userDataPath: string
  readonly now?: () => Date
  readonly log?: Pick<Console, 'log' | 'warn'>
}

export type LegacyUserDataMigrationState =
  | 'already_checked'
  | 'existing_profile'
  | 'copied'
  | 'no_legacy_profile'
  | 'invalid_profile'
  | 'failed'

/** A bounded startup report; it intentionally contains neither paths nor raw errors. */
export interface LegacyUserDataMigrationResult {
  readonly state: LegacyUserDataMigrationState
  readonly sourceName?: (typeof LEGACY_PROFILE_NAMES)[number]
}

function hasProfile(dir: string): boolean {
  return PROFILE_MARKERS.some((name) => fs.existsSync(join(dir, name)))
}

function isCanonicalNonRootProfilePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    !isAbsolute(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return false
  }
  const canonical = resolve(value)
  return canonical === value && canonical !== parse(canonical).root
}

function warn(log: Pick<Console, 'log' | 'warn'>, error: unknown): void {
  try {
    log.warn('[rebrand-migration] legacy userData migration skipped:', error)
  } catch {
    // Startup migration must stay best-effort even when an injected logger fails.
  }
}

/**
 * One-time migration for the AGBench -> TaskWraith rebrand. The caller owns
 * choosing and validating the profile identity; this module deliberately has
 * no Electron dependency and performs no work outside that exact profile.
 */
export function migrateLegacyUserDataSync(
  options: LegacyUserDataMigrationOptions
): LegacyUserDataMigrationResult {
  const log = options?.log ?? console
  const userDataPath = options?.userDataPath
  if (!isCanonicalNonRootProfilePath(userDataPath)) {
    warn(
      log,
      new TypeError('Legacy userData migration requires a canonical non-root profile path.')
    )
    return { state: 'invalid_profile' }
  }

  try {
    const marker = join(userDataPath, MIGRATION_MARKER)
    if (fs.existsSync(marker)) return { state: 'already_checked' }

    let result: LegacyUserDataMigrationResult
    // Only seed a FRESH TaskWraith profile — never migrate over real data.
    if (hasProfile(userDataPath)) {
      result = { state: 'existing_profile' }
    } else {
      const parent = dirname(userDataPath)
      result = { state: 'no_legacy_profile' }
      // Packaged productName was "AGBench"; the dev/electron-vite name was "agbench".
      for (const legacyName of LEGACY_PROFILE_NAMES) {
        const oldDir = join(parent, legacyName)
        if (oldDir === userDataPath) continue
        if (!hasProfile(oldDir)) continue
        fs.cpSync(oldDir, userDataPath, {
          recursive: true,
          force: false,
          errorOnExist: false,
          filter: (src) => {
            const rel = relative(oldDir, src)
            if (!rel) return true
            if (VOLATILE_TOP_LEVEL_NAMES.has(rel.split(sep)[0])) return false
            return !src.endsWith('.sock')
          }
        })
        try {
          log.log(`[rebrand-migration] copied legacy userData ${oldDir} -> ${userDataPath}`)
        } catch {
          // Logging is not allowed to make this best-effort migration fail.
        }
        result = { state: 'copied', sourceName: legacyName }
        break
      }
    }

    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(marker, `checked ${(options.now ?? (() => new Date()))().toISOString()}\n`)
    return result
  } catch (error) {
    warn(log, error)
    return { state: 'failed' }
  }
}
