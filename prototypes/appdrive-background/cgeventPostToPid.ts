/**
 * CGEventPostToPid prototype surface.
 * Default: dry-run (no events posted).
 * Live post: harness fixture PID + explicit user invocation + env gate only.
 * Never implements global CGEventPost, cursor warp, clipboard, or activation.
 */

import {
  evaluateBackgroundInputPolicy,
  refuseSilentForegroundFallback,
  type PolicyDecision
} from './backgroundInputPolicy'
import type { FixtureTarget } from './fixtureTarget'
import type { ActuationKind } from './types'

export type EventSpec =
  | { type: 'key'; keyCode: number; down: boolean }
  | { type: 'mouse'; x: number; y: number; button: 'left'; phase: 'down' | 'up' | 'move' }

export type PostAttempt = {
  target: FixtureTarget
  event: EventSpec
  mode?: 'observe_only' | 'dry_run' | 'live_post'
  explicitUserInvocation?: boolean
  envAllowPost?: boolean
}

export type PostOutcome = {
  ok: boolean
  dryRun: boolean
  actuation: ActuationKind | 'refused'
  posted: boolean
  targetPid: number | null
  policy: PolicyDecision
  message: string
}

/**
 * Prototype post entry. Live OS posting is intentionally NOT implemented here.
 * A future native bridge may implement post only after interference proof;
 * this module refuses silent fallback and records dry-run attempts.
 */
export function attemptCgEventPostToPid(attempt: PostAttempt): PostOutcome {
  const policy = evaluateBackgroundInputPolicy({
    mode: attempt.mode ?? 'dry_run',
    target: attempt.target,
    explicitUserInvocation: attempt.explicitUserInvocation,
    envAllowPost: attempt.envAllowPost,
    operation: 'cgevent_post_to_pid'
  })

  if (!policy.allow) {
    return {
      ok: false,
      dryRun: true,
      actuation: 'refused',
      posted: false,
      targetPid: attempt.target.pid,
      policy,
      message: policy.reason
    }
  }

  if (policy.dryRun) {
    return {
      ok: true,
      dryRun: true,
      actuation: policy.actuation,
      posted: false,
      targetPid: attempt.target.pid,
      policy,
      message:
        policy.actuation === 'observe_only'
          ? 'Observe-only: no event synthesized.'
          : `Dry-run: would CGEventPostToPid(pid=${attempt.target.pid ?? 'null'}, event=${attempt.event.type}) — not posted.`
    }
  }

  // Live path: still no implementation in this candidate.
  // Refuse rather than invent native posting or fall back to foreground AX.
  const fallback = refuseSilentForegroundFallback(
    'Live CGEventPostToPid native implementation is not present in this candidate; refusing rather than falling back to foreground AX or global CGEventPost.'
  )
  return {
    ok: false,
    dryRun: false,
    actuation: 'refused',
    posted: false,
    targetPid: attempt.target.pid,
    policy: fallback,
    message: fallback.reason
  }
}

export function refuseGlobalCgEventPost(): PostOutcome {
  const policy = evaluateBackgroundInputPolicy({
    mode: 'live_post',
    target: {
      kind: 'harness_fixture',
      appId: 'invalid',
      appLabel: 'invalid',
      pid: 1,
      ownedByHarness: true
    },
    explicitUserInvocation: true,
    envAllowPost: true,
    operation: 'global_cgevent_post'
  })
  return {
    ok: false,
    dryRun: true,
    actuation: 'refused',
    posted: false,
    targetPid: null,
    policy,
    message: !policy.allow ? policy.reason : 'unexpected'
  }
}
