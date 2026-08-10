/**
 * Muse bundled-skill pin for TaskWraith-managed seats.
 *
 * Wave-1 D verified Muse Code 0.1.0-R708.1 exposes exactly ten listable
 * bundled skills (`muse skills list --source built-in --json`). The v1 seat
 * disables all of them via pre-seeded `$XDG_CONFIG_HOME/muse/settings.json`
 * rather than calling `muse skills disable`.
 *
 * `create-plugin` is present on disk under the bundled tree but is not
 * listable / disable-able via CLI today. Still seed it `off` and pin the
 * directory name so a future build that makes it listable fails the ratchet.
 */

export const MUSE_BUNDLED_SKILL_URI_PREFIX = 'bundled://muse-core/skills/' as const
export const MUSE_BUNDLED_SKILL_URI_SUFFIX = '/SKILL.md' as const

/** Exact listable bundled skill names on Muse 0.1.0-R708.1 (CI ratchet). */
export const MUSE_LISTABLE_BUNDLED_SKILL_NAMES = Object.freeze([
  'create-skill',
  'doctor',
  'git',
  'grill',
  'grill-and-record',
  'import',
  'manage-settings',
  'plan',
  'read-session',
  'taste'
] as const)

export type MuseListableBundledSkillName = (typeof MUSE_LISTABLE_BUNDLED_SKILL_NAMES)[number]

/**
 * On-disk under `$XDG_DATA_HOME/muse/skills/bundled/muse-core/skills/` but not
 * returned by `muse skills list` on the pinned Muse build.
 */
export const MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES = Object.freeze(['create-plugin'] as const)

export type MuseNonListableBundledSkillName = (typeof MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES)[number]

/** Every bundled skill name the seat seeds off (listable + create-plugin). */
export const MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES = Object.freeze([
  ...MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES,
  ...MUSE_LISTABLE_BUNDLED_SKILL_NAMES
] as const)

export type MusePinnedOffBundledSkillName = (typeof MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES)[number]

export type MuseSkillActivation = 'off' | 'on'

export function museBundledSkillUri(name: string): string {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\0')) {
    throw new TypeError('Muse bundled skill name is invalid.')
  }
  return `${MUSE_BUNDLED_SKILL_URI_PREFIX}${name}${MUSE_BUNDLED_SKILL_URI_SUFFIX}`
}

export function buildMuseBundledSkillActivationPin(
  activation: MuseSkillActivation = 'off'
): Readonly<Record<string, MuseSkillActivation>> {
  const bundled: Record<string, MuseSkillActivation> = {}
  for (const name of MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES) {
    bundled[museBundledSkillUri(name)] = activation
  }
  return Object.freeze(bundled)
}

export interface MuseSkillPinSettings {
  readonly schema_version: 1
  readonly skills: {
    readonly activation: {
      readonly bundled: Readonly<Record<string, MuseSkillActivation>>
    }
  }
}

/** Pre-seed body for `$XDG_CONFIG_HOME/muse/settings.json`. */
export function buildMuseSkillPinSettings(
  activation: MuseSkillActivation = 'off'
): MuseSkillPinSettings {
  return Object.freeze({
    schema_version: 1 as const,
    skills: Object.freeze({
      activation: Object.freeze({
        bundled: buildMuseBundledSkillActivationPin(activation)
      })
    })
  })
}

export function serializeMuseSkillPinSettings(
  settings: MuseSkillPinSettings = buildMuseSkillPinSettings()
): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

export type MuseSkillPinRatchetResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      reason: string
      expected: readonly string[]
      observed: readonly string[]
      missing: readonly string[]
      unexpected: readonly string[]
    }>

function sortedUniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => String(name)))].sort((a, b) => a.localeCompare(b))
}

/**
 * CI ratchet: observed listable bundled skill names must equal the pinned set.
 * A new Muse build that adds a listable skill fails closed until an explicit
 * pin update lands.
 */
export function assertMuseListableBundledSkillRatchet(
  observedNames: readonly string[]
): MuseSkillPinRatchetResult {
  if (!Array.isArray(observedNames)) {
    throw new TypeError('Observed Muse bundled skill names must be an array.')
  }
  const expected = [...MUSE_LISTABLE_BUNDLED_SKILL_NAMES]
  const observed = sortedUniqueNames(observedNames)
  const expectedSet = new Set<string>(expected)
  const observedSet = new Set(observed)
  const missing = expected.filter((name) => !observedSet.has(name))
  const unexpected = observed.filter((name) => !expectedSet.has(name))
  if (missing.length === 0 && unexpected.length === 0) {
    return { ok: true }
  }
  return {
    ok: false,
    reason:
      'Muse listable bundled skill set drifted from the TaskWraith pin; update MuseSkillPin deliberately.',
    expected,
    observed,
    missing,
    unexpected
  }
}

/**
 * After seeding, every listable skill must report activation `off` and the
 * enabled set must be empty.
 */
export function assertMuseEnabledBundledSkillsEmpty(
  entries: readonly Readonly<{ name?: string; id?: string; activation?: string }>[]
): MuseSkillPinRatchetResult {
  if (!Array.isArray(entries)) {
    throw new TypeError('Observed Muse skill entries must be an array.')
  }
  const stillOn = entries
    .filter((entry) => String(entry?.activation ?? '').toLowerCase() !== 'off')
    .map((entry) => String(entry.name || entry.id || '<unknown>'))
    .sort((a, b) => a.localeCompare(b))
  if (stillOn.length === 0) {
    return { ok: true }
  }
  return {
    ok: false,
    reason: 'Muse bundled skills remain enabled after the seat pin seed.',
    expected: [],
    observed: stillOn,
    missing: [],
    unexpected: stillOn
  }
}

/** Expected on-disk inventory under the bundled skills tree (listable + create-plugin). */
export function expectedMuseBundledSkillDirectoryNames(): readonly string[] {
  return Object.freeze(
    sortedUniqueNames([
      ...MUSE_LISTABLE_BUNDLED_SKILL_NAMES,
      ...MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES
    ])
  )
}
