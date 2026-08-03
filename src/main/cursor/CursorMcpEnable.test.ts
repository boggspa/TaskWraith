import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_MCP_ENABLE_KILL_GRACE_MS,
  cursorMcpListReportsReady,
  runCursorMcpEnable,
  runCursorMcpReadyProbe,
  type CursorMcpEnableChild
} from './CursorMcpEnable'
import { CursorWorkspaceConfigLeaseAbortedError } from './CursorWorkspaceConfigLease'

class FakeChild extends EventEmitter implements CursorMcpEnableChild {
  readonly signals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal)
    return true
  }

  override once(event: 'close', listener: () => void): this {
    return super.once(event, listener)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runCursorMcpEnable', () => {
  it('waits for the exact helper close and escalates cancellation from TERM to KILL', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const child = new FakeChild()
    let callback: ((error: Error | null, stderr: string) => void) | undefined
    let settled = false

    const approval = runCursorMcpEnable({
      serverName: 'taskwraith',
      signal: controller.signal,
      launch: (next) => {
        callback = next
        return child
      }
    }).finally(() => {
      settled = true
    })

    controller.abort()
    await Promise.resolve()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(CURSOR_MCP_ENABLE_KILL_GRACE_MS)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(settled).toBe(false)

    child.emit('close')
    await expect(approval).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(settled).toBe(true)
    expect(callback).toBeTypeOf('function')
  })

  it('treats the exec callback as a termination acknowledgement after cancellation', async () => {
    const controller = new AbortController()
    const child = new FakeChild()
    let callback: ((error: Error | null, stderr: string) => void) | undefined
    const approval = runCursorMcpEnable({
      serverName: 'taskwraith',
      signal: controller.signal,
      launch: (next) => {
        callback = next
        return child
      }
    })

    controller.abort()
    callback?.(new Error('terminated'), '')

    await expect(approval).rejects.toBeInstanceOf(CursorWorkspaceConfigLeaseAbortedError)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('preserves the helper diagnostic for ordinary failures', async () => {
    const child = new FakeChild()
    const approval = runCursorMcpEnable({
      serverName: 'taskwraith',
      launch: (callback) => {
        queueMicrotask(() => callback(new Error('exit 1'), 'approval denied'))
        return child
      }
    })

    await expect(approval).rejects.toThrow(
      'cursor-agent mcp enable taskwraith failed: approval denied'
    )
  })
})

describe('runCursorMcpReadyProbe', () => {
  it('accepts only the exact ready server row, including ANSI output', async () => {
    expect(
      cursorMcpListReportsReady(
        '\u001b[32mtaskwraith-broker: ready\u001b[0m\ntaskwraith: ready',
        'taskwraith-broker'
      )
    ).toBe(true)
    expect(
      cursorMcpListReportsReady('taskwraith-broker: Error: Connection failed', 'taskwraith-broker')
    ).toBe(false)
    expect(cursorMcpListReportsReady('taskwraith: ready', 'taskwraith-broker')).toBe(false)
  })

  it('settles only when the exact broker is ready', async () => {
    const child = new FakeChild()
    const probe = runCursorMcpReadyProbe({
      serverName: 'taskwraith-broker',
      launch: (callback) => {
        queueMicrotask(() => callback(null, 'taskwraith-broker: ready\n', ''))
        return child
      }
    })

    await expect(probe).resolves.toBeUndefined()
  })

  it('fails visibly when the broker registration exists but is not reachable', async () => {
    const child = new FakeChild()
    const probe = runCursorMcpReadyProbe({
      serverName: 'taskwraith-broker',
      launch: (callback) => {
        queueMicrotask(() =>
          callback(null, 'taskwraith-broker: Error: Connection failed\ntaskwraith: ready\n', '')
        )
        return child
      }
    })

    await expect(probe).rejects.toThrow(
      'Cursor MCP server taskwraith-broker is not ready for this run'
    )
  })
})
