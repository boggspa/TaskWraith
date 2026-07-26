import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AgentThreadForkCapability, ChatRecord, ProviderId } from '../store/types'
import { ANTIGRAVITY_PROVIDER_ID, isLiveSelectableProvider } from '../../shared/retiredProviders'

type ThreadListParams = {
  limit?: number
  cursor?: string | null
  cwd?: string | null
  archived?: unknown
  searchTerm?: string | null
  sortKey?: string | null
  sortDirection?: string | null
}

type ThreadForkParams = {
  excludeTurns?: unknown
  cwd?: string
  model?: string
  chatId?: string
  emulated?: unknown
}

export type AgentReviewAuthorityParams = {
  appChatId?: unknown
  cwd?: unknown
}

interface CodexThreadClient {
  ensureStarted(appVersion: string): Promise<void>
  request(method: string, payload: unknown, timeoutMs: number): Promise<unknown>
}

export type AgentThreadSenderScope =
  | { kind: 'main' }
  | {
      kind: 'chat'
      chatId: string
      workspacePath: string | null
      linkedProviderThreads: ReadonlyArray<{
        provider: ProviderId
        threadId: string
      }>
    }

export interface CodexThreadHandlersDeps {
  getCodexClient: () => CodexThreadClient
  getAppVersion: () => string
  providerDisplayName: (provider: ProviderId) => string
  resolveSenderAgentThreadScope: (event: IpcMainInvokeEvent) => AgentThreadSenderScope
  createEmulatedFork?: (input: {
    provider: ProviderId
    chatId: string
    sourceProviderThreadId?: string
    sourceModel?: string
  }) => ChatRecord
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function assertScopedChat(scope: AgentThreadSenderScope, requestedChatId: unknown): void {
  if (scope.kind === 'main') return
  if (trimmedString(requestedChatId) !== scope.chatId) {
    throw new Error('Renderer cannot manage provider threads for another chat.')
  }
}

function assertScopedProviderThread(
  scope: AgentThreadSenderScope,
  provider: ProviderId,
  threadId: string
): void {
  if (scope.kind === 'main') return
  const requestedThreadId = trimmedString(threadId)
  const ownsThread = scope.linkedProviderThreads.some(
    (entry) => entry.provider === provider && trimmedString(entry.threadId) === requestedThreadId
  )
  if (!requestedThreadId || !ownsThread) {
    throw new Error('Renderer cannot manage an unlinked provider thread.')
  }
}

function scopedListCwd(scope: AgentThreadSenderScope, requestedCwd: unknown): string | null {
  if (scope.kind === 'main') return trimmedString(requestedCwd) || null
  const workspacePath = trimmedString(scope.workspacePath)
  if (!workspacePath) {
    throw new Error('Detached provider thread listing requires a workspace-scoped chat.')
  }
  const requestedPath = trimmedString(requestedCwd)
  if (requestedPath && requestedPath !== workspacePath) {
    throw new Error('Renderer cannot list provider threads for another workspace.')
  }
  return workspacePath
}

function scopedForkCwd(scope: AgentThreadSenderScope, requestedCwd: unknown): string | undefined {
  if (scope.kind === 'main') return trimmedString(requestedCwd) || undefined
  const workspacePath = trimmedString(scope.workspacePath)
  const requestedPath = trimmedString(requestedCwd)
  if (!workspacePath) {
    if (requestedPath) {
      throw new Error('Renderer cannot fork a provider thread into another workspace.')
    }
    return undefined
  }
  if (requestedPath && requestedPath !== workspacePath) {
    throw new Error('Renderer cannot fork a provider thread into another workspace.')
  }
  return workspacePath
}

export function authorizeAgentReview(
  scope: AgentThreadSenderScope,
  provider: ProviderId,
  threadId: string,
  params: AgentReviewAuthorityParams,
  workspacePathsEqual: (left: string, right: string) => boolean
): { workspacePath: string } {
  const requestedWorkspacePath = trimmedString(params.cwd) || undefined
  if (scope.kind === 'main') {
    if (!requestedWorkspacePath) throw new Error('Native review requires a workspace.')
    return { workspacePath: requestedWorkspacePath }
  }
  assertScopedChat(scope, params.appChatId)
  assertScopedProviderThread(scope, provider, threadId)
  const ownedWorkspacePath = trimmedString(scope.workspacePath)
  if (!ownedWorkspacePath) {
    throw new Error('Detached native review requires a workspace-scoped chat.')
  }
  if (
    requestedWorkspacePath &&
    !workspacePathsEqual(requestedWorkspacePath, ownedWorkspacePath)
  ) {
    throw new Error('Renderer cannot start a review in another workspace.')
  }
  return { workspacePath: ownedWorkspacePath }
}

function forkCapability(
  provider: ProviderId,
  providerDisplayName: (provider: ProviderId) => string
): AgentThreadForkCapability & { detail: string; requiresLinkedSession: boolean } {
  if (provider === 'codex') {
    return {
      provider,
      label: 'Native fork',
      kind: 'native',
      nativeThreadTools: true,
      requiresLinkedSession: true,
      caveats: [],
      detail: 'Creates a provider-native Codex thread fork through thread/fork.'
    }
  }
  if (!isLiveSelectableProvider(provider) && provider !== ANTIGRAVITY_PROVIDER_ID) {
    return {
      provider,
      label: 'Fork unavailable',
      kind: 'unsupported',
      nativeThreadTools: false,
      requiresLinkedSession: false,
      caveats: [`${providerDisplayName(provider)} is unavailable and cannot start new forked runs.`],
      detail: `${providerDisplayName(provider)} is retained for historical records only.`
    }
  }
  // Capability describes the fork mechanism, not conditional-provider
  // admission. AntiGravity's emulated fork still crosses the injected
  // createEmulatedFork boundary, where ChatService enforces the configured
  // in-app lane before any sibling chat or run can be created.
  return {
    provider,
    label: 'Emulated fork',
    kind: 'emulated',
    nativeThreadTools: false,
    requiresLinkedSession: false,
    caveats: [
      `${providerDisplayName(provider)} does not expose a TaskWraith-native thread/fork primitive; TaskWraith copies the transcript into an isolated sibling chat.`
    ],
    detail:
      'No provider-native fork is available on this transport. TaskWraith creates an isolated sibling chat with copied transcript context.'
  }
}

export function registerCodexThreadHandlers(deps: CodexThreadHandlersDeps): void {
  ipcMain.handle('fork:get-capability', async (_, provider: ProviderId) => {
    return forkCapability(provider, deps.providerDisplayName)
  })

  ipcMain.handle(
    'list-agent-threads',
    async (event, provider: ProviderId, params: ThreadListParams = {}) => {
      if (provider !== 'codex') {
        return { data: [], nextCursor: null }
      }
      const scope = deps.resolveSenderAgentThreadScope(event)
      const cwd = scopedListCwd(scope, params.cwd)
      if (scope.kind === 'chat' && trimmedString(params.cursor)) {
        throw new Error('Provider thread pagination is unavailable in detached chat windows.')
      }
      const client = deps.getCodexClient()
      await client.ensureStarted(deps.getAppVersion())
      return client.request(
        'thread/list',
        {
          limit: params.limit || 40,
          cursor: params.cursor || null,
          cwd,
          archived: Boolean(params.archived),
          searchTerm: params.searchTerm || null,
          sortKey: params.sortKey || 'updated_at',
          sortDirection: params.sortDirection || 'desc'
        },
        20_000
      )
    }
  )

  ipcMain.handle(
    'fork-agent-thread',
    async (event, provider: ProviderId, threadId: string, params: ThreadForkParams = {}) => {
      const scope = deps.resolveSenderAgentThreadScope(event)
      const cwd = scopedForkCwd(scope, params.cwd)
      if (provider !== 'codex') {
        const capability = forkCapability(provider, deps.providerDisplayName)
        if (capability.kind !== 'emulated' || !deps.createEmulatedFork) {
          throw new Error(capability.detail)
        }
        const chatId =
          typeof params.chatId === 'string' && params.chatId.trim()
            ? params.chatId.trim()
            : typeof threadId === 'string' && threadId.trim()
              ? threadId.trim()
              : ''
        if (!chatId) {
          throw new Error('Chat id is required for an emulated TaskWraith fork.')
        }
        assertScopedChat(scope, chatId)
        if (trimmedString(threadId) && trimmedString(threadId) !== chatId) {
          assertScopedProviderThread(scope, provider, threadId)
        }
        const chat = deps.createEmulatedFork({
          provider,
          chatId,
          sourceProviderThreadId:
            typeof threadId === 'string' && threadId.trim() && threadId !== chatId
              ? threadId.trim()
              : undefined,
          sourceModel: typeof params.model === 'string' ? params.model : undefined
        })
        return {
          ok: true,
          provider,
          kind: 'emulated',
          chatId: chat.appChatId,
          forkedChatId: chat.appChatId,
          title: chat.title,
          parentChatId: chat.parentChatId,
          caveats: capability.caveats
        }
      }
      if (params.chatId) assertScopedChat(scope, params.chatId)
      assertScopedProviderThread(scope, provider, threadId)
      const client = deps.getCodexClient()
      await client.ensureStarted(deps.getAppVersion())
      const native = await client.request(
        'thread/fork',
        {
          threadId,
          excludeTurns: Boolean(params.excludeTurns),
          persistExtendedHistory: true,
          ...(cwd ? { cwd } : {}),
          ...(params.model ? { model: params.model } : {})
        },
        30_000
      )
      return {
        ...(native && typeof native === 'object' && !Array.isArray(native) ? native : {}),
        ok: true,
        provider,
        kind: 'native',
        native
      }
    }
  )

  ipcMain.handle(
    'rollback-agent-thread',
    async (event, provider: ProviderId, threadId: string, numTurns: number = 1) => {
      if (provider !== 'codex') {
        throw new Error(
          `Thread rollback is not available for ${deps.providerDisplayName(provider)} in this version. File rollback still belongs to Diff Studio/git workflow.`
        )
      }
      const scope = deps.resolveSenderAgentThreadScope(event)
      assertScopedProviderThread(scope, provider, threadId)
      const client = deps.getCodexClient()
      await client.ensureStarted(deps.getAppVersion())
      return client.request(
        'thread/rollback',
        {
          threadId,
          numTurns: Math.max(1, Math.trunc(Number(numTurns) || 1))
        },
        30_000
      )
    }
  )
}
