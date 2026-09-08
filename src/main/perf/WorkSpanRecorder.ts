/**
 * Main-process entry for the cross-thread work-span recorder (M1). The
 * implementation lives in src/host-shared/perf so the standalone Host runtime
 * (which imports nothing from src/main) constructs its own recorder for
 * HostPerfSnapshot; main-side importers keep this path (pattern precedent:
 * src/main/host/HostCommandIdentity.ts).
 */
export * from '../../host-shared/perf/WorkSpanRecorder'
