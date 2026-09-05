/**
 * Managed-policy lock predicates for the Settings panel — extracted from
 * `../SettingsPanel.tsx` (behavior-preserving move).
 *
 * The status blob is whatever `window.api.getManagedPolicyStatus()` returned,
 * so it stays deliberately opaque: every field is read defensively rather than
 * typed, because an MDM payload can omit or mistype any key.
 */

export type ManagedPolicyStatus = Record<string, unknown>

export function managedPolicySettingList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
}

export function isManagedPolicySettingLocked(
  status: ManagedPolicyStatus | null | undefined,
  setting: string
): boolean {
  if (status?.active !== true) return false
  return (
    managedPolicySettingList(status.lockedSettings).includes(setting) ||
    managedPolicySettingList(status.enforcedSettings).includes(setting)
  )
}
