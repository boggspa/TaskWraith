import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { ParticipantHealthCard } from './ParticipantHealthCard'

function healthMessage(): ChatMessage {
  return {
    id: 'participant-health-1',
    role: 'system',
    content: 'Participant health',
    timestamp: '2026-07-18T00:00:00.000Z',
    metadata: {
      kind: 'ensembleParticipantHealth',
      okCount: 1,
      totalCount: 1,
      entries: [
        {
          participantId: 'reviewer',
          provider: 'claude',
          role: 'Reviewer',
          status: 'ok'
        }
      ]
    }
  } as ChatMessage
}

describe('ParticipantHealthCard', () => {
  it('uses the official provider mark beside the provider and role label', () => {
    const html = renderToStaticMarkup(<ParticipantHealthCard message={healthMessage()} />)

    expect(html).toContain('Claude / Reviewer')
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-claude')
  })

  it('returns no card for another system message kind', () => {
    const message = healthMessage()
    message.metadata = { kind: 'providerRunFailure' }

    expect(renderToStaticMarkup(<ParticipantHealthCard message={message} />)).toBe('')
  })

  it('repairs legacy frozen Pi seat presentation from the stamped model', () => {
    const message = healthMessage()
    message.metadata = {
      kind: 'ensembleParticipantHealth',
      okCount: 1,
      totalCount: 1,
      entries: [
        {
          participantId: 'deepseek-reviewer',
          provider: 'pi',
          model: 'deepseek/deepseek-v4-pro',
          displayProviderLabel: 'Pi',
          displayHueClass: 'pi',
          role: 'Reviewer',
          status: 'ok'
        }
      ]
    }

    const html = renderToStaticMarkup(<ParticipantHealthCard message={message} />)
    expect(html).toContain('participant-health-chip provider-deepseek')
    expect(html).toContain('DeepSeek / Reviewer')
  })
})
