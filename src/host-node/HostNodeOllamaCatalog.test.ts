import { describe, expect, it } from 'vitest'

import type { OllamaModelInfo } from '../host-shared/ollama/OllamaDaemonClient'
import { hostNodeOllamaOffersFromCatalog } from './HostNodeOllamaCatalog'

function model(
  id: string,
  source: 'local' | 'cloud',
  options: Partial<OllamaModelInfo> = {}
): OllamaModelInfo {
  return {
    id,
    label: id === 'minimax-m3:cloud' ? 'MiniMax M3' : id,
    source,
    isCloud: source === 'cloud',
    installed: source === 'local',
    isDefault: false,
    ...options
  }
}

describe('hostNodeOllamaOffersFromCatalog', () => {
  it('projects only runnable discovered rows and preserves the proven default', () => {
    const offers = hostNodeOllamaOffersFromCatalog({
      models: [
        model('qwen3.5:9b', 'local'),
        model('minimax-m3:cloud', 'cloud', { isDefault: true, requiredPlan: 'pro' }),
        model('unproven:cloud', 'cloud', {
          disabled: true,
          disabledReason: 'Account state unavailable.'
        })
      ]
    })

    expect(offers.models).toEqual([
      expect.objectContaining({ modelId: 'qwen3.5:9b', available: true }),
      expect.objectContaining({
        modelId: 'minimax-m3:cloud',
        label: 'MiniMax M3',
        available: true,
        default: true,
        detail: 'Ollama Cloud · pro plan'
      })
    ])
    expect(offers.models.map((entry) => entry.modelId)).not.toContain('unproven:cloud')
  })

  it('keeps a local default when no proven Cloud model is present', () => {
    const offers = hostNodeOllamaOffersFromCatalog({
      models: [model('qwen3.5:9b', 'local', { isDefault: true })]
    })

    expect(offers.models).toEqual([
      expect.objectContaining({ modelId: 'qwen3.5:9b', default: true })
    ])
    expect(offers.offerRevision).toMatch(/^[a-f0-9]{64}$/)
  })
})
