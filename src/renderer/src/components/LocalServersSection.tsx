import { useMemo, useState, type JSX } from 'react'
import { localServerWorkspaceLabel } from '../../../shared/localServerWorkspaceLabel'
import { useLocalServers } from '../hooks/useLocalServers'
import { SidebarOverflowMenu } from './SidebarOverflowMenu'

/** Right-chevron matching the other sidebar section headers. */
function SectionChevron({ isExpanded }: { isExpanded: boolean }): JSX.Element {
  return (
    <span
      className={`sf-symbol-icon sidebar-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.2 4.7 10 8.1 6.2 11.5" />
      </svg>
    </span>
  )
}

/**
 * "Local servers" sidebar section: lists dev servers running under the user's
 * workspaces with one-click Stop. Hidden entirely when nothing is running
 * (like the update pill), so it costs zero space in the common case.
 */
export function LocalServersSection(): JSX.Element | null {
  const { servers, busy, stop, stopAll } = useLocalServers()
  const [collapsed, setCollapsed] = useState(false)
  const headerMenuItems = useMemo(
    () => [
      {
        id: 'local-servers-stop-all',
        label: 'Stop all servers',
        onSelect: () => {
          if (window.confirm(`Stop all ${servers.length} local server(s)?`)) void stopAll()
        },
        disabled: busy,
        danger: true,
        group: 'destructive' as const
      }
    ],
    [busy, servers.length, stopAll]
  )

  if (servers.length === 0) return null

  return (
    <div className="sidebar-local-servers-section">
      <div className="sidebar-section-header">
        <button
          type="button"
          className="sidebar-section-header-toggle"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand Local Servers' : 'Collapse Local Servers'}
        >
          <SectionChevron isExpanded={!collapsed} />
          <h4 className="sidebar-section-title">Local Servers</h4>
        </button>
        <span className="sidebar-local-servers-count">{servers.length}</span>
        <SidebarOverflowMenu
          triggerLabel="Local servers actions"
          alwaysVisible
          className="sidebar-section-header-action"
          items={headerMenuItems}
        />
      </div>
      {!collapsed && (
        <div className="sidebar-local-servers-list">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`sidebar-local-server-row ${server.origin === 'agent-spawned' ? 'is-agent' : ''}`}
              title={server.command || server.name}
            >
              <span className="sidebar-local-server-main">
                <span className="sidebar-local-server-name">{server.name}</span>
                {localServerWorkspaceLabel(server) && (
                  <span className="sidebar-local-server-workspace">
                    {localServerWorkspaceLabel(server)}
                  </span>
                )}
              </span>
              {server.origin === 'agent-spawned' && (
                <span className="sidebar-local-server-badge" title="Started by a TaskWraith agent">
                  agent
                </span>
              )}
              {server.primaryPort != null && (
                <button
                  type="button"
                  className="sidebar-local-server-port"
                  onClick={() =>
                    void window.api.openExternalOrPath(`http://localhost:${server.primaryPort}`)
                  }
                  title={`Open http://localhost:${server.primaryPort}`}
                >
                  :{server.primaryPort}
                </button>
              )}
              <button
                type="button"
                className="sidebar-local-server-stop"
                onClick={() => void stop(server.pid)}
                disabled={busy}
                title={`Stop ${server.name} (pid ${server.pid})`}
                aria-label={`Stop ${server.name}`}
              >
                Stop
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
