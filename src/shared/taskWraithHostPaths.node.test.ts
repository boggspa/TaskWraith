import { describe, expect, it } from 'vitest'
import { normalize } from 'node:path'
import {
  decodeTaskWraithHostDiscovery,
  TASKWRAITH_HOST_DISCOVERY_FILE,
  TASKWRAITH_HOST_SOCKET_FILE,
  TASKWRAITH_HOST_TOKEN_FILE,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from './taskWraithHostPaths.node'
import {
  TASKWRAITH_CONTROL_DISCOVERY_FILE,
  TASKWRAITH_CONTROL_SOCKET_FILE,
  TASKWRAITH_CONTROL_TOKEN_FILE,
  taskWraithControlSocketPath
} from './taskWraithControlPaths.node'

/* eslint-disable @typescript-eslint/no-require-imports -- the design-intent probe loads Node modules dynamically. */

describe('TaskWraith Host v2 paths', () => {
  // -----------------------------------------------------------------------
  // File-name constants — distinct v2 namespace
  // -----------------------------------------------------------------------

  it('encodes host-v2 in every file-name constant', () => {
    // Every v2 constant must contain the literal 'host-v2' so no accidental
    // v1 collision is possible even if both modules write into the same
    // userData directory.
    expect(TASKWRAITH_HOST_DISCOVERY_FILE).toContain('host-v2')
    expect(TASKWRAITH_HOST_TOKEN_FILE).toContain('host-v2')
    expect(TASKWRAITH_HOST_SOCKET_FILE).toContain('host-v2')
  })

  // -----------------------------------------------------------------------
  // v1 / v2 non-collision (risk C, PIN W3-P1)
  // -----------------------------------------------------------------------

  it('never collides with v1 socket paths on POSIX', () => {
    const userData = '/Users/ada/Library/Application Support/TaskWraith Dev'
    const v1 = taskWraithControlSocketPath(userData, 'darwin')
    const v2 = taskWraithHostSocketPath(userData, 'darwin')

    // Structural non-collision: different directories AND different filenames.
    expect(v1).not.toBe(v2)
    expect(v1).toContain('tw-') // v1 prefix, no host-v2
    expect(v2).toContain('twh2-')
    expect(v1).not.toContain('twh2-')
    expect(v2).toContain(TASKWRAITH_HOST_SOCKET_FILE)
    expect(v1).toContain(TASKWRAITH_CONTROL_SOCKET_FILE)

    // Both stay within macOS sockaddr_un limit.
    expect(Buffer.byteLength(v1, 'utf8')).toBeLessThan(104)
    expect(Buffer.byteLength(v2, 'utf8')).toBeLessThan(104)
  })

  it('never collides with v1 socket paths on Windows', () => {
    const userData = 'C:\\Users\\ada\\TaskWraith'
    const v1 = taskWraithControlSocketPath(userData, 'win32')
    const v2 = taskWraithHostSocketPath(userData, 'win32')

    expect(v1).not.toBe(v2)
    expect(v1.startsWith('\\\\.\\pipe\\taskwraith-control-')).toBe(true)
    expect(v2.startsWith('\\\\.\\pipe\\taskwraith-host-v2-')).toBe(true)
    // Windows pipe name still carries the full 'host-v2' literal — no length
    // constraint on named pipes.
    expect(v2).toContain('host-v2')
  })

  it('never collides with v1 discovery and token filenames in the same userData directory', () => {
    const userData = '/tmp/test-userdata'
    const v1Discovery = `${userData}/${TASKWRAITH_CONTROL_DISCOVERY_FILE}`
    const v2Discovery = taskWraithHostDiscoveryPath(userData)
    const v1Token = `${userData}/${TASKWRAITH_CONTROL_TOKEN_FILE}`
    const v2Token = taskWraithHostTokenPath(userData)

    expect(v2Discovery).not.toBe(v1Discovery)
    expect(v2Token).not.toBe(v1Token)
    expect(v2Discovery).toContain('host-v2')
    expect(v2Token).toContain('host-v2')
    // v1 files must NOT contain the v2 marker.
    expect(TASKWRAITH_CONTROL_DISCOVERY_FILE).not.toContain('host-v2')
    expect(TASKWRAITH_CONTROL_TOKEN_FILE).not.toContain('host-v2')
  })

  // -----------------------------------------------------------------------
  // Path determinism
  // -----------------------------------------------------------------------

  it('produces deterministic socket paths per userData identity', () => {
    const a = taskWraithHostSocketPath('/data/a', 'darwin')
    const b = taskWraithHostSocketPath('/data/a', 'darwin')
    const c = taskWraithHostSocketPath('/data/b', 'darwin')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('produces deterministic discovery and token paths', () => {
    const userData = '/tmp/host-test'
    expect(taskWraithHostDiscoveryPath(userData)).toBe(taskWraithHostDiscoveryPath(userData))
    expect(taskWraithHostTokenPath(userData)).toBe(taskWraithHostTokenPath(userData))
    expect(taskWraithHostDiscoveryPath(userData)).toContain(normalize(userData))
    expect(taskWraithHostTokenPath(userData)).toContain(normalize(userData))
  })

  // -----------------------------------------------------------------------
  // Injected-dir isolation (no process.cwd / env leakage)
  // -----------------------------------------------------------------------

  it('is isolated from process.cwd and environment', () => {
    const userData = '/injected/base'
    const socket = taskWraithHostSocketPath(userData, 'darwin')
    // The socket path is derived purely from the injected userData, not from
    // cwd, HOME, or any env var.
    expect(socket).toContain('twh2-')
    expect(socket).toContain(TASKWRAITH_HOST_SOCKET_FILE)
    // Running the same call with a different userData yields a different path
    // even though cwd didn't change.
    const other = taskWraithHostSocketPath('/other/base', 'darwin')
    expect(socket).not.toBe(other)
  })

  // -----------------------------------------------------------------------
  // Windows branch shape
  // -----------------------------------------------------------------------

  it('uses a bounded opaque named pipe on Windows', () => {
    const first = taskWraithHostSocketPath('C:\\Users\\Ada\\TaskWraith', 'win32')
    const second = taskWraithHostSocketPath('C:\\Users\\Ada\\TaskWraith Dev', 'win32')
    expect(first.startsWith('\\\\.\\pipe\\taskwraith-host-v2-')).toBe(true)
    expect(first).toContain('host-v2')
    // Suffix is 16 hex chars.
    expect(first.slice(-16)).toMatch(/^[a-f0-9]{16}$/)
    expect(first).not.toContain('Ada')
    expect(first).not.toBe(second)
  })

  it('keeps POSIX sockets short and isolates them by userData identity', () => {
    const longPath = `/var/folders/${'very-long-segment/'.repeat(12)}TaskWraith Dev`
    const first = taskWraithHostSocketPath(longPath, 'darwin')
    const second = taskWraithHostSocketPath(`${longPath} 2`, 'darwin')
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThan(104)
    expect(first).not.toBe(second)
    expect(first).toMatch(/taskwraith-host-v2\.sock$/)
  })

  // -----------------------------------------------------------------------
  // Discovery decoder — fail-closed matrix
  // -----------------------------------------------------------------------

  it('decodes a valid discovery payload', () => {
    const result = decodeTaskWraithHostDiscovery({
      protocolVersion: 2,
      socketPath: '/tmp/twh2-501-abc123/taskwraith-host-v2.sock',
      tokenPath: '/Users/ada/.config/taskwraith/taskwraith-host-v2.token',
      pid: 42,
      startedAt: '2026-08-04T08:00:00.000Z'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.discovery.protocolVersion).toBe(2)
      expect(result.discovery.socketPath).toBe('/tmp/twh2-501-abc123/taskwraith-host-v2.sock')
      expect(result.discovery.tokenPath).toBe(
        '/Users/ada/.config/taskwraith/taskwraith-host-v2.token'
      )
      expect(result.discovery.pid).toBe(42)
      expect(result.discovery.startedAt).toBe('2026-08-04T08:00:00.000Z')
    }
  })

  it('rejects non-object input', () => {
    expect(decodeTaskWraithHostDiscovery(null)).toEqual({
      ok: false,
      error: 'discovery must be an object'
    })
    expect(decodeTaskWraithHostDiscovery('nope')).toEqual({
      ok: false,
      error: 'discovery must be an object'
    })
    expect(decodeTaskWraithHostDiscovery([])).toEqual({
      ok: false,
      error: 'discovery must be an object'
    })
  })

  it('rejects wrong protocol version', () => {
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 1,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        pid: 1,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'unsupported protocol version' })

    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 3,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        pid: 1,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'unsupported protocol version' })
  })

  it('rejects missing or invalid fields', () => {
    // Missing socketPath
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        tokenPath: '/tmp/t',
        pid: 1,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'socketPath must be a non-empty bounded string' })

    // Empty socketPath
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        socketPath: '',
        tokenPath: '/tmp/t',
        pid: 1,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'socketPath must be a non-empty bounded string' })

    // Missing pid
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'pid must be a positive integer' })

    // Non-integer pid
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        pid: 1.5,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'pid must be a positive integer' })

    // Zero pid
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        pid: 0,
        startedAt: 'now'
      })
    ).toEqual({ ok: false, error: 'pid must be a positive integer' })

    // Missing startedAt
    expect(
      decodeTaskWraithHostDiscovery({
        protocolVersion: 2,
        socketPath: '/tmp/s',
        tokenPath: '/tmp/t',
        pid: 1
      })
    ).toEqual({ ok: false, error: 'startedAt must be a non-empty bounded string' })
  })

  it('rejects extra fields gracefully (still decodes)', () => {
    // Extra unknown fields are ignored — forward-compatible.
    const result = decodeTaskWraithHostDiscovery({
      protocolVersion: 2,
      socketPath: '/tmp/s',
      tokenPath: '/tmp/t',
      pid: 1,
      startedAt: 'now',
      extra: 'should be ignored'
    })
    expect(result.ok).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Permission-mode intent (documented, not enforced here)
  // -----------------------------------------------------------------------

  it('documents that permission-mode application lives with the server', () => {
    // This module is a pure path calculator — it never touches the filesystem.
    // The server that calls these functions is responsible for applying
    // 0700 on the socket directory and 0600 on the token file (per PIN W3-P1).
    // This test exists so that a future refactor that adds fs.chmod here is
    // caught as a contract violation.
    const src = __filename.replace('.test.ts', '.ts')
    // The production module must not import 'node:fs'.
    const fs = require('node:fs')
    // We're only asserting the design intent — the test file itself is allowed
    // to import fs for the check.
    const content = fs.readFileSync(src, 'utf8')
    expect(content).not.toMatch(/import.*from\s+['"]node:fs['"]/)
    expect(content).not.toMatch(/require\(['"]node:fs['"]\)/)
  })
})
