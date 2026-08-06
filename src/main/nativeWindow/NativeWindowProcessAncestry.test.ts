import { describe, expect, it } from 'vitest'

import {
  NATIVE_WINDOW_ANCESTRY_MAX_DEPTH,
  verifyNativeWindowProcessAncestry
} from './NativeWindowProcessAncestry'

const ROOT = 4001
const MIDDLE = 4002
const LEAF = 4003

function receipt(micros: number): string {
  return `procBSDInfo:${micros}`
}

/** npm(4001) -> node(4002) -> electron(4003); a child never predates its parent. */
function chain(): Array<{ pid: number; ppid: number; processStartedAt: string }> {
  return [
    { pid: LEAF, ppid: MIDDLE, processStartedAt: receipt(3000) },
    { pid: MIDDLE, ppid: ROOT, processStartedAt: receipt(2000) },
    { pid: ROOT, ppid: 1, processStartedAt: receipt(1000) }
  ]
}

function verify(overrides: Record<string, unknown> = {}) {
  return verifyNativeWindowProcessAncestry({
    chain: chain(),
    leafPid: LEAF,
    leafProcessStartedAt: receipt(3000),
    rootPid: ROOT,
    rootProcessStartedAt: receipt(1000),
    ...overrides
  })
}

describe('verifyNativeWindowProcessAncestry', () => {
  it('accepts a window process descended from the launch process', () => {
    const result = verify()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proof.leafPid).toBe(LEAF)
    expect(result.proof.rootPid).toBe(ROOT)
    // Depth counts links traversed, so the launch process itself is depth 0.
    expect(result.proof.depth).toBe(2)
  })

  it('accepts the exact-match case as depth 0', () => {
    const result = verifyNativeWindowProcessAncestry({
      chain: [{ pid: ROOT, ppid: 1, processStartedAt: receipt(1000) }],
      leafPid: ROOT,
      leafProcessStartedAt: receipt(1000),
      rootPid: ROOT,
      rootProcessStartedAt: receipt(1000)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proof.depth).toBe(0)
  })

  it('refuses a chain whose parent link is broken', () => {
    const broken = chain()
    broken[0] = { ...broken[0], ppid: 9999 }
    const result = verify({ chain: broken })
    expect(result).toMatchObject({ ok: false, code: 'broken-link' })
  })

  it('refuses a parent that started after its child (PID reuse)', () => {
    const reused = chain()
    // The middle process was recycled: its birth receipt postdates the window.
    reused[1] = { ...reused[1], processStartedAt: receipt(5000) }
    const result = verify({ chain: reused })
    expect(result).toMatchObject({ ok: false, code: 'birth-order-violation' })
  })

  it('refuses when the leaf receipt does not match the attached window', () => {
    const result = verify({ leafProcessStartedAt: receipt(7777) })
    expect(result).toMatchObject({ ok: false, code: 'leaf-mismatch' })
  })

  it('refuses when the root receipt does not match the launch attempt', () => {
    const result = verify({ rootProcessStartedAt: receipt(7777) })
    expect(result).toMatchObject({ ok: false, code: 'root-mismatch' })
  })

  it('refuses a chain that never reaches the claimed root', () => {
    const result = verify({ chain: chain().slice(0, 2) })
    expect(result).toMatchObject({ ok: false, code: 'root-mismatch' })
  })

  it('refuses a cyclic chain rather than looping', () => {
    const cyclic = [
      { pid: LEAF, ppid: MIDDLE, processStartedAt: receipt(3000) },
      { pid: MIDDLE, ppid: LEAF, processStartedAt: receipt(2000) },
      { pid: LEAF, ppid: ROOT, processStartedAt: receipt(3000) },
      { pid: ROOT, ppid: 1, processStartedAt: receipt(1000) }
    ]
    const result = verify({ chain: cyclic })
    expect(result).toMatchObject({ ok: false, code: 'malformed-chain' })
  })

  it('refuses a chain deeper than the cap', () => {
    const deep = [{ pid: 5000, ppid: 5001, processStartedAt: receipt(10_000) }]
    for (let index = 1; index <= NATIVE_WINDOW_ANCESTRY_MAX_DEPTH + 1; index += 1) {
      deep.push({
        pid: 5000 + index,
        ppid: 5001 + index,
        processStartedAt: receipt(10_000 - index)
      })
    }
    const result = verifyNativeWindowProcessAncestry({
      chain: deep,
      leafPid: 5000,
      leafProcessStartedAt: receipt(10_000),
      rootPid: deep[deep.length - 1].pid,
      rootProcessStartedAt: deep[deep.length - 1].processStartedAt
    })
    expect(result).toMatchObject({ ok: false, code: 'depth-exceeded' })
  })

  it('refuses to treat a protected host process as a drivable window', () => {
    const result = verify({ hostProtectedPids: [LEAF] })
    expect(result).toMatchObject({ ok: false, code: 'protected-process' })
  })

  it('allows a protected process as an ancestry root without making it a target', () => {
    // Adoption anchors on the TaskWraith process itself, which is protected as
    // a target. Being someone's ancestor is a fact, not an authorization.
    const result = verify({ hostProtectedPids: [ROOT] })
    expect(result.ok).toBe(true)
  })

  it('refuses malformed chains instead of throwing', () => {
    for (const bad of [null, undefined, [], 'chain', [{ pid: 0, ppid: 1 }], [{}]]) {
      const result = verify({ chain: bad })
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a non-canonical process-start receipt inside the chain', () => {
    const spoofed = chain()
    // A wall-clock timestamp is not a birth receipt; it cannot order births.
    spoofed[1] = { ...spoofed[1], processStartedAt: '2026-08-06T20:00:00Z' }
    const result = verify({ chain: spoofed })
    expect(result).toMatchObject({ ok: false, code: 'malformed-chain' })
  })

  it('refuses a non-canonical endpoint receipt before parsing the chain', () => {
    const result = verify({ leafProcessStartedAt: '2026-08-06T20:00:00Z' })
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
  })
})
