/**
 * User-facing Simulator control setup contract.
 *
 * This is intentionally separate from AppDrive: it only covers the optional
 * local companion required to actuate an iOS Simulator from Simulator Canvas.
 * The renderer receives product-state language here, never install commands or
 * dependency names.
 */

export const SIMULATOR_CONTROL_DISABLED_MESSAGE =
  'Simulator control is turned off in Settings.' as const

export type SimulatorControlSetupState = 'ready' | 'disabled' | 'setup_required' | 'unsupported'

export interface SimulatorControlSetupStatus {
  /** Whether the user has enabled simulator actuation. */
  enabled: boolean
  /** Whether this host can support the setup flow. */
  supported: boolean
  /** Whether the local control companion is ready to use. */
  ready: boolean
  state: SimulatorControlSetupState
  /** Plain-language copy suitable for Settings and the Canvas empty state. */
  message: string
}

export interface SimulatorControlSetupResult extends SimulatorControlSetupStatus {
  ok: boolean
  /** Plain-language failure copy; implementation details stay in local logs. */
  error?: string
}
