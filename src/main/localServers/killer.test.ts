import { describe, it, expect } from 'vitest'
import { escalateKill, type KillController } from './killer'

const immediateWait = (): Promise<void> => Promise.resolve()

function controller(opts: {
  aliveAfterTerm: boolean
  aliveAfterKill?: boolean
}): KillController & { signals: string[] } {
  const signals: string[] = []
  let alive = true
  return {
    signals,
    signal(sig) {
      signals.push(sig)
      if (sig === 'SIGTERM') alive = opts.aliveAfterTerm
      if (sig === 'SIGKILL') alive = opts.aliveAfterKill ?? false
    },
    isAlive: () => alive
  }
}

describe('escalateKill', () => {
  it('stops at SIGTERM when the process dies gracefully', async () => {
    const ctrl = controller({ aliveAfterTerm: false })
    const result = await escalateKill(ctrl, { wait: immediateWait })
    expect(ctrl.signals).toEqual(['SIGTERM'])
    expect(result).toEqual({ ok: true, escalated: false })
  })

  it('escalates to SIGKILL when still alive after the grace window', async () => {
    const ctrl = controller({ aliveAfterTerm: true, aliveAfterKill: false })
    const result = await escalateKill(ctrl, { wait: immediateWait })
    expect(ctrl.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result).toEqual({ ok: true, escalated: true })
  })

  it('reports not-ok when the process survives SIGKILL', async () => {
    const ctrl = controller({ aliveAfterTerm: true, aliveAfterKill: true })
    const result = await escalateKill(ctrl, { wait: immediateWait })
    expect(result.ok).toBe(false)
    expect(result.escalated).toBe(true)
  })

  it('treats an un-signalable (already-gone) process as success', async () => {
    const alive = false
    const ctrl: KillController = {
      signal: () => {
        throw new Error('ESRCH')
      },
      isAlive: () => alive
    }
    const result = await escalateKill(ctrl, { wait: immediateWait })
    expect(result.ok).toBe(true)
    expect(result.escalated).toBe(false)
  })
})
