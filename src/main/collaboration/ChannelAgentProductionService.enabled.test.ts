import { describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/collaboration/ChannelAgentReviewGate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../shared/collaboration/ChannelAgentReviewGate')>()
  return { ...actual, channelAgentParticipationEnabled: () => true }
})

import type { ChannelAgentDispatchPlan } from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentProductionService,
  type ChannelAgentProductionServiceOptions
} from './ChannelAgentProductionService'
import type { HumanChannelMessage } from './ChannelMessageLog'
import type { ChannelMember } from './ChannelStore'

const CHANNEL_ID = 'channel-agent-production-enabled-proof'
const PLAN = Object.freeze({ channelId: CHANNEL_ID }) as unknown as ChannelAgentDispatchPlan

function members(): ChannelMember[] {
  return [
    {
      channelId: CHANNEL_ID,
      memberId: 'member-owner',
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: 'owner-public-key',
      status: 'active',
      joinedAt: 1
    },
    {
      channelId: CHANNEL_ID,
      memberId: 'agent-build',
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey: Buffer.alloc(32, 7).toString('base64'),
      status: 'active',
      agentSeatId: 'pooled-agent-build',
      keyGeneration: 1,
      joinedAt: 2
    },
    {
      channelId: CHANNEL_ID,
      memberId: 'agent-review',
      kind: 'agent',
      displayName: 'Review Agent',
      identityPublicKey: Buffer.alloc(32, 8).toString('base64'),
      status: 'active',
      agentSeatId: 'pooled-agent-review',
      keyGeneration: 1,
      joinedAt: 3
    }
  ]
}

function record(
  messageId: string,
  content = 'Ask <@agent-build> and <@agent-review> to inspect this.'
): HumanChannelMessage {
  return {
    channelId: CHANNEL_ID,
    sequence: Number(messageId.replace(/\D/g, '')) || 1,
    messageId,
    authorMemberId: 'member-owner',
    clientMessageId: `client-${messageId}`,
    kind: 'human.text',
    content,
    acceptedAt: 2_000,
    contentHash: 'b'.repeat(64)
  }
}

function postedResult(targetId: string) {
  return {
    kind: 'posted' as const,
    channelId: CHANNEL_ID,
    dispatchId: `dispatch-${targetId}`,
    runId: `run-${targetId}`,
    triggerMessageId: 'message-1',
    agentMemberId: targetId,
    record: { kind: 'agent.text' } as never,
    deduplicated: false
  }
}

function harness() {
  const execution = {
    start: vi.fn(),
    dispatchPlan: vi.fn<ChannelAgentProductionServiceOptions['execution']['dispatchPlan']>(),
    dispose: vi.fn()
  }
  const recovery = {
    recoverChannel: vi.fn<ChannelAgentProductionServiceOptions['recovery']['recoverChannel']>()
  }
  recovery.recoverChannel.mockResolvedValue({
    channelId: CHANNEL_ID,
    items: [
      {
        channelId: CHANNEL_ID,
        dispatchId: 'dispatch-recovery-proof',
        runId: 'run-recovery-proof',
        initialDirective: 'reconcile_exact_run_without_redispatch',
        finalDirective: 'reconcile_exact_run_without_redispatch',
        disposition: 'retained',
        code: 'run_active'
      }
    ],
    completed: 0,
    retained: 1
  })
  const getMembers = vi.fn(() => members())
  const resolveDispatchPlan = vi.fn<ChannelAgentProductionServiceOptions['resolveDispatchPlan']>()
  const audit = vi.fn<ChannelAgentProductionServiceOptions['audit']['append']>()
  const logger = vi.fn()
  const service = new ChannelAgentProductionService({
    execution,
    recovery,
    getMembers,
    resolveDispatchPlan,
    audit: { append: audit },
    logger
  })
  return {
    service,
    execution,
    recovery,
    getMembers,
    resolveDispatchPlan,
    audit,
    logger
  }
}

describe('ChannelAgentProductionService admitted path', () => {
  it('starts execution once, recovers unique Channels, and records retained recovery', async () => {
    const h = harness()
    expect(h.service.start([CHANNEL_ID, CHANNEL_ID])).toMatchObject({ state: 'running' })
    expect(h.execution.start).toHaveBeenCalledOnce()
    expect(h.service.start([CHANNEL_ID])).toMatchObject({ state: 'running' })
    expect(h.execution.start).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(h.recovery.recoverChannel).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(h.service.status().pendingOperations).toBe(0))
    expect(h.service.status()).toMatchObject({ retainedRecoveries: 1 })
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        channelId: CHANNEL_ID,
        code: 'recovery_run_active'
      })
    )
    await h.service.stop()
    expect(h.execution.dispose).toHaveBeenCalledOnce()
  })

  it('serially resolves admitted targets and dispatches only authorized plans', async () => {
    const h = harness()
    h.recovery.recoverChannel.mockResolvedValue({
      channelId: CHANNEL_ID,
      items: [],
      completed: 0,
      retained: 0
    })
    h.resolveDispatchPlan.mockImplementation(async ({ target }) =>
      target.memberId === 'agent-review'
        ? { kind: 'denied', reason: 'dispatch_budget_exhausted' }
        : { kind: 'authorized', plan: PLAN }
    )
    h.execution.dispatchPlan.mockResolvedValue(postedResult('agent-build'))
    h.service.start([CHANNEL_ID])
    await vi.waitFor(() => expect(h.service.status().pendingOperations).toBe(0))

    await expect(
      h.service.handleDurableAppend({ deduplicated: false, record: record('message-1') })
    ).resolves.toEqual({
      kind: 'processed',
      targetCount: 2,
      dispatched: 1,
      posted: 1,
      declined: 1,
      retained: 0
    })
    expect(h.resolveDispatchPlan.mock.calls.map(([args]) => args.target.memberId)).toEqual([
      'agent-build',
      'agent-review'
    ])
    expect(h.execution.dispatchPlan).toHaveBeenCalledOnce()
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        memberId: 'agent-review',
        code: 'dispatch_budget_exhausted',
        contentHash: 'b'.repeat(64)
      })
    )
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(record('message-1').content)
    await h.service.stop()
  })

  it('drains accepted per-Channel work before disposal and fences later dispatch', async () => {
    const h = harness()
    h.recovery.recoverChannel.mockResolvedValue({
      channelId: CHANNEL_ID,
      items: [],
      completed: 0,
      retained: 0
    })
    h.resolveDispatchPlan.mockResolvedValue({ kind: 'authorized', plan: PLAN })
    let releaseDispatch!: () => void
    const dispatchBarrier = new Promise<void>((resolve) => {
      releaseDispatch = resolve
    })
    h.execution.dispatchPlan.mockImplementation(async () => {
      await dispatchBarrier
      return postedResult('agent-build')
    })
    h.service.start([CHANNEL_ID])
    await vi.waitFor(() => expect(h.service.status().pendingOperations).toBe(0))

    const first = h.service.handleDurableAppend({
      deduplicated: false,
      record: record('message-2', 'Ask <@agent-build> first.')
    })
    const second = h.service.handleDurableAppend({
      deduplicated: false,
      record: record('message-3', 'Ask <@agent-build> second.')
    })
    await vi.waitFor(() => expect(h.execution.dispatchPlan).toHaveBeenCalledTimes(1))
    const stopping = h.service.stop()
    expect(h.execution.dispose).not.toHaveBeenCalled()

    await expect(
      h.service.handleDurableAppend({
        deduplicated: false,
        record: record('message-4', 'Ask <@agent-build> after stop.')
      })
    ).resolves.toMatchObject({ kind: 'rejected', dispatched: 0 })
    releaseDispatch()
    await expect(first).resolves.toMatchObject({ kind: 'processed', posted: 1 })
    await expect(second).resolves.toMatchObject({ kind: 'processed', posted: 1 })
    await expect(stopping).resolves.toBeUndefined()
    expect(h.execution.dispatchPlan).toHaveBeenCalledTimes(2)
    expect(h.execution.dispose).toHaveBeenCalledOnce()
    expect(h.service.status().state).toBe('stopped')
  })

  it('fences a Channel immediately and waits for its accepted dispatch queue', async () => {
    const h = harness()
    h.recovery.recoverChannel.mockResolvedValue({
      channelId: CHANNEL_ID,
      items: [],
      completed: 0,
      retained: 0
    })
    h.resolveDispatchPlan.mockResolvedValue({ kind: 'authorized', plan: PLAN })
    let releaseDispatch!: () => void
    const dispatchBarrier = new Promise<void>((resolve) => {
      releaseDispatch = resolve
    })
    h.execution.dispatchPlan.mockImplementation(async () => {
      await dispatchBarrier
      return postedResult('agent-build')
    })
    h.service.start([CHANNEL_ID])
    await vi.waitFor(() => expect(h.service.status().pendingOperations).toBe(0))

    const accepted = h.service.handleDurableAppend({
      deduplicated: false,
      record: record('message-6', 'Ask <@agent-build> before close.')
    })
    await vi.waitFor(() => expect(h.execution.dispatchPlan).toHaveBeenCalledOnce())
    let quiesced = false
    const quiescing = h.service.quiesceChannel(CHANNEL_ID).then(() => {
      quiesced = true
    })
    await Promise.resolve()
    expect(quiesced).toBe(false)
    await expect(
      h.service.handleDurableAppend({
        deduplicated: false,
        record: record('message-7', 'Ask <@agent-build> after close began.')
      })
    ).resolves.toMatchObject({ kind: 'rejected', dispatched: 0 })
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        code: 'agent_channel_quiescing'
      })
    )

    releaseDispatch()
    await expect(accepted).resolves.toMatchObject({ kind: 'processed', posted: 1 })
    await quiescing
    expect(quiesced).toBe(true)
    expect(h.execution.dispatchPlan).toHaveBeenCalledOnce()
    await h.service.stop()
  })

  it('redacts plan and dispatch dependency failures into bounded audit codes', async () => {
    const h = harness()
    h.recovery.recoverChannel.mockResolvedValue({
      channelId: CHANNEL_ID,
      items: [],
      completed: 0,
      retained: 0
    })
    h.resolveDispatchPlan.mockRejectedValue(new Error('secret prompt /Users/alice/private'))
    h.service.start([CHANNEL_ID])
    await vi.waitFor(() => expect(h.service.status().pendingOperations).toBe(0))
    await expect(
      h.service.handleDurableAppend({
        deduplicated: false,
        record: record('message-5', 'Ask <@agent-build> to inspect secret bytes.')
      })
    ).resolves.toMatchObject({ kind: 'processed', declined: 1 })
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'dispatch_plan_unavailable' })
    )
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/secret bytes|\/Users\/alice/)
    await h.service.stop()
  })
})
