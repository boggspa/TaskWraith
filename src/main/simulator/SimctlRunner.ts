/**
 * Shared `xcrun simctl` argv runner + device ops used by SimulatorHostService
 * and the Canvas `device` driver. Argv-array only (no shell).
 */
import { execFile } from 'child_process'

export const SIMCTL_TIMEOUT_MS = 60_000

export type SimctlResult = { stdout: string; stderr: string }

/** Runs `xcrun simctl <args…>` and resolves its output (rejects on non-zero). */
export type SimctlRunner = (args: string[]) => Promise<SimctlResult>

/** Alias kept for SimulatorCapability / HostService call sites. */
export type SimulatorSimctlRunner = SimctlRunner

/**
 * Throwing device ops over shared simctl argv. CanvasDeviceDriver orchestrates
 * lifecycle on top of these; SimulatorHostService exposes a result-shaped API
 * that can be adapted via {@link createHostBackedDeviceOps}.
 */
export interface SimctlDeviceOps {
  listBooted(): Promise<string[]>
  boot(udid: string): Promise<void>
  install(udid: string, appPath: string): Promise<void>
  launch(udid: string, bundleId: string): Promise<void>
  terminate(udid: string, bundleId: string): Promise<void>
  /** `simctl io <udid> screenshot <outPath>` — caller owns temp lifecycle. */
  screenshotToPath(udid: string, outPath: string): Promise<void>
  shutdown(udid: string): Promise<void>
}

type HostActionResult = { ok: boolean; error?: string }

/** Minimal host surface needed to back device ops (avoids circular imports). */
export interface SimctlHostDeviceFacade {
  boot(udid: string): Promise<HostActionResult>
  install(udid: string, appPath: string): Promise<HostActionResult>
  launch(udid: string, bundleId: string): Promise<HostActionResult>
  terminate(udid: string, bundleId?: string): Promise<HostActionResult>
  status(): Promise<{ bootedDevices: Array<{ udid: string }> }>
}

export function createDefaultSimctlRunner(timeoutMs: number = SIMCTL_TIMEOUT_MS): SimctlRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'xcrun',
        ['simctl', ...args],
        { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`simctl ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`))
          } else {
            resolve({ stdout, stderr })
          }
        }
      )
    })
}

/** Module-level default — same argv shape HostService / Capability used inline. */
export const defaultSimctlRunner: SimctlRunner = createDefaultSimctlRunner()

export function parseBootedUdids(stdout: string): string[] {
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

export async function listBootedUdids(run: SimctlRunner): Promise<string[]> {
  const { stdout } = await run(['list', 'devices', 'booted', '--json'])
  return parseBootedUdids(stdout)
}

export function createSimctlDeviceOps(run: SimctlRunner): SimctlDeviceOps {
  return {
    listBooted: () => listBootedUdids(run),
    boot: async (udid) => {
      await run(['boot', udid])
    },
    install: async (udid, appPath) => {
      await run(['install', udid, appPath])
    },
    launch: async (udid, bundleId) => {
      await run(['launch', udid, bundleId])
    },
    terminate: async (udid, bundleId) => {
      await run(['terminate', udid, bundleId])
    },
    screenshotToPath: async (udid, outPath) => {
      await run(['io', udid, 'screenshot', outPath])
    },
    shutdown: async (udid) => {
      await run(['shutdown', udid])
    }
  }
}

function assertHostOk(result: HostActionResult, verb: string): void {
  if (!result.ok) {
    throw new Error(result.error || `simctl ${verb} failed`)
  }
}

/**
 * Thin-wrap a SimulatorHostService-shaped facade. Boot/install/launch/terminate
 * and listBooted go through the host; screenshot path-write and shutdown stay on
 * the shared runner so Canvas close-race temp ownership remains driver-local.
 */
export function createHostBackedDeviceOps(
  host: SimctlHostDeviceFacade,
  run: SimctlRunner
): SimctlDeviceOps {
  const viaRunner = createSimctlDeviceOps(run)
  return {
    listBooted: async () => {
      const status = await host.status()
      return status.bootedDevices.map((d) => d.udid)
    },
    boot: async (udid) => {
      assertHostOk(await host.boot(udid), 'boot')
    },
    install: async (udid, appPath) => {
      assertHostOk(await host.install(udid, appPath), 'install')
    },
    launch: async (udid, bundleId) => {
      assertHostOk(await host.launch(udid, bundleId), 'launch')
    },
    terminate: async (udid, bundleId) => {
      assertHostOk(await host.terminate(udid, bundleId), 'terminate')
    },
    screenshotToPath: viaRunner.screenshotToPath,
    shutdown: viaRunner.shutdown
  }
}
