import { createConnection, type Socket } from 'node:net'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, parse, resolve } from 'node:path'

import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostBootstrapHello
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

export interface HostShutdownClientOptions {
  readonly profilePath: string
  readonly connect?: (path: string) => Socket
  readonly exists?: (path: string) => boolean
  readonly delay?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
}

export type HostShutdownState = 'stopping' | 'already_stopping'

const CLIENT_ID = 'taskwraith-host-cli'

function encodeFrame(frame: HostLocalTransportClientFrame): string {
  const encoded = encodeHostLocalTransportClientFrame(frame)
  if (!encoded.ok) throw new Error(`Host shutdown frame is invalid: ${encoded.error.code}`)
  return `${JSON.stringify(encoded.value)}\n`
}

export class HostShutdownClient {
  private readonly profilePath: string
  private readonly connect: (path: string) => Socket
  private readonly exists: (path: string) => boolean
  private readonly delay: (ms: number) => Promise<void>
  private readonly timeoutMs: number

  constructor(options: HostShutdownClientOptions) {
    if (!options || !isAbsolute(options.profilePath))
      throw new Error('HostShutdownClient requires an absolute profile')
    const canonical = realpathSync(resolve(options.profilePath))
    if (canonical !== options.profilePath || canonical === parse(canonical).root)
      throw new Error('HostShutdownClient requires a canonical non-root profile')
    this.profilePath = canonical
    this.connect = options.connect ?? createConnection
    this.exists = options.exists ?? existsSync
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('HostShutdownClient timeout is invalid')
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
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      if (!paths.some((path) => this.exists(path))) return
      await this.delay(25)
    }
    throw new Error('Host shutdown timed out while ownership artifacts remain')
  }

  private request(socketPath: string, token: string): Promise<HostShutdownState> {
    return new Promise((resolve, reject) => {
      const socket = this.connect(socketPath)
      let buffer = ''
      let welcomed = false
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
        reject(error)
      }
      const finish = (value: HostShutdownState) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
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
        capabilities: ['bootstrap', 'host-lifecycle']
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
          if (decoded.skipped) continue
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
            socket.write(
              encodeFrame({
                type: 'request',
                transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
                id: 'shutdown',
                kind: 'host.shutdown',
                params: {}
              })
            )
          } else if (frame.type === 'response' && welcomed && frame.id === 'shutdown') {
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
