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
import { readFile, stat, unlink } from 'fs/promises'
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
  CanvasViewport
} from './canvasTypes'
import { isSafeAppBundlePath, isValidBundleId, isValidSimUdid, readPngDimensions } from './canvasTypes'

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
  now?: () => string
  tmpFile?: () => string
  platform?: NodeJS.Platform
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

  private readonly run: SimctlRunner
  private readonly readShot: (path: string) => Promise<Buffer>
  private readonly statPath: (path: string) => Promise<{ isDirectory: () => boolean }>
  private readonly removeFile: (path: string) => Promise<void>
  private readonly nowFn: () => string
  private readonly tmpFileFn: () => string
  private readonly platform: NodeJS.Platform

  constructor(sessionId: string, deps: CanvasDeviceDriverDeps = {}) {
    this.run = deps.runSimctl ?? defaultSimctl
    this.readShot = deps.readScreenshot ?? ((p) => readFile(p))
    this.statPath = deps.statPath ?? ((p) => stat(p))
    this.removeFile = deps.removeFile ?? ((p) => unlink(p))
    this.nowFn = deps.now ?? (() => new Date().toISOString())
    this.tmpFileFn =
      deps.tmpFile ??
      (() => join(tmpdir(), `canvas-shot-${sessionId}-${Date.now()}.png`))
    this.platform = deps.platform ?? process.platform
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
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

    const udid = await this.resolveDevice(wantUdid)
    this.udid = udid
    this.bundleId = bundleId

    const appPath = (input.appPath || '').trim()
    if (appPath) {
      if (!isSafeAppBundlePath(appPath)) {
        throw new Error('Invalid `appPath` (must be an absolute path to a .app bundle).')
      }
      await this.assertAppExists(appPath)
      await this.run(['install', udid, appPath])
    }

    await this.run(['launch', udid, bundleId])
    this.launched = true

    const frame = await this.screenshot()
    return {
      url: `device://${udid}/${bundleId}`,
      title: bundleId,
      viewport: { width: frame.width, height: frame.height }
    }
  }

  private async resolveDevice(want: string): Promise<string> {
    const booted = await this.listBooted()
    if (want !== 'booted') {
      if (!booted.includes(want)) {
        await this.run(['boot', want])
        this.bootedByUs = true
      }
      return want
    }
    if (booted.length === 0) {
      throw new Error(
        'No booted simulator found. Boot one in Simulator.app, or pass `device.udid`.'
      )
    }
    return booted[0]
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
    if (!this.udid) throw new Error('Device canvas is not open.')
    const out = this.tmpFileFn()
    await this.run(['io', this.udid, 'screenshot', out])
    let png: Buffer
    try {
      png = await this.readShot(out)
    } finally {
      // Best-effort cleanup of the temp PNG — we keep only the in-memory bytes.
      this.removeFile(out).catch(() => {})
    }
    const { width, height } = readPngDimensions(png)
    return {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width,
      height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: this.nowFn()
    }
  }

  async close(): Promise<void> {
    const { udid, bundleId, launched, bootedByUs } = this
    this.udid = null
    this.launched = false
    if (udid && bundleId && launched) {
      // Terminate only the app we launched — never the user's other apps.
      try {
        await this.run(['terminate', udid, bundleId])
      } catch {
        // App may already be gone.
      }
    }
    if (udid && bootedByUs) {
      // Only shut down a simulator WE booted; never one the user already had up.
      try {
        await this.run(['shutdown', udid])
      } catch {
        // Best effort.
      }
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
  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }
}
