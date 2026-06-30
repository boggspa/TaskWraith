import { ipcMain } from 'electron'
import type { ProviderId } from '../store/types'

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
}

interface CodexThreadClient {
  ensureStarted(appVersion: string): Promise<void>
  request(method: string, payload: unknown, timeoutMs: number): Promise<unknown>
}

export interface CodexThreadHandlersDeps {
  getCodexClient: () => CodexThreadClient
  getAppVersion: () => string
  providerDisplayName: (provider: ProviderId) => string
}

export function registerCodexThreadHandlers(deps: CodexThreadHandlersDeps): void {
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
        throw new Error(
          `Thread fork is not available for ${deps.providerDisplayName(provider)} in this version.`
        )
      }
      const client = deps.getCodexClient()
      await client.ensureStarted(deps.getAppVersion())
      return client.request(
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
