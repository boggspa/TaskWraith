import { describe, it, expect, vi } from 'vitest'
import {
  buildVerifiedSameProviderRetryPayload,
  runProviderAutoFailover
} from './ProviderAutoFailover'
import type { AutoFailoverDeps, FailoverRunSnapshot, AutoFailoverNotice } from './ProviderAutoFailover'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

function baseSnapshot(over: Partial<FailoverRunSnapshot> = {}): FailoverRunSnapshot {
  const snapshot: FailoverRunSnapshot = {
    sourceRunId: 'run-A',
    provider: 'claude',
    scope: 'workspace',
    workspace: '/repo',
    prompt: 'do the thing',
    appChatId: 'chat-1',
    approvalMode: 'auto_edit',
    model: 'cli-default',
    failoverHopCount: 0,
    effectivePermissionsSignature: 'verified-source-signature',
    permissionPostureContext: {} as FailoverRunSnapshot['permissionPostureContext'],
    ...over
  }
  if (!over.permissionPostureContext) {
    snapshot.permissionPostureContext = {
      provider: snapshot.provider,
      scope: snapshot.scope,
      appRunId: snapshot.sourceRunId,
      appChatId: snapshot.appChatId,
      prompt: snapshot.prompt,
      workflowMode: snapshot.workflowMode === 'plan' ? 'plan' : 'normal',
      runtimeProfileId: snapshot.runtimeProfileId
    }
  }
  return snapshot
}

function makeDeps(over: Partial<AutoFailoverDeps> = {}): { deps: AutoFailoverDeps; notices: AutoFailoverNotice[]; dispatched: any[]; settingsWrites: any[] } {
  const notices: AutoFailoverNotice[] = []
  const dispatched: any[] = []
  const settingsWrites: any[] = []
  const deps: AutoFailoverDeps = {
    getSettings: () => ({ providerRunPauses: {} }),
    updateSettings: (p) => settingsWrites.push(p),
    availableProviders: () => ['claude', 'codex', 'kimi', 'grok', 'cursor', 'ollama'],
    isPaused: () => false,
    signPosture: () => 'sig-deadbeef',
    verifyPosture: vi.fn(() => true),
    makeRunId: (p) => `${p}-newrun`,
    dispatch: async (payload) => dispatched.push(payload),
    notify: (n) => notices.push(n),
    now: () => NOW,
    ...over
  }
  return { deps, notices, dispatched, settingsWrites }
}

describe('runProviderAutoFailover', () => {
  it('pauses the failed provider and re-dispatches the same request to a healthy one', async () => {
    const { deps, notices, dispatched, settingsWrites } = makeDeps()
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-A',
      failedProvider: 'claude',
      appChatId: 'chat-1',
      snapshot: baseSnapshot()
    })

    expect(res.ok).toBe(true)
    expect(res.target).toBe('codex') // first eligible after claude
    expect(res.newRunId).toBe('claude-newrun')

    // wrote an auto-pause on the failed provider with a reroute to the target
    expect(settingsWrites).toHaveLength(1)
    const pause = settingsWrites[0].providerRunPauses.claude
    expect(pause.paused).toBe(true)
    expect(pause.reroute).toEqual({ provider: 'codex' })
    expect(pause.reason).toMatch(/quota wall/i)

    // re-dispatched faithfully: provider stays the FAILED one (seam reroutes),
    // same prompt, new run id, lineage + hop set.
    expect(dispatched).toHaveLength(1)
    const p = dispatched[0]
    expect(p.provider).toBe('claude')
    expect(p.prompt).toBe('do the thing')
    expect(p.appRunId).toBe('claude-newrun')
    expect(p.handoffSourceRunId).toBe('run-A')
    expect(p.failoverHopCount).toBe(1)
    expect(p.effectivePermissionsSignature).toBe('sig-deadbeef')

    expect(notices.at(-1)).toMatchObject({ kind: 'rerouted', target: 'codex' })
  })

  it('does not launder an unverified pre-normalize posture into a retry signature', async () => {
    const getSettings = vi.fn(() => ({ providerRunPauses: {} }))
    const updateSettings = vi.fn()
    const signPosture = vi.fn(() => 'must-not-sign')
    const dispatch = vi.fn(async () => undefined)
    const { deps } = makeDeps({
      getSettings,
      updateSettings,
      signPosture,
      verifyPosture: vi.fn(() => false),
      dispatch
    })

    const result = await runProviderAutoFailover(deps, {
      failedRunId: 'run-A',
      failedProvider: 'claude',
      appChatId: 'chat-1',
      snapshot: baseSnapshot({
        effectivePermissions: { presetId: 'full_access' } as never,
        effectivePermissionsSignature: 'renderer-forged-signature'
      })
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-source-posture' })
    expect(getSettings).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(signPosture).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('re-verifies a same-provider retry immediately before allocating and signing it', () => {
    const makeRunId = vi.fn(() => 'pi-retry-1')
    const signPosture = vi.fn(() => 'must-not-sign')

    expect(
      buildVerifiedSameProviderRetryPayload(
        baseSnapshot({ provider: 'pi', sourceRunId: 'pi-run-1' }),
        {
          failedRunId: 'pi-run-1',
          provider: 'pi',
          appChatId: 'chat-1',
          makeRunId
        },
        { verifyPosture: vi.fn(() => false), signPosture }
      )
    ).toBeNull()
    expect(makeRunId).not.toHaveBeenCalled()
    expect(signPosture).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, -1, 0.5])('rejects invalid source hop count %s', async (hop) => {
    const getSettings = vi.fn(() => ({ providerRunPauses: {} }))
    const { deps } = makeDeps({ getSettings })

    await expect(
      runProviderAutoFailover(deps, {
        failedRunId: 'run-A',
        failedProvider: 'claude',
        snapshot: baseSnapshot({ failoverHopCount: hop })
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid-source-posture' })
    expect(getSettings).not.toHaveBeenCalled()
  })

  it('fails closed for a scheduled occurrence without mutating settings, signing, allocating, dispatching, or notifying', async () => {
    const getSettings = vi.fn(() => ({ providerRunPauses: {} }))
    const availableProviders = vi.fn((): ('claude' | 'codex')[] => ['claude', 'codex'])
    const isPaused = vi.fn(() => false)
    const updateSettings = vi.fn()
    const signPosture = vi.fn(() => 'must-not-be-used')
    const makeRunId = vi.fn(() => 'must-not-be-used')
    const dispatch = vi.fn(async () => undefined)
    const notify = vi.fn()
    const { deps, settingsWrites, dispatched, notices } = makeDeps({
      getSettings,
      availableProviders,
      isPaused,
      updateSettings,
      signPosture,
      makeRunId,
      dispatch,
      notify
    })
    const result = await runProviderAutoFailover(deps, {
      failedRunId: 'run-A',
      failedProvider: 'claude',
      appChatId: 'chat-1',
      snapshot: baseSnapshot({ scheduledTaskId: 'task-7' })
    })
    expect(result).toEqual({ ok: false, reason: 'scheduled-run' })
    expect(getSettings).not.toHaveBeenCalled()
    expect(availableProviders).not.toHaveBeenCalled()
    expect(isPaused).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(signPosture).not.toHaveBeenCalled()
    expect(makeRunId).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(settingsWrites).toHaveLength(0)
    expect(dispatched).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  it('keeps the requested approval mode for an interactive failover', async () => {
    const interactive = makeDeps()
    await runProviderAutoFailover(interactive.deps, {
      failedRunId: 'run-B',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ sourceRunId: 'run-B', approvalMode: 'auto_edit' })
    })
    expect(interactive.dispatched[0].approvalMode).toBe('auto_edit')
    expect('scheduledTaskId' in interactive.dispatched[0]).toBe(false)
  })

  it('uses the configured reroute target when set and live', async () => {
    const { deps, dispatched } = makeDeps({
      getSettings: () => ({ providerRunPauses: { claude: { paused: false, reroute: { provider: 'kimi' } } } })
    })
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-A',
      failedProvider: 'claude',
      snapshot: baseSnapshot()
    })
    expect(res.target).toBe('kimi')
    expect(dispatched[0].provider).toBe('claude')
  })

  it('uses the parsed reset hint as the pause window when present', async () => {
    const { deps, settingsWrites } = makeDeps()
    await runProviderAutoFailover(deps, {
      failedRunId: 'run-A',
      failedProvider: 'claude',
      snapshot: baseSnapshot(),
      resetHintAt: '2026-06-21T13:00:00.000Z'
    })
    expect(settingsWrites[0].providerRunPauses.claude.until).toBe('2026-06-21T13:00:00.000Z')
  })

  it('defaults to a 15-minute pause window when no reset hint', async () => {
    const { deps, settingsWrites } = makeDeps()
    await runProviderAutoFailover(deps, {
      failedRunId: 'r',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ sourceRunId: 'r' })
    })
    expect(settingsWrites[0].providerRunPauses.claude.until).toBe(new Date(NOW + 15 * 60_000).toISOString())
  })

  it('stops at the hop cap (no infinite ping-pong)', async () => {
    const { deps, notices, dispatched } = makeDeps()
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-C',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ sourceRunId: 'run-C', failoverHopCount: 2 })
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('hop-cap')
    expect(dispatched).toHaveLength(0)
    expect(notices.at(-1)).toMatchObject({ kind: 'exhausted', hops: 2 })
  })

  it('gives up (no dispatch) when every other provider is paused', async () => {
    const { deps, notices, dispatched } = makeDeps({ isPaused: (p) => p !== 'claude' })
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-D',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ sourceRunId: 'run-D' })
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no-target')
    expect(dispatched).toHaveLength(0)
    expect(notices.at(-1)).toMatchObject({ kind: 'no-target' })
  })

  it('does nothing without a captured snapshot', async () => {
    const { deps, settingsWrites, dispatched } = makeDeps()
    const res = await runProviderAutoFailover(deps, { failedRunId: 'r', failedProvider: 'claude', snapshot: undefined })
    expect(res).toEqual({ ok: false, reason: 'no-snapshot' })
    expect(settingsWrites).toHaveLength(0)
    expect(dispatched).toHaveLength(0)
  })

  it('reports a dispatch failure without throwing', async () => {
    const { deps, notices } = makeDeps({
      dispatch: vi.fn(async () => {
        throw new Error('preflight blew up')
      })
    })
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-E',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ sourceRunId: 'run-E' })
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('dispatch-failed')
    expect(notices.at(-1)).toMatchObject({ kind: 'dispatch-failed', error: 'preflight blew up' })
  })
})
