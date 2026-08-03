/**
 * Pure host-snapshot helpers for interference measurement.
 * No OS calls here — observers inject snapshots (real or synthetic).
 */

import type { HostSnapshot } from './types'

export function createSyntheticSnapshot(
  partial: Partial<HostSnapshot> & Pick<HostSnapshot, 'capturedAtMs'>
): HostSnapshot {
  return {
    frontmostAppId: partial.frontmostAppId ?? null,
    focusedWindowId: partial.focusedWindowId ?? null,
    keyboardTargetPid: partial.keyboardTargetPid ?? null,
    hostCursor: partial.hostCursor ?? null,
    clipboardHash: partial.clipboardHash ?? null,
    targetIsActive: partial.targetIsActive ?? false,
    targetPid: partial.targetPid ?? null,
    humanInputScope: partial.humanInputScope ?? 'unknown',
    humanInputRecentOnTarget: partial.humanInputRecentOnTarget ?? null,
    humanInputRecentElsewhere: partial.humanInputRecentElsewhere ?? null,
    capturedAtMs: partial.capturedAtMs
  }
}

export function cursorMoved(
  before: HostSnapshot['hostCursor'],
  after: HostSnapshot['hostCursor'],
  epsilon = 0.5
): boolean {
  if (before == null || after == null) return before !== after
  return Math.abs(before.x - after.x) > epsilon || Math.abs(before.y - after.y) > epsilon
}
