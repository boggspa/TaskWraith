import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import { ReviewCard } from './ReviewCard'

function reviewActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'rev_1',
    toolName: 'codex_review',
    displayName: 'Codex review',
    category: 'task',
    status: 'running',
    ...overrides
  }
}

describe('ReviewCard', () => {
  it('renders a running review with target/model and codex identity', () => {
    const html = renderToStaticMarkup(
      <ReviewCard
        activity={reviewActivity({
          reviewSummary: {
            provider: 'codex',
            status: 'running',
            target: 'uncommitted changes',
            model: 'gpt-x'
          }
        })}
      />
    )
    expect(html).toContain('Codex Review')
    expect(html).toContain('Reviewing')
    expect(html).toContain('uncommitted changes')
    expect(html).toContain('gpt-x')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('agent-identity-icon')
    expect(html).toContain('var(--provider-codex-color')
    expect(html).toContain('status-running')
  })

  it('renders a completed review with duration + tokens', () => {
    const html = renderToStaticMarkup(
      <ReviewCard
        activity={reviewActivity({
          status: 'success',
          reviewSummary: {
            provider: 'codex',
            status: 'completed',
            target: 'uncommitted changes',
            durationMs: 42000,
            totalTokens: 9000
          }
        })}
      />
    )
    expect(html).toContain('Reviewed')
    expect(html).toContain('42s')
    expect(html).toContain('9.0k tokens')
    expect(html).toContain('status-completed')
  })

  it('never fabricates a findings/severity count', () => {
    const html = renderToStaticMarkup(
      <ReviewCard
        activity={reviewActivity({ reviewSummary: { provider: 'codex', status: 'completed' } })}
      />
    )
    expect(html.toLowerCase()).not.toContain('finding')
    expect(html.toLowerCase()).not.toContain('severity')
    expect(html.toLowerCase()).not.toContain('critical')
  })

  it('surfaces an error when the review failed', () => {
    const html = renderToStaticMarkup(
      <ReviewCard
        activity={reviewActivity({
          reviewSummary: { provider: 'codex', status: 'failed', error: 'review timed out' }
        })}
      />
    )
    expect(html).toContain('Failed')
    expect(html).toContain('status-failed')
  })
})
