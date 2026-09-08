/**
 * One pollable bundle for "is the Host process healthy, and if not, which
 * thread's work is eating it" (Independent Threads Programme M1).
 *
 * Mirrors createMainPerfInstrumentation's start/stop/snapshot contract for
 * the Host runtime: the Host had no loop-lag meter before M1, so S2/S5
 * stalls (command chain, record persistence) were invisible outside a
 * hand-attached profiler. `eventLoopLag` says THAT the Host loop stalled;
 * the `workSpans` section — a Host-process WorkSpanRecorder exposed as
 * `.spans` so the composition root can hand begin/record to Host
 * subsystems — says WHICH chat/run/kind paid for it in the same window.
 * Extra sections are read-only closures supplied by the composition root,
 * and every section degrades to `{ error }` independently: diagnostics
 * that crash under the load they exist to diagnose are worse than none.
 *
 * Both dependencies come from src/host-shared/perf; this module must not
 * import src/main (the packaged standalone Host excludes that tree).
 */
import {
  createEventLoopLagMeter,
  type EventLoopLagMeter,
  type EventLoopLagSnapshot
} from '../host-shared/perf/EventLoopLagMeter'
import { createWorkSpanRecorder, type WorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'

export interface HostPerfSnapshot {
  capturedAt: string
  eventLoopLag: EventLoopLagSnapshot
  sections: Record<string, unknown>
}

export interface HostPerfInstrumentation {
  start(): void
  stop(): void
  snapshot(options?: { resetLagWindow?: boolean }): HostPerfSnapshot
  /**
   * The Host-process recorder behind the `workSpans` section. The
   * composition root hands `spans.begin`/`spans.record` to the S2/S3/S5
   * seams; the section stays bounded because it reads aggregates only.
   */
  spans: WorkSpanRecorder
}

export interface HostPerfInstrumentationOptions {
  /** Injection seam for tests; production uses the native sampler. */
  meter?: EventLoopLagMeter
  /** Injection seam for tests; production constructs a Host recorder. */
  spans?: WorkSpanRecorder
  sections?: Record<string, () => unknown>
  now?: () => Date
}

/** Ring bound for the default Host recorder; snapshots stay bounded. */
export const HOST_WORK_SPAN_MAX_RETAINED = 512

export function createHostPerfInstrumentation(
  options: HostPerfInstrumentationOptions = {}
): HostPerfInstrumentation {
  const meter = options.meter ?? createEventLoopLagMeter()
  const spans =
    options.spans ??
    createWorkSpanRecorder({ process: 'host', maxRetained: HOST_WORK_SPAN_MAX_RETAINED })
  const now = options.now ?? (() => new Date())
  // The recorder's own section wins over a caller-supplied workSpans entry:
  // this instrumentation exists to make the Host recorder pollable.
  const sections = { ...options.sections, workSpans: spans.section }

  const snapshot = (snapshotOptions?: { resetLagWindow?: boolean }): HostPerfSnapshot => {
    const collected: Record<string, unknown> = {}
    for (const [name, provider] of Object.entries(sections)) {
      try {
        collected[name] = provider() ?? null
      } catch (error) {
        collected[name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      capturedAt: now().toISOString(),
      eventLoopLag: meter.snapshot({ reset: snapshotOptions?.resetLagWindow }),
      sections: collected
    }
  }

  return {
    start: () => meter.start(),
    stop: () => meter.stop(),
    snapshot,
    spans
  }
}
