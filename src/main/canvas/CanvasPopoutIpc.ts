/** Chat-scoped IPC for moving Canvas renderer surfaces between dock and window. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { CanvasCallContext, CanvasSessionSummary } from './canvasTypes'
import type { CanvasEmbedIpcAuthority } from './CanvasEmbedIpc'
import {
  type CanvasPopoutOpenInput,
  type CanvasPopoutSessionSeed,
  type CanvasPopoutSurface,
  CanvasPopoutWindowManager
} from './CanvasPopoutWindowManager'

const SURFACES = new Set<CanvasPopoutSurface>([
  'browser',
  'sketch',
  'emulator',
  'mesh',
  'simulator',
  'media'
])

export interface CanvasPopoutIpcDeps {
  windows: Pick<CanvasPopoutWindowManager, 'open' | 'ownerForSender' | 'closeForDock'>
  canvas: Pick<CanvasEmbedIpcAuthority, 'transferRenderer' | 'ownedCanvasIds'>
  resolveContext(event: IpcMainInvokeEvent, chatId: string): CanvasCallContext
  mainRendererSenderId(): number | undefined
  showInDock(input: {
    chatId: string
    surface: CanvasPopoutSurface
    canvases: readonly CanvasSessionSummary[]
  }): void
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`Canvas pop-out ${label} is invalid.`)
  }
  return value
}

function parseSession(value: unknown): CanvasPopoutSessionSeed | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canvas pop-out session is invalid.')
  }
  const record = value as Record<string, unknown>
  const kind =
    record.kind === 'web' || record.kind === 'sketch' || record.kind === 'emulator'
      ? record.kind
      : null
  if (!kind) throw new Error('Canvas pop-out session kind is invalid.')
  return {
    canvasId: requiredString(record.canvasId, 'canvas id'),
    kind,
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {})
  }
}

function parseOpen(
  value: unknown,
  options: { requireEmulatorSession?: boolean } = {}
): CanvasPopoutOpenInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canvas pop-out request is invalid.')
  }
  const record = value as Record<string, unknown>
  const chatId = requiredString(record.chatId, 'chat id')
  const surface = SURFACES.has(record.surface as CanvasPopoutSurface)
    ? (record.surface as CanvasPopoutSurface)
    : null
  if (!surface) throw new Error('Canvas pop-out surface is invalid.')
  const session = parseSession(record.session)
  const expectedSurface =
    session?.kind === 'web'
      ? 'browser'
      : session?.kind === 'sketch'
        ? 'sketch'
        : session?.kind === 'emulator'
          ? 'emulator'
          : undefined
  if (session && surface !== expectedSurface) {
    throw new Error('Canvas pop-out surface does not match its live session.')
  }
  if (options.requireEmulatorSession && surface === 'emulator' && !session) {
    throw new Error('Emulator pop-out requires its matching live session.')
  }
  return { chatId, surface, ...(session ? { session } : {}) }
}

export function registerCanvasPopoutIpc(ipcMain: IpcMain, deps: CanvasPopoutIpcDeps): void {
  ipcMain.handle('canvas:open-popout', async (event, raw: unknown) => {
    try {
      const input = parseOpen(raw, { requireEmulatorSession: true })
      const context = deps.resolveContext(event, input.chatId)
      const sourceSenderId = event.sender.id
      const result = await deps.windows.open(input, (destinationSenderId) => {
        if (!input.session) return
        deps.canvas.transferRenderer({
          canvasIds: [input.session.canvasId],
          fromSenderId: sourceSenderId,
          toSenderId: destinationSenderId,
          context,
          toSurfaceHostId: destinationSenderId,
          expectedDriver: input.session.kind
        })
      })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('canvas:dock-popout', (event, raw: unknown) => {
    try {
      const input = parseOpen(raw)
      if (input.session) throw new Error('Dock request must not supply a session.')
      const owner = deps.windows.ownerForSender(event.sender.id)
      if (!owner || owner.chatId !== input.chatId) {
        throw new Error('Renderer does not own this Canvas pop-out.')
      }
      const context = deps.resolveContext(event, input.chatId)
      const mainSenderId = deps.mainRendererSenderId()
      if (!mainSenderId) throw new Error('Main window is unavailable.')
      const canvasIds = deps.canvas.ownedCanvasIds(event.sender.id)
      const canvases = canvasIds.length
        ? deps.canvas.transferRenderer({
            canvasIds,
            fromSenderId: event.sender.id,
            toSenderId: mainSenderId,
            toSurfaceHostId: mainSenderId,
            context,
            presentation: 'dock'
          })
        : []
      deps.showInDock({ chatId: input.chatId, surface: input.surface, canvases })
      deps.windows.closeForDock(event.sender.id)
      return { ok: true, canvasIds: canvases.map((canvas) => canvas.canvasId) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
