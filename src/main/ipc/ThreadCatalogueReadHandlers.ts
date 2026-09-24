import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import {
  decodeThreadCatalogueReadQuery,
  type ThreadCatalogueReadQuery
} from '../../shared/threadCatalogueProtocol'
import { threadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'
import type { SenderChatReadScope } from './chatHandlers'
import type { ThreadCatalogueOpenResult } from '../store/ThreadCatalogueClient'

/**
 * Attempts after the first for a retryable catalogue read. The background
 * importer re-indexes a changed thread ~100ms later
 * (ThreadCatalogueWorkerService.notifyChanged), so a short bounded wait covers
 * the race without making a genuine failure slow to surface.
 */
const THREAD_CATALOGUE_READ_RETRIES = 2
const defaultRetryDelayMs = (attempt: number): number => 80 * attempt

/**
 * A retryable catalogue error means the read never ran -- history moved under
 * the indexer, a lease aged out, the source was not settled yet. Re-reading is
 * the correct response and the background importer already does exactly that.
 * Letting one escape here instead turned a benign indexing race into
 * "Run execution failed unexpectedly" and killed the user's run, which is why
 * this is bounded-retried rather than propagated. `lease_erased` is the one
 * code the taxonomy marks non-retryable: that page was deliberately
 * invalidated, so it still surfaces immediately.
 */
async function queryWithRetry(
  mirror: ThreadCatalogueMirror,
  request: ThreadCatalogueReadQuery,
  retryDelayMs: (attempt: number) => number
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mirror.port.query(request)
    } catch (error) {
      const requestError = threadCatalogueRequestError(error)
      if (!requestError?.retryable || attempt > THREAD_CATALOGUE_READ_RETRIES) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(attempt)))
    }
  }
}

/** A lease is bound to its actual opener, never to a renderer-supplied chat label. */
export function registerThreadCatalogueReadHandlers(
  scopeFor: (event: IpcMainInvokeEvent) => SenderChatReadScope,
  getMirror: () => ThreadCatalogueMirror | null = () => null,
  options?: { retryDelayMs?: (attempt: number) => number }
): void {
  const retryDelayMs = options?.retryDelayMs ?? defaultRetryDelayMs
  ipcMain.handle('thread-catalogue:status', (event) => {
    scopeFor(event)
    return getMirror()?.status ?? { complete: true, loaded: 0, failed: 0, error: null }
  })
  const leases = new Map<number, Map<string, { chatId: string; expires: number }>>()
  ipcMain.handle('thread-catalogue:read', async (event, input: unknown) => {
    const scope = scopeFor(event)
    const mirror = getMirror()
    if (!mirror) return { available: false }
    const query = decodeThreadCatalogueReadQuery(input)
    if (!query) throw new Error('Invalid history read')
    if (
      query.method === 'known-run' ||
      query.method === 'introspection' ||
      query.method === 'message-activity' ||
      query.method === 'changes' ||
      query.method === 'run' ||
      query.method === 'host-runs'
    )
      throw new Error('Unsupported renderer history read')
    let owned = leases.get(event.sender.id)
    if (!owned) {
      owned = new Map()
      leases.set(event.sender.id, owned)
      event.sender.once('destroyed', () => {
        leases.delete(event.sender.id)
        for (const leaseId of owned!.keys())
          void mirror.port.query({ method: 'release', leaseId }).catch(() => undefined)
      })
    }
    for (const [id, lease] of owned) if (lease.expires <= Date.now()) owned.delete(id)
    if ('chatId' in query && scope.kind === 'chat' && query.chatId !== scope.chatId)
      throw new Error('Renderer does not own this chat read')
    if (query.method === 'list') {
      if (scope.kind === 'chat') {
        if (query.workspaceId && query.workspaceId !== scope.workspaceId)
          throw new Error('Renderer does not own this workspace read')
        const row = mirror.get(scope.chatId)
        return {
          available: true,
          data: {
            entries: row ? [{ projection: row }] : [],
            next: null,
            coverage: mirror.complete ? 'complete' : 'partial',
            repairPending: []
          }
        }
      }
      return { available: true, data: mirror.presentationPage(query) }
    }
    if ('leaseId' in query) {
      const lease = owned.get(query.leaseId)
      if (!lease || (scope.kind === 'chat' && lease.chatId !== scope.chatId))
        throw new Error('Renderer does not own this history lease')
      if (query.method === 'chunk' && query.reference.chatId !== lease.chatId)
        throw new Error('History reference belongs to another chat')
    }
    const data = await queryWithRetry(mirror, query, retryDelayMs)
    if (query.method === 'open' && data) {
      const opened = data as ThreadCatalogueOpenResult
      owned.set(opened.leaseId, { chatId: query.chatId, expires: Date.now() + 120_000 })
    }
    if (query.method === 'release') owned.delete(query.leaseId)
    return { available: true, data }
  })
}
