import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'

import {
  HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION
} from '../shared/hostProtocol'
import {
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HostShutdownClient } from './HostShutdownClient'

const paths: string[] = []
afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('reports an idempotent already-stopped state when all owned artifacts are absent', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-shutdown-client-')))
  paths.push(profile)
  const client = new HostShutdownClient({ profilePath: profile, exists: () => false })
  await expect(client.shutdown()).resolves.toBe('already_stopping')
})

it('is idempotent when the canonical profile directory does not exist', async () => {
  const profile = join(tmpdir(), `host-shutdown-client-missing-${process.pid}-${Date.now()}`)
  const client = new HostShutdownClient({ profilePath: profile })
  await expect(client.shutdown()).resolves.toBe('already_stopping')
})

it('fails closed on an inconsistent artifact set without connecting', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-shutdown-client-bad-')))
  paths.push(profile)
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => path.endsWith('.json')
  })
  await expect(client.shutdown()).rejects.toThrow('inconsistent')
})

it('waits for an already-stopping lease without connecting or deleting it', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-shutdown-client-stopping-')))
  paths.push(profile)
  const lease = taskWraithHostAuthorityLeasePath(profile)
  const present = new Set([lease])
  const connect = vi.fn()
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => present.has(path),
    connect,
    delay: async () => present.clear()
  })
  await expect(client.shutdown()).resolves.toBe('already_stopping')
  expect(connect).not.toHaveBeenCalled()
})

it('uses the fixed lifecycle identity, accepts the ACK, and waits for owned cleanup', async () => {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-shutdown-client-live-')))
  paths.push(profile)
  const discoveryPath = taskWraithHostDiscoveryPath(profile)
  const tokenPath = taskWraithHostTokenPath(profile)
  const leasePath = taskWraithHostAuthorityLeasePath(profile)
  const socketPath = taskWraithHostSocketPath(profile)
  const present = new Set([discoveryPath, tokenPath, leasePath, socketPath])
  writeFileSync(tokenPath, 'owner-token\n', { mode: 0o600 })
  writeFileSync(leasePath, '{}\n', { mode: 0o600 })
  writeFileSync(
    discoveryPath,
    `${JSON.stringify({
      protocolVersion: HOST_PROTOCOL_VERSION,
      socketPath,
      tokenPath,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      hostId: 'host-1',
      hostVersion: 'node-host-v1'
    })}\n`,
    { mode: 0o600 }
  )

  const frames: Array<Record<string, unknown>> = []
  class ScriptedSocket extends EventEmitter {
    destroyed = false

    write(line: string): boolean {
      const frame = JSON.parse(line) as Record<string, unknown>
      frames.push(frame)
      if (frame.type === 'hello') {
        queueMicrotask(() =>
          this.emit(
            'data',
            `${JSON.stringify({
              type: 'welcome',
              transportVersion: 1,
              welcome: {
                type: 'host.welcome',
                protocolVersion: HOST_PROTOCOL_VERSION,
                controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
                projectionVersion: HOST_PROJECTION_VERSION,
                hostId: 'host-1',
                hostVersion: 'node-host-v1',
                sessionId: 'session-1',
                generation: 1,
                cursor: 0,
                authenticatedClient: {
                  clientId: 'taskwraith-host-cli',
                  clientClass: 'host-cli',
                  clientVersion: '1.0.0'
                },
                capabilities: ['bootstrap', 'host-lifecycle'],
                freshness: 'live'
              }
            })}\n`
          )
        )
      } else {
        present.clear()
        queueMicrotask(() =>
          this.emit(
            'data',
            `${JSON.stringify({
              type: 'response',
              transportVersion: 1,
              id: 'shutdown',
              ok: true,
              result: { kind: 'host.shutdown', state: 'stopping' }
            })}\n`
          )
        )
      }
      return true
    }

    destroy(): this {
      this.destroyed = true
      return this
    }
  }
  const socket = new ScriptedSocket()
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => present.has(path),
    connect: (path) => {
      expect(path).toBe(socketPath)
      queueMicrotask(() => socket.emit('connect'))
      return socket as unknown as Socket
    }
  })
  await expect(client.shutdown()).resolves.toBe('stopping')
  expect(frames).toHaveLength(2)
  expect(frames[0]).toMatchObject({
    type: 'hello',
    token: 'owner-token',
    hello: {
      client: { clientClass: 'host-cli', clientId: 'taskwraith-host-cli' },
      capabilities: ['bootstrap', 'host-lifecycle']
    }
  })
  expect(frames[1]).toEqual({
    type: 'request',
    transportVersion: 1,
    id: 'shutdown',
    kind: 'host.shutdown',
    params: {}
  })
  expect(socket.destroyed).toBe(true)
})

// Golden captured from the pre-removal-budget implementation (HEAD 2a71f9580)
// through the same scripted socket: the exact bytes of the two frames the
// client writes. The removal-budget option must not change them.
const GOLDEN_HELLO_FRAME =
  '{"type":"hello","transportVersion":1,"token":"owner-token","hello":{"type":"host.hello",' +
  '"protocolVersion":2,"projectionVersion":2,"client":{"clientId":"taskwraith-host-cli",' +
  '"clientClass":"host-cli","clientVersion":"1.0.0"},"capabilities":["bootstrap","host-lifecycle"]}}\n'
const GOLDEN_SHUTDOWN_FRAME =
  '{"type":"request","transportVersion":1,"id":"shutdown","kind":"host.shutdown","params":{}}\n'

function seedLiveProfile(prefix: string): {
  profile: string
  present: Set<string>
  socketPath: string
} {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  paths.push(profile)
  const discoveryPath = taskWraithHostDiscoveryPath(profile)
  const tokenPath = taskWraithHostTokenPath(profile)
  const leasePath = taskWraithHostAuthorityLeasePath(profile)
  const socketPath = taskWraithHostSocketPath(profile)
  writeFileSync(tokenPath, 'owner-token\n', { mode: 0o600 })
  writeFileSync(leasePath, '{}\n', { mode: 0o600 })
  writeFileSync(
    discoveryPath,
    `${JSON.stringify({
      protocolVersion: HOST_PROTOCOL_VERSION,
      socketPath,
      tokenPath,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      hostId: 'host-1',
      hostVersion: 'node-host-v1'
    })}\n`,
    { mode: 0o600 }
  )
  return {
    profile,
    present: new Set([discoveryPath, tokenPath, leasePath, socketPath]),
    socketPath
  }
}

class AckingSocket extends EventEmitter {
  readonly lines: string[] = []
  destroyed = false

  constructor(private readonly onAck: () => void) {
    super()
  }

  write(line: string): boolean {
    this.lines.push(line)
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.type === 'hello') {
      queueMicrotask(() =>
        this.emit(
          'data',
          `${JSON.stringify({
            type: 'welcome',
            transportVersion: 1,
            welcome: {
              type: 'host.welcome',
              protocolVersion: HOST_PROTOCOL_VERSION,
              controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
              projectionVersion: HOST_PROJECTION_VERSION,
              hostId: 'host-1',
              hostVersion: 'node-host-v1',
              sessionId: 'session-1',
              generation: 1,
              cursor: 0,
              authenticatedClient: {
                clientId: 'taskwraith-host-cli',
                clientClass: 'host-cli',
                clientVersion: '1.0.0'
              },
              capabilities: ['bootstrap', 'host-lifecycle'],
              freshness: 'live'
            }
          })}\n`
        )
      )
    } else {
      this.onAck()
      queueMicrotask(() =>
        this.emit(
          'data',
          `${JSON.stringify({
            type: 'response',
            transportVersion: 1,
            id: 'shutdown',
            ok: true,
            result: { kind: 'host.shutdown', state: 'stopping' }
          })}\n`
        )
      )
    }
    return true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

it('writes byte-identical hello and shutdown frames (pre-removal-budget golden)', async () => {
  const { profile, present } = seedLiveProfile('host-shutdown-client-golden-')
  const socket = new AckingSocket(() => present.clear())
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => present.has(path),
    connect: () => {
      queueMicrotask(() => socket.emit('connect'))
      return socket as unknown as Socket
    }
  })
  await expect(client.shutdown()).resolves.toBe('stopping')
  expect(socket.lines).toEqual([GOLDEN_HELLO_FRAME, GOLDEN_SHUTDOWN_FRAME])
})

it('waits for artefact removal on its own budget, not the ACK budget', async () => {
  const { profile, present } = seedLiveProfile('host-shutdown-client-drain-')
  const socket = new AckingSocket(() => undefined)
  let polls = 0
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => present.has(path),
    connect: () => {
      queueMicrotask(() => socket.emit('connect'))
      return socket as unknown as Socket
    },
    // A Host draining live work: the ACK is immediate, the artefacts vanish
    // only after ~150 ms of real time, which is past the 50 ms ACK budget.
    delay: async () => {
      polls += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (polls === 5) present.clear()
    },
    timeoutMs: 50,
    removalTimeoutMs: 5_000
  })
  await expect(client.shutdown()).resolves.toBe('stopping')
  expect(polls).toBe(5)
})

it('times out the removal wait on the removal budget alone', async () => {
  const { profile, present } = seedLiveProfile('host-shutdown-client-drain-timeout-')
  const socket = new AckingSocket(() => undefined)
  const client = new HostShutdownClient({
    profilePath: profile,
    exists: (path) => present.has(path),
    connect: () => {
      queueMicrotask(() => socket.emit('connect'))
      return socket as unknown as Socket
    },
    delay: () => new Promise((resolve) => setTimeout(resolve, 5)),
    timeoutMs: 5_000,
    removalTimeoutMs: 20
  })
  await expect(client.shutdown()).rejects.toThrow(/timed out while ownership artifacts remain/)
  expect(() => new HostShutdownClient({ profilePath: profile, removalTimeoutMs: 0 })).toThrow(
    /removal timeout is invalid/
  )
})
