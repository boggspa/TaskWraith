import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
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
      formatAssistantMessageLabel(assistant({ providerModel: 'qwen3.5:9b' }), 'Ollama', 'ollama')
    ).toEqual({
      label: 'Alibaba',
      provider: 'ollama',
      providerClass: 'alibaba',
      modelBadge: 'Qwen 3.5 (9B Param)'
    })
  })

  it('uses the Google brand for Gemma through Ollama', () => {
    expect(
      formatAssistantMessageLabel(assistant({ providerModel: 'gemma4:12b' }), 'Ollama', 'ollama')
    ).toEqual({
      label: 'Google',
      provider: 'ollama',
      providerClass: 'google',
      modelBadge: 'Gemma 4 (12B Param)'
    })
  })

  it('uses the OpenAI brand for GPT OSS through Ollama', () => {
    expect(
      formatAssistantMessageLabel(assistant({ providerModel: 'gpt-oss' }), 'Ollama', 'ollama')
    ).toEqual({
      label: 'OpenAI',
      provider: 'ollama',
      providerClass: 'openai',
      modelBadge: 'GPT OSS (20B Param)'
    })
  })

  it('uses the Deep Reinforce brand for Ornith through Ollama', () => {
    expect(
      formatAssistantMessageLabel(assistant({ providerModel: 'ornith:35b' }), 'Ollama', 'ollama')
    ).toEqual({
      label: 'Deep Reinforce',
      provider: 'ollama',
      providerClass: 'deep-reinforce',
      modelBadge: 'Ornith 1.0 (35B Param)'
    })
  })

  it('uses the Liquid brand for LFM through Ollama', () => {
    expect(
      formatAssistantMessageLabel(assistant({ providerModel: 'lfm2.5:8b' }), 'Ollama', 'ollama')
    ).toEqual({
      label: 'Liquid',
      provider: 'ollama',
      providerClass: 'liquid',
      modelBadge: 'LFM 2.5 (8B-A1B)'
    })
  })

  it('uses the Poolside brand for Laguna through Ollama', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({ providerModel: 'laguna-xs-2.1:q8_0' }),
        'Ollama',
        'ollama'
      )
    ).toEqual({
      label: 'Poolside',
      provider: 'ollama',
      providerClass: 'poolside',
      modelBadge: 'Laguna XS 2.1 (33B-A3B Q8)'
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

  it('adds the run model badge for non-Ollama solo chats when available', () => {
    expect(
      formatAssistantMessageLabel(assistant(), 'Codex', 'codex', {
        soloModelId: 'gpt-5.5'
      })
    ).toEqual({
      label: 'Codex',
      provider: 'codex',
      providerClass: 'codex',
      modelBadge: '5.5'
    })
  })

  it('uses every Pi upstream hue for solo transcript attribution', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const modelId = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(modelId, `missing representative Pi model for ${upstream}`).toBeTruthy()
      expect(
        formatAssistantMessageLabel(assistant({ providerModel: modelId }), 'Pi', 'pi')
      ).toMatchObject({
        provider: 'pi',
        providerClass: brand.hueClass
      })
    }
  })

  it('uses the Pi upstream hue for guest transcript attribution', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({
          kind: 'guestParticipantReply',
          guestProvider: 'pi',
          guestRole: 'Scout',
          guestModel: 'qwen-token-plan/qwen3.7-max'
        }),
        'Codex',
        'codex'
      )
    ).toMatchObject({
      provider: 'pi',
      providerClass: 'qwen'
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

  it('uses pooled-agent nickname and identity when present on ensemble rows', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({
          ensembleProvider: 'codex',
          ensembleRole: 'Builder',
          ensembleModel: 'gpt-5.5-codex',
          pooledAgentId: 'pooled-agent-cactus',
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: 'pooled-agent-cactus',
            nickname: 'Circuit Cactus',
            iconKind: 'asset',
            assetKey: 'pool:circuit-cactus',
            hue: 139,
            brightness: 64,
            accent: '#41F27A',
            hueEnabled: true
          }
        }),
        'Codex',
        'codex',
        { isEnsembleChat: true }
      )
    ).toEqual({
      label: 'Circuit Cactus',
      provider: 'codex',
      providerClass: 'codex',
      modelBadge: '5.5-Codex',
      agentAccent: '#41F27A',
      pooledAgentIdentity: {
        schemaVersion: 1,
        agentId: 'pooled-agent-cactus',
        nickname: 'Circuit Cactus',
        iconKind: 'asset',
        assetKey: 'pool:circuit-cactus',
        hue: 139,
        brightness: 64,
        accent: '#41F27A',
        hueEnabled: true
      }
    })
  })

  it('uses pooled-agent nickname for solo provider rows when metadata carries it', () => {
    expect(
      formatAssistantMessageLabel(
        assistant({
          pooledAgentId: 'pooled-agent-solo',
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: 'pooled-agent-solo',
            nickname: 'Socket Sorcery',
            iconKind: 'seed',
            seed: 'socket-sorcery',
            hue: 164,
            accent: '#06D6A0'
          }
        }),
        'Codex',
        'codex',
        { soloModelId: 'gpt-5.5' }
      )
    ).toMatchObject({
      label: 'Socket Sorcery',
      provider: 'codex',
      providerClass: 'codex',
      modelBadge: '5.5',
      agentAccent: '#06D6A0'
    })
  })
})
