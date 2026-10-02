import { describe, expect, it } from 'vitest'
import { MainNativeActionGate } from './MainNativeActionGate'

describe('MainNativeActionGate', () => {
  it('closes synchronously and joins every admitted operation exactly once', async () => {
    const gate = new MainNativeActionGate()
    const first = gate.tryEnter('click')!
    const second = gate.tryEnter('fill')!
    gate.beginShutdown()
    gate.beginShutdown()
    expect(gate.tryEnter('late')).toBeNull()
    let drained = false
    const join = gate.join().then(() => {
      drained = true
    })
    first.release()
    first.release()
    await Promise.resolve()
    expect(drained).toBe(false)
    second.release()
    await join
    await gate.join()
    expect(gate.snapshot()).toEqual({ closed: true, inFlight: 0 })
  })

  it('requires closed admission before a final join', async () => {
    await expect(new MainNativeActionGate().join()).rejects.toThrow('Close native action admission')
  })
})
