import { describe, expect, it } from 'vitest'
import { formatKimiProcessError, runKimiAcpTurn } from './KimiAcpClient'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import {
  createProviderTransportCloseOperation,
  ProviderOperationRegistry,
  waitForProviderOperationSettlement
} from '../run/ProviderOperationRegistry'

class FakeChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
  autoCloseOnEnd = true
  private dataListeners: Array<(chunk: string) => void> = []
  private closeListener?: (code: number | null) => void
  stdin = {
    write: (data: string): void => {
      this.writes.push(data)
    },
    on: (): void => {},
    end: (): void => {
      this.killed = true
      if (this.autoCloseOnEnd) this.closeListener?.(0)
    }
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = { on: (): void => {} }
  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }
  kill(): void {
    this.killed = true
    this.closeListener?.(0)
  }
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((listener) => listener(line))
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
  sent(): Array<Record<string, unknown>> {
    return this.writes.map((write) => JSON.parse(write.trim()) as Record<string, unknown>)
  }
}

describe('runKimiAcpTurn', () => {
  it('holds a deletion join through cancel, exact child close, and async cleanup', async () => {
    const registry = new ProviderOperationRegistry()
    const transportClose = createProviderTransportCloseOperation()
    const transportOperation = registry.track('kimi-run', transportClose.operation)
    const child = new FakeChild()
    child.autoCloseOnEnd = false
    let releaseCleanup!: () => void
    let cleanupStarted = false
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const handle = runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {},
      onClose: async () => {
        cleanupStarted = true
        await cleanup
      }
    })
    void handle.closed.then(() => transportClose.markTransportClosed())

    let deletionSettled = false
    const deletionJoin = waitForProviderOperationSettlement(transportOperation, 1_000).then(
      (settled) => {
        deletionSettled = settled
        return settled
      }
    )

    handle.cancel()
    await Promise.resolve()
    expect(child.killed).toBe(true)
    expect(cleanupStarted).toBe(false)
    expect(deletionSettled).toBe(false)

    child.finish(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupStarted).toBe(true)
    expect(deletionSettled).toBe(false)

    releaseCleanup()
    await handle.closed
    await expect(deletionJoin).resolves.toBe(true)
    expect(registry.get('kimi-run')).toBeUndefined()
  })

  it('advertises no path-based client fs capability', () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {}
    })

    expect(child.sent()[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'taskwraith', version: '1.0.6' }
      }
    })
  })

  it('does not answer an unsolicited fs request', () => {
    const child = new FakeChild()
    runKimiAcpTurn({
      prompt: 'hi',
      cwdLifetime: 'run',
      cwd: '/private/empty',
      spawnProcess: () => child,
      onEvent: () => {}
    })
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session_1' } })
    child.emit({
      jsonrpc: '2.0',
      id: 30,
      method: 'fs/read_text_file',
      params: { path: '/workspace/secret' }
    })

    expect(child.sent().find((message) => message.id === 30)).toMatchObject({
      id: 30,
      error: { code: -32601 }
    })
  })
})

describe('formatKimiProcessError', () => {
  it('explains ENOENT as missing Kimi Code setup', () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    expect(formatKimiProcessError(error)).toContain('Kimi Code could not be started')
    expect(formatKimiProcessError(error)).toContain('kimi login')
  })

  it('passes through non-ENOENT errors verbatim', () => {
    expect(formatKimiProcessError(new Error('boom'))).toBe('boom')
  })
})
