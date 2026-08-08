import { describe, expect, it, vi } from 'vitest'
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
    const resolveBinary = vi.fn((name: string) =>
      name === 'idb'
        ? '/opt/homebrew/bin/idb'
        : name === 'idb_companion'
          ? '/opt/homebrew/bin/idb_companion'
          : null
    )
    const client = new IdbClient({ platform: 'darwin', resolveBinary })
    expect(client.isAvailable()).toBe(true)
    expect(client.companionAvailable()).toBe(true)
    expect(client.resolveIdbPath()).toBe('/opt/homebrew/bin/idb')
    expect(client.resolveCompanionPath()).toBe('/opt/homebrew/bin/idb_companion')
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
})
