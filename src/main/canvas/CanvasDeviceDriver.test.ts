import { describe, it, expect } from 'vitest'
import { CanvasDeviceDriver, type SimctlResult } from './CanvasDeviceDriver'

const UDID_A = 'AAAAAAAA-1111-2222-3333-444444444444'
const UDID_B = 'BBBBBBBB-5555-6666-7777-888888888888'

/** A 24-byte buffer that parses as a PNG with a valid IHDR width/height. */
function fakePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function makeDriver(opts: { booted?: string[]; platform?: NodeJS.Platform } = {}) {
  const booted = opts.booted ?? [UDID_A]
  const calls: string[][] = []
  const runSimctl = async (args: string[]): Promise<SimctlResult> => {
    calls.push(args)
    if (args[0] === 'list') {
      const devices = { 'com.apple.CoreSimulator.SimRuntime.iOS-17-0': booted.map((udid) => ({ udid, state: 'Booted' })) }
      return { stdout: JSON.stringify({ devices }), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  let removed: string[] = []
  const driver = new CanvasDeviceDriver('sess', {
    runSimctl,
    readScreenshot: async () => fakePng(750, 1334),
    statPath: async () => ({ isDirectory: () => true }),
    removeFile: async (p) => {
      removed.push(p)
    },
    now: () => '2026-06-21T00:00:00.000Z',
    tmpFile: () => '/tmp/shot.png',
    platform: opts.platform ?? 'darwin'
  })
  return { driver, calls, removed: () => removed }
}

describe('CanvasDeviceDriver', () => {
  it('opens on the booted sim: launch + screenshot, no boot/install', async () => {
    const { driver, calls } = makeDriver()
    const handle = await driver.open({ bundleId: 'com.example.App' })
    expect(handle.title).toBe('com.example.App')
    expect(handle.url).toBe(`device://${UDID_A}/com.example.App`)
    expect(handle.viewport).toEqual({ width: 750, height: 1334 })
    expect(calls).toContainEqual(['launch', UDID_A, 'com.example.App'])
    expect(calls).toContainEqual(['io', UDID_A, 'screenshot', '/tmp/shot.png'])
    // No app path → no install; sim already booted → no boot.
    expect(calls.some((c) => c[0] === 'install')).toBe(false)
    expect(calls.some((c) => c[0] === 'boot')).toBe(false)
  })

  it('installs a provided .app before launch', async () => {
    const { driver, calls } = makeDriver()
    await driver.open({ bundleId: 'com.example.App', appPath: '/Users/me/Build/Example.app' })
    const idx = calls.findIndex((c) => c[0] === 'install')
    const launchIdx = calls.findIndex((c) => c[0] === 'launch')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(calls[idx]).toEqual(['install', UDID_A, '/Users/me/Build/Example.app'])
    expect(idx).toBeLessThan(launchIdx) // install precedes launch
  })

  it('boots a specific (un-booted) udid and shuts only it down on close', async () => {
    const { driver, calls } = makeDriver({ booted: [UDID_A] })
    await driver.open({ bundleId: 'com.example.App', device: { udid: UDID_B } })
    expect(calls).toContainEqual(['boot', UDID_B])
    await driver.close()
    expect(calls).toContainEqual(['terminate', UDID_B, 'com.example.App'])
    expect(calls).toContainEqual(['shutdown', UDID_B]) // we booted it → we shut it down
  })

  it('does NOT shut down a sim the user already had booted', async () => {
    const { driver, calls } = makeDriver({ booted: [UDID_A] })
    await driver.open({ bundleId: 'com.example.App' }) // uses already-booted UDID_A
    await driver.close()
    expect(calls).toContainEqual(['terminate', UDID_A, 'com.example.App'])
    expect(calls.some((c) => c[0] === 'shutdown')).toBe(false)
  })

  it('rejects when no simulator is booted and none specified', async () => {
    const { driver } = makeDriver({ booted: [] })
    await expect(driver.open({ bundleId: 'com.example.App' })).rejects.toThrow(/No booted simulator/)
  })

  it('rejects an invalid bundle id (no command injection surface)', async () => {
    const { driver, calls } = makeDriver()
    await expect(driver.open({ bundleId: 'com.x; rm -rf /' })).rejects.toThrow(/Invalid bundleId/)
    // Nothing was launched.
    expect(calls.some((c) => c[0] === 'launch')).toBe(false)
  })

  it('rejects an unsafe app path', async () => {
    const { driver } = makeDriver()
    await expect(
      driver.open({ bundleId: 'com.example.App', appPath: '/x/$(touch pwned).app' })
    ).rejects.toThrow(/Invalid `appPath`/)
  })

  it('rejects an invalid udid', async () => {
    const { driver } = makeDriver()
    await expect(
      driver.open({ bundleId: 'com.example.App', device: { udid: 'not-a-uuid' } })
    ).rejects.toThrow(/Invalid simulator/)
  })

  it('requires macOS', async () => {
    const { driver } = makeDriver({ platform: 'linux' })
    await expect(driver.open({ bundleId: 'com.example.App' })).rejects.toThrow(/requires macOS/)
  })

  it('screenshot returns base64 + dims + sha256 and cleans up the temp file', async () => {
    const { driver, removed } = makeDriver()
    await driver.open({ bundleId: 'com.example.App' })
    const frame = await driver.screenshot()
    expect(frame.mimeType).toBe('image/png')
    expect(frame.width).toBe(750)
    expect(frame.height).toBe(1334)
    expect(frame.byteLength).toBe(24)
    expect(frame.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(frame.data, 'base64').length).toBe(24)
    expect(removed()).toContain('/tmp/shot.png')
  })

  it('throws a clear error for the unsupported DOM verbs', async () => {
    const { driver } = makeDriver()
    await driver.open({ bundleId: 'com.example.App' })
    await expect(driver.snapshot()).rejects.toThrow(/screenshot-only/)
    await expect(driver.inspect()).rejects.toThrow(/screenshot-only/)
    await expect(driver.act({ kind: 'click', ref: 'e1' })).rejects.toThrow(/screenshot-only/)
    await expect(driver.evaluate({ script: '1' })).rejects.toThrow(/screenshot-only/)
    await expect(driver.annotate([])).rejects.toThrow(/screenshot-only/)
  })
})
