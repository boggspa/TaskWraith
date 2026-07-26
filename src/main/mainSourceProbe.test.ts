import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * The probe exists to stop source assertions from silently stopping to mean
 * anything. That guarantee is worth exactly as much as the evidence that it
 * discriminates, so each accessor is driven over synthetic sources carrying the
 * mistake it is supposed to catch.
 */
const probe = (text: string): MainSourceProbe => MainSourceProbe.fromText('synthetic.ts', text)

describe('MainSourceProbe.fn', () => {
  it('finds a declaration and a const-arrow under the same name', () => {
    // This is the exact refactor that broke the tests this probe replaced: an
    // inline arrow passed as a property became a named binding. Both shapes
    // must resolve, or the probe just relocates the brittleness.
    const declared = probe('function authorize(payload) { guard(payload) }')
    const arrow = probe('const authorize = (payload) => { guard(payload) }')

    expect(declared.callsTo(declared.fn('authorize'), 'guard')).toHaveLength(1)
    expect(arrow.callsTo(arrow.fn('authorize'), 'guard')).toHaveLength(1)
  })

  it('throws rather than reporting a missing subject as a satisfied claim', () => {
    const renamed = probe('function authorizeLaunch(payload) { guard(payload) }')

    // The dangerous direction: if this returned an empty node, every assertion
    // downstream would pass over nothing at all.
    expect(() => renamed.fn('authorize')).toThrow(/declares no function `authorize`/)
    expect(() => renamed.fn('authorize')).toThrow(/renamed, moved or deleted/)
  })
})

describe('MainSourceProbe.callsTo', () => {
  it('counts bare and member calls and reports absence as zero', () => {
    const source = probe(`function run() {
      settle({ provider: 'antigravity' })
      runManager.settle('x')
      other()
    }`)
    const run = source.fn('run')

    expect(source.callsTo(run, 'settle')).toHaveLength(2)
    expect(source.callsTo(run, 'missing')).toHaveLength(0)
  })
})

describe('MainSourceProbe.propText', () => {
  it('reads object-argument properties regardless of order or formatting', () => {
    const compact = probe("function run() { settle({ provider: 'agy', fallback: false }) }")
    const reordered = probe(`function run() {
      settle({
        fallback:    false,
        provider:
          'agy'
      })
    }`)

    for (const source of [compact, reordered]) {
      const call = source.callsTo(source.fn('run'), 'settle')[0]
      expect(source.propText(call, 0, 'provider')).toBe("'agy'")
      expect(source.propText(call, 0, 'fallback')).toBe('false')
      expect(source.propText(call, 0, 'absent')).toBeNull()
    }
  })
})

describe('MainSourceProbe.comparesStrictly', () => {
  it('distinguishes a sanitized comparison from a raw one', () => {
    const sanitized = probe('function run() { if (payload.prompt !== admittedPrompt) fail() }')
    const raw = probe('function run() { if (payload.prompt !== admission.payload.prompt) fail() }')

    expect(
      sanitized.comparesStrictly(sanitized.fn('run'), 'payload.prompt', 'admittedPrompt')
    ).toBe(true)
    expect(
      sanitized.comparesStrictly(sanitized.fn('run'), 'payload.prompt', 'admission.payload.prompt')
    ).toBe(false)
    expect(raw.comparesStrictly(raw.fn('run'), 'payload.prompt', 'admission.payload.prompt')).toBe(
      true
    )
  })

  it('matches either operand order but not a loose or equality comparison', () => {
    const flipped = probe('function run() { if (admittedPrompt !== payload.prompt) fail() }')
    const equality = probe('function run() { if (payload.prompt === admittedPrompt) fail() }')

    expect(flipped.comparesStrictly(flipped.fn('run'), 'payload.prompt', 'admittedPrompt')).toBe(
      true
    )
    expect(equality.comparesStrictly(equality.fn('run'), 'payload.prompt', 'admittedPrompt')).toBe(
      false
    )
  })
})

describe('MainSourceProbe.assignmentsTo', () => {
  it('collects every right-hand side and stays empty when the target is never assigned', () => {
    const source = probe(`function run() {
      payload.providerSessionId = launch.resumedConversationId
      payload.other = null
    }`)
    const run = source.fn('run')

    expect(source.assignmentsTo(run, 'payload.providerSessionId')).toEqual([
      'launch.resumedConversationId'
    ])
    expect(source.assignmentsTo(run, 'payload.missing')).toEqual([])
  })
})
