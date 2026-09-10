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

describe('MainSourceProbe.construction', () => {
  it('sees a `new` wiring site that callsTo is blind to, and reads its arguments', () => {
    const source = probe(`const orchestrator = new EnsembleOrchestrator({
      resolveExternalSeats: resolveSeats,
      hostAdmissionRuntime
    })`)

    // The gap this closes: callsTo matches CallExpression only, so the whole
    // construction was previously reachable only as a source substring.
    expect(source.callsTo(source.source, 'EnsembleOrchestrator')).toHaveLength(0)

    const built = source.construction('EnsembleOrchestrator')
    expect(built).toHaveLength(1)
    expect(source.propText(built[0], 0, 'resolveExternalSeats')).toBe('resolveSeats')
    // Shorthand resolves too, which `toContain('hostAdmissionRuntime')` cannot
    // distinguish from the same identifier appearing anywhere else in the file.
    expect(source.propText(built[0], 0, 'hostAdmissionRuntime')).toBe('hostAdmissionRuntime')
    expect(source.propText(built[0], 0, 'absent')).toBeNull()
  })

  it('throws rather than reporting a never-constructed class as a satisfied claim', () => {
    const renamed = probe('const o = new EnsembleCoordinator({})')

    expect(() => renamed.construction('EnsembleOrchestrator')).toThrow(
      /never constructs `EnsembleOrchestrator`/
    )
    expect(() => renamed.construction('EnsembleOrchestrator')).toThrow(/renamed, moved or deleted/)
  })
})

describe('MainSourceProbe.binding', () => {
  it('reads a non-function initializer and refuses a missing one', () => {
    const source = probe("const sandboxPlan = projectionScope?.shellSandbox\n")

    expect(source.text(source.binding('sandboxPlan'))).toBe('projectionScope?.shellSandbox')
    expect(() => source.binding('shellSandbox')).toThrow(/declares no non-function binding/)
  })

  it('leaves function bindings to fn, so the two locators cannot silently overlap', () => {
    const source = probe('const authorize = (payload) => { guard(payload) }')

    expect(() => source.binding('authorize')).toThrow(/declares no non-function binding/)
    expect(source.callsTo(source.fn('authorize'), 'guard')).toHaveLength(1)
  })
})

describe('MainSourceProbe.typeMembers', () => {
  // The idiom this replaces: `not.toContain('sandbox?: ShellSandboxPlan\n}')`.
  // It is silent in BOTH directions, and this file carries one source per
  // direction so neither can regress unnoticed.
  const withFieldLast = `interface Scope {
  readonly shellSandbox?: ShellSandboxPlan
}`
  const withFieldNotLast = `interface Scope {
  readonly shellSandbox?: ShellSandboxPlan
  readonly operations: Set<Controller>
}`

  it('reads members regardless of declaration order', () => {
    expect(probe(withFieldLast).typeMembers('Scope')).toEqual(['shellSandbox'])
    expect(probe(withFieldNotLast).typeMembers('Scope')).toEqual(['shellSandbox', 'operations'])
  })

  it('discriminates where the trailing-brace string goes vacuously green', () => {
    // The forbidden field is genuinely back, but it is no longer LAST, so the
    // string guard reports clean. This is the whole failure mode: the guard
    // stops guarding the moment anyone declares a member after its subject,
    // and nothing about that edit looks like it touched the guard.
    const reintroduced = `interface Scope {
  readonly sandbox?: ShellSandboxPlan
  readonly operations: Set<Controller>
}`
    expect(reintroduced).not.toContain('sandbox?: ShellSandboxPlan\n}')
    expect(probe(reintroduced).typeMembers('Scope')).toContain('sandbox')

    // And the probe compares whole member names, so the legitimate field is
    // never mistaken for the forbidden one in either direction.
    expect(probe(withFieldLast).typeMembers('Scope')).not.toContain('sandbox')
    expect(probe(withFieldNotLast).typeMembers('Scope')).not.toContain('sandbox')
  })

  it('reads a type alias and throws on an absent type', () => {
    expect(probe('type Scope = { a: string; b: number }').typeMembers('Scope')).toEqual(['a', 'b'])
    expect(() => probe('interface Other { a: string }').typeMembers('Scope')).toThrow(
      /declares no object type `Scope`/
    )
  })
})

describe('MainSourceProbe.comparesEqual', () => {
  it('matches either operand order and does not answer for the negated form', () => {
    const equal = probe("function run() { if (grant.access === 'write') keep(grant) }")
    const negated = probe("function run() { if (grant.access !== 'write') drop(grant) }")

    expect(equal.comparesEqual(equal.fn('run'), 'grant.access', "'write'")).toBe(true)
    expect(equal.comparesEqual(equal.fn('run'), "'write'", 'grant.access')).toBe(true)
    expect(equal.comparesStrictly(equal.fn('run'), 'grant.access', "'write'")).toBe(false)
    expect(negated.comparesEqual(negated.fn('run'), 'grant.access', "'write'")).toBe(false)
  })
})

describe('MainSourceProbe.objectLiterals + propOf', () => {
  // The idiom these replace: find every line matching `decision: 'deny'`, then
  // assert the NEXT TEN LINES mention `onReplyWritten`. That is wrong in both
  // directions at once, and this source carries both faults simultaneously —
  // one denial has no receipt of its own, and it is the neighbour's receipt
  // that sits inside its window.
  const twoDenials = `function hook() {
  if (a) {
    return { decision: 'deny', reason: 'first', onReplyWritten: () => receipt(1) }
  }
  if (b) {
    return { decision: 'deny', reason: 'second' }
  }
  return { decision: 'allow' }
}`

  it('checks each literal on its own, where a line window reads a neighbour', () => {
    const source = probe(twoDenials)
    const hook = source.fn('hook')
    const denials = source
      .objectLiterals(hook)
      .filter((object) => source.propOf(object, 'decision') === "'deny'")

    expect(denials).toHaveLength(2)
    // The second denial has no receipt. Per-object this is visible; a ten-line
    // window starting at its `decision` line reaches the `allow` return and the
    // first denial's callback, and reports green.
    expect(source.propOf(denials[0], 'onReplyWritten')).toBe('() => receipt(1)')
    expect(source.propOf(denials[1], 'onReplyWritten')).toBeNull()

    const windowed = source.text(hook).split('\n')
    const denyLines = windowed
      .map((line, index) => ({ line, index }))
      .filter((row) => /decision: 'deny'/.test(row.line))
    expect(denyLines).toHaveLength(2)
    expect(windowed.slice(denyLines[1].index, denyLines[1].index + 10).join('\n')).not.toContain(
      'onReplyWritten'
    )
  })

  it('reads a literal reached by return, not only one passed as an argument', () => {
    const source = probe("function hook() { return { decision: 'deny' } }")
    const literals = source.objectLiterals(source.fn('hook'))

    expect(literals).toHaveLength(1)
    expect(source.propOf(literals[0], 'decision')).toBe("'deny'")
    expect(source.propOf(literals[0], 'missing')).toBeNull()
  })
})

describe('MainSourceProbe.guard', () => {
  const branched = `const make = (kind) => {
  if (kind === 'emulator') {
    return createEmulatorCanvasDriver({ sessionId })
  }
  return createWebCanvasDriver({ sessionId })
}`

  it('scopes a containment claim to one branch instead of a proximity window', () => {
    const source = probe(branched)
    const emulator = source.guard(source.fn('make'), "kind === 'emulator'")

    expect(source.callsTo(emulator, 'createEmulatorCanvasDriver')).toHaveLength(1)
    // The claim a `[\s\S]{0,500}` window cannot make: the OTHER driver is not
    // in this branch, however close it sits in the text.
    expect(source.callsTo(emulator, 'createWebCanvasDriver')).toHaveLength(0)
  })

  it('throws when the condition is reworded rather than scoping to nothing', () => {
    const source = probe(branched)

    expect(() => source.guard(source.fn('make'), "kind === 'simulator'")).toThrow(
      /has no `if \(kind === 'simulator'\)` branch/
    )
  })
})
