export interface WorkspaceDiffInspectorActions<TDiff> {
  loadDiff: (workspacePath: string) => Promise<TDiff>
  isCurrent?: () => boolean
  onOpen: () => void
  onLoaded: (diff: TDiff, workspacePath: string) => void
  onError: (message: string) => void
}

export type WorkspaceDiffInspectorResult = 'opened' | 'failed' | 'ignored'

export async function openWorkspaceDiffInspector<TDiff>(
  workspacePath: string | null | undefined,
  actions: WorkspaceDiffInspectorActions<TDiff>
): Promise<WorkspaceDiffInspectorResult> {
  const targetPath = workspacePath?.trim()
  if (!targetPath) return 'ignored'

  actions.onOpen()
  try {
    const diff = await actions.loadDiff(targetPath)
    if (actions.isCurrent && !actions.isCurrent()) return 'ignored'
    actions.onLoaded(diff, targetPath)
    return 'opened'
  } catch (error) {
    if (actions.isCurrent && !actions.isCurrent()) return 'ignored'
    actions.onError(
      error instanceof Error
        ? `Could not load workspace changes: ${error.message}`
        : 'Could not load workspace changes.'
    )
    return 'failed'
  }
}

export function withWorkspaceDiffPath<TDiff extends object>(
  diff: TDiff,
  workspacePath: string
): TDiff & { workspacePath: string } {
  return { ...diff, workspacePath }
}
