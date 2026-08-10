import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { RuntimeProfile } from '../../../main/store/types'

export interface ComposerWorktreeSelection {
  baseWorkspacePath: string
  effectiveWorkspacePath: string
  branch?: string
  label: string
  source: 'composer'
}

export type ComposerWorktreeSelectionByChatId = Record<string, ComposerWorktreeSelection | null>

export interface RuntimeWorktreeIntent {
  requested: boolean
  /** 'ensembleLane' / 'ephemeralFleet' are main-stamped for isolated
   * fan-out / fleet-writer lanes; the composer never produces them, but the
   * mirror must accept them on round-trips. */
  source: 'runtimeProfile' | 'composer' | 'ensembleLane' | 'ephemeralFleet'
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

/**
 * Resolve a composer's worktree only when it belongs to this exact chat and
 * still matches the chat's current canonical workspace. A chat can be rebound
 * while its renderer-local picker state is still alive; stale state must not
 * redirect the rebound chat into the old repository.
 */
export function composerWorktreeSelectionForChat(
  selections: ComposerWorktreeSelectionByChatId,
  chatId: string | null | undefined,
  baseWorkspacePath: string | null | undefined
): ComposerWorktreeSelection | null {
  if (!chatId || !baseWorkspacePath) return null
  const selection = selections[chatId]
  if (!selection) return null
  return normalizeWorkspacePath(selection.baseWorkspacePath) ===
    normalizeWorkspacePath(baseWorkspacePath)
    ? selection
    : null
}

export function updateComposerWorktreeSelectionForChat(
  selections: ComposerWorktreeSelectionByChatId,
  chatId: string,
  selection: ComposerWorktreeSelection | null
): ComposerWorktreeSelectionByChatId {
  if (!chatId) return selections
  if (!selection) {
    if (!Object.prototype.hasOwnProperty.call(selections, chatId)) return selections
    const next = { ...selections }
    delete next[chatId]
    return next
  }
  return { ...selections, [chatId]: selection }
}

/** The one path all run and Git actions for this composer must target. */
export function resolveComposerEffectiveWorkspacePath(
  baseWorkspacePath: string | null | undefined,
  selection: ComposerWorktreeSelection | null | undefined
): string | undefined {
  const basePath = normalizeWorkspacePath(baseWorkspacePath || '')
  if (!basePath) return undefined
  if (
    selection &&
    normalizeWorkspacePath(selection.baseWorkspacePath) === basePath &&
    isLinkedWorktreePath(basePath, selection.effectiveWorkspacePath)
  ) {
    return normalizeWorkspacePath(selection.effectiveWorkspacePath)
  }
  return basePath
}

/** Rebuild the immutable run intent from its snapshotted effective path. */
export function composerWorktreeSelectionFromEffectivePath(
  baseWorkspacePath: string,
  effectiveWorkspacePath: string | null | undefined
): ComposerWorktreeSelection | null {
  const basePath = normalizeWorkspacePath(baseWorkspacePath)
  const effectivePath = normalizeWorkspacePath(effectiveWorkspacePath || '')
  if (!isLinkedWorktreePath(basePath, effectivePath)) return null
  return {
    baseWorkspacePath: basePath,
    effectiveWorkspacePath: effectivePath,
    label: effectivePath.split('/').pop() || effectivePath,
    source: 'composer'
  }
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
