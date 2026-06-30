import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HumanCollaborationInviteComposerControl } from './HumanCollaborationInviteComposerControl'

describe('HumanCollaborationInviteComposerControl', () => {
  it('does not render for chats without an active share', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active={false} onCopyInvite={() => {}} />
    )

    expect(html).toBe('')
  })

  it('renders a fresh invite action for active shared chats', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active onCopyInvite={() => {}} />
    )

    expect(html).toContain('New invite')
    expect(html).toContain('Create and copy a fresh People invite')
    expect(html).toContain('composer-human-invite-button')
  })

  it('can be disabled with the composer lock state', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active disabled onCopyInvite={() => {}} />
    )

    expect(html).toContain('disabled=""')
  })
})
