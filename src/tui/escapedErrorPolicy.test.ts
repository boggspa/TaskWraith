import { describe, expect, it, vi } from 'vitest'

import {
  classifyTuiEscapedError,
  createTuiEscapedErrorHandler,
  type TuiEscapedErrorHandlerIo
} from './escapedErrorPolicy'

function harness(): { io: TuiEscapedErrorHandlerIo; stderr: string[]; exitCodes: number[] } {
  const stderr: string[] = []
  const exitCodes: number[] = []
  return {
    io: {
      stopTui: vi.fn(),
      writeStderr: (line: string) => {
        stderr.push(line)
      },
      setExitCode: (code: number) => {
        exitCodes.push(code)
      }
    },
    stderr,
    exitCodes
  }
}

/** A dropped Host socket, exactly as Node surfaces it to an unawaited promise. */
function transportError(code: string): Error {
  return Object.assign(new Error('read ECONNRESET'), { code })
}

describe('TUI escaped-error policy', () => {
  it('leaves the session alive when a Host transport rejection escapes', () => {
    const { io, stderr, exitCodes } = harness()
    const handle = createTuiEscapedErrorHandler(io)

    handle('rejection', transportError('ECONNRESET'))

    // stop() latches `stopped`, and scheduleReconnect returns early once it is
    // set — so tearing down here would destroy the reconnect path that already
    // handles this and already warns the user. Staying alive IS the fix.
    expect(io.stopTui).not.toHaveBeenCalled()
    expect(exitCodes).toEqual([])
    // The alternate screen is live; a stderr line would corrupt the frame.
    expect(stderr).toEqual([])
  })

  it('still restores the terminal when an escaped error is not recoverable', () => {
    const { io, stderr, exitCodes } = harness()
    const handle = createTuiEscapedErrorHandler(io)

    handle('rejection', new TypeError('cannot read properties of undefined'))

    // The safety net is load-bearing: without stop() the user is handed back a
    // terminal with echo off, still inside the alternate screen.
    expect(io.stopTui).toHaveBeenCalledTimes(1)
    expect(stderr).toEqual([
      'TaskWraith TUI: unexpected rejection — cannot read properties of undefined\n'
    ])
    expect(exitCodes).toEqual([1])
  })

  it('treats an uncaught exception as fatal even when it looks like transport', () => {
    const { io, exitCodes } = harness()
    const handle = createTuiEscapedErrorHandler(io)

    // Deliberately conservative: an exception unwound the stack at an arbitrary
    // point, so the state it abandoned is unknown no matter how familiar the
    // code looks. Only unawaited rejections are eligible to survive.
    expect(classifyTuiEscapedError('exception', transportError('ECONNRESET'))).toBe('fatal')
    handle('exception', transportError('ECONNRESET'))

    expect(io.stopTui).toHaveBeenCalledTimes(1)
    expect(exitCodes).toEqual([1])
  })

  it('survives repeat events so the net is not consumed by a recovery', () => {
    const { io, exitCodes } = harness()
    const handle = createTuiEscapedErrorHandler(io)

    // Registered with `on`, not `once`. A second transport blip must still be
    // absorbed, and a later genuine fault must still find a working net —
    // otherwise the fix works exactly once and the next error hard-crashes.
    handle('rejection', transportError('EPIPE'))
    handle('rejection', transportError('ECONNREFUSED'))
    expect(io.stopTui).not.toHaveBeenCalled()

    handle('rejection', new RangeError('index out of range'))
    expect(io.stopTui).toHaveBeenCalledTimes(1)
    expect(exitCodes).toEqual([1])

    // The teardown itself stays single-shot.
    handle('rejection', new RangeError('second fault'))
    expect(io.stopTui).toHaveBeenCalledTimes(1)
    expect(exitCodes).toEqual([1])
  })

  it('fails closed on anything it cannot positively recognise', () => {
    expect(classifyTuiEscapedError('rejection', undefined)).toBe('fatal')
    expect(classifyTuiEscapedError('rejection', 'ECONNRESET')).toBe('fatal')
    expect(classifyTuiEscapedError('rejection', new Error('no code'))).toBe('fatal')
    expect(classifyTuiEscapedError('rejection', { code: 'ENOENT' })).toBe('fatal')
    expect(classifyTuiEscapedError('rejection', { code: 42 })).toBe('fatal')

    // Recognised only when the code genuinely names a transport failure,
    // including when the client wraps it one `cause` level down.
    expect(classifyTuiEscapedError('rejection', transportError('ETIMEDOUT'))).toBe('recoverable')
    expect(
      classifyTuiEscapedError(
        'rejection',
        new Error('host request failed', { cause: transportError('ENOTCONN') })
      )
    ).toBe('recoverable')
  })
})
