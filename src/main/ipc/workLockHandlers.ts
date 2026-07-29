import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  scopeWorkLockProjectionSnapshot,
  workLockProjectionQueryKey,
  type WorkLockProjectionChangedEvent,
  type WorkLockProjectionChangeReason,
  type WorkLockProjectionQuery,
  type WorkLockProjectionSnapshot,
  type WorkLockProjectionSubscribeRequest,
  type WorkLockProjectionSubscribeResult
} from '../../shared/workLockProjection'

const WORK_LOCK_CHANGED_CHANNEL = 'work-locks:changed'

export interface WorkLockProjectionServiceUpdate {
  reason: Exclude<WorkLockProjectionChangeReason, 'initial'>
  snapshot: WorkLockProjectionSnapshot
}

export interface WorkLockProjectionSubscription {
  snapshot: WorkLockProjectionSnapshot
  unsubscribe: () => void
}

export interface WorkLockHandlerDeps {
  /**
   * Resolve renderer input to a canonical, authorized scope. Main may allow an
   * empty global scope; popouts should return only their exact owned workspace.
   */
  resolveAuthorizedQuery: (
    event: IpcMainInvokeEvent,
    query: WorkLockProjectionQuery
  ) => WorkLockProjectionQuery
  list: (
    query: WorkLockProjectionQuery
  ) => WorkLockProjectionSnapshot | Promise<WorkLockProjectionSnapshot>
  /**
   * Main-owned final projection boundary. Use it to redact durable identities
   * and sibling paths before a secondary renderer can receive the snapshot.
   */
  projectSnapshot?: (
    event: IpcMainInvokeEvent,
    query: WorkLockProjectionQuery,
    snapshot: WorkLockProjectionSnapshot
  ) => WorkLockProjectionSnapshot
  /**
   * Registration and initial snapshot must be one service operation so an
   * acquire between separate list/subscribe calls cannot disappear.
   */
  subscribe: (
    query: WorkLockProjectionQuery,
    onUpdate: (update: WorkLockProjectionServiceUpdate) => void
  ) => WorkLockProjectionSubscription
}

interface HandlerSubscription {
  webContentsId: number
  query: WorkLockProjectionQuery
  cleanup: () => void
  setServiceUnsubscribe: (unsubscribe: () => void) => void
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function exactPathField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

function queryFromInput(input: unknown): WorkLockProjectionQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const workspacePath = exactPathField(record.workspacePath)
  const chatId = stringField(record.chatId)
  return {
    ...(workspacePath ? { workspacePath } : {}),
    ...(chatId ? { chatId } : {})
  }
}

function subscriptionIdFromInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  return stringField((input as Record<string, unknown>).subscriptionId) || ''
}

export function registerWorkLockHandlers(deps: WorkLockHandlerDeps): void {
  const subscriptions = new Map<string, HandlerSubscription>()

  ipcMain.handle('work-locks:list', async (event, input?: unknown) => {
    const query = deps.resolveAuthorizedQuery(event, queryFromInput(input))
    const snapshot = await deps.list(query)
    const scoped = scopeWorkLockProjectionSnapshot(snapshot, query)
    return deps.projectSnapshot?.(event, query, scoped) ?? scoped
  })

  ipcMain.handle(
    'work-locks:subscribe',
    async (
      event,
      input?: WorkLockProjectionSubscribeRequest
    ): Promise<WorkLockProjectionSubscribeResult> => {
      const subscriptionId = subscriptionIdFromInput(input)
      if (!subscriptionId) return { ok: false, error: 'Subscription id is required.' }

      const sender = event.sender
      const existing = subscriptions.get(subscriptionId)
      if (existing && existing.webContentsId !== sender.id) {
        return {
          ok: false,
          error: 'Work lock subscription id belongs to another renderer.'
        }
      }
      existing?.cleanup()

      const query = deps.resolveAuthorizedQuery(event, queryFromInput(input))
      let serviceUnsubscribe = (): void => undefined
      let cleaned = false
      const forget = (): void => {
        if (subscriptions.get(subscriptionId) === subscription) {
          subscriptions.delete(subscriptionId)
        }
      }
      const onDestroyed = (): void => cleanup()
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        sender.removeListener('destroyed', onDestroyed)
        serviceUnsubscribe()
        forget()
      }
      const subscription: HandlerSubscription = {
        webContentsId: sender.id,
        query,
        cleanup,
        setServiceUnsubscribe: (unsubscribe) => {
          if (cleaned) {
            unsubscribe()
            return
          }
          serviceUnsubscribe = unsubscribe
        }
      }

      sender.once('destroyed', onDestroyed)
      subscriptions.set(subscriptionId, subscription)

      let registration: WorkLockProjectionSubscription
      try {
        registration = deps.subscribe(query, (update) => {
          try {
            if (cleaned || sender.isDestroyed()) {
              cleanup()
              return
            }
            const currentQuery = deps.resolveAuthorizedQuery(event, queryFromInput(input))
            if (workLockProjectionQueryKey(currentQuery) !== workLockProjectionQueryKey(query)) {
              cleanup()
              return
            }
            const scoped = scopeWorkLockProjectionSnapshot(update.snapshot, query)
            const payload: WorkLockProjectionChangedEvent = {
              subscriptionId,
              reason: update.reason,
              snapshot: deps.projectSnapshot?.(event, query, scoped) ?? scoped
            }
            sender.send(WORK_LOCK_CHANGED_CHANNEL, payload)
          } catch {
            cleanup()
          }
        })
      } catch (error) {
        cleanup()
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Work lock subscription failed.'
        }
      }

      subscription.setServiceUnsubscribe(registration.unsubscribe)
      if (subscriptions.get(subscriptionId) !== subscription || cleaned) {
        cleanup()
        return {
          ok: false,
          error: 'Work lock subscription changed while it was starting.'
        }
      }

      return {
        ok: true,
        data: {
          subscriptionId,
          snapshot:
            deps.projectSnapshot?.(
              event,
              query,
              scopeWorkLockProjectionSnapshot(registration.snapshot, query)
            ) ?? scopeWorkLockProjectionSnapshot(registration.snapshot, query)
        }
      }
    }
  )

  ipcMain.handle('work-locks:unsubscribe', async (event, input?: unknown) => {
    const subscriptionId = subscriptionIdFromInput(input)
    if (!subscriptionId) return { ok: true }
    const subscription = subscriptions.get(subscriptionId)
    if (subscription && subscription.webContentsId !== event.sender.id) {
      return {
        ok: false,
        error: 'Work lock subscription id belongs to another renderer.'
      }
    }
    subscription?.cleanup()
    return { ok: true }
  })
}
