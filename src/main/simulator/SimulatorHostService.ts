/**
 * TaskWraith-owned Simulator.app + simctl host for Simulator Canvas.
 * Argv-array exec only (no shell); deps are injectable for unit tests.
 *
 * Lifecycle ownership (Claude model):
 * - Prefer spawning the Simulator binary as a TaskWraith child (not launchd `open`).
 * - Only kill/quit Simulator.app when we started it and still own its birth identity.
 * - Only shutdown devices we ourselves booted; leave user-booted devices alone.
 * - dispose/release detach any registered stream and clear ownership state.
 */
import { execFile, spawn, type ChildProcess } from 'child_process'
import {
  access,
  chmod as fsChmod,
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  rm as fsRm
} from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  simulatorPointSizeFromPixels,
  type SimulatorCapabilityStatus,
  type SimulatorDeviceInfo,
  type SimulatorHostActionResult,
  type SimulatorScreenshotFrame
} from '../../shared/simulatorCanvas'
import {
  isSafeAppBundlePath,
  isValidBundleId,
  isValidSimUdid,
  readPngDimensions
} from '../canvas/canvasTypes'
import { probeSimulatorCapability } from './SimulatorCapability'
import { defaultSimctlRunner, type SimulatorSimctlRunner } from './SimctlRunner'

const TEMP_PREFIX = join(tmpdir(), 'simulator-canvas-shot-')

/** Result of opening Simulator.app — ownership is claimed only for child spawns. */
export type SimulatorSpawnResult = {
  pid: number | null
  /** True only when the Simulator binary was spawned as our direct child. */
  ownedChild: boolean
  child?: ChildProcess | null
}

export type SimulatorSpawnOpen = (appPath: string) => Promise<SimulatorSpawnResult>

/** Capability probe plus HostService lifecycle ownership fields. */
export type SimulatorHostStatus = SimulatorCapabilityStatus & {
  simulatorAppRunning: boolean
  ownedByUs: boolean
  ownedPid: number | null
}

/** Direction for `simctl pbsync` between the Mac host and a simulator. */
export type SimulatorPasteboardDirection = 'host-to-sim' | 'sim-to-host'

export type SimulatorReleaseResult = {
  ok: boolean
  error?: string
  closedSimulatorApp: boolean
  shutdownUdids: string[]
  detachedStream: boolean
}

export interface SimulatorHostServiceDeps {
  platform?: NodeJS.Platform
  runSimctl?: SimulatorSimctlRunner
  pathExists?: (path: string) => Promise<boolean>
  readFile?: (path: string) => Promise<Buffer>
  mkdtemp?: (prefix: string) => Promise<string>
  rm?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>
  chmod?: (path: string, mode: number) => Promise<void>
  spawnOpen?: SimulatorSpawnOpen
  /** Probe whether Simulator.app GUI is already running (user- or TaskWraith-booted). */
  probeSimulatorAppRunning?: () => Promise<boolean>
  /** Optional process-birth observer (pid reuse guard). */
  observeProcessBirth?: (pid: number) => Promise<string | null>
  isProcessAlive?: (pid: number) => boolean
  killProcess?: (pid: number, signal: NodeJS.Signals | number) => void
  /** Session-store / stream hook — called on dispose/release. */
  onDetachStream?: () => void | Promise<void>
  now?: () => string
}

const defaultPathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Prefer the Simulator binary as a TaskWraith child (stdio ignored, not detached).
 * Fall back to `open <appPath>` only when the binary is missing — that path never
 * claims ownership (the pid is the launchd helper, not Simulator).
 */
const defaultSpawnOpen: SimulatorSpawnOpen = async (appPath) => {
  const binaryPath = join(appPath, 'Contents', 'MacOS', 'Simulator')
  try {
    await access(binaryPath, fsConstants.X_OK)
    const child: ChildProcess = spawn(binaryPath, [], {
      // Keep as our child so dispose/quit can own the lifecycle.
      // Do not detach/unref — that orphans the process into launchd-like ownership.
      stdio: 'ignore'
    })
    return {
      pid: typeof child.pid === 'number' ? child.pid : null,
      ownedChild: true,
      child
    }
  } catch {
    return await new Promise<SimulatorSpawnResult>((resolve, reject) => {
      const child = execFile('open', [appPath], (err) => {
        if (err) reject(err)
        else {
          resolve({
            // `open` pid is not Simulator — never claim ownership.
            pid: typeof child.pid === 'number' ? child.pid : null,
            ownedChild: false,
            child: null
          })
        }
      })
    })
  }
}

const defaultIsProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const defaultKillProcess = (pid: number, signal: NodeJS.Signals | number): void => {
  process.kill(pid, signal)
}

const defaultProbeSimulatorAppRunning = async (): Promise<boolean> => {
  // pgrep -x matches the process name exactly; argv-array, no shell.
  return await new Promise((resolve) => {
    execFile('pgrep', ['-x', 'Simulator'], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve(false)
        return
      }
      resolve(Boolean(String(stdout || '').trim()))
    })
  })
}

function fail(
  error: string,
  extra: Partial<SimulatorHostActionResult> = {}
): SimulatorHostActionResult {
  return { ok: false, error, ...extra }
}

function ok(extra: Partial<SimulatorHostActionResult> = {}): SimulatorHostActionResult {
  return { ok: true, ...extra }
}

function requireUdid(udid: string): string | null {
  const trimmed = udid.trim()
  if (!trimmed || !isValidSimUdid(trimmed)) return null
  return trimmed
}

function isAlreadyBootedMessage(message: string): boolean {
  return /current state:\s*booted|already\s+booted/i.test(message)
}

function isAlreadyShutdownMessage(message: string): boolean {
  return /already (?:in )?(?:the )?shutdown|current state:\s*shutdown/i.test(message)
}

export class SimulatorHostService {
  private readonly platform: NodeJS.Platform
  private readonly runSimctl: SimulatorSimctlRunner
  private readonly pathExists: (path: string) => Promise<boolean>
  private readonly readFile: (path: string) => Promise<Buffer>
  private readonly mkdtemp: (prefix: string) => Promise<string>
  private readonly rm: (
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ) => Promise<void>
  private readonly chmod: (path: string, mode: number) => Promise<void>
  private readonly spawnOpen: SimulatorSpawnOpen
  private readonly probeSimulatorAppRunning: () => Promise<boolean>
  private readonly observeProcessBirth: ((pid: number) => Promise<string | null>) | null
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly killProcess: (pid: number, signal: NodeJS.Signals | number) => void
  private onDetachStream: (() => void | Promise<void>) | null
  private readonly now: () => string

  private ownedSimulatorPid: number | null = null
  private ownedSimulatorBirth: string | null = null
  private ownedChild: ChildProcess | null = null
  /** Devices we successfully transitioned from Shutdown → Booted. */
  private readonly ownedBootedUdids = new Set<string>()
  private disposed = false

  constructor(deps: SimulatorHostServiceDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.runSimctl = deps.runSimctl ?? defaultSimctlRunner
    this.pathExists = deps.pathExists ?? defaultPathExists
    this.readFile = deps.readFile ?? ((path) => fsReadFile(path))
    this.mkdtemp = deps.mkdtemp ?? ((prefix) => fsMkdtemp(prefix))
    this.rm = deps.rm ?? ((path, options) => fsRm(path, options))
    this.chmod = deps.chmod ?? ((path, mode) => fsChmod(path, mode))
    this.spawnOpen = deps.spawnOpen ?? defaultSpawnOpen
    this.probeSimulatorAppRunning = deps.probeSimulatorAppRunning ?? defaultProbeSimulatorAppRunning
    this.observeProcessBirth = deps.observeProcessBirth ?? null
    this.isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive
    this.killProcess = deps.killProcess ?? defaultKillProcess
    this.onDetachStream = deps.onDetachStream ?? null
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** Session store / composition-root hook for stream teardown on dispose. */
  setStreamDetachHandler(handler: (() => void | Promise<void>) | null): void {
    this.onDetachStream = handler
  }

  getOwnedSimulatorPid(): number | null {
    return this.ownedSimulatorPid
  }

  getOwnedBootedUdids(): string[] {
    return [...this.ownedBootedUdids]
  }

  async status(): Promise<SimulatorHostStatus> {
    const base = await probeSimulatorCapability({
      platform: this.platform,
      pathExists: this.pathExists,
      runSimctl: this.runSimctl,
      now: this.now
    })
    const ownership = await this.resolveOwnership()
    const externalRunning =
      !ownership.ownedByUs && this.platform === 'darwin'
        ? await this.probeSimulatorAppRunning()
        : false
    return {
      ...base,
      simulatorAppRunning: ownership.ownedByUs || externalRunning,
      ownedByUs: ownership.ownedByUs,
      ownedPid: ownership.ownedPid
    }
  }

  async openSimulatorApp(): Promise<SimulatorHostActionResult> {
    const status = await this.status()
    if (this.platform !== 'darwin') {
      return fail(status.installHint, { status })
    }
    if (!status.simulatorAppPath) {
      return fail(status.installHint || 'Simulator.app was not found on this Mac.', { status })
    }

    // Already running (user- or prior-session): attach for use, never claim kill rights.
    if (status.simulatorAppRunning) {
      return ok({ status, udid: status.bootedDevices[0]?.udid })
    }

    try {
      const opened = await this.spawnOpen(status.simulatorAppPath)
      if (
        opened.ownedChild &&
        typeof opened.pid === 'number' &&
        Number.isFinite(opened.pid) &&
        opened.pid > 0
      ) {
        const birth = this.observeProcessBirth
          ? await this.observeProcessBirth(opened.pid)
          : null
        this.ownedSimulatorPid = opened.pid
        this.ownedSimulatorBirth = birth
        this.ownedChild = opened.child ?? null
        this.ownedChild?.once('exit', () => {
          if (this.ownedSimulatorPid === opened.pid) {
            this.clearSimulatorOwnership()
          }
        })
      } else {
        // launchd `open` fallback — do not claim ownership.
        this.clearSimulatorOwnership()
      }
      const next = await this.status()
      return ok({ status: next, udid: next.bootedDevices[0]?.udid })
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : `Failed to open Simulator.app: ${String(error)}`,
        { status }
      )
    }
  }

  /**
   * Quit Simulator.app only when TaskWraith still owns the process birth.
   * Never kills a user-booted Simulator.
   */
  async closeSimulatorApp(): Promise<SimulatorHostActionResult> {
    const ownership = await this.resolveOwnership()
    if (!ownership.ownedByUs || ownership.ownedPid == null) {
      this.clearSimulatorOwnership()
      const status = await this.status()
      return ok({ status })
    }
    try {
      this.killProcess(ownership.ownedPid, 'SIGTERM')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // ESRCH — already gone — treat as success.
      if (!/ESRCH|kill ESRCH|No such process/i.test(message)) {
        const status = await this.status()
        return fail(message, { status })
      }
    }
    this.clearSimulatorOwnership()
    const status = await this.status()
    return ok({ status })
  }

  /**
   * Session-store hook: shutdown only devices we booted, close owned Simulator.app,
   * detach stream. Leaves user-booted devices and user-booted Simulator alone.
   * Safe to call again later (does not permanently retire the host service).
   */
  async release(): Promise<SimulatorReleaseResult> {
    return this.performRelease()
  }

  /**
   * App-quit hook: same owned-only cleanup as `release()`, then retires this instance.
   */
  async dispose(): Promise<SimulatorReleaseResult> {
    if (this.disposed) {
      return {
        ok: true,
        closedSimulatorApp: false,
        shutdownUdids: [],
        detachedStream: false
      }
    }
    const result = await this.performRelease()
    this.disposed = true
    return result
  }

  private async performRelease(): Promise<SimulatorReleaseResult> {
    const shutdownUdids: string[] = []
    const failures: string[] = []

    for (const udid of [...this.ownedBootedUdids]) {
      try {
        await this.runSimctl(['shutdown', udid])
        this.ownedBootedUdids.delete(udid)
        shutdownUdids.push(udid)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isAlreadyShutdownMessage(message)) {
          this.ownedBootedUdids.delete(udid)
          shutdownUdids.push(udid)
        } else {
          failures.push(`shutdown ${udid}: ${message}`)
        }
      }
    }

    // Snapshot ownership before close — birth mismatch drops the claim without killing.
    const ownershipBeforeClose = await this.resolveOwnership()
    const closeResult = await this.closeSimulatorApp()
    const closedSimulatorApp = ownershipBeforeClose.ownedByUs && closeResult.ok
    if (!closeResult.ok && closeResult.error) {
      failures.push(closeResult.error)
    }

    let detachedStream = false
    if (this.onDetachStream) {
      try {
        await this.onDetachStream()
        detachedStream = true
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : `stream detach failed: ${String(error)}`
        )
      }
    }

    return {
      ok: failures.length === 0,
      error: failures.length > 0 ? failures.join('; ') : undefined,
      closedSimulatorApp,
      shutdownUdids,
      detachedStream
    }
  }

  async listDevices(): Promise<{
    ok: boolean
    error?: string
    devices?: SimulatorDeviceInfo[]
    status?: SimulatorHostStatus
  }> {
    try {
      const status = await this.status()
      return {
        ok: true,
        devices: status.availableDevices,
        status
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async boot(udid: string): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')
    try {
      const alreadyBooted = await this.isDeviceBooted(valid)
      if (alreadyBooted) {
        // User- or externally-booted — never claim shutdown rights.
        return ok({ udid: valid })
      }
      await this.runSimctl(['boot', valid])
      this.ownedBootedUdids.add(valid)
      return ok({ udid: valid })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Booting an already-booted device is success for our purposes — but not ownership.
      if (isAlreadyBootedMessage(message)) {
        return ok({ udid: valid })
      }
      return fail(message, { udid: valid })
    }
  }

  /**
   * Sync the pasteboard between the Mac host and a simulator via
   * `simctl pbsync`. Clipboard CONTENT never enters this process — simctl
   * moves it directly, so nothing is logged and nothing crosses IPC.
   */
  async pasteboardSync(
    udid: string,
    direction: SimulatorPasteboardDirection
  ): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')
    const args =
      direction === 'host-to-sim' ? ['pbsync', 'host', valid] : ['pbsync', valid, 'host']
    try {
      await this.runSimctl(args)
      return ok({ udid: valid })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), { udid: valid })
    }
  }

  async install(udid: string, appPath: string): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')
    const path = (appPath || '').trim()
    if (!isSafeAppBundlePath(path)) {
      return fail('Invalid `appPath` (must be an absolute path to a .app bundle).', {
        udid: valid
      })
    }
    try {
      await this.runSimctl(['install', valid, path])
      return ok({ udid: valid })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), { udid: valid })
    }
  }

  async launch(udid: string, bundleId: string): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')
    const bundle = (bundleId || '').trim()
    if (!isValidBundleId(bundle)) {
      return fail(`Invalid bundleId "${bundleId}".`, { udid: valid })
    }
    try {
      await this.runSimctl(['launch', valid, bundle])
      return ok({ udid: valid })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), { udid: valid })
    }
  }

  async terminate(udid: string, bundleId?: string): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')
    const bundle = typeof bundleId === 'string' ? bundleId.trim() : ''
    if (!bundle) {
      return fail('terminate requires a bundleId.', { udid: valid })
    }
    if (!isValidBundleId(bundle)) {
      return fail(`Invalid bundleId "${bundleId}".`, { udid: valid })
    }
    try {
      await this.runSimctl(['terminate', valid, bundle])
      return ok({ udid: valid })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no such process|not (?:currently )?running|current state:\s*shutdown/i.test(message)) {
        return ok({ udid: valid })
      }
      return fail(message, { udid: valid })
    }
  }

  async screenshot(udid: string): Promise<SimulatorHostActionResult> {
    const valid = requireUdid(udid)
    if (!valid) return fail('Invalid simulator `udid` (expected a UUID or "booted").')

    let rootDir: string | null = null
    try {
      rootDir = await this.mkdtemp(TEMP_PREFIX)
      try {
        await this.chmod(rootDir, 0o700)
      } catch {
        // Best-effort private temp; continue if chmod is unavailable in tests.
      }
      const out = join(rootDir, 'screenshot.png')
      await this.runSimctl(['io', valid, 'screenshot', out])
      const png = await this.readFile(out)
      const { width, height } = readPngDimensions(png)
      const { pointWidth, pointHeight } = simulatorPointSizeFromPixels(width, height)
      const frame: SimulatorScreenshotFrame = {
        pngBase64: png.toString('base64'),
        width,
        height,
        pointWidth,
        pointHeight,
        capturedAt: this.now(),
        udid: valid
      }
      return ok({ udid: valid, frame })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), { udid: valid })
    } finally {
      if (rootDir) {
        try {
          await this.rm(rootDir, { recursive: true, force: true })
        } catch {
          // Temp cleanup is best-effort; do not mask the screenshot result.
        }
      }
    }
  }

  private async isDeviceBooted(udid: string): Promise<boolean> {
    try {
      const { stdout } = await this.runSimctl(['list', 'devices', 'available', '--json'])
      const parsed = JSON.parse(stdout) as {
        devices?: Record<string, Array<{ udid?: string; state?: string }>>
      }
      for (const list of Object.values(parsed.devices || {})) {
        for (const device of list) {
          if (device.udid === udid && device.state === 'Booted') return true
        }
      }
    } catch {
      return false
    }
    return false
  }

  private async resolveOwnership(): Promise<{ ownedByUs: boolean; ownedPid: number | null }> {
    const pid = this.ownedSimulatorPid
    if (pid == null) return { ownedByUs: false, ownedPid: null }
    if (!this.isProcessAlive(pid)) {
      this.clearSimulatorOwnership()
      return { ownedByUs: false, ownedPid: null }
    }
    if (this.ownedSimulatorBirth && this.observeProcessBirth) {
      const current = await this.observeProcessBirth(pid)
      if (!current || current !== this.ownedSimulatorBirth) {
        // Pid reused by a different process — drop claim, never kill.
        this.clearSimulatorOwnership()
        return { ownedByUs: false, ownedPid: null }
      }
    }
    return { ownedByUs: true, ownedPid: pid }
  }

  private clearSimulatorOwnership(): void {
    this.ownedSimulatorPid = null
    this.ownedSimulatorBirth = null
    this.ownedChild = null
  }
}
