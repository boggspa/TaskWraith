import { describe, expect, it, vi } from 'vitest'
import { createMainPerfInstrumentation } from './MainPerfSnapshot'
import { createWorkSpanRecorder } from '../perf/WorkSpanRecorder'
import { EnsembleHostAdmissionScheduler } from '../services/EnsembleHostAdmissionScheduler'
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

  it('exercises the production index.ts recorder->runtime->snapshot binding via AST', () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')

    const indexPath = path.join(__dirname, '../index.ts')
    const indexSource = fs.readFileSync(indexPath, 'utf8')
    const sourceFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.Latest, true)

    interface ExtractedInit {
      name: string
      text: string
    }
    const extracted: ExtractedInit[] = []

    function visit(node: ts.Node) {
      if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0]
        if (
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          ts.isIdentifier(decl.name)
        ) {
          const n = decl.name.text
          if (n === 'mainWorkSpanRecorder' || n === 'ensembleHostAdmissionRuntime') {
            const start = decl.initializer.getStart(sourceFile)
            const end = decl.initializer.getEnd()
            extracted.push({ name: n, text: indexSource.slice(start, end) })
          }
        }
      }
      if (ts.isExpressionStatement(node)) {
        const expr = node.expression
        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = expr.left
          if (ts.isIdentifier(left) && left.text === 'mainPerfInstrumentationRef') {
            const start = expr.right.getStart(sourceFile)
            const end = expr.right.getEnd()
            extracted.push({
              name: 'mainPerfInstrumentationRef',
              text: indexSource.slice(start, end)
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(extracted.length).toBeGreaterThanOrEqual(3)
    const recorderInit = extracted.find((e) => e.name === 'mainWorkSpanRecorder')
    const runtimeInit = extracted.find((e) => e.name === 'ensembleHostAdmissionRuntime')
    const instrInit = extracted.find((e) => e.name === 'mainPerfInstrumentationRef')

    expect(recorderInit).toBeDefined()
    expect(runtimeInit).toBeDefined()
    expect(instrInit).toBeDefined()

    expect(recorderInit!.text).toContain('createWorkSpanRecorder')
    expect(runtimeInit!.text).toContain('EnsembleHostAdmissionRuntime')
    expect(runtimeInit!.text).toContain('spans: mainWorkSpanRecorder')
    expect(instrInit!.text).toContain('createMainPerfInstrumentation')
    expect(instrInit!.text).toContain('workSpans: mainWorkSpanRecorder.section')

    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 4096 })
    const scheduler = new EnsembleHostAdmissionScheduler({ spans: recorder })
    const runtime = new EnsembleHostAdmissionRuntime({ scheduler })
    const instrumentation = createMainPerfInstrumentation({
      sections: { workSpans: recorder.section }
    })

    instrumentation.start()
    runtime.reserve({ runId: 'L', chatId: 'C', provider: 'codex', kind: 'lane' as const })

    if (scheduler['spans']) {
      scheduler['spans'].record({
        process: 'main',
        chatId: 'C',
        runId: 'L',
        participantId: 'P-L',
        laneId: 'L',
        kind: 'admission_wait',
        startedAt: Date.now(),
        durationMs: 37,
        resource: 'ensemble_pool',
        bytes: 0,
        fallback: false,
        reason: 'queued'
      })
    }

    const snap = instrumentation.snapshot()
    const ws = snap.sections.workSpans as { byKind?: Record<string, any> }
    expect(ws.byKind?.admission_wait?.count).toBeGreaterThanOrEqual(1)
    expect(ws.byKind?.admission_wait?.totalMs).toBeGreaterThanOrEqual(37)
    instrumentation.stop()
  })

  it('fails when scheduler spans option is removed from index', () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 4096 })
    const scheduler = new EnsembleHostAdmissionScheduler()
    const runtime = new EnsembleHostAdmissionRuntime({ scheduler })
    const instrumentation = createMainPerfInstrumentation({
      sections: { workSpans: recorder.section }
    })

    instrumentation.start()
    runtime.reserve({ runId: 'D', chatId: 'DC', provider: 'codex', kind: 'lane' as const })

    const snap = instrumentation.snapshot()
    const ws = snap.sections.workSpans as { byKind?: Record<string, any> }
    expect(ws.byKind?.admission_wait?.count).toBeUndefined()
    instrumentation.stop()
  })

  it('fails when workSpans section is swapped to a different recorder', () => {
    const prodRecorder = createWorkSpanRecorder({ process: 'main', maxRetained: 4096 })
    const scheduler = new EnsembleHostAdmissionScheduler({ spans: prodRecorder })
    new EnsembleHostAdmissionRuntime({ scheduler })
    const fakeRecorder = createWorkSpanRecorder({ process: 'main', maxRetained: 4096 })

    const instrumentation = createMainPerfInstrumentation({
      sections: { workSpans: fakeRecorder.section }
    })
    instrumentation.start()

    prodRecorder.record({
      process: 'main',
      chatId: 'S',
      runId: 'S',
      participantId: 'P-S',
      laneId: 'S',
      kind: 'admission_wait',
      startedAt: Date.now(),
      durationMs: 50,
      resource: 'ensemble_pool',
      bytes: 0,
      fallback: false,
      reason: 'queued'
    })

    const snap = instrumentation.snapshot()
    const ws = snap.sections.workSpans as { byKind?: Record<string, any> }
    expect(ws.byKind?.admission_wait?.count).toBeUndefined()
    expect(prodRecorder.snapshot().byKind?.admission_wait?.count).toBe(1)
    instrumentation.stop()
  })
})
