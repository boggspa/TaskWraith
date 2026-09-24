/**
 * Production bind for the host-native saturation driver
 * (`scripts/perf/hostNativeSaturation.cjs`).
 *
 * HostNodeRunAdmission already matches the driver method-for-method
 * (`acquire` / `inflightCount` / `queuedCount` / `cancelQueued`) with the
 * production reject codes. This adapter is the thin wrap that adds the
 * injected `persistProbe` the S3 scenario requires. A live Desktop persist
 * against an out-of-process Host is still the M2 HostQueuedStartInterference
 * regression — this bind does not invent one.
 */

import type { HostNodeRunAdmission } from './HostNodeRunAdmission'

export type HostNativeSaturationPersistProbe = () => Promise<unknown>

export function bindHostNodeRunAdmissionForSaturation(
  admission: HostNodeRunAdmission,
  persistProbe: HostNativeSaturationPersistProbe
) {
  return {
    acquire: (input: { commandId: string; threadId: string }) => admission.acquire(input),
    inflightCount: () => admission.inflightCount(),
    queuedCount: () => admission.queuedCount(),
    cancelQueued: (input: { threadId: string; commandId?: string }) =>
      admission.cancelQueued(input),
    persistProbe
  }
}
