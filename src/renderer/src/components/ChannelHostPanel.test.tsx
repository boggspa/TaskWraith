import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChannelIpcChannel,
  ChannelIpcMember,
  ChannelIpcMessage
} from '../../../shared/collaboration/ChannelIpc'
import { ChannelHostPanelView, type ChannelHostPanelViewProps } from './ChannelHostPanel'

const panelSource = readFileSync(new URL('./ChannelHostPanel.tsx', import.meta.url), 'utf8')

function channel(overrides: Partial<ChannelIpcChannel> = {}): ChannelIpcChannel {
  return {
    channelId: 'channel-1',
    chatId: 'chat-1',
    ownerMemberId: 'member-host',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    membershipRevision: 2,
    messageCount: 2,
    reference: { kind: 'chat', id: 'chat-1' },
    display: { title: 'Design room', status: 'active', memberCount: 2, messageCount: 2 },
    availability: 'ready',
    ...overrides
  }
}

function member(overrides: Partial<ChannelIpcMember> = {}): ChannelIpcMember {
  return {
    memberId: 'member-host',
    channelId: 'channel-1',
    kind: 'human',
    displayName: 'Chris',
    status: 'active',
    joinedAt: 1,
    ...overrides
  }
}

function message(overrides: Partial<ChannelIpcMessage> = {}): ChannelIpcMessage {
  return {
    channelId: 'channel-1',
    sequence: 1,
    messageId: 'message-1',
    authorMemberId: 'member-host',
    clientMessageId: 'client-1',
    kind: 'human.text',
    content: 'Welcome to the Channel.',
    acceptedAt: 1_786_262_400_000,
    contentHash: 'a'.repeat(64),
    ...overrides
  }
}

function props(overrides: Partial<ChannelHostPanelViewProps> = {}): ChannelHostPanelViewProps {
  return {
    chatTitle: 'Design room',
    panelId: 'channel-panel',
    open: true,
    ownerDisplayName: 'Host',
    draft: '',
    closeConfirmation: false,
    state: {
      loading: false,
      busy: null,
      channel: null,
      members: [],
      pendingAdmissions: [],
      humanReviews: [],
      records: [],
      highWaterSequence: 0,
      invite: null,
      notice: null,
      error: null
    },
    onToggleOpen: () => undefined,
    onClosePanel: () => undefined,
    onOwnerDisplayNameChange: () => undefined,
    onDraftChange: () => undefined,
    onCreate: () => undefined,
    onIssueInvite: () => undefined,
    onCopyInvite: () => undefined,
    onClearInvite: () => undefined,
    onAppend: () => undefined,
    onLoadMore: () => undefined,
    onRevokeMember: () => undefined,
    onApproveHumanReview: () => undefined,
    onDenyHumanReview: () => undefined,
    onRetry: () => undefined,
    onRequestClose: () => undefined,
    onCancelClose: () => undefined,
    onConfirmClose: () => undefined,
    ...overrides
  }
}

function render(overrides: Partial<ChannelHostPanelViewProps> = {}): string {
  return renderToStaticMarkup(<ChannelHostPanelView {...props(overrides)} />)
}

describe('ChannelHostPanelView', () => {
  it('keeps the panel hidden behind an accessible adjacent header control', () => {
    const html = render({ open: false })

    expect(html).toContain('>Channel<')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="channel-panel"')
    expect(html).not.toContain('role="dialog"')
  })

  it('requires explicit creation and promises no automatic People migration', () => {
    const html = render()

    expect(html).toContain('Create Channel')
    expect(html).toContain('Your Channel name')
    expect(html).toContain('People share stays available alongside it')
    expect(html).not.toContain('Channel invite payload')
  })

  it('renders durable human and signed-agent history with explicit participant labels', () => {
    const room = channel()
    const html = render({
      draft: 'A host update',
      state: {
        loading: false,
        busy: null,
        channel: room,
        members: [
          member(),
          member({ memberId: 'member-alex', displayName: 'Alex', joinedAt: 2 }),
          member({
            memberId: 'agent-build',
            kind: 'agent',
            displayName: 'Build Agent',
            joinedAt: 3
          })
        ],
        pendingAdmissions: [],
        humanReviews: [],
        records: [
          message(),
          message({
            sequence: 2,
            messageId: 'message-2',
            authorMemberId: 'member-alex',
            content: 'I can see the durable history.'
          }),
          message({
            sequence: 3,
            messageId: 'message-3',
            authorMemberId: 'agent-build',
            clientMessageId: 'agent-client-3',
            kind: 'agent.text',
            content: 'Signed agent result.'
          })
        ],
        highWaterSequence: 3,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('Human posts stay manual')
    expect(html).toContain('active signed grant')
    expect(html).toContain('start a bounded run automatically')
    expect(html).toContain('Chris')
    expect(html).toContain('Owner · Active')
    expect(html).toContain('Alex')
    expect(html).toContain('Build Agent')
    expect(html).toContain('Agent · Active')
    expect(html).toContain('Remove Alex from Channel')
    expect(html).not.toContain('Remove Chris from Channel')
    expect(html).not.toContain('Remove Build Agent from Channel')
    expect(html).toContain('Welcome to the Channel.')
    expect(html).toContain('I can see the durable history.')
    expect(html).toContain('Signed agent result.')
    expect(html).toContain('channel-host-message is-agent')
    expect(html).toContain('Copy fresh invite')
    expect(html).toContain('Post')
  })

  it('mounts signed-agent management only inside an active recovery-ready host panel', () => {
    const agentManagement = <div data-agent-management="true">Signed agent controls</div>
    const active = render({
      agentManagement,
      state: {
        loading: false,
        busy: null,
        channel: channel(),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })
    const closed = render({
      agentManagement,
      state: {
        loading: false,
        busy: null,
        channel: channel({ status: 'closed' }),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })
    const blocked = render({
      agentManagement,
      state: {
        loading: false,
        busy: null,
        channel: channel({ availability: 'recovery_blocked' }),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(active).toContain('data-agent-management="true"')
    expect(active).toContain('Signed agent controls')
    expect(closed).not.toContain('data-agent-management')
    expect(blocked).not.toContain('data-agent-management')
  })

  it('binds the isolated agent panel to the canonical Channel and owner projection', () => {
    expect(panelSource).toContain(
      "import { ChannelAgentManagement } from './ChannelAgentManagement'"
    )
    expect(panelSource).toContain('channelId={state.channel.channelId}')
    expect(panelSource).toContain('ownerMemberId={state.channel.ownerMemberId}')
    expect(panelSource).not.toContain('window.api.channelAgents')
  })

  it('shows the host SAS and a scoped removal action for a pending join', () => {
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: channel(),
        members: [
          member(),
          member({ memberId: 'member-alex', displayName: 'Alex', status: 'pending' })
        ],
        pendingAdmissions: [
          {
            memberId: 'member-alex',
            displayName: 'Alex',
            confirmCode: '123456',
            expiresAt: 120_000
          }
        ],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('Confirm joins')
    expect(html).toContain('Compare each code out of band')
    expect(html).toContain('aria-label="Security code 123456"')
    expect(html).toContain('>123456<')
    expect(html).toContain('Reject Alex&#x27;s Channel join')
    expect(html).toContain('Codes differ — remove')
  })

  it('shows queued content only in the host review section with explicit decisions', () => {
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: channel(),
        members: [member(), member({ memberId: 'member-alex', displayName: 'Alex' })],
        pendingAdmissions: [],
        humanReviews: [
          {
            reviewId: 'review-1',
            channelId: 'channel-1',
            memberId: 'member-alex',
            displayName: 'Alex',
            content: 'Please approve this contribution.',
            contentBytes: 33,
            state: 'queued',
            enqueuedAt: 1_786_262_400_000,
            expiresAt: 1_786_348_800_000
          }
        ],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('Review messages')
    expect(html).toContain('Nothing enters Channel history until you approve it')
    expect(html).toContain('Please approve this contribution.')
    expect(html).toContain('aria-label="Approve message from Alex"')
    expect(html).toContain('aria-label="Decline message from Alex"')
    expect(html).not.toContain('review-1')
  })

  it('keeps the one-shot invite visible, discloses SAS, and warns on a closed relay room', () => {
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: channel(),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: {
          payload: '{"inviteToken":"one-shot-token"}',
          expiresAt: 1_786_262_400_000,
          hostRoomOpened: false,
          copied: false
        },
        notice: 'Invite created.',
        error: null
      }
    })

    expect(html).toContain('One-shot invite')
    expect(html).toContain('one-shot-token')
    expect(html).toContain('relay room is not open yet')
    expect(html).toContain('six-digit security code out of band')
    expect(html).toContain('aria-label="Channel invite payload"')
  })

  it('offers bounded forward paging when durable history is not caught up', () => {
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: channel({ messageCount: 400 }),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [message({ sequence: 256 })],
        highWaterSequence: 400,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('256 / 400')
    expect(html).toContain('Load newer messages')
  })

  it('keeps closed history visible while removing every mutation control', () => {
    const closed = channel({
      status: 'closed',
      display: { title: 'Design room', status: 'closed', memberCount: 2, messageCount: 1 }
    })
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: closed,
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [message()],
        highWaterSequence: 1,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('is-closed')
    expect(html).toContain('Welcome to the Channel.')
    expect(html).not.toContain('Copy fresh invite')
    expect(html).not.toContain('aria-label="Channel message"')
    expect(html).not.toContain('Close Channel…')
  })

  it('requires an explicit second action before closing an active Channel', () => {
    const html = render({
      closeConfirmation: true,
      state: {
        loading: false,
        busy: null,
        channel: channel(),
        members: [member()],
        pendingAdmissions: [],
        humanReviews: [],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: null
      }
    })

    expect(html).toContain('Members will lose access; history is retained')
    expect(html).toContain('Cancel')
    expect(html).toContain('Close Channel')
  })

  it('fails the mutation surface closed when durable recovery is blocked', () => {
    const html = render({
      state: {
        loading: false,
        busy: null,
        channel: channel({ availability: 'recovery_blocked' }),
        members: [],
        pendingAdmissions: [],
        humanReviews: [
          {
            reviewId: 'blocked-review',
            channelId: 'channel-1',
            memberId: 'member-alex',
            displayName: 'Alex',
            content: 'Must stay hidden while recovery is blocked.',
            contentBytes: 43,
            state: 'queued',
            enqueuedAt: 1,
            expiresAt: 2
          }
        ],
        records: [],
        highWaterSequence: 0,
        invite: null,
        notice: null,
        error: 'This Channel is unavailable until its durable history is recovered.'
      }
    })

    expect(html).toContain('Recovery needed')
    expect(html).toContain('durable history is recovered')
    expect(html).not.toContain('Copy fresh invite')
    expect(html).not.toContain('aria-label="Channel message"')
    expect(html).not.toContain('Close Channel…')
    expect(html).not.toContain('Must stay hidden while recovery is blocked.')
  })
})
