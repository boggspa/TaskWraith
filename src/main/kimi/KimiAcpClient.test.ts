import { describe, it, expect, vi } from 'vitest'
import { resolve, relative } from 'path'
import {
  createKimiFsInboundHandler,
  formatKimiProcessError,
  runKimiAcpTurn,
  type KimiAcpFs
} from './KimiAcpClient'
import type { AcpInboundReply, AcpChildProcess } from '../acp/AcpTurnClient'
import type { AcpRunEvent } from '../acp/AcpProtocol'

const realFs = (
  over: Partial<KimiAcpFs> = {}
): KimiAcpFs => ({
  readTextFile: async () => 'BODY',
  writeTextFile: async () => {},
  resolve,
  relative,
  ...over
})

function makeReply(): { reply: AcpInboundReply; results: unknown[]; errors: [number, string][] } {
  const results: unknown[] = []
  const errors: [number, string][] = []
  return {
    reply: {
      respondResult: (r) => results.push(r),
      respondError: (c, m) => errors.push([c, m])
    },
    results,
    errors
  }
}

describe('createKimiFsInboundHandler — workspace path authority', () => {
  it('serves a read inside the workspace', async () => {
    const events: AcpRunEvent[] = []
    const handler = createKimiFsInboundHandler({
      fsRoots: ['/ws'],
      fs: realFs({ readTextFile: async () => 'HELLO' }),
      onEvent: (e) => events.push(e)
    })
    const { reply, results } = makeReply()
    const handled = handler(
      { method: 'fs/read_text_file', id: 1, params: { path: '/ws/a.txt' } },
      reply
    )
    expect(handled).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(results).toEqual([{ content: 'HELLO' }])
  })

  it('denies a read outside the workspace and warns', async () => {
    const events: AcpRunEvent[] = []
    const readSpy = vi.fn(async () => 'SECRET')
    const handler = createKimiFsInboundHandler({
      fsRoots: ['/ws'],
      fs: realFs({ readTextFile: readSpy }),
      onEvent: (e) => events.push(e)
    })
    const { reply, results, errors } = makeReply()
    const handled = handler(
      { method: 'fs/read_text_file', id: 2, params: { path: '/etc/passwd' } },
      reply
    )
    expect(handled).toBe(true)
    expect(readSpy).not.toHaveBeenCalled()
    expect(results).toHaveLength(0)
    expect(errors[0][1]).toContain('outside the granted workspace')
    expect(events.some((e) => e.type === 'provider_warning' && /denied it/.test(e.text || ''))).toBe(
      true
    )
  })

  it('serves a write inside the workspace and denies one outside', async () => {
    const writeSpy = vi.fn(async () => {})
    const handler = createKimiFsInboundHandler({
      fsRoots: ['/ws', '/grant'],
      fs: realFs({ writeTextFile: writeSpy }),
      onEvent: () => {}
    })

    const inside = makeReply()
    handler(
      { method: 'fs/write_text_file', id: 3, params: { path: '/grant/out.txt', content: 'X' } },
      inside.reply
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(writeSpy).toHaveBeenCalledWith('/grant/out.txt', 'X')
    expect(inside.results).toEqual([null])

    const outside = makeReply()
    handler(
      { method: 'fs/write_text_file', id: 4, params: { path: '/tmp/evil', content: 'X' } },
      outside.reply
    )
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(outside.errors).toHaveLength(1)
  })

  it('declines (returns false) for non-fs methods so the core keep-alives them', () => {
    const handler = createKimiFsInboundHandler({ fsRoots: ['/ws'], fs: realFs(), onEvent: () => {} })
    const { reply } = makeReply()
    expect(handler({ method: 'terminal/create', id: 5, params: {} }, reply)).toBe(false)
  })

  it('surfaces a read error as a JSON-RPC error, not a crash', async () => {
    const handler = createKimiFsInboundHandler({
      fsRoots: ['/ws'],
      fs: realFs({
        readTextFile: async () => {
          throw new Error('EISDIR')
        }
      }),
      onEvent: () => {}
    })
    const { reply, errors } = makeReply()
    handler({ method: 'fs/read_text_file', id: 6, params: { path: '/ws/dir' } }, reply)
    await new Promise((r) => setTimeout(r, 0))
    expect(errors[0][1]).toContain('Read failed')
  })
})

describe('runKimiAcpTurn', () => {
  class FakeChild implements AcpChildProcess {
    writes: string[] = []
    killed = false
    private dataListeners: ((chunk: string) => void)[] = []
    private closeListener?: (code: number | null) => void
    stdin = { write: (d: string) => void this.writes.push(d), on: () => {} }
    stdout = {
      on: (_e: 'data', l: (chunk: string) => void) => void this.dataListeners.push(l)
    }
    stderr = { on: () => {} }
    on(event: 'error' | 'close', listener: (arg: never) => void): void {
      if (event === 'close') this.closeListener = listener as (code: number | null) => void
    }
    kill(): void {
      this.killed = true
      this.closeListener?.(0)
    }
    emit(m: unknown): void {
      const line = `${JSON.stringify(m)}\n`
      this.dataListeners.forEach((cb) => cb(line))
    }
    sent(): Record<string, unknown>[] {
      return this.writes.map((w) => JSON.parse(w.trim()))
    }
  }

  it('advertises fs read+write capabilities in initialize', () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'hi',
      cwd: '/ws',
      spawnProcess: () => child,
      fsRoots: ['/ws'],
      fs: realFs(),
      onEvent: () => {}
    })
    expect(child.sent()[0]).toMatchObject({
      method: 'initialize',
      params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }
    })
  })

  it('answers an fs read routed by the agent under workspace authority', async () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'read it',
      cwd: '/ws',
      spawnProcess: () => child,
      fsRoots: ['/ws'],
      fs: realFs({ readTextFile: async () => 'FILE' }),
      onEvent: () => {}
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    child.emit({ jsonrpc: '2.0', id: 30, method: 'fs/read_text_file', params: { path: '/ws/f' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(child.sent().find((m) => m.id === 30)).toMatchObject({
      id: 30,
      result: { content: 'FILE' }
    })
  })
})

describe('formatKimiProcessError', () => {
  it('explains ENOENT as missing Kimi Code setup', () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    expect(formatKimiProcessError(err)).toContain('Kimi Code could not be started')
    expect(formatKimiProcessError(err)).toContain('kimi login')
  })

  it('passes through non-ENOENT errors verbatim', () => {
    expect(formatKimiProcessError(new Error('boom'))).toBe('boom')
  })
})
