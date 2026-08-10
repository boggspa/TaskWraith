import { beforeEach, describe, expect, it, vi } from 'vitest'

const journal = vi.hoisted(() => ({
  restore: vi.fn()
}))

vi.mock('./ChannelAgentDispatchJournalState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ChannelAgentDispatchJournalState')>()
  return {
    ...actual,
    ChannelAgentDispatchJournalState: {
      restore: journal.restore
    }
  }
})

import type { ChannelAgentDispatchJournalSnapshot } from './ChannelAgentDispatchJournalState'
import { reconcileChannelAgentProductionRun } from './ChannelAgentProductionRunReconciler'

const RUN_ID = 'channel-agent-run-production-reconcile'

function snapshot(): ChannelAgentDispatchJournalSnapshot {
  return {
    schemaVersion: 1,
    binding: { runId: RUN_ID },
    events: []
  } as unknown as ChannelAgentDispatchJournalSnapshot
}

function restore(
  args: {
    directive?: string
    runId?: string
    provider?: string
    launchCount?: number
  } = {}
): void {
  journal.restore.mockReturnValue({
    snapshot: () => ({
      ...snapshot(),
      binding: { runId: args.runId ?? RUN_ID },
      events: Array.from({ length: args.launchCount ?? 1 }, () => ({
        kind: 'launch.intent',
        seal: { provider: args.provider ?? 'codex' }
      }))
    }),
    recoveryDirective: () => args.directive ?? 'reconcile_exact_run_without_redispatch'
  })
}

beforeEach(() => {
  journal.restore.mockReset()
  restore()
})

describe('reconcileChannelAgentProductionRun', () => {
  it('reports exact active ownership and authoritative process absence', () => {
    const activeLookup = {
      getRun: vi.fn(() => ({
        runId: RUN_ID,
        provider: 'codex' as const,
        status: 'running' as const
      }))
    }
    expect(reconcileChannelAgentProductionRun(activeLookup, snapshot())).toEqual({
      kind: 'active'
    })
    expect(activeLookup.getRun).toHaveBeenCalledWith(RUN_ID)

    const absentLookup = { getRun: vi.fn(() => undefined) }
    expect(reconcileChannelAgentProductionRun(absentLookup, snapshot())).toEqual({
      kind: 'definitively_absent'
    })
  })

  it('retains terminal, rebound, conflicting, and unavailable run evidence', () => {
    for (const run of [
      { runId: RUN_ID, provider: 'codex' as const, status: 'completed' as const },
      { runId: 'other-run', provider: 'codex' as const, status: 'running' as const },
      { runId: RUN_ID, provider: 'claude' as const, status: 'running' as const }
    ]) {
      expect(reconcileChannelAgentProductionRun({ getRun: () => run }, snapshot())).toEqual({
        kind: 'unavailable'
      })
    }
    expect(
      reconcileChannelAgentProductionRun(
        {
          getRun: () => {
            throw new Error('PRIVATE PROVIDER STATE')
          }
        },
        snapshot()
      )
    ).toEqual({ kind: 'unavailable' })
  })

  it('refuses malformed journals, non-reconciliation phases, and ambiguous launches', () => {
    journal.restore.mockImplementationOnce(() => {
      throw new Error('invalid journal')
    })
    expect(reconcileChannelAgentProductionRun({ getRun: vi.fn() }, snapshot())).toEqual({
      kind: 'unavailable'
    })

    restore({ directive: 'sign_terminal_post' })
    const wrongPhaseLookup = { getRun: vi.fn() }
    expect(reconcileChannelAgentProductionRun(wrongPhaseLookup, snapshot())).toEqual({
      kind: 'unavailable'
    })
    expect(wrongPhaseLookup.getRun).not.toHaveBeenCalled()

    restore({ launchCount: 2 })
    expect(reconcileChannelAgentProductionRun({ getRun: vi.fn() }, snapshot())).toEqual({
      kind: 'unavailable'
    })
  })
})
