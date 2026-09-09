import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OutsideSocketCommand } from './outsideCommand'
import {
  TASKWRAITH_MCP_TOOLS,
  buildTaskWraithMcpResponse,
  serveTaskWraithMcp,
  type TaskWraithMcpCommandResult,
  type TaskWraithMcpDeps
} from './mcpServer'

function deps(
  result: TaskWraithMcpCommandResult = { code: 0, out: ['ok'], err: [] }
): TaskWraithMcpDeps & { runCommand: ReturnType<typeof vi.fn> } {
  return {
    runCommand: vi.fn(async (_command: OutsideSocketCommand) => result),
    serverVersion: '9.9.9',
    defaultCwd: '/repo/worktree'
  }
}

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args }
})

describe('buildTaskWraithMcpResponse — handshake', () => {
  it('answers initialize with the requested protocol version and a tools capability', async () => {
    const response = await buildTaskWraithMcpResponse(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      deps()
    )
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'taskwraith', version: '9.9.9' }
      }
    })
  })

  it('falls back to a known protocol version when the client names none', async () => {
    const response = (await buildTaskWraithMcpResponse(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      deps()
    )) as { result: { protocolVersion: string } }
    expect(response.result.protocolVersion).toBe('2024-11-05')
  })

  it('takes no reply to a notification', async () => {
    expect(
      await buildTaskWraithMcpResponse(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        deps()
      )
    ).toBeNull()
  })

  it('answers ping, and refuses an unknown method and a malformed request', async () => {
    expect(
      await buildTaskWraithMcpResponse({ jsonrpc: '2.0', id: 2, method: 'ping' }, deps())
    ).toMatchObject({ id: 2, result: {} })
    expect(
      await buildTaskWraithMcpResponse({ jsonrpc: '2.0', id: 3, method: 'nope/at/all' }, deps())
    ).toMatchObject({ id: 3, error: { code: -32601 } })
    expect(await buildTaskWraithMcpResponse('not an object', deps())).toMatchObject({
      error: { code: -32600 }
    })
  })
})

describe('buildTaskWraithMcpResponse — tools/list', () => {
  it('advertises exactly the two verbs, each with a schema naming its required arguments', async () => {
    const response = (await buildTaskWraithMcpResponse(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      deps()
    )) as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } }
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'list_threads',
      'read_thread',
      'send_prompt'
    ])
    expect(response.result.tools).toEqual(TASKWRAITH_MCP_TOOLS)
    const send = response.result.tools.find((tool) => tool.name === 'send_prompt')
    expect(send?.inputSchema.required).toEqual(['thread', 'text'])
  })
})

describe('buildTaskWraithMcpResponse — tools/call', () => {
  it('runs list_threads against the working tree the server was started in', async () => {
    const d = deps({ code: 0, out: ['thread-1  running  ensemble  Host persistence'], err: [] })
    const response = (await buildTaskWraithMcpResponse(call('list_threads', {}), d)) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean }
    }
    expect(d.runCommand).toHaveBeenCalledWith({
      kind: 'threads',
      cwd: '/repo/worktree',
      json: false
    })
    expect(response.result.content[0]).toEqual({
      type: 'text',
      text: 'thread-1  running  ensemble  Host persistence'
    })
    expect(response.result.isError).toBeUndefined()
  })

  it('passes a query through and drops the working-tree scope when asked for all', async () => {
    const d = deps()
    await buildTaskWraithMcpResponse(call('list_threads', { query: 'host', all: true }), d)
    expect(d.runCommand).toHaveBeenCalledWith({ kind: 'threads', query: 'host', json: false })
  })

  it('sends a prompt into the named thread', async () => {
    const d = deps({ code: 0, out: ['Host persistence: Prompt dispatched.'], err: [] })
    await buildTaskWraithMcpResponse(
      call('send_prompt', { thread: 'host persistence', text: 'nice work' }),
      d
    )
    expect(d.runCommand).toHaveBeenCalledWith({
      kind: 'send',
      selector: 'host persistence',
      text: 'nice work',
      cwd: '/repo/worktree',
      json: false
    })
  })

  it('honours an explicit working tree on a send', async () => {
    const d = deps()
    await buildTaskWraithMcpResponse(
      call('send_prompt', { thread: 't-1', text: 'go', cwd: '/elsewhere' }),
      d
    )
    expect(d.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/elsewhere' }))
  })

  it('reports a refused command as an MCP tool error carrying what the CLI said', async () => {
    const d = deps({ code: 1, out: [], err: ['"Host" matches 2 threads. Send to an id:'] })
    const response = (await buildTaskWraithMcpResponse(
      call('send_prompt', { thread: 'Host', text: 'go' }),
      d
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('matches 2 threads')
  })

  it('refuses a send with missing or blank arguments without ever dispatching one', async () => {
    const d = deps()
    for (const args of [{ text: 'go' }, { thread: 't-1' }, { thread: '  ', text: 'go' }]) {
      const response = (await buildTaskWraithMcpResponse(call('send_prompt', args), d)) as {
        result: { isError?: boolean }
      }
      expect(response.result.isError).toBe(true)
    }
    expect(d.runCommand).not.toHaveBeenCalled()
  })

  it('reads a thread back, scoped and limited', async () => {
    const d = deps({ code: 0, out: ['Codex · 10:00', 'thanks'], err: [] })
    const response = (await buildTaskWraithMcpResponse(
      call('read_thread', { thread: 't-1', limit: 5 }),
      d
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(d.runCommand).toHaveBeenCalledWith({
      kind: 'read',
      selector: 't-1',
      limit: 5,
      cwd: '/repo/worktree',
      json: false
    })
    expect(response.result.content[0].text).toContain('thanks')
    expect(response.result.isError).toBeUndefined()
  })

  it('reads without a limit when the caller names none', async () => {
    const d = deps()
    await buildTaskWraithMcpResponse(call('read_thread', { thread: 't-1' }), d)
    expect(d.runCommand.mock.calls[0][0]).not.toHaveProperty('limit')
  })

  it('refuses a read with no thread, and a limit that is not a positive count', async () => {
    const d = deps()
    for (const args of [
      {},
      { thread: '  ' },
      { thread: 't-1', limit: 0 },
      { thread: 't-1', limit: 'lots' }
    ]) {
      const response = (await buildTaskWraithMcpResponse(call('read_thread', args), d)) as {
        result: { isError?: boolean }
      }
      expect(response.result.isError).toBe(true)
    }
    expect(d.runCommand).not.toHaveBeenCalled()
  })

  it('refuses an unknown tool without dispatching', async () => {
    const d = deps()
    const response = (await buildTaskWraithMcpResponse(call('rm_rf', {}), d)) as {
      result: { isError?: boolean; content: Array<{ text: string }> }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('rm_rf')
    expect(d.runCommand).not.toHaveBeenCalled()
  })

  it('reports a thrown command as a tool error rather than taking the server down', async () => {
    const d = deps()
    d.runCommand = vi.fn(async () => {
      throw new Error('socket died')
    })
    const response = (await buildTaskWraithMcpResponse(call('list_threads', {}), d)) as {
      result: { isError?: boolean; content: Array<{ text: string }> }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('socket died')
  })
})

describe('serveTaskWraithMcp', () => {
  function harness() {
    const stdin = new EventEmitter() as EventEmitter & { resume?: () => void }
    stdin.resume = () => undefined
    const written: string[] = []
    const exit = vi.fn()
    serveTaskWraithMcp({
      stdin: stdin as unknown as NodeJS.ReadableStream,
      stdout: { write: (chunk: string) => written.push(chunk) },
      exit,
      deps: deps()
    })
    return { stdin, written, exit }
  }

  it('answers a newline-framed request in the same framing', async () => {
    const h = harness()
    h.stdin.emit(
      'data',
      Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    )
    await vi.waitFor(() => expect(h.written).toHaveLength(1))
    expect(h.written[0].endsWith('\n')).toBe(true)
    expect(JSON.parse(h.written[0])).toMatchObject({ id: 1, result: {} })
  })

  it('answers a Content-Length framed request in the same framing', async () => {
    const h = harness()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
    h.stdin.emit(
      'data',
      Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
    )
    await vi.waitFor(() => expect(h.written).toHaveLength(1))
    expect(h.written[0]).toMatch(/^Content-Length: \d+\r\n\r\n\{/)
  })

  it('writes nothing at all for a notification, keeping stdout pure JSON-RPC', async () => {
    const h = harness()
    h.stdin.emit(
      'data',
      Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.written).toEqual([])
  })

  it('reports malformed JSON as a parse error instead of dying', async () => {
    const h = harness()
    h.stdin.emit('data', Buffer.from('{ not json\n'))
    await vi.waitFor(() => expect(h.written).toHaveLength(1))
    expect(JSON.parse(h.written[0])).toMatchObject({ error: { code: -32700 } })
  })

  it('exits when the client hangs up', () => {
    const h = harness()
    h.stdin.emit('end')
    expect(h.exit).toHaveBeenCalledWith(0)
  })
})
