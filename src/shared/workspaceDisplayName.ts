/** Legacy workspace display names from the AGBench -> TaskWraith rebrand. */
const LEGACY_WORKSPACE_LABELS = new Set(['AGBench', 'agbench'])

export interface WorkspaceDisplayNameSource {
  displayName?: string | null
  path?: string | null
  repoRoot?: string | null
  remoteUrl?: string | null
}

export function pathBasename(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/g, '')
  if (!trimmed) return ''
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed
}

export function formatWorkspaceDisplayName(raw: string | null | undefined): string {
  const trimmed = String(raw || '').trim()
  if (LEGACY_WORKSPACE_LABELS.has(trimmed)) return 'TaskWraith'
  return trimmed
}

export function gitRemoteProjectName(remoteUrl: string | null | undefined): string {
  const trimmed = String(remoteUrl || '').trim()
  if (!trimmed) return ''
  const withoutSuffix = trimmed.split(/[?#]/)[0].replace(/[\\/]+$/g, '')
  let candidate = ''

  try {
    const parsed = new URL(withoutSuffix)
    candidate = pathBasename(parsed.pathname)
  } catch {
    const scpLike = withoutSuffix.match(/^[^@\s]+@[^:\s]+:(.+)$/)
    candidate = pathBasename(scpLike?.[1] || withoutSuffix)
  }

  return candidate.replace(/\.git$/i, '').trim()
}

export function resolveWorkspaceDisplayName(source: WorkspaceDisplayNameSource): string {
  const rawDisplayName = String(source.displayName || '').trim()
  const displayName = formatWorkspaceDisplayName(rawDisplayName)
  const rawPathBasename = pathBasename(source.path)
  const pathLabel = formatWorkspaceDisplayName(rawPathBasename)
  const repoLabel = formatWorkspaceDisplayName(
    gitRemoteProjectName(source.remoteUrl) || pathBasename(source.repoRoot)
  )
  const displayLooksDefault =
    !rawDisplayName ||
    rawDisplayName === rawPathBasename ||
    displayName === pathLabel ||
    LEGACY_WORKSPACE_LABELS.has(rawDisplayName)

  if (repoLabel && displayLooksDefault) return repoLabel
  return displayName || repoLabel || pathLabel || 'Workspace'
}
