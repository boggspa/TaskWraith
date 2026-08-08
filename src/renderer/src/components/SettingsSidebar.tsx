/**
 * SettingsSidebar — minimal Codex-style left-rail for the Settings
 * full-app takeover. When the user opens Settings (via the workspace
 * sidebar footer or the FirstLaunchSheet), App.tsx swaps the regular
 * `<Sidebar />` for this component and the transcript pane for the
 * SettingsPanel rendered in `layout="takeover"` mode.
 *
 * Visual reference: Codex CLI / Claude Code app — compact settings
 * rail with a direct back affordance. TaskWraith adds search and
 * grouped IA because the settings surface is broader than a single
 * provider app.
 *
 * Tab labels and ids stay canonical in `SettingsPanel.tsx` via the
 * exported `SETTINGS_TABS` constant — this component re-uses that
 * list so the two render sites can't drift when tabs are added or
 * renamed in the future.
 */
import { useMemo, useState } from 'react'
import {
  SETTINGS_TAB_GROUP_LABELS,
  getVisibleSettingsTabs,
  resolveVisibleSettingsTab,
  settingsTabMatchesQuery,
  type SettingsTabDefinition,
  type SettingsTabGroup,
  type SettingsTab
} from './SettingsPanel'

interface SettingsSidebarProps {
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBackToApp: () => void
  appVersion?: string
  /** Open/close transition classes from `usePanelPresence` (App.tsx). */
  animationClassName?: string
}

function ArrowLeftSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9.5 4.2 5.5 8l4 3.8" />
        <path d="M5.7 8h6" />
      </svg>
    </span>
  )
}

function SearchSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="7" cy="7" r="4" />
        <path d="m10.2 10.2 3.1 3.1" />
      </svg>
    </span>
  )
}

function SettingsTabSymbolIcon({ tab }: { tab: SettingsTab }) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.35,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  const icon =
    tab === 'behavior' ? (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.9v2M8 12.1v2M1.9 8h2M12.1 8h2M3.7 3.7l1.4 1.4M10.9 10.9l1.4 1.4M12.3 3.7l-1.4 1.4M5.1 10.9l-1.4 1.4" />
      </svg>
    ) : tab === 'appearance' ? (
      <svg {...common}>
        <path d="M3 10.4A5.5 5.5 0 1 1 8.7 14H7.2a1.1 1.1 0 0 1-.8-1.9l.4-.4a1 1 0 0 0-.7-1.7H4.4A1.8 1.8 0 0 1 3 10.4Z" />
        <path d="M5.1 6.4h.1M7.7 4.8h.1M10.4 6h.1M10.1 9h.1" />
      </svg>
    ) : tab === 'key-commands' ? (
      <svg {...common}>
        <rect x="2" y="4" width="12" height="8.2" rx="1.6" />
        <path d="M4.5 6.6h.1M6.8 6.6h.1M9.1 6.6h.1M11.4 6.6h.1M4.5 9.4h3.8M9.7 9.4h1.8" />
      </svg>
    ) : tab === 'providers' ? (
      <svg {...common}>
        <path d="M8 2.2 13 5v6L8 13.8 3 11V5Z" />
        <path d="M8 2.2V8l5 3M8 8l-5 3" />
      </svg>
    ) : tab === 'roster' ? (
      <svg {...common}>
        <circle cx="5" cy="5.2" r="1.6" />
        <circle cx="11" cy="5.2" r="1.6" />
        <path d="M2.8 12.4c.4-2 1.2-3 2.2-3s1.8 1 2.2 3M8.8 12.4c.4-2 1.2-3 2.2-3s1.8 1 2.2 3" />
      </svg>
    ) : tab === 'approval-ledger' ? (
      <svg {...common}>
        <path d="M8 2.2 12.8 4v3.4c0 3-1.8 5.2-4.8 6.4-3-1.2-4.8-3.4-4.8-6.4V4Z" />
        <path d="m5.8 8 1.4 1.4 3-3.2" />
      </svg>
    ) : tab === 'safety-privacy' ? (
      <svg {...common}>
        <path d="M8 2.2 12.7 4v3.5c0 2.8-1.7 5-4.7 6.3-3-1.3-4.7-3.5-4.7-6.3V4Z" />
        <path d="M5.3 8.1c.8-1.3 1.7-1.9 2.7-1.9s1.9.6 2.7 1.9c-.8 1.3-1.7 1.9-2.7 1.9S6.1 9.4 5.3 8.1Z" />
        <circle cx="8" cy="8.1" r=".8" />
      </svg>
    ) : tab === 'mcp' ? (
      <svg {...common}>
        <path d="M4.2 5.2h3.2v3.2H4.2zM8.6 7.6h3.2v3.2H8.6z" />
        <path d="M7.4 6.8h1.2M5.8 8.4v2.2h2.8" />
      </svg>
    ) : tab === 'mcp-servers' ? (
      <svg {...common}>
        <rect x="2.6" y="2.8" width="10.8" height="3.4" rx="1" />
        <rect x="2.6" y="9.8" width="10.8" height="3.4" rx="1" />
        <path d="M5 4.5h.1M5 11.5h.1M8 6.2v3.6M5.2 8h5.6" />
      </svg>
    ) : tab === 'plugins' ? (
      <svg {...common}>
        <path d="M6.4 2.4h3.2v3.2H6.4zM2.8 8.8H6v3.2H2.8zM10 8.8h3.2v3.2H10z" />
        <path d="M8 5.6v1.7M6 10.4H4.4M10 10.4h1.6M6 10.4h4" />
      </svg>
    ) : tab === 'skills' ? (
      <svg {...common}>
        <path d="M4 2.8h6.2L12.4 5v8.2H4z" />
        <path d="M10.2 2.8V5h2.2M5.6 7.4h4.8M5.6 9.6h4.8M5.6 11.8h3.2" />
      </svg>
    ) : tab === 'hooks' ? (
      <svg {...common}>
        <path d="M5.2 3.2v5.2a2.8 2.8 0 1 0 2.8 2.8" />
        <path d="M5.2 5.4h3.4M10.8 3.8v2.4h2" />
      </svg>
    ) : tab === 'local-servers' ? (
      <svg {...common}>
        <rect x="2.6" y="3" width="10.8" height="3.5" rx="1" />
        <rect x="2.6" y="9.5" width="10.8" height="3.5" rx="1" />
        <path d="M5 4.8h.1M5 11.2h.1M8 6.5v3" />
      </svg>
    ) : tab === 'pairing' ? (
      <svg {...common}>
        <rect x="4.5" y="1.8" width="7" height="12.4" rx="1.5" />
        <path d="M7 3.7h2M7.3 12.2h1.4" />
      </svg>
    ) : tab === 'shares' ? (
      <svg {...common}>
        <circle cx="8" cy="3.7" r="1.85" />
        <circle cx="3.9" cy="12.1" r="1.85" />
        <circle cx="12.1" cy="12.1" r="1.85" />
        <path d="M6.8 5.2 5.1 10.5" />
        <path d="M9.2 5.2 10.9 10.5" />
      </svg>
    ) : tab === 'workspaces' ? (
      <svg {...common}>
        <path d="M2.5 5.2h4l1 1.3h6v5.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2Z" />
        <path d="M2.5 5.2V3.7a1.1 1.1 0 0 1 1.1-1.1h3.1l1 1.2h4.7a1.1 1.1 0 0 1 1.1 1.1v1.6" />
      </svg>
    ) : tab === 'pinned-messages' ? (
      <svg {...common}>
        <path d="m9.8 2.4 3.8 3.8-2.1 1.2-.8 3-1.5-1.5-3.8 3.8-2.1-2.1 3.8-3.8-1.5-1.5 3-.8Z" />
      </svg>
    ) : tab === 'archived' ? (
      <svg {...common}>
        <path d="M3 5.1h10v8H3z" />
        <path d="M2.4 3h11.2l.5 2.1H1.9Z" />
        <path d="M6 8.5h4" />
      </svg>
    ) : tab === 'model-usage' ? (
      <svg {...common}>
        <path d="M3 12.8V7.2M6.3 12.8V4.8M9.7 12.8V6.5M13 12.8V3.2" />
      </svg>
    ) : (
      <svg {...common}>
        <path d="M3 4.4h10M3 8h10M3 11.6h10" />
      </svg>
    )
  return <span className="settings-sidebar-tab-icon">{icon}</span>
}

function groupTabs(tabs: SettingsTabDefinition[]): Array<{
  group: SettingsTabGroup
  tabs: SettingsTabDefinition[]
}> {
  const groups: Array<{ group: SettingsTabGroup; tabs: SettingsTabDefinition[] }> = []
  for (const tab of tabs) {
    const last = groups[groups.length - 1]
    if (last?.group === tab.group) {
      last.tabs.push(tab)
    } else {
      groups.push({ group: tab.group, tabs: [tab] })
    }
  }
  return groups
}

export function SettingsSidebar({
  activeTab,
  onTabChange,
  onBackToApp,
  appVersion,
  animationClassName = ''
}: SettingsSidebarProps) {
  const [query, setQuery] = useState('')
  const visibleVersion = appVersion && appVersion !== 'unknown' ? appVersion : null
  const visibleSettingsTabs = getVisibleSettingsTabs()
  const resolvedActiveTab = resolveVisibleSettingsTab(activeTab)
  const filteredTabs = useMemo(
    () => visibleSettingsTabs.filter((tab) => settingsTabMatchesQuery(tab, query)),
    [query, visibleSettingsTabs]
  )
  const groupedTabs = useMemo(() => groupTabs(filteredTabs), [filteredTabs])
  const trimmedQuery = query.trim()

  return (
    <aside
      className={`app-sidebar settings-sidebar${animationClassName ? ` ${animationClassName}` : ''}`}
      aria-label="Settings navigation"
    >
      <div className="settings-sidebar-inner">
        <button
          type="button"
          className="settings-sidebar-back"
          onClick={onBackToApp}
          title="Return to the chat surface"
        >
          <ArrowLeftSymbolIcon />
          <span>Back to app</span>
        </button>
        <label className="settings-sidebar-search">
          <span className="settings-sidebar-search-icon">
            <SearchSymbolIcon />
          </span>
          <span className="sr-only">Search settings</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings..."
            aria-label="Search settings"
          />
        </label>
        <nav className="settings-sidebar-tabs" role="tablist" aria-label="Settings sections">
          {groupedTabs.map(({ group, tabs }) => (
            <section key={group} className="settings-sidebar-group">
              <div className="settings-sidebar-group-label">{SETTINGS_TAB_GROUP_LABELS[group]}</div>
              {tabs.map((tab) => {
                return (
                  <span key={tab.id} className="settings-sidebar-tab-slot">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={resolvedActiveTab === tab.id}
                      className={`settings-sidebar-tab ${resolvedActiveTab === tab.id ? 'active' : ''}`}
                      onClick={() => onTabChange(tab.id)}
                      title={tab.description}
                    >
                      <SettingsTabSymbolIcon tab={tab.id} />
                      <span className="settings-sidebar-tab-label">{tab.label}</span>
                    </button>
                  </span>
                )
              })}
            </section>
          ))}
          {groupedTabs.length === 0 && (
            <div className="settings-sidebar-empty">
              No settings match{trimmedQuery ? ` "${trimmedQuery}"` : ''}.
            </div>
          )}
        </nav>
        {visibleVersion && (
          <div
            className="settings-sidebar-version"
            aria-label={`TaskWraith version ${visibleVersion}`}
          >
            TaskWraith v{visibleVersion}
          </div>
        )}
      </div>
    </aside>
  )
}
