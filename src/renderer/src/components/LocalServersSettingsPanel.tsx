import { useEffect, useMemo, useState, type JSX } from 'react'
import { localServerWorkspaceLabel } from '../../../shared/localServerWorkspaceLabel'
import { useLocalServers } from '../hooks/useLocalServers'
import type { LocalServerEntry } from '../../../main/localServers/types'

interface WorkspaceGroup {
  key: string
  label: string
  servers: LocalServerEntry[]
}

function groupByWorkspace(servers: LocalServerEntry[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const server of servers) {
    const key = server.workspacePath || server.workspaceId || 'unknown'
    const label = localServerWorkspaceLabel(server) || 'Other'
    if (!groups.has(key)) groups.set(key, { key, label, servers: [] })
    groups.get(key)?.servers.push(server)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Settings → Local servers. The persistent home for the dev-server list
 * (grouped by workspace) plus the lifecycle toggles. Shares the same live data
 * as the sidebar section via useLocalServers.
 */
export function LocalServersSettingsPanel(): JSX.Element {
  const { servers, snapshot, busy, stop, stopAll, refresh } = useLocalServers()
  const [detach, setDetach] = useState(false)
  const [stopOnQuit, setStopOnQuit] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const settings = await window.api.getSettings()
        setDetach(Boolean(settings?.localServersDetachSpawns))
        setStopOnQuit(Boolean(settings?.localServersStopOnQuit))
      } catch {
        // ignore
      }
    })()
  }, [])

  const groups = useMemo(() => groupByWorkspace(servers), [servers])

  const updateDetach = (next: boolean): void => {
    setDetach(next)
    void window.api.updateSettings({ localServersDetachSpawns: next }).catch(() => {})
  }
  const updateStopOnQuit = (next: boolean): void => {
    setStopOnQuit(next)
    void window.api.updateSettings({ localServersStopOnQuit: next }).catch(() => {})
  }

  return (
    <div className="settings-local-servers">
      <h3 className="settings-local-servers-title">Local servers</h3>
      <p className="settings-local-servers-intro">
        Dev servers and watchers (Next.js, Vite, and friends) running under your workspaces — the
        ones agents start to test changes, plus any you started yourself. Stop the stragglers so
        they stop holding ports and memory in the background.
      </p>

      <label className="settings-local-servers-toggle">
        <input
          type="checkbox"
          checked={detach}
          onChange={(event) => updateDetach(event.target.checked)}
        />
        <span>
          <strong>Run agent commands in their own process group</strong>
          <span className="settings-local-servers-toggle-hint">
            Lets Stop kill the whole tree (npm → node → workers), not just the wrapper. Off by
            default.
          </span>
        </span>
      </label>

      <label className="settings-local-servers-toggle">
        <input
          type="checkbox"
          checked={stopOnQuit}
          onChange={(event) => updateStopOnQuit(event.target.checked)}
        />
        <span>
          <strong>Stop agent-spawned servers when TaskWraith quits</strong>
          <span className="settings-local-servers-toggle-hint">
            Tidies up the servers TaskWraith&apos;s agents started. Off by default.
          </span>
        </span>
      </label>

      <div className="settings-local-servers-list-header">
        <span className="settings-local-servers-list-count">
          {servers.length} server{servers.length === 1 ? '' : 's'} running
        </span>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        {servers.length > 0 && (
          <button
            type="button"
            className="settings-local-servers-stop-all"
            onClick={() => {
              if (window.confirm(`Stop all ${servers.length} local server(s)?`)) void stopAll()
            }}
            disabled={busy}
          >
            Stop all
          </button>
        )}
      </div>

      {snapshot && !snapshot.detectionAvailable && (
        <p className="settings-local-servers-note">
          Automatic detection isn&apos;t available on this platform — only servers started by
          TaskWraith agents are shown here.
        </p>
      )}

      {servers.length === 0 ? (
        <p className="settings-local-servers-empty">No local servers detected.</p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="settings-local-servers-group">
            <h4 className="settings-local-servers-group-title">{group.label}</h4>
            {group.servers.map((server) => (
              <div key={server.id} className="settings-local-server-row">
                <span className="settings-local-server-name">{server.name}</span>
                {server.origin === 'agent-spawned' && (
                  <span className="settings-local-server-badge">agent</span>
                )}
                <span className="settings-local-server-cmd" title={server.command}>
                  {server.command}
                </span>
                {server.primaryPort != null && (
                  <button
                    type="button"
                    className="settings-local-server-port"
                    onClick={() =>
                      void window.api.openExternalOrPath(`http://localhost:${server.primaryPort}`)
                    }
                  >
                    :{server.primaryPort}
                  </button>
                )}
                <button
                  type="button"
                  className="settings-local-server-stop"
                  onClick={() => void stop(server.pid)}
                  disabled={busy}
                >
                  Stop
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
