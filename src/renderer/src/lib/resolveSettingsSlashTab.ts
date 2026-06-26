import type { SettingsTab, SettingsTabDefinition } from '../components/SettingsPanel'

export interface ResolveSettingsSlashTabOptions {
  settingsTabs: readonly SettingsTabDefinition[]
  defaultTab?: SettingsTab
  isTabVisible?: (tab: SettingsTab) => boolean
}

const DEFAULT_SETTINGS_TAB: SettingsTab = 'appearance'
const FALLBACK_SETTINGS_TAB: SettingsTab = 'behavior'

function normalizeSettingsQuery(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreMatch(haystack: string, query: string): number {
  if (!haystack) return 0
  if (haystack === query) return 100
  if (haystack.startsWith(query)) return 80
  if (haystack.includes(query)) return 60
  return 0
}

function scoreSettingsTab(tab: SettingsTabDefinition, query: string): number {
  let score = 0
  const haystackLabel = normalizeSettingsQuery(tab.label)
  const haystackDescription = normalizeSettingsQuery(tab.description)
  const haystackId = normalizeSettingsQuery(tab.id)

  score += scoreMatch(haystackLabel, query)
  score += scoreMatch(haystackId, query) * 0.5

  if (haystackDescription) {
    score += scoreMatch(haystackDescription, query) * 0.25
  }

  for (const alias of tab.aliases) {
    score += scoreMatch(normalizeSettingsQuery(alias), query)
  }

  return score
}

function resolveVisibleTab(
  tab: SettingsTab,
  fallback: SettingsTab,
  isTabVisible: (tab: SettingsTab) => boolean
): SettingsTab {
  return isTabVisible(tab) ? tab : fallback
}

export function resolveSettingsTabFromSlashArg(
  settingsArg: string,
  {
    settingsTabs,
    defaultTab = DEFAULT_SETTINGS_TAB,
    isTabVisible = () => true
  }: ResolveSettingsSlashTabOptions
): SettingsTab {
  const query = normalizeSettingsQuery(settingsArg)
  const fallback = FALLBACK_SETTINGS_TAB

  if (!query) {
    return resolveVisibleTab(defaultTab, fallback, isTabVisible)
  }

  const best = settingsTabs
    .map((tab) => ({ tab, score: scoreSettingsTab(tab, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tab.id.localeCompare(b.tab.id))[0]

  if (!best) {
    return resolveVisibleTab(defaultTab, fallback, isTabVisible)
  }

  return resolveVisibleTab(best.tab.id, fallback, isTabVisible)
}
