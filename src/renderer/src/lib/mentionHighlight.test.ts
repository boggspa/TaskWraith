import { describe, expect, it } from 'vitest'
import { tokeniseMentions } from './mentionHighlight'
import type { EnsembleParticipant } from '../../../main/store/types'

const participant = (overrides: Partial<EnsembleParticipant>): EnsembleParticipant => ({
  id: overrides.id || 'p1',
  provider: overrides.provider || 'claude',
  enabled: overrides.enabled ?? true,
  role: overrides.role ?? '',
  instructions: overrides.instructions ?? '',
  order: overrides.order ?? 0,
  model: overrides.model
})

describe('tokeniseMentions provider hue class', () => {
  it('tags non-Ollama participant mentions with the runtime provider class', () => {
    const participants = [participant({ id: 'a', provider: 'claude', role: 'Reviewer' })]
    const segments = tokeniseMentions('hey @Reviewer take a look', participants)
    const mention = segments.find((s) => s.kind === 'mention')
    expect(mention).toMatchObject({ provider: 'claude', providerClass: 'claude' })
  })

  it('resolves Ollama display-brand participants to the spoofed brand hue class', () => {
    const participants = [
      participant({ id: 'b', provider: 'ollama', role: 'Planner', model: 'qwen3.5:9b' })
    ]
    const segments = tokeniseMentions('ok @Planner go ahead', participants)
    const mention = segments.find((s) => s.kind === 'mention')
    // Runtime provider stays `ollama`, but the hue class spoofs Alibaba.
    expect(mention).toMatchObject({ provider: 'ollama', providerClass: 'alibaba' })
  })

  it('keeps unbranded Ollama participants on the generic ollama hue class', () => {
    const participants = [
      participant({ id: 'c', provider: 'ollama', role: 'Helper', model: 'mystery-local' })
    ]
    const segments = tokeniseMentions('@Helper please', participants)
    const mention = segments.find((s) => s.kind === 'mention')
    expect(mention).toMatchObject({ provider: 'ollama', providerClass: 'ollama' })
  })
})
