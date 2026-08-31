import { describe, expect, it } from 'vitest'
import { hasResolvedMention, tokeniseMentions } from './mentionHighlight'
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

  it('renders a picker-selected participant as a plain tag while preserving its exact identity', () => {
    const participants = [
      participant({ id: 'claude-reviewer', provider: 'claude', role: 'Reviewer' }),
      participant({ id: 'codex-reviewer', provider: 'codex', role: 'Reviewer' })
    ]
    const value = 'Ask [@Reviewer](ensemble-dm://codex-reviewer) to take this.'
    const segments = tokeniseMentions(value, participants)
    const mention = segments.find((segment) => segment.kind === 'mention')

    expect(segments.map((segment) => segment.text).join('')).toBe('Ask @Reviewer to take this.')
    expect(mention).toMatchObject({ participant: { id: 'codex-reviewer' }, text: '@Reviewer' })
    expect(hasResolvedMention(value, participants)).toBe(true)
  })
})

describe('tokeniseMentions roster groups', () => {
  it('emits provider-neutral group segments without requiring a roster', () => {
    const segments = tokeniseMentions(
      '@All ask @Captains and @Management, then @Reviewers and @BG.',
      []
    )

    expect(segments.filter((segment) => segment.kind === 'group-mention')).toEqual([
      {
        kind: 'group-mention',
        text: '@All',
        group: 'all',
        sourceLength: '@All'.length
      },
      {
        kind: 'group-mention',
        text: '@Captains',
        group: 'captains',
        sourceLength: '@Captains'.length
      },
      {
        kind: 'group-mention',
        text: '@Management',
        group: 'management',
        sourceLength: '@Management'.length
      },
      {
        kind: 'group-mention',
        text: '@Reviewers',
        group: 'reviewers',
        sourceLength: '@Reviewers'.length
      },
      {
        kind: 'group-mention',
        text: '@BG',
        group: 'backgrounds',
        sourceLength: '@BG'.length
      }
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(
      '@All ask @Captains and @Management, then @Reviewers and @BG.'
    )
    expect(hasResolvedMention('@Scouts inspect this', [])).toBe(true)
  })
})
