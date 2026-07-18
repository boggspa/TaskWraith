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

  it('renders the steer menu trigger for blackboard-capable ensemble rows and the plain button for solo rows', () => {
    const html = renderToStaticMarkup(
      <QueuedMessagesAboveRow
        chat={null}
        entries={[
          {
            id: 'ensemble-queued-round-1-0',
            provider: 'codex',
            providerDisplayLabel: 'Ensemble',
            prompt: 'Check the auth flow.',
            canAddToBlackboard: true
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
        onAddToBlackboard={noop}
        onReorder={noop}
      />
    )
    // Ensemble row: menu trigger (closed by default — no portal content in
    // static markup, so the menu items themselves must NOT appear).
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('Open steer menu for Ensemble queued message 1')
    expect(html).not.toContain('Add to Blackboard')
    // Solo row: the plain immediate-steer button.
    expect(html).toContain('Steer Codex queued message 2 from the queue now')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
  })
})
