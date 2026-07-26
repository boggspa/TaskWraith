import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ThreadMessageSendForm } from './ThreadMessageSendForm'
import type { ThreadMessageSendTarget } from './ThreadMessageSendFormModel'

const TARGETS: ThreadMessageSendTarget[] = [
  { chatId: 'chat-b', title: 'Byte pin fix', workspaceId: 'ws-1', crossWorkspace: false },
  { chatId: 'chat-far', title: 'Other workspace', workspaceId: 'ws-2', crossWorkspace: true }
]

function render(over: Partial<Parameters<typeof ThreadMessageSendForm>[0]> = {}) {
  return renderToStaticMarkup(
    <ThreadMessageSendForm
      fromChatId="chat-a"
      loadTargets={async () => TARGETS}
      send={async () => ({ ok: true })}
      createIdempotencyKey={() => 'key-1'}
      {...over}
    />
  )
}

describe('ThreadMessageSendForm — initial render', () => {
  // Static markup renders before the targets effect resolves, so this pins the
  // pre-load state: no target chosen, send unavailable, nothing misleading shown.
  it('starts with no target chosen and send unavailable', () => {
    const html = render()
    expect(html).toContain('Choose a thread…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Send')
  })

  it('explains why send is unavailable rather than just greying out', () => {
    expect(render()).toContain('title="There is no other thread to message."')
  })

  // Off by default, and labelled by what it does to the other thread. Defaulting it
  // on, or calling it "urgent", would make an unattended run in someone else's
  // thread the path of least resistance.
  it('offers wake unchecked and described by its effect', () => {
    const html = render()
    expect(html).toContain('Start a turn there now')
    expect(html).not.toContain('checked=""')
    expect(html).not.toMatch(/urgent/i)
  })

  it('shows no counter, warning or outcome before anything is typed', () => {
    const html = render()
    expect(html).not.toContain('characters left')
    expect(html).not.toContain('thread-message-send-warning')
    expect(html).not.toContain('thread-message-send-outcome')
  })

  it('tells the user what the recipient can and cannot see', () => {
    expect(render()).toContain('sees your title, not your context')
  })

  // Belt to the model's over-budget block: the textarea itself will not accept an
  // unbounded paste.
  it('caps the textarea length', () => {
    expect(render()).toContain('maxLength="12001"')
  })
})

describe('ThreadMessageSendForm — wiring', () => {
  // Static markup runs no effects, so target loading cannot be observed here. That
  // is worth pinning rather than working around: it means the pre-load render above
  // is the state a user actually sees first, and it must be honest on its own.
  it('loads no targets during render, because effects do not run here', () => {
    const loadTargets = vi.fn(async () => TARGETS)
    render({ loadTargets })
    expect(loadTargets).not.toHaveBeenCalled()
  })

  // A load failure must leave a usable, honest form rather than throwing during
  // render.
  it('survives a target load failure', () => {
    const html = render({
      loadTargets: async () => {
        throw new Error('main is busy')
      }
    })
    expect(html).toContain('Choose a thread…')
  })

  it('does not send anything during render', () => {
    const send = vi.fn(async () => ({ ok: true }))
    render({ send })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not mint an idempotency key until a send is attempted', () => {
    const createIdempotencyKey = vi.fn(() => 'key-1')
    render({ createIdempotencyKey })
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })
})
