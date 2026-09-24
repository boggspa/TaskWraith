/**
 * SOURCE-STRING guards for the projected-rows cache in `TranscriptPanel`.
 *
 * Why source strings. `useProjectedTranscriptRows` is module-private and its
 * `cacheRef` branch lives inside a `useMemo` behind a `useRef`. Renderer tests
 * have no jsdom — they are `renderToStaticMarkup`, so refs never attach and the
 * hook cannot be mounted. Until now the rule that a projection cache built under
 * one estimate input must be discarded WHOLE rested on a comment and nothing
 * else: `cacheRef`, `unboundedActivityBodies` and `pairFanoutLanes` appeared in
 * zero test files repo-wide.
 *
 * The central guard below is DERIVED, not a hard-coded list. It reads whatever
 * the projection memo currently names in its dependency array and requires every
 * global input there to also be compared before the cache is trusted and to be
 * recorded on every `cacheRef` write. A future Transcript Width or Text Size
 * input wired into legs 1+2 and not leg 3 reds this test without anyone
 * remembering to extend it — which matters, because legs 1+2 alone are not a
 * partial fix. A global setting flip does not change the `messages` array
 * identity, so the prefix walk runs to completion, the tail loop executes zero
 * times, and every cached row object comes back by reference at its old
 * estimate, permanently and re-armed on every flush.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')

/**
 * Inputs that are exempt from the leg-3 rule, and why.
 *
 * `messages` IS the cache's own key — the prefix walk compares it element by
 * element. `runBoundaryIds` is PER ROW: the walk breaks at the first row whose
 * boundary bit flipped, an escape hatch that works only because that input does
 * not change every row at once. Nothing that changes the whole list may be
 * added here.
 */
const PER_ROW_PROJECTION_INPUTS = new Set(['messages', 'runBoundaryIds'])

/** Executable source only. A count of how many times an identifier is READ must
 * not move because somebody mentioned it in a comment. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function projectionHookSource(): string {
  const start = panelSource.indexOf('function useProjectedTranscriptRows(')
  expect(start).toBeGreaterThan(-1)
  const end = panelSource.indexOf('\nfunction offsetGroupedRanges(', start)
  expect(end).toBeGreaterThan(start)
  return panelSource.slice(start, end)
}

function projectionMemoDependencies(hook: string): string[] {
  const dependencyStart = hook.lastIndexOf('}, [')
  expect(dependencyStart).toBeGreaterThan(-1)
  const dependencyEnd = hook.indexOf('])', dependencyStart)
  expect(dependencyEnd).toBeGreaterThan(dependencyStart)
  return hook
    .slice(dependencyStart + 4, dependencyEnd)
    .split(',')
    .map((dependency) => dependency.trim())
    .filter(Boolean)
}

function cacheTrustGuard(hook: string): string {
  const start = hook.indexOf('const cached =')
  expect(start).toBeGreaterThan(-1)
  const end = hook.indexOf('if (cached &&', start)
  expect(end).toBeGreaterThan(start)
  return hook.slice(start, end)
}

function cacheWriteBodies(hook: string): string[] {
  return hook
    .split('cacheRef.current = {')
    .slice(1)
    .map((tail) => {
      const close = tail.indexOf('}')
      expect(close).toBeGreaterThan(-1)
      return tail.slice(0, close)
    })
}

/** Whole-identifier match, so `layoutEpoch` never satisfies itself via
 * `layoutEpochToken` — an anchor that is a strict PREFIX of another valid form
 * proves nothing. */
function namesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(source)
}

/**
 * Whole-identifier match that also requires a COMPARISON, not just a mention.
 *
 * `namesIdentifier` alone made the trust guard presence-only: flipping the `&&`
 * between two comparisons to `||` left every identifier in place, so the guard
 * stayed green while `cached` became unconditionally truthy and the prefix was
 * reused across a flip of ANY global input. Accepts either the inline form
 * `cacheRef.current?.x === x` or a comparator call `f(cacheRef.current?.x, x)`,
 * and rejects a self-comparison typo (`cacheRef.current?.x === cacheRef...`)
 * because the right-hand side must be the bare identifier.
 */
function comparesIdentifier(source: string, identifier: string): boolean {
  const inline = new RegExp(`cacheRef\\.current\\?\\.${identifier}\\s*===\\s*${identifier}\\b`)
  const viaComparator = new RegExp(
    `\\(\\s*cacheRef\\.current\\?\\.${identifier}\\s*,\\s*${identifier}\\s*\\)`
  )
  return inline.test(source) || viaComparator.test(source)
}

/** The balanced argument list of the first `name(` call in `source`. */
function callArguments(source: string, name: string): string {
  const open = source.indexOf(`${name}(`)
  expect(open).toBeGreaterThan(-1)
  let depth = 0
  for (let index = open + name.length; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + name.length + 1, index)
    }
  }
  throw new Error(`unbalanced call: ${name}`)
}

describe('the projected-rows cache discards on every global estimate input', () => {
  it('compares and records every global dependency, not only the ones it was written for', () => {
    const hook = projectionHookSource()
    const dependencies = projectionMemoDependencies(hook)
    const globalInputs = dependencies.filter(
      (dependency) => !PER_ROW_PROJECTION_INPUTS.has(dependency)
    )
    const guard = cacheTrustGuard(hook)
    const writes = cacheWriteBodies(hook)

    // Non-vacuity: the derived lists must be the real ones before an empty
    // failure list means anything.
    expect(dependencies).toEqual(
      expect.arrayContaining(['messages', 'runBoundaryIds', 'layoutEpoch'])
    )
    expect(globalInputs).toEqual(
      expect.arrayContaining(['unboundedActivityBodies', 'pairFanoutLanes', 'layoutEpoch'])
    )
    expect(writes).toHaveLength(2)

    // Structure, not just presence. `(A && B) || true` keeps every identifier
    // in place while trusting the cache unconditionally, so the conjunction
    // itself has to be pinned — a disjunction anywhere in this guard means one
    // input's verdict can be overridden by another's.
    expect(
      guard.includes('||'),
      'the cache-trust guard must be a pure conjunction of comparisons'
    ).toBe(false)

    const unguarded: string[] = []
    let checks = 0
    for (const input of globalInputs) {
      checks += 1
      if (!comparesIdentifier(guard, input)) {
        unguarded.push(`${input}: in the dep array but NOT compared before the cache is trusted`)
      }
      for (let index = 0; index < writes.length; index += 1) {
        checks += 1
        if (!namesIdentifier(writes[index], input)) {
          unguarded.push(`${input}: not recorded on cacheRef write #${index + 1}`)
        }
      }
    }
    expect(checks).toBe(globalInputs.length * (writes.length + 1))
    expect(unguarded).toEqual([])
  })

  it('compares the layout epoch BY VALUE, never by object identity', () => {
    // An identity check would discard the entire prefix on every render for a
    // caller that rebuilds its epoch object — an O(n) full re-walk per frame at
    // ~10,000 accumulated turns — while a value-equal object must not read as a
    // change at all.
    const guard = cacheTrustGuard(projectionHookSource())
    expect(guard).toContain(
      'transcriptLayoutEpochsEqual(cacheRef.current?.layoutEpoch, layoutEpoch)'
    )
  })

  it('threads the epoch into BOTH projection call paths', () => {
    // `projectRowsAfterSharedPrefix` is a second, independent entry into
    // `projectRow`. An estimate input added to only one of the two silently
    // splits the height model between full and streaming re-projections.
    // Derived from the dep array, exactly like the trust guard — hard-coding
    // `layoutEpoch` here would let a FUTURE global input (a Width or Text Size
    // scalar) red leg 3 while passing leg 1, which is the half-wired state this
    // whole file exists to make impossible.
    const hook = projectionHookSource()
    const globalInputs = projectionMemoDependencies(hook).filter(
      (dependency) => !PER_ROW_PROJECTION_INPUTS.has(dependency)
    )
    expect(globalInputs).toEqual(
      expect.arrayContaining(['unboundedActivityBodies', 'pairFanoutLanes', 'layoutEpoch'])
    )
    const missing: string[] = []
    for (const call of ['projectRowsAfterSharedPrefix', 'projectRows']) {
      const args = callArguments(hook, call)
      for (const input of globalInputs) {
        if (!namesIdentifier(args, input)) missing.push(`${input}: absent from ${call}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('the layout epoch reaches the height caches', () => {
  it('is minted once and handed to both the projection and the virtualiser', () => {
    // One source, so a Width or Text Size control changes a single line and
    // cannot desync the estimate from the cache keys.
    // MEMOISATION, not today's value. Pinning the literal
    // `= DEFAULT_TRANSCRIPT_LAYOUT_EPOCH` would pin temporary inertness: order
    // 10 must delete that text, and the guard would be deleted with it —
    // leaving an inline object literal, a new epoch every render, and the
    // pre-paint measure pass re-running every render. What must survive that
    // edit is that the epoch is built inside a `useMemo` over its axes.
    const mintAt = panelSource.indexOf(
      'const transcriptLayoutEpoch = useMemo<TranscriptLayoutEpoch>('
    )
    expect(
      mintAt,
      'the epoch must be minted through useMemo, not rebuilt each render'
    ).toBeGreaterThan(-1)
    const mint = panelSource.slice(mintAt, panelSource.indexOf('const projectedRows =', mintAt))
    const mintDeps = mint.slice(mint.lastIndexOf('['), mint.lastIndexOf(']') + 1)
    for (const axis of ['transcriptLayoutWidthBucket', 'transcriptLayoutFontScale']) {
      expect(namesIdentifier(mint, axis), `${axis} must be read by the mint`).toBe(true)
      expect(namesIdentifier(mintDeps, axis), `${axis} must re-mint the epoch`).toBe(true)
    }
    const callSite = panelSource.slice(panelSource.indexOf('const projectedRows ='))
    expect(callSite).not.toBe('')
    const projectionArguments = callArguments(callSite, 'useProjectedTranscriptRows')
    expect(namesIdentifier(projectionArguments, 'transcriptLayoutEpoch')).toBe(true)
    const virtualizerCall = panelSource.slice(
      panelSource.indexOf('} = useTranscriptVirtualization({')
    )
    expect(virtualizerCall).not.toBe('')
    expect(virtualizerCall.slice(0, 900)).toContain('layoutEpoch: transcriptLayoutEpoch')
  })

  it('keys BOTH height maps on the epoch, so a layout change misses rather than lies', () => {
    // `measurementsRef` returns the pre-change height on an exact hit;
    // `geometryHeightsRef` is worse — it has no content version, so it keeps
    // serving the old-layout height even for rows whose content has since
    // changed. Both lookups and both writes must carry the epoch.
    const writeStart = panelSource.indexOf('const key = measurementKey(')
    expect(writeStart).toBeGreaterThan(-1)
    const writeEnd = panelSource.indexOf('const prev = measurements.get(key)', writeStart)
    expect(writeEnd).toBeGreaterThan(writeStart)
    // Comments STRIPPED and each key pinned BY ROLE. A bare `match()` count over
    // the raw slice is satisfied by prose: dropping `layoutEpoch` from the
    // `geometryKey(...)` call and adding a one-line comment naming it holds the
    // count at 2 while the geometry map — the worse of the two to serve stale,
    // since it carries no content version — loses the epoch from its key.
    const writeSite = withoutComments(panelSource.slice(writeStart, writeEnd))
    for (const [fn, role] of [
      ['measurementKey(', 'the measurement key'],
      ['geometryKey(', 'the geometry key']
    ] as const) {
      const at = writeSite.indexOf(fn)
      expect(at, `${role} must be written here`).toBeGreaterThan(-1)
      // BALANCED, not the first `)`. Both calls take nested calls as arguments
      // (`expandedRowIds?.has(...)`), so stopping at the first closer truncates
      // the argument list before the epoch and the guard reads false for code
      // that is perfectly correct.
      let depth = 0
      let end = at
      for (let i = at + fn.length - 1; i < writeSite.length; i += 1) {
        if (writeSite[i] === '(') depth += 1
        else if (writeSite[i] === ')') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      expect(end, `${role} has an unbalanced argument list`).toBeGreaterThan(at)
      const args = writeSite.slice(at, end)
      expect(
        new RegExp('\\blayoutEpoch\\b').test(args),
        `${role} must be written under the epoch`
      ).toBe(true)
    }

    const readStart = panelSource.indexOf('const heights = useMemo(() => {')
    expect(readStart).toBeGreaterThan(-1)
    const readEnd = panelSource.indexOf('heightsRef.current = heights', readStart)
    expect(readEnd).toBeGreaterThan(readStart)
    const readSite = withoutComments(panelSource.slice(readStart, readEnd))
    // The bucket the keys are built at is the MEASURED column, not the epoch's.
    // Those are two numbers with two jobs and conflating them is a regression:
    // the epoch's bucket is the ESTIMATE correction and is gated to 0 at Medium
    // so the default setting keeps its shipped calibration, while the key's
    // bucket is cache INVALIDATION and must track the real column at EVERY
    // setting. Routing the key through the gated epoch deleted the width
    // dimension from both key spaces at the default width, so a Medium column
    // that tracks its box — a side-chat divider drag, a Multiview pane, any
    // window under the cap — served heights measured at the previous column.
    // The epoch is still handed to `getRowHeight` and is still in the deps.
    //
    // Comments STRIPPED. A bare `match()` count over the raw slice moves every
    // time somebody writes the identifier in prose, which is how a count guard
    // gets "corrected" to whatever the file currently says.
    // EXACTLY that expression, to its line terminator. `toContain` on the bare
    // read is strict-PREFIX anchored: `const bucket = layoutEpoch.widthBucket + 1`
    // satisfies it, and satisfied every other guard on this seam too — 883 test
    // files green while the estimate was calibrated for one column and
    // `measurementKey` / `geometryKey` recorded another, which is the exact
    // defect this whole file exists to make unrepresentable.
    const bucketAt = readSite.indexOf('const bucket =')
    expect(
      bucketAt,
      'the bucket the heights are keyed at must come from the epoch, not a second sample'
    ).toBeGreaterThan(-1)
    expect(
      readSite.slice(bucketAt, readSite.indexOf('\n', bucketAt)).trim(),
      'the epoch bucket must reach the heights memo untouched'
    ).toBe('const bucket = measuredWidthBucket')
    expect(readSite).toContain('layoutEpoch\n          )')
    const readDeps = readSite.slice(readSite.lastIndexOf('}, ['))
    expect(readDeps, 'the heights memo must re-run when the epoch moves').toContain('layoutEpoch')
    expect(
      readDeps,
      'and when the MEASURED column moves, or it reads keys written at another width'
    ).toContain('measuredWidthBucket')
    expect(
      readSite.match(/\blayoutEpoch\b/g)?.length,
      'exactly those two roles — a third mention is a second reader to account for'
    ).toBe(2)
  })

  it('does NOT clear the height maps on an epoch change', () => {
    // The epoch lives in the cache KEYS, exactly like the width bucket, so a
    // layout change misses both maps instead of emptying them. Clearing as well
    // would throw away every height the reader can scroll back to at the old
    // layout for no invalidation benefit. Density and view are in that effect
    // only because they are absent from the keys.
    const start = panelSource.indexOf('// Density change alters --space-lg')
    expect(start).toBeGreaterThan(-1)
    const effect = panelSource.slice(start, panelSource.indexOf('}, [', start) + 200)
    const dependencies = effect.slice(effect.indexOf('}, ['))
    expect(dependencies).toContain('compactDensity')
    expect(namesIdentifier(dependencies, 'layoutEpoch')).toBe(false)
  })

  it('re-runs the measure pass when the epoch changes', () => {
    // The pass writes both cache keys. If it does not re-run, the new-epoch keys
    // are never written and every row sits on its estimate indefinitely.
    const start = panelSource.indexOf(
      '// Pre-paint: anchor correction (Phase 1) + slot measurement (Phase 2).'
    )
    expect(start).toBeGreaterThan(-1)
    const end = panelSource.indexOf('\n\n  const blockRef = useCallback', start)
    expect(end).toBeGreaterThan(start)
    const effect = panelSource.slice(start, end)
    const dependencies = effect
      .slice(effect.lastIndexOf('}, [') + 4)
      .replace(/\]\)\s*$/, '')
      .split(',')
      .map((dependency) => dependency.trim())
      .filter(Boolean)
    expect(dependencies).toEqual(expect.arrayContaining(['measureTick', 'layoutEpoch']))
  })
})
