/**
 * IPC for the renderer canvas pane (live-embed). Kept out of the index.ts god-
 * module: the handler bodies live here and index.ts just calls
 * registerCanvasEmbedIpc once. The renderer opens an EMBEDDED web canvas (a
 * WebContentsView floated over its pane), then streams the pane's rect via
 * set-bounds and toggles set-visible on occlusion. These are HUMAN actions (the
 * user's own preview) — un-gated, but the driver still enforces the SSRF policy.
 */
import type { IpcMain } from 'electron'
import type { CanvasController } from './canvasTypes'
import type { CanvasEmbedController, CanvasEmbedRect } from './CanvasEmbedController'

export interface CanvasEmbedIpcDeps {
  controller: CanvasController
  embed: CanvasEmbedController
}

export function registerCanvasEmbedIpc(ipcMain: IpcMain, deps: CanvasEmbedIpcDeps): void {
  ipcMain.handle(
    'canvas:open-embedded',
    async (_e, args: { url?: string; originAllowlist?: string[] } | undefined) => {
      const opened = await deps.controller.open(
        {
          driver: 'web',
          url: args?.url,
          originAllowlist: Array.isArray(args?.originAllowlist) ? args.originAllowlist : undefined,
          embed: true
        },
        {}
      )
      return {
        canvasId: opened.canvasId,
        url: opened.url,
        title: opened.title,
        viewport: opened.viewport
      }
    }
  )

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
