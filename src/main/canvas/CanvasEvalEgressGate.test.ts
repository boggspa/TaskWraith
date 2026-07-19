import { describe, expect, it } from 'vitest'
import { CanvasEvalEgressGate } from './CanvasEvalEgressGate'

describe('CanvasEvalEgressGate', () => {
  it('stays active until every overlapping eval releases its hold', () => {
    const gate = new CanvasEvalEgressGate()
    const releaseA = gate.enter()
    const releaseB = gate.enter()
    expect(gate.active).toBe(true)

    releaseA()
    expect(gate.active).toBe(true)

    releaseB()
    expect(gate.active).toBe(false)
  })

  it('makes release idempotent', () => {
    const gate = new CanvasEvalEgressGate()
    const release = gate.enter()
    release()
    release()
    expect(gate.active).toBe(false)
  })
})
