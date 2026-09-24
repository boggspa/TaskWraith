/**
 * Main-process entry for the event-loop lag meter. The implementation moved
 * to src/host-shared/perf/EventLoopLagMeter (Independent Threads M1) so the
 * Host runtime can meter its own loop without importing src/main; every
 * existing main-process importer keeps this path.
 */
export * from '../../host-shared/perf/EventLoopLagMeter'
