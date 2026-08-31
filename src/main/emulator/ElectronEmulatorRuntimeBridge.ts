/**
 * ElectronEmulatorRuntimeBridge — the main-owned, session-scoped loader for one
 * fixed packaged emulator surface.
 *
 * It intentionally implements only CanvasEmulatorDriver's boot/shutdown seam.
 * Typed observation, agent input, and eval policy remain separate future slices.
 * The renderer receives only its bundle's frozen `__twemu` facade; this bridge
 * never exports raw Module, HEAP, preload, or IPC authority.
 */
import type { CanvasEmulatorRuntimeBridge } from '../canvas/CanvasEmulatorDriver'
import type { CanvasHostSurface } from '../canvas/CanvasHostSurface'
import type { CanvasEmulatorGameId } from '../canvas/canvasTypes'
import {
  emulatorEntryUrl,
  resolveEmulatorAsset,
  type EmulatorAssetRegistry
} from './EmulatorAssetManifest'
import {
  registerEmulatorAssetProtocol,
  type EmulatorAssetProtocolRegistration,
  type EmulatorSessionProtocol
} from './EmulatorAssetProtocol'

const READY_TIMEOUT_MS = 10_000
const OPERATION_TIMEOUT_MS = 2_000
const READY_POLL_MS = 25
const EXPECTED_FACADE_KEYS = ['observe', 'ready', 'shutdown', 'step']
const TWGB_MAGIC = [0x54, 0x57, 0x47, 0x42]
const EXTERNAL_REQUEST_FILTER = { urls: ['*://*/*'] }

class EmulatorOperationTimeout extends Error {}

export interface ElectronEmulatorWebRequest {
  onBeforeRequest(
    filter: { urls: string[] },
    listener:
      | ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void)
      | null
  ): void
}

export interface ElectronEmulatorSession {
  protocol: EmulatorSessionProtocol
  webRequest: ElectronEmulatorWebRequest
  setPermissionCheckHandler(handler: ((...args: unknown[]) => boolean) | null): void
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: unknown,
          callback: (allowed: boolean) => void,
          details: unknown
        ) => void)
      | null
  ): void
  on(event: 'will-download', listener: (...args: unknown[]) => void): void
  removeListener(event: 'will-download', listener: (...args: unknown[]) => void): void
}

export interface ElectronEmulatorWebContents {
  session: ElectronEmulatorSession
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void
  setWebRTCIPHandlingPolicy?(policy: 'disable_non_proxied_udp'): void
  on(
    event: 'will-navigate' | 'did-fail-load' | 'render-process-gone',
    listener: (...args: unknown[]) => void
  ): void
  removeListener(
    event: 'will-navigate' | 'did-fail-load' | 'render-process-gone',
    listener: (...args: unknown[]) => void
  ): void
}

export interface EmulatorStableReadyState {
  readonly frameId: number
  readonly frameHash: string
  readonly width: 160
  readonly height: 144
  readonly magic: readonly [number, number, number, number]
  readonly schema: 1
  readonly status: 3
  readonly x: number
  readonly y: number
  readonly input: 0
  readonly frameCounter: number
}

export interface ElectronEmulatorRuntimeBridgeDeps {
  registry: EmulatorAssetRegistry
  readyTimeoutMs?: number
  operationTimeoutMs?: number
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
  /** Main-owned notification for a post-ready load/process fatality. */
  onFatal?: (input: { surface: CanvasHostSurface; reason: Error }) => void
}

interface LiveRuntime {
  readonly surface: CanvasHostSurface
  readonly contents: ElectronEmulatorWebContents
  readonly session: ElectronEmulatorSession
  readonly gameId: CanvasEmulatorGameId
  readonly entryUrl: string
  registration: EmulatorAssetProtocolRegistration | null
  cancelled: boolean
  loadFailure: Error | null
  cleanup: Promise<void> | null
  readonly onNavigate: (...args: unknown[]) => void
  readonly onLoadFailure: (...args: unknown[]) => void
  readonly onProcessGone: (...args: unknown[]) => void
  readonly onDownload: (...args: unknown[]) => void
  readonly onBeforeRequest: (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void
  ) => void
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new EmulatorOperationTimeout(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    )
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function isExactMagic(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === TWGB_MAGIC.length &&
    value.every((item, index) => item === TWGB_MAGIC[index])
  )
}

/** Main-side validation of the page-owned ready projection; never trust a string alone. */
export function validateEmulatorStableReady(value: unknown): EmulatorStableReadyState {
  const input = asRecord(value)
  const frameId = safeInteger(input?.frameId)
  const frameCounter = safeInteger(input?.frameCounter)
  const x = safeInteger(input?.x)
  const y = safeInteger(input?.y)
  if (
    !input ||
    input.frozen !== true ||
    input.moduleGlobal !== 'undefined' ||
    input.heapGlobal !== 'undefined' ||
    input.requireGlobal !== 'undefined' ||
    JSON.stringify(input.facadeKeys) !== JSON.stringify(EXPECTED_FACADE_KEYS) ||
    !isExactMagic(input.magic) ||
    input.schema !== 1 ||
    input.status !== 3 ||
    input.input !== 0 ||
    input.width !== 160 ||
    input.height !== 144 ||
    frameId === null ||
    frameId <= 0 ||
    frameCounter === null ||
    frameCounter <= 0 ||
    x === null ||
    x > 159 ||
    y === null ||
    y > 143 ||
    typeof input.frameHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.frameHash)
  ) {
    throw new Error('Emulator page did not provide a stable, bounded TWGB ready state.')
  }
  return Object.freeze({
    frameId,
    frameHash: input.frameHash,
    width: 160,
    height: 144,
    magic: [TWGB_MAGIC[0], TWGB_MAGIC[1], TWGB_MAGIC[2], TWGB_MAGIC[3]],
    schema: 1,
    status: 3,
    x,
    y,
    input: 0,
    frameCounter
  })
}

const READY_PROBE = `(() => {
  const api = globalThis.__twemu;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__twemu');
  if (!api || typeof api.ready !== 'function' || !Object.isFrozen(api) ||
      !descriptor || descriptor.writable !== false || descriptor.configurable !== false) {
    throw new Error('twemu facade is unavailable');
  }
  const facadeKeys = Object.keys(api).sort();
  return Promise.resolve(api.ready()).then((ready) => ({
    frozen: Object.isFrozen(api), facadeKeys,
    moduleGlobal: typeof globalThis.Module,
    heapGlobal: typeof globalThis.HEAPU8,
    requireGlobal: typeof globalThis.require,
    frameId: ready && ready.frameId,
    frameHash: ready && ready.frameHash,
    width: ready && ready.width,
    height: ready && ready.height,
    magic: ready && ready.magic,
    schema: ready && ready.schema,
    status: ready && ready.status,
    x: ready && ready.x,
    y: ready && ready.y,
    input: ready && ready.input,
    frameCounter: ready && ready.frameCounter
  }));
})()`

const SHUTDOWN_PROBE = `(() => {
  const api = globalThis.__twemu;
  if (!api || typeof api.shutdown !== 'function') return Promise.resolve(null);
  return Promise.resolve(api.shutdown()).catch(() => null);
})()`

function bridgeContents(surface: CanvasHostSurface): ElectronEmulatorWebContents {
  return surface.webContents as unknown as ElectronEmulatorWebContents
}

export class ElectronEmulatorRuntimeBridge implements CanvasEmulatorRuntimeBridge {
  private live: LiveRuntime | null = null
  private readonly readyTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(private readonly deps: ElectronEmulatorRuntimeBridgeDeps) {
    this.readyTimeoutMs = Math.max(100, Math.min(30_000, deps.readyTimeoutMs ?? READY_TIMEOUT_MS))
    this.operationTimeoutMs = Math.max(
      100,
      Math.min(10_000, deps.operationTimeoutMs ?? OPERATION_TIMEOUT_MS)
    )
    this.now = deps.now ?? Date.now
    this.sleep = deps.delay ?? delay
  }

  async boot(input: {
    gameId: CanvasEmulatorGameId
    url: string
    surface: CanvasHostSurface
  }): Promise<void> {
    if (this.live) throw new Error('An emulator runtime is already bound to this bridge.')
    if (input.surface.isDestroyed()) throw new Error('Emulator surface was destroyed before boot.')
    const entryUrl = emulatorEntryUrl(input.gameId)
    if (input.url !== entryUrl)
      throw new Error('Emulator runtime refused a non-canonical entry URL.')
    const contents = bridgeContents(input.surface)
    if (contents.isDestroyed()) throw new Error('Emulator WebContents was destroyed before boot.')
    const session = contents.session
    const live = this.createLive(input.surface, contents, session, input.gameId, entryUrl)
    this.live = live

    try {
      live.registration = await registerEmulatorAssetProtocol(session.protocol, this.deps.registry)
      this.installPolicies(live)
      await withTimeout(contents.loadURL(entryUrl), this.operationTimeoutMs, 'Emulator page load')
      await this.waitForStableReady(live)
      this.assertCurrent(live)
    } catch (error) {
      try {
        await this.cleanup(live, true, true)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Emulator boot and cleanup both failed.')
      }
      throw error
    }
  }

  async shutdown(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
  }): Promise<void> {
    const live = this.live
    if (!live || live.surface !== input.surface) return
    if (live.gameId !== input.gameId) throw new Error('Emulator shutdown game binding mismatch.')
    await this.cleanup(live, true)
  }

  private createLive(
    surface: CanvasHostSurface,
    contents: ElectronEmulatorWebContents,
    session: ElectronEmulatorSession,
    gameId: CanvasEmulatorGameId,
    entryUrl: string
  ): LiveRuntime {
    const live = {
      surface,
      contents,
      session,
      gameId,
      entryUrl,
      registration: null,
      cancelled: false,
      loadFailure: null,
      cleanup: null,
      onNavigate: () => {},
      onLoadFailure: () => {},
      onProcessGone: () => {},
      onDownload: () => {},
      onBeforeRequest: () => {}
    } as LiveRuntime
    live.onNavigate = (event: { preventDefault?: () => void }, target: unknown) => {
      if (target === entryUrl) return
      event.preventDefault?.()
    }
    live.onLoadFailure = (
      _event: unknown,
      code: unknown,
      description: unknown,
      url: unknown,
      isMainFrame: unknown
    ) => {
      if (isMainFrame === false) return
      const reason = new Error(
        `Emulator load failed (${String(code)}): ${String(description)} [${String(url)}]`
      )
      live.loadFailure = reason
      void this.handleFatal(live, reason)
    }
    live.onProcessGone = () => {
      const reason = new Error('Emulator renderer process exited.')
      live.loadFailure = reason
      void this.handleFatal(live, reason)
    }
    live.onDownload = (event: { preventDefault?: () => void }) => {
      event.preventDefault?.()
    }
    live.onBeforeRequest = (details, callback) => {
      let allowed = false
      try {
        allowed = resolveEmulatorAsset(this.deps.registry, details.url) !== null
      } catch {
        allowed = false
      }
      callback({ cancel: !allowed })
    }
    return live
  }

  private installPolicies(live: LiveRuntime): void {
    const { contents, session } = live
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      contents.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp')
    } catch {
      // Older Electron paths may lack the optional WebRTC policy hook.
    }
    contents.on('will-navigate', live.onNavigate)
    contents.on('did-fail-load', live.onLoadFailure)
    contents.on('render-process-gone', live.onProcessGone)
    session.webRequest.onBeforeRequest(EXTERNAL_REQUEST_FILTER, live.onBeforeRequest)
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_webContents, _permission, callback, _details) =>
      callback(false)
    )
    session.on('will-download', live.onDownload)
  }

  private async waitForStableReady(live: LiveRuntime): Promise<EmulatorStableReadyState> {
    const deadline = this.now() + this.readyTimeoutMs
    let lastError: unknown = null
    while (this.now() < deadline) {
      this.assertCurrent(live)
      if (live.loadFailure) throw live.loadFailure
      try {
        const value = await withTimeout(
          live.contents.executeJavaScript(READY_PROBE),
          this.operationTimeoutMs,
          'Emulator ready probe'
        )
        return validateEmulatorStableReady(value)
      } catch (error) {
        if (error instanceof EmulatorOperationTimeout) throw error
        lastError = error
      }
      await this.sleep(READY_POLL_MS)
    }
    throw new Error(
      `Emulator page did not reach stable ready state before timeout${
        lastError ? `: ${String(lastError)}` : ''
      }`
    )
  }

  private assertCurrent(live: LiveRuntime): void {
    if (
      this.live !== live ||
      live.cancelled ||
      live.surface.isDestroyed() ||
      live.contents.isDestroyed()
    ) {
      throw new Error('Emulator boot was cancelled because its surface closed.')
    }
  }

  private async handleFatal(live: LiveRuntime, reason: Error): Promise<void> {
    if (this.live !== live) return
    try {
      await this.cleanup(live, false, true)
    } catch {
      // The surface is still retired below; a retry remains available to callers.
    }
    try {
      this.deps.onFatal?.({ surface: live.surface, reason })
    } catch {
      // A diagnostic/retirement callback cannot retain this session's resources.
    }
  }

  private async cleanup(
    live: LiveRuntime,
    invokePageShutdown: boolean,
    forceDestroySurface = false
  ): Promise<void> {
    if (live.cleanup) return live.cleanup
    live.cancelled = true
    const operation = (async () => {
      let strictError: unknown = null
      let pageShutdownTimedOut = false
      try {
        if (invokePageShutdown && !live.contents.isDestroyed()) {
          try {
            await withTimeout(
              live.contents.executeJavaScript(SHUTDOWN_PROBE),
              this.operationTimeoutMs,
              'Emulator page shutdown'
            )
          } catch (error) {
            pageShutdownTimedOut = error instanceof EmulatorOperationTimeout
          }
        }
      } finally {
        try {
          live.contents.removeListener('will-navigate', live.onNavigate)
        } catch {}
        try {
          live.contents.removeListener('did-fail-load', live.onLoadFailure)
        } catch {}
        try {
          live.contents.removeListener('render-process-gone', live.onProcessGone)
        } catch {}
        // The driver supplies a unique in-memory partition, so clearing this
        // WebRequest slot removes only the bridge's own session policy.
        try {
          live.session.webRequest.onBeforeRequest(EXTERNAL_REQUEST_FILTER, null)
        } catch {}
        try {
          live.session.removeListener('will-download', live.onDownload)
        } catch {}
        try {
          live.session.setPermissionCheckHandler(null)
        } catch {}
        try {
          live.session.setPermissionRequestHandler(null)
        } catch {}
        if (live.registration) {
          try {
            await live.registration.unregister()
          } catch {
            try {
              await live.registration.unregister()
            } catch (error) {
              strictError = error
            }
          }
        }
        if ((forceDestroySurface || pageShutdownTimedOut) && !live.surface.isDestroyed()) {
          try {
            live.surface.destroy()
          } catch {}
        }
      }
      if (strictError) throw strictError
      if (this.live === live) this.live = null
    })()
    live.cleanup = operation
    void operation.catch(() => {
      if (live.cleanup === operation) live.cleanup = null
    })
    return operation
  }
}
