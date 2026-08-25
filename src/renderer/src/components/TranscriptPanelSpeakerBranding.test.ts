import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { activityStackSpeakerPresentation } from './TranscriptPanel'

/**
 * Cause 5 of the branding-loss investigation: the activity-stack speaker header
 * resolved its model from the message's own run ONLY, while the assistant
 * bubble beside it also falls back to the chat's most recent model-bearing run.
 * A follow-up row whose `runId` lookup misses therefore lost the Pi/Ollama
 * upstream override in the header while the adjacent bubble kept it — two
 * adjacent rows disagreeing about who spoke.
 */

const toolMessage = (runId: string): ChatMessage => ({
  id: 'msg-1',
  role: 'tool',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  runId,
  toolActivities: [
    {
      id: 'act-1',
      toolName: 'run_shell_command',
      displayName: 'Run shell command',
      category: 'unknown',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
})

const chatWith = (runs: ChatRun[], chatKind: ChatRecord['chatKind'] = 'single'): ChatRecord => ({
  appChatId: 'chat-1',
  title: 'Branding',
  chatKind,
  createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
  updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  archived: false,
  messages: [],
  runs
})

const piRun = (runId: string, requestedModel: string): ChatRun => ({
  runId,
  provider: 'pi',
  startedAt: '2026-01-01T00:00:00.000Z',
  requestedModel
})

describe('activityStackSpeakerPresentation branding fallback', () => {
  it('keeps the Pi upstream brand when the row run lookup misses', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-missing'),
      chat: chatWith([piRun('run-1', 'deepseek/deepseek-v4-flash')]),
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })
    expect(presentation.label).toBe('DeepSeek')
    expect(presentation.providerClass).toBe('deepseek')
  })

  it('keeps the Ollama upstream brand when the row run lookup misses', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-missing'),
      chat: chatWith([
        {
          runId: 'run-1',
          provider: 'ollama',
          startedAt: '2026-01-01T00:00:00.000Z',
          requestedModel: 'qwen3:8b'
        }
      ]),
      fallbackProvider: 'ollama',
      fallbackProviderLabel: 'Ollama'
    })
    expect(presentation.label).toBe('Alibaba')
    expect(presentation.providerClass).toBe('alibaba')
  })

  it('still prefers the row own run over the chat-wide fallback', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-2'),
      chat: chatWith([
        piRun('run-1', 'deepseek/deepseek-v4-flash'),
        piRun('run-2', 'zai/glm-5.2')
      ]),
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })
    expect(presentation.label).toBe('Z.ai')
    expect(presentation.providerClass).toBe('zai')
  })

  it('never fabricates a brand from an ambiguous same-provider history', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-missing'),
      chat: chatWith([
        piRun('run-1', 'deepseek/deepseek-v4-flash'),
        piRun('run-2', 'zai/glm-5.2')
      ]),
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })
    expect(presentation.label).toBe('Pi')
    expect(presentation.providerClass).toBe('pi')
  })

  it('does not borrow the solo fallback for an ensemble chat', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-missing'),
      chat: chatWith([piRun('run-1', 'deepseek/deepseek-v4-flash')], 'ensemble'),
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })
    expect(presentation.providerClass).toBe('pi')
  })
})

/**
 * Cause 4: the Ollama brand matcher tries the wire id first and the human label
 * second, but `ChatRun` carried no label, so the second chance was unreachable
 * from any run-derived row. Ollama tags are routinely shortened ("north-mini:30b")
 * while the catalog label keeps the full name the needle matches.
 */
describe('run model label branding', () => {
  const ollamaRun = (requestedModel: string, modelLabel?: string): ChatRun => ({
    runId: 'run-1',
    provider: 'ollama',
    startedAt: '2026-01-01T00:00:00.000Z',
    requestedModel,
    ...(modelLabel ? { modelLabel } : {})
  })

  it('brands an Ollama row from the run model label when the wire id misses every needle', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-1'),
      chat: chatWith([ollamaRun('north-mini:30b', 'North Mini Code 1.0 (30B-A3B Q4)')]),
      fallbackProvider: 'ollama',
      fallbackProviderLabel: 'Ollama'
    })
    expect(presentation.label).toBe('Cohere')
    expect(presentation.providerClass).toBe('cohere')
  })

  it('keeps the wire id authoritative when a stale label names another maker', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-1'),
      chat: chatWith([ollamaRun('deepseek-r1:8b', 'Qwen 3 (4B Param)')]),
      fallbackProvider: 'ollama',
      fallbackProviderLabel: 'Ollama'
    })
    expect(presentation.label).toBe('DeepSeek')
    expect(presentation.providerClass).toBe('deepseek')
  })

  it('falls back to the humanised id when the run carries no label', () => {
    const presentation = activityStackSpeakerPresentation({
      message: toolMessage('run-1'),
      chat: chatWith([ollamaRun('qwen3:8b')]),
      fallbackProvider: 'ollama',
      fallbackProviderLabel: 'Ollama'
    })
    expect(presentation.label).toBe('Alibaba')
    expect(presentation.providerClass).toBe('alibaba')
  })
})
