import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerAgentQuestionHandlers } from './agentQuestionHandlers'
import { bindMainWorkSpanSink } from '../perf/mainWorkSpanSink'
import type { WorkSpanRecordInput } from '../perf/WorkSpanRecorder'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, payload: Record<string, unknown>) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps(main = false) {
  return {
    registry: {
      answer: vi.fn(() => ({ ok: true })),
      answerScoped: vi.fn(() => ({ ok: true })),
      reject: vi.fn(() => ({ ok: true })),
      rejectScoped: vi.fn(() => ({ ok: true })),
      get: vi.fn((questionId: string) =>
        questionId.startsWith('question-') ? { threadId: `chat-${questionId.slice(9)}` } : null
      )
    },
    isMainRendererSender: vi.fn(() => main),
    assertSenderChatScope: vi.fn()
  }
}

describe('registerAgentQuestionHandlers', () => {
  it('requires a secondary renderer to supply and own the question chat', () => {
    const deps = createDeps(false)
    registerAgentQuestionHandlers(deps)

    expect(() =>
      handlerFor('answer-agent-question')({ sender: { id: 2 } }, {
        questionId: 'question-1',
        answer: 'yes'
      })
    ).toThrow('Renderer cannot resolve an agent question without chat authority.')
    expect(deps.registry.answer).not.toHaveBeenCalled()
    expect(deps.registry.answerScoped).not.toHaveBeenCalled()
  })

  it('rejects a secondary renderer that targets another chat before resolution', () => {
    const deps = createDeps(false)
    deps.assertSenderChatScope.mockImplementation(() => {
      throw new Error('Renderer cannot act on another chat.')
    })
    registerAgentQuestionHandlers(deps)

    expect(() =>
      handlerFor('cancel-agent-question')({ sender: { id: 2 } }, {
        questionId: 'question-3',
        appChatId: 'chat-3'
      })
    ).toThrow('Renderer cannot act on another chat.')
    expect(deps.registry.rejectScoped).not.toHaveBeenCalled()
  })

  it('resolves secondary answers only through the owned scoped path', () => {
    const deps = createDeps(false)
    registerAgentQuestionHandlers(deps)

    expect(
      handlerFor('answer-agent-question')({ sender: { id: 2 } }, {
        questionId: 'question-1',
        answer: 'yes',
        appChatId: 'chat-1',
        appRunId: 'run-1',
        workspaceId: 'ws-1'
      })
    ).toEqual({ ok: true })
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(
      { sender: { id: 2 } },
      'chat-1'
    )
    expect(deps.registry.answerScoped).toHaveBeenCalledWith(
      'question-1',
      { threadId: 'chat-1', runId: 'run-1', workspaceId: 'ws-1' },
      'yes',
      false
    )
    expect(deps.registry.answer).not.toHaveBeenCalled()
  })

  it('keeps the main renderer unscoped fallback for legacy questions', () => {
    const deps = createDeps(true)
    registerAgentQuestionHandlers(deps)

    expect(
      handlerFor('cancel-agent-question')({ sender: { id: 1 } }, {
        questionId: 'question-1'
      })
    ).toEqual({ ok: true })
    expect(deps.registry.reject).toHaveBeenCalledWith('question-1', 'user-dismissed')
    expect(deps.registry.rejectScoped).not.toHaveBeenCalled()
  })

  it('times an answer under the chat main asked it in, and a dismissal not at all', () => {
    const spans: WorkSpanRecordInput[] = []
    bindMainWorkSpanSink({ record: (span) => void spans.push(span) })
    try {
      registerAgentQuestionHandlers(createDeps(true))
      handlerFor('answer-agent-question')(
        { sender: { id: 1 } },
        { questionId: 'question-1', answer: 'yes', appChatId: 'chat-1' }
      )
      // The payload's chat is the renderer's claim; main's record decides.
      handlerFor('answer-agent-question')(
        { sender: { id: 1 } },
        { questionId: 'question-3', answer: 'yes', appChatId: 'victim-chat' }
      )
      handlerFor('answer-agent-question')(
        { sender: { id: 1 } },
        { questionId: 'unknown', answer: 'yes', appChatId: 'chat-1' }
      )
      handlerFor('cancel-agent-question')(
        { sender: { id: 1 } },
        { questionId: 'question-2', appChatId: 'chat-2' }
      )
      expect(spans.map((span) => [span.chatId, span.kind, span.reason])).toEqual([
        ['chat-1', 'control_response', 'question_answer'],
        ['chat-3', 'control_response', 'question_answer']
      ])
    } finally {
      bindMainWorkSpanSink(undefined)
    }
  })
})
