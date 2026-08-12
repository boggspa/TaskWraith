/** Main-renderer IPC for the user-controlled, in-process Host lifecycle. */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  HostLifecycleActionRequest,
  HostLifecycleActionResult,
  HostLifecycleSnapshot,
  HostLifecycleStatusResult
} from '../../shared/hostLifecycle'
import type { HostLifecycleController } from '../host/HostLifecycleController'

export const HOST_LIFECYCLE_STATUS_CHANNEL = 'host-lifecycle:status'
export const HOST_LIFECYCLE_SET_CHANNEL = 'host-lifecycle:set'
export const HOST_LIFECYCLE_CHANGED_CHANNEL = 'host-lifecycle:changed'

type HostLifecycleControllerPort = Pick<
  HostLifecycleController,
  'getSnapshot' | 'start' | 'stop' | 'subscribe'
>

type HostLifecycleIpc = Pick<typeof ipcMain, 'handle' | 'removeHandler'>

export interface HostLifecycleHandlersDeps {
  readonly controller: HostLifecycleControllerPort
  readonly assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  readonly publishChanged: (snapshot: HostLifecycleSnapshot) => void
  readonly ipc?: HostLifecycleIpc
}

const activeSubscriptions = new WeakMap<object, () => void>()

function authorizationError(
  deps: HostLifecycleHandlersDeps,
  event: IpcMainInvokeEvent
): string | null {
  try {
    deps.assertMainRendererSender(event)
    return null
  } catch {
    return 'Only the main TaskWraith window can control Host.'
  }
}

function isExactActionRequest(value: unknown): value is HostLifecycleActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'action') return false
  const action = (value as { action?: unknown }).action
  return action === 'start' || action === 'stop'
}

/**
 * Register the lifecycle bridge and return a subscription disposer.
 *
 * Registration is idempotent for the injected ipcMain instance: old handlers
 * and the old controller subscription are removed before replacements land.
 */
export function registerHostLifecycleHandlers(deps: HostLifecycleHandlersDeps): () => void {
  if (!deps || typeof deps !== 'object') {
    throw new Error('registerHostLifecycleHandlers requires deps')
  }
  if (!deps.controller || typeof deps.controller.getSnapshot !== 'function') {
    throw new Error('registerHostLifecycleHandlers requires controller')
  }
  if (typeof deps.assertMainRendererSender !== 'function') {
    throw new Error('registerHostLifecycleHandlers requires main-renderer authorization')
  }
  if (typeof deps.publishChanged !== 'function') {
    throw new Error('registerHostLifecycleHandlers requires publishChanged')
  }

  const ipc = deps.ipc ?? ipcMain
  const key = ipc as object
  activeSubscriptions.get(key)?.()

  ipc.removeHandler?.(HOST_LIFECYCLE_STATUS_CHANNEL)
  ipc.handle(HOST_LIFECYCLE_STATUS_CHANNEL, (event): HostLifecycleStatusResult => {
    const denied = authorizationError(deps, event)
    if (denied) return { ok: false, error: denied }
    return { ok: true, snapshot: deps.controller.getSnapshot() }
  })

  ipc.removeHandler?.(HOST_LIFECYCLE_SET_CHANNEL)
  ipc.handle(
    HOST_LIFECYCLE_SET_CHANNEL,
    async (event, request: unknown): Promise<HostLifecycleActionResult> => {
      const denied = authorizationError(deps, event)
      if (denied) return { ok: false, error: denied }
      if (!isExactActionRequest(request)) {
        return {
          ok: false,
          error: 'Host lifecycle request must contain exactly one start or stop action.',
          snapshot: deps.controller.getSnapshot()
        }
      }
      return request.action === 'start'
        ? deps.controller.start('user-start')
        : deps.controller.stop('user-stop')
    }
  )

  let active = true
  const unsubscribe = deps.controller.subscribe((snapshot) => {
    if (active) deps.publishChanged(snapshot)
  })
  const dispose = (): void => {
    if (!active) return
    active = false
    unsubscribe()
    if (activeSubscriptions.get(key) === dispose) activeSubscriptions.delete(key)
  }
  activeSubscriptions.set(key, dispose)
  return dispose
}
