/** Main-renderer IPC for the user-controlled Host lifecycle, and the menu's restart action. */

import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  isHostLifecycleAction,
  type HostLifecycleActionRequest,
  type HostLifecycleActionResult,
  type HostLifecycleInspectResult,
  type HostLifecycleLeaseProjection,
  type HostLifecycleSnapshot,
  type HostLifecycleStatusResult
} from '../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../shared/hostProtocol'
import type { HostLifecycleController } from '../host/HostLifecycleController'

export const HOST_LIFECYCLE_STATUS_CHANNEL = 'host-lifecycle:status'
export const HOST_LIFECYCLE_SET_CHANNEL = 'host-lifecycle:set'
export const HOST_LIFECYCLE_INSPECT_CHANNEL = 'host-lifecycle:inspect'
export const HOST_LIFECYCLE_CHANGED_CHANNEL = 'host-lifecycle:changed'

type HostLifecycleControllerPort = Pick<
  HostLifecycleController,
  'getSnapshot' | 'start' | 'stop' | 'restart' | 'subscribe'
>

type HostLifecycleIpc = Pick<typeof ipcMain, 'handle' | 'removeHandler'>

/** What the inspect channel reads live, beside the lifecycle snapshot. */
export interface HostLifecycleInspectPort {
  /** The Host's own `host.status` (main's lease socket); null when it cannot be read. */
  readHostStatus(): Promise<HostStatusProjection | null>
  /** Main's lease on the Host; null when this app holds none (the in-process Host). */
  leaseProjection(): HostLifecycleLeaseProjection | null
}

export interface HostLifecycleHandlersDeps {
  readonly controller: HostLifecycleControllerPort
  readonly assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  readonly publishChanged: (snapshot: HostLifecycleSnapshot) => void
  readonly inspect?: HostLifecycleInspectPort
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
  return isHostLifecycleAction((value as { action?: unknown }).action)
}

function performAction(
  controller: HostLifecycleControllerPort,
  request: HostLifecycleActionRequest
): Promise<HostLifecycleActionResult> {
  switch (request.action) {
    case 'start':
      return controller.start('user-start')
    case 'stop':
      return controller.stop('user-stop')
    case 'restart':
      return controller.restart('user-restart')
  }
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
          error: 'Host lifecycle request must contain exactly one start, stop or restart action.',
          snapshot: deps.controller.getSnapshot()
        }
      }
      return performAction(deps.controller, request)
    }
  )

  ipc.removeHandler?.(HOST_LIFECYCLE_INSPECT_CHANNEL)
  ipc.handle(HOST_LIFECYCLE_INSPECT_CHANNEL, async (event): Promise<HostLifecycleInspectResult> => {
    const denied = authorizationError(deps, event)
    if (denied) return { ok: false, error: denied }
    let host: HostStatusProjection | null = null
    try {
      host = (await deps.inspect?.readHostStatus()) ?? null
    } catch {
      host = null
    }
    return {
      ok: true,
      snapshot: deps.controller.getSnapshot(),
      host,
      lease: deps.inspect?.leaseProjection() ?? null
    }
  })

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

/** Where the live-run count is read from: the Host's own status, then the Desktop projection. */
export interface HostLiveRunSources {
  readonly readHostStatus: () => Promise<HostStatusProjection | null>
  readonly snapshot: () => Promise<
    | {
        readonly ok: true
        readonly snapshot: { readonly runs: readonly { readonly providerOutcome?: string }[] }
      }
    | { readonly ok: false }
  >
}

export interface HostRestartActionDeps extends HostLiveRunSources {
  readonly controller: Pick<HostLifecycleController, 'restart'>
  /** Ask before a restart that would cancel live runs (or when that is unknown). */
  readonly confirm?: (liveRuns: number | null) => Promise<boolean>
  readonly log?: (line: string) => void
}

/**
 * Live runs on the Host: its own count over main's lease socket first (it
 * survives a poisoned Desktop session), then the Desktop projection's running
 * runs, the update barrier's rule. Null when neither can be read.
 */
export async function countHostLiveRuns(input: HostLiveRunSources): Promise<number | null> {
  try {
    const status = await input.readHostStatus()
    if (status) return status.liveWork.runs
  } catch {
    // Fall through to the projection.
  }
  try {
    const projected = await input.snapshot()
    return projected.ok
      ? projected.snapshot.runs.filter((run) => run.providerOutcome === 'running').length
      : null
  } catch {
    return null
  }
}

async function confirmWithDialog(liveRuns: number | null): Promise<boolean> {
  const detail =
    liveRuns === null
      ? 'TaskWraith cannot tell whether runs are in progress. Restarting the Host cancels any that are.'
      : `${liveRuns} run${liveRuns === 1 ? ' is' : 's are'} in progress. Restarting the Host cancels ${
          liveRuns === 1 ? 'it' : 'them'
        }.`
  const answer = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Restart Host', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Restart the TaskWraith Host?',
    detail
  })
  return answer.response === 0
}

/**
 * The menu's Restart Host: an explicit user restart, confirmed first when
 * runs are live (the update barrier's rule) or their count is unknown.
 * Resolves null when the user cancelled.
 */
export function createHostRestartAction(
  deps: HostRestartActionDeps
): () => Promise<HostLifecycleActionResult | null> {
  const confirm = deps.confirm ?? confirmWithDialog
  const log = deps.log ?? (() => undefined)
  return async () => {
    const liveRuns = await countHostLiveRuns(deps)
    if ((liveRuns === null || liveRuns > 0) && !(await confirm(liveRuns))) {
      log('[host-lifecycle] restart cancelled by the user')
      return null
    }
    const result = await deps.controller.restart('user-restart')
    if (!result.ok) log(`[host-lifecycle] restart failed: ${result.error}`)
    return result
  }
}
