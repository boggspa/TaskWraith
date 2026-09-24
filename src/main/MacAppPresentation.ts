interface MacAppPresentationTarget {
  setActivationPolicy(policy: 'regular' | 'accessory'): void
  readonly dock?: {
    hide(): void
    show(): Promise<void>
  }
}

/**
 * Packaged macOS processes start as UI elements so helpers never acquire a
 * Dock tile before JavaScript runs. Only the primary desktop promotes itself.
 */
export function setMacAppPresentation(
  target: MacAppPresentationTarget,
  visible: boolean,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') return
  try {
    target.setActivationPolicy(visible ? 'regular' : 'accessory')
  } catch {
    // Use one native transition. Calling dock.hide/show after a successful
    // policy change starts a second, asynchronous macOS process transform.
    try {
      if (visible) void target.dock?.show().catch(() => undefined)
      else target.dock?.hide()
    } catch {
      // Presentation failure must not prevent a helper serving its client.
    }
  }
}
