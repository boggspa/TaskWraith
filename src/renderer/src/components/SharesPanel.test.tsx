import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SharesPanelView } from './SharesPanel'

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    shareId: 'share-1',
    chatId: 'chat-1',
    mode: 'comments' as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextSequence: 1,
    participants: [
      {
        collaboratorId: 'c-1',
        displayName: 'Alex',
        publicKeyId: 'ed25519:alex',
        status: 'active' as const,
        joinedAt: 2
      }
    ],
    invites: [],
    idempotency: {},
    ...overrides
  }
}

const NOW = 1_000_000

describe('SharesPanelView', () => {
  it('shows a loading state', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView shares={[]} chatTitles={{}} loading error={null} onRevoke={() => {}} />
    )
    expect(html).toContain('Loading shares')
  })

  it('shows the empty state when there are no shares', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
      />
    )
    expect(html).toContain('No active shares')
    // The remote-access dependency note is always surfaced.
    expect(html).toContain('remote access')
  })

  it('renders a share with resolved title, mode, participant and revoke', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Design review')
    expect(html).toContain('Comments')
    expect(html).toContain('Alex')
    expect(html).toContain('Active')
    expect(html).toContain('shares-panel-dot is-active')
    expect(html).toContain('Stop sharing')
  })

  it('falls back to a generic title when the chat is unresolved', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare({ chatId: 'unknown' })]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Shared chat')
  })

  it('shows an awaiting state and counts open invites with no participants', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[
          makeShare({
            participants: [],
            invites: [
              { inviteId: 'i-1', tokenHash: 'h', createdAt: 1, expiresAt: NOW + 10_000 }
            ]
          })
        ]}
        chatTitles={{ 'chat-1': 'Spec' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Invite sent')
  })

  it('ignores consumed or expired invites in the open-invite logic', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[
          makeShare({
            participants: [],
            invites: [
              { inviteId: 'i-expired', tokenHash: 'h', createdAt: 1, expiresAt: NOW - 1 },
              { inviteId: 'i-used', tokenHash: 'h', createdAt: 1, expiresAt: NOW + 10_000, consumedAt: 5 }
            ]
          })
        ]}
        chatTitles={{ 'chat-1': 'Spec' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    // No live invites and no participants -> "no collaborators yet", not awaiting.
    expect(html).toContain('No collaborators yet')
  })

  it('excludes revoked participants from the roster', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[
          makeShare({
            participants: [
              {
                collaboratorId: 'c-1',
                displayName: 'Alex',
                publicKeyId: 'k',
                status: 'active' as const
              },
              {
                collaboratorId: 'c-2',
                displayName: 'Mallory',
                publicKeyId: 'k2',
                status: 'revoked' as const,
                revokedAt: 9
              }
            ]
          })
        ]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Alex')
    expect(html).not.toContain('Mallory')
  })
})
