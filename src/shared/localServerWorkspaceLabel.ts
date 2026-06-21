import type { LocalServerEntry } from '../main/localServers/types'
import { formatWorkspaceDisplayName, pathBasename } from './workspaceDisplayName'

/** Normalize a workspace label for Local Servers UI (sidebar + settings). */
export function formatLocalServerWorkspaceLabel(raw: string | undefined): string {
  return formatWorkspaceDisplayName(raw)
}

/** Resolve the subtitle shown under each detected local server row. */
export function localServerWorkspaceLabel(
  entry: Pick<LocalServerEntry, 'workspaceName' | 'workspacePath'>
): string {
  if (entry.workspaceName) return formatLocalServerWorkspaceLabel(entry.workspaceName)
  const path = entry.workspacePath
  if (!path) return ''
  return formatLocalServerWorkspaceLabel(pathBasename(path))
}
