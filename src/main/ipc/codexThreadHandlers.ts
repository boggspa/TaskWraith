import { ipcMain } from 'electron'
import type { AgentThreadForkCapability, ChatRecord, ProviderId } from '../store/types'
import { isRetiredProvider } from '../../shared/retiredProviders'

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

interface CodexThreadClient {
  ensureStarted(appVersion: string): Promise<void>
  request(method: string, payload: unknown, timeoutMs: number): Promise<unknown>
}

export interface CodexThreadHandlersDeps {
  getCodexClient: () => CodexThreadClient
  getAppVersion: () => string
  providerDisplayName: (provider: ProviderId) => string
  createEmulatedFork?: (input: {
    provider: ProviderId
    chatId: string
    sourceProviderThreadId?: string
    sourceModel?: string
  }) => ChatRecord
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
  if (isRetiredProvider(provider)) {
    return {
      provider,
      label: 'Fork unavailable',
      kind: 'unsupported',
      nativeThreadTools: false,
      requiresLinkedSession: false,
      caveats: [`${providerDisplayName(provider)} is retired and cannot start new forked runs.`],
      detail: `${providerDisplayName(provider)} is retired in TaskWraith.`
    }
  }
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

  ipcMain.handle('list-agent-threads', async (_, provider: ProviderId, params: ThreadListParams = {}) => {
    if (provider !== 'codex') {
      return { data: [], nextCursor: null }
    }
    const client = deps.getCodexClient()
    await client.ensureStarted(deps.getAppVersion())
    return client.request(
      'thread/list',
      {
        limit: params.limit || 40,
        cursor: params.cursor || null,
        cwd: params.cwd || null,
        archived: Boolean(params.archived),
        searchTerm: params.searchTerm || null,
        sortKey: params.sortKey || 'updated_at',
        sortDirection: params.sortDirection || 'desc'
      },
      20_000
    )
  })

  ipcMain.handle(
    'fork-agent-thread',
    async (_, provider: ProviderId, threadId: string, params: ThreadForkParams = {}) => {
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
      const client = deps.getCodexClient()
      await client.ensureStarted(deps.getAppVersion())
      const native = await client.request(
        'thread/fork',
        {
          threadId,
          excludeTurns: Boolean(params.excludeTurns),
          persistExtendedHistory: true,
          ...(params.cwd ? { cwd: params.cwd } : {}),
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
    async (_, provider: ProviderId, threadId: string, numTurns: number = 1) => {
      if (provider !== 'codex') {
        throw new Error(
          `Thread rollback is not available for ${deps.providerDisplayName(provider)} in this version. File rollback still belongs to Diff Studio/git workflow.`
        )
      }
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
