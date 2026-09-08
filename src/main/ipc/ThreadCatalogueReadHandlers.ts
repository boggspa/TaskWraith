import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import { decodeThreadCatalogueReadQuery } from '../../shared/threadCatalogueProtocol'
import type { SenderChatReadScope } from './chatHandlers'
import type { ThreadCatalogueOpenResult } from '../store/ThreadCatalogueClient'

/** A lease is bound to its actual opener, never to a renderer-supplied chat label. */
export function registerThreadCatalogueReadHandlers(
  scopeFor: (event: IpcMainInvokeEvent) => SenderChatReadScope,
  getMirror: () => ThreadCatalogueMirror | null = () => null
): void {
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
    const data = await mirror.port.query(query)
    if (query.method === 'open' && data) {
      const opened = data as ThreadCatalogueOpenResult
      owned.set(opened.leaseId, { chatId: query.chatId, expires: Date.now() + 120_000 })
    }
    if (query.method === 'release') owned.delete(query.leaseId)
    return { available: true, data }
  })
}
