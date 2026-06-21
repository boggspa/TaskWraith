import { describe, it, expect, vi } from 'vitest'
import { runProviderAutoFailover } from './ProviderAutoFailover'
import type { AutoFailoverDeps, FailoverRunSnapshot, AutoFailoverNotice } from './ProviderAutoFailover'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

function baseSnapshot(over: Partial<FailoverRunSnapshot> = {}): FailoverRunSnapshot {
  return {
    provider: 'claude',
    scope: 'workspace',
    workspace: '/repo',
    prompt: 'do the thing',
    appChatId: 'chat-1',
    approvalMode: 'auto_edit',
    model: 'cli-default',
    failoverHopCount: 0,
    ...over
  }
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
    await runProviderAutoFailover(deps, { failedRunId: 'r', failedProvider: 'claude', snapshot: baseSnapshot() })
    expect(settingsWrites[0].providerRunPauses.claude.until).toBe(new Date(NOW + 15 * 60_000).toISOString())
  })

  it('stops at the hop cap (no infinite ping-pong)', async () => {
    const { deps, notices, dispatched } = makeDeps()
    const res = await runProviderAutoFailover(deps, {
      failedRunId: 'run-C',
      failedProvider: 'claude',
      snapshot: baseSnapshot({ failoverHopCount: 2 })
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
      snapshot: baseSnapshot()
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
      snapshot: baseSnapshot()
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('dispatch-failed')
    expect(notices.at(-1)).toMatchObject({ kind: 'dispatch-failed', error: 'preflight blew up' })
  })
})
