import { describe, expect, it } from 'vitest'
import {
  WorkflowLoopEngine,
  type WorkflowLoopEngineDeps,
  type WorkflowLoopStepInput,
  type WorkflowLoopStepResult
} from './WorkflowLoopEngine'
import type { WorkflowLoopConfig } from './WorkflowLoopModel'

/** Build an engine over a scripted fake dispatchStep. Records every step input. */
function harness(
  step: (input: WorkflowLoopStepInput) => WorkflowLoopStepResult,
  over: Partial<WorkflowLoopEngineDeps> = {}
) {
  const calls: WorkflowLoopStepInput[] = []
  let uuidN = 0
  const engine = new WorkflowLoopEngine({
    dispatchStep: async (input) => {
      calls.push(input)
      return step(input)
    },
    now: () => 1000 + calls.length,
    uuid: () => `r${++uuidN}`,
    isCancelled: () => false,
    ...over
  })
  return { engine, calls }
}

const cfg = (
  acceptance: WorkflowLoopConfig['acceptance'],
  limits: WorkflowLoopConfig['limits'] = { maxRuns: 100 }
): WorkflowLoopConfig => ({ acceptance, limits })

describe('WorkflowLoopEngine', () => {
  it('maker-only loop runs maxIterations times then stops max_iterations', async () => {
    const { engine, calls } = harness((i) => ({ output: `work ${i.iteration}`, tokens: 10 }))
    const snap = await engine.run(cfg({ maxIterations: 3 }))
    expect(snap.status).toBe('completed')
    expect(snap.stopReason).toBe('max_iterations')
    expect(snap.iterationsCompleted).toBe(3)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.role === 'maker')).toBe(true)
    expect(snap.budget.spentRuns).toBe(3)
    expect(snap.budget.truncated).toBe(false) // max_iterations is a clean stop, not a truncation
    expect(snap.finalOutput).toBe('work 3')
  })

  it('stops accepted when the verifier accepts; records each iteration', async () => {
    const { engine, calls } = harness((i) =>
      i.role === 'verifier'
        ? { verdict: { decision: i.iteration >= 2 ? 'accept' : 'revise', evidence: 'x' }, tokens: 5 }
        : { output: `draft ${i.iteration}`, tokens: 20 }
    )
    const snap = await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    expect(snap.stopReason).toBe('accepted')
    expect(snap.iterationsCompleted).toBe(2)
    expect(calls.map((c) => c.role)).toEqual(['maker', 'verifier', 'maker', 'verifier'])
    expect(snap.budget.spentRuns).toBe(4)
    expect(snap.budget.spentTokens).toBe(20 + 5 + 20 + 5)
    expect(snap.finalOutput).toBe('draft 2')
    expect(snap.iterations[0]).toMatchObject({
      iteration: 1,
      makerRunId: 'r1',
      makerOutput: 'draft 1',
      verifierRunId: 'r2',
      verdict: { decision: 'revise' }
    })
    expect(snap.iterations[1]).toMatchObject({ makerRunId: 'r3', verifierRunId: 'r4' })
  })

  it('threads prior maker output + verdict into the next iteration', async () => {
    const { engine, calls } = harness((i) =>
      i.role === 'verifier'
        ? { verdict: { decision: i.iteration >= 2 ? 'accept' : 'revise', evidence: 'fix the thing' } }
        : { output: `draft ${i.iteration}` }
    )
    await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    const maker1 = calls.find((c) => c.role === 'maker' && c.iteration === 1)
    expect(maker1?.priorOutput).toBeUndefined() // first iteration: nothing prior
    const verifier1 = calls.find((c) => c.role === 'verifier' && c.iteration === 1)
    expect(verifier1?.priorOutput).toBe('draft 1')
    const maker2 = calls.find((c) => c.role === 'maker' && c.iteration === 2)
    expect(maker2?.priorOutput).toBe('draft 1')
    expect(maker2?.priorVerdict).toEqual({ decision: 'revise', evidence: 'fix the thing' })
  })

  it('a verifier that always revises (with evidence) still terminates at max_iterations', async () => {
    const { engine } = harness((i) =>
      i.role === 'verifier' ? { verdict: { decision: 'revise', evidence: 'still broken' } } : { output: 'd' }
    )
    const snap = await engine.run(cfg({ maxIterations: 3, verifier: {} }))
    expect(snap.stopReason).toBe('max_iterations')
    expect(snap.iterationsCompleted).toBe(3)
  })

  it('stops budget_exhausted (truncated) when maxRuns is hit mid-loop', async () => {
    const { engine } = harness((i) =>
      i.role === 'verifier' ? { verdict: { decision: 'revise', evidence: 'x' } } : { output: 'd' }
    )
    // maxRuns 3: iter1 = maker(run1)+verifier(run2); iter2 maker(run3) → pre-verifier
    // budget guard trips before verifier(2).
    const snap = await engine.run(cfg({ maxIterations: 10, verifier: {} }, { maxRuns: 3 }))
    expect(snap.stopReason).toBe('budget_exhausted')
    expect(snap.budget.truncated).toBe(true)
    expect(snap.budget.spentRuns).toBe(3)
  })

  it('stops budget_exhausted on a token ceiling across iterations', async () => {
    const { engine } = harness((i) =>
      i.role === 'verifier' ? { verdict: { decision: 'revise', evidence: 'x' }, tokens: 0 } : { output: 'd', tokens: 600 }
    )
    const snap = await engine.run(cfg({ maxIterations: 10, verifier: {} }, { maxRuns: 100, maxTokens: 1000 }))
    expect(snap.stopReason).toBe('budget_exhausted')
    expect(snap.budget.truncated).toBe(true)
  })

  it('fails the loop when a maker run fails', async () => {
    const { engine } = harness((i) =>
      i.iteration === 2 && i.role === 'maker' ? { failed: true, error: 'boom' } : { output: 'd' }
    )
    const snap = await engine.run(cfg({ maxIterations: 5 }))
    expect(snap.status).toBe('failed')
    expect(snap.stopReason).toBe('failed')
    expect(snap.error).toBe('boom')
    expect(snap.iterationsCompleted).toBe(2)
    expect(snap.iterations[1].failed).toBe(true)
  })

  it('stops inconclusive when a configured verifier emits no verdict', async () => {
    const { engine } = harness((i) =>
      i.role === 'verifier' ? { output: 'looked but did not decide', tokens: 3 } : { output: 'd' }
    )
    const snap = await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    expect(snap.stopReason).toBe('inconclusive')
    expect(snap.iterationsCompleted).toBe(1)
  })

  it('stops rejected on a verifier reject', async () => {
    const { engine } = harness((i) =>
      i.role === 'verifier' ? { verdict: { decision: 'reject', evidence: 'wrong direction' } } : { output: 'd' }
    )
    const snap = await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    expect(snap.stopReason).toBe('rejected')
    expect(snap.iterationsCompleted).toBe(1)
  })

  it('stops cancelled when cancelled before the first dispatch', async () => {
    const { engine, calls } = harness(() => ({ output: 'd' }), { isCancelled: () => true })
    const snap = await engine.run(cfg({ maxIterations: 5 }))
    expect(snap.status).toBe('cancelled')
    expect(snap.iterationsCompleted).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('stops cancelled between the maker and the verifier', async () => {
    let checks = 0
    const { engine } = harness(() => ({ output: 'd' }), {
      // isCancelled is checked at the top of the loop (false) then before the
      // verifier (true) — so the maker runs but the verifier is skipped.
      isCancelled: () => checks++ >= 1
    })
    const snap = await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    expect(snap.status).toBe('cancelled')
    expect(snap.iterationsCompleted).toBe(1) // the maker ran; the verifier was skipped
  })

  it('emits progress snapshots + a terminal snapshot via onState', async () => {
    const snaps: { status: string; stopReason?: string }[] = []
    const { engine } = harness(
      (i) =>
        i.role === 'verifier'
          ? { verdict: { decision: i.iteration >= 2 ? 'accept' : 'revise', evidence: 'x' } }
          : { output: 'd' },
      { onState: (s) => snaps.push({ status: s.status, stopReason: s.stopReason }) }
    )
    await engine.run(cfg({ maxIterations: 5, verifier: {} }))
    // ≥1 'running' progress snapshot (after iter1 continue) + the terminal one.
    expect(snaps.some((s) => s.status === 'running')).toBe(true)
    expect(snaps[snaps.length - 1]).toEqual({ status: 'completed', stopReason: 'accepted' })
  })
})
