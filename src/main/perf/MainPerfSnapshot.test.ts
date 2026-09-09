import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createMainPerfInstrumentation, type MainPerfInstrumentation } from './MainPerfSnapshot'
import {
  createWorkSpanRecorder,
  type WorkSpanAggregates,
  type WorkSpanRecorder
} from '../perf/WorkSpanRecorder'
import { EnsembleHostAdmissionRuntime } from '../services/EnsembleHostAdmissionRuntime'
import type { EventLoopLagMeter, EventLoopLagSnapshot } from './EventLoopLagMeter'
import type { HostLoadSampler, HostLoadSnapshot } from './HostLoadSample'
import * as ts from 'typescript'

function fakeHostLoad(overrides: Partial<HostLoadSnapshot> = {}): HostLoadSampler {
  const snapshot: HostLoadSnapshot = {
    loadPerCpu1m: 0.25,
    loadAverage1m: 2,
    loadAverage5m: 2,
    loadAverage15m: 2,
    loadAverageReported: true,
    cpuBusyPercent: 41,
    hostContended: false,
    loadIsNotCpuBound: false,
    cpuCount: 8,
    processCpuPercent: 40,
    processCpuWindowMs: 1_000,
    processCpuUserMs: 350,
    processCpuSystemMs: 50,
    ...overrides
  }
  return { sample: () => snapshot }
}

function fakeMeter(): { meter: EventLoopLagMeter; resets: number[] } {
  const resets: number[] = []
  const lag: EventLoopLagSnapshot = {
    observedForMs: 1000,
    p50Ms: 1,
    p95Ms: 5,
    p99Ms: 9,
    maxMs: 42,
    meanMs: 2,
    sampling: true
  }
  return {
    resets,
    meter: {
      start: vi.fn(),
      stop: vi.fn(),
      snapshot: (options) => {
        resets.push(options?.reset ? 1 : 0)
        return lag
      }
    }
  }
}

describe('createMainPerfInstrumentation', () => {
  it('bundles the lag snapshot with every healthy section', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      hostLoad: fakeHostLoad(),
      now: () => new Date('2026-08-18T18:00:00.000Z'),
      sections: {
        journal: () => ({ appends: 7 }),
        queue: () => null
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.capturedAt).toBe('2026-08-18T18:00:00.000Z')
    expect(snapshot.eventLoopLag.maxMs).toBe(42)
    expect(snapshot.sections.journal).toEqual({ appends: 7 })
    expect(snapshot.sections.queue).toBeNull()
  })

  it('carries the host reading beside the lag, so a red gate can be attributed', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      hostLoad: fakeHostLoad({ loadPerCpu1m: 3.5, hostContended: true })
    })

    const snapshot = instrumentation.snapshot()

    // Same window, both halves: p95 5 ms of lag against a host running 3.5x
    // oversubscribed is a different verdict from the same lag on an idle box.
    expect(snapshot.eventLoopLag.p95Ms).toBe(5)
    expect(snapshot.host.loadPerCpu1m).toBe(3.5)
    expect(snapshot.host.hostContended).toBe(true)
    expect(snapshot.host.processCpuPercent).toBe(40)
  })

  it('degrades a throwing section to an error marker without failing the snapshot', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      sections: {
        broken: () => {
          throw new Error('stats source detached')
        },
        healthy: () => 3
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.sections.broken).toEqual({ error: 'stats source detached' })
    expect(snapshot.sections.healthy).toBe(3)
  })

  it('passes the window reset through to the meter', () => {
    const { meter, resets } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({ meter })
    instrumentation.snapshot()
    instrumentation.snapshot({ resetLagWindow: true })

    expect(resets).toEqual([0, 1])
  })

  it('wires workSpans section from the actual main recorder', () => {
    const { meter } = fakeMeter()
    const mainRecorder = createWorkSpanRecorder({ process: 'main', maxRetained: 4096 })
    const instrumentation = createMainPerfInstrumentation({
      meter,
      hostLoad: fakeHostLoad(),
      sections: {
        workSpans: mainRecorder.section
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.sections.workSpans).toBeDefined()
    expect(typeof snapshot.sections.workSpans).toBe('object')
    expect(snapshot.sections.workSpans).toHaveProperty('byKind')
    expect(snapshot.sections.workSpans).toHaveProperty('byResource')
  })
})

// ---------------------------------------------------------------------------
// M1 production-binding regression (Amendment A1.1).
//
// The wiring under test is three expressions in src/main/index.ts: the single
// main-process WorkSpanRecorder, the admission runtime that must receive THAT
// recorder as its scheduler span sink, and the perf instrumentation whose
// `workSpans` section must read THAT recorder's aggregates. Sever any one of
// them and every admission wait a light thread pays becomes invisible while the
// suites stay green.
//
// e8a08747a tried to pin this by slicing the initializer TEXT and asserting
// `toContain` substrings, then building a LOCAL recorder/scheduler/runtime and
// injecting a synthetic span through `scheduler['spans']`. Review3 executed the
// consequence: hiding the sink behind a dead branch
// (`schedulerOptions: false ? { spans: mainWorkSpanRecorder } : {}`) or
// commenting out either binding line left every required substring in place and
// the suite green. Only deleting the text outright reddened it.
//
// So these cases EVALUATE the extracted expressions. The three real factories
// are bound call-through, so the objects produced are the production ones;
// every other identifier the sections map touches is inert; and the proof is
// object identity plus one real `admission_wait` emitted by the scheduler's own
// path under genuinely held capacity. The mutants at the bottom are applied to
// the extracted source text and evaluated, so each reds a named assertion.
// ---------------------------------------------------------------------------

const MAIN_INDEX_PATH = join(__dirname, '../index.ts')

/** Exact production expression text, located by AST node rather than by line. */
interface ProductionInitializers {
  recorder: string
  runtime: string
  instrumentation: string
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return undefined
}

/** The perf instrumentation call is identified by the section it must carry. */
function declaresWorkSpansSection(call: ts.CallExpression): boolean {
  const [argument] = call.arguments
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false
  return argument.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property) === 'sections' &&
      ts.isObjectLiteralExpression(property.initializer) &&
      property.initializer.properties.some((entry) => propertyName(entry) === 'workSpans')
  )
}

function readProductionInitializers(): ProductionInitializers {
  const source = readFileSync(MAIN_INDEX_PATH, 'utf8')
  const file = ts.createSourceFile(MAIN_INDEX_PATH, source, ts.ScriptTarget.Latest, true)
  const textOf = (node: ts.Node): string => source.slice(node.getStart(file), node.getEnd())

  let recorder: string | undefined
  let runtime: string | undefined
  let instrumentation: string | undefined

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'mainWorkSpanRecorder') recorder ??= textOf(node.initializer)
      if (node.name.text === 'ensembleHostAdmissionRuntime') runtime ??= textOf(node.initializer)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createMainPerfInstrumentation' &&
      declaresWorkSpansSection(node)
    ) {
      instrumentation ??= textOf(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  if (!recorder || !runtime || !instrumentation) {
    throw new Error(
      'main perf production initializers were not found in index.ts ' +
        `(recorder=${Boolean(recorder)} runtime=${Boolean(runtime)} instrumentation=${Boolean(instrumentation)})`
    )
  }
  return { recorder, runtime, instrumentation }
}

/**
 * Identifiers the expression reads from its enclosing scope. Property names and
 * parameters are excluded; everything left is bound explicitly (the real
 * factories) or inertly (whatever else the sections map happens to touch), so
 * this stays honest when production adds another section.
 */
function freeIdentifiers(expression: string): string[] {
  const file = ts.createSourceFile('expr.ts', `(${expression})`, ts.ScriptTarget.Latest, true)
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined
      const isMemberName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node
      const isPropertyKey =
        parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node
      const isParameterName = parent !== undefined && ts.isParameter(parent) && parent.name === node
      if (!isMemberName && !isPropertyKey && !isParameterName) names.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...names]
}

interface ProductionBinding {
  /** The recorder the FIRST production expression built. */
  recorder: WorkSpanRecorder
  runtime: EnsembleHostAdmissionRuntime
  instrumentation: MainPerfInstrumentation
  /** Whatever production handed to the admission runtime as its span sink. */
  schedulerSpansSink: unknown
  /** Whatever production registered as the `workSpans` section provider. */
  workSpansProvider: unknown
  advanceClock: (ms: number) => void
}

interface CapturedRuntimeOptions {
  schedulerOptions?: { spans?: unknown }
  scheduler?: { spans?: unknown }
}

/**
 * Evaluate the three production expressions verbatim. `Date.now` is swapped
 * before evaluation so the scheduler and recorder capture a clock this test
 * owns — production injects no clock, and an exact queue wait cannot be proven
 * against the wall clock.
 */
function evaluateProductionBinding(
  mutate: (initializers: ProductionInitializers) => ProductionInitializers = (given) => given
): ProductionBinding {
  const initializers = mutate(readProductionInitializers())

  let capturedRecorder: WorkSpanRecorder | undefined
  let capturedRuntimeOptions: CapturedRuntimeOptions | undefined
  let capturedInstrumentationOptions: { sections?: Record<string, unknown> } | undefined

  const inert = (): unknown => null
  const inertScope = new Proxy({}, { get: () => inert })

  const bindings: Record<string, unknown> = {
    createWorkSpanRecorder: (options: Parameters<typeof createWorkSpanRecorder>[0]) => {
      const made = createWorkSpanRecorder(options)
      capturedRecorder ??= made
      return made
    },
    EnsembleHostAdmissionRuntime: function CapturingRuntime(options: CapturedRuntimeOptions) {
      capturedRuntimeOptions = options
      return new EnsembleHostAdmissionRuntime(
        options as ConstructorParameters<typeof EnsembleHostAdmissionRuntime>[0]
      )
    },
    createMainPerfInstrumentation: (
      options: Parameters<typeof createMainPerfInstrumentation>[0]
    ) => {
      capturedInstrumentationOptions = options
      return createMainPerfInstrumentation(options)
    }
  }

  const body = [
    `const mainWorkSpanRecorder = (${initializers.recorder});`,
    `const ensembleHostAdmissionRuntime = (${initializers.runtime});`,
    `const mainPerfInstrumentationRef = (${initializers.instrumentation});`,
    'return { mainWorkSpanRecorder, ensembleHostAdmissionRuntime, mainPerfInstrumentationRef };'
  ].join('\n')

  const parameters = new Set<string>([
    ...freeIdentifiers(initializers.recorder),
    ...freeIdentifiers(initializers.runtime),
    ...freeIdentifiers(initializers.instrumentation)
  ])
  for (const local of [
    'mainWorkSpanRecorder',
    'ensembleHostAdmissionRuntime',
    'mainPerfInstrumentationRef'
  ]) {
    parameters.delete(local)
  }
  const parameterNames = [...parameters]

  const transpiled = ts.transpileModule(
    `(function (${parameterNames.join(', ')}) {\n"use strict";\n${body}\n})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText

  // Deliberate dynamic evaluation: the point of this suite is to run the
  // production expressions themselves. A hand-written copy of them is exactly
  // the local fixture Review3 rejected — it cannot notice production drifting.
  const factory = new Function(
    `"use strict"; var produce = ${transpiled}\n; return produce;`
  )() as (...values: unknown[]) => {
    mainWorkSpanRecorder: WorkSpanRecorder
    ensembleHostAdmissionRuntime: EnsembleHostAdmissionRuntime
    mainPerfInstrumentationRef: MainPerfInstrumentation
  }

  let clockMs = 1_700_000_000_000
  const realDateNow = Date.now
  let produced: ReturnType<typeof factory>
  try {
    Date.now = () => clockMs
    produced = factory(
      ...parameterNames.map((name) => (name in bindings ? bindings[name] : inertScope))
    )
  } finally {
    Date.now = realDateNow
  }

  if (!capturedRecorder) throw new Error('production expressions built no work-span recorder')

  return {
    recorder: capturedRecorder,
    runtime: produced.ensembleHostAdmissionRuntime,
    instrumentation: produced.mainPerfInstrumentationRef,
    schedulerSpansSink:
      capturedRuntimeOptions?.schedulerOptions?.spans ?? capturedRuntimeOptions?.scheduler?.spans,
    workSpansProvider: capturedInstrumentationOptions?.sections?.workSpans,
    advanceClock: (ms: number) => {
      clockMs += ms
    }
  }
}

const HEAVY_CHAT = 'chat-heavy-holder'
const LIGHT_CHAT = 'chat-light-waiter'
const LIGHT_WAIT_MS = 37

function assertProductionIdentityBindings(binding: ProductionBinding): void {
  expect(
    binding.schedulerSpansSink,
    'production admission scheduler spans sink is the production main recorder'
  ).toBe(binding.recorder)
  expect(
    binding.workSpansProvider,
    'production workSpans section provider is the production main recorder section'
  ).toBe(binding.recorder.section)
}

/**
 * Hold every real host slot with one heavy chat, make a light request actually
 * queue behind it, advance the owned clock by an exact amount and cancel. The
 * span is produced by the scheduler's own emission path — nothing is recorded
 * by hand — and must arrive in the production `workSpans` section.
 */
function assertRealQueuedWaitReachesWorkSpans(binding: ProductionBinding): WorkSpanAggregates {
  const { runtime, instrumentation } = binding
  const heldSlots = runtime.snapshot().occupancy.maxActive

  for (let index = 0; index < heldSlots; index += 1) {
    const held = runtime.reserve({
      runId: `heavy-${index}`,
      chatId: HEAVY_CHAT,
      provider: 'codex',
      kind: 'lane'
    })
    expect(held.kind, 'the heavy chat takes a real host slot').toBe('reserved')
  }

  const filled = runtime.snapshot().occupancy
  expect(filled.active, 'real host capacity is fully held before the light request').toBe(heldSlots)
  expect(filled.queued, 'nothing is queued before the light request').toBe(0)

  const light = runtime.reserve({
    runId: 'light-1',
    chatId: LIGHT_CHAT,
    participantId: 'light-participant',
    provider: 'codex',
    kind: 'lane'
  })
  if (light.kind !== 'reserved') {
    throw new Error(`the light request was rejected instead of queued: ${light.message}`)
  }
  expect(light.initialState, 'the light request really waits behind held capacity').toBe('queued')

  binding.advanceClock(LIGHT_WAIT_MS)
  light.cancel('cancelled while queued behind the heavy chat')

  const settled = runtime.snapshot().occupancy
  expect(
    settled.active,
    'cancelling the queued light request leaves host occupancy unchanged'
  ).toBe(heldSlots)
  expect(settled.queued, 'the light request left the queue').toBe(0)

  instrumentation.start()
  let section: unknown
  try {
    section = instrumentation.snapshot().sections.workSpans
  } finally {
    instrumentation.stop()
    runtime.shutdown()
  }

  expect(
    section,
    'the production workSpans section is present in the main perf snapshot'
  ).toBeDefined()
  const aggregates = section as WorkSpanAggregates
  expect(aggregates.process, 'the workSpans section reads a main-process recorder').toBe('main')

  const lightWait = aggregates.byChat[LIGHT_CHAT]?.admission_wait
  expect(
    lightWait,
    'the real queued light wait reaches the production workSpans section'
  ).toBeDefined()
  expect(lightWait?.count, 'the light chat paid exactly one admission wait').toBe(1)
  expect(lightWait?.totalMs, 'the light chat wait is attributed at its exact duration').toBe(
    LIGHT_WAIT_MS
  )
  expect(lightWait?.maxMs, 'the light chat wait maximum is that same wait').toBe(LIGHT_WAIT_MS)

  const heavyWait = aggregates.byChat[HEAVY_CHAT]?.admission_wait
  expect(heavyWait?.count, 'the heavy chat that held capacity is attributed separately').toBe(
    heldSlots
  )
  expect(heavyWait?.totalMs, 'the heavy chat never waited for a slot it already owned').toBe(0)

  return aggregates
}

function mutateProductionText(
  text: string,
  pattern: RegExp,
  replacement: string,
  label: string
): string {
  const mutated = text.replace(pattern, replacement)
  if (mutated === text) {
    throw new Error(`mutation "${label}" did not apply; the red-check would be vacuous`)
  }
  return mutated
}

interface ProductionMutant {
  name: string
  mutate: (initializers: ProductionInitializers) => ProductionInitializers
  identityFailure: RegExp
  behaviourFailure: RegExp
}

const PRODUCTION_MUTANTS: readonly ProductionMutant[] = [
  {
    name: 'scheduler spans option hidden behind a dead branch',
    mutate: (given) => ({
      ...given,
      runtime: mutateProductionText(
        given.runtime,
        /schedulerOptions:\s*(\{[^{}]*\})/,
        'schedulerOptions: false ? $1 : {}',
        'dead-branch schedulerOptions'
      )
    }),
    identityFailure: /production admission scheduler spans sink/,
    behaviourFailure: /real queued light wait reaches the production workSpans section/
  },
  {
    name: 'scheduler spans option commented out',
    mutate: (given) => ({
      ...given,
      runtime: mutateProductionText(
        given.runtime,
        /spans:\s*mainWorkSpanRecorder\s*,?/,
        '',
        'commented-out spans binding'
      )
    }),
    identityFailure: /production admission scheduler spans sink/,
    behaviourFailure: /real queued light wait reaches the production workSpans section/
  },
  {
    name: 'workSpans section commented out',
    mutate: (given) => ({
      ...given,
      instrumentation: mutateProductionText(
        given.instrumentation,
        /workSpans:\s*mainWorkSpanRecorder\.section\s*,?/,
        '',
        'commented-out workSpans binding'
      )
    }),
    identityFailure: /production workSpans section provider/,
    behaviourFailure: /production workSpans section is present in the main perf snapshot/
  },
  {
    name: 'workSpans section swapped to a disconnected recorder',
    mutate: (given) => ({
      ...given,
      instrumentation: mutateProductionText(
        given.instrumentation,
        /workSpans:\s*mainWorkSpanRecorder\.section/,
        "workSpans: createWorkSpanRecorder({ process: 'main', maxRetained: 4096 }).section",
        'swapped disconnected recorder'
      )
    }),
    identityFailure: /production workSpans section provider/,
    behaviourFailure: /real queued light wait reaches the production workSpans section/
  }
]

describe('main perf production binding (M1)', () => {
  it('binds one recorder across the admission scheduler and the perf snapshot', () => {
    assertProductionIdentityBindings(evaluateProductionBinding())
  })

  it('carries a real held-capacity queued light wait into the workSpans section', () => {
    const aggregates = assertRealQueuedWaitReachesWorkSpans(evaluateProductionBinding())

    // The whole point of byChat: the light thread's wait is separable from the
    // heavy thread that caused it. An aggregate-only reading cannot say this.
    expect(aggregates.byChat[LIGHT_CHAT]?.admission_wait?.totalMs).toBe(LIGHT_WAIT_MS)
    expect(aggregates.byChat[HEAVY_CHAT]?.admission_wait?.totalMs).toBe(0)
    expect(aggregates.byKind.admission_wait?.totalMs).toBe(LIGHT_WAIT_MS)
  })

  it.each(PRODUCTION_MUTANTS)(
    'reds when the production wiring is broken: $name',
    ({ mutate, identityFailure, behaviourFailure }) => {
      expect(() => assertProductionIdentityBindings(evaluateProductionBinding(mutate))).toThrow(
        identityFailure
      )
      expect(() => assertRealQueuedWaitReachesWorkSpans(evaluateProductionBinding(mutate))).toThrow(
        behaviourFailure
      )
    }
  )
})
