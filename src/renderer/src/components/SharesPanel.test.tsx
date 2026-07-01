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
      <SharesPanelView
        shares={[]}
        chatTitles={{}}
        loading
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
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
        now={NOW}
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

  it('renders a copy invite control when a handler is supplied', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        onCopyInvite={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('shares-panel-copy-invite')
    expect(html).toContain('Copy invite')
    expect(html).toContain('aria-label="Copy a fresh invite for Design review"')
  })

  it('marks a share as live when its chat has a connected collaborator session', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        connectedChatIds={new Set(['chat-1'])}
        now={NOW}
      />
    )
    expect(html).toContain('Comments · Live')
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

  it('renders a per-participant Remove control when a handler is supplied', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        onRevokeParticipant={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('shares-panel-participant-remove')
    expect(html).toContain('Remove')
  })

  it('omits the per-participant Remove control without a handler', () => {
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
    expect(html).not.toContain('shares-panel-participant-remove')
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

/*
 * P2a — contribution-rules preset picker + host-reviewed labels.
 */
describe('SharesPanelView contribution rules (P2a)', () => {
  it('labels a share from its rules preset and renders the preset picker', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[
          makeShare({
            contributionRules: {
              schemaVersion: 1,
              preset: 'requestHostAction',
              viewProjection: true,
              appendComment: true,
              requestHostAction: true,
              createHostDraft: 'host-click',
              providerDispatch: 'never',
              maxContributionBytes: 8000,
              rateLimitProfile: 'comments-v1',
              auditLevel: 'summary'
            }
          }) as never
        ]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        onChangeRules={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Host actions')
    expect(html).toContain('Comments — host-reviewed before AI')
    expect(html).toContain('Auto-draft — you still send')
    expect(html).toContain('shares-panel-rules-select')
  })

  it('keeps the legacy Comments label for shares without persisted rules', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Comments')
    // No picker unless the container wires onChangeRules.
    expect(html).not.toContain('shares-panel-rules-select')
  })

  it('mentions that contributions are host-reviewed before the AI', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('host-reviewed')
  })
})

/*
 * P2a presence clarity — invite issued / participant active / live / offline
 * are distinct states (spec §6).
 */
describe('SharesPanelView presence states (P2a)', () => {
  it('shows Offline for an active participant with no live session', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        liveSessionKeys={new Set<string>()}
        now={NOW}
      />
    )
    expect(html).toContain('Comments · Offline')
    expect(html).toContain('is-offline')
  })

  it('marks the specific collaborator Live when their session is connected', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        connectedChatIds={new Set(['chat-1'])}
        liveSessionKeys={new Set(['share-1:c-1'])}
        now={NOW}
      />
    )
    expect(html).toContain('Comments · Live')
    expect(html).toContain('is-live')
  })

  it('labels an unconsumed invite with no participants as Invite issued', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[
          makeShare({
            participants: [],
            invites: [
              { inviteId: 'i-1', tokenHash: 'h', createdAt: 1, expiresAt: NOW + 60_000 }
            ]
          }) as never
        ]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).toContain('Invite issued')
    expect(html).toContain('Invite sent — awaiting collaborator')
  })
})
