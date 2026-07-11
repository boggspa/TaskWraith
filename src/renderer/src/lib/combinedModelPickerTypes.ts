/**
 * Pure data shapes shared by the model picker and provider-default catalogs.
 * Keep these outside the React component so main-process parity tests can
 * validate the catalogs without pulling the renderer UI graph into the node
 * TypeScript project.
 */
export interface CombinedModelPickerModelOption {
  id: string
  label: string
  disabled?: boolean
  disabledReason?: string
  /** Provider metadata retained for atomic cross-provider/new-seat defaults. */
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string | null
  additionalSpeedTiers?: string[]
  /** 1.0.7-mini — ISO date (YYYY-MM-DD) when the provider is retiring this
   * model. When present, the picker row renders a small clock + ordinal-
   * date pill in red to flag the deprecation without baking it into the
   * label string (which previously flashed on first paint then resolved
   * away via modelDisplayName, and wasn't machine-readable). Optional;
   * non-retiring models pass undefined. */
  retiresAt?: string
}

export interface CombinedModelPickerReasoningOption {
  /** Internal token (e.g. 'low' | 'medium' | 'high' | 'xhigh' | 'off'). */
  value: string
  /** Human-readable label as it should appear in the popover row. */
  label: string
  disabled?: boolean
  disabledReason?: string
}
