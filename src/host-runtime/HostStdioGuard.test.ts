import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { installHostStdioGuard, writeHostStderr } from './HostStdioGuard'

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' })
}

describe('HostStdioGuard', () => {
  it('swallows every error a guarded stream raises, from EPIPE to a destroyed stream', () => {
    const stderr = new EventEmitter()
    const stdout = new EventEmitter()
    // Unguarded, an 'error' with no listener is thrown: the crash F1 was.
    expect(() => stderr.emit('error', epipe())).toThrow('EPIPE')
    installHostStdioGuard([stdout, stderr])
    expect(() => stderr.emit('error', epipe())).not.toThrow()
    expect(() =>
      stderr.emit(
        'error',
        Object.assign(new Error('Cannot call write after a stream was destroyed'), {
          code: 'ERR_STREAM_DESTROYED'
        })
      )
    ).not.toThrow()
    expect(() => stdout.emit('error', epipe())).not.toThrow()
  })

  it('guards each stream once however often it is installed', () => {
    const stderr = new EventEmitter()
    installHostStdioGuard([stderr])
    installHostStdioGuard([stderr, stderr])
    expect(stderr.listenerCount('error')).toBe(1)
  })

  it('writes a best-effort line, and drops one whose write throws instead of raising it', () => {
    const lines: string[] = []
    writeHostStderr('taskwraith-host: one\n', { write: (text: string) => lines.push(text) })
    expect(lines).toEqual(['taskwraith-host: one\n'])
    const throwing = {
      write: vi.fn(() => {
        throw epipe()
      })
    }
    expect(() => writeHostStderr('taskwraith-host: two\n', throwing)).not.toThrow()
    expect(throwing.write).toHaveBeenCalledWith('taskwraith-host: two\n')
  })
})
