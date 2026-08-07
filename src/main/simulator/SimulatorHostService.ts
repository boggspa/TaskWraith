/**
 * TaskWraith-owned Simulator.app + simctl host for Simulator Canvas.
 * Argv-array exec only (no shell); deps are injectable for unit tests.
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
import { probeSimulatorCapability, type SimulatorSimctlRunner } from './SimulatorCapability'

const SIMCTL_TIMEOUT_MS = 60_000
const TEMP_PREFIX = join(tmpdir(), 'simulator-canvas-shot-')

export type SimulatorSpawnOpen = (appPath: string) => Promise<{ pid: number | null }>

export interface SimulatorHostServiceDeps {
  platform?: NodeJS.Platform
  runSimctl?: SimulatorSimctlRunner
  pathExists?: (path: string) => Promise<boolean>
  readFile?: (path: string) => Promise<Buffer>
  mkdtemp?: (prefix: string) => Promise<string>
  rm?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>
  chmod?: (path: string, mode: number) => Promise<void>
  spawnOpen?: SimulatorSpawnOpen
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

const defaultSimctl: SimulatorSimctlRunner = (args) =>
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

const defaultSpawnOpen: SimulatorSpawnOpen = async (appPath) => {
  const binaryPath = join(appPath, 'Contents', 'MacOS', 'Simulator')
  try {
    await access(binaryPath, fsConstants.X_OK)
    const child: ChildProcess = spawn(binaryPath, [], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return { pid: typeof child.pid === 'number' ? child.pid : null }
  } catch {
    // Fall back to `open <appPath>` — pid is best-effort (often the `open` helper).
    return await new Promise<{ pid: number | null }>((resolve, reject) => {
      const child = execFile('open', [appPath], (err) => {
        if (err) reject(err)
        else resolve({ pid: typeof child.pid === 'number' ? child.pid : null })
      })
    })
  }
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
  private readonly now: () => string
  private ownedSimulatorPid: number | null = null

  constructor(deps: SimulatorHostServiceDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.runSimctl = deps.runSimctl ?? defaultSimctl
    this.pathExists = deps.pathExists ?? defaultPathExists
    this.readFile = deps.readFile ?? ((path) => fsReadFile(path))
    this.mkdtemp = deps.mkdtemp ?? ((prefix) => fsMkdtemp(prefix))
    this.rm = deps.rm ?? ((path, options) => fsRm(path, options))
    this.chmod = deps.chmod ?? ((path, mode) => fsChmod(path, mode))
    this.spawnOpen = deps.spawnOpen ?? defaultSpawnOpen
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  getOwnedSimulatorPid(): number | null {
    return this.ownedSimulatorPid
  }

  async status(): Promise<SimulatorCapabilityStatus> {
    return probeSimulatorCapability({
      platform: this.platform,
      pathExists: this.pathExists,
      runSimctl: this.runSimctl,
      now: this.now
    })
  }

  async openSimulatorApp(): Promise<SimulatorHostActionResult> {
    const status = await this.status()
    if (this.platform !== 'darwin') {
      return fail(status.installHint, { status })
    }
    if (!status.simulatorAppPath) {
      return fail(status.installHint || 'Simulator.app was not found on this Mac.', { status })
    }
    try {
      const opened = await this.spawnOpen(status.simulatorAppPath)
      if (typeof opened.pid === 'number' && Number.isFinite(opened.pid) && opened.pid > 0) {
        this.ownedSimulatorPid = opened.pid
      }
      return ok({ status, udid: status.bootedDevices[0]?.udid })
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : `Failed to open Simulator.app: ${String(error)}`,
        { status }
      )
    }
  }

  async listDevices(): Promise<{
    ok: boolean
    error?: string
    devices?: SimulatorDeviceInfo[]
    status?: SimulatorCapabilityStatus
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
      await this.runSimctl(['boot', valid])
      return ok({ udid: valid })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Booting an already-booted device is success for our purposes.
      if (/current state:\s*booted|already\s+booted/i.test(message)) {
        return ok({ udid: valid })
      }
      return fail(message, { udid: valid })
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
      const frame: SimulatorScreenshotFrame = {
        pngBase64: png.toString('base64'),
        width,
        height,
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
}
