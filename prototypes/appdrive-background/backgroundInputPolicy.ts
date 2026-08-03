/**
 * Hard safety policy for the Background Drive input prototype.
 * Defaults to dry-run / observe-only. Never expands production authority.
 */

import type { ActuationKind, ForbiddenActuation } from './types'
import { isHarnessOwnedFixture, type FixtureTarget } from './fixtureTarget'

export type PolicyDecision =
  | { allow: true; actuation: ActuationKind; dryRun: boolean }
  | { allow: false; refused: ForbiddenActuation | string; reason: string }

export type PostRequest = {
  /** Requested actuation mode. Default dry-run. */
  mode?: 'observe_only' | 'dry_run' | 'live_post'
  /** Must be harness-owned for any post path. */
  target: FixtureTarget
  /** Explicit user flag required for live post (CLI --allow-live-post). */
  explicitUserInvocation?: boolean
  /** Env gate APPDRIVE_BG_ALLOW_POST=1 also required for live post. */
  envAllowPost?: boolean
  /** Attempted operation name for audit. */
  operation: string
}

const FORBIDDEN_OPS: Record<string, ForbiddenActuation> = {
  global_cgevent_post: 'global_cgevent_post',
  cgevent_post: 'global_cgevent_post',
  cursor_warp: 'cursor_warp',
  warp_cursor: 'cursor_warp',
  clipboard_write: 'clipboard_write',
  clipboard_type: 'clipboard_write',
  activate: 'activate_or_raise',
  raise: 'activate_or_raise',
  activate_or_raise: 'activate_or_raise',
  permission_prompt: 'permission_prompt',
  silent_foreground_fallback: 'silent_foreground_fallback'
}

export function evaluateBackgroundInputPolicy(req: PostRequest): PolicyDecision {
  const op = req.operation.trim().toLowerCase()
  if (op in FORBIDDEN_OPS) {
    return {
      allow: false,
      refused: FORBIDDEN_OPS[op],
      reason: `Forbidden operation "${req.operation}" is never permitted in Background Drive prototype.`
    }
  }

  if (op === 'cgevent_post_global' || op === 'cgeventpost') {
    return {
      allow: false,
      refused: 'global_cgevent_post',
      reason: 'Global CGEventPost is forbidden; only CGEventPostToPid to a harness fixture may be prototyped.'
    }
  }

  if (!isHarnessOwnedFixture(req.target)) {
    return {
      allow: false,
      refused: 'non_fixture_target',
      reason: 'Target is not a harness-owned fixture; refusing any post/prototype actuation.'
    }
  }

  const mode = req.mode ?? 'dry_run'

  if (mode === 'observe_only') {
    return { allow: true, actuation: 'observe_only', dryRun: true }
  }

  if (mode === 'dry_run') {
    return { allow: true, actuation: 'dry_run_cgevent_post_to_pid', dryRun: true }
  }

  // live_post path — triple gate
  if (!req.explicitUserInvocation) {
    return {
      allow: false,
      refused: 'missing_explicit_user_invocation',
      reason: 'Live CGEventPostToPid requires explicit user invocation (--allow-live-post).'
    }
  }
  if (!req.envAllowPost) {
    return {
      allow: false,
      refused: 'missing_env_allow_post',
      reason: 'Live CGEventPostToPid requires APPDRIVE_BG_ALLOW_POST=1.'
    }
  }
  if (req.target.pid == null || req.target.pid <= 0) {
    return {
      allow: false,
      refused: 'missing_fixture_pid',
      reason: 'Live CGEventPostToPid requires a harness-owned fixture PID.'
    }
  }

  return { allow: true, actuation: 'cgevent_post_to_pid', dryRun: false }
}

/** Never silently fall back from background refusal to foreground control. */
export function refuseSilentForegroundFallback(reason: string): PolicyDecision {
  return {
    allow: false,
    refused: 'silent_foreground_fallback',
    reason: `Silent background→foreground fallback refused: ${reason}`
  }
}
