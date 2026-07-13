export interface WorkspaceTrustOwner {
  generation: number
  workspaceId: string | null
  workspacePath: string | null
}

/**
 * A trust probe is renderer-global state, so its result may only publish while
 * the workspace identity and request generation that launched it still own the
 * focused surface. The path check protects imported/recreated workspace records
 * that reuse an id, while the generation rejects out-of-order probes for the
 * same workspace.
 */
export function isCurrentWorkspaceTrustOwner(
  request: WorkspaceTrustOwner,
  current: WorkspaceTrustOwner
): boolean {
  return (
    request.generation === current.generation &&
    request.workspaceId === current.workspaceId &&
    request.workspacePath === current.workspacePath
  )
}
