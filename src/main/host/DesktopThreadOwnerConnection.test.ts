import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import {
  DESKTOP_THREAD_OWNER_CLIENT_ID,
  DesktopThreadOwnerConnection,
  createDesktopThreadOwnerClient
} from './DesktopThreadOwnerConnection'

const WELCOME = { bootEpoch: 'a'.repeat(64) } as HostBootstrapWelcome

class FakeTransport extends EventEmitter {
  connected = false
  connects = 0
  closes = 0
  outcome: 'welcome' | 'fail' | 'hang' = 'welcome'
  private release: (() => void) | null = null

  connect(): Promise<HostBootstrapWelcome> {
    this.connects += 1
    if (this.outcome === 'fail') return Promise.reject(new Error('no host'))
    const welcome = () => {
      this.connected = true
      this.emit('welcome', WELCOME)
      return WELCOME
    }
    if (this.outcome === 'hang') {
      return new Promise((resolve) => {
        this.release = () => resolve(welcome())
      })
    }
    return Promise.resolve(welcome())
  }

  finish(): void {
    this.release?.()
  }

  close(): void {
    this.closes += 1
    this.connected = false
  }

  drop(): void {
    this.connected = false
    this.emit('disconnected', new Error('gone'))
  }
}

function fixture() {
  const transport = new FakeTransport()
  const client = { onWelcome: vi.fn(), onDisconnected: vi.fn() }
  const log = vi.fn()
  const connection = new DesktopThreadOwnerConnection(transport, client, log)
  return { transport, client, log, connection }
}

describe('DesktopThreadOwnerConnection', () => {
  it('tells the negotiation client about the welcome before the connect resolves', async () => {
    const { transport, client, connection } = fixture()
    await expect(connection.ensureConnected()).resolves.toBe(true)
    expect(client.onWelcome).toHaveBeenCalledWith(WELCOME)
    expect(transport.connects).toBe(1)
    // Already connected: no second socket.
    await expect(connection.ensureConnected()).resolves.toBe(true)
    expect(transport.connects).toBe(1)
  })

  it('runs one connect at a time', async () => {
    const { transport, connection } = fixture()
    transport.outcome = 'hang'
    const first = connection.ensureConnected()
    const second = connection.ensureConnected()
    transport.finish()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(transport.connects).toBe(1)
  })

  it('answers false when the Host cannot be reached, and tries again next time', async () => {
    const { transport, log, connection } = fixture()
    transport.outcome = 'fail'
    await expect(connection.ensureConnected()).resolves.toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no host'))
    transport.outcome = 'welcome'
    await expect(connection.ensureConnected()).resolves.toBe(true)
    expect(transport.connects).toBe(2)
  })

  it('passes a dropped socket on to the client, which voids its grants', async () => {
    const { transport, client, connection } = fixture()
    await connection.ensureConnected()
    transport.drop()
    expect(client.onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('reports its own close too, which the transport does not, and never reconnects after', async () => {
    const { transport, client, connection } = fixture()
    await connection.ensureConnected()
    connection.close()
    connection.close()
    expect(transport.closes).toBe(1)
    expect(client.onDisconnected).toHaveBeenCalledTimes(1)
    await expect(connection.ensureConnected()).resolves.toBe(false)
    expect(transport.connects).toBe(1)
  })

  it('builds a desktop-class client with an id of its own', () => {
    const client = createDesktopThreadOwnerClient({
      userDataPath: '/tmp/desktop-thread-owner-client-test',
      appVersion: '0.0.0-test'
    })
    expect(client.connected).toBe(false)
    expect(DESKTOP_THREAD_OWNER_CLIENT_ID).not.toBe('taskwraith-desktop-lease')
  })
})
