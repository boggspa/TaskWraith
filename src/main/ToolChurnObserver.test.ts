import { describe, expect, it } from 'vitest'
import { ToolChurnObserver } from './ToolChurnObserver'
import type { WorkspaceChurnSample } from './WorkspaceChurn'
import { isMeasuredDiffSummary } from '../shared/toolDiffSummaryMerge'

const WS = '/repo'

const sampleOf = (tracked: WorkspaceChurnSample['tracked']): WorkspaceChurnSample => ({
  tracked,
  untracked: {}
})

/** Scripted sampler: returns the next queued sample per call, recording calls. */
function scriptedSampler(queue: Array<WorkspaceChurnSample | null>) {
  const calls: string[] = []
  return {
    calls,
    sample: async (workspace: string): Promise<WorkspaceChurnSample | null> => {
      calls.push(workspace)
      return queue.length > 0 ? (queue.shift() as WorkspaceChurnSample | null) : null
    }
  }
}

describe('ToolChurnObserver', () => {
  it('measures the first write by priming a baseline at dispatch', async () => {
    const sampler = scriptedSampler([
      sampleOf({ 'src/a.ts': { additions: 10, deletions: 0 } }), // primed baseline
      sampleOf({ 'src/a.ts': { additions: 13, deletions: 1 } }) // settle
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    observer.noteWriteDispatched(WS)
    const summary = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })

    expect(summary).toMatchObject({ additions: 3, deletions: 1, confidence: 'exact' })
    expect(isMeasuredDiffSummary(summary)).toBe(true)
  })

  it('rolls the baseline forward so steady state costs ONE sample per write', async () => {
    const sampler = scriptedSampler([
      sampleOf({}), // primed baseline
      sampleOf({ 'src/a.ts': { additions: 5, deletions: 0 } }), // settle 1
      sampleOf({ 'src/a.ts': { additions: 9, deletions: 2 } }) // settle 2
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    observer.noteWriteDispatched(WS)
    const first = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })
    observer.noteWriteDispatched(WS)
    const second = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })

    expect(first).toMatchObject({ additions: 5, deletions: 0 })
    // Second write is measured against the FIRST settle, not against HEAD —
    // otherwise it would re-report the cumulative 9/2.
    expect(second).toMatchObject({ additions: 4, deletions: 2 })
    // 3 samples for 2 writes: one priming + one per settle.
    expect(sampler.calls).toHaveLength(3)
  })

  it('degrades to estimated when a second write overlapped the window', async () => {
    const sampler = scriptedSampler([
      sampleOf({}),
      sampleOf({ 'src/a.ts': { additions: 6, deletions: 0 } }),
      sampleOf({ 'src/a.ts': { additions: 6, deletions: 0 }, 'src/b.ts': { additions: 4, deletions: 0 } })
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    // Two writes in flight at once — neither delta is cleanly attributable.
    observer.noteWriteDispatched(WS)
    observer.noteWriteDispatched(WS)
    const first = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })
    const second = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/b.ts']
    })

    expect(first?.confidence).toBe('estimated')
    expect(isMeasuredDiffSummary(first)).toBe(false)
    // Contention is sticky across the tail of the overlap: the second settle
    // closed a window that OPENED while a peer was still writing.
    expect(second?.confidence).toBe('estimated')
  })

  it('returns to exclusive once the workspace goes quiet again', async () => {
    const sampler = scriptedSampler([
      sampleOf({}),
      sampleOf({ 'src/a.ts': { additions: 1, deletions: 0 } }),
      sampleOf({ 'src/a.ts': { additions: 2, deletions: 0 } }),
      sampleOf({ 'src/a.ts': { additions: 3, deletions: 0 } })
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    observer.noteWriteDispatched(WS)
    observer.noteWriteDispatched(WS)
    await observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })
    await observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })

    observer.noteWriteDispatched(WS)
    const afterQuiet = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })

    expect(afterQuiet?.confidence).toBe('exact')
  })

  it('declines when the priming sample never landed', async () => {
    // A workspace that is not a repository: every sample declines, so there is
    // no baseline and `diff HEAD` must NOT be substituted for one.
    const sampler = scriptedSampler([null, null])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    observer.noteWriteDispatched(WS)
    const summary = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })

    expect(summary).toBeUndefined()
  })

  it('still advances the baseline when a settle cannot be measured', async () => {
    // First settle has no baseline (dispatch was never noted) so it declines —
    // but it must leave a baseline behind, or the workspace never recovers.
    const sampler = scriptedSampler([
      sampleOf({ 'src/a.ts': { additions: 4, deletions: 0 } }), // settle 1 (no baseline)
      sampleOf({ 'src/a.ts': { additions: 7, deletions: 0 } }) // settle 2
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })

    const first = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })
    const second = await observer.measureSettledWrite({
      workspacePath: WS,
      touchedPaths: ['src/a.ts']
    })

    expect(first).toBeUndefined()
    expect(second).toMatchObject({ additions: 3, confidence: 'exact' })
  })

  it('serialises concurrent settles so the rolling baseline advances in order', async () => {
    const sampler = scriptedSampler([
      sampleOf({}),
      sampleOf({ 'src/a.ts': { additions: 2, deletions: 0 } }),
      sampleOf({ 'src/a.ts': { additions: 5, deletions: 0 } })
    ])
    const observer = new ToolChurnObserver({ sample: sampler.sample })
    observer.noteWriteDispatched(WS)

    // Fired without awaiting the first — the chain must still order them.
    const [first, second] = await Promise.all([
      observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] }),
      observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })
    ])

    expect(first?.additions).toBe(2)
    // 5 - 2, not 5 - 0: the second subtracted the baseline the first advanced to.
    expect(second?.additions).toBe(3)
  })

  it('keeps workspaces independent', async () => {
    const other = '/other'
    const queue: Array<WorkspaceChurnSample | null> = [
      sampleOf({}),
      sampleOf({}),
      sampleOf({ 'src/a.ts': { additions: 8, deletions: 0 } }),
      sampleOf({ 'src/z.ts': { additions: 1, deletions: 0 } })
    ]
    const observer = new ToolChurnObserver({ sample: async () => queue.shift() ?? null })

    observer.noteWriteDispatched(WS)
    observer.noteWriteDispatched(other)
    const a = await observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })
    const b = await observer.measureSettledWrite({
      workspacePath: other,
      touchedPaths: ['src/z.ts']
    })

    // Two writes in two DIFFERENT workspaces are each exclusive.
    expect(a?.confidence).toBe('exact')
    expect(b?.confidence).toBe('exact')
  })

  it('survives a sampler that throws', async () => {
    const observer = new ToolChurnObserver({
      sample: async () => {
        throw new Error('git exploded')
      }
    })
    observer.noteWriteDispatched(WS)

    await expect(
      observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })
    ).resolves.toBeUndefined()
    // And the chain is not poisoned — a later call still resolves.
    await expect(
      observer.measureSettledWrite({ workspacePath: WS, touchedPaths: ['src/a.ts'] })
    ).resolves.toBeUndefined()
  })
})
