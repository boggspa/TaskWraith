import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { openCdpWebSocketSession } = require('./cdpWebSocketSession.cjs')

class FakeWs {
  url: string
  handlers: Record<string, (...args: unknown[]) => void> = {}
  constructor(url: string) {
    this.url = url
    queueMicrotask(() => this.handlers.open && this.handlers.open())
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers[event] = handler
  }
  send(_data: string) {
    // never replies — hang
  }
  close() {
    if (this.handlers.close) this.handlers.close()
  }
}

describe('CDP websocket send timeout and close', () => {
  it('times out a send that never gets a JSON-RPC reply', async () => {
    const session = await openCdpWebSocketSession({
      url: 'ws://127.0.0.1:9/devtools',
      WebSocket: FakeWs,
      openTimeoutMs: 200
    })
    await expect(
      session.send('HeapProfiler.takeHeapSnapshot', {}, { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    session.close()
  })

  it('rejects in-flight send when the socket closes', async () => {
    const session = await openCdpWebSocketSession({
      url: 'ws://127.0.0.1:9/devtools',
      WebSocket: FakeWs,
      openTimeoutMs: 200
    })
    const pending = session.send('HeapProfiler.disable')
    session.close()
    await expect(pending).rejects.toThrow(/CDP session closed/)
  })
})
