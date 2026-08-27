import { describe, expect, it, vi } from 'vitest'
import type { RendererRunQueueMutation } from '../ipc/runQueueHandlers'
import { rendererMutationTargetsMainOwnedSteer } from './RendererSteerMutationAuthority'

function check(mutation: RendererRunQueueMutation) {
  const deps = {
    resolveCanonicalQueuedRunId: vi.fn((id: string) => (id === 'job-alias' ? 'queued-run' : id)),
    hasPendingQueuedRun: vi.fn((id: string) => id === 'queued-run'),
    hasPendingActiveRun: vi.fn((id: string) => id === 'active-run')
  }
  return { result: rendererMutationTargetsMainOwnedSteer(mutation, deps), deps }
}

describe('rendererMutationTargetsMainOwnedSteer', () => {
  it.each<RendererRunQueueMutation>([
    { operation: 'request', job: { runId: 'queued-run' } },
    { operation: 'request', job: { id: 'job-alias' } },
    { operation: 'lease', request: { runId: 'queued-run' } },
    { operation: 'transition', runIdOrId: 'job-alias', status: 'failed', partial: {} },
    {
      operation: 'promote-steer',
      input: { runId: 'queued-run', provider: 'codex', ownerToken: 'owner' }
    },
    {
      operation: 'promote-steer',
      input: {
        runId: 'new-run',
        provider: 'codex',
        prepareJob: { runId: 'queued-run', provider: 'codex', source: 'manual' }
      }
    },
    {
      operation: 'lease-promoted-steer',
      input: { runId: 'queued-run', ownerToken: 'owner' }
    },
    {
      operation: 'fallback-promoted-steer',
      input: { runId: 'queued-run', ownerToken: 'owner', reason: 'fallback' }
    }
  ])('blocks a main-owned queued row for $operation', (mutation) => {
    expect(check(mutation).result).toBe(true)
  })

  it('blocks a promotion that would cancel an active run with pending live steering', () => {
    expect(
      check({
        operation: 'promote-steer',
        input: {
          runId: 'new-run',
          provider: 'codex',
          cancelRunId: 'active-run',
          ownerToken: 'owner'
        }
      }).result
    ).toBe(true)
  })

  it('allows unrelated renderer queue mutations', () => {
    const { result, deps } = check({
      operation: 'transition',
      runIdOrId: 'other-run',
      status: 'cancelled',
      partial: {}
    })
    expect(result).toBe(false)
    expect(deps.hasPendingQueuedRun).toHaveBeenCalledWith('other-run')
  })
})
