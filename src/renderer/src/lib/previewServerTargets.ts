import type { LocalServerEntry } from '../../../main/localServers/types'
import { localServerWorkspaceLabel } from '../../../shared/localServerWorkspaceLabel'

export interface PreviewServerTarget {
  id: string
  label: string
  subtitle: string
  url: string
  port: number
  server: LocalServerEntry
}

function normalizeWorkspacePath(value: string | null | undefined): string {
  if (!value) return ''
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:/i.test(normalized)) return normalized.toLowerCase()
  return normalized
}

function pathIsInside(candidate: string | null | undefined, root: string): boolean {
  const normalizedCandidate = normalizeWorkspacePath(candidate)
  if (!normalizedCandidate || !root) return false
  return normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`)
}

function previewServerRank(server: LocalServerEntry, workspacePath: string): number {
  const workspaceMatch = normalizeWorkspacePath(server.workspacePath) === workspacePath ? 0 : 1
  const originRank = server.origin === 'agent-spawned' ? 0 : 1
  const portRank = server.primaryPort ?? Number.MAX_SAFE_INTEGER
  return workspaceMatch * 1_000_000 + originRank * 10_000 + portRank
}

export function buildPreviewServerTargets(
  servers: LocalServerEntry[],
  workspacePath: string | null | undefined
): PreviewServerTarget[] {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath)
  if (!normalizedWorkspace) return []

  return servers
    .filter((server) => {
      if (server.primaryPort == null || !Number.isFinite(server.primaryPort)) return false
      return (
        normalizeWorkspacePath(server.workspacePath) === normalizedWorkspace ||
        pathIsInside(server.cwd, normalizedWorkspace)
      )
    })
    .slice()
    .sort(
      (a, b) => previewServerRank(a, normalizedWorkspace) - previewServerRank(b, normalizedWorkspace)
    )
    .map((server) => {
      const port = server.primaryPort as number
      const workspaceLabel = localServerWorkspaceLabel(server)
      const subtitleParts = [
        workspaceLabel,
        server.origin === 'agent-spawned' ? 'agent-spawned' : 'detected',
        `pid ${server.pid}`
      ].filter(Boolean)
      return {
        id: server.id,
        label: `${server.name || 'Local server'} :${port}`,
        subtitle: subtitleParts.join(' · '),
        url: `http://localhost:${port}`,
        port,
        server
      }
    })
}
