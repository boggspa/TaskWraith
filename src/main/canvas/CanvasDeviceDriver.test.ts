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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ok: SimctlResult = { stdout: '', stderr: '' }

function bootedList(udids: string[] = [UDID_A]): SimctlResult {
  return {
    stdout: JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': udids.map((udid) => ({
          udid,
          state: 'Booted'
        }))
      }
    }),
    stderr: ''
  }
}

function makeDriver(opts: { booted?: string[]; platform?: NodeJS.Platform } = {}) {
  const booted = opts.booted ?? [UDID_A]
  const calls: string[][] = []
  const runSimctl = async (args: string[]): Promise<SimctlResult> => {
    calls.push(args)
    if (args[0] === 'list') {
      const devices = {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': booted.map((udid) => ({
          udid,
          state: 'Booted'
        }))
      }
      return { stdout: JSON.stringify({ devices }), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const removed: string[] = []
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
    await expect(driver.open({ bundleId: 'com.example.App' })).rejects.toThrow(
      /No booted simulator/
    )
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

  it('close blocks new screenshots synchronously and joins a simctl screenshot already in flight', async () => {
    const captureStarted = deferred<void>()
    const captureResult = deferred<SimctlResult>()
    const calls: string[][] = []
    let screenshotCount = 0
    const driver = new CanvasDeviceDriver('close-during-capture', {
      platform: 'darwin',
      tmpFile: () => '/tmp/close-during-capture.png',
      readScreenshot: async () => fakePng(10, 20),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if (args[0] === 'io' && ++screenshotCount === 2) {
          captureStarted.resolve()
          return captureResult.promise
        }
        return ok
      }
    })
    await driver.open({ bundleId: 'com.example.App' })

    const screenshot = driver.screenshot()
    await captureStarted.promise
    const close = driver.close()
    expect(driver.close()).toBe(close)
    await expect(driver.screenshot()).rejects.toThrow('Device canvas is not open.')

    let closeSettled = false
    void close.finally(() => {
      closeSettled = true
    })
    await Promise.resolve()
    expect(closeSettled).toBe(false)

    captureResult.resolve(ok)
    await expect(screenshot).rejects.toThrow(
      'Device screenshot was cancelled because the Canvas closed.'
    )
    await close
    expect(calls).toContainEqual(['terminate', UDID_A, 'com.example.App'])
  })

  it('does not return a late frame when close begins during final temp unlink', async () => {
    const unlinkStarted = deferred<void>()
    const unlinkResult = deferred<void>()
    let removeCount = 0
    const driver = new CanvasDeviceDriver('late-frame', {
      platform: 'darwin',
      tmpFile: () => '/tmp/late-frame.png',
      runSimctl: async (args) => (args[0] === 'list' ? bootedList() : ok),
      readScreenshot: async () => fakePng(30, 40),
      removeFile: async () => {
        removeCount += 1
        if (removeCount === 2) {
          unlinkStarted.resolve()
          return unlinkResult.promise
        }
      }
    })
    await driver.open({ bundleId: 'com.example.App' })

    const screenshot = driver.screenshot()
    await unlinkStarted.promise
    const close = driver.close()
    unlinkResult.resolve()

    await expect(screenshot).rejects.toThrow(
      'Device screenshot was cancelled because the Canvas closed.'
    )
    await close
  })

  it('reports a temp-delete failure and retries the exact retained path on the next close', async () => {
    const firstDeleteStarted = deferred<void>()
    const firstDeleteResult = deferred<void>()
    const removed: string[] = []
    let removeCount = 0
    let cleanupCanSucceed = false
    const tempPath = '/tmp/retry-owned-temp.png'
    const driver = new CanvasDeviceDriver('retry-cleanup', {
      platform: 'darwin',
      tmpFile: () => tempPath,
      runSimctl: async (args) => (args[0] === 'list' ? bootedList() : ok),
      readScreenshot: async () => fakePng(50, 60),
      removeFile: async (path) => {
        removed.push(path)
        removeCount += 1
        if (removeCount === 2) {
          firstDeleteStarted.resolve()
          return firstDeleteResult.promise
        }
        if (removeCount > 2 && !cleanupCanSucceed) throw new Error('temp is locked')
      }
    })
    await driver.open({ bundleId: 'com.example.App' })

    const screenshot = driver.screenshot()
    await firstDeleteStarted.promise
    const firstClose = driver.close()
    firstDeleteResult.reject(new Error('first unlink failed'))
    await expect(screenshot).rejects.toThrow(
      'Device screenshot was cancelled because the Canvas closed.'
    )
    await expect(firstClose).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error)]
    })

    cleanupCanSucceed = true
    await driver.close()
    expect(removed.filter((path) => path === tempPath).length).toBeGreaterThanOrEqual(3)
  })

  it('attempts every outstanding temp cleanup and aggregates all final failures', async () => {
    const paths = ['/tmp/open.png', '/tmp/a.png', '/tmp/b.png']
    const initialDeletes = new Map([
      ['/tmp/a.png', deferred<void>()],
      ['/tmp/b.png', deferred<void>()]
    ])
    const initialDeleteStarted = new Set<string>()
    const attempts: string[] = []
    const driver = new CanvasDeviceDriver('aggregate-cleanup', {
      platform: 'darwin',
      tmpFile: () => paths.shift()!,
      runSimctl: async (args) => (args[0] === 'list' ? bootedList() : ok),
      readScreenshot: async () => fakePng(70, 80),
      removeFile: async (path) => {
        attempts.push(path)
        const gate = initialDeletes.get(path)
        if (gate && !initialDeleteStarted.has(path)) {
          initialDeleteStarted.add(path)
          return gate.promise
        }
        if (path !== '/tmp/open.png') throw new Error(`locked: ${path}`)
      }
    })
    await driver.open({ bundleId: 'com.example.App' })

    const first = driver.screenshot()
    const second = driver.screenshot()
    while (initialDeleteStarted.size < 2) await Promise.resolve()
    const close = driver.close()
    initialDeletes.get('/tmp/a.png')!.reject(new Error('a unlink failed'))
    initialDeletes.get('/tmp/b.png')!.reject(new Error('b unlink failed'))

    await expect(first).rejects.toThrow(
      'Device screenshot was cancelled because the Canvas closed.'
    )
    await expect(second).rejects.toThrow(
      'Device screenshot was cancelled because the Canvas closed.'
    )
    try {
      await close
      throw new Error('expected close to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError
      expect(aggregate.errors).toHaveLength(2)
      expect(aggregate.errors.map(String).join('\n')).toContain('/tmp/a.png')
      expect(aggregate.errors.map(String).join('\n')).toContain('/tmp/b.png')
    }
    expect(attempts).toEqual(
      expect.arrayContaining(['/tmp/a.png', '/tmp/b.png', '/tmp/a.png', '/tmp/b.png'])
    )
  })

  it('close during install waits for it and prevents the late launch', async () => {
    const installStarted = deferred<void>()
    const installResult = deferred<SimctlResult>()
    const calls: string[][] = []
    const driver = new CanvasDeviceDriver('close-install', {
      platform: 'darwin',
      tmpFile: () => '/tmp/unused-install.png',
      statPath: async () => ({ isDirectory: () => true }),
      readScreenshot: async () => fakePng(90, 100),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if (args[0] === 'install') {
          installStarted.resolve()
          return installResult.promise
        }
        return ok
      }
    })

    const opening = driver.open({
      bundleId: 'com.example.App',
      appPath: '/Users/me/Build/Example.app'
    })
    await installStarted.promise
    const close = driver.close()
    installResult.resolve(ok)

    await expect(opening).rejects.toThrow(
      'Device canvas open was cancelled because the Canvas closed.'
    )
    await close
    expect(calls.some((args) => args[0] === 'launch')).toBe(false)
  })

  it('close during launch terminates the app after the late launch resolves', async () => {
    const launchStarted = deferred<void>()
    const launchResult = deferred<SimctlResult>()
    const calls: string[][] = []
    const driver = new CanvasDeviceDriver('close-launch', {
      platform: 'darwin',
      tmpFile: () => '/tmp/unused-launch.png',
      readScreenshot: async () => fakePng(110, 120),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if (args[0] === 'launch') {
          launchStarted.resolve()
          return launchResult.promise
        }
        return ok
      }
    })

    const opening = driver.open({ bundleId: 'com.example.App' })
    await launchStarted.promise
    const close = driver.close()
    launchResult.resolve(ok)

    await expect(opening).rejects.toThrow(
      'Device canvas open was cancelled because the Canvas closed.'
    )
    await close
    expect(
      calls.filter(
        (args) => args[0] === 'terminate' && args[1] === UDID_A && args[2] === 'com.example.App'
      )
    ).toHaveLength(1)
  })

  it('retains active native resources and aggregates terminate and shutdown failures for retry', async () => {
    const calls: string[][] = []
    let cleanupCanSucceed = false
    const driver = new CanvasDeviceDriver('retry-active-native', {
      platform: 'darwin',
      tmpFile: () => '/tmp/retry-active-native.png',
      readScreenshot: async () => fakePng(115, 125),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if ((args[0] === 'terminate' || args[0] === 'shutdown') && !cleanupCanSucceed) {
          throw new Error(`${args[0]} remained live`)
        }
        return ok
      }
    })
    await driver.open({ bundleId: 'com.example.App', device: { udid: UDID_B } })

    try {
      await driver.close()
      throw new Error('expected close to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError
      expect(aggregate.errors).toHaveLength(2)
      expect(aggregate.errors.map(String).join('\n')).toContain('terminate remained live')
      expect(aggregate.errors.map(String).join('\n')).toContain('shutdown remained live')
    }

    cleanupCanSucceed = true
    await driver.close()
    expect(calls.filter((args) => args[0] === 'terminate')).toHaveLength(2)
    expect(calls.filter((args) => args[0] === 'shutdown')).toHaveLength(2)
  })

  it('treats narrow simctl already-gone results as successful native cleanup', async () => {
    const calls: string[][] = []
    const driver = new CanvasDeviceDriver('already-gone-native', {
      platform: 'darwin',
      tmpFile: () => '/tmp/already-gone-native.png',
      readScreenshot: async () => fakePng(116, 126),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if (args[0] === 'terminate') {
          throw new Error('simctl terminate failed: No such process')
        }
        if (args[0] === 'shutdown') {
          throw new Error('Unable to shutdown device in current state: Shutdown')
        }
        return ok
      }
    })
    await driver.open({ bundleId: 'com.example.App', device: { udid: UDID_B } })

    const close = driver.close()
    await close
    expect(driver.close()).toBe(close)
    expect(calls.filter((args) => args[0] === 'terminate')).toHaveLength(1)
    expect(calls.filter((args) => args[0] === 'shutdown')).toHaveLength(1)
  })

  it('retains a late-launched app when strict termination fails and retries its exact identity', async () => {
    const launchStarted = deferred<void>()
    const launchResult = deferred<SimctlResult>()
    const calls: string[][] = []
    let terminateCanSucceed = false
    const driver = new CanvasDeviceDriver('retry-late-launch', {
      platform: 'darwin',
      tmpFile: () => '/tmp/retry-late-launch.png',
      readScreenshot: async () => fakePng(117, 127),
      removeFile: async () => {},
      runSimctl: async (args) => {
        calls.push(args)
        if (args[0] === 'list') return bootedList()
        if (args[0] === 'launch') {
          launchStarted.resolve()
          return launchResult.promise
        }
        if (args[0] === 'terminate' && !terminateCanSucceed) {
          throw new Error('late app remains live')
        }
        return ok
      }
    })

    const opening = driver.open({ bundleId: 'com.example.App' })
    await launchStarted.promise
    const firstClose = driver.close()
    launchResult.resolve(ok)

    await expect(opening).rejects.toThrow(
      'Device canvas open was cancelled because the Canvas closed.'
    )
    await expect(firstClose).rejects.toMatchObject({ name: 'AggregateError' })
    terminateCanSucceed = true
    await driver.close()
    expect(
      calls.filter(
        (args) => args[0] === 'terminate' && args[1] === UDID_A && args[2] === 'com.example.App'
      )
    ).toHaveLength(3)
  })

  it('allocates production screenshots in a private directory with a fixed leaf', async () => {
    const madePrefixes: string[] = []
    const modes: Array<[string, number]> = []
    const removedFiles: string[] = []
    const removedDirectories: string[] = []
    const calls: string[][] = []
    const driver = new CanvasDeviceDriver('private/session', {
      platform: 'darwin',
      makeTempDirectory: async (prefix) => {
        madePrefixes.push(prefix)
        return '/tmp/private-canvas-shot'
      },
      setPathMode: async (path, mode) => {
        modes.push([path, mode])
      },
      removeFile: async (path) => {
        removedFiles.push(path)
      },
      removeDirectory: async (path) => {
        removedDirectories.push(path)
      },
      readScreenshot: async () => fakePng(130, 140),
      runSimctl: async (args) => {
        calls.push(args)
        return args[0] === 'list' ? bootedList() : ok
      }
    })

    await driver.open({ bundleId: 'com.example.App' })
    expect(madePrefixes[0]).toMatch(/canvas-shot-privatesession-$/)
    expect(modes).toContainEqual(['/tmp/private-canvas-shot', 0o700])
    expect(calls).toContainEqual([
      'io',
      UDID_A,
      'screenshot',
      '/tmp/private-canvas-shot/screenshot.png'
    ])
    expect(removedFiles).toContain('/tmp/private-canvas-shot/screenshot.png')
    expect(removedDirectories).toContain('/tmp/private-canvas-shot')
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
