import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChannelMemberIpcChannel,
  ChannelMemberIpcMember,
  ChannelMemberIpcMembershipSummary,
  ChannelMemberIpcMessage
} from '../../../shared/collaboration/ChannelMemberIpc'
import { createChannelMemberPanelInitialState } from '../lib/channelMemberPanelModel'
import { ChannelMemberPanelView, type ChannelMemberPanelViewProps } from './ChannelMemberPanel'

function channel(overrides: Partial<ChannelMemberIpcChannel> = {}): ChannelMemberIpcChannel {
  return {
    channelId: 'channel-a',
    hostChatId: 'host-chat-a',
    memberId: 'member-b',
    displayName: 'Member B',
    title: 'Design room',
    status: 'active',
    savedAt: 1_000,
    updatedAt: 1_100,
    ...overrides
  }
}

function summary(
  overrides: Partial<ChannelMemberIpcMembershipSummary> = {}
): ChannelMemberIpcMembershipSummary {
  return { ...channel(), active: true, ...overrides }
}

function member(overrides: Partial<ChannelMemberIpcMember> = {}): ChannelMemberIpcMember {
  return {
    memberId: 'member-b',
    kind: 'human',
    displayName: 'Member B',
    status: 'active',
    joinedAt: 1_000,
    ...overrides
  }
}

function message(
  sequence: number,
  overrides: Partial<ChannelMemberIpcMessage> = {}
): ChannelMemberIpcMessage {
  return {
    channelId: 'channel-a',
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: 'owner-a',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content: `Message ${sequence}`,
    acceptedAt: 1_786_262_400_000 + sequence,
    contentHash: `${sequence}`.padStart(64, '0'),
    ...overrides
  }
}

function props(overrides: Partial<ChannelMemberPanelViewProps> = {}): ChannelMemberPanelViewProps {
  return {
    panelId: 'joined-channel-panel',
    open: true,
    inviteText: '',
    displayName: 'Member B',
    draft: '',
    confirmation: null,
    state: { ...createChannelMemberPanelInitialState(), loading: false },
    onToggleOpen: () => undefined,
    onClosePanel: () => undefined,
    onInviteTextChange: () => undefined,
    onDisplayNameChange: () => undefined,
    onDraftChange: () => undefined,
    onBeginJoin: () => undefined,
    onConfirmJoin: () => undefined,
    onReconnect: () => undefined,
    onResume: () => undefined,
    onDisconnect: () => undefined,
    onAppend: () => undefined,
    onRefresh: () => undefined,
    onRequestReset: () => undefined,
    onRequestForget: () => undefined,
    onCancelConfirmation: () => undefined,
    onConfirmDestructiveAction: () => undefined,
    ...overrides
  }
}

function render(overrides: Partial<ChannelMemberPanelViewProps> = {}): string {
  return renderToStaticMarkup(<ChannelMemberPanelView {...props(overrides)} />)
}

describe('ChannelMemberPanelView', () => {
  it('keeps joined memberships behind an accessible adjacent control', () => {
    const html = render({ open: false })

    expect(html).toContain('>Joined<')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="joined-channel-panel"')
    expect(html).not.toContain('role="dialog"')
  })

  it('offers an explicit human-only invite flow without agent dispatch', () => {
    const html = render({ inviteText: '{"type":"taskwraith-channel-invite"}' })

    expect(html).toContain('Join a Channel')
    expect(html).toContain('Your human display name')
    expect(html).toContain('TaskWraith Channel invite')
    expect(html).toContain('Begin secure join')
    expect(html).toContain('never starts an agent run')
    expect(html).not.toContain('Run agent')
    expect(html).not.toContain('provider')
  })

  it('pauses admission on a visible out-of-band SAS confirmation', () => {
    const html = render({
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        phase: 'awaiting_sas',
        confirmCode: '123456'
      }
    })

    expect(html).toContain('Out-of-band verification')
    expect(html).toContain('123456')
    expect(html).toContain('same code over a separate trusted channel')
    expect(html).toContain('I verified the code — join')
    expect(html).toContain('Cancel join')
    expect(html).not.toContain('aria-label="TaskWraith Channel invite"')
  })

  it('lists multiple saved memberships with current and revoked state', () => {
    const html = render({
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        memberships: [
          summary(),
          summary({
            channelId: 'channel-revoked',
            title: 'Old room',
            status: 'revoked',
            active: false
          })
        ],
        phase: 'disconnected',
        channel: channel()
      }
    })

    expect(html).toContain('2 saved Channel memberships')
    expect(html).toContain('Design room')
    expect(html).toContain('Member B · Current')
    expect(html).toContain('Old room')
    expect(html).toContain('Member B · Revoked')
    expect(html).toContain('Forget Design room Channel membership')
    expect(html).toContain('Forget Old room Channel membership')
    expect(html).not.toContain('Open &amp; reconnect')
  })

  it('keeps verified history and attribution readable while offline', () => {
    const html = render({
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        memberships: [summary()],
        phase: 'disconnected',
        connected: false,
        channel: channel(),
        members: [
          member({ memberId: 'owner-a', displayName: 'Host' }),
          member({ memberId: 'member-b', displayName: 'Member B' })
        ],
        records: [message(1, { content: 'Durable offline message' })],
        highWaterSequence: 1
      }
    })

    expect(html).toContain('Offline')
    expect(html).toContain('verified durable history stays readable')
    expect(html).toContain('Host')
    expect(html).toContain('Member B (you)')
    expect(html).toContain('Durable offline message')
    expect(html).toContain('Reconnect')
    expect(html).not.toContain('aria-label="Joined Channel message"')
  })

  it('renders connected human posting, catch-up, and disconnect controls', () => {
    const html = render({
      draft: 'A human reply',
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        memberships: [summary()],
        phase: 'connected',
        connected: true,
        channel: channel(),
        members: [member({ memberId: 'owner-a', displayName: 'Host' }), member()],
        records: [
          message(1, { content: 'Host update' }),
          message(2, {
            authorMemberId: 'member-b',
            content: 'Member reply',
            clientMessageId: 'member:reply'
          })
        ],
        highWaterSequence: 2
      }
    })

    expect(html).toContain('Connected')
    expect(html).toContain('Host update')
    expect(html).toContain('Member reply')
    expect(html).toContain('Catch up')
    expect(html).toContain('Disconnect')
    expect(html).toContain('aria-label="Joined Channel message"')
    expect(html).toContain('Post')
  })

  it('fails revoked and recovery-blocked memberships closed while retaining history', () => {
    const revokedHtml = render({
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        memberships: [summary({ status: 'revoked' })],
        phase: 'revoked',
        connected: false,
        channel: channel({ status: 'revoked' }),
        members: [member()],
        records: [message(1, { content: 'Retained after revoke' })],
        highWaterSequence: 1
      }
    })
    expect(revokedHtml).toContain('Revoked')
    expect(revokedHtml).toContain('Retained after revoke')
    expect(revokedHtml).toContain('Saved history remains read-only')
    expect(revokedHtml).not.toContain('aria-label="Joined Channel message"')

    const blockedHtml = render({
      state: {
        ...createChannelMemberPanelInitialState(),
        loading: false,
        memberships: [summary()],
        phase: 'recovery_blocked',
        connected: false,
        channel: channel(),
        error: 'This Mac’s Channel history needs local repair before it can reconnect.'
      }
    })
    expect(blockedHtml).toContain('Repair needed')
    expect(blockedHtml).toContain('Repair local history…')
    expect(blockedHtml).not.toContain('aria-label="Joined Channel message"')
  })

  it('requires a second explicit action for local repair and forget', () => {
    const repair = render({
      confirmation: { kind: 'reset', channelId: 'channel-a', title: 'Design room' }
    })
    expect(repair).toContain('Repair Design room on this Mac?')
    expect(repair).toContain('Membership, identity, and host pin stay intact')
    expect(repair).toContain('Repair local history')
    expect(repair).toContain('Cancel')

    const forget = render({
      confirmation: { kind: 'forget', channelId: 'channel-a', title: 'Design room' }
    })
    expect(forget).toContain('Forget Design room on this Mac?')
    expect(forget).toContain('does not revoke the member on the host')
    expect(forget).toContain('Forget membership')
  })
})
