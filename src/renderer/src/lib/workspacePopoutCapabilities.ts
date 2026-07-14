export interface WorkspacePopoutRefreshCapability {
  externalWriteAllowed?: boolean
}

export function popoutAllowsGitMutations(
  chatId: string,
  writeParam: string | null
): boolean {
  return !chatId || writeParam === '1'
}

export function refreshPopoutGitMutationCapability(
  chatId: string,
  current: boolean,
  payload: WorkspacePopoutRefreshCapability
): boolean {
  if (!chatId) return true
  return typeof payload.externalWriteAllowed === 'boolean'
    ? payload.externalWriteAllowed
    : current
}
