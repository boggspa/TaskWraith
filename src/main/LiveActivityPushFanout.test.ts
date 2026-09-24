import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contentFingerprint,
  livePhaseForCardStatus,
  participantSeatPhase,
  LiveActivityPushFanout
} from './LiveActivityPushFanout'
import { LiveActivityTokenStore } from './LiveActivityTokenStore'
import { buildLiveActivityContentState } from '../shared/apns/liveActivityPayload'

let pendingStart: (() => void) | null = null

function harness(delivered = true) {
  pendingStart = null
  const store = new LiveActivityTokenStore()
  const pushLiveActivityToToken = vi.fn(async () => ({ delivered, reason: 'Unregistered' }))
  const fanout = new LiveActivityPushFanout({
    store,
    sender: () => ({ pushLiveActivityToToken }),
    appearance: () => ({
      enabled: true,
      archetype: 'diff',
      successHex: 0x2db777,
      failureHex: 0xec3d35
    }),
    now: () => 1_700_000_000,
    // Fire immediately so the grace period does not make tests wait 20s.
    schedule: (fn) => {
      pendingStart = fn
      return { cancel: () => (pendingStart = null) }
    }
  })
  store.register({
    pairID: 'pair-1',
    activityRef: 'ref-1',
    token: 'abc123',
    env: 'sandbox',
    threadId: 'chat-1'
  })
  return { store, fanout, pushLiveActivityToToken, runPendingStart: (): void => pendingStart?.() }
}

describe('live activity phase mapping', () => {
  it('agrees with the phone planner, including on unknown', () => {
    // These two tables must stay identical or a push contradicts what the
    // device already rendered from the same projection.
    expect(livePhaseForCardStatus('queued')).toBe('running')
    expect(livePhaseForCardStatus('awaitingQuestion')).toBe('awaitingQuestion')
    expect(livePhaseForCardStatus('success')).toBe('complete')
    expect(livePhaseForCardStatus('idle')).toBeNull()
    expect(livePhaseForCardStatus('reticulating')).toBeNull()
    expect(livePhaseForCardStatus(undefined)).toBeNull()
  })

  it('maps ensemble participant statuses into existing wire phases', () => {
    expect(participantSeatPhase('answered')).toBe('complete')
    expect(participantSeatPhase('yielded')).toBe('complete')
    expect(participantSeatPhase('sleeping')).toBe('complete')
    expect(participantSeatPhase('unreachable')).toBe('failed')
    expect(participantSeatPhase('skipped')).toBe('cancelled')
    expect(participantSeatPhase('cancelled')).toBe('cancelled')
    expect(participantSeatPhase('failed')).toBe('failed')
    expect(participantSeatPhase('error')).toBe('failed')
    expect(participantSeatPhase('running')).toBe('running')
    expect(participantSeatPhase('idle')).toBe('running')
    expect(participantSeatPhase('reticulating')).toBe('running')
    expect(participantSeatPhase('success')).toBe('running')
    expect(participantSeatPhase('awaitingApproval')).toBe('running')
  })
})

describe('live activity summary fingerprints', () => {
  it('changes when only seat counters change', () => {
    const base = buildLiveActivityContentState({ phase: 'running', startedAtUnix: 1 })
    const changed = buildLiveActivityContentState({
      phase: 'running',
      startedAtUnix: 1,
      activeSeats: 1
    })

    expect(contentFingerprint(changed)).not.toBe(contentFingerprint(base))
  })
})

describe('live activity fanout', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('ignores threads with no registered activity', () => {
    h.fanout.onTaskCard({ id: 'other-chat', status: 'running' })
    expect(h.pushLiveActivityToToken).not.toHaveBeenCalled()
  })

  it('pushes an update for a live run', async () => {
    h.fanout.onTaskCard({
      id: 'chat-1',
      status: 'running',
      additions: 10,
      activeSeats: 2,
      respondedSeats: 3,
      blockedSeats: 1
    })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const [token, env, payload] = h.pushLiveActivityToToken.mock.calls[0] as never as [
      string,
      string,
      Record<string, unknown>
    ]
    expect(token).toBe('abc123')
    expect(env).toBe('sandbox')
    expect(payload.event).toBe('update')
    expect(payload).toMatchObject({
      contentState: { activeSeats: 2, respondedSeats: 3, blockedSeats: 1 }
    })
    // The collapse id is the OPAQUE activity ref, never the threadId — that is
    // what keeps the push itself from linking back to a conversation.
    expect(payload.collapseId).toBe('ref-1')
    expect(JSON.stringify(payload)).not.toContain('chat-1')
  })

  it('spends no push when the projection changed nothing', async () => {
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', additions: 10 })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', additions: 10 })
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', additions: 10 })
    expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1)
  })

  it('ends and forgets on a terminal status', async () => {
    h.fanout.onTaskCard({ id: 'chat-1', status: 'failed' })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >
    expect(payload.event).toBe('end')
    // A terminal push must carry NO stale date — the run is over, so the state
    // cannot go out of date, and greying out an accurate outcome is wrong.
    expect(payload.staleAtUnix).toBeUndefined()
    expect(payload.dismissAtUnix).toBeGreaterThan(1_700_000_000)
    expect(h.store.forThread('chat-1')).toHaveLength(0)
  })

  it('ends the card when a run goes idle rather than freezing it', async () => {
    h.fanout.onTaskCard({ id: 'chat-1', status: 'idle' })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    expect(h.store.forThread('chat-1')).toHaveLength(0)
  })

  it('drops a token APNs rejected', async () => {
    const dead = harness(false)
    dead.fanout.onTaskCard({ id: 'chat-1', status: 'running' })
    await vi.waitFor(() => expect(dead.store.forThread('chat-1')).toHaveLength(0))
  })

  it('updates an anonymous workspace card without serialising its routing id', async () => {
    h.store.register({
      pairID: 'pair-1',
      activityRef: 'workspace-ref',
      token: 'workspace-token',
      env: 'sandbox',
      workspaceId: 'workspace-secret'
    })
    h.fanout.onWorkspaceActivity({
      workspaceId: 'workspace-secret',
      phase: 'awaitingApproval',
      startedAtUnix: 10,
      activeRuns: 3,
      filesChanged: 12,
      additions: 539,
      deletions: 202,
      ahead: 89,
      behind: 0,
      hasGitSnapshot: true,
      seats: [
        { provider: 'codex', phase: 'running' },
        { provider: 'grok', phase: 'awaitingApproval' }
      ]
    })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2]
    expect(payload).toMatchObject({
      event: 'update',
      needsUser: true,
      contentState: {
        activeRuns: 3,
        filesChanged: 12,
        additions: 539,
        deletions: 202,
        ahead: 89,
        behind: 0,
        hasGitSnapshot: true
      }
    })
    expect(JSON.stringify(payload)).not.toContain('workspace-secret')
  })
})

describe('token store', () => {
  it('re-pushes after a token rotation instead of skipping as unchanged', () => {
    const store = new LiveActivityTokenStore()
    const entry = { pairID: 'p', activityRef: 'r', env: 'sandbox' as const, threadId: 't' }
    store.register({ ...entry, token: 'aaa' })
    const fp = contentFingerprint(
      buildLiveActivityContentState({ phase: 'running', startedAtUnix: 1 })
    )
    expect(store.markPushed('p', 'r', fp)).toBe(true)
    expect(store.markPushed('p', 'r', fp)).toBe(false)
    // The new token addresses the same activity, but what is on its screen is
    // unknown to us — so the next projection must re-push, not be skipped.
    store.register({ ...entry, token: 'bbb' })
    expect(store.markPushed('p', 'r', fp)).toBe(true)
  })

  it('is bounded, evicting the oldest so a peer cannot grow it without limit', () => {
    let clock = 0
    const store = new LiveActivityTokenStore({ now: () => ++clock })
    for (let i = 0; i < LiveActivityTokenStore.MAX_ENTRIES + 10; i++) {
      store.register({
        pairID: 'p',
        activityRef: `r${i}`,
        token: 't',
        env: 'sandbox',
        threadId: `chat-${i}`
      })
    }
    expect(store.size).toBe(LiveActivityTokenStore.MAX_ENTRIES)
    expect(store.forThread('chat-0')).toHaveLength(0)
    expect(store.forThread(`chat-${LiveActivityTokenStore.MAX_ENTRIES + 9}`)).toHaveLength(1)
  })

  it('forgets everything for an unpaired device', () => {
    const store = new LiveActivityTokenStore()
    store.register({ pairID: 'a', activityRef: '1', token: 't', env: 'sandbox', threadId: 'c' })
    store.register({ pairID: 'b', activityRef: '2', token: 't', env: 'sandbox', threadId: 'c' })
    store.forgetPair('a')
    expect(store.forThread('c').map((r) => r.pairID)).toEqual(['b'])
  })

  it('routes workspace and thread activities independently', () => {
    const store = new LiveActivityTokenStore()
    store.register({
      pairID: 'p',
      activityRef: 'thread-ref',
      token: 't',
      env: 'sandbox',
      threadId: 'same-looking-id'
    })
    store.register({
      pairID: 'p',
      activityRef: 'workspace-ref',
      token: 'w',
      env: 'sandbox',
      workspaceId: 'same-looking-id'
    })
    expect(store.forThread('same-looking-id').map((entry) => entry.activityRef)).toEqual([
      'thread-ref'
    ])
    expect(store.forWorkspace('same-looking-id').map((entry) => entry.activityRef)).toEqual([
      'workspace-ref'
    ])
  })
})

describe('push-to-start', () => {
  function startHarness() {
    const store = new LiveActivityTokenStore()
    const pushLiveActivityToToken = vi.fn(async () => ({ delivered: true }))
    let enabled = true
    let scheduled: (() => void) | null = null
    const fanout = new LiveActivityPushFanout({
      store,
      sender: () => ({ pushLiveActivityToToken }),
      appearance: () => ({
        enabled,
        archetype: 'attention',
        successHex: 0x112233,
        failureHex: 0x445566
      }),
      now: () => 1_700_000_000,
      schedule: (fn) => {
        scheduled = fn
        return { cancel: () => (scheduled = null) }
      }
    })
    store.registerStartToken({
      pairID: 'pair-1',
      token: 'starttoken',
      env: 'sandbox',
      providerAccents: { codex: 0x705aff }
    })
    return {
      store,
      fanout,
      pushLiveActivityToToken,
      fire: (): void => scheduled?.(),
      isScheduled: (): boolean => scheduled !== null,
      setEnabled: (v: boolean): void => {
        enabled = v
      }
    }
  }

  it('does not start immediately — the phone gets a chance to raise its own', () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex' })
    expect(h.pushLiveActivityToToken).not.toHaveBeenCalled()
    expect(h.isScheduled()).toBe(true)
  })

  it('stands down if the phone raised its own card in the meantime', () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex' })
    // The phone woke up and registered a real per-activity token.
    h.store.register({
      pairID: 'pair-1',
      activityRef: 'phone-ref',
      token: 'phonetoken',
      env: 'sandbox',
      threadId: 'chat-1'
    })
    h.fire()
    // Two cards for one run is a bug the user has to clear by hand.
    expect(h.pushLiveActivityToToken).not.toHaveBeenCalled()
  })

  it('starts with the phone-supplied accent and the Mac-owned diff colours', async () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'awaitingApproval', provider: 'codex' })
    h.fire()
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >
    expect(payload.event).toBe('start')
    const attributes = payload.attributes as Record<string, unknown>
    expect(attributes.palette).toEqual({
      // From the map the PHONE shipped — the Mac has no provider table.
      accent: 0x705aff,
      // From the Mac's own settings.diffStatColors.
      success: 0x112233,
      failure: 0x445566,
      attention: 0xf5a623
    })
    expect(attributes.archetype).toBe('attention')
    // Opaque ref, never the threadId.
    expect(JSON.stringify(payload)).not.toContain('chat-1')
  })

  it('falls back to the default accent for a provider the phone map predates', async () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'brand-new-provider' })
    h.fire()
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >
    const attributes = payload.attributes as Record<string, { accent: number }>
    // Default blue, NOT 0x000000 — an unknown key must not paint a black card.
    expect(attributes.palette.accent).toBe(0x5a8cff)
  })

  it('forces the ensemble layout regardless of the chosen archetype', async () => {
    const h = startHarness()
    h.fanout.onTaskCard({
      id: 'chat-1',
      status: 'running',
      provider: 'pi',
      isEnsemble: true,
      seats: [{ provider: 'codex', phase: 'running' }]
    })
    h.fire()
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      { archetype: string }
    >
    expect(payload.attributes).toMatchObject({ archetype: 'ensemble', provider: 'ensemble' })
  })

  it('cancels a pending start when the run finishes first', () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex' })
    expect(h.isScheduled()).toBe(true)
    h.fanout.onTaskCard({ id: 'chat-1', status: 'success', provider: 'codex' })
    expect(h.isScheduled()).toBe(false)
    expect(h.pushLiveActivityToToken).not.toHaveBeenCalled()
  })

  it('queues only ONE start per device+thread across a projection storm', () => {
    const h = startHarness()
    for (let i = 0; i < 25; i++) {
      h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex', additions: i })
    }
    h.fire()
    expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1)
  })

  it('sends nothing at all when the user turned Live Activities off', () => {
    const h = startHarness()
    h.setEnabled(false)
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex' })
    expect(h.isScheduled()).toBe(false)
    expect(h.pushLiveActivityToToken).not.toHaveBeenCalled()
  })

  it('registers the started card so the next projection updates it, not restarts it', async () => {
    const h = startHarness()
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex' })
    h.fire()
    await vi.waitFor(() => expect(h.store.hasActivityForThread('pair-1', 'chat-1')).toBe(true))
    h.fanout.onTaskCard({ id: 'chat-1', status: 'running', provider: 'codex', additions: 9 })
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(2))
    const second = (h.pushLiveActivityToToken.mock.calls[1] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >
    expect(second.event).toBe('update')
  })

  it('push-starts a workspace archetype and keeps workspace identity off APNs', async () => {
    const h = startHarness()
    h.fanout.onWorkspaceActivity({
      workspaceId: 'workspace-secret',
      phase: 'running',
      startedAtUnix: 10,
      activeRuns: 2,
      filesChanged: 4,
      additions: 20,
      deletions: 3,
      ahead: 2,
      behind: 1,
      hasGitSnapshot: true,
      seats: [
        { provider: 'codex', phase: 'running' },
        { provider: 'grok', phase: 'running' }
      ]
    })
    h.fire()
    await vi.waitFor(() => expect(h.pushLiveActivityToToken).toHaveBeenCalledTimes(1))
    const payload = (h.pushLiveActivityToToken.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >
    expect(payload.attributes).toMatchObject({ provider: 'taskwraith', archetype: 'workspace' })
    expect(JSON.stringify(payload)).not.toContain('workspace-secret')
    expect(h.store.hasActivityForWorkspace('pair-1', 'workspace-secret')).toBe(true)
  })
})
