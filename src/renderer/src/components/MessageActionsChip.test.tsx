import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageActionsChip } from './MessageActionsChip'

describe('MessageActionsChip', () => {
  it('renders thumbs feedback buttons before the rest of the transcript actions', () => {
    const html = renderToStaticMarkup(
      <MessageActionsChip
        onCopy={() => {}}
        onTogglePin={() => {}}
        onThumbsUp={() => {}}
        onThumbsDown={() => {}}
        onOpenSideChat={() => {}}
        onDelete={() => {}}
        label="assistant message"
      />
    )

    const thumbsUp = html.indexOf('message-actions-chip-button--thumbs-up')
    const thumbsDown = html.indexOf('message-actions-chip-button--thumbs-down')
    const copy = html.indexOf('message-actions-chip-button--copy')
    const pin = html.indexOf('message-actions-chip-button--pin')

    expect(thumbsUp).toBeGreaterThan(-1)
    expect(thumbsDown).toBeGreaterThan(-1)
    expect(copy).toBeGreaterThan(-1)
    expect(pin).toBeGreaterThan(-1)
    expect(thumbsUp).toBeLessThan(copy)
    expect(thumbsDown).toBeLessThan(copy)
    expect(thumbsUp).toBeLessThan(pin)
    expect(thumbsDown).toBeLessThan(pin)
    expect(thumbsUp).toBeLessThan(thumbsDown)
  })
})
