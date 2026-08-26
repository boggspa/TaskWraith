// Re-export shim. Implementation moved to src/host-shared/pi/PiCliArgs.ts so the
// pure-Node Host can consume it without importing src/main (forbidden by
// src/host-node/hostNodeBoundary.test.ts). Public API unchanged.
export * from '../../host-shared/pi/PiCliArgs'
