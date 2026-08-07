import { describe, expect, it, vi } from 'vitest'
import { SIMULATOR_APP_CANDIDATE_PATHS } from './SimulatorCapability'
import { SimulatorHostService } from './SimulatorHostService'

const UDID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'

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
        udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
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
    spawnOpen?: (appPath: string) => Promise<{ pid: number | null }>
    platform?: NodeJS.Platform
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
    spawnOpen: opts.spawnOpen ?? (async () => ({ pid: 4242 })),
    now: () => '2026-08-07T12:00:00.000Z'
  })
  return { host, calls, removed: () => removed, runSimctl }
}

describe('SimulatorHostService', () => {
  it('status() reports installed when simctl + Simulator.app are present', async () => {
    const { host } = makeHost()
    const status = await host.status()
    expect(status.installed).toBe(true)
    expect(status.simulatorAppPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
    expect(status.bootedDevices[0]?.udid).toBe(UDID)
  })

  it('openSimulatorApp tracks owned pid best-effort', async () => {
    const spawnOpen = vi.fn(async (appPath: string) => {
      expect(appPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
      return { pid: 9991 }
    })
    const { host } = makeHost({ spawnOpen })
    const result = await host.openSimulatorApp()
    expect(result.ok).toBe(true)
    expect(spawnOpen).toHaveBeenCalledOnce()
    expect(host.getOwnedSimulatorPid()).toBe(9991)
  })

  it('listDevices returns available devices from the capability probe', async () => {
    const { host } = makeHost()
    const result = await host.listDevices()
    expect(result.ok).toBe(true)
    expect(result.devices?.map((d) => d.name)).toEqual(['iPhone 16', 'iPad Pro'])
  })

  it('boot/install/launch/terminate happy paths use simctl argv arrays', async () => {
    const { host, calls } = makeHost()
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
      spawnOpen: async () => ({ pid: 1 })
    })
    const result = await host.openSimulatorApp()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Simulator|Xcode/i)
    expect(host.getOwnedSimulatorPid()).toBeNull()
  })
})
