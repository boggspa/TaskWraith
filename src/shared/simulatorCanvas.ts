/**
 * Shared contracts for Simulator Canvas — chat-owned iOS Simulator dock surface.
 * Node-builtin-free so renderer, preload, and main can all import it.
 */

export const SIMULATOR_INSTALL_DOCS_URL = 'https://developer.apple.com/xcode/'

export type SimulatorFormFactor = 'phone' | 'tablet'

export interface SimulatorDevicePreset {
  id: string
  label: string
  formFactor: SimulatorFormFactor
  /** Logical CSS pixels for the bezel content area (not device points). */
  defaultLogicalSize: { width: number; height: number }
}

export const SIMULATOR_DEVICE_PRESETS: readonly SimulatorDevicePreset[] = [
  {
    id: 'iphone',
    label: 'iPhone',
    formFactor: 'phone',
    defaultLogicalSize: { width: 390, height: 844 }
  },
  {
    id: 'ipad',
    label: 'iPad',
    formFactor: 'tablet',
    defaultLogicalSize: { width: 820, height: 1180 }
  }
]

export interface SimulatorDeviceInfo {
  udid: string
  name: string
  state: string
  runtime?: string
  isAvailable?: boolean
}

export interface SimulatorCapabilityStatus {
  platform: string
  /** True when simctl works and Simulator.app is present on macOS. */
  installed: boolean
  simctlAvailable: boolean
  simulatorAppPath: string | null
  xcodeAppPath: string | null
  bootedDevices: SimulatorDeviceInfo[]
  availableDevices: SimulatorDeviceInfo[]
  installHint: string
  docsUrl: string
  /** True when the `idb` client resolves on PATH (opt-in actuation). */
  idbAvailable?: boolean
  /** True when `idb_companion` resolves on PATH. */
  idbCompanionAvailable?: boolean
}

export interface SimulatorScreenshotFrame {
  pngBase64: string
  /** Screenshot pixel extents (simctl PNG IHDR). Not idb coordinate space. */
  width: number
  height: number
  /**
   * Device-point extents for idb tap/swipe. Defaults to half the pixel size
   * (retina @2x) with a floor of 1; callers may override when AX root is known.
   */
  pointWidth: number
  pointHeight: number
  capturedAt: string
  udid: string
}

/** Derive idb point extents from screenshot pixels (default retina @2x). */
export function simulatorPointSizeFromPixels(
  width: number,
  height: number,
  override?: Partial<{ pointWidth: number; pointHeight: number }>
): { pointWidth: number; pointHeight: number } {
  const overrideW = override?.pointWidth
  const overrideH = override?.pointHeight
  return {
    pointWidth:
      typeof overrideW === 'number' && Number.isFinite(overrideW) && overrideW > 0
        ? Math.round(overrideW)
        : Math.max(1, Math.round(width / 2)),
    pointHeight:
      typeof overrideH === 'number' && Number.isFinite(overrideH) && overrideH > 0
        ? Math.round(overrideH)
        : Math.max(1, Math.round(height / 2))
  }
}

export interface SimulatorHostActionResult {
  ok: boolean
  error?: string
  udid?: string
  status?: SimulatorCapabilityStatus
  frame?: SimulatorScreenshotFrame
}

/** Honest View & Control gate for human bezel gestures (tap / type / scroll). */
export const SIMULATOR_VIEW_CONTROL_REQUIRED = 'View & Control required' as const

export const SIMULATOR_PREVIEW_ONLY_BANNER =
  'Preview only — enable Simulator control to use this device.' as const

/**
 * Recorded under a control lease but not actuated — typically idb missing, or no
 * session frame/udid yet for coordinate mapping.
 */
export const SIMULATOR_GESTURE_ACTUATION_DEFERRED =
  'Simulator control is not ready yet.' as const

export type SimulatorControllerKind = 'human' | 'run'

export interface SimulatorInteractionStatus {
  canControl: boolean
  /**
   * True only when idb is on PATH and a controller lease is held for the chat.
   * View & Control / preview alone never implies device drive.
   */
  actuationReady: boolean
  reason: string
  /** Screen Watch observation attached for this chat (preview path). */
  hasObservation: boolean
  /** Whether the `idb` client binary is available on this host. */
  idbAvailable?: boolean
  /** Whether SimulatorControllerLease currently holds this chat. */
  controllerLeaseHeld?: boolean
  /**
   * Who holds the controller lease when known (`human` dock vs agent `run`).
   * Absent/null when no lease is held.
   */
  controllerKind?: SimulatorControllerKind | null
  /** Agent controller lease expiry; null for human control/no lease. */
  controllerExpiresAt?: number | null
  /** Remaining agent actions in the current bounded lease. */
  controllerStepsRemaining?: number | null
  /** Display-only exact Simulator target; never an authority token. */
  controllerTarget?: { udid?: string; bundleId?: string } | null
  /**
   * Last absolute orientation stored on the chat session after a successful
   * IPC/MCP rotate. Absent until the first successful rotate in-process.
   */
  orientation?: SimulatorRotateDirection
}

export interface SimulatorGestureResult {
  ok: boolean
  error?: string
  /** True when intent was accepted under an active lease (may still be deferred). */
  recorded?: boolean
}

export interface SimulatorTapGesture {
  chatId: string
  /** Normalized 0..1 within the bezel content area. */
  x: number
  y: number
}

export interface SimulatorTypeGesture {
  chatId: string
  text: string
}

export interface SimulatorScrollGesture {
  chatId: string
  /** Normalized 0..1 pointer position within the bezel content area. */
  x: number
  y: number
  deltaX: number
  deltaY: number
}

/** idb `ui button` HID names — strict allowlist for MCP/IPC. */
export const SIMULATOR_HARDWARE_BUTTONS = [
  'APPLE_PAY',
  'HOME',
  'LOCK',
  'SIDE_BUTTON',
  'SIRI'
] as const

export type SimulatorHardwareButton = (typeof SIMULATOR_HARDWARE_BUTTONS)[number]

/**
 * Absolute orientations accepted by Facebook idb `ui rotate`
 * (`PORTRAIT` / `PORTRAIT_UPSIDE_DOWN` / `LANDSCAPE_LEFT` / `LANDSCAPE_RIGHT`).
 */
export const SIMULATOR_ROTATE_DIRECTIONS = [
  'PORTRAIT',
  'PORTRAIT_UPSIDE_DOWN',
  'LANDSCAPE_LEFT',
  'LANDSCAPE_RIGHT'
] as const

export type SimulatorRotateDirection = (typeof SIMULATOR_ROTATE_DIRECTIONS)[number]

/** Panel cycle order: portrait → landscape_right → portrait_upside_down → landscape_left. */
export const SIMULATOR_ROTATE_CYCLE: readonly SimulatorRotateDirection[] = [
  'PORTRAIT',
  'LANDSCAPE_RIGHT',
  'PORTRAIT_UPSIDE_DOWN',
  'LANDSCAPE_LEFT'
]

export function nextSimulatorRotateDirection(
  current: SimulatorRotateDirection
): SimulatorRotateDirection {
  const idx = SIMULATOR_ROTATE_CYCLE.indexOf(current)
  return SIMULATOR_ROTATE_CYCLE[(idx < 0 ? 0 : idx + 1) % SIMULATOR_ROTATE_CYCLE.length]!
}

export function isSimulatorHardwareButton(value: unknown): value is SimulatorHardwareButton {
  return (
    typeof value === 'string' &&
    (SIMULATOR_HARDWARE_BUTTONS as readonly string[]).includes(value)
  )
}

export function isSimulatorRotateDirection(value: unknown): value is SimulatorRotateDirection {
  return (
    typeof value === 'string' &&
    (SIMULATOR_ROTATE_DIRECTIONS as readonly string[]).includes(value)
  )
}

export interface SimulatorInspectResult {
  ok: boolean
  tree?: unknown
  error?: string
  truncated?: boolean
}

export const SIMULATOR_MISSING_MACOS_HINT =
  'Simulator Canvas needs Xcode’s Simulator.app and `xcrun simctl`. Install Xcode from the App Store or developer.apple.com, then open it once so the platforms install.'

export const SIMULATOR_UNSUPPORTED_PLATFORM_HINT =
  'Simulator Canvas requires macOS with Xcode’s iOS Simulator.'

export function simulatorInstallHint(platform: string): string {
  return platform === 'darwin' ? SIMULATOR_MISSING_MACOS_HINT : SIMULATOR_UNSUPPORTED_PLATFORM_HINT
}

export function isSimulatorFormFactor(value: unknown): value is SimulatorFormFactor {
  return value === 'phone' || value === 'tablet'
}

export function simulatorPresetById(id: string): SimulatorDevicePreset | null {
  return SIMULATOR_DEVICE_PRESETS.find((preset) => preset.id === id) ?? null
}
