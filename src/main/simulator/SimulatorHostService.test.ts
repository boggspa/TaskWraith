import { describe, expect, it, vi } from 'vitest'
import { SIMULATOR_APP_CANDIDATE_PATHS } from './SimulatorCapability'
import { SimulatorHostService } from './SimulatorHostService'

const UDID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
const UDID_B = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB'

/** Minimal PNG buffer with IHDR width/height. */
function fakePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

const SAMPLE_LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      {
        udid: UDID,
        name: 'iPhone 16',
        state: 'Booted',
        isAvailable: true
      },
      {
        udid: UDID_B,
        name: 'iPad Pro',
        state: 'Shutdown',
        isAvailable: true
      }
    ]
  }
})

function makeHost(
  opts: {
    runSimctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>
    spawnOpen?: (appPath: string) => Promise<{
      pid: number | null
      ownedChild: boolean
    }>
    platform?: NodeJS.Platform
    probeSimulatorAppRunning?: () => Promise<boolean>
    observeProcessBirth?: (pid: number) => Promise<string | null>
    isProcessAlive?: (pid: number) => boolean
    killProcess?: (pid: number, signal: NodeJS.Signals | number) => void
    onDetachStream?: () => void | Promise<void>
  } = {}
) {
  const calls: string[][] = []
  const runSimctl =
    opts.runSimctl ??
    (async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'list') {
        return { stdout: SAMPLE_LIST_JSON, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  const removed: string[] = []
  const killProcess = opts.killProcess ?? vi.fn()
  const host = new SimulatorHostService({
    platform: opts.platform ?? 'darwin',
    pathExists: async (path) =>
      path === SIMULATOR_APP_CANDIDATE_PATHS[0] || path === '/Applications/Xcode.app',
    runSimctl,
    readFile: async () => fakePng(390, 844),
    mkdtemp: async () => '/tmp/simulator-canvas-shot-test',
    rm: async (path) => {
      removed.push(path)
    },
    chmod: async () => {},
    spawnOpen: opts.spawnOpen ?? (async () => ({ pid: 4242, ownedChild: true })),
    probeSimulatorAppRunning: opts.probeSimulatorAppRunning ?? (async () => false),
    observeProcessBirth: opts.observeProcessBirth ?? (async (pid) => `birth-${pid}`),
    isProcessAlive: opts.isProcessAlive ?? ((pid) => pid > 0),
    killProcess,
    onDetachStream: opts.onDetachStream,
    now: () => '2026-08-07T12:00:00.000Z'
  })
  return { host, calls, removed: () => removed, runSimctl, killProcess }
}

describe('SimulatorHostService', () => {
  it('status() reports installed when simctl + Simulator.app are present', async () => {
    const { host } = makeHost()
    const status = await host.status()
    expect(status.installed).toBe(true)
    expect(status.simulatorAppPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
    expect(status.bootedDevices[0]?.udid).toBe(UDID)
  })

  it('status() reports simulatorAppRunning / ownedByUs / ownedPid lifecycle fields', async () => {
    const { host } = makeHost({
      spawnOpen: async () => ({ pid: 9991, ownedChild: true }),
      observeProcessBirth: async () => 'birth-9991',
      isProcessAlive: (pid) => pid === 9991
    })
    const before = await host.status()
    expect(before.simulatorAppRunning).toBe(false)
    expect(before.ownedByUs).toBe(false)
    expect(before.ownedPid).toBeNull()

    expect((await host.openSimulatorApp()).ok).toBe(true)
    const after = await host.status()
    expect(after.simulatorAppRunning).toBe(true)
    expect(after.ownedByUs).toBe(true)
    expect(after.ownedPid).toBe(9991)
  })

  it('openSimulatorApp claims ownership only for TaskWraith child spawns', async () => {
    const spawnOpen = vi.fn(async (appPath: string) => {
      expect(appPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
      return { pid: 9991, ownedChild: true }
    })
    const { host } = makeHost({ spawnOpen })
    const result = await host.openSimulatorApp()
    expect(result.ok).toBe(true)
    expect(spawnOpen).toHaveBeenCalledOnce()
    expect(host.getOwnedSimulatorPid()).toBe(9991)
    expect((await host.status()).ownedByUs).toBe(true)
  })

  it('openSimulatorApp does not claim ownership for launchd open fallback', async () => {
    const { host } = makeHost({
      spawnOpen: async () => ({ pid: 111, ownedChild: false })
    })
    expect((await host.openSimulatorApp()).ok).toBe(true)
    expect(host.getOwnedSimulatorPid()).toBeNull()
    const status = await host.status()
    expect(status.ownedByUs).toBe(false)
    expect(status.ownedPid).toBeNull()
  })

  it('openSimulatorApp never claims a user-booted Simulator already running', async () => {
    const spawnOpen = vi.fn(async () => ({ pid: 9991, ownedChild: true }))
    const { host, killProcess } = makeHost({
      probeSimulatorAppRunning: async () => true,
      spawnOpen
    })
    expect((await host.openSimulatorApp()).ok).toBe(true)
    expect(spawnOpen).not.toHaveBeenCalled()
    expect(host.getOwnedSimulatorPid()).toBeNull()
    expect((await host.status()).simulatorAppRunning).toBe(true)
    expect((await host.status()).ownedByUs).toBe(false)

    await host.closeSimulatorApp()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('closeSimulatorApp / release only kill when we still own the birth identity', async () => {
    const killProcess = vi.fn()
    let birth: string | null = 'birth-9991'
    const { host } = makeHost({
      spawnOpen: async () => ({ pid: 9991, ownedChild: true }),
      observeProcessBirth: async () => birth,
      isProcessAlive: () => true,
      killProcess
    })
    await host.openSimulatorApp()
    expect((await host.closeSimulatorApp()).ok).toBe(true)
    expect(killProcess).toHaveBeenCalledWith(9991, 'SIGTERM')
    expect(host.getOwnedSimulatorPid()).toBeNull()

    killProcess.mockClear()
    await host.openSimulatorApp()
    birth = 'reused-pid-different-birth'
    const released = await host.release()
    expect(released.closedSimulatorApp).toBe(false)
    expect(killProcess).not.toHaveBeenCalled()
    expect(host.getOwnedSimulatorPid()).toBeNull()
  })

  it('boot tracks only devices TaskWraith booted; dispose shuts those down and leaves user-booted alone', async () => {
    const booted = new Set<string>([UDID])
    const detachStream = vi.fn()
    const killProcess = vi.fn()
    const { host, calls } = makeHost({
      spawnOpen: async () => ({ pid: 4242, ownedChild: true }),
      killProcess,
      onDetachStream: detachStream,
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') {
          const devices = [
            {
              udid: UDID,
              name: 'iPhone 16',
              state: booted.has(UDID) ? 'Booted' : 'Shutdown',
              isAvailable: true
            },
            {
              udid: UDID_B,
              name: 'iPad Pro',
              state: booted.has(UDID_B) ? 'Booted' : 'Shutdown',
              isAvailable: true
            }
          ]
          return {
            stdout: JSON.stringify({
              devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': devices }
            }),
            stderr: ''
          }
        }
        if (args[0] === 'boot' && args[1]) {
          booted.add(args[1])
        }
        if (args[0] === 'shutdown' && args[1]) {
          booted.delete(args[1])
        }
        return { stdout: '', stderr: '' }
      }
    })

    // User-booted UDID is already Booted — boot() is ok but must not claim it.
    expect((await host.boot(UDID)).ok).toBe(true)
    expect(host.getOwnedBootedUdids()).not.toContain(UDID)

    expect((await host.boot(UDID_B)).ok).toBe(true)
    expect(host.getOwnedBootedUdids()).toContain(UDID_B)

    await host.openSimulatorApp()
    const released = await host.dispose()
    expect(released.shutdownUdids).toEqual([UDID_B])
    expect(calls).toContainEqual(['shutdown', UDID_B])
    expect(calls.some((c) => c[0] === 'shutdown' && c[1] === UDID)).toBe(false)
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(detachStream).toHaveBeenCalledOnce()
    expect(host.getOwnedBootedUdids()).toEqual([])
    expect(host.getOwnedSimulatorPid()).toBeNull()
  })

  it('listDevices returns available devices from the capability probe', async () => {
    const { host } = makeHost()
    const result = await host.listDevices()
    expect(result.ok).toBe(true)
    expect(result.devices?.map((d) => d.name)).toEqual(['iPhone 16', 'iPad Pro'])
  })

  it('boot/install/launch/terminate happy paths use simctl argv arrays', async () => {
    const { host, calls } = makeHost({
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') {
          // No devices booted — so boot() claims ownership.
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                  {
                    udid: UDID,
                    name: 'iPhone 16',
                    state: 'Shutdown',
                    isAvailable: true
                  }
                ]
              }
            }),
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }
    })
    expect((await host.boot(UDID)).ok).toBe(true)
    expect((await host.install(UDID, '/Users/me/Build/Example.app')).ok).toBe(true)
    expect((await host.launch(UDID, 'com.example.App')).ok).toBe(true)
    expect((await host.terminate(UDID, 'com.example.App')).ok).toBe(true)
    expect(calls).toContainEqual(['boot', UDID])
    expect(calls).toContainEqual(['install', UDID, '/Users/me/Build/Example.app'])
    expect(calls).toContainEqual(['launch', UDID, 'com.example.App'])
    expect(calls).toContainEqual(['terminate', UDID, 'com.example.App'])
  })

  it('screenshot returns a frame and cleans the temp directory', async () => {
    const { host, calls, removed } = makeHost()
    const result = await host.screenshot(UDID)
    expect(result.ok).toBe(true)
    expect(result.frame).toEqual({
      pngBase64: fakePng(390, 844).toString('base64'),
      width: 390,
      height: 844,
      capturedAt: '2026-08-07T12:00:00.000Z',
      udid: UDID
    })
    expect(calls).toContainEqual([
      'io',
      UDID,
      'screenshot',
      '/tmp/simulator-canvas-shot-test/screenshot.png'
    ])
    expect(removed()).toContain('/tmp/simulator-canvas-shot-test')
  })

  it('rejects invalid udid / bundleId / appPath before simctl', async () => {
    const { host, calls } = makeHost()
    expect((await host.boot('not-a-uuid')).ok).toBe(false)
    expect((await host.launch(UDID, 'com.x; rm -rf /')).ok).toBe(false)
    expect((await host.install(UDID, '/x/$(touch pwned).app')).ok).toBe(false)
    expect((await host.terminate(UDID)).ok).toBe(false)
    expect((await host.screenshot('bad')).ok).toBe(false)
    expect(calls.filter((c) => c[0] !== 'list')).toEqual([])
  })

  it('openSimulatorApp fails when Simulator.app is missing', async () => {
    const host = new SimulatorHostService({
      platform: 'darwin',
      pathExists: async () => false,
      runSimctl: async () => ({ stdout: SAMPLE_LIST_JSON, stderr: '' }),
      spawnOpen: async () => ({ pid: 1, ownedChild: true }),
      probeSimulatorAppRunning: async () => false
    })
    const result = await host.openSimulatorApp()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Simulator|Xcode/i)
    expect(host.getOwnedSimulatorPid()).toBeNull()
  })
})
