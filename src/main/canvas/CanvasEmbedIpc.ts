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
  CanvasNavigateInput,
  CanvasSessionSummary
} from './canvasTypes'
import type { CanvasBrowserProfileClearResult } from './CanvasService'
import type { CanvasEmbedController, CanvasEmbedRect } from './CanvasEmbedController'

export interface CanvasEmbedIpcDeps {
  controller: CanvasController
  embed: CanvasEmbedController
  /** Main-owned, app-wide human reset. Deliberately absent from CanvasController/MCP. */
  clearBrowserProfile: () => Promise<CanvasBrowserProfileClearResult>
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

type OpenArgs =
  | {
      url?: string
      originAllowlist?: string[]
      chatId?: string
      presentation?: 'dock'
    }
  | undefined
type OpenSketchArgs = { chatId?: string; presentation?: 'dock' } | undefined
type AdoptEmbeddedArgs = { chatId?: string; canvasId?: string } | undefined
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
  const owned = new Map<string, { context: CanvasCallContext; senderId: number | undefined }>()
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
          embed,
          ...(embed && args?.presentation === 'dock' ? { presentation: 'dock' as const } : {})
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
        {
          driver: 'sketch',
          embed,
          ...(embed && args?.presentation === 'dock' ? { presentation: 'dock' as const } : {})
        },
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
  ipcMain.handle('canvas:open-embedded', (event, args: OpenArgs) => openCanvas(event, args, true))
  ipcMain.handle('canvas:open-sketch-window', (event, args: OpenSketchArgs) =>
    openSketchCanvas(event, args, false)
  )
  ipcMain.handle('canvas:open-sketch-embedded', (event, args: OpenSketchArgs) =>
    openSketchCanvas(event, args, true)
  )

  // Agent-opened dock canvases already have a hidden WebContentsView, but are
  // not yet renderer-owned. Adoption binds that exact live surface to the
  // sender + canonical chat so the ordinary bounds/visibility/close handlers
  // can host it without changing canvasId or weakening renderer authority.
  ipcMain.handle('canvas:adopt-embedded', (event, args: AdoptEmbeddedArgs) => {
    try {
      const chatId = requiredChatId(args?.chatId)
      const canvasId = typeof args?.canvasId === 'string' ? args.canvasId.trim() : ''
      if (!canvasId) throw new Error('Canvas adoption requires a canvas id.')
      const context = deps.resolveContext(event, chatId)
      const existing = owned.get(canvasId)
      if (existing) {
        if (existing.senderId !== senderId(event) || !sameAuthority(existing.context, context)) {
          throw new Error('Canvas is already owned by a different renderer or chat.')
        }
      }
      if (!deps.embed.has(canvasId)) {
        throw new Error('Canvas does not have a live embedded surface to adopt.')
      }
      const summary = deps.controller.status(canvasId, context)
      if (!summary || summary.presentation !== 'dock') {
        throw new Error('Canvas is not an active dock presentation for this chat.')
      }
      owned.set(canvasId, { context, senderId: senderId(event) })
      return { ok: true, ...summary }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

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

  // Structured chart payload for a chat-owned chart canvas. Used by the dock
  // TelemetryPane when list/status did not already carry `chartDocument`
  // (or to refresh without re-listing). Redacted JSON only — no pixels.
  ipcMain.handle('canvas:chart-document', (event, chatId: unknown, canvasId: unknown) => {
    if (typeof canvasId !== 'string' || !canvasId) return null
    const context = deps.resolveContext(event, requiredChatId(chatId))
    return deps.controller.getChartDocument(canvasId, context)
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

  // App-wide Browser-profile reset is a HUMAN settings action. The channel is
  // no-argument and main-renderer-only at the global IPC boundary; no Canvas
  // MCP executor exposes it. CanvasService fences new web opens and contains
  // every existing web surface before Chromium storage is touched.
  ipcMain.handle('canvas:clear-browser-profile', async () => {
    try {
      const result = await deps.clearBrowserProfile()
      for (const canvasId of result.closedCanvasIds) {
        owned.delete(canvasId)
        deps.embed.detach(canvasId)
      }
      return { ok: true, closedSurfaceCount: result.closedSurfaceCount }
    } catch (err) {
      // A profile-data clear can fail after drivers were already contained.
      // Retire only renderer bookkeeping that no longer maps to a live Canvas;
      // leave genuinely live/failed-close surfaces owned so the human can retry.
      for (const [canvasId, entry] of owned) {
        try {
          const stillLive = deps.controller
            .list(entry.context)
            .some((candidate) => candidate.canvasId === canvasId)
          if (stillLive) continue
          owned.delete(canvasId)
          deps.embed.detach(canvasId)
        } catch {
          // Keep the ownership entry when liveness cannot be proven.
        }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Browser-chrome navigation for ANY web canvas in the sender's chat — the
  // human driving their own address bar / back / forward / reload / stop. The
  // HUMAN action is un-gated (like open/close above) but the driver still
  // enforces the full URL/DNS SSRF policy, and CanvasService still re-checks
  // chat ownership and serializes against in-flight agent interactions. The
  // human path never consumes the agent interaction budget.
  ipcMain.handle(
    'canvas:navigate-chat',
    async (event, chatId: unknown, canvasId: unknown, rawInput: unknown) => {
      if (typeof canvasId !== 'string' || !canvasId) {
        return { ok: false, error: 'Canvas id is required.' }
      }
      try {
        const context = deps.resolveContext(event, requiredChatId(chatId))
        const record = (rawInput ?? {}) as { url?: unknown; action?: unknown }
        const url = typeof record.url === 'string' ? record.url.trim() : ''
        const action =
          record.action === 'back' ||
          record.action === 'forward' ||
          record.action === 'reload' ||
          record.action === 'stop'
            ? record.action
            : undefined
        const input: CanvasNavigateInput = url ? { url } : { action }
        if (!input.url && !input.action) {
          return { ok: false, error: 'Provide a url or a navigation action.' }
        }
        const state = await deps.controller.navigate(canvasId, input, context, {
          chargeInteraction: false
        })
        return { ok: true, ...state }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

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
