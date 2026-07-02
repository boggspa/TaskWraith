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
 * Spike 5 (docs/ensemble-posture-fanout-preamble-design.md) — slim ensemble
 * turn prompts for seats whose provider session natively resumes
 * (claude/codex/cursor). Opt-in while the prompt-shape change is validated:
 * the full ~5.5k-char shell re-sent every turn duplicates history those
 * sessions already hold.
 */
export function ensembleSlimResumeEnabled(): boolean {
  const value = process.env.TASKWRAITH_ENSEMBLE_SLIM_RESUME
  return value === '1' || value === 'true' || value === 'yes'
}

export function composerContenteditableEnabled(): boolean {
  const value = process.env.TASKWRAITH_COMPOSER_CONTENTEDITABLE
  return value === '1' || value === 'true' || value === 'yes'
}

export function channelGatewayEnabled(input?: {
  isPackaged?: boolean
  appName?: string
}): boolean {
  const disabled = process.env.TASKWRAITH_MESSAGES_BRIDGE === '0'
  if (disabled) return false
  const isPackaged = Boolean(input?.isPackaged)
  if (!isPackaged) return true
  return /\bdebug\b/i.test(input?.appName || '')
}

export const messagesBridgeEnabled = channelGatewayEnabled
