/**
 * App Drive dock — pure renderer helpers for the first-class App Drive panel.
 *
 * This module productizes the *existing* safe control projection (exact
 * run/window View & Control lease). It does not mint authority, invent
 * Background/Isolated Drive, or claim target-scoped native arbitration.
 *
 * Mode honesty for this slice: native Tier 4 is always labeled Foreground Drive.
 * Pause / Takeover / Stop are explicit session chrome; they do not expand input.
 */

export const APP_DRIVE_MODE = 'foreground' as const
export type AppDriveMode = typeof APP_DRIVE_MODE

export type AppDriveControlVerb = 'observe' | 'inspect' | 'click' | 'fill'

/** Explicit session chrome — not lease minting and not HID arbitration. */
export type AppDriveSessionLifecycle =
  | 'idle'
  | 'viewing'
  | 'driving'
  | 'paused'
  | 'takeover'
  | 'stopped'

export interface AppDriveDockTarget {
  readonly applicationName: string
  readonly windowTitle: string
  /** Display-only metadata. Never treat as authorization. */
  readonly bundleID?: string
}

export interface AppDriveDockControlView {
  readonly provider: string
  readonly allowedVerbs: readonly AppDriveControlVerb[]
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
  readonly approvedBy: 'user'
  readonly trustState: 'user-approved'
}

/**
 * Normalized cursor hint inside a dock preview (0..1). Display-only — never
 * warps the OS cursor or posts input events.
 */
export interface AppDriveVirtualCursorPoint {
  readonly x: number
  readonly y: number
  readonly label?: string
}

export interface AppDriveDockStatus {
  readonly chatId: string
  readonly observation: AppDriveDockTarget | null
  readonly control: AppDriveDockControlView | null
  readonly lifecycle: AppDriveSessionLifecycle
  /** Always `foreground` for the shipped native path this run. */
  readonly mode: AppDriveMode
  readonly warning?: string
  readonly virtualCursor?: AppDriveVirtualCursorPoint | null
  /** Optional preview frame (data URL / blob URL). Never required for status. */
  readonly previewFrameUrl?: string | null
}

export interface AppDriveLifecycleActionAvailability {
  readonly canPause: boolean
  readonly canResume: boolean
  readonly canTakeOver: boolean
  readonly canStop: boolean
  /** True when the panel should refuse presenting agent-act affordances. */
  readonly agentActionsRefused: boolean
}

const CONTROL_VERBS: readonly AppDriveControlVerb[] = Object.freeze([
  'observe',
  'inspect',
  'click',
  'fill'
])

export function isAppDriveControlVerb(value: unknown): value is AppDriveControlVerb {
  return value === 'observe' || value === 'inspect' || value === 'click' || value === 'fill'
}

export function modeChipLabel(mode: AppDriveMode = APP_DRIVE_MODE): string {
  return mode === 'foreground' ? 'Foreground Drive' : 'Foreground Drive'
}

/**
 * Permission disclosure for the current attachment — process-local View & Control,
 * never durable app-keyed trust.
 */
export function permissionDisclosureLabel(
  status: Pick<AppDriveDockStatus, 'observation' | 'control'>
): string {
  if (status.control) return 'View & Control · current launch'
  if (status.observation) return 'View only · Screen Watch'
  return 'No attachment'
}

export function lifecycleStatusLabel(lifecycle: AppDriveSessionLifecycle): string {
  switch (lifecycle) {
    case 'idle':
      return 'Idle'
    case 'viewing':
      return 'Viewing'
    case 'driving':
      return 'Driving'
    case 'paused':
      return 'Paused'
    case 'takeover':
      return 'Takeover'
    case 'stopped':
      return 'Stopped'
  }
}

/**
 * Derive a UI lifecycle when the host has not yet wired an explicit session
 * flag. Prefer an explicit lifecycle from the main session layer when present.
 */
export function deriveAppDriveLifecycle(input: {
  observation: AppDriveDockTarget | null
  control: AppDriveDockControlView | null
  paused?: boolean
  takeover?: boolean
  stopped?: boolean
}): AppDriveSessionLifecycle {
  if (input.stopped) return 'stopped'
  if (!input.observation && !input.control) return 'idle'
  if (input.takeover) return 'takeover'
  if (input.paused) return 'paused'
  if (input.control) return 'driving'
  return 'viewing'
}

export function lifecycleActionAvailability(
  lifecycle: AppDriveSessionLifecycle
): AppDriveLifecycleActionAvailability {
  switch (lifecycle) {
    case 'driving':
      return {
        canPause: true,
        canResume: false,
        canTakeOver: true,
        canStop: true,
        agentActionsRefused: false
      }
    case 'paused':
      return {
        canPause: false,
        canResume: true,
        canTakeOver: true,
        canStop: true,
        agentActionsRefused: true
      }
    case 'takeover':
      return {
        canPause: false,
        canResume: true,
        canTakeOver: false,
        canStop: true,
        agentActionsRefused: true
      }
    case 'viewing':
      return {
        canPause: false,
        canResume: false,
        canTakeOver: false,
        canStop: true,
        agentActionsRefused: true
      }
    case 'idle':
    case 'stopped':
      return {
        canPause: false,
        canResume: false,
        canTakeOver: false,
        canStop: false,
        agentActionsRefused: true
      }
  }
}

export function formatStepsRemaining(control: AppDriveDockControlView | null): string {
  if (!control) return '—'
  return `${control.stepsRemaining} / ${control.stepBudget}`
}

export function formatExpiry(
  expiresAt: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '—'
  const remainingMs = expiresAt - nowMs
  if (remainingMs <= 0) return 'Expired'
  const totalSeconds = Math.floor(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export function formatVerbList(verbs: readonly string[] | null | undefined): string {
  if (!verbs || verbs.length === 0) return '—'
  return verbs.join(', ')
}

export function targetPrimaryLabel(target: AppDriveDockTarget | null): string {
  if (!target) return 'No target'
  const name = target.applicationName.trim()
  return name || 'Unknown app'
}

export function targetSecondaryLabel(target: AppDriveDockTarget | null): string {
  if (!target) return ''
  const title = target.windowTitle.trim()
  return title || 'Untitled window'
}

/**
 * Clamp a display-only virtual cursor into the unit square. Out-of-range or
 * non-finite values hide the cursor rather than inventing a position.
 */
export function normalizeVirtualCursorPoint(
  point: AppDriveVirtualCursorPoint | null | undefined
): AppDriveVirtualCursorPoint | null {
  if (!point) return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null
  const label = typeof point.label === 'string' ? point.label.trim() : ''
  return Object.freeze({
    x: point.x,
    y: point.y,
    ...(label ? { label } : {})
  })
}

export function sanitizeControlVerbs(
  verbs: readonly unknown[] | null | undefined
): readonly AppDriveControlVerb[] {
  if (!verbs) return Object.freeze([...CONTROL_VERBS].slice(0, 0))
  const next = verbs.filter(isAppDriveControlVerb)
  return Object.freeze([...next])
}
