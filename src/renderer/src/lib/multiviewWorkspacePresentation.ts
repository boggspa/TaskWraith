export interface PathKeyedWorkspaceSnapshot {
  requestedPath?: string | null
}

/**
 * Store an action result under the workspace path that produced it. A focused
 * composer survives pane switches, so a slow response may arrive after focus
 * has moved. Null/error responses have no authoritative path and deliberately
 * retain the last subscription-owned value instead of clearing another pane.
 */
export function updatePathKeyedWorkspaceSnapshot<
  TSnapshot extends PathKeyedWorkspaceSnapshot
>(
  previous: Record<string, TSnapshot | null>,
  focusedWorkspacePath: string,
  snapshot: TSnapshot | null
): Record<string, TSnapshot | null> {
  if (!snapshot) return previous
  const ownerPath = snapshot.requestedPath?.trim() || focusedWorkspacePath
  if (!ownerPath) return previous
  return { ...previous, [ownerPath]: snapshot }
}
