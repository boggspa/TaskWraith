import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { ContextCompactionCard } from './ContextCompactionCard'

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'context-compaction-ca77fa3c',
    role: 'system',
    content: 'Context compacted · 24k → 1k tokens · manual · Claude',
    timestamp: '2026-07-02T04:00:00.000Z',
    metadata: {
      kind: 'contextCompaction',
      provider: 'claude',
      contextCompaction: {
        kind: 'completed',
        telemetry: {
          provider: 'claude',
          trigger: 'manual',
          preTokens: 24012,
          postTokens: 1330,
          durationMs: 11652,
          eventUuid: 'ca77fa3c-1d96-46d3-b728-eeef779c57b6'
        }
      }
    },
    ...overrides
  } as ChatMessage
}

describe('ContextCompactionCard', () => {
  it('renders a completed compaction with pre→post occupancy and trigger', () => {
    const html = renderToStaticMarkup(<ContextCompactionCard message={makeMessage()} />)
    expect(html).toContain('context-compaction-card')
    expect(html).toContain('is-completed')
    expect(html).toContain('Context compacted')
    expect(html).toContain('24k → 1k tokens')
    expect(html).toContain('manual')
    expect(html).toContain('12s')
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-claude')
  })

  it('renders a failed compaction with the provider error inline', () => {
    const html = renderToStaticMarkup(
      <ContextCompactionCard
        message={makeMessage({
          metadata: {
            kind: 'contextCompaction',
            provider: 'claude',
            contextCompaction: {
              kind: 'failed',
              telemetry: { provider: 'claude', error: 'Not enough messages to compact.' }
            }
          }
        })}
      />
    )
    expect(html).toContain('is-failed')
    expect(html).toContain('Context compaction failed')
    expect(html).toContain('Not enough messages to compact.')
  })

  it('prefers the frozen participant label over the live provider name', () => {
    const html = renderToStaticMarkup(
      <ContextCompactionCard
        message={makeMessage({
          metadata: {
            kind: 'contextCompaction',
            provider: 'codex',
            displayParticipantLabel: 'Codex / Worker',
            contextCompaction: {
              kind: 'completed',
              telemetry: {
                provider: 'codex',
                trigger: 'auto',
                preTokens: 850000,
                postTokens: 96000
              }
            }
          }
        })}
      />
    )
    expect(html).toContain('Codex / Worker')
    expect(html).toContain('automatic')
  })

  it('returns null for non-compaction messages', () => {
    const html = renderToStaticMarkup(
      <ContextCompactionCard message={makeMessage({ metadata: { kind: 'providerRunFailure' } })} />
    )
    expect(html).toBe('')
  })
})
