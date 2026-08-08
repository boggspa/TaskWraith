/**
 * Chat-scoped renderer IPC for Simulator Canvas host actions + human gestures.
 *
 * Expected composition-root wiring (do not grow index.ts beyond registration):
 *   registerSimulatorCanvasHandlers(ipcMain, {
 *     getHostControl: () => control,
 *     getControllerLease: () => lease,
 *     getSessionStore: () => sessions,
 *     getInteraction: () => bridge,
 *     getIdb: () => idb
 *   })
 * Plus will-quit: void simulatorHostService.dispose()
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import type { IdbClient } from '../simulator/IdbClient'
import type { SimulatorHostControl } from '../simulator/SimulatorHostControl'
import type { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import type { SimulatorInteractionBridge } from '../simulator/SimulatorInteractionBridge'
import type {
  SimulatorScrollGesture,
  SimulatorTapGesture,
  SimulatorTypeGesture
} from '../../shared/simulatorCanvas'

export interface SimulatorCanvasIpcDeps {
  getHostControl: () => Pick<
    SimulatorHostControl,
    | 'status'
    | 'openSimulatorApp'
    | 'listDevices'
    | 'boot'
    | 'install'
    | 'launch'
    | 'terminate'
    | 'screenshot'
  >
  getControllerLease: () => Pick<SimulatorControllerLease, 'claimHuman' | 'peek'>
  getSessionStore?: () => Pick<SimulatorSessionStore, 'get'>
  getInteraction: () => Pick<
    SimulatorInteractionBridge,
    'interactionStatus' | 'tap' | 'type' | 'scroll'
  >
  /** Optional idb probe — merges idbAvailable into capability status for the panel CTA. */
  getIdb?: () => Pick<IdbClient, 'isAvailable' | 'companionAvailable'>
  /** Optional native .app picker (mesh-import style). Path field remains when omitted. */
  getRequestingWindow?: (event: IpcMainInvokeEvent) => BrowserWindow | null
  showOpenDialog?: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<{ canceled: boolean; filePaths: string[] }>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error(`Simulator Canvas ${label} is invalid.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('Simulator Canvas argument is invalid.')
  }
  return value
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Simulator Canvas ${label} is invalid.`)
  }
  return value as Record<string, unknown>
}

function requiredFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Simulator Canvas ${label} is invalid.`)
  }
  return value
}

function parseTap(value: unknown): SimulatorTapGesture {
  const record = requiredObject(value, 'tap')
  return {
    chatId: requiredString(record.chatId, 'chatId'),
    x: requiredFinite(record.x, 'x'),
    y: requiredFinite(record.y, 'y')
  }
}

function parseType(value: unknown): SimulatorTypeGesture {
  const record = requiredObject(value, 'type')
  if (typeof record.text !== 'string') {
    throw new Error('Simulator Canvas text is invalid.')
  }
  return {
    chatId: requiredString(record.chatId, 'chatId'),
    text: record.text
  }
}

function parseScroll(value: unknown): SimulatorScrollGesture {
  const record = requiredObject(value, 'scroll')
  return {
    chatId: requiredString(record.chatId, 'chatId'),
    x: requiredFinite(record.x, 'x'),
    y: requiredFinite(record.y, 'y'),
    deltaX: requiredFinite(record.deltaX, 'deltaX'),
    deltaY: requiredFinite(record.deltaY, 'deltaY')
  }
}

function humanControl(
  deps: SimulatorCanvasIpcDeps,
  chatId: string
): { chatId: string; controllerTokenId: string } {
  const claimed = deps.getControllerLease().claimHuman(chatId)
  if (!claimed.ok) {
    throw new Error(claimed.error)
  }
  return { chatId, controllerTokenId: claimed.token.tokenId }
}

export function registerSimulatorCanvasHandlers(
  ipcMain: IpcMain,
  deps: SimulatorCanvasIpcDeps
): void {
  ipcMain.handle('simulator-canvas:status', async () => {
    const status = await deps.getHostControl().status()
    const idb = deps.getIdb?.()
    return {
      ok: true,
      status: {
        ...status,
        idbAvailable: idb?.isAvailable() ?? false,
        idbCompanionAvailable: idb?.companionAvailable() ?? false
      }
    }
  })

  ipcMain.handle('simulator-canvas:claim-control', async (_event, chatId: unknown) => {
    const id = requiredString(chatId, 'chatId')
    const claimed = deps.getControllerLease().claimHuman(id)
    if (!claimed.ok) {
      return { ok: false, error: claimed.error, code: claimed.code }
    }
    return { ok: true, token: claimed.token }
  })

  ipcMain.handle('simulator-canvas:session', async (_event, chatId: unknown) => {
    const id = requiredString(chatId, 'chatId')
    const session = deps.getSessionStore?.().get(id) ?? null
    const controller = deps.getControllerLease().peek(id)
    return { ok: true, session, controller }
  })

  ipcMain.handle('simulator-canvas:open-app', async (_event, chatId: unknown) => {
    const id = requiredString(chatId, 'chatId')
    return deps.getHostControl().openSimulatorApp(humanControl(deps, id))
  })

  ipcMain.handle('simulator-canvas:list-devices', async () => {
    return deps.getHostControl().listDevices()
  })

  ipcMain.handle('simulator-canvas:boot', async (_event, chatId: unknown, udid: unknown) => {
    const id = requiredString(chatId, 'chatId')
    return deps.getHostControl().boot(requiredString(udid, 'udid'), humanControl(deps, id))
  })

  ipcMain.handle('simulator-canvas:pick-app', async (event, chatId: unknown) => {
    // Authority check: chatId must be a well-formed identity even though the
    // picker itself does not mutate the device — it only returns a human path.
    requiredString(chatId, 'chatId')
    const showOpenDialog = deps.showOpenDialog
    const getWindow = deps.getRequestingWindow
    if (!showOpenDialog || !getWindow) {
      return { ok: false, canceled: true, error: 'Simulator Canvas app picker is unavailable.' }
    }
    const window = getWindow(event)
    if (!window) return { ok: true, canceled: true }
    const selection = await showOpenDialog(window, {
      title: 'Install an .app into the Simulator',
      buttonLabel: 'Choose .app',
      properties: ['openFile'],
      filters: [{ name: 'Application', extensions: ['app'] }]
    })
    const appPath = selection.canceled ? null : selection.filePaths[0]
    if (!appPath || !appPath.trim()) return { ok: true, canceled: true }
    return { ok: true, canceled: false, appPath: appPath.trim() }
  })

  ipcMain.handle(
    'simulator-canvas:install',
    async (_event, chatId: unknown, udid: unknown, appPath: unknown) => {
      const id = requiredString(chatId, 'chatId')
      return deps
        .getHostControl()
        .install(
          requiredString(udid, 'udid'),
          requiredString(appPath, 'appPath'),
          humanControl(deps, id)
        )
    }
  )

  ipcMain.handle(
    'simulator-canvas:launch',
    async (_event, chatId: unknown, udid: unknown, bundleId: unknown) => {
      const id = requiredString(chatId, 'chatId')
      return deps
        .getHostControl()
        .launch(
          requiredString(udid, 'udid'),
          requiredString(bundleId, 'bundleId'),
          humanControl(deps, id)
        )
    }
  )

  ipcMain.handle(
    'simulator-canvas:terminate',
    async (_event, chatId: unknown, udid: unknown, bundleId: unknown) => {
      const id = requiredString(chatId, 'chatId')
      return deps
        .getHostControl()
        .terminate(requiredString(udid, 'udid'), optionalString(bundleId), humanControl(deps, id))
    }
  )

  ipcMain.handle('simulator-canvas:screenshot', async (_event, chatId: unknown, udid: unknown) => {
    const id = requiredString(chatId, 'chatId')
    return deps.getHostControl().screenshot(requiredString(udid, 'udid'), { chatId: id })
  })

  ipcMain.handle('simulator-canvas:interaction-status', async (_event, chatId: unknown) => {
    const id = requiredString(chatId, 'chatId')
    const status = deps.getInteraction().interactionStatus(id)
    const controller = deps.getControllerLease().peek(id)
    return {
      ...status,
      controllerLeaseHeld: Boolean(controller) || Boolean(status.controllerLeaseHeld),
      controllerKind: controller?.kind ?? null
    }
  })

  ipcMain.handle('simulator-canvas:tap', async (_event, payload: unknown) => {
    return deps.getInteraction().tap(parseTap(payload))
  })

  ipcMain.handle('simulator-canvas:type', async (_event, payload: unknown) => {
    return deps.getInteraction().type(parseType(payload))
  })

  ipcMain.handle('simulator-canvas:scroll', async (_event, payload: unknown) => {
    return deps.getInteraction().scroll(parseScroll(payload))
  })
}
