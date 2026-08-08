/**
 * Per-provider skills/hooks harness posture (Wave C).
 *
 * Controls whether a managed provider launch may load the provider's own
 * skills/hooks surfaces (`allow-native`), must keep them clamped so only
 * TaskWraith-owned skills/hooks apply (`tw-only`), or must actively suppress
 * native discovery (`suppress`).
 *
 * Fail-safe defaults match today's containment:
 * - Claude / Pi / Kimi → suppress / suppress
 * - Cursor → allow-native / allow-native (Path-B cannot fully suppress account hooks)
 * - Codex → tw-only / tw-only (private CODEX_HOME; no argv change)
 * - all other ProviderIds → tw-only / tw-only
 *
 * Launch builders accept an optional resolved posture and keep today's argv /
 * home behavior when omitted.
 *
 * Provider ids mirror `ProviderId` in store/types but stay local here so this
 * module remains free of a shared↔store import cycle.
 */

export type HarnessPassthroughMode = 'tw-only' | 'allow-native' | 'suppress'

export interface ProviderHarnessPosture {
  skills: HarnessPassthroughMode
  hooks: HarnessPassthroughMode
}

/** Mirrors store `ProviderId` — kept local to avoid a shared↔store cycle. */
export type HarnessProviderId =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
  | 'antigravity'
  | 'pi'
  | 'mistral'

export type ProviderHarnessPostureMap = Partial<Record<HarnessProviderId, ProviderHarnessPosture>>

const HARNESS_PASSTHROUGH_MODES = new Set<HarnessPassthroughMode>([
  'tw-only',
  'allow-native',
  'suppress'
])

const ALL_PROVIDER_IDS: readonly HarnessProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
]

const SUPPRESS_BOTH: ProviderHarnessPosture = { skills: 'suppress', hooks: 'suppress' }
const ALLOW_NATIVE_BOTH: ProviderHarnessPosture = {
  skills: 'allow-native',
  hooks: 'allow-native'
}
const TW_ONLY_BOTH: ProviderHarnessPosture = { skills: 'tw-only', hooks: 'tw-only' }

/** Built-in defaults. Stored settings are sparse overrides merged onto these. */
export const DEFAULT_PROVIDER_HARNESS_POSTURES: Record<HarnessProviderId, ProviderHarnessPosture> =
  {
    claude: { ...SUPPRESS_BOTH },
    pi: { ...SUPPRESS_BOTH },
    kimi: { ...SUPPRESS_BOTH },
    cursor: { ...ALLOW_NATIVE_BOTH },
    codex: { ...TW_ONLY_BOTH },
    gemini: { ...TW_ONLY_BOTH },
    grok: { ...TW_ONLY_BOTH },
    ollama: { ...TW_ONLY_BOTH },
    antigravity: { ...TW_ONLY_BOTH },
    mistral: { ...TW_ONLY_BOTH }
  }

/**
 * Cursor Path-B disclosure: account skills/hooks under `~/.cursor` may still
 * load inside the OS sandbox. `suppress` is recorded honestly but cannot be
 * fully enforced via argv today.
 */
export const CURSOR_HARNESS_SUPPRESS_DISCLOSURE =
  'Cursor Path-B cannot fully suppress account skills/hooks. Native Cursor tools remain sandbox-bounded under ~/.cursor; TaskWraith mediates brokered gateway calls only.'

/**
 * Codex tw-only is realized by TaskWraith's private CODEX_HOME isolation — the
 * managed seat does not inherit the user's global Codex skills/hooks tree.
 * No Codex argv flag is required for this posture.
 */
export const CODEX_HARNESS_TW_ONLY_NOTE =
  'Codex tw-only uses TaskWraith private CODEX_HOME isolation; no argv change is required.'

export function isHarnessPassthroughMode(value: unknown): value is HarnessPassthroughMode {
  return typeof value === 'string' && HARNESS_PASSTHROUGH_MODES.has(value as HarnessPassthroughMode)
}

export function isProviderIdForHarness(value: unknown): value is HarnessProviderId {
  return typeof value === 'string' && (ALL_PROVIDER_IDS as readonly string[]).includes(value)
}

export function mergeProviderHarnessPosture(
  base: ProviderHarnessPosture,
  override?: Partial<ProviderHarnessPosture> | null
): ProviderHarnessPosture {
  const skills =
    override && isHarnessPassthroughMode(override.skills) ? override.skills : base.skills
  const hooks = override && isHarnessPassthroughMode(override.hooks) ? override.hooks : base.hooks
  return { skills, hooks }
}

export function normalizeProviderHarnessPosture(
  value: unknown,
  fallback: ProviderHarnessPosture
): ProviderHarnessPosture {
  if (!value || typeof value !== 'object') return { ...fallback }
  const record = value as Record<string, unknown>
  return mergeProviderHarnessPosture(fallback, {
    skills: isHarnessPassthroughMode(record.skills) ? record.skills : undefined,
    hooks: isHarnessPassthroughMode(record.hooks) ? record.hooks : undefined
  })
}

/**
 * Normalize persisted sparse overrides. Unknown providers / modes are dropped.
 * Entries that match the built-in default exactly are kept (explicit user choice).
 */
export function normalizeProviderHarnessPostureMap(value: unknown): ProviderHarnessPostureMap {
  if (!value || typeof value !== 'object') return {}
  const input = value as Record<string, unknown>
  const out: ProviderHarnessPostureMap = {}
  for (const provider of ALL_PROVIDER_IDS) {
    if (!(provider in input)) continue
    const fallback = DEFAULT_PROVIDER_HARNESS_POSTURES[provider]
    const normalized = normalizeProviderHarnessPosture(input[provider], fallback)
    out[provider] = normalized
  }
  return out
}

export function resolveProviderHarnessPosture(
  provider: HarnessProviderId,
  stored?: ProviderHarnessPostureMap | null
): ProviderHarnessPosture {
  const fallback = DEFAULT_PROVIDER_HARNESS_POSTURES[provider] ?? TW_ONLY_BOTH
  if (!stored || !(provider in stored)) return { ...fallback }
  return normalizeProviderHarnessPosture(stored[provider], fallback)
}

/**
 * Claude's `--setting-sources` gate loads user/project settings, hooks,
 * plugins, and MCP files together — skills and hooks cannot be split.
 *
 * - Default / suppress / tw-only → keep `--setting-sources ''` (today's clamp).
 * - allow-native on BOTH channels → omit the empty setting-sources pair so the
 *   CLI may load native sources. Mixed modes stay clamped (fail-safe).
 */
export function claudeUsesEmptySettingSources(posture: ProviderHarnessPosture): boolean {
  return !(posture.skills === 'allow-native' && posture.hooks === 'allow-native')
}

/** Pi: suppress / tw-only keep `--no-skills`; allow-native omits it. */
export function piShouldPassNoSkills(posture: Pick<ProviderHarnessPosture, 'skills'>): boolean {
  return posture.skills !== 'allow-native'
}

/**
 * Kimi: suppress / tw-only create an empty isolated `skills/` dir (today).
 * allow-native skips creating that empty clamp so native skills are not
 * actively wiped by the seat home builder.
 */
export function kimiShouldEmptySkillsDir(posture: Pick<ProviderHarnessPosture, 'skills'>): boolean {
  return posture.skills !== 'allow-native'
}

export function harnessPostureProviders(): readonly HarnessProviderId[] {
  return ALL_PROVIDER_IDS
}
