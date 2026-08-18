import { describe, it, expect, afterEach } from 'vitest'
import { startKimiHttpMcpBridge, type KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'

let handle: KimiHttpMcpBridgeHandle | null = null
afterEach(async () => {
  await handle?.close()
  handle = null
})

async function post(
  h: KimiHttpMcpBridgeHandle,
  body: unknown,
  auth: string | null = h.headerValue
): Promise<{ status: number; sessionId: string | null; json: unknown }> {
  const res = await fetch(h.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {})
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await res.text()
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    json: text ? JSON.parse(text) : null
  }
}

describe('startKimiHttpMcpBridge', () => {
  it('rejects a request without the exact Bearer token', async () => {
    handle = await startKimiHttpMcpBridge({ dispatch: async () => ({ jsonrpc: '2.0', id: 1, result: {} }) })
    expect((await post(handle, { jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status).toBe(401)
    expect((await post(handle, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer wrong')).status).toBe(401)
  })

  it('binds localhost and dispatches a JSON-RPC request, returning the response as JSON', async () => {
    handle = await startKimiHttpMcpBridge({
      dispatch: async (msg) => ({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } })
    })
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true)
    const r = await post(handle, { jsonrpc: '2.0', id: 7, method: 'tools/list' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 7, result: { echoed: 'tools/list' } })
  })

  it('sets Mcp-Session-Id on initialize and keeps it stable', async () => {
    handle = await startKimiHttpMcpBridge({
      dispatch: async (msg) => ({ jsonrpc: '2.0', id: msg.id, result: {} })
    })
    const a = await post(handle, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(a.sessionId).toBeTruthy()
    const b = await post(handle, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    expect(b.sessionId).toBe(a.sessionId)
  })

  it('answers a notification (no id) with 202 and no body', async () => {
    handle = await startKimiHttpMcpBridge({ dispatch: async () => null })
    const r = await post(handle, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(r.status).toBe(202)
    expect(r.json).toBeNull()
  })

  it('redacts a thrown dispatch as a generic -32603 error response', async () => {
    const sentinel = '/Users/operator/private/workspace/.secrets/token=host-secret'
    handle = await startKimiHttpMcpBridge({
      dispatch: async () => {
        throw new Error(sentinel)
      }
    })
    const r = await post(handle, { jsonrpc: '2.0', id: 9, method: 'tools/call' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32603,
        message: 'TaskWraith MCP bridge encountered an unexpected internal error.'
      }
    })
    expect(JSON.stringify(r.json)).not.toContain(sentinel)
  })

  it('rejects a malformed body with -32700 and declines GET', async () => {
    handle = await startKimiHttpMcpBridge({ dispatch: async () => ({ jsonrpc: '2.0', id: 1, result: {} }) })
    const bad = await post(handle, 'not json{')
    expect(bad.status).toBe(400)
    const get = await fetch(handle.url, { headers: { Authorization: handle.headerValue } })
    expect(get.status).toBe(405)
  })

  it('close() is idempotent', async () => {
    handle = await startKimiHttpMcpBridge({ dispatch: async () => null })
    await handle.close()
    await handle.close()
    handle = null
  })

  it('tracks first authenticated contact and resolves contact waiters', async () => {
    // The resumed-session surface check keys on this: a session that never
    // touches its run's bridge is running without the gateway tools.
    handle = await startKimiHttpMcpBridge({
      dispatch: async (msg) => ({ jsonrpc: '2.0', id: msg.id, result: {} })
    })
    expect(handle.contacted()).toBe(false)
    const waited = handle.waitForContact(2_000)
    await post(handle, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(handle.contacted()).toBe(true)
    await expect(waited).resolves.toBe(true)
  })

  it('never counts an unauthorized request as contact, and times out false', async () => {
    handle = await startKimiHttpMcpBridge({ dispatch: async () => null })
    await post(handle, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer wrong')
    expect(handle.contacted()).toBe(false)
    await expect(handle.waitForContact(40)).resolves.toBe(false)
  })
})
