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
}

export interface SimulatorScreenshotFrame {
  pngBase64: string
  width: number
  height: number
  capturedAt: string
  udid: string
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
  'Preview only — attach Simulator in Screen Watch and approve View & Control for tap/type/scroll' as const

/** Actuation through App Drive / NativeWindowCoordinator is a later slice. */
export const SIMULATOR_GESTURE_ACTUATION_DEFERRED =
  'View & Control lease is present, but Simulator Canvas tap/type/scroll actuation is not wired yet' as const

export interface SimulatorInteractionStatus {
  canControl: boolean
  reason: string
  /** Screen Watch observation attached for this chat (preview path). */
  hasObservation: boolean
}

export interface SimulatorGestureResult {
  ok: boolean
  error?: string
  /** True when intent was accepted under an active lease (no desktop actuation yet). */
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
