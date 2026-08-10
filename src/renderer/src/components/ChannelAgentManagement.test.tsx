import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChannelAgentIpcOverview,
  ChannelAgentIpcOverviewSeat
} from '../../../shared/collaboration/ChannelAgentIpc'
import type { ChannelAgentManagementState } from '../lib/channelAgentManagementModel'
import {
  ChannelAgentManagementView,
  type ChannelAgentManagementViewProps
} from './ChannelAgentManagement'

const CHANNEL_ID = 'channel-agent-component-proof'
const OWNER_MEMBER_ID = 'human-owner'

function seat(overrides: Partial<ChannelAgentIpcOverviewSeat> = {}): ChannelAgentIpcOverviewSeat {
  return {
    seat: {
      agentSeatId: 'pooled-agent-build',
      displayName: 'Build Agent',
      provider: 'codex',
      model: 'gpt-5.6',
      role: 'builder'
    },
    currentKeyGeneration: 2,
    membership: {
      channelId: CHANNEL_ID,
      memberId: 'agent-member-2',
      displayName: 'Build Agent',
      keyGeneration: 2,
      status: 'active'
    },
    ...overrides
  }
}

function overview(overrides: Partial<ChannelAgentIpcOverview> = {}): ChannelAgentIpcOverview {
  return {
    channelId: CHANNEL_ID,
    seats: [seat()],
    allowedMentioners: [
      { memberId: OWNER_MEMBER_ID, displayName: 'Chris' },
      { memberId: 'human-reviewer', displayName: 'Reviewer' }
    ],
    permissionPresetIds: ['read_only', 'plan', 'default', 'workspace_write', 'full_access'],
    grantLimits: {
      defaultTtlMs: 3_600_000,
      minimumTtlMs: 300_000,
      maximumTtlMs: 2_592_000_000,
      defaultMaxDispatches: 1,
      maximumDispatches: 100
    },
    ...overrides
  }
}

function state(overrides: Partial<ChannelAgentManagementState> = {}): ChannelAgentManagementState {
  return {
    loading: false,
    busy: null,
    overview: overview(),
    notice: null,
    error: null,
    ...overrides
  }
}

function props(
  overrides: Partial<ChannelAgentManagementViewProps> = {}
): ChannelAgentManagementViewProps {
  return {
    sectionId: 'channel-agent-section',
    ownerMemberId: OWNER_MEMBER_ID,
    state: state(),
    onRefresh: () => undefined,
    onEnroll: () => undefined,
    onGrant: () => undefined,
    onRevoke: () => undefined,
    onRotate: () => undefined,
    ...overrides
  }
}

function render(overrides: Partial<ChannelAgentManagementViewProps> = {}): string {
  return renderToStaticMarkup(<ChannelAgentManagementView {...props(overrides)} />)
}

describe('ChannelAgentManagementView', () => {
  it('states the immutable review boundary while the safe roster loads', () => {
    const html = render({
      state: state({ loading: true, overview: null })
    })

    expect(html).toContain('Agents')
    expect(html).toContain('Loading signed agent roster')
    expect(html).toContain('only its named humans start this agent by mention')
    expect(html).toContain('confirmed workspace, permissions, lifetime, and dispatch budget')
    expect(html).not.toContain('Review enrollment')
    expect(html).not.toContain('Review mention grant')
  })

  it('renders a current signed participant with exact bounded grant controls', () => {
    const html = render()

    expect(html).toContain('Build Agent')
    expect(html).toContain('codex · gpt-5.6 · builder')
    expect(html).toContain('Active · key generation 2')
    expect(html).toContain('Permission preset')
    expect(html).toContain('<option value="read_only" selected="">Read only</option>')
    expect(html).toContain('<option value="full_access">Full access</option>')
    expect(html).toContain('Humans allowed to mention this agent')
    expect(html).toContain('Chris · Owner')
    expect(html).toContain('Reviewer')
    expect(html).toContain('checked=""')
    expect(html).toContain('Lifetime (minutes)')
    expect(html).toContain('value="60"')
    expect(html).toContain('Dispatch budget')
    expect(html).toContain('max="100"')
    expect(html).toContain('Review mention grant…')
    expect(html).toContain('aria-label="Review mention grant for Build Agent"')
    expect(html).toContain('Remove agent…')
    expect(html).toContain('aria-label="Remove Build Agent from Channel"')
    expect(html).toContain('Rotate key &amp; re-enroll…')
    expect(html).toContain('aria-label="Rotate key and re-enroll Build Agent"')
    expect(html).toContain('native confirmation shows the exact workspace')
    expect(html).not.toMatch(/private key|signature|authority hash|instruction/i)
  })

  it('offers enrollment without inventing a stable-key generation', () => {
    const html = render({
      state: state({
        overview: overview({ seats: [seat({ currentKeyGeneration: null, membership: undefined })] })
      })
    })

    expect(html).toContain('Not enrolled · no stable key yet')
    expect(html).toContain('Review enrollment…')
    expect(html).toContain('aria-label="Review enrollment for Build Agent"')
    expect(html).not.toContain('Review mention grant…')
    expect(html).not.toContain('Remove agent…')
    expect(html).not.toContain('Rotate key')
  })

  it('retains orphaned revoked cleanup without offering enrollment or a grant', () => {
    const current = seat()
    const html = render({
      state: state({
        overview: overview({
          seats: [
            seat({
              seat: {
                ...current.seat,
                provider: null,
                model: null,
                role: null
              },
              membership: { ...current.membership!, status: 'revoked' }
            })
          ]
        })
      })
    })

    expect(html).toContain('Roster descriptor unavailable')
    expect(html).toContain('Removed · key generation 2')
    expect(html).toContain('Rotate the stable key before re-enrolling')
    expect(html).toContain('Rotate key &amp; re-enroll…')
    expect(html).not.toContain('Review enrollment…')
    expect(html).not.toContain('Review mention grant…')
    expect(html).not.toContain('Remove agent…')
  })

  it('shows an empty canonical roster and safe feedback independently', () => {
    const empty = render({ state: state({ overview: overview({ seats: [] }) }) })
    expect(empty).toContain('No eligible pooled Agents are attached to this chat yet')

    const feedback = render({
      state: state({
        overview: null,
        error: 'Agent management is unavailable until this Channel is recovered.',
        notice: 'No Channel agent changes were made.'
      })
    })
    expect(feedback).toContain('role="alert"')
    expect(feedback).toContain('Retry')
    expect(feedback).toContain('role="status"')
    expect(feedback).toContain('No Channel agent changes were made')
  })

  it('disables the complete surface and labels only the active seat action while busy', () => {
    const html = render({
      state: state({
        busy: { action: 'grant', agentSeatId: 'pooled-agent-build' }
      })
    })

    expect(html).toContain('>Working…</button>')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Remove agent…')
    expect(html).toContain('Rotate key &amp; re-enroll…')
    expect(html).not.toContain('Working…</button><button')
  })

  it('fails the grant form closed when the owner is absent from active humans', () => {
    const html = render({
      ownerMemberId: 'missing-owner',
      state: state()
    })

    expect(html).toContain('Choose at least one active human who may mention this agent')
    expect(html).toMatch(/Review mention grant…<\/button>/)
    expect(html).toMatch(/disabled=""[^>]*>Review mention grant…<\/button>/)
  })
})
