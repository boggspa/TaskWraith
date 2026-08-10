import { describe, expect, it, vi } from 'vitest'
import type {
  ChannelAgentIpcApi,
  ChannelAgentIpcOutcome,
  ChannelAgentIpcOverview,
  ChannelAgentIpcOverviewSeat,
  ChannelAgentIpcResult
} from '../../../shared/collaboration/ChannelAgentIpc'
import {
  ChannelAgentManagementController,
  channelAgentGrantDraftError,
  createChannelAgentGrantDraft,
  createChannelAgentManagementInitialState
} from './channelAgentManagementModel'

const CHANNEL_ID = 'channel-agent-renderer-proof'
const OWNER_MEMBER_ID = 'human-owner'
const AGENT_SEAT_ID = 'pooled-agent-renderer-proof'

function seat(overrides: Partial<ChannelAgentIpcOverviewSeat> = {}): ChannelAgentIpcOverviewSeat {
  return {
    seat: {
      agentSeatId: AGENT_SEAT_ID,
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
    permissionPresetIds: ['read_only', 'plan', 'workspace_write'],
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

function applied(
  value: Extract<ChannelAgentIpcOutcome, { status: 'applied' }>['value']
): ChannelAgentIpcResult<ChannelAgentIpcOutcome> {
  return { ok: true, value: { status: 'applied', value } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function harness(initialOverview: ChannelAgentIpcOverview = overview()) {
  const methods = {
    overview: vi.fn<ChannelAgentIpcApi['overview']>(async () => ({
      ok: true,
      value: initialOverview
    })),
    enroll: vi.fn<ChannelAgentIpcApi['enroll']>(async () => ({
      ok: true,
      value: { status: 'declined' }
    })),
    grant: vi.fn<ChannelAgentIpcApi['grant']>(async () => ({
      ok: true,
      value: { status: 'declined' }
    })),
    revoke: vi.fn<ChannelAgentIpcApi['revoke']>(async () => ({
      ok: true,
      value: { status: 'declined' }
    })),
    rotate: vi.fn<ChannelAgentIpcApi['rotate']>(async () => ({
      ok: true,
      value: { status: 'declined' }
    }))
  }
  return {
    methods,
    api: methods as unknown as ChannelAgentIpcApi
  }
}

describe('ChannelAgentManagementController', () => {
  it('loads the exact Channel overview once and exposes an inert initial state', async () => {
    const target = harness()
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => 'unused-request'
    })

    expect(controller.snapshot()).toEqual(createChannelAgentManagementInitialState())
    await controller.start()
    await controller.start()

    expect(target.methods.overview).toHaveBeenCalledTimes(1)
    expect(target.methods.overview).toHaveBeenCalledWith({ channelId: CHANNEL_ID })
    expect(controller.snapshot()).toMatchObject({
      loading: false,
      busy: null,
      overview: overview(),
      error: null
    })
  })

  it('defaults to the owner and validates every renderer-side grant bound', () => {
    const current = overview()
    expect(createChannelAgentGrantDraft(current, OWNER_MEMBER_ID)).toEqual({
      permissionPresetId: 'read_only',
      allowedMentionerMemberIds: [OWNER_MEMBER_ID],
      ttlMs: 3_600_000,
      maxDispatches: 1
    })
    expect(
      createChannelAgentGrantDraft(current, 'missing-owner').allowedMentionerMemberIds
    ).toEqual([])

    const valid = createChannelAgentGrantDraft(current, OWNER_MEMBER_ID)
    expect(channelAgentGrantDraftError(valid, current)).toBeNull()
    expect(
      channelAgentGrantDraftError({ ...valid, permissionPresetId: 'full_access' }, current)
    ).toContain('permission preset')
    expect(
      channelAgentGrantDraftError(
        { ...valid, allowedMentionerMemberIds: [OWNER_MEMBER_ID, OWNER_MEMBER_ID] },
        current
      )
    ).toContain('active human')
    expect(
      channelAgentGrantDraftError({ ...valid, allowedMentionerMemberIds: ['unknown'] }, current)
    ).toContain('active human')
    expect(channelAgentGrantDraftError({ ...valid, ttlMs: 299_999 }, current)).toContain('lifetime')
    expect(channelAgentGrantDraftError({ ...valid, maxDispatches: 101 }, current)).toContain(
      'dispatch budget'
    )
  })

  it('submits a canonical bounded grant, checks its action binding, and refreshes', async () => {
    const target = harness()
    target.methods.grant.mockResolvedValue(
      applied({
        kind: 'grant',
        agentSeatId: AGENT_SEAT_ID,
        member: {
          channelId: CHANNEL_ID,
          memberId: 'agent-member-2',
          status: 'active',
          keyGeneration: 2
        },
        allowedMentionerMemberIds: [OWNER_MEMBER_ID, 'human-reviewer'],
        permissionPresetId: 'plan',
        expiresAt: 5_000_000,
        maxDispatches: 3
      })
    )
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => 'renderer-grant-request'
    })
    await controller.start()

    const result = await controller.grant(AGENT_SEAT_ID, {
      permissionPresetId: 'plan',
      allowedMentionerMemberIds: ['human-reviewer', OWNER_MEMBER_ID],
      ttlMs: 900_000,
      maxDispatches: 3
    })

    expect(result).toBe(true)
    expect(target.methods.grant).toHaveBeenCalledWith({
      requestId: 'renderer-grant-request',
      channelId: CHANNEL_ID,
      agentSeatId: AGENT_SEAT_ID,
      permissionPresetId: 'plan',
      allowedMentionerMemberIds: [OWNER_MEMBER_ID, 'human-reviewer'].sort(),
      ttlMs: 900_000,
      maxDispatches: 3
    })
    expect(target.methods.overview).toHaveBeenCalledTimes(2)
    expect(controller.snapshot()).toMatchObject({
      busy: null,
      notice: 'Mention grant issued for 3 dispatches.',
      error: null
    })
  })

  it('retains the exact idempotency token after transport loss and redacts thrown details', async () => {
    const unenrolled = seat({ currentKeyGeneration: null, membership: undefined })
    const target = harness(overview({ seats: [unenrolled] }))
    target.methods.enroll
      .mockRejectedValueOnce(new Error('/Users/secret/private-key.json'))
      .mockResolvedValueOnce(
        applied({
          kind: 'enroll',
          agentSeatId: AGENT_SEAT_ID,
          member: {
            channelId: CHANNEL_ID,
            memberId: 'agent-member-1',
            status: 'active',
            keyGeneration: 1
          }
        })
      )
    const createRequestId = vi.fn(() => 'stable-retry-token')
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId
    })
    await controller.start()

    expect(await controller.enroll(AGENT_SEAT_ID)).toBe(false)
    expect(controller.snapshot().error).toBe(
      'The Channel agent request could not be completed. Try again.'
    )
    expect(JSON.stringify(controller.snapshot())).not.toContain('/Users/secret')
    expect(await controller.enroll(AGENT_SEAT_ID)).toBe(true)

    expect(createRequestId).toHaveBeenCalledTimes(1)
    expect(target.methods.enroll.mock.calls.map(([input]) => input.requestId)).toEqual([
      'stable-retry-token',
      'stable-retry-token'
    ])
  })

  it('clears a definitive request after decline or stale confirmation and uses a fresh token', async () => {
    const target = harness()
    target.methods.grant
      .mockResolvedValueOnce({ ok: true, value: { status: 'declined' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'stale' } })
    const requestIds = ['request-declined', 'request-stale']
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => requestIds.shift() || 'unexpected'
    })
    const draft = createChannelAgentGrantDraft(overview(), OWNER_MEMBER_ID)
    await controller.start()

    expect(await controller.grant(AGENT_SEAT_ID, draft)).toBe(false)
    expect(controller.snapshot().notice).toBe('No Channel agent changes were made.')
    expect(await controller.grant(AGENT_SEAT_ID, draft)).toBe(false)
    expect(controller.snapshot().notice).toContain('state changed during confirmation')
    expect(target.methods.grant.mock.calls.map(([input]) => input.requestId)).toEqual([
      'request-declined',
      'request-stale'
    ])
    expect(target.methods.overview).toHaveBeenCalledTimes(3)
  })

  it('routes enrollment, revocation, and rotation through exact closed inputs', async () => {
    const seats = [
      seat({
        seat: { ...seat().seat, agentSeatId: 'pooled-agent-new', displayName: 'New Agent' },
        currentKeyGeneration: null,
        membership: undefined
      }),
      seat({
        seat: { ...seat().seat, agentSeatId: 'pooled-agent-active', displayName: 'Active Agent' }
      })
    ]
    const target = harness(overview({ seats }))
    target.methods.enroll.mockResolvedValue(
      applied({
        kind: 'enroll',
        agentSeatId: 'pooled-agent-new',
        member: {
          channelId: CHANNEL_ID,
          memberId: 'agent-new',
          status: 'active',
          keyGeneration: 1
        }
      })
    )
    target.methods.revoke.mockResolvedValue(
      applied({
        kind: 'revoke',
        agentSeatId: 'pooled-agent-active',
        member: {
          channelId: CHANNEL_ID,
          memberId: 'agent-member-2',
          status: 'revoked',
          keyGeneration: 2
        },
        alreadyRevoked: false
      })
    )
    target.methods.rotate.mockResolvedValue(
      applied({
        kind: 'rotate',
        agentSeatId: 'pooled-agent-active',
        fromKeyGeneration: 2,
        toKeyGeneration: 3,
        members: [
          {
            channelId: CHANNEL_ID,
            memberId: 'agent-member-3',
            status: 'active',
            keyGeneration: 3
          }
        ],
        resumed: false
      })
    )
    let ordinal = 0
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => `request-${++ordinal}`
    })
    await controller.start()

    expect(await controller.enroll('pooled-agent-new')).toBe(true)
    expect(await controller.revoke('pooled-agent-active')).toBe(true)
    expect(await controller.rotate('pooled-agent-active')).toBe(true)

    expect(target.methods.enroll).toHaveBeenCalledWith({
      requestId: 'request-1',
      channelId: CHANNEL_ID,
      agentSeatId: 'pooled-agent-new'
    })
    expect(target.methods.revoke).toHaveBeenCalledWith({
      requestId: 'request-2',
      channelId: CHANNEL_ID,
      agentSeatId: 'pooled-agent-active'
    })
    expect(target.methods.rotate).toHaveBeenCalledWith({
      requestId: 'request-3',
      channelId: CHANNEL_ID,
      agentSeatId: 'pooled-agent-active',
      reEnrollChannelIds: [CHANNEL_ID]
    })
    expect(controller.snapshot().notice).toContain('generation 3')
  })

  it('fails local stale-seat and malformed-response cases without claiming a mutation', async () => {
    const revoked = seat({
      membership: { ...seat().membership!, status: 'revoked' }
    })
    const target = harness(overview({ seats: [revoked] }))
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => 'request-local-proof'
    })
    await controller.start()

    expect(await controller.enroll(AGENT_SEAT_ID)).toBe(false)
    expect(controller.snapshot().error).toContain('Rotate')
    expect(target.methods.enroll).not.toHaveBeenCalled()

    target.methods.rotate.mockResolvedValue(
      applied({
        kind: 'rotate',
        agentSeatId: 'different-seat',
        fromKeyGeneration: 2,
        toKeyGeneration: 3,
        members: [],
        resumed: false
      })
    )
    expect(await controller.rotate(AGENT_SEAT_ID)).toBe(false)
    expect(controller.snapshot().error).toContain('did not match the confirmed action')
    expect(target.methods.overview).toHaveBeenCalledTimes(1)
  })

  it('serializes actions and ignores a late response after disposal', async () => {
    const target = harness()
    const pending = deferred<ChannelAgentIpcResult<ChannelAgentIpcOutcome>>()
    target.methods.revoke.mockReturnValue(pending.promise)
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID,
      createRequestId: () => 'request-pending'
    })
    await controller.start()

    const first = controller.revoke(AGENT_SEAT_ID)
    expect(await controller.rotate(AGENT_SEAT_ID)).toBe(false)
    expect(controller.snapshot().error).toContain('Finish the current')
    controller.dispose()
    pending.resolve(
      applied({
        kind: 'revoke',
        agentSeatId: AGENT_SEAT_ID,
        member: {
          channelId: CHANNEL_ID,
          memberId: 'agent-member-2',
          status: 'revoked',
          keyGeneration: 2
        },
        alreadyRevoked: false
      })
    )

    expect(await first).toBe(false)
    expect(target.methods.overview).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched overview and redacts main error text', async () => {
    const target = harness()
    target.methods.overview
      .mockResolvedValueOnce({ ok: true, value: overview({ channelId: 'other-channel' }) })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal_error', message: '/private/channel-authority.json' }
      })
    const controller = new ChannelAgentManagementController({
      api: target.api,
      channelId: CHANNEL_ID
    })

    await controller.start()
    expect(controller.snapshot().overview).toBeNull()
    expect(controller.snapshot().error).toContain('did not match the active Channel')
    await controller.refresh()
    expect(controller.snapshot().error).toBe('The Channel agent request could not be completed.')
    expect(JSON.stringify(controller.snapshot())).not.toContain('/private')
  })
})
