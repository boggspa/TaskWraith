export function ensembleWakeupsEnabled(): boolean {
  const value = process.env.TASKWRAITH_ENSEMBLE_WAKEUPS
  return value === '1' || value === 'true' || value === 'yes'
}

import { buildRuntimeFeatureGateSnapshot } from '../shared/runtimeFeatureGates'

export function concurrentLanesEnabled(): boolean {
  return buildRuntimeFeatureGateSnapshot(process.env).concurrentLanes
}

export function concurrentWriteLanesEnabled(): boolean {
  return buildRuntimeFeatureGateSnapshot(process.env).concurrentWriteLanes
}

/**
 * Spike 5 (the staged fan-out design) — slim ensemble
 * turn prompts for seats whose provider session natively resumes
 * (claude/codex): the full ~5.5k-char shell re-sent every turn
 * duplicates history those sessions already hold. Default ON (user opt-in,
 * 2026-07-02) with TASKWRAITH_ENSEMBLE_SLIM_RESUME=0 as the kill switch —
 * flip that if resumed seats start losing panel context on live rounds.
 */
export function ensembleSlimResumeEnabled(): boolean {
  const value = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
  return value !== '0' && value !== 'false' && value !== 'no'
}

export function composerContenteditableEnabled(): boolean {
  const value = process.env.TASKWRAITH_COMPOSER_CONTENTEDITABLE
  return value === '1' || value === 'true' || value === 'yes'
}
