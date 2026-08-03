/**
 * App Drive Background Input prototype — types only.
 * Candidate / RFC status. No production imports. No authority minting.
 */

export type DriveMode = 'background' | 'isolated' | 'foreground'

export type InterferenceDimension =
  | 'focus'
  | 'frontmostApp'
  | 'hostCursor'
  | 'keyboardTarget'
  | 'clipboardHash'
  | 'activation'
  | 'targetSuccess'
  | 'targetScopedHumanArbitration'

export type DimensionVerdict = 'pass' | 'fail' | 'unknown' | 'not_measured'

export type ActuationKind = 'observe_only' | 'dry_run_cgevent_post_to_pid' | 'cgevent_post_to_pid'

export type ForbiddenActuation =
  | 'global_cgevent_post'
  | 'cursor_warp'
  | 'clipboard_write'
  | 'activate_or_raise'
  | 'permission_prompt'
  | 'silent_foreground_fallback'

/** Host surface snapshot used before/after a candidate action. */
export type HostSnapshot = {
  capturedAtMs: number
  frontmostAppId: string | null
  focusedWindowId: string | null
  keyboardTargetPid: number | null
  hostCursor: { x: number; y: number } | null
  /** SHA-256 of clipboard text/bytes when measured; never stores contents. */
  clipboardHash: string | null
  targetIsActive: boolean
  targetPid: number | null
  /**
   * Human physical-input signal scope.
   * Production native path today is machine-global HID — that is NOT target-scoped.
   */
  humanInputScope: 'none' | 'global_hid' | 'target_scoped' | 'unknown'
  humanInputRecentOnTarget: boolean | null
  humanInputRecentElsewhere: boolean | null
}

export type DimensionResult = {
  dimension: InterferenceDimension
  verdict: DimensionVerdict
  before: unknown
  after: unknown
  detail: string
}

export type PerAppInterferenceResult = {
  schemaVersion: 1
  modeClaimed: DriveMode
  /** Always false for this candidate prototype — Background Drive is unshipped. */
  productionAuthority: false
  appId: string
  appLabel: string
  targetPid: number | null
  fixtureOwned: boolean
  actuation: ActuationKind
  dryRun: boolean
  startedAtMs: number
  finishedAtMs: number
  dimensions: DimensionResult[]
  /** True only when every required dimension is pass AND not dry-run-only. */
  nonInterferenceProven: boolean
  refused: Array<{ kind: ForbiddenActuation | string; reason: string }>
  notes: string[]
}

export type InterferenceReport = {
  schemaVersion: 1
  harness: 'scripts/appdrive-interference'
  prototype: 'prototypes/appdrive-background'
  generatedAtMs: number
  defaultDryRun: true
  results: PerAppInterferenceResult[]
  summary: {
    appsMeasured: number
    provenNonInterference: number
    failed: number
    unknown: number
    dryRunOnly: number
  }
}
