import { afterEach, describe, expect, it, vi } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'
import {
  DESKTOP_CONTROL_ACTIONS,
  handleChatControl,
  handleDesktopControl,
  withDesktopControlResponseSpan
} from './desktopControlResponseSpan'
import { bindMainWorkSpanSink } from './mainWorkSpanSink'
import { createWorkSpanRecorder, type WorkSpanRecordInput } from './WorkSpanRecorder'

function captureSink() {
  const spans: WorkSpanRecordInput[] = []
  return { spans, sink: { record: (span: WorkSpanRecordInput) => void spans.push(span) } }
}

/** A clock that reads each value once, then keeps reading the last. */
function readings(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

const byChat = (_event: unknown, chatId?: unknown) => chatId

/** A handler's arguments as the renderer sends them: a chat id, or anything. */
type ChatArgs = [event: unknown, chatId?: unknown]

afterEach(() => {
  bindMainWorkSpanSink(undefined)
})

describe('withDesktopControlResponseSpan', () => {
  it('times a synchronous handler from ingress to its result, as its action', () => {
    const { spans, sink } = captureSink()
    const wrapped = withDesktopControlResponseSpan(
      'cancel',
      byChat,
      (_event: unknown, chatId?: string) => `cancelled ${chatId}`,
      { sink: () => sink, now: readings(1_000, 1_030) }
    )
    expect(wrapped({}, ' chat-1 ')).toBe('cancelled  chat-1 ')
    expect(spans).toEqual([
      {
        chatId: 'chat-1',
        kind: 'control_response',
        reason: 'cancel',
        startedAt: 1_000,
        durationMs: 30
      }
    ])
  })

  it('ends an async handler’s span when its promise settles, and returns that promise', async () => {
    const { spans, sink } = captureSink()
    let settle: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      settle = resolve
    })
    const wrapped = withDesktopControlResponseSpan(
      'approval_decision',
      byChat,
      (..._: ChatArgs) => pending,
      {
        sink: () => sink,
        now: readings(2_000, 2_450)
      }
    )
    const result = wrapped({}, 'chat-2')
    expect(result).toBe(pending)
    await Promise.resolve()
    expect(spans).toEqual([])
    settle('approved')
    await expect(result).resolves.toBe('approved')
    expect(spans).toEqual([expect.objectContaining({ chatId: 'chat-2', durationMs: 450 })])
  })

  it('times a refusal too: a rejection or a throw reaches the caller unchanged', async () => {
    const { spans, sink } = captureSink()
    const failure = new Error('Renderer cannot act on another chat.')
    const rejecting = withDesktopControlResponseSpan(
      'question_answer',
      byChat,
      (..._: ChatArgs) => Promise.reject(failure),
      { sink: () => sink, now: readings(10, 25) }
    )
    await expect(rejecting({}, 'chat-3')).rejects.toBe(failure)
    const throwing = withDesktopControlResponseSpan(
      'question_answer',
      byChat,
      (..._: ChatArgs) => {
        throw failure
      },
      { sink: () => sink, now: readings(40, 41) }
    )
    expect(() => throwing({}, 'chat-3')).toThrow(failure)
    expect(spans.map((span) => [span.reason, span.durationMs])).toEqual([
      ['question_answer', 15],
      ['question_answer', 1]
    ])
  })

  it('names the chat before the handler runs', () => {
    const { spans, sink } = captureSink()
    const pending = new Map<unknown, string>([['approval-1', 'chat-4']])
    const wrapped = withDesktopControlResponseSpan(
      'approval_decision',
      (_event, requestId) => pending.get(requestId),
      (_event: unknown, requestId: string) => pending.delete(requestId),
      { sink: () => sink, now: readings(0, 5) }
    )
    expect(wrapped({}, 'approval-1')).toBe(true)
    expect(spans).toEqual([expect.objectContaining({ chatId: 'chat-4' })])
  })

  it('records nothing without a sink or a nameable chat, and runs the handler as given', () => {
    const handler = vi.fn((_event: unknown, value: unknown) => ({ handled: value }))
    const chatOf = vi.fn(byChat)
    const unmeasured = withDesktopControlResponseSpan('cancel', chatOf, handler, {
      sink: () => undefined
    })
    expect(unmeasured({ sender: 1 }, 'chat-5')).toEqual({ handled: 'chat-5' })
    expect(chatOf).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledWith({ sender: 1 }, 'chat-5')

    const { spans, sink } = captureSink()
    for (const chatId of ['', '   ', 42, undefined, null]) {
      const wrapped = withDesktopControlResponseSpan('cancel', byChat, handler, {
        sink: () => sink,
        now: readings(0, 1)
      })
      expect(wrapped({}, chatId)).toEqual({ handled: chatId })
    }
    const lookupThrows = withDesktopControlResponseSpan(
      'cancel',
      () => {
        throw new Error('approval list gone')
      },
      handler,
      { sink: () => sink, now: readings(0, 1) }
    )
    expect(lookupThrows({}, 'chat-5')).toEqual({ handled: 'chat-5' })
    expect(spans).toEqual([])
  })

  it('loses the measurement, never the result, when the sink or the clock fails', async () => {
    const handler = (_event: unknown, chatId?: string) => Promise.resolve(`ok ${chatId}`)
    const cases = [
      {
        sink: () => ({
          record: () => {
            throw new Error('recorder gone')
          }
        }),
        now: readings(0, 1)
      },
      {
        sink: () => {
          throw new Error('sink accessor gone')
        },
        now: readings(0, 1)
      },
      {
        sink: () => captureSink().sink,
        now: () => {
          throw new Error('clock gone')
        }
      },
      { sink: () => captureSink().sink, now: readings(Number.NaN) }
    ]
    for (const options of cases) {
      const wrapped = withDesktopControlResponseSpan('cancel', byChat, handler, options)
      await expect(wrapped({}, 'chat-6')).resolves.toBe('ok chat-6')
    }
    const { spans, sink } = captureSink()
    let reads = 0
    const endClockFails = withDesktopControlResponseSpan('cancel', byChat, handler, {
      sink: () => sink,
      now: () => {
        reads += 1
        if (reads > 1) throw new Error('clock gone at the end')
        return 7
      }
    })
    await expect(endClockFails({}, 'chat-6')).resolves.toBe('ok chat-6')
    expect(spans).toEqual([])
  })

  it('keeps a throwing sink out of a synchronous result and a synchronous refusal', () => {
    const throwingSink = () => ({
      record: () => {
        throw new Error('recorder gone')
      }
    })
    const value = withDesktopControlResponseSpan('cancel', byChat, (..._: ChatArgs) => 'done', {
      sink: throwingSink,
      now: readings(0, 1)
    })
    expect(value({}, 'chat-12')).toBe('done')
    const refusal = new Error('Renderer cannot act on another chat.')
    const refusing = withDesktopControlResponseSpan(
      'cancel',
      byChat,
      (..._: ChatArgs) => {
        throw refusal
      },
      { sink: throwingSink, now: readings(0, 1) }
    )
    expect(() => refusing({}, 'chat-12')).toThrow(refusal)
  })

  it('records no span from a clock that fails, and never a negative one', async () => {
    const handler = (_event: unknown, chatId?: string) => Promise.resolve(`ok ${chatId}`)
    const { spans, sink } = captureSink()
    for (const now of [readings(Number.NaN), readings(-1), readings(Infinity)]) {
      const wrapped = withDesktopControlResponseSpan('cancel', byChat, handler, {
        sink: () => sink,
        now
      })
      await expect(wrapped({}, 'chat-6')).resolves.toBe('ok chat-6')
    }
    expect(spans).toEqual([])
    const backwards = withDesktopControlResponseSpan('cancel', byChat, handler, {
      sink: () => sink,
      now: readings(500, 480)
    })
    await expect(backwards({}, 'chat-6')).resolves.toBe('ok chat-6')
    expect(spans).toEqual([expect.objectContaining({ startedAt: 500, durationMs: 0 })])
  })

  it('returns a thenable whose then() throws, untouched and unmeasured', () => {
    const { spans, sink } = captureSink()
    const thenable = {
      then() {
        throw new Error('then gone')
      }
    }
    const wrapped = withDesktopControlResponseSpan(
      'approval_decision',
      byChat,
      (..._: ChatArgs) => thenable,
      {
        sink: () => sink,
        now: readings(0, 1)
      }
    )
    expect(wrapped({}, 'chat-11')).toBe(thenable)
    expect(spans).toEqual([])
  })

  it('refuses a chat id longer than any lane reader accepts', () => {
    const { spans, sink } = captureSink()
    const handler = (..._: ChatArgs) => 'done'
    for (const chatId of ['c'.repeat(256), ` ${'c'.repeat(256)} `, 'c'.repeat(257)]) {
      withDesktopControlResponseSpan('cancel', byChat, handler, {
        sink: () => sink,
        now: readings(0, 1)
      })({}, chatId)
    }
    expect(spans.map((span) => span.chatId.length)).toEqual([256, 256])
  })

  it('records one span for one call, even from a thenable that settles twice', () => {
    const { spans, sink } = captureSink()
    const twice = {
      then(resolve: (value: string) => void, reject: (reason: unknown) => void) {
        resolve('done')
        reject(new Error('and again'))
      }
    }
    withDesktopControlResponseSpan('approval_decision', byChat, (..._: ChatArgs) => twice, {
      sink: () => sink,
      now: readings(0, 1, 2)
    })({}, 'chat-13')
    expect(spans).toEqual([expect.objectContaining({ chatId: 'chat-13', durationMs: 1 })])
  })

  it('reads the default sink on each call, not when the handler is wrapped', () => {
    const wrapped = withDesktopControlResponseSpan('cancel', byChat, (..._: ChatArgs) => true)
    const { spans, sink } = captureSink()
    bindMainWorkSpanSink(sink)
    wrapped({}, 'chat-14')
    expect(spans).toEqual([expect.objectContaining({ chatId: 'chat-14' })])
  })

  it('defaults to the process-wide main sink', () => {
    const { spans, sink } = captureSink()
    bindMainWorkSpanSink(sink)
    withDesktopControlResponseSpan('cancel', byChat, (..._: ChatArgs) => true)({}, 'chat-7')
    expect(spans).toEqual([expect.objectContaining({ chatId: 'chat-7', reason: 'cancel' })])
  })

  it('writes spans the recorder accepts, one reason per action', () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    for (const action of DESKTOP_CONTROL_ACTIONS) {
      withDesktopControlResponseSpan(action, byChat, (..._: ChatArgs) => true, {
        sink: () => recorder,
        now: readings(100, 160)
      })({}, 'chat-8')
    }
    const snapshot = recorder.snapshot()
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.spans.map((span) => [span.kind, span.reason, span.durationMs])).toEqual([
      ['control_response', 'cancel', 60],
      ['control_response', 'approval_decision', 60],
      ['control_response', 'question_answer', 60]
    ])
    expect(DESKTOP_CONTROL_ACTIONS).toEqual(['cancel', 'approval_decision', 'question_answer'])
  })
})

describe('handleDesktopControl and handleChatControl', () => {
  it('register the timed handler on the channel', async () => {
    const { spans, sink } = captureSink()
    const ipc = { handle: vi.fn() }
    handleChatControl(ipc, 'cancel-ensemble-round', 'cancel', async (_event, chatId) => chatId, {
      sink: () => sink,
      now: readings(0, 3)
    })
    handleDesktopControl(
      ipc,
      'answer-agent-question',
      'question_answer',
      (_event, payload) => (payload as { appChatId?: string }).appChatId,
      (_event, payload: { appChatId?: string }) => ({ ok: Boolean(payload) }),
      { sink: () => sink, now: readings(10, 12) }
    )
    const handlers = new Map(
      ipc.handle.mock.calls.map(([channel, handler]) => [channel, handler])
    ) as Map<string, (...args: unknown[]) => unknown>
    await expect(handlers.get('cancel-ensemble-round')!({}, 'chat-9')).resolves.toBe('chat-9')
    expect(handlers.get('answer-agent-question')!({}, { appChatId: 'chat-10' })).toEqual({
      ok: true
    })
    expect(spans.map((span) => [span.chatId, span.reason, span.durationMs])).toEqual([
      ['chat-9', 'cancel', 3],
      ['chat-10', 'question_answer', 2]
    ])
  })

  it('times main’s cancel-ensemble-round handler', () => {
    const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))
    const calls = probe.callsTo(probe.source, 'handleChatControl')
    expect(calls).toHaveLength(1)
    expect([0, 1, 2].map((index) => probe.argText(calls[0], index))).toEqual([
      'ipcMain',
      "'cancel-ensemble-round'",
      "'cancel'"
    ])
    const direct = probe
      .callsTo(probe.source, 'handle')
      .filter((call) => probe.argText(call, 0) === "'cancel-ensemble-round'")
    expect(direct).toEqual([])
  })
})
