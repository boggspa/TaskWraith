import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Capture = {
  id: string
  state: 'off' | 'on'
  repetition: number
  rolloutFlags: { effective: Record<string, string> }
  argv: string[]
}
type Plan = { workload: string; switch: string; runner: string; captures: Capture[]; note: string }
type Qualified = {
  qualified: boolean
  reasons: string[]
  workload: string | null
  captures: Array<{
    id: string
    state: string | null
    startedAt: string | null
    windows: number
    switchInMain: string
  }>
}
const { DURABILITY_SWITCH, buildDurabilityPairPlan, qualifyDurabilityPair } =
  require('./durabilityPair.cjs') as {
    DURABILITY_SWITCH: string
    buildDurabilityPairPlan: (options: Record<string, unknown>) => Plan
    qualifyDurabilityPair: (captures: Array<{ id: string; report: unknown }>) => Qualified
  }
const { buildM5FlagPairPlan } = require('./m5FlagPairPlan.cjs') as {
  buildM5FlagPairPlan: (options: Record<string, unknown>) => { captures: Capture[] }
}
const { parseArgs } = require('./runT2Baseline.cjs') as {
  parseArgs: (argv: string[]) => Record<string, unknown>
}
const { resolveRolloutFlags, PROGRAMME_ROLLOUT_FLAGS } = require('./rolloutFlags.cjs') as {
  resolveRolloutFlags: (options: { declared?: string[] }) => { record: Record<string, any> }
  PROGRAMME_ROLLOUT_FLAGS: string[]
}

const ROOTS = { repoRoot: '/repo', homeRoot: '/repo/perf-homes/bd', artifactRoot: '/artifacts' }
const SHA = 'a'.repeat(40)
const CELL = 'large/2/warm/ollama_same_model_repeated/none'
const SHAPE = { threads: 3, seats: 2, mode: 'parallel', windowMs: 30_000 }
const ORDER = ['off-0', 'on-0', 'off-1', 'on-1', 'off-2', 'on-2']

describe('the off-against-on plan', () => {
  it('names the switch the owner lane added to the rollout flags', () => {
    expect(DURABILITY_SWITCH).toBe('TASKWRAITH_THREAD_BARRIER_DURABILITY')
    expect(PROGRAMME_ROLLOUT_FLAGS).toContain(DURABILITY_SWITCH)
  })

  it('launches the two-lane workload off, on, off, on, off, on, exactly as the flag pairs do', () => {
    const plan = buildDurabilityPairPlan({
      ...ROOTS,
      workload: 'light_beside_large_live',
      gitSha: SHA,
      cell: CELL
    })
    expect(plan.workload).toBe('light_beside_large_live')
    expect(plan.switch).toBe(DURABILITY_SWITCH)
    expect(plan.runner).toBe('/repo/scripts/perf/runT2Baseline.cjs')
    expect(plan.captures.map((capture) => `${capture.state}-${capture.repetition}`)).toEqual(ORDER)
    expect(plan.captures.map((capture) => capture.id)).toEqual(
      ORDER.map((name) => `bd-lanes-${name}`)
    )
    // The existing pairs' launch, but for the captures' names.
    const existing = buildM5FlagPairPlan({
      ...ROOTS,
      gitSha: SHA,
      cell: CELL,
      flags: [DURABILITY_SWITCH]
    })
    plan.captures.forEach((capture, index) => {
      expect(capture.argv).toEqual(
        existing.captures[index].argv.map((arg) => arg.replaceAll('x6-', 'bd-lanes-'))
      )
    })
  })

  it('launches the many-agent workload in the same order, one window each, in its shape', () => {
    const plan = buildDurabilityPairPlan({
      ...ROOTS,
      workload: 'many_agents_live',
      gitSha: SHA,
      agents: SHAPE
    })
    expect(plan.captures.map((capture) => `${capture.state}-${capture.repetition}`)).toEqual(ORDER)
    const [first, second] = plan.captures
    expect(first.id).toBe('bd-agents-off-0')
    expect(first.argv).toEqual([
      '--workload=many_agents_live',
      '--live-agents',
      '--agent-threads=3',
      '--agent-seats=2',
      '--agent-mode=parallel',
      '--agent-window-ms=30000',
      '--launch',
      '--i-accept-isolated-launch',
      '--materialize-instance-userdata',
      '--home=/repo/perf-homes/bd/bd-agents-off-0',
      '--artifact-dir=/artifacts/bd-agents-off-0',
      '--out-dir=/artifacts/bd-agents-off-0',
      '--instance-id=bd-agents-off-0',
      `--git-sha=${SHA}`,
      `--build-id=${SHA}`,
      '--accept-unfolded-cross-thread',
      '--seed=42',
      '--port=9420',
      '--inspect-port=9820'
    ])
    expect(second.argv.at(-1)).toBe(`--flag=${DURABILITY_SWITCH}`)
    // A cell, when given, folds the Host's spans instead.
    const folded = buildDurabilityPairPlan({
      ...ROOTS,
      workload: 'many_agents_live',
      gitSha: SHA,
      agents: SHAPE,
      cell: CELL
    })
    expect(folded.captures[0].argv).toContain(`--cell=${CELL}`)
    expect(folded.captures[0].argv).not.toContain('--accept-unfolded-cross-thread')
  })

  it('differs between off and on only in the switch, pinned in every capture', () => {
    for (const workload of ['light_beside_large_live', 'many_agents_live']) {
      const plan = buildDurabilityPairPlan({
        ...ROOTS,
        workload,
        gitSha: SHA,
        cell: CELL,
        agents: SHAPE
      })
      for (const capture of plan.captures) {
        const declared = capture.state === 'on' ? [DURABILITY_SWITCH] : []
        expect(capture.rolloutFlags).toEqual(resolveRolloutFlags({ declared }).record)
        expect(capture.argv.filter((arg) => arg.startsWith('--flag='))).toEqual(
          declared.map((flag) => `--flag=${flag}`)
        )
        // The runner understands every argument.
        expect(parseArgs(capture.argv)).toMatchObject({ workload, launch: true })
      }
      const [off, on] = plan.captures
      const named = (argv: string[]) =>
        argv.filter((arg) => !arg.startsWith('--flag=')).map((arg) => arg.replace(/-o(ff|n)-/, '-'))
      expect(named(on.argv)).toEqual(named(off.argv))
    }
  })

  it('gives every capture the same extra arguments, never one the plan sets itself', () => {
    const plan = buildDurabilityPairPlan({
      ...ROOTS,
      workload: 'many_agents_live',
      gitSha: SHA,
      agents: SHAPE,
      extraArgv: ['--live-round-timeout-ms=900000', '--skip-build']
    })
    for (const capture of plan.captures) {
      const extra = capture.argv.indexOf('--live-round-timeout-ms=900000')
      expect(capture.argv.slice(extra, extra + 2)).toEqual([
        '--live-round-timeout-ms=900000',
        '--skip-build'
      ])
      // The switch stays last, so off and on differ only there.
      expect(capture.argv.slice(extra + 2)).toEqual(
        capture.state === 'on' ? [`--flag=${DURABILITY_SWITCH}`] : []
      )
    }
    for (const extra of [
      `--flag=${DURABILITY_SWITCH}`,
      '--flag=TASKWRAITH_JOURNAL_FLUSHER',
      '--home=/elsewhere',
      '--seed=7',
      '--agent-threads=200',
      '--workload=dual_run',
      'skip-build'
    ]) {
      expect(() =>
        buildDurabilityPairPlan({
          ...ROOTS,
          workload: 'many_agents_live',
          gitSha: SHA,
          agents: SHAPE,
          extraArgv: [extra]
        })
      ).toThrow(/extra argument/)
    }
  })

  it('refuses what cannot make a pair', () => {
    const lanes = { ...ROOTS, workload: 'light_beside_large_live', gitSha: SHA, cell: CELL }
    const agents = { ...ROOTS, workload: 'many_agents_live', gitSha: SHA, agents: SHAPE }
    expect(() => buildDurabilityPairPlan({ ...lanes, repoRoot: 'repo' })).toThrow(/absolute/)
    expect(() => buildDurabilityPairPlan({ ...lanes, gitSha: 'abc' })).toThrow(/commit/)
    expect(() => buildDurabilityPairPlan({ ...lanes, workload: 'dual_run' })).toThrow(/workload/)
    expect(() => buildDurabilityPairPlan({ ...lanes, cell: undefined })).toThrow(/cell/)
    expect(() => buildDurabilityPairPlan({ ...agents, agents: undefined })).toThrow(/shape/)
    for (const shape of [
      { ...SHAPE, threads: 0 },
      { ...SHAPE, seats: 1.5 },
      { ...SHAPE, mode: 'both' },
      { ...SHAPE, windowMs: -1 }
    ]) {
      expect(() => buildDurabilityPairPlan({ ...agents, agents: shape })).toThrow(/shape/)
    }
  })
})

/** A capture's report as the runner writes it, for the pair's reading. */
function report(
  state: 'off' | 'on',
  startedAt: string,
  options: {
    flags?: string[]
    workload?: string
    gitSha?: string
    buildId?: string
    seed?: number
    fingerprint?: string
    threads?: number
    main?: Record<string, unknown> | null
    unavailable?: string
    windows?: number
  } = {}
) {
  const declared = [...(state === 'on' ? [DURABILITY_SWITCH] : []), ...(options.flags ?? [])]
  const workload = options.workload ?? 'many_agents_live'
  const main =
    options.main === undefined ? { enabled: state === 'on', ignored: null } : options.main
  const window = (repetition: number) => ({
    repetition,
    reasons: [],
    barrierDurability: {
      before: main,
      after: main,
      change: main === null ? null : {},
      unavailable: main === null ? (options.unavailable ?? 'section_absent') : null
    }
  })
  const phase = {
    options: { windowMs: 30_000, settleMarginMs: 30_000 },
    ...(workload === 'many_agents_live'
      ? { asked: { threads: options.threads ?? 3, seats: 2, seatMode: 'parallel' } }
      : {}),
    windows: Array.from({ length: options.windows ?? 1 }, (_, index) => window(index))
  }
  return {
    environment: {
      workload,
      gitSha: options.gitSha ?? SHA,
      seed: options.seed ?? 42,
      startedAt,
      // As read back from the report's file.
      rolloutFlags: JSON.parse(JSON.stringify(resolveRolloutFlags({ declared }).record))
    },
    runEvidence: {
      buildId: options.buildId ?? SHA,
      fixtureFingerprint: options.fingerprint ?? 'f'.repeat(64)
    },
    liveRounds: workload === 'many_agents_live' ? { agents: phase } : { lanes: phase }
  }
}

const at = (minute: number) =>
  `2026-10-05T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00.000Z`

/** Six captures in their order, each from the report `make` gives it. */
function six(
  make: (state: 'off' | 'on', index: number) => unknown = (state, index) =>
    report(state, at(10 * index))
) {
  return ORDER.map((name, index) => ({
    id: `bd-agents-${name}`,
    report: make(index % 2 ? 'on' : 'off', index)
  }))
}

describe('reading the captures back as a pair', () => {
  it('qualifies one build and workload launched off and on in turn, the switch in effect in main', () => {
    const pair = qualifyDurabilityPair(six())
    expect(pair).toMatchObject({ qualified: true, reasons: [], workload: 'many_agents_live' })
    expect(pair.captures.map((capture) => capture.state)).toEqual([
      'off',
      'on',
      'off',
      'on',
      'off',
      'on'
    ])
    expect(pair.captures[1]).toEqual({
      id: 'bd-agents-on-0',
      state: 'on',
      startedAt: at(10),
      windows: 1,
      switchInMain: 'on'
    })
  })

  it('takes the captures in the order they ran, whatever order they are given in', () => {
    const pair = qualifyDurabilityPair([...six()].reverse())
    expect(pair.qualified).toBe(true)
    expect(pair.captures.map((capture) => capture.id)).toEqual(
      ORDER.map((name) => `bd-agents-${name}`)
    )
  })

  it('needs the captures off and on in turn, off first, as many of each', () => {
    const swapped = six((state, index) => report(state === 'on' ? 'off' : 'on', at(10 * index)))
    expect(qualifyDurabilityPair(swapped).reasons).toContain('not_off_and_on_in_turn')
    const doubled = six((state, index) => report(index === 1 ? 'off' : state, at(10 * index)))
    expect(qualifyDurabilityPair(doubled).reasons).toContain('not_off_and_on_in_turn')
    expect(qualifyDurabilityPair(six().slice(0, 5)).reasons).toContain('not_off_and_on_in_turn')
    expect(qualifyDurabilityPair(six().slice(0, 1)).reasons).toContain('not_off_and_on_in_turn')
    expect(qualifyDurabilityPair(six().slice(0, 2)).qualified).toBe(true)
    expect(qualifyDurabilityPair([])).toMatchObject({
      qualified: false,
      reasons: ['not_off_and_on_in_turn'],
      workload: null,
      captures: []
    })
    const undated = six((state, index) => report(state, index === 3 ? 'later' : at(10 * index)))
    expect(qualifyDurabilityPair(undated).reasons).toContain('started_at_unrecorded:bd-agents-on-1')
  })

  it('needs one build, workload, seed, fixture and shape in every capture', () => {
    const differing: Array<[Record<string, unknown>, string]> = [
      [{ gitSha: 'b'.repeat(40) }, 'differs:gitSha'],
      [{ buildId: 'other-build' }, 'differs:buildId'],
      [{ seed: 7 }, 'differs:seed'],
      [{ fingerprint: 'e'.repeat(64) }, 'differs:fixtureFingerprint'],
      [{ threads: 20 }, 'differs:shape'],
      [{ workload: 'light_beside_large_live' }, 'differs:workload']
    ]
    for (const [options, reason] of differing) {
      const pair = qualifyDurabilityPair(
        six((state, index) => report(state, at(10 * index), index === 4 ? options : {}))
      )
      expect(pair.qualified).toBe(false)
      expect(pair.reasons).toContain(reason)
    }
  })

  it('says which of them a capture does not record', () => {
    const pair = qualifyDurabilityPair(
      six((state, index) => {
        const made = report(state, at(10 * index)) as Record<string, unknown>
        if (index === 1) delete made.runEvidence
        return made
      })
    )
    expect(pair.reasons).toEqual(['unrecorded:buildId', 'unrecorded:fixtureFingerprint'])
  })

  it('needs every other programme flag the same in every capture', () => {
    const pair = qualifyDurabilityPair(
      six((state, index) =>
        report(state, at(10 * index), index === 2 ? { flags: ['TASKWRAITH_UTILITY_WRITE'] } : {})
      )
    )
    expect(pair.reasons).toEqual(['flag_differs:TASKWRAITH_UTILITY_WRITE'])
  })

  it('needs the switch recorded, and main to say it was in effect as the capture asked', () => {
    const unrecorded = six()
    delete (unrecorded[2].report as any).environment.rolloutFlags.effective[DURABILITY_SWITCH]
    expect(qualifyDurabilityPair(unrecorded).reasons).toContain('switch_unrecorded:bd-agents-off-1')

    const notInEffect = qualifyDurabilityPair(
      six((state, index) =>
        report(
          state,
          at(10 * index),
          index === 3 ? { main: { enabled: false, ignored: null } } : {}
        )
      )
    )
    expect(notInEffect.reasons).toEqual(['switch_not_in_effect:bd-agents-on-1'])
    expect(notInEffect.captures[3].switchInMain).toBe('off')

    const ignored = qualifyDurabilityPair(
      six((state, index) =>
        report(
          state,
          at(10 * index),
          index === 5 ? { main: { enabled: false, ignored: 'a flusher is on' } } : {}
        )
      )
    )
    expect(ignored.reasons).toEqual(['switch_ignored:bd-agents-on-2'])
    expect(ignored.captures[5].switchInMain).toBe('ignored')

    // A build without the section cannot say: the pair is not qualified.
    const unconfirmed = qualifyDurabilityPair(
      six((state, index) => report(state, at(10 * index), { main: null }))
    )
    expect(unconfirmed.qualified).toBe(false)
    expect(unconfirmed.reasons[0]).toBe('switch_unconfirmed:bd-agents-off-0:section_absent')
    expect(unconfirmed.captures[0].switchInMain).toBe('unconfirmed:section_absent')
  })

  it('reads a two-lane pair the same way, from its lane windows', () => {
    const pair = qualifyDurabilityPair(
      six((state, index) =>
        report(state, at(10 * index), { workload: 'light_beside_large_live', windows: 1 })
      )
    )
    expect(pair).toMatchObject({ qualified: true, workload: 'light_beside_large_live' })
  })

  it('refuses a capture that is not a report, or a workload that has no pair', () => {
    const pair = qualifyDurabilityPair([{ id: 'x', report: null }, ...six().slice(1)])
    expect(pair.qualified).toBe(false)
    expect(pair.reasons).toContain('report_unreadable:x')
    const dual = qualifyDurabilityPair(
      six((state, index) => report(state, at(10 * index), { workload: 'dual_run' }))
    )
    expect(dual.reasons).toContain('workload_has_no_pair:dual_run')
  })
})
