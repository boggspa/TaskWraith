import type {
  OnBeforeRequestListenerDetails,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
  OnSendHeadersListenerDetails,
  Session,
  WebContents
} from 'electron'

/**
 * TaskWraith's browser profile is durable but remains completely separate from
 * Chrome, Safari, the Electron default session, and provider credentials.
 */
export const CANVAS_BROWSER_PARTITION = 'persist:taskwraith-canvas-browser-v1'

export interface CanvasBrowserProfileRequestHandlers {
  shouldBlock(details: OnBeforeRequestListenerDetails): boolean | Promise<boolean>
  onSendHeaders(details: OnSendHeadersListenerDetails): void
  onCompleted(details: OnCompletedListenerDetails): void
  onErrorOccurred(details: OnErrorOccurredListenerDetails): void
}

export interface CanvasBrowserProfileController {
  readonly partition: string
  readonly activeSurfaceCount: number
  register(
    webContents: Pick<WebContents, 'id' | 'session'>,
    handlers: CanvasBrowserProfileRequestHandlers
  ): () => void
  clearBrowsingData(): Promise<void>
}

export interface CanvasBrowserProfileDeps {
  partition?: string
  /** Lazy because Electron sessions are unavailable before app readiness. */
  resolveSession?: (partition: string) => Session
}

interface RegisteredSurface {
  token: symbol
  handlers: CanvasBrowserProfileRequestHandlers
}

interface RequestOwner {
  token: symbol
  webContentsId: number
}

/**
 * One router owns the persistent partition's session-wide hooks.
 *
 * Electron's webRequest API keeps only the last listener registered for each
 * event. Per-canvas listeners therefore silently replace each other once pages
 * share a partition. This router installs each hook once, then dispatches by
 * webContentsId so every live canvas retains its own SSRF/eval gate and network
 * ring buffer while cookies and site storage remain app-wide.
 */
export class CanvasBrowserProfile implements CanvasBrowserProfileController {
  readonly partition: string

  private readonly resolveSession?: (partition: string) => Session
  private readonly surfaces = new Map<number, RegisteredSurface>()
  private readonly requestOwners = new Map<number, RequestOwner>()
  private boundSession: Session | null = null
  private sessionHooksInstalled = false

  constructor(deps: CanvasBrowserProfileDeps = {}) {
    this.partition = deps.partition ?? CANVAS_BROWSER_PARTITION
    this.resolveSession = deps.resolveSession
  }

  get activeSurfaceCount(): number {
    return this.surfaces.size
  }

  register(
    webContents: Pick<WebContents, 'id' | 'session'>,
    handlers: CanvasBrowserProfileRequestHandlers
  ): () => void {
    const webContentsId = webContents.id
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 0) {
      throw new Error('Canvas Browser requires a valid webContents id.')
    }
    if (this.surfaces.has(webContentsId)) {
      throw new Error(`Canvas Browser webContents ${webContentsId} is already registered.`)
    }

    this.bindSession(webContents.session)
    this.installSessionHooks()
    const token = Symbol(`canvas-browser-surface-${webContentsId}`)
    this.surfaces.set(webContentsId, { token, handlers })

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.surfaces.get(webContentsId)
      if (current?.token === token) this.surfaces.delete(webContentsId)
      for (const [requestId, owner] of this.requestOwners) {
        if (owner.token === token) this.requestOwners.delete(requestId)
      }
      try {
        this.boundSession?.flushStorageData()
      } catch {
        // Persistence flush is best effort; Chromium also flushes on its own.
      }
    }
  }

  async clearBrowsingData(): Promise<void> {
    if (this.surfaces.size > 0) {
      throw new Error('Close all Canvas Browser surfaces before clearing browsing data.')
    }
    const session = this.boundSession ?? this.resolveSession?.(this.partition)
    if (!session) throw new Error('Canvas Browser profile is not available yet.')
    this.bindSession(session)
    await session.clearStorageData()
    await session.clearCache()
    session.flushStorageData()
  }

  private bindSession(session: Session): void {
    if (this.boundSession && this.boundSession !== session) {
      throw new Error('Canvas Browser partition resolved to more than one Electron session.')
    }
    this.boundSession = session
  }

  private installSessionHooks(): void {
    if (this.sessionHooksInstalled) return
    const session = this.boundSession
    if (!session) throw new Error('Canvas Browser session is not bound.')

    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    try {
      session.setPermissionCheckHandler(() => false)
    } catch {
      // Best effort for Electron builds without the synchronous check hook.
    }
    session.on('will-download', (event) => event.preventDefault())

    const webRequest = session.webRequest
    webRequest.onBeforeRequest((details, callback) => {
      const routed = this.routeFor(details)
      if (!routed) {
        callback({ cancel: true })
        return
      }
      this.requestOwners.set(details.id, {
        token: routed.surface.token,
        webContentsId: routed.webContentsId
      })
      Promise.resolve()
        .then(() => routed.surface.handlers.shouldBlock(details))
        .then(
          (blocked) => {
            const live = this.surfaces.get(routed.webContentsId)
            callback({ cancel: blocked || live?.token !== routed.surface.token })
          },
          () => callback({ cancel: true })
        )
    })
    webRequest.onSendHeaders((details) => {
      const routed = this.routeFor(details)
      if (!routed) return
      this.requestOwners.set(details.id, {
        token: routed.surface.token,
        webContentsId: routed.webContentsId
      })
      routed.surface.handlers.onSendHeaders(details)
    })
    webRequest.onCompleted((details) => {
      const routed = this.routeForCompletion(details)
      this.requestOwners.delete(details.id)
      routed?.onCompleted(details)
    })
    webRequest.onErrorOccurred((details) => {
      const routed = this.routeForCompletion(details)
      this.requestOwners.delete(details.id)
      routed?.onErrorOccurred(details)
    })
    this.sessionHooksInstalled = true
  }

  private routeFor(details: {
    webContentsId?: number
    webContents?: Pick<WebContents, 'id'>
  }): { webContentsId: number; surface: RegisteredSurface } | null {
    const webContentsId =
      typeof details.webContentsId === 'number' ? details.webContentsId : details.webContents?.id
    if (typeof webContentsId !== 'number') return null
    const surface = this.surfaces.get(webContentsId)
    return surface ? { webContentsId, surface } : null
  }

  private routeForCompletion(details: {
    id: number
    webContentsId?: number
    webContents?: Pick<WebContents, 'id'>
  }): CanvasBrowserProfileRequestHandlers | null {
    const direct = this.routeFor(details)
    if (direct) return direct.surface.handlers
    const owner = this.requestOwners.get(details.id)
    if (!owner) return null
    const surface = this.surfaces.get(owner.webContentsId)
    return surface?.token === owner.token ? surface.handlers : null
  }
}
