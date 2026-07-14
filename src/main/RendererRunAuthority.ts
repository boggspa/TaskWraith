import type { AgentRunPayload } from './run/AgentRunTypes'
import type { ChatRecord } from './store/types'
import type { WorkspacePopoutAuthority } from './WorkspacePopoutAuthority'

const RENDERER_RUN_AUTHORITY_ERROR = 'Renderer run authority does not match its owning chat.'
const RUNTIME_WORKTREE_BASE_AUTHORITY_ERROR =
  'Runtime worktree base workspace does not match the run chat workspace.'

/**
 * Bind every selected runtime worktree (main renderer and popouts alike) to
 * the workspace that has already passed the durable chat identity check.
 * Merely requiring the renderer-nominated base to be some registered
 * workspace is insufficient: it would let a Test 1 chat nominate Test 3 and
 * then select any linked Test 3 worktree.
 */
export function bindRuntimeWorktreeBaseWorkspace(input: {
  requestedBaseWorkspacePath?: string
  registeredWorkspace: string
  canonicalizePath: (path: string) => string
}): string {
  const registeredWorkspace = input.canonicalizePath(input.registeredWorkspace)
  const requestedBase = input.requestedBaseWorkspacePath?.trim()
    ? input.canonicalizePath(input.requestedBaseWorkspacePath)
    : registeredWorkspace
  if (requestedBase !== registeredWorkspace) {
    throw new Error(RUNTIME_WORKTREE_BASE_AUTHORITY_ERROR)
  }
  return registeredWorkspace
}

export function derivePopoutRunPayload(input: {
  payload: AgentRunPayload
  chat: ChatRecord
  owner: WorkspacePopoutAuthority
  canonicalizePath: (path: string) => string
}): AgentRunPayload {
  const { payload, chat, owner, canonicalizePath } = input
  if (owner.kind !== 'chat' || owner.chatId !== chat.appChatId || payload.appChatId !== chat.appChatId) {
    throw new Error(RENDERER_RUN_AUTHORITY_ERROR)
  }

  const scope = chat.scope === 'global' ? 'global' : 'workspace'
  let workspace: string | undefined
  if (scope === 'workspace') {
    if (!chat.workspacePath || !owner.workspacePath) {
      throw new Error(RENDERER_RUN_AUTHORITY_ERROR)
    }
    let chatWorkspace: string
    let ownerWorkspace: string
    try {
      chatWorkspace = canonicalizePath(chat.workspacePath)
      ownerWorkspace = canonicalizePath(owner.workspacePath)
    } catch {
      throw new Error(RENDERER_RUN_AUTHORITY_ERROR)
    }
    if (chatWorkspace !== ownerWorkspace) {
      throw new Error(RENDERER_RUN_AUTHORITY_ERROR)
    }
    workspace = chatWorkspace
  } else if (owner.workspacePath) {
    // A workspace popout whose durable chat was rebound to global is stale.
    // Do not silently widen it into global authority; require a fresh window
    // with a matching frozen owner snapshot.
    throw new Error(RENDERER_RUN_AUTHORITY_ERROR)
  }

  const linkedSession =
    payload.provider === 'gemini'
      ? chat.linkedGeminiSessionId
      : payload.provider === chat.provider
        ? chat.linkedProviderSessionId
        : undefined
  const requestedSession = normalizeSessionId(payload.providerSessionId)
  const providerSessionId =
    payload.provider === 'gemini'
      ? requestedSession && requestedSession === normalizeSessionId(linkedSession)
        ? linkedSession
        : null
      : linkedSession || null
  const runtimeWorktree =
    workspace && payload.runtimeWorktree
      ? {
          ...payload.runtimeWorktree,
          // The renderer may select a worktree linked to this repository, but
          // it cannot nominate another registered workspace as the repository
          // root. resolveRuntimeWorktreeWorkspace performs the linked-worktree
          // check later against this main-owned base.
          baseWorkspacePath: workspace
        }
      : undefined

  return {
    ...payload,
    scope,
    workspace,
    providerSessionId,
    runtimeWorktree
  }
}

function normalizeSessionId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}
