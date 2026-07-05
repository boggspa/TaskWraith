/**
 * IPC for the renderer-opened canvas (HUMAN actions — the user's own preview,
 * un-gated, but the driver still enforces the SSRF policy). Two open modes:
 *  - `canvas:open-window` → a standalone floating BrowserWindow (the default, and
 *    what the composer toolbar button uses — movable/closable, no DOM-overlay
 *    positioning to get wrong).
 *  - `canvas:open-embedded` → a WebContentsView floated over a multiview pane (the
 *    empty-pane launcher), positioned via set-bounds / set-visible.
 * Kept out of the index.ts god-module: index.ts just calls registerCanvasEmbedIpc.
 */
import type { IpcMain } from 'electron'
import type { CanvasController } from './canvasTypes'
import type { CanvasEmbedController, CanvasEmbedRect } from './CanvasEmbedController'

export interface CanvasEmbedIpcDeps {
  controller: CanvasController
  embed: CanvasEmbedController
}

type OpenArgs = { url?: string; originAllowlist?: string[]; chatId?: string } | undefined
type OpenSketchArgs = { chatId?: string } | undefined
type OpenCanvasResult =
  | {
      ok: true
      canvasId: string
      url: string
      title: string
      viewport: { width: number; height: number }
    }
  | { ok: false; error: string }

export function registerCanvasEmbedIpc(ipcMain: IpcMain, deps: CanvasEmbedIpcDeps): void {
  // A bad/unreachable url (e.g. no dev server) is a normal outcome, NOT an
  // exception — return it as a result so ipcMain doesn't log an unhandled handler
  // rejection and the renderer can surface it. CanvasService tears the half-opened
  // window/view down on a failed navigation.
  const openCanvas = async (
    args: OpenArgs,
    embed: boolean
  ): Promise<OpenCanvasResult> => {
    try {
      const opened = await deps.controller.open(
        {
          driver: 'web',
          url: args?.url,
          originAllowlist: Array.isArray(args?.originAllowlist) ? args.originAllowlist : undefined,
          embed
        },
        { chatId: typeof args?.chatId === 'string' ? args.chatId : undefined }
      )
      return {
        ok: true,
        canvasId: opened.canvasId,
        url: opened.url,
        title: opened.title,
        viewport: opened.viewport
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const openSketchCanvas = async (args: OpenSketchArgs): Promise<OpenCanvasResult> => {
    try {
      const opened = await deps.controller.open(
        { driver: 'sketch' },
        { chatId: typeof args?.chatId === 'string' ? args.chatId : undefined }
      )
      return {
        ok: true,
        canvasId: opened.canvasId,
        url: opened.url,
        title: opened.title,
        viewport: opened.viewport
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle('canvas:open-window', (_e, args: OpenArgs) => openCanvas(args, false))
  ipcMain.handle('canvas:open-embedded', (_e, args: OpenArgs) => openCanvas(args, true))
  ipcMain.handle('canvas:open-sketch-window', (_e, args: OpenSketchArgs) => openSketchCanvas(args))

  ipcMain.handle('canvas:set-bounds', (_e, canvasId: unknown, rect: unknown) => {
    if (typeof canvasId === 'string') {
      deps.embed.setBounds(canvasId, (rect ?? {}) as Partial<CanvasEmbedRect>)
    }
  })

  ipcMain.handle('canvas:set-visible', (_e, canvasId: unknown, visible: unknown) => {
    if (typeof canvasId === 'string') deps.embed.setVisible(canvasId, Boolean(visible))
  })

  ipcMain.handle('canvas:close', async (_e, canvasId: unknown) => {
    if (typeof canvasId === 'string') await deps.controller.close(canvasId, {})
  })

  ipcMain.handle('canvas:list', () => deps.controller.list({}))
}
