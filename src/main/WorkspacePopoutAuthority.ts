import type { WorkspacePopoutKind } from './index.types'

export interface WorkspacePopoutAuthority {
  kind: WorkspacePopoutKind
  workspacePath?: string
  chatId?: string
  externalWriteAllowed?: boolean
}

function ownerMayOpenKind(
  ownerKind: WorkspacePopoutKind,
  requestedKind: WorkspacePopoutKind
): boolean {
  switch (ownerKind) {
    case 'chat':
      return requestedKind === 'chat' || requestedKind === 'diff-studio'
    case 'diff-studio':
      return requestedKind === 'diff-studio'
    case 'file-editor':
    case 'workbench':
      return (
        requestedKind === 'file-editor' ||
        requestedKind === 'workbench' ||
        requestedKind === 'diff-studio'
      )
  }
}

/**
 * A secondary renderer may open a child workspace surface only inside the
 * authority that main assigned to that exact popout. Request payloads are not
 * capabilities: matching a registered workspace or an existing chat is not
 * enough to broaden a popout into another workspace/chat.
 */
export function assertWorkspacePopoutRequestWithinOwner(
  owner: WorkspacePopoutAuthority,
  requested: WorkspacePopoutAuthority,
  canonicalizePath: (value: string) => string
): void {
  const requestedChatId = requested.chatId?.trim()
  if (requested.kind === 'chat' && (!requestedChatId || owner.chatId !== requestedChatId)) {
    throw new Error('Renderer cannot open a chat outside its popout authority.')
  }
  if (requestedChatId && owner.chatId !== requestedChatId) {
    throw new Error('Renderer cannot open a workspace view for another chat.')
  }

  const requestedWorkspacePath = requested.workspacePath?.trim()
  if (requestedWorkspacePath) {
    const ownerWorkspacePath = owner.workspacePath?.trim()
    if (!ownerWorkspacePath) {
      throw new Error('Renderer has no workspace authority for this popout request.')
    }
    let requestedCanonical: string
    let ownerCanonical: string
    try {
      requestedCanonical = canonicalizePath(requestedWorkspacePath)
      ownerCanonical = canonicalizePath(ownerWorkspacePath)
    } catch {
      throw new Error('Renderer workspace authority could not be resolved.')
    }
    if (requestedCanonical !== ownerCanonical) {
      throw new Error('Renderer cannot open a popout for another workspace.')
    }
  } else if (requested.kind !== 'chat') {
    throw new Error('Workspace popout request has no workspace authority.')
  }
  if (!ownerMayOpenKind(owner.kind, requested.kind)) {
    throw new Error('Renderer cannot open a popout with broader authority.')
  }
}

export function assertWorkspacePopoutChatRequestWithinOwner(
  owner: WorkspacePopoutAuthority,
  chatId: string
): void {
  const requestedChatId = chatId.trim()
  if (owner.kind !== 'chat' || !requestedChatId || owner.chatId !== requestedChatId) {
    throw new Error('Renderer cannot act on another chat.')
  }
}
