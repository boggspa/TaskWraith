import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { formatAssistantMessageLabel } from './assistantMessageLabel'

const assistant = (metadata?: ChatMessage['metadata']): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: 'Hello',
  timestamp: '2026-06-08T10:00:00.000Z',
  ...(metadata ? { metadata } : {})
})

describe('formatAssistantMessageLabel', () => {
  it('uses the Alibaba brand as the solo Ollama assistant sender label for Qwen', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'qwen3:4b-instruct' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Alibaba',
      provider: 'ollama',
      providerClass: 'alibaba',
      modelBadge: 'Qwen 3 (4B Param)'
    })
  })

  it('uses the Alibaba brand and Qwen 3.5 badge for the 9B Ollama model', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'qwen3.5:9b' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Alibaba',
      provider: 'ollama',
      providerClass: 'alibaba',
      modelBadge: 'Qwen 3.5 (9B Param)'
    })
  })

  it('uses the Google brand for Gemma through Ollama', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'gemma4:12b' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Google',
      provider: 'ollama',
      providerClass: 'google',
      modelBadge: 'Gemma 4 (12B Param)'
    })
  })

  it('uses the OpenAI brand for GPT OSS through Ollama', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'gpt-oss' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'OpenAI',
      provider: 'ollama',
      providerClass: 'openai',
      modelBadge: 'GPT OSS (20B Param)'
    })
  })

  it('uses the Deep Reinforce brand for Ornith through Ollama', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'ornith:35b' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Deep Reinforce',
      provider: 'ollama',
      providerClass: 'deep-reinforce',
      modelBadge: 'Ornith 1.0 (35B Param)'
    })
  })

  it('uses the Liquid brand for LFM through Ollama', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'lfm2.5:8b' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Liquid',
      provider: 'ollama',
      providerClass: 'liquid',
      modelBadge: 'LFM 2.5 (8B-1A)'
    })
  })

  it('keeps non-Ollama solo chats provider-labelled', () => {
    expect(formatAssistantMessageLabel(assistant(), 'Codex', 'codex')).toEqual({
      label: 'Codex',
      provider: 'codex',
      providerClass: 'codex',
      modelBadge: null
    })
  })

  it('does not apply chat-level Ollama spoofing to ensemble messages missing ensembleProvider', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'qwen3.5:9b', providerModelLabel: 'Qwen 3.5 (9B Param)' }),
        'Ollama',
        'ollama',
        { isEnsembleChat: true }
      )
    ).toEqual({
      label: 'Ollama',
      provider: 'ollama',
      providerClass: 'ollama',
      modelBadge: null
    })
  })

  it('brands ensemble Ollama participant bubbles without touching other providers', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({
          ensembleProvider: 'ollama',
          ensembleRole: 'Local',
          ensembleModel: 'qwen3.5:9b'
        }),
        'Ollama',
        'ollama',
        { isEnsembleChat: true }
      )
    ).toEqual({
      label: 'Alibaba / Local',
      provider: 'ollama',
      providerClass: 'alibaba',
      modelBadge: 'Qwen 3.5 (9B Param)'
    })

    expect(
      formatAssistantMessageLabel(
        assistant({
          ensembleProvider: 'codex',
          ensembleRole: 'Builder',
          ensembleModel: 'gpt-5.5-codex'
        }),
        'Ollama',
        'ollama',
        { isEnsembleChat: true }
      )
    ).toEqual({
      label: 'Codex / Builder',
      provider: 'codex',
      providerClass: 'codex',
      modelBadge: '5.5-Codex'
    })
  })
})
