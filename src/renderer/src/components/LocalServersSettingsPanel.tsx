import { useEffect, useMemo, useState, type JSX } from 'react'
import { localServerWorkspaceLabel } from '../../../shared/localServerWorkspaceLabel'
import { useWorkspaceLaunchTargets } from '../hooks/useWorkspaceLaunchTargets'
import { useLocalServers } from '../hooks/useLocalServers'
import type { LaunchTarget } from '../../../main/launchTargets/types'
import type { DeclaredLocalService, LocalServerEntry } from '../../../main/localServers/types'
import type { ProviderId, WorkspaceRecord } from '../../../main/store/types'

interface WorkspaceGroup {
  key: string
  label: string
  servers: LocalServerEntry[]
}

interface LocalServersSettingsPanelProps {
  workspaces?: WorkspaceRecord[]
  activeProvider?: ProviderId
}

interface ServiceLaunchMatch {
  workspace: WorkspaceRecord
  target: LaunchTarget
  hint: string
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

function normalizeLaunchHint(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function launchTargetMatchesHint(target: LaunchTarget, hint: string): boolean {
  const normalizedHint = normalizeLaunchHint(hint)
  if (!normalizedHint) return false
  const searchable = [
    target.id,
    target.label,
    target.subtitle,
    target.source,
    target.kind,
    target.platform,
    target.command?.raw
  ]
    .map(normalizeLaunchHint)
    .filter(Boolean)
  return searchable.some((value) => value === normalizedHint || value.includes(normalizedHint))
}

function scoreLaunchTarget(target: LaunchTarget, hint: string): number {
  const normalizedHint = normalizeLaunchHint(hint)
  const label = normalizeLaunchHint(target.label)
  return (
    (target.id === hint ? 1000 : 0) +
    (label === normalizedHint ? 600 : 0) +
    (target.kind === 'dev-server' || target.kind === 'preview' ? 80 : 0) +
    (target.command?.longRunning ? 40 : 0) +
    target.confidence * 20
  )
}

function findServiceLaunchMatch(
  service: DeclaredLocalService,
  workspaces: WorkspaceRecord[],
  targetsForWorkspace: (workspacePath: string | null | undefined) => LaunchTarget[]
): ServiceLaunchMatch | null {
  if (!service.managedByTaskWraith) return null
  const hints = (service.launchTargetHints || []).map((hint) => hint.trim()).filter(Boolean)
  if (hints.length === 0) return null
  const matches: Array<ServiceLaunchMatch & { score: number }> = []
  for (const workspace of workspaces) {
    for (const target of targetsForWorkspace(workspace.path)) {
      if (!target.command || target.blockers.length > 0) continue
      const hint = hints.find((item) => launchTargetMatchesHint(target, item))
      if (!hint) continue
      matches.push({ workspace, target, hint, score: scoreLaunchTarget(target, hint) })
    }
  }
  matches.sort((a, b) => b.score - a.score || a.target.label.localeCompare(b.target.label))
  return matches[0] || null
}

/**
 * Settings → Local servers. The persistent home for the dev-server list
 * (grouped by workspace) plus the lifecycle toggles. Shares the same live data
 * as the sidebar section via useLocalServers.
 */
export function LocalServersSettingsPanel({
  workspaces = [],
  activeProvider = 'codex'
}: LocalServersSettingsPanelProps): JSX.Element {
  const { servers, snapshot, busy, stop, stopAll, refresh } = useLocalServers()
  const workspacePaths = useMemo(() => workspaces.map((workspace) => workspace.path), [workspaces])
  const launchTargets = useWorkspaceLaunchTargets(workspacePaths)
  const [detach, setDetach] = useState(false)
  const [stopOnQuit, setStopOnQuit] = useState(false)
  const [startingServiceId, setStartingServiceId] = useState<string | null>(null)

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
  const declaredServices: DeclaredLocalService[] = snapshot?.declaredServices || []

  const startDeclaredService = async (
    service: DeclaredLocalService,
    match: ServiceLaunchMatch
  ): Promise<void> => {
    if (typeof window.api.launchStart !== 'function') return
    setStartingServiceId(service.id)
    try {
      const result = await window.api.launchStart({
        workspacePath: match.target.workspacePath,
        targetId: match.target.id,
        provider: activeProvider
      })
      if (!result?.ok) {
        window.alert(result?.error || 'Launch target did not start.')
        return
      }
      await Promise.all([refresh(), launchTargets.refresh(match.target.workspacePath)])
    } finally {
      setStartingServiceId(null)
    }
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

      {declaredServices.length > 0 && (
        <div className="settings-local-servers-group">
          <h4 className="settings-local-servers-group-title">Plugin service declarations</h4>
          {declaredServices.map((service) => {
            const launchMatch = findServiceLaunchMatch(
              service,
              workspaces,
              launchTargets.targetsForWorkspace
            )
            const serviceMetadata = [
              service.pluginProvenance?.pluginId || 'plugin',
              service.healthCheck?.url || service.healthCheck?.commandHint || 'health metadata',
              service.managedByTaskWraith
                ? launchMatch
                  ? `launch ${launchMatch.workspace.displayName}: ${launchMatch.target.label}`
                  : 'no matching launch target'
                : 'external'
            ].join(' · ')
            return (
              <div key={service.id} className="settings-local-server-row">
                <span className="settings-local-server-name">{service.label}</span>
                <span className="settings-local-server-badge">{service.status}</span>
                <span className="settings-local-server-cmd" title={service.description || service.id}>
                  {serviceMetadata}
                </span>
                {service.ports[0] != null && (
                  <button
                    type="button"
                    className="settings-local-server-port"
                    onClick={() =>
                      void window.api.openExternalOrPath(`http://localhost:${service.ports[0]}`)
                    }
                  >
                    :{service.ports[0]}
                  </button>
                )}
                {service.managedByTaskWraith && (
                  <button
                    type="button"
                    className="settings-local-server-start"
                    title={
                      launchMatch
                        ? `Start ${launchMatch.target.label} in ${launchMatch.workspace.displayName}`
                        : 'No matching launch target found in loaded workspaces.'
                    }
                    onClick={() => {
                      if (launchMatch) void startDeclaredService(service, launchMatch)
                    }}
                    disabled={
                      busy || launchTargets.busy || !launchMatch || startingServiceId === service.id
                    }
                  >
                    {startingServiceId === service.id ? 'Starting' : 'Start'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
