import { createConnection, type Socket } from 'node:net'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, parse, resolve } from 'node:path'

import {
  matchProcessBirth,
  observeProcessBirthIdentity,
  type ProcessBirthObservation
} from '../host-runtime/ProcessBirthIdentity'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostBootstrapHello,
  type HostStatusProjection
} from '../shared/hostProtocol'
import {
  decodeHostLocalTransportHostFrame,
  encodeHostLocalTransportClientFrame,
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportClientFrame
} from '../shared/hostProtocolTransport'
import {
  HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES,
  HOST_LOCAL_CONTROL_MAX_TOKEN_BYTES,
  readPrivateLocalControlArtifact
} from '../shared/hostLocalControlArtifacts.node'
import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import type { HostTerminationExpectedHost } from './HostProcessTermination'

export interface HostShutdownClientOptions {
  readonly profilePath: string
  /** Bind shutdown to this Host using status and birth on the connected socket. */
  readonly expected?: HostTerminationExpectedHost
  readonly observe?: (pid: number) => Promise<ProcessBirthObservation>
  readonly connect?: (path: string) => Socket
  readonly exists?: (path: string) => boolean
  readonly delay?: (ms: number) => Promise<void>
  /** Budget for the socket round-trip (hello, welcome, shutdown ACK). */
  readonly timeoutMs?: number
  /**
   * Budget for the Host to remove its ownership artefacts after the ACK; a
   * Host draining live provider work needs longer than the ACK does. Defaults
   * to `timeoutMs`, which keeps the historical single-budget behaviour.
   */
  readonly removalTimeoutMs?: number
}

export type HostShutdownState = 'stopping' | 'already_stopping'

/** A guarded socket could not prove it belongs to the selected Host. */
export class HostShutdownIdentityError extends Error {
  constructor(
    message: string,
    readonly reason: 'mismatch' | 'unavailable',
    readonly actualPid: number | null = null
  ) {
    super(message)
    this.name = 'HostShutdownIdentityError'
  }
}

/** An authenticated legacy Host explicitly lacks same-socket status support. */
export class HostShutdownUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostShutdownUnsupportedError'
  }
}

const CLIENT_ID = 'taskwraith-host-cli'

function encodeFrame(frame: HostLocalTransportClientFrame): string {
  const encoded = encodeHostLocalTransportClientFrame(frame)
  if (!encoded.ok) throw new Error(`Host shutdown frame is invalid: ${encoded.error.code}`)
  return `${JSON.stringify(encoded.value)}\n`
}

export class HostShutdownClient {
  private readonly profilePath: string
  private readonly expected: HostTerminationExpectedHost | undefined
  private readonly observe: (pid: number) => Promise<ProcessBirthObservation>
  private readonly connect: (path: string) => Socket
  private readonly exists: (path: string) => boolean
  private readonly delay: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly removalTimeoutMs: number

  constructor(options: HostShutdownClientOptions) {
    if (
      !options ||
      !isAbsolute(options.profilePath) ||
      resolve(options.profilePath) !== options.profilePath ||
      options.profilePath === parse(options.profilePath).root
    )
      throw new Error('HostShutdownClient requires an absolute profile')
    this.profilePath = options.profilePath
    if (
      options.expected &&
      (!Number.isSafeInteger(options.expected.pid) || options.expected.pid < 1)
    )
      throw new Error('HostShutdownClient expected pid is invalid')
    this.expected = options.expected ? { ...options.expected } : undefined
    this.observe = options.observe ?? observeProcessBirthIdentity
    if (existsSync(this.profilePath)) this.assertCanonicalProfile()
    this.connect = options.connect ?? createConnection
    this.exists = options.exists ?? existsSync
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('HostShutdownClient timeout is invalid')
    this.removalTimeoutMs = options.removalTimeoutMs ?? this.timeoutMs
    if (!Number.isSafeInteger(this.removalTimeoutMs) || this.removalTimeoutMs < 1)
      throw new Error('HostShutdownClient removal timeout is invalid')
  }

  async shutdown(): Promise<HostShutdownState> {
    const discoveryPath = taskWraithHostDiscoveryPath(this.profilePath)
    const tokenPath = taskWraithHostTokenPath(this.profilePath)
    const leasePath = taskWraithHostAuthorityLeasePath(this.profilePath)
    const socketPath = taskWraithHostSocketPath(this.profilePath)
    const present = [discoveryPath, tokenPath, leasePath].map((path) => this.exists(path))
    if (present.every((value) => !value)) return 'already_stopping'
    if (!present[0] && !present[1] && present[2]) {
      await this.waitForRemoval([discoveryPath, tokenPath, leasePath, socketPath])
      return 'already_stopping'
    }
    if (present.some((value) => !value)) throw new Error('Host shutdown artifacts are inconsistent')
    this.assertCanonicalProfile()
    let rawDiscovery: unknown
    try {
      rawDiscovery = JSON.parse(
        readPrivateLocalControlArtifact(discoveryPath, HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES)
      )
    } catch {
      throw new Error('Host discovery is invalid')
    }
    const discovery = decodeTaskWraithHostDiscovery(rawDiscovery)
    if (!discovery.ok) throw new Error('Host discovery is invalid')
    if (
      discovery.discovery.tokenPath !== tokenPath ||
      discovery.discovery.socketPath !== socketPath
    ) {
      throw new Error('Host discovery paths are inconsistent')
    }
    const token = readPrivateLocalControlArtifact(
      tokenPath,
      HOST_LOCAL_CONTROL_MAX_TOKEN_BYTES
    ).trim()
    if (!token) throw new Error('Host token is invalid')
    const state = await this.request(discovery.discovery.socketPath, token)
    await this.waitForRemoval([discoveryPath, tokenPath, leasePath, socketPath])
    return state
  }

  private async waitForRemoval(paths: readonly string[]): Promise<void> {
    const deadline = Date.now() + this.removalTimeoutMs
    while (Date.now() < deadline) {
      if (!paths.some((path) => this.exists(path))) return
      await this.delay(25)
    }
    throw new Error('Host shutdown timed out while ownership artifacts remain')
  }

  private assertCanonicalProfile(): void {
    const canonical = realpathSync(this.profilePath)
    const stat = lstatSync(canonical)
    if (canonical !== this.profilePath || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('HostShutdownClient requires a canonical profile directory')
    }
  }

  private async verifyExpectedHost(status: HostStatusProjection, hostId: string): Promise<void> {
    const expected = this.expected!
    if (
      status.pid !== expected.pid ||
      status.profilePath !== this.profilePath ||
      status.hostId !== hostId ||
      (expected.startedAt !== undefined && status.startedAt !== expected.startedAt)
    ) {
      throw new HostShutdownIdentityError(
        `Connected Host does not match expected pid ${expected.pid}, profile and listener identity`,
        'mismatch',
        status.pid
      )
    }
    const observation = await this.observe(status.pid)
    const match = matchProcessBirth(observation, expected)
    if (match !== 'match') {
      throw new HostShutdownIdentityError(
        `Connected Host birth ${match === 'mismatch' ? 'differs from' : 'cannot verify'} expected pid ${expected.pid}`,
        match === 'mismatch' || observation.state === 'dead' ? 'mismatch' : 'unavailable',
        status.pid
      )
    }
  }

  private request(socketPath: string, token: string): Promise<HostShutdownState> {
    return new Promise((resolve, reject) => {
      const socket = this.connect(socketPath)
      let buffer = ''
      let welcomed = false
      let hostId = ''
      let verifying = false
      let shutdownSent = false
      let settled = false
      const timer = setTimeout(() => {
        fail(new Error('Host shutdown request timed out'))
      }, this.timeoutMs)
      timer.unref?.()
      const cleanup = () => {
        clearTimeout(timer)
        socket.destroy()
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        // Silent sockets and explicit legacy capability refusals retain verified
        // signal fallback. Other unproven identities after welcome are refusals.
        reject(
          this.expected &&
            welcomed &&
            !shutdownSent &&
            !(error instanceof HostShutdownIdentityError) &&
            !(error instanceof HostShutdownUnsupportedError)
            ? new HostShutdownIdentityError(
                `Connected Host identity could not be verified: ${error.message}`,
                'unavailable'
              )
            : error
        )
      }
      const finish = (value: HostShutdownState) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const sendShutdown = () => {
        if (settled) return
        shutdownSent = true
        socket.write(
          encodeFrame({
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: 'shutdown',
            kind: 'host.shutdown',
            params: {}
          })
        )
      }
      socket.once('error', fail)
      socket.once('close', () => fail(new Error('Host closed before acknowledging shutdown')))
      const hello: HostBootstrapHello = {
        type: 'host.hello',
        protocolVersion: HOST_PROTOCOL_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        client: {
          clientId: CLIENT_ID,
          clientClass: 'host-cli',
          clientVersion: '1.0.0'
        },
        capabilities: this.expected
          ? ['bootstrap', 'host-lifecycle', 'health']
          : ['bootstrap', 'host-lifecycle']
      }
      socket.once('connect', () =>
        socket.write(
          encodeFrame({
            type: 'hello',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            token,
            hello
          })
        )
      )
      socket.on('data', (chunk) => {
        if (settled) return
        buffer += String(chunk)
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (!line) continue
          let parsed
          try {
            parsed = JSON.parse(line)
          } catch {
            fail(new Error('Host shutdown response is malformed'))
            return
          }
          const decoded = decodeHostLocalTransportHostFrame(parsed)
          if (!decoded.ok) {
            fail(new Error('Host shutdown response is invalid'))
            return
          }
          if ('skipped' in decoded) continue
          const frame = decoded.value
          if (frame.type === 'welcome') {
            if (
              welcomed ||
              frame.welcome.hostVersion !== 'node-host-v1' ||
              frame.welcome.authenticatedClient.clientClass !== 'host-cli' ||
              frame.welcome.authenticatedClient.clientId !== CLIENT_ID ||
              !frame.welcome.capabilities.includes('host-lifecycle')
            ) {
              fail(new Error('Host lifecycle capability was not granted'))
              return
            }
            welcomed = true
            hostId = frame.welcome.hostId
            if (this.expected) {
              if (!frame.welcome.capabilities.includes('health')) {
                fail(new HostShutdownUnsupportedError('Host health capability was not granted'))
                return
              }
              socket.write(
                encodeFrame({
                  type: 'request',
                  transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
                  id: 'identity',
                  kind: 'host.status',
                  params: {}
                })
              )
            } else sendShutdown()
          } else if (
            frame.type === 'response' &&
            welcomed &&
            this.expected &&
            frame.id === 'identity'
          ) {
            if (!verifying && !frame.ok && frame.error.code === 'unknown_request_kind') {
              fail(new HostShutdownUnsupportedError('Host status request is unsupported'))
              return
            }
            if (verifying || !frame.ok || frame.result.kind !== 'host.status') {
              fail(
                new HostShutdownIdentityError(
                  'Host status identity was not acknowledged',
                  'unavailable'
                )
              )
              return
            }
            verifying = true
            void this.verifyExpectedHost(frame.result.status, hostId)
              .then(sendShutdown)
              .catch((error) =>
                fail(error instanceof Error ? error : new Error('Host birth observation failed'))
              )
          } else if (frame.type === 'response' && shutdownSent && frame.id === 'shutdown') {
            if (!frame.ok || frame.result.kind !== 'host.shutdown') {
              fail(new Error('Host shutdown was not acknowledged'))
              return
            }
            finish(frame.result.state)
          }
        }
      })
    })
  }
}
