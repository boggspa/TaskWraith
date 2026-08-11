import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { IdbClient } from './IdbClient'

describe('IdbClient', () => {
  it('reports unavailable off macOS even when a resolver would find binaries', () => {
    const client = new IdbClient({
      platform: 'linux',
      resolveBinary: () => '/usr/bin/idb'
    })
    expect(client.isAvailable()).toBe(false)
    expect(client.companionAvailable()).toBe(false)
  })

  it('resolves idb / idb_companion via the injectable resolver', () => {
    const idbPath = path.join('/opt', 'homebrew', 'bin', 'idb')
    const companionPath = path.join('/opt', 'homebrew', 'bin', 'idb_companion')
    const resolveBinary = vi.fn((name: string) =>
      name === 'idb' ? idbPath : name === 'idb_companion' ? companionPath : null
    )
    const client = new IdbClient({ platform: 'darwin', resolveBinary })
    expect(client.isAvailable()).toBe(true)
    expect(client.companionAvailable()).toBe(true)
    expect(client.resolveIdbPath()).toBe(idbPath)
    expect(client.resolveCompanionPath()).toBe(companionPath)
  })

  it('invokes argv-array commands through the injectable runner (never shell)', async () => {
    const calls: Array<{ binary: string; args: readonly string[] }> = []
    const run = vi.fn(async (binary: string, args: readonly string[]) => {
      calls.push({ binary, args: [...args] })
      return { stdout: '', stderr: '' }
    })
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: (name) => (name === 'idb' ? '/mock/idb' : null),
      run
    })

    await client.tap('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 12.6, 40.2)
    await client.text('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'hello')
    await client.swipe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 10, 20, 10, 200)
    await client.screenshot('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', '/tmp/s.png')
    await client.connect('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    await client.boot('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')

    expect(calls).toEqual([
      {
        binary: '/mock/idb',
        args: ['ui', 'tap', '13', '40', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
      },
      {
        binary: '/mock/idb',
        args: ['ui', 'text', 'hello', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
      },
      {
        binary: '/mock/idb',
        args: [
          'ui',
          'swipe',
          '10',
          '20',
          '10',
          '200',
          '--udid',
          'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
        ]
      },
      {
        binary: '/mock/idb',
        args: ['screenshot', '/tmp/s.png', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
      },
      {
        binary: '/mock/idb',
        args: ['connect', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
      },
      {
        binary: '/mock/idb',
        args: ['boot', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
      }
    ])
    // No shell metacharacters / concatenated command strings.
    for (const call of calls) {
      expect(call.binary).toBe('/mock/idb')
      expect(call.args.every((arg) => typeof arg === 'string')).toBe(true)
    }
  })

  it('parses list-targets rows into udids', async () => {
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async () => ({
        stdout:
          'iPhone 16 | AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA | Booted | simulator | arm64\n' +
          'iPad Pro | BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB | Shutdown | simulator | arm64\n',
        stderr: ''
      })
    })
    const listed = await client.listTargets()
    expect(listed.ok).toBe(true)
    expect(listed.targets).toEqual([
      {
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        name: 'iPhone 16',
        state: 'Booted',
        raw: 'iPhone 16 | AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA | Booted | simulator | arm64'
      },
      {
        udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
        name: 'iPad Pro',
        state: 'Shutdown',
        raw: 'iPad Pro | BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB | Shutdown | simulator | arm64'
      }
    ])
  })

  it('returns structured errors when idb is missing or the runner fails', async () => {
    const missing = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => null
    })
    await expect(missing.tap('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 1, 2)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('idb is not available')
    })

    const failing = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async () => {
        throw new Error('idb ui failed: companion down')
      }
    })
    await expect(failing.text('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'x')).resolves.toEqual({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'idb ui failed: companion down'
    })
  })

  it('describeAll prefers parsed JSON from ui describe-all and truncates large trees', async () => {
    const calls: string[][] = []
    const nodes = Array.from({ length: 520 }, (_, i) => ({ AXLabel: `n${i}` }))
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        return { stdout: JSON.stringify(nodes), stderr: '' }
      }
    })
    const described = await client.describeAll('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(calls[0]).toEqual([
      'ui',
      'describe-all',
      '--udid',
      'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    ])
    expect(described.ok).toBe(true)
    expect(described.truncated).toBe(true)
    expect(Array.isArray(described.tree)).toBe(true)
    expect((described.tree as unknown[]).length).toBeLessThanOrEqual(500)
  })

  it('describeAll retries with --json when the first stdout is not JSON', async () => {
    const calls: string[][] = []
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        if (args.includes('--json')) {
          return { stdout: JSON.stringify([{ AXLabel: 'Home' }]), stderr: '' }
        }
        return { stdout: 'not-json', stderr: '' }
      }
    })
    const described = await client.describeAll('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(calls).toEqual([
      ['ui', 'describe-all', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'describe-all', '--json', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
    ])
    expect(described).toEqual({
      ok: true,
      tree: [{ AXLabel: 'Home' }],
      truncated: false
    })
  })

  it('hardwareButton allowlists HID names and emits ui button argv', async () => {
    const calls: string[][] = []
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        return { stdout: '', stderr: '' }
      }
    })
    await expect(
      client.hardwareButton('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'HOME')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.hardwareButton('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'LOCK')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.hardwareButton('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'SIDE_BUTTON')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.hardwareButton('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'not-a-button' as never)
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/allowlisted|invalid|button/i)
    })
    expect(calls).toEqual([
      ['ui', 'button', 'HOME', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'button', 'LOCK', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'button', 'SIDE_BUTTON', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
    ])
  })

  it('rotate maps absolute orientations to ui rotate argv', async () => {
    const calls: string[][] = []
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        return { stdout: '', stderr: '' }
      }
    })
    await expect(
      client.rotate('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'PORTRAIT')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.rotate('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'LANDSCAPE_RIGHT')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.rotate('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'PORTRAIT_UPSIDE_DOWN')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.rotate('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'LANDSCAPE_LEFT')
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.rotate('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'CLOCKWISE' as never)
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/allowlisted|invalid|direction|orient|rotate/i)
    })
    expect(calls).toEqual([
      ['ui', 'rotate', 'PORTRAIT', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'rotate', 'LANDSCAPE_RIGHT', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'rotate', 'PORTRAIT_UPSIDE_DOWN', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['ui', 'rotate', 'LANDSCAPE_LEFT', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
    ])
  })

  it('ensureConnected pre-warms once per udid within the TTL', async () => {
    const calls: string[][] = []
    let now = 1000
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      now: () => now,
      run: async (_binary, args) => {
        calls.push([...args])
        return { stdout: '', stderr: '' }
      }
    })

    await client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    await client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(calls).toEqual([['connect', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']])

    now += 31_000
    await client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(calls).toEqual([
      ['connect', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      ['connect', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
    ])
  })

  it('ensureConnected dedupes concurrent pre-warm calls for the same udid', async () => {
    const calls: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        await gate
        return { stdout: '', stderr: '' }
      }
    })

    const first = client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    const second = client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    release()
    await Promise.all([first, second])
    expect(calls).toEqual([['connect', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']])
  })

  it('ensureConnected never throws when the companion cannot be reached', async () => {
    const missing = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => null
    })
    await expect(
      missing.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    ).resolves.toBeUndefined()

    const failing = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async () => {
        throw new Error('idb connect failed: companion down')
      }
    })
    await expect(
      failing.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    ).resolves.toBeUndefined()
  })

  it('pre-warms over gRPC without spawning the Python client when the socket is healthy', async () => {
    const describe = vi.fn(async () => undefined)
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run,
      grpcTransport: {
        tap: async () => undefined,
        text: async () => undefined,
        swipe: async () => undefined,
        describe
      }
    })

    await client.ensureConnected('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')

    expect(describe).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(run).not.toHaveBeenCalled()
  })

  it('serialises concurrent invocations so companion auto-spawn cannot race', async () => {
    const udid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    const started: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        started.push([...args])
        if (started.length === 1) await gate
        return { stdout: '', stderr: '' }
      }
    })

    const first = client.tap(udid, 1, 2)
    const second = client.text(udid, 'x')
    // Let the queue start the first invocation; the second must wait behind it.
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).toEqual([['ui', 'tap', '1', '2', '--udid', udid]])
    release()
    await Promise.all([first, second])
    expect(started).toEqual([
      ['ui', 'tap', '1', '2', '--udid', udid],
      ['ui', 'text', 'x', '--udid', udid]
    ])
  })

  it('keeps the queue moving after a failed invocation', async () => {
    const udid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    const started: string[][] = []
    let calls = 0
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls += 1
        started.push([...args])
        if (calls === 1) throw new Error('idb ui failed: companion down')
        return { stdout: '', stderr: '' }
      }
    })

    const first = await client.tap(udid, 1, 2)
    const second = await client.tap(udid, 3, 4)
    expect(first).toMatchObject({ ok: false, error: 'idb ui failed: companion down' })
    expect(second).toMatchObject({ ok: true })
    expect(started).toEqual([
      ['ui', 'tap', '1', '2', '--udid', udid],
      ['ui', 'tap', '3', '4', '--udid', udid]
    ])
  })

  it('uses gRPC without spawning the Python client when the companion is healthy', async () => {
    const calls: Array<{ kind: string; args: unknown[] }> = []
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => null,
      run,
      grpcTransport: {
        tap: async (...args) => {
          calls.push({ kind: 'tap', args })
        },
        text: async (...args) => {
          calls.push({ kind: 'text', args })
        },
        swipe: async (...args) => {
          calls.push({ kind: 'swipe', args })
        },
        describe: async () => undefined
      }
    })

    await expect(client.tap('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 12.6, 40.2)).resolves.toEqual({
      ok: true,
      stdout: '',
      stderr: ''
    })
    await client.text('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'one\ntwo')
    await client.swipe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 1.2, 2.4, 3.6, 4.8)

    expect(calls).toEqual([
      {
        kind: 'tap',
        args: ['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 13, 40]
      },
      {
        kind: 'text',
        args: ['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'one\ntwo']
      },
      {
        kind: 'swipe',
        args: ['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 1, 2, 4, 5]
      }
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to CLI inside the same queue without reordering gestures', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        order.push('cli:' + args.slice(0, 2).join(':'))
        return { stdout: '', stderr: '' }
      },
      grpcTransport: {
        tap: async () => {
          order.push('grpc:tap')
          await gate
          throw new Error('socket closed')
        },
        text: async () => {
          order.push('grpc:text')
        },
        swipe: async () => undefined,
        describe: async () => undefined
      }
    })

    const first = client.tap('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 1, 2)
    const second = client.text('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'x')
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['grpc:tap'])
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['grpc:tap', 'cli:ui:tap', 'grpc:text'])
  })

  it('passes an unsupported text batch to CLI unchanged after gRPC rejects it', async () => {
    const calls: string[][] = []
    const client = new IdbClient({
      platform: 'darwin',
      resolveBinary: () => '/mock/idb',
      run: async (_binary, args) => {
        calls.push([...args])
        return { stdout: '', stderr: '' }
      },
      grpcTransport: {
        tap: async () => undefined,
        text: async () => {
          throw new Error('unsupported HID character')
        },
        swipe: async () => undefined,
        describe: async () => undefined
      }
    })

    await client.text('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'hello🙂\nworld')
    expect(calls).toEqual([
      ['ui', 'text', 'hello🙂\nworld', '--udid', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']
    ])
  })
})
