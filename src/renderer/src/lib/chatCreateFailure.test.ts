import { describe, expect, it, vi } from 'vitest'
import { guardChatCreate } from './chatCreateFailure'

describe('guardChatCreate', () => {
  it('reports a rejected create against the surface that issued it', async () => {
    const reporter = vi.fn()
    const failure = new Error('Host persistence failed.')

    guardChatCreate('sidebar new-chat menu', Promise.reject(failure), reporter)
    await Promise.resolve()

    expect(reporter).toHaveBeenCalledWith('sidebar new-chat menu', failure)
  })

  it('leaves no unhandled rejection behind for a failed create', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      guardChatCreate('thread home (workspace)', Promise.reject(new Error('nope')), vi.fn())
      // Two macrotask turns: Node reports an unhandled rejection only after the
      // microtask queue drains, so a same-tick assertion would pass vacuously.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('stays silent for a create that resolves', async () => {
    const reporter = vi.fn()

    guardChatCreate('sidebar new-chat menu', Promise.resolve({ appChatId: 'chat-1' }), reporter)
    await Promise.resolve()

    expect(reporter).not.toHaveBeenCalled()
  })

  it('is a no-op for a surface whose prop type discards the result', () => {
    const reporter = vi.fn()

    expect(() => guardChatCreate('sidebar new-chat menu', undefined, reporter)).not.toThrow()
    expect(reporter).not.toHaveBeenCalled()
  })
})
