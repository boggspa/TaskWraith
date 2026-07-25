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
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type {
  CanvasCallContext,
  CanvasController,
  CanvasSessionSummary
} from './canvasTypes'
import type { CanvasEmbedController, CanvasEmbedRect } from './CanvasEmbedController'

export interface CanvasEmbedIpcDeps {
  controller: CanvasController
  embed: CanvasEmbedController
  /** Resolve payload chatId through main-owned sender/chat/clear authority. */
  resolveContext: (event: IpcMainInvokeEvent, chatId: string) => CanvasCallContext
}

export interface CanvasEmbedIpcAuthority {
  invalidateAuthorities: (input: {
    chatIds?: Iterable<string>
    workspacePaths?: Iterable<string>
  }) => string[]
  openChatIds: () => Set<string>
  clear: () => void
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

export function registerCanvasEmbedIpc(
  ipcMain: IpcMain,
  deps: CanvasEmbedIpcDeps
): CanvasEmbedIpcAuthority {
  const owned = new Map<
    string,
    { context: CanvasCallContext; senderId: number | undefined }
  >()
  const senderId = (event: IpcMainInvokeEvent): number | undefined => event.sender?.id
  const sameAuthority = (a: CanvasCallContext, b: CanvasCallContext): boolean =>
    a.chatId === b.chatId && a.workspacePath === b.workspacePath
  const requiredChatId = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error('Canvas open requires an active canonical chat.')
    }
    return value
  }
  const ownedEntry = (event: IpcMainInvokeEvent, canvasId: string) => {
    const entry = owned.get(canvasId)
    if (!entry || entry.senderId !== senderId(event) || !entry.context.chatId) {
      throw new Error('Renderer does not own this Canvas.')
    }
    const current = deps.resolveContext(event, entry.context.chatId)
    if (!sameAuthority(current, entry.context)) {
      throw new Error('Canvas chat authority changed.')
    }
    return entry
  }

  // A bad/unreachable url (e.g. no dev server) is a normal outcome, NOT an
  // exception — return it as a result so ipcMain doesn't log an unhandled handler
  // rejection and the renderer can surface it. CanvasService tears the half-opened
  // window/view down on a failed navigation.
  const openCanvas = async (
    event: IpcMainInvokeEvent,
    args: OpenArgs,
    embed: boolean
  ): Promise<OpenCanvasResult> => {
    let context: CanvasCallContext | undefined
    let openedCanvasId: string | undefined
    try {
      context = deps.resolveContext(event, requiredChatId(args?.chatId))
      const opened = await deps.controller.open(
        {
          driver: 'web',
          url: args?.url,
          originAllowlist: Array.isArray(args?.originAllowlist) ? args.originAllowlist : undefined,
          embed
        },
        context
      )
      openedCanvasId = opened.canvasId
      // Re-resolve after navigation: the chat may have been deleted/cleared
      // while the driver was awaiting DNS/load.
      const current = deps.resolveContext(event, context.chatId || '')
      if (!sameAuthority(current, context)) throw new Error('Canvas chat authority changed.')
      owned.set(opened.canvasId, { context, senderId: senderId(event) })
      return {
        ok: true,
        canvasId: opened.canvasId,
        url: opened.url,
        title: opened.title,
        viewport: opened.viewport
      }
    } catch (err) {
      if (openedCanvasId && context) {
        try {
          await deps.controller.close(openedCanvasId, context)
        } catch {
          // Scoped clear may already have retired the session.
        } finally {
          deps.embed.detach(openedCanvasId)
        }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const openSketchCanvas = async (
    event: IpcMainInvokeEvent,
    args: OpenSketchArgs,
    embed: boolean
  ): Promise<OpenCanvasResult> => {
    let context: CanvasCallContext | undefined
    let openedCanvasId: string | undefined
    try {
      context = deps.resolveContext(event, requiredChatId(args?.chatId))
      const opened = await deps.controller.open(
        { driver: 'sketch', embed },
        context
      )
      openedCanvasId = opened.canvasId
      const current = deps.resolveContext(event, context.chatId || '')
      if (!sameAuthority(current, context)) throw new Error('Canvas chat authority changed.')
      owned.set(opened.canvasId, { context, senderId: senderId(event) })
      return {
        ok: true,
        canvasId: opened.canvasId,
        url: opened.url,
        title: opened.title,
        viewport: opened.viewport
      }
    } catch (err) {
      if (openedCanvasId && context) {
        try {
          await deps.controller.close(openedCanvasId, context)
        } catch {
          // Scoped clear may already have retired the session.
        } finally {
          deps.embed.detach(openedCanvasId)
        }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle('canvas:open-window', (event, args: OpenArgs) => openCanvas(event, args, false))
  ipcMain.handle('canvas:open-embedded', (event, args: OpenArgs) =>
    openCanvas(event, args, true)
  )
  ipcMain.handle('canvas:open-sketch-window', (event, args: OpenSketchArgs) =>
    openSketchCanvas(event, args, false)
  )
  ipcMain.handle('canvas:open-sketch-embedded', (event, args: OpenSketchArgs) =>
    openSketchCanvas(event, args, true)
  )

  ipcMain.handle('canvas:set-bounds', (event, canvasId: unknown, rect: unknown) => {
    if (typeof canvasId === 'string') {
      ownedEntry(event, canvasId)
      deps.embed.setBounds(canvasId, (rect ?? {}) as Partial<CanvasEmbedRect>)
    }
  })

  ipcMain.handle('canvas:set-visible', (event, canvasId: unknown, visible: unknown) => {
    if (typeof canvasId === 'string') {
      ownedEntry(event, canvasId)
      deps.embed.setVisible(canvasId, Boolean(visible))
    }
  })

  ipcMain.handle('canvas:close', async (event, canvasId: unknown) => {
    if (typeof canvasId !== 'string') return
    const entry = ownedEntry(event, canvasId)
    owned.delete(canvasId)
    try {
      await deps.controller.close(canvasId, entry.context)
    } finally {
      deps.embed.detach(canvasId)
    }
  })

  // Chat-scoped visibility for the right-dock Canvas panel: EVERY open canvas in
  // the chat (agent-opened floating windows and html renders included), not just
  // the ones this renderer opened. Authority is the same main-owned
  // resolveContext gate every canvas call uses; summaries are redacted metadata
  // (no pixels), matching what canvas_list already exposes to agents.
  ipcMain.handle('canvas:list-chat', (event, chatId: unknown) => {
    const context = deps.resolveContext(event, requiredChatId(chatId))
    return deps.controller.list(context)
  })

  // Close ANY canvas in the sender's chat (the human closing an agent's canvas
  // is equivalent to closing its floating window by hand). CanvasService.close
  // re-checks chat ownership, so a canvasId from another chat throws.
  ipcMain.handle('canvas:close-chat', async (event, chatId: unknown, canvasId: unknown) => {
    if (typeof canvasId !== 'string') return
    const context = deps.resolveContext(event, requiredChatId(chatId))
    // Ownership check IS controller.close (chat-scoped); only clean up renderer
    // bookkeeping once it succeeds, so a cross-chat canvasId can't detach a view
    // that was never this chat's to touch.
    await deps.controller.close(canvasId, context)
    owned.delete(canvasId)
    deps.embed.detach(canvasId)
  })

  ipcMain.handle('canvas:list', (event) => {
    const summaries = new Map<string, CanvasSessionSummary>()
    for (const [canvasId, entry] of owned) {
      if (entry.senderId !== senderId(event) || !entry.context.chatId) continue
      try {
        const current = deps.resolveContext(event, entry.context.chatId)
        if (!sameAuthority(current, entry.context)) continue
        const summary = deps.controller
          .list(entry.context)
          .find((candidate) => candidate.canvasId === canvasId)
        if (summary) summaries.set(canvasId, summary)
      } catch {
        // A stale/cross-chat entry is never projected to this renderer.
      }
    }
    return [...summaries.values()]
  })

  return {
    invalidateAuthorities(input) {
      const chatIds = new Set([...(input.chatIds ?? [])])
      const workspacePaths = new Set([...(input.workspacePaths ?? [])])
      const invalidated: string[] = []
      for (const [canvasId, entry] of owned) {
        if (
          (entry.context.chatId && chatIds.has(entry.context.chatId)) ||
          (entry.context.workspacePath && workspacePaths.has(entry.context.workspacePath))
        ) {
          owned.delete(canvasId)
          deps.embed.detach(canvasId)
          invalidated.push(canvasId)
        }
      }
      return invalidated
    },
    openChatIds() {
      return new Set(
        [...owned.values()]
          .map((entry) => entry.context.chatId)
          .filter((chatId): chatId is string => Boolean(chatId))
      )
    },
    clear() {
      for (const canvasId of owned.keys()) deps.embed.detach(canvasId)
      owned.clear()
    }
  }
}
