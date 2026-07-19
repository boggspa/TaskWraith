import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NeedsInputBannerCard,
  needsInputOpenAriaLabel,
  type NeedsInputBannerEntry
} from './NeedsInputBanner'

function makeEntry(overrides: Partial<NeedsInputBannerEntry> = {}): NeedsInputBannerEntry {
  return {
    questionId: 'q-1',
    appChatId: 'chat-1',
    chatTitle: 'Refactor auth',
    provider: 'codex',
    question: 'Ship the migration tonight?',
    options: ['Ship it', 'Wait'],
    context: 'Tests are green.',
    askedAt: 1,
    ...overrides
  }
}

describe('NeedsInputBanner', () => {
  it('builds an open-thread aria label from the chat title', () => {
    expect(needsInputOpenAriaLabel('Refactor auth')).toBe('Open thread: Refactor auth')
    expect(needsInputOpenAriaLabel('  ')).toBe('Open thread')
    expect(needsInputOpenAriaLabel(undefined)).toBe('Open thread')
  })

  it('renders the question, provider, and option buttons', () => {
    const html = renderToStaticMarkup(
      <NeedsInputBannerCard
        entry={makeEntry()}
        onOpen={() => {}}
        onAnswer={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('Needs your input')
    expect(html).toContain('Codex in Refactor auth')
    expect(html).toContain('Ship the migration tonight?')
    expect(html).toContain('Tests are green.')
    expect(html).toContain('Ship it')
    expect(html).toContain('Wait')
    expect(html).toContain('Open')
  })

  it('omits inline options when no answer handler is provided', () => {
    const html = renderToStaticMarkup(
      <NeedsInputBannerCard entry={makeEntry()} onOpen={() => {}} onDismiss={() => {}} />
    )
    expect(html).not.toContain('Answer choices')
    expect(html).toContain('Open')
  })

  it('falls back to Agent / A thread labels when metadata is missing', () => {
    const html = renderToStaticMarkup(
      <NeedsInputBannerCard
        entry={makeEntry({ provider: null, chatTitle: undefined, options: undefined })}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(html).toContain('Agent in A thread')
  })
})
