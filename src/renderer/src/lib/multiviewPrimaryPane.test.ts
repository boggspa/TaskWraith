import { describe, expect, it } from 'vitest'
import { resolvePrimaryPaneIndex } from './multiviewPrimaryPane'

const panes = [
  { id: 'pane-primary', chatId: 'chat-primary' },
  { id: 'pane-empty', chatId: null },
  { id: 'pane-secondary', chatId: 'chat-secondary' }
]

describe('resolvePrimaryPaneIndex', () => {
  it('targets the main chat even when another pane owns focus', () => {
    expect(resolvePrimaryPaneIndex(panes, 'chat-primary')).toBe(0)
  })

  it('follows the main chat when it is in a later pane', () => {
    expect(resolvePrimaryPaneIndex(panes, 'chat-secondary')).toBe(2)
  })

  it('fails closed when the primary chat is absent', () => {
    expect(resolvePrimaryPaneIndex(panes, null)).toBeNull()
    expect(resolvePrimaryPaneIndex(panes, 'missing-chat')).toBeNull()
  })
})
