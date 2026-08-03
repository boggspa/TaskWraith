import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import {
  normalizeWorkspacePath,
  resolveComposerEffectiveWorkspacePath,
  type ComposerWorktreeSelection
} from '../lib/composerWorktreeSelection'

export interface WorkspaceStatsContext {
  chatId: string
  baseWorkspacePath: string
  workspacePath: string
  label: string
  snapshot: GitRepositorySnapshot | null
}

export function buildWorkspaceStatsContext(input: {
  chatId?: string | null
  baseWorkspacePath?: string | null
  worktreeSelection?: ComposerWorktreeSelection | null
  snapshot?: GitRepositorySnapshot | null
  label?: string | null
  isGlobalChat?: boolean
}): WorkspaceStatsContext | undefined {
  if (!input.chatId || input.isGlobalChat) return undefined
  const basePath = normalizeWorkspacePath(
    input.baseWorkspacePath || input.snapshot?.requestedPath || ''
  )
  const workspacePath = normalizeWorkspacePath(
    resolveComposerEffectiveWorkspacePath(basePath, input.worktreeSelection) || ''
  )
  if (!workspacePath) return undefined
  const snapshotPath = normalizeWorkspacePath(input.snapshot?.requestedPath || '')
  const snapshot = snapshotPath === workspacePath ? input.snapshot || null : null
  const label =
    snapshot?.branch ||
    input.worktreeSelection?.label ||
    input.label?.trim() ||
    workspacePath.split('/').filter(Boolean).pop() ||
    workspacePath
  return { chatId: input.chatId, baseWorkspacePath: basePath, workspacePath, label, snapshot }
}
