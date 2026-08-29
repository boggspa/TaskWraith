import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  ContextCompactionCard,
  contextCompactionMessageFailed,
  contextCompactionMessageMetaLabel
} from './ContextCompactionCard'

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
  it('renders a completed compaction as a tool-call-style row (no banner card)', () => {
    const html = renderToStaticMarkup(<ContextCompactionCard message={makeMessage()} />)
    expect(html).toContain('context-compaction-row')
    expect(html).not.toContain('context-compaction-card')
    expect(html).toContain('is-completed')
    expect(html).toContain('Compacted context')
    expect(html).toContain('24k → 1k tokens')
    expect(html).toContain('manual')
    expect(html).toContain('12s')
    // Speaker meta rides the line as text (provider-tinted via row class),
    // not as a logo pill — the row must read as transcript, not chrome.
    expect(html).toContain('provider-claude')
    expect(html).toContain('context-compaction-row-meta')
    expect(html).not.toContain('provider-brand-logo-image')
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
    const message = makeMessage({
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
    })
    const html = renderToStaticMarkup(<ContextCompactionCard message={message} />)
    expect(html).toContain('Codex / Worker')
    expect(html).toContain('automatic')
    expect(contextCompactionMessageMetaLabel(message)).toBe('Codex / Worker')
  })

  it('uses the frozen Pi upstream hue for the transcript row', () => {
    const message = makeMessage({
      metadata: {
        kind: 'contextCompaction',
        provider: 'pi',
        displayParticipantLabel: 'DeepSeek / Worker',
        displayHueClass: 'deepseek',
        contextCompaction: {
          kind: 'completed',
          telemetry: {
            provider: 'pi',
            trigger: 'auto',
            preTokens: 120000,
            postTokens: 16000
          }
        }
      }
    })

    const html = renderToStaticMarkup(<ContextCompactionCard message={message} />)
    expect(html).toContain('provider-deepseek')
    expect(html).toContain('DeepSeek / Worker')
    expect(html).not.toContain('provider-pi')
  })

  it('exposes the failed bit and frozen meta label to transcript consumers', () => {
    const failed = makeMessage({
      metadata: {
        kind: 'contextCompaction',
        provider: 'claude',
        contextCompaction: { kind: 'failed', telemetry: { provider: 'claude' } }
      }
    })
    expect(contextCompactionMessageFailed(failed)).toBe(true)
    expect(contextCompactionMessageFailed(makeMessage())).toBe(false)
    expect(contextCompactionMessageMetaLabel(makeMessage())).toBe('Claude')
  })

  it('returns null for non-compaction messages', () => {
    const html = renderToStaticMarkup(
      <ContextCompactionCard message={makeMessage({ metadata: { kind: 'providerRunFailure' } })} />
    )
    expect(html).toBe('')
  })
})
