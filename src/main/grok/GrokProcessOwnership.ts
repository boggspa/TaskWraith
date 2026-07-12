/**
 * Remove a provider's legacy/global process fallback only when it still points
 * at the process owned by the finishing run. Per-run RunManager ownership is
 * authoritative; this guard prevents a late close from erasing a newer run's
 * fallback handle.
 */
export function deleteCliProviderProcessIfOwned<K, P>(
  processes: Map<K, P>,
  provider: K,
  ownedProcess: P | null | undefined
): boolean {
  if (!ownedProcess || processes.get(provider) !== ownedProcess) return false
  processes.delete(provider)
  return true
}
