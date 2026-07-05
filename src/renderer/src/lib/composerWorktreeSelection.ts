import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { RuntimeProfile } from '../../../main/store/types'

export interface ComposerWorktreeSelection {
  baseWorkspacePath: string
  effectiveWorkspacePath: string
  branch?: string
  label: string
  source: 'composer'
}

export interface RuntimeWorktreeIntent {
  requested: boolean
  source: 'runtimeProfile' | 'composer'
  profileId?: string
  profileName?: string
  baseWorkspacePath?: string
  effectiveWorkspacePath?: string
  status: 'selection-required' | 'selected'
}

export function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\/+$/, '')
}

export function isLinkedWorktreePath(basePath: string, effectivePath: string): boolean {
  const base = normalizeWorkspacePath(basePath)
  const effective = normalizeWorkspacePath(effectivePath)
  return Boolean(base && effective && base !== effective)
}

export function resolveWorktreeSelectionFromSnapshot(
  baseWorkspacePath: string,
  snapshot: GitRepositorySnapshot | null | undefined
): ComposerWorktreeSelection | null {
  if (!snapshot?.requestedPath) return null
  const effectivePath = normalizeWorkspacePath(snapshot.requestedPath)
  const basePath = normalizeWorkspacePath(baseWorkspacePath)
  if (!isLinkedWorktreePath(basePath, effectivePath)) return null
  const branch = snapshot.branch
  const label = branch || effectivePath.split('/').pop() || effectivePath
  return {
    baseWorkspacePath: basePath,
    effectiveWorkspacePath: effectivePath,
    branch,
    label,
    source: 'composer'
  }
}

export function buildComposerRuntimeWorktreeIntent(input: {
  baseWorkspacePath: string
  selection: ComposerWorktreeSelection | null | undefined
  runtimeProfile?: RuntimeProfile | null
}): RuntimeWorktreeIntent | undefined {
  const basePath = normalizeWorkspacePath(input.baseWorkspacePath)
  const profile = input.runtimeProfile
  const profileWantsWorktree = profile?.workspaceMode === 'worktree'
  const effectivePath = input.selection?.effectiveWorkspacePath

  if (effectivePath) {
    return {
      requested: true,
      source: 'composer',
      baseWorkspacePath: basePath,
      effectiveWorkspacePath: effectivePath,
      status: 'selected',
      ...(profileWantsWorktree
        ? { profileId: profile?.id, profileName: profile?.name }
        : {})
    }
  }

  if (profileWantsWorktree) {
    return {
      requested: true,
      source: 'runtimeProfile',
      profileId: profile?.id,
      profileName: profile?.name,
      baseWorkspacePath: basePath,
      status: 'selection-required'
    }
  }

  return undefined
}

export function worktreeSelectionRequiredWarning(intent?: RuntimeWorktreeIntent | null): string | null {
  if (!intent?.requested || intent.status !== 'selection-required') return null
  const profile = intent.profileName ? ` (${intent.profileName})` : ''
  return `Runtime profile${profile} requires an isolated worktree. Open Branch & worktree above and create or select one before running.`
}