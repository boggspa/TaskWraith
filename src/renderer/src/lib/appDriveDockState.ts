/**
 * App Drive dock — pure renderer helpers for the first-class App Drive panel.
 *
 * This module productizes the *existing* safe control projection (exact
 * run/window View & Control lease). It does not mint authority, invent
 * Background/Isolated Drive, or claim target-scoped native arbitration.
 *
 * Mode honesty for this slice: native Tier 4 is always labeled Foreground Drive.
 * Pause / Takeover / Stop are explicit session chrome; they do not expand input.
 *
 * Canonical lifecycle matches main session/authority models:
 * `idle | active | paused | takeover | stopped`.
 * Visible "Viewing" / "Driving" labels are derived from observation/control
 * presence while lifecycle is `active` — they are not separate states.
 */

export const APP_DRIVE_MODE = 'foreground' as const
export type AppDriveMode = typeof APP_DRIVE_MODE

export type AppDriveControlVerb = 'observe' | 'inspect' | 'click' | 'fill'

/**
 * Canonical session chrome lifecycle — aligned with AppDriveSession /
 * AppDriveAuthorityModel. Do not reintroduce viewing/driving as states.
 */
export type AppDriveSessionLifecycle = 'idle' | 'active' | 'paused' | 'takeover' | 'stopped'

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

/** Visible activity label while lifecycle is active (not a state machine value). */
export type AppDriveActivityLabel = 'Viewing' | 'Driving' | null

const CONTROL_VERBS: readonly AppDriveControlVerb[] = Object.freeze([
  'observe',
  'inspect',
  'click',
  'fill'
])

export const MODE_HONESTY_DESCRIPTION =
  'Native Tier 4 requires the selected app to be frontmost and focused. Background and Isolated Drive are not shipped in this panel.'

export const PERMISSION_HONESTY_DESCRIPTION =
  'Permission is for the current managed launch only — not durable app-keyed trust. Bundle ID is display metadata, not an approval key.'

export const PAUSE_VS_TAKEOVER_HELP =
  'Pause holds agent click/fill until Resume. Take Over marks you as driving; Resume returns agent control. Neither is target-scoped HID arbitration — native idle remains machine-wide.'

export function isAppDriveControlVerb(value: unknown): value is AppDriveControlVerb {
  return value === 'observe' || value === 'inspect' || value === 'click' || value === 'fill'
}

export function isAppDriveSessionLifecycle(value: unknown): value is AppDriveSessionLifecycle {
  return (
    value === 'idle' ||
    value === 'active' ||
    value === 'paused' ||
    value === 'takeover' ||
    value === 'stopped'
  )
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

/**
 * Derive Viewing/Driving display labels from attachment presence while the
 * canonical lifecycle is `active`. Other lifecycles keep their own labels.
 */
export function activityDisplayLabel(
  status: Pick<AppDriveDockStatus, 'observation' | 'control' | 'lifecycle'>
): AppDriveActivityLabel {
  if (status.lifecycle !== 'active') return null
  if (status.control) return 'Driving'
  if (status.observation) return 'Viewing'
  return null
}

export function lifecycleStatusLabel(
  lifecycle: AppDriveSessionLifecycle,
  status?: Pick<AppDriveDockStatus, 'observation' | 'control'>
): string {
  switch (lifecycle) {
    case 'idle':
      return 'Idle'
    case 'active': {
      const activity = activityDisplayLabel({
        lifecycle: 'active',
        observation: status?.observation ?? null,
        control: status?.control ?? null
      })
      return activity ?? 'Active'
    }
    case 'paused':
      return 'Paused'
    case 'takeover':
      return 'Takeover'
    case 'stopped':
      return 'Stopped'
  }
}

/**
 * Context-specific stop control label.
 * Observation-only → Detach Screen Watch; control lease → Stop control.
 */
export function stopControlLabel(
  status: Pick<AppDriveDockStatus, 'observation' | 'control'>
): string {
  if (status.control) return 'Stop control'
  if (status.observation) return 'Detach'
  return 'Stop'
}

/**
 * Derive a UI lifecycle when the host has not yet wired an explicit session
 * flag. Prefer an explicit lifecycle from the main session layer when present.
 * Returns only canonical states — never viewing/driving.
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
  return 'active'
}

export function lifecycleActionAvailability(
  lifecycle: AppDriveSessionLifecycle,
  status?: Pick<AppDriveDockStatus, 'observation' | 'control'>
): AppDriveLifecycleActionAvailability {
  const hasControl = Boolean(status?.control)
  const hasObservation = Boolean(status?.observation)

  switch (lifecycle) {
    case 'active':
      if (hasControl) {
        return {
          canPause: true,
          canResume: false,
          canTakeOver: true,
          canStop: true,
          agentActionsRefused: false
        }
      }
      // Observation-only: Detach is available; pause/takeover need control.
      return {
        canPause: false,
        canResume: false,
        canTakeOver: false,
        canStop: hasObservation,
        agentActionsRefused: true
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

/**
 * Announce lifecycle transitions for assistive tech (role=status consumers).
 */
export function lifecycleChangeAnnouncement(
  lifecycle: AppDriveSessionLifecycle,
  status?: Pick<AppDriveDockStatus, 'observation' | 'control'>
): string {
  const label = lifecycleStatusLabel(lifecycle, status)
  switch (lifecycle) {
    case 'idle':
      return 'App Drive idle. No target attached.'
    case 'active':
      return `App Drive ${label.toLowerCase()}.`
    case 'paused':
      return 'App Drive paused. Agent click and fill are held until Resume.'
    case 'takeover':
      return 'Human takeover active. You are driving; agent click and fill are refused until Resume.'
    case 'stopped':
      return 'App Drive stopped. Re-attach and approve View & Control to continue.'
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
