import { describe, expect, it } from 'vitest'

import { meaningfulAcpStderrLine } from './HostNodeAcpStderr'

describe('meaningfulAcpStderrLine', () => {
  it('drops telemetry and Sentry chatter and keeps the last line that reads like an error', () => {
    expect(
      meaningfulAcpStderrLine(
        "DEBUG:vibe:telemetry event=vibe.tool_call_finished properties={'os': 'darwin'}\n" +
          'vibe.core.exceptions.UnauthenticatedError: Sign in with vibe --setup\n' +
          'Sentry is attempting to send 2 pending events\nWaiting up to 2 seconds\nPress Ctrl-C to quit\n'
      )
    ).toBe('vibe.core.exceptions.UnauthenticatedError: Sign in with vibe --setup')
  })

  it('returns nothing for a chunk that is only noise', () => {
    expect(meaningfulAcpStderrLine('INFO: warming up\n\nDEBUG:vibe:x\n')).toBe('')
  })

  it('bounds and control-strips what it keeps', () => {
    const bell = String.fromCharCode(7)
    const kept = meaningfulAcpStderrLine(`Traceback${bell} ${'x'.repeat(400)}`, 50)
    expect(kept.length).toBeLessThanOrEqual(50)
    expect(kept.startsWith('Traceback ')).toBe(true)
    expect(kept.includes(bell)).toBe(false)
  })
})
