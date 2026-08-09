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

  it('groups share actions separately from editable sharing controls', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Design review' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        onCopyInvite={() => {}}
        onChangeRules={() => {}}
        onChangeHostReview={() => {}}
        now={NOW}
      />
    )
    const actionsStart = html.indexOf('shares-panel-card-actions')
    expect(actionsStart).toBeGreaterThan(html.indexOf('shares-panel-host-review'))
    expect(html.slice(actionsStart)).toContain('Copy invite')
    expect(html.slice(actionsStart)).toContain('Stop sharing')
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
    expect(html).toContain('People chat')
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

  it('hides the activity log entirely when the bridge does not expose one', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
      />
    )
    expect(html).not.toContain('Activity log')
  })

  it('renders a rejected contribution with its reason, not just that it happened', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
        auditEvents={[
          {
            id: 'a-1',
            at: NOW - 30_000,
            kind: 'contribution.rejected',
            code: 'quota_exceeded',
            detail: 'Alex'
          },
          {
            id: 'a-2',
            at: NOW - 5_000,
            kind: 'admission.sas_confirmed'
          }
        ] as never}
        now={NOW}
      />
    )
    expect(html).toContain('Activity log')
    // The denial code must be translated — 'quota_exceeded' alone is jargon.
    expect(html).toContain('Contribution rejected')
    expect(html).toContain('rate limit — too many, too fast')
    expect(html).toContain('30s ago')
    expect(html).toContain('Security code confirmed')
    // Failures are tinted so they survive a scan of a long log.
    expect(html).toContain('is-problem')
  })

  it('surfaces an activity-log load failure instead of implying no activity', () => {
    const html = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare() as never]}
        chatTitles={{}}
        loading={false}
        error={null}
        onRevoke={() => {}}
        auditEvents={[]}
        auditError="Could not load the activity log."
        now={NOW}
      />
    )
    expect(html).toContain('Could not load the activity log.')
    expect(html).not.toContain('No collaboration activity yet.')
  })
})

describe('the full-history opt-in', () => {
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare()]}
        chatTitles={{ 'chat-1': 'Shared thread' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        now={NOW}
        {...props}
      />
    )

  it('states in full what turning it on hands over', () => {
    // The sentence IS the consent. A shortened label ("Full history", "Share
    // everything") would make a retroactive disclosure decision read as a
    // display preference, so the wording is pinned, not just the control.
    const html = render({ onChangeFullHistory: () => {} })
    expect(html).toContain('Share the full history of this thread, including messages')
    expect(html).toContain('from before you invited anyone')
  })

  it('is absent, not merely disabled, when the host cannot set it', () => {
    // No handler means no affordance at all — a dead checkbox on a consent
    // control is worse than none, because it looks like a setting that failed.
    expect(render()).not.toContain('from before you invited anyone')
  })

  it('reflects the share it is given, in both states', () => {
    const off = render({ onChangeFullHistory: () => {} })
    expect(off).not.toContain('checked=""')
    const on = renderToStaticMarkup(
      <SharesPanelView
        shares={[makeShare({ fullHistory: true })]}
        chatTitles={{ 'chat-1': 'Shared thread' }}
        loading={false}
        error={null}
        onRevoke={() => {}}
        onChangeFullHistory={() => {}}
        now={NOW}
      />
    )
    expect(on).toContain('checked=""')
  })
})
