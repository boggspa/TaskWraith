/**
 * Compare before/after host snapshots into machine-readable dimension results.
 */

import { cursorMoved } from './hostSnapshot'
import type {
  DimensionResult,
  HostSnapshot,
  InterferenceDimension
} from './types'

const REQUIRED: InterferenceDimension[] = [
  'focus',
  'frontmostApp',
  'hostCursor',
  'keyboardTarget',
  'clipboardHash',
  'activation',
  'targetSuccess',
  'targetScopedHumanArbitration'
]

export function diffHostSnapshots(input: {
  before: HostSnapshot
  after: HostSnapshot
  /** Did the candidate action claim success against the fixture target? */
  targetActionSucceeded: boolean | null
  /** dry-run cannot prove non-interference. */
  dryRun: boolean
}): DimensionResult[] {
  const { before, after, targetActionSucceeded, dryRun } = input
  const results: DimensionResult[] = []

  // focus
  if (before.focusedWindowId == null || after.focusedWindowId == null) {
    results.push({
      dimension: 'focus',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.focusedWindowId,
      after: after.focusedWindowId,
      detail: 'Focused window id unavailable for full comparison.'
    })
  } else if (before.focusedWindowId === after.focusedWindowId) {
    results.push({
      dimension: 'focus',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: before.focusedWindowId,
      after: after.focusedWindowId,
      detail: 'Focused window unchanged.'
    })
  } else {
    results.push({
      dimension: 'focus',
      verdict: 'fail',
      before: before.focusedWindowId,
      after: after.focusedWindowId,
      detail: 'Focused window changed — focus theft.'
    })
  }

  // frontmostApp
  if (before.frontmostAppId == null || after.frontmostAppId == null) {
    results.push({
      dimension: 'frontmostApp',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.frontmostAppId,
      after: after.frontmostAppId,
      detail: 'Frontmost app id unavailable.'
    })
  } else if (before.frontmostAppId === after.frontmostAppId) {
    results.push({
      dimension: 'frontmostApp',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: before.frontmostAppId,
      after: after.frontmostAppId,
      detail: 'Frontmost app unchanged.'
    })
  } else {
    results.push({
      dimension: 'frontmostApp',
      verdict: 'fail',
      before: before.frontmostAppId,
      after: after.frontmostAppId,
      detail: 'Frontmost app changed — activation/frontmost theft.'
    })
  }

  // hostCursor
  if (before.hostCursor == null || after.hostCursor == null) {
    results.push({
      dimension: 'hostCursor',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.hostCursor,
      after: after.hostCursor,
      detail: 'Host cursor position unavailable.'
    })
  } else if (!cursorMoved(before.hostCursor, after.hostCursor)) {
    results.push({
      dimension: 'hostCursor',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: before.hostCursor,
      after: after.hostCursor,
      detail: 'Host cursor position unchanged.'
    })
  } else {
    results.push({
      dimension: 'hostCursor',
      verdict: 'fail',
      before: before.hostCursor,
      after: after.hostCursor,
      detail: 'Host cursor moved — cursor/warp interference.'
    })
  }

  // keyboardTarget
  if (before.keyboardTargetPid == null || after.keyboardTargetPid == null) {
    results.push({
      dimension: 'keyboardTarget',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.keyboardTargetPid,
      after: after.keyboardTargetPid,
      detail: 'Keyboard target pid unavailable.'
    })
  } else if (before.keyboardTargetPid === after.keyboardTargetPid) {
    results.push({
      dimension: 'keyboardTarget',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: before.keyboardTargetPid,
      after: after.keyboardTargetPid,
      detail: 'Keyboard target pid unchanged.'
    })
  } else {
    results.push({
      dimension: 'keyboardTarget',
      verdict: 'fail',
      before: before.keyboardTargetPid,
      after: after.keyboardTargetPid,
      detail: 'Keyboard target changed — keyboard focus theft.'
    })
  }

  // clipboardHash
  if (before.clipboardHash == null || after.clipboardHash == null) {
    results.push({
      dimension: 'clipboardHash',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.clipboardHash,
      after: after.clipboardHash,
      detail: 'Clipboard hash unavailable (contents never stored).'
    })
  } else if (before.clipboardHash === after.clipboardHash) {
    results.push({
      dimension: 'clipboardHash',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: before.clipboardHash,
      after: after.clipboardHash,
      detail: 'Clipboard hash unchanged.'
    })
  } else {
    results.push({
      dimension: 'clipboardHash',
      verdict: 'fail',
      before: before.clipboardHash,
      after: after.clipboardHash,
      detail: 'Clipboard changed — clipboard interference.'
    })
  }

  // activation (target became active when it was not, or frontmost flipped onto target)
  const activationStole =
    before.targetIsActive === false && after.targetIsActive === true
  if (dryRun) {
    results.push({
      dimension: 'activation',
      verdict: 'not_measured',
      before: before.targetIsActive,
      after: after.targetIsActive,
      detail: 'Dry-run does not measure live activation side effects.'
    })
  } else if (activationStole) {
    results.push({
      dimension: 'activation',
      verdict: 'fail',
      before: before.targetIsActive,
      after: after.targetIsActive,
      detail: 'Target became active — activation theft (Background Drive forbids this).'
    })
  } else {
    results.push({
      dimension: 'activation',
      verdict: 'pass',
      before: before.targetIsActive,
      after: after.targetIsActive,
      detail: 'No activation theft detected.'
    })
  }

  // targetSuccess
  if (targetActionSucceeded == null) {
    results.push({
      dimension: 'targetSuccess',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: null,
      after: targetActionSucceeded,
      detail: dryRun
        ? 'Dry-run does not deliver events; target success not proven.'
        : 'Target success unknown.'
    })
  } else if (targetActionSucceeded) {
    results.push({
      dimension: 'targetSuccess',
      verdict: dryRun ? 'not_measured' : 'pass',
      before: null,
      after: true,
      detail: 'Action reported success on fixture target.'
    })
  } else {
    results.push({
      dimension: 'targetSuccess',
      verdict: 'fail',
      before: null,
      after: false,
      detail: 'Action did not succeed on fixture target.'
    })
  }

  // targetScopedHumanArbitration
  // Background Drive acceptance requires target-scoped human sensing.
  // Global HID (today's production native path) is explicitly not sufficient.
  if (after.humanInputScope === 'target_scoped') {
    const canDiscriminate =
      after.humanInputRecentOnTarget !== null &&
      after.humanInputRecentElsewhere !== null
    results.push({
      dimension: 'targetScopedHumanArbitration',
      verdict: canDiscriminate ? (dryRun ? 'not_measured' : 'pass') : 'unknown',
      before: before.humanInputScope,
      after: {
        scope: after.humanInputScope,
        onTarget: after.humanInputRecentOnTarget,
        elsewhere: after.humanInputRecentElsewhere
      },
      detail: canDiscriminate
        ? 'Target-scoped human arbitration signals present.'
        : 'Scope claimed target_scoped but discrimination signals missing.'
    })
  } else if (after.humanInputScope === 'global_hid') {
    results.push({
      dimension: 'targetScopedHumanArbitration',
      verdict: 'fail',
      before: before.humanInputScope,
      after: after.humanInputScope,
      detail:
        'Only global HID idle is available (matches current production native path). Not target-scoped; Background Drive must not claim target-only pause.'
    })
  } else {
    results.push({
      dimension: 'targetScopedHumanArbitration',
      verdict: dryRun ? 'not_measured' : 'unknown',
      before: before.humanInputScope,
      after: after.humanInputScope,
      detail: 'Target-scoped human arbitration not available.'
    })
  }

  // Ensure all required dimensions present
  for (const dim of REQUIRED) {
    if (!results.some((r) => r.dimension === dim)) {
      results.push({
        dimension: dim,
        verdict: 'unknown',
        before: null,
        after: null,
        detail: 'Dimension missing from diff — fail closed as unknown.'
      })
    }
  }

  return results
}

export function isNonInterferenceProven(
  dimensions: DimensionResult[],
  dryRun: boolean
): boolean {
  if (dryRun) return false
  return dimensions.every((d) => d.verdict === 'pass')
}
