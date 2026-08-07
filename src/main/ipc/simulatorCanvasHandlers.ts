/**
 * Chat-scoped renderer IPC for Simulator Canvas host actions + human gestures.
 *
 * Expected composition-root wiring (do not grow index.ts beyond one line):
 *   registerSimulatorCanvasHandlers(ipcMain, { getHost: () => host, getInteraction: () => bridge })
 */
import type { IpcMain } from 'electron'
import type { SimulatorHostService } from '../simulator/SimulatorHostService'
import type { SimulatorInteractionBridge } from '../simulator/SimulatorInteractionBridge'
import type {
  SimulatorScrollGesture,
  SimulatorTapGesture,
  SimulatorTypeGesture
} from '../../shared/simulatorCanvas'

export interface SimulatorCanvasIpcDeps {
  getHost: () => Pick<
    SimulatorHostService,
    | 'status'
    | 'openSimulatorApp'
    | 'listDevices'
    | 'boot'
    | 'install'
    | 'launch'
    | 'terminate'
    | 'screenshot'
  >
  getInteraction: () => Pick<
    SimulatorInteractionBridge,
    'interactionStatus' | 'tap' | 'type' | 'scroll'
  >
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

export function registerSimulatorCanvasHandlers(
  ipcMain: IpcMain,
  deps: SimulatorCanvasIpcDeps
): void {
  ipcMain.handle('simulator-canvas:status', async () => {
    const status = await deps.getHost().status()
    return { ok: true, status }
  })

  ipcMain.handle('simulator-canvas:open-app', async () => {
    return deps.getHost().openSimulatorApp()
  })

  ipcMain.handle('simulator-canvas:list-devices', async () => {
    return deps.getHost().listDevices()
  })

  ipcMain.handle('simulator-canvas:boot', async (_event, udid: unknown) => {
    return deps.getHost().boot(requiredString(udid, 'udid'))
  })

  ipcMain.handle('simulator-canvas:install', async (_event, udid: unknown, appPath: unknown) => {
    return deps.getHost().install(requiredString(udid, 'udid'), requiredString(appPath, 'appPath'))
  })

  ipcMain.handle('simulator-canvas:launch', async (_event, udid: unknown, bundleId: unknown) => {
    return deps.getHost().launch(requiredString(udid, 'udid'), requiredString(bundleId, 'bundleId'))
  })

  ipcMain.handle('simulator-canvas:terminate', async (_event, udid: unknown, bundleId: unknown) => {
    return deps.getHost().terminate(requiredString(udid, 'udid'), optionalString(bundleId))
  })

  ipcMain.handle('simulator-canvas:screenshot', async (_event, udid: unknown) => {
    return deps.getHost().screenshot(requiredString(udid, 'udid'))
  })

  ipcMain.handle('simulator-canvas:interaction-status', async (_event, chatId: unknown) => {
    return deps.getInteraction().interactionStatus(requiredString(chatId, 'chatId'))
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
