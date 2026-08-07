import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueuedMessagesAboveRow, queuedMessageEntryProviderLabel } from './QueuedMessagesAboveRow'

describe('QueuedMessagesAboveRow labels', () => {
  it('uses an ensemble display label instead of the seed provider for ensemble queue rows', () => {
    expect(
      queuedMessageEntryProviderLabel({
        id: 'ensemble-queued-round-1-0',
        provider: 'grok',
        providerDisplayLabel: 'Ensemble',
        prompt: 'Continue the round.'
      })
    ).toBe('Ensemble')
  })

  it('falls back to the provider label for normal queued rows', () => {
    expect(
      queuedMessageEntryProviderLabel({
        id: 'queued-1',
        provider: 'grok',
        prompt: 'Run this later.'
      })
    ).toBe('Grok')
  })
})

describe('QueuedMessagesAboveRow steer actions', () => {
  const noop = (): void => {}

  it('renders a plain immediate Steer button for ensemble and solo queue rows', () => {
    const html = renderToStaticMarkup(
      <QueuedMessagesAboveRow
        chat={null}
        entries={[
          {
            id: 'ensemble-queued-round-1-0',
            provider: 'codex',
            providerDisplayLabel: 'Ensemble',
            prompt: 'Check the auth flow.'
          },
          {
            id: 'solo-run-1',
            provider: 'codex',
            prompt: 'Run this later.'
          }
        ]}
        onEdit={noop}
        onDelete={noop}
        onSteer={noop}
        onReorder={noop}
      />
    )
    expect(html).not.toContain('aria-haspopup="menu"')
    expect(html).not.toContain('Open steer menu')
    expect(html).not.toContain('Add to Blackboard')
    expect(html).toContain('Steer Ensemble queued message 1 from the queue now')
    expect(html).toContain('Steer Codex queued message 2 from the queue now')
    // No provider brand glyph — ensemble rows were leaking the chat seed
    // provider icon (e.g. Claude next to an @GrokWork prompt).
    expect(html).not.toContain('data-provider-logo=')
    expect(html).not.toContain('provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
  })
})
