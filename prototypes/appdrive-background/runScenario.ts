/**
 * Observe → (dry-run act) → re-observe scenario runner for Background Drive.
 * Default dry-run. Never imports production App Drive code.
 */

import { attemptCgEventPostToPid, type EventSpec } from './cgeventPostToPid'
import { DEFAULT_FIXTURE_TARGET, type FixtureTarget } from './fixtureTarget'
import { createSyntheticSnapshot } from './hostSnapshot'
import { diffHostSnapshots, isNonInterferenceProven } from './interferenceDiff'
import type { HostSnapshot, InterferenceReport, PerAppInterferenceResult } from './types'

export type ScenarioApp = {
  appId: string
  appLabel: string
  /** Optional injected before/after for pure tests / offline harness. */
  before?: HostSnapshot
  after?: HostSnapshot
  target?: FixtureTarget
}

export type RunScenarioOptions = {
  apps: ScenarioApp[]
  mode?: 'observe_only' | 'dry_run' | 'live_post'
  event?: EventSpec
  explicitUserInvocation?: boolean
  envAllowPost?: boolean
  nowMs?: () => number
}

function defaultBefore(app: ScenarioApp, now: number): HostSnapshot {
  return createSyntheticSnapshot({
    capturedAtMs: now,
    frontmostAppId: 'com.apple.Terminal',
    focusedWindowId: 'win-terminal-1',
    keyboardTargetPid: 4242,
    hostCursor: { x: 100, y: 200 },
    clipboardHash: 'sha256:dryrun-clipboard-placeholder',
    targetIsActive: false,
    targetPid: app.target?.pid ?? null,
    humanInputScope: 'global_hid',
    humanInputRecentOnTarget: null,
    humanInputRecentElsewhere: null
  })
}

function defaultAfterUnchanged(before: HostSnapshot, now: number): HostSnapshot {
  return {
    ...before,
    capturedAtMs: now
  }
}

export function runAppScenario(
  app: ScenarioApp,
  options: Omit<RunScenarioOptions, 'apps'>
): PerAppInterferenceResult {
  const now = options.nowMs ?? (() => Date.now())
  const startedAtMs = now()
  const target: FixtureTarget = app.target ?? {
    ...DEFAULT_FIXTURE_TARGET,
    appId: app.appId,
    appLabel: app.appLabel
  }
  const mode = options.mode ?? 'dry_run'
  const event: EventSpec = options.event ?? { type: 'key', keyCode: 0, down: true }

  const before = app.before ?? defaultBefore(app, startedAtMs)
  const post = attemptCgEventPostToPid({
    target,
    event,
    mode,
    explicitUserInvocation: options.explicitUserInvocation,
    envAllowPost: options.envAllowPost
  })

  const finishedAtMs = now()
  const after =
    app.after ??
    (post.posted
      ? defaultAfterUnchanged(before, finishedAtMs)
      : defaultAfterUnchanged(before, finishedAtMs))

  const dryRun = post.dryRun || mode !== 'live_post'
  const dimensions = diffHostSnapshots({
    before,
    after,
    targetActionSucceeded: post.posted ? true : null,
    dryRun
  })

  const refused: PerAppInterferenceResult['refused'] = []
  if (!post.policy.allow) {
    refused.push({ kind: post.policy.refused, reason: post.policy.reason })
  } else if (post.actuation === 'refused') {
    // live path without native impl
    const p = post.policy
    if (!p.allow) {
      refused.push({ kind: p.refused, reason: p.reason })
    }
  }

  const notes = [post.message]
  if (dryRun) {
    notes.push(
      'Dry-run/observe-only: nonInterferenceProven remains false by design until live interference passes.'
    )
  }
  if (after.humanInputScope === 'global_hid') {
    notes.push(
      'Human arbitration is global HID (production-like), not target-scoped — Background Drive claim blocked.'
    )
  }

  return {
    schemaVersion: 1,
    modeClaimed: 'background',
    productionAuthority: false,
    appId: app.appId,
    appLabel: app.appLabel,
    targetPid: target.pid,
    fixtureOwned: target.ownedByHarness === true,
    actuation:
      post.actuation === 'refused'
        ? dryRun
          ? 'dry_run_cgevent_post_to_pid'
          : 'observe_only'
        : post.actuation,
    dryRun,
    startedAtMs,
    finishedAtMs,
    dimensions,
    nonInterferenceProven: isNonInterferenceProven(dimensions, dryRun),
    refused,
    notes
  }
}

export function runInterferenceScenarios(options: RunScenarioOptions): InterferenceReport {
  const now = options.nowMs ?? (() => Date.now())
  const results = options.apps.map((app) => runAppScenario(app, options))
  let proven = 0
  let failed = 0
  let unknown = 0
  let dryRunOnly = 0
  for (const r of results) {
    if (r.dryRun) dryRunOnly += 1
    if (r.nonInterferenceProven) proven += 1
    if (r.dimensions.some((d) => d.verdict === 'fail')) failed += 1
    else if (r.dimensions.some((d) => d.verdict === 'unknown' || d.verdict === 'not_measured'))
      unknown += 1
  }
  return {
    schemaVersion: 1,
    harness: 'scripts/appdrive-interference',
    prototype: 'prototypes/appdrive-background',
    generatedAtMs: now(),
    defaultDryRun: true,
    results,
    summary: {
      appsMeasured: results.length,
      provenNonInterference: proven,
      failed,
      unknown,
      dryRunOnly
    }
  }
}
