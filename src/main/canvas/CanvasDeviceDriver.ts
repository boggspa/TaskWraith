/**
 * CanvasDeviceDriver — the P4 `device` driver: a screenshot-only preview of an
 * app running in an iOS Simulator, driven entirely through `xcrun simctl`.
 *
 * Per the design's HARD BLOCKER, we do NOT try to drive Xcode's SwiftUI Canvas
 * (no public API). The native path is: boot a simulator → (optionally install a
 * built .app) → launch the app → screenshot the running app. The DOM/structured
 * verbs (snapshot/inspect/click/fill/eval/annotate/network/console/resize) have
 * no native analog without an extra harness (idb / XCUITest) and are therefore
 * UNSUPPORTED in this build — they throw a clear error rather than pretend.
 *
 * Security: every simctl call goes through `execFile('xcrun', ['simctl', …])`
 * with an argv ARRAY — there is NO shell, so agent-supplied values (bundle id /
 * app path / udid) cannot inject commands. They are additionally validated
 * (isValidBundleId / isValidSimUdid / isSafeAppBundlePath) for good errors and
 * defence-in-depth. The runner is injected so the orchestration is unit-testable
 * without Xcode.
 */
import { execFile } from 'child_process'
import { chmod, mkdtemp, readFile, rm, stat, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'
import {
  isSafeAppBundlePath,
  isValidBundleId,
  isValidSimUdid,
  readPngDimensions
} from './canvasTypes'

export interface SimctlResult {
  stdout: string
  stderr: string
}
/** Runs `xcrun simctl <args…>` and resolves its output (rejects on non-zero). */
export type SimctlRunner = (args: string[]) => Promise<SimctlResult>

export interface CanvasDeviceDriverDeps {
  runSimctl?: SimctlRunner
  readScreenshot?: (path: string) => Promise<Buffer>
  statPath?: (path: string) => Promise<{ isDirectory: () => boolean }>
  removeFile?: (path: string) => Promise<void>
  removeDirectory?: (path: string) => Promise<void>
  makeTempDirectory?: (prefix: string) => Promise<string>
  setPathMode?: (path: string, mode: number) => Promise<void>
  now?: () => string
  /** Test-only legacy hook. Production creates a private 0700 directory. */
  tmpFile?: () => string
  platform?: NodeJS.Platform
}

const SCREENSHOT_CANCELLED_MESSAGE = 'Device screenshot was cancelled because the Canvas closed.'
const OPEN_CANCELLED_MESSAGE = 'Device canvas open was cancelled because the Canvas closed.'

interface OwnedScreenshotTemp {
  path: string
  rootDir: string | null
}

interface PendingOpenResources {
  udid: string
  bundleId: string
  bootedByUs: boolean
  launched: boolean
}

const SIMCTL_TIMEOUT_MS = 60000

const defaultSimctl: SimctlRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'xcrun',
      ['simctl', ...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: SIMCTL_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`simctl ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`))
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the device driver (the iOS simulator preview is screenshot-only in this build).`
  )
}

export class CanvasDeviceDriver implements CanvasDriver {
  readonly kind = 'device' as const

  private udid: string | null = null
  private bundleId: string | null = null
  private bootedByUs = false
  private launched = false
  private closeRequested = false
  private lifecycleGeneration = 0
  private readonly inFlightScreenshots = new Set<Promise<CanvasFrame>>()
  private readonly inFlightOpens = new Set<Promise<CanvasSessionHandle>>()
  private readonly ownedTempFiles = new Set<OwnedScreenshotTemp>()
  private readonly pendingOpenResources = new Set<PendingOpenResources>()
  private closePromise: Promise<void> | null = null

  private readonly run: SimctlRunner
  private readonly readShot: (path: string) => Promise<Buffer>
  private readonly statPath: (path: string) => Promise<{ isDirectory: () => boolean }>
  private readonly removeFile: (path: string) => Promise<void>
  private readonly removeDirectory: (path: string) => Promise<void>
  private readonly makeTempDirectory: (prefix: string) => Promise<string>
  private readonly setPathMode: (path: string, mode: number) => Promise<void>
  private readonly nowFn: () => string
  private readonly tmpFileFn: (() => string) | null
  private readonly tempPrefix: string
  private readonly platform: NodeJS.Platform

  constructor(sessionId: string, deps: CanvasDeviceDriverDeps = {}) {
    this.run = deps.runSimctl ?? defaultSimctl
    this.readShot = deps.readScreenshot ?? ((p) => readFile(p))
    this.statPath = deps.statPath ?? ((p) => stat(p))
    this.removeFile = deps.removeFile ?? ((p) => unlink(p))
    this.removeDirectory = deps.removeDirectory ?? ((p) => rm(p))
    this.makeTempDirectory = deps.makeTempDirectory ?? ((prefix) => mkdtemp(prefix))
    this.setPathMode = deps.setPathMode ?? ((path, mode) => chmod(path, mode))
    this.nowFn = deps.now ?? (() => new Date().toISOString())
    this.tmpFileFn = deps.tmpFile ?? null
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'session'
    this.tempPrefix = join(tmpdir(), `canvas-shot-${safeSessionId}-`)
    this.platform = deps.platform ?? process.platform
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.closeRequested) throw new Error('Device canvas is closed.')
    const generation = this.lifecycleGeneration
    const operation = this.performOpen(input, generation)
    this.inFlightOpens.add(operation)
    try {
      return await operation
    } finally {
      this.inFlightOpens.delete(operation)
    }
  }

  private async performOpen(
    input: CanvasOpenInput,
    generation: number
  ): Promise<CanvasSessionHandle> {
    if (this.platform !== 'darwin') {
      throw new Error('The Canvas device driver requires macOS with Xcode simulators.')
    }
    const bundleId = (input.bundleId || '').trim()
    if (!bundleId) {
      throw new Error('The device driver requires a `bundleId` (e.g. "com.example.App").')
    }
    if (!isValidBundleId(bundleId)) {
      throw new Error(`Invalid bundleId "${bundleId}".`)
    }
    const wantUdid = (input.device?.udid || 'booted').trim()
    if (!isValidSimUdid(wantUdid)) {
      throw new Error('Invalid simulator `udid` (expected a UUID or "booted").')
    }

    const resources: PendingOpenResources = {
      udid: '',
      bundleId,
      bootedByUs: false,
      launched: false
    }
    try {
      await this.resolveDevice(wantUdid, generation, resources)
      const { udid } = resources
      const appPath = (input.appPath || '').trim()
      if (appPath) {
        if (!isSafeAppBundlePath(appPath)) {
          throw new Error('Invalid `appPath` (must be an absolute path to a .app bundle).')
        }
        await this.assertAppExists(appPath)
        this.assertOpenActive(generation)
        await this.run(['install', udid, appPath])
        this.assertOpenActive(generation)
      }

      await this.run(['launch', udid, bundleId])
      resources.launched = true
      this.assertOpenActive(generation)

      // Transfer ownership only after launch and its post-await generation
      // check. Before this point a close-raced open cleans its local resources.
      this.udid = udid
      this.bundleId = bundleId
      this.bootedByUs = resources.bootedByUs
      this.launched = true
      this.pendingOpenResources.delete(resources)

      const frame = await this.screenshot()
      this.assertOpenActive(generation)
      return {
        url: `device://${udid}/${bundleId}`,
        title: bundleId,
        viewport: { width: frame.width, height: frame.height }
      }
    } catch (error) {
      let cleanupError: unknown
      if (this.pendingOpenResources.has(resources)) {
        try {
          await this.cleanupPendingOpenResource(resources)
        } catch (caught) {
          cleanupError = caught
        }
      }
      if (this.openWasCancelled(generation)) {
        throw new Error(OPEN_CANCELLED_MESSAGE)
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Device canvas open failed and its local resources could not be cleaned.'
        )
      }
      throw error
    }
  }

  private async resolveDevice(
    want: string,
    generation: number,
    resources: PendingOpenResources
  ): Promise<void> {
    const booted = await this.listBooted()
    this.assertOpenActive(generation)
    resources.udid = want === 'booted' ? (booted[0] ?? '') : want
    if (!resources.udid) {
      throw new Error(
        'No booted simulator found. Boot one in Simulator.app, or pass `device.udid`.'
      )
    }
    this.pendingOpenResources.add(resources)
    if (want !== 'booted') {
      if (!booted.includes(want)) {
        await this.run(['boot', want])
        resources.bootedByUs = true
        this.assertOpenActive(generation)
      }
    }
  }

  private async listBooted(): Promise<string[]> {
    const { stdout } = await this.run(['list', 'devices', 'booted', '--json'])
    try {
      const parsed = JSON.parse(stdout) as {
        devices?: Record<string, Array<{ udid?: string; state?: string }>>
      }
      const out: string[] = []
      for (const list of Object.values(parsed.devices || {})) {
        for (const d of list) {
          if (d.state === 'Booted' && typeof d.udid === 'string') out.push(d.udid)
        }
      }
      return out
    } catch {
      return []
    }
  }

  private async assertAppExists(appPath: string): Promise<void> {
    try {
      const s = await this.statPath(appPath)
      if (!s.isDirectory()) throw new Error('not a bundle directory')
    } catch {
      throw new Error(`App bundle not found at "${appPath}".`)
    }
  }

  async screenshot(): Promise<CanvasFrame> {
    if (!this.udid || this.closeRequested) throw new Error('Device canvas is not open.')
    const generation = this.lifecycleGeneration
    const operation = this.captureScreenshot(generation)
    this.inFlightScreenshots.add(operation)
    try {
      return await operation
    } finally {
      this.inFlightScreenshots.delete(operation)
    }
  }

  private async captureScreenshot(generation: number): Promise<CanvasFrame> {
    const udid = this.udid
    if (!udid) throw new Error('Device canvas is not open.')
    let temp: OwnedScreenshotTemp
    try {
      temp = await this.allocateScreenshotTemp()
    } catch (error) {
      if (this.screenshotWasCancelled(generation)) {
        throw new Error(SCREENSHOT_CANCELLED_MESSAGE)
      }
      throw error
    }
    const out = temp.path
    let cleanupError: unknown
    let result: CanvasFrame | undefined
    let operationError: unknown
    try {
      if (this.screenshotWasCancelled(generation)) {
        throw new Error(SCREENSHOT_CANCELLED_MESSAGE)
      }
      await this.run(['io', udid, 'screenshot', out])
      if (this.screenshotWasCancelled(generation)) throw new Error(SCREENSHOT_CANCELLED_MESSAGE)
      const png = await this.readShot(out)
      if (this.screenshotWasCancelled(generation)) throw new Error(SCREENSHOT_CANCELLED_MESSAGE)
      const { width, height } = readPngDimensions(png)
      result = {
        mimeType: 'image/png',
        data: png.toString('base64'),
        width,
        height,
        byteLength: png.byteLength,
        hash: createHash('sha256').update(png).digest('hex'),
        capturedAt: this.nowFn()
      }
    } catch (error) {
      operationError = error
    }
    try {
      await this.removeOwnedTempFile(temp)
    } catch (error) {
      cleanupError = error
    }
    // close() may begin while unlink is pending. Re-check after the final await
    // so a valid frame can never escape after close has taken ownership.
    if (this.screenshotWasCancelled(generation)) {
      throw new Error(SCREENSHOT_CANCELLED_MESSAGE)
    }
    if (cleanupError) {
      throw new Error(`Device screenshot temp cleanup failed: ${String(cleanupError)}`)
    }
    if (operationError) throw operationError
    return result!
  }

  private screenshotWasCancelled(generation: number): boolean {
    return this.closeRequested || generation !== this.lifecycleGeneration
  }

  private openWasCancelled(generation: number): boolean {
    return this.closeRequested || generation !== this.lifecycleGeneration
  }

  private assertOpenActive(generation: number): void {
    if (this.openWasCancelled(generation)) throw new Error(OPEN_CANCELLED_MESSAGE)
  }

  private async allocateScreenshotTemp(): Promise<OwnedScreenshotTemp> {
    let temp: OwnedScreenshotTemp
    if (this.tmpFileFn) {
      temp = { path: this.tmpFileFn(), rootDir: null }
    } else {
      const rootDir = await this.makeTempDirectory(this.tempPrefix)
      temp = { path: join(rootDir, 'screenshot.png'), rootDir }
      this.ownedTempFiles.add(temp)
      try {
        await this.setPathMode(rootDir, 0o700)
      } catch (error) {
        try {
          await this.removeOwnedTempFile(temp)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Could not secure or remove screenshot temp allocation "${temp.path}".`
          )
        }
        throw error
      }
    }
    const collision = [...this.ownedTempFiles].some(
      (owned) => owned !== temp && owned.path === temp.path
    )
    if (collision) {
      if (temp.rootDir) {
        try {
          await this.removeOwnedTempFile(temp)
        } catch {
          // The allocation remains tracked for close to retry.
        }
      }
      throw new Error(`Device screenshot temp path collision: ${temp.path}`)
    }
    this.ownedTempFiles.add(temp)
    return temp
  }

  private async removeOwnedTempFile(temp: OwnedScreenshotTemp): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.removeFile(temp.path)
    } catch (error) {
      if (!isMissingFileError(error)) failures.push(error)
    }
    if (temp.rootDir) {
      try {
        await this.removeDirectory(temp.rootDir)
      } catch (error) {
        if (!isMissingFileError(error)) failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not remove screenshot temp allocation "${temp.path}".`
      )
    }
    this.ownedTempFiles.delete(temp)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closeRequested = true
    this.lifecycleGeneration += 1
    const attempt = this.performClose()
    this.closePromise = attempt
    void attempt.then(
      () => {},
      () => {
        // Lifecycle close remains terminal, but a later close call must retry
        // any exact temp/resource path retained after strict cleanup failed.
        if (this.closePromise === attempt) this.closePromise = null
      }
    )
    return attempt
  }

  private async performClose(): Promise<void> {
    await Promise.allSettled([...this.inFlightOpens])
    await Promise.allSettled([...this.inFlightScreenshots])

    const cleanupFailures: Error[] = []
    const pendingOpenResources = [...this.pendingOpenResources]
    const openCleanupOutcomes = await Promise.allSettled(
      pendingOpenResources.map((resources) => this.cleanupPendingOpenResource(resources))
    )
    openCleanupOutcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        appendCleanupFailures(
          cleanupFailures,
          `Device open cleanup failed for "${pendingOpenResources[index].bundleId}" on ${pendingOpenResources[index].udid}`,
          outcome.reason
        )
      }
    })

    // A capture always attempts its own unlink. Any path left in this set had a
    // failed cleanup, so close retries every one and reports all final failures.
    const remainingTempFiles = [...this.ownedTempFiles]
    const cleanupOutcomes = await Promise.allSettled(
      remainingTempFiles.map((temp) => this.removeOwnedTempFile(temp))
    )
    cleanupOutcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        appendCleanupFailures(
          cleanupFailures,
          `Device screenshot temp cleanup failed for "${remainingTempFiles[index].path}"`,
          outcome.reason
        )
      }
    })

    if (this.udid && this.bundleId) {
      const activeResources: PendingOpenResources = {
        udid: this.udid,
        bundleId: this.bundleId,
        launched: this.launched,
        bootedByUs: this.bootedByUs
      }
      try {
        await this.cleanupOwnedSimulatorResources(activeResources)
      } catch (error) {
        appendCleanupFailures(
          cleanupFailures,
          `Device active-resource cleanup failed for "${activeResources.bundleId}" on ${activeResources.udid}`,
          error
        )
      }
      this.launched = activeResources.launched
      this.bootedByUs = activeResources.bootedByUs
      if (!this.launched && !this.bootedByUs) {
        this.udid = null
        this.bundleId = null
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        `Device Canvas close encountered ${cleanupFailures.length} cleanup failure${cleanupFailures.length === 1 ? '' : 's'}.`
      )
    }
  }

  private async cleanupPendingOpenResource(resources: PendingOpenResources): Promise<void> {
    await this.cleanupOwnedSimulatorResources(resources)
    this.pendingOpenResources.delete(resources)
  }

  private async cleanupOwnedSimulatorResources(resources: PendingOpenResources): Promise<void> {
    const failures: unknown[] = []
    let terminateFailure: unknown
    if (resources.launched) {
      try {
        await this.run(['terminate', resources.udid, resources.bundleId])
        resources.launched = false
      } catch (error) {
        if (isAlreadyCleanSimctlError('terminate', error)) {
          resources.launched = false
        } else {
          terminateFailure = error
        }
      }
    }
    let shutdownFailure: unknown
    if (resources.bootedByUs) {
      try {
        await this.run(['shutdown', resources.udid])
        resources.bootedByUs = false
        resources.launched = false
      } catch (error) {
        if (isAlreadyCleanSimctlError('shutdown', error)) {
          resources.bootedByUs = false
          resources.launched = false
        } else {
          shutdownFailure = error
        }
      }
    }
    // A successful/known-already-complete shutdown also guarantees the app is
    // gone, so only report cleanup errors for resources that remain live.
    if (resources.launched && terminateFailure) failures.push(terminateFailure)
    if (resources.bootedByUs && shutdownFailure) failures.push(shutdownFailure)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not clean owned simulator resources.')
    }
  }

  // --- DOM/structured verbs: no native analog without idb/XCUITest. ---
  async snapshot(): Promise<CanvasElementTree> {
    return unsupported('snapshot')
  }
  async inspect(): Promise<CanvasElementDetail> {
    return unsupported('inspect')
  }
  async network(): Promise<CanvasNetworkEntry[]> {
    return unsupported('network')
  }
  async console(): Promise<CanvasConsoleEntry[]> {
    return unsupported('console')
  }
  async resize(_viewport: CanvasViewport): Promise<CanvasViewport> {
    return unsupported('resize')
  }
  async act(_action: CanvasActionInput): Promise<CanvasActResult> {
    return unsupported('click/fill')
  }
  async annotate(_marks: CanvasMark[]): Promise<{ count: number }> {
    return unsupported('annotate')
  }
  async sketchDocument(): Promise<CanvasSketchDocument> {
    return unsupported('sketch_get')
  }
  async sketchUpdate(_update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    return unsupported('sketch_update')
  }
  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }
  async reload(): Promise<void> {
    return unsupported('reload')
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isAlreadyCleanSimctlError(operation: 'terminate' | 'shutdown', error: unknown): boolean {
  const message = String(error)
  if (/invalid device(?: or device pair| identifier)?\s*:|no devices? found/i.test(message)) {
    return true
  }
  if (operation === 'terminate') {
    return /no such process|not (?:currently )?running|current state:\s*shutdown/i.test(message)
  }
  return /already (?:in )?(?:the )?shutdown|current state:\s*shutdown/i.test(message)
}

function appendCleanupFailures(target: Error[], context: string, error: unknown): void {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) appendCleanupFailures(target, context, cause)
    return
  }
  target.push(new Error(`${context}: ${String(error)}`))
}
