import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  buildNoAuthorityMcpResponse,
  serveMcpBridgeWithoutAuthority
} from './McpBridgeNoAuthorityServer'

function harness() {
  const stdin = new EventEmitter() as EventEmitter & { resume?: () => void }
  stdin.resume = () => undefined
  const written: string[] = []
  const exit = vi.fn()
  serveMcpBridgeWithoutAuthority({
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdout: { write: (chunk: string) => written.push(chunk) },
    exit,
    appVersion: '9.9.9'
  })
  const send = (text: string) => stdin.emit('data', Buffer.from(text, 'utf8'))
  const line = (payload: unknown) => send(`${JSON.stringify(payload)}\n`)
  const framed = (payload: unknown) => {
    const body = JSON.stringify(payload)
    send(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }
  return { stdin, written, exit, line, framed, send }
}

describe('buildNoAuthorityMcpResponse', () => {
  it('completes the handshake and echoes the client protocol version', () => {
    expect(
      buildNoAuthorityMcpResponse(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        '9.9.9'
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'TaskWraith MCP Bridge', version: '9.9.9' }
      }
    })
  })

  it('advertises ZERO tools — the process holds no endpoint authority', () => {
    expect(
      buildNoAuthorityMcpResponse({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '9.9.9')
    ).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
  })

  it('refuses every tools/call rather than answering one', () => {
    const response = buildNoAuthorityMcpResponse(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_shell_command' } },
      '9.9.9'
    ) as { error?: { code: number; message: string } }

    expect(response.error?.code).toBe(-32601)
    expect(response.error?.message).not.toMatch(/socket|token|epoch|\//i)
  })

  it('stays silent for notifications', () => {
    expect(
      buildNoAuthorityMcpResponse({ jsonrpc: '2.0', method: 'notifications/initialized' }, '9.9.9')
    ).toBeNull()
  })

  it('answers ping so a client health check does not read as a dead server', () => {
    expect(buildNoAuthorityMcpResponse({ jsonrpc: '2.0', id: 4, method: 'ping' }, '9.9.9')).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {}
    })
  })
})

describe('serveMcpBridgeWithoutAuthority', () => {
  it('answers a line-delimited initialize on the same framing', () => {
    const h = harness()

    h.line({ jsonrpc: '2.0', id: 1, method: 'initialize' })

    expect(h.written).toHaveLength(1)
    expect(h.written[0].endsWith('\n')).toBe(true)
    expect(JSON.parse(h.written[0])).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } })
  })

  it('answers a Content-Length request on the same framing', () => {
    const h = harness()

    h.framed({ jsonrpc: '2.0', id: 7, method: 'tools/list' })

    expect(h.written[0]).toMatch(/^Content-Length: \d+\r\n\r\n\{/)
    expect(JSON.parse(h.written[0].split('\r\n\r\n')[1])).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { tools: [] }
    })
  })

  it('reassembles a request split across chunks', () => {
    const h = harness()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })

    h.send(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body.slice(0, 10)}`)
    expect(h.written).toHaveLength(0)
    h.send(body.slice(10))

    expect(JSON.parse(h.written[0].split('\r\n\r\n')[1])).toMatchObject({ id: 8 })
  })

  it('reports malformed JSON without dying', () => {
    const h = harness()

    h.send('{not json\n')
    h.line({ jsonrpc: '2.0', id: 9, method: 'ping' })

    expect(JSON.parse(h.written[0])).toMatchObject({ error: { code: -32700 } })
    expect(JSON.parse(h.written[1])).toMatchObject({ id: 9, result: {} })
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('exits cleanly when the client closes the pipe', () => {
    const h = harness()

    h.stdin.emit('end')

    expect(h.exit).toHaveBeenCalledWith(0)
  })

  it('survives a stdout that throws (client already gone)', () => {
    const stdin = new EventEmitter() as EventEmitter & { resume?: () => void }
    stdin.resume = () => undefined
    const exit = vi.fn()
    serveMcpBridgeWithoutAuthority({
      stdin: stdin as unknown as NodeJS.ReadableStream,
      stdout: {
        write: () => {
          throw new Error('EPIPE')
        }
      },
      exit
    })

    expect(() =>
      stdin.emit('data', Buffer.from(`${JSON.stringify({ id: 1, method: 'ping' })}\n`, 'utf8'))
    ).not.toThrow()
  })
})
