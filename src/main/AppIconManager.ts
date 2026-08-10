import { app, nativeImage, nativeTheme } from 'electron'
import type { BrowserWindow, NativeImage } from 'electron'
import type { AppIconVariant } from '../shared/iconVariants'

// Runtime icon renditions (rounded-squircle, transparent corners). One light +
// one dark PNG per variant; the dock listener swaps between them by effective
// theme. electron-vite `?asset` returns a path that resolves in dev and packaged
// builds (same mechanism as the build-time `resources/icon.png`).
import iconRegularLight from '../../resources/app-icon/icon-regular-light.png?asset'
import iconRegularDark from '../../resources/app-icon/icon-regular-dark.png?asset'
import iconMonolineLight from '../../resources/app-icon/icon-monoline-light.png?asset'
import iconMonolineDark from '../../resources/app-icon/icon-monoline-dark.png?asset'
import iconGlassLight from '../../resources/app-icon/icon-glass-light.png?asset'
import iconGlassDark from '../../resources/app-icon/icon-glass-dark.png?asset'
import iconLightMonolineLight from '../../resources/app-icon/icon-light-monoline-light.png?asset'
import iconLightMonolineDark from '../../resources/app-icon/icon-light-monoline-dark.png?asset'

const ICON_PATHS: Record<AppIconVariant, { light: string; dark: string }> = {
  regular: { light: iconRegularLight, dark: iconRegularDark },
  monoline: { light: iconMonolineLight, dark: iconMonolineDark },
  glass: { light: iconGlassLight, dark: iconGlassDark },
  lightMonoline: { light: iconLightMonolineLight, dark: iconLightMonolineDark }
}

export interface AppIconManagerDeps {
  /** The persisted variant choice. A retired/unknown id falls back to the
   * monoline default at load time (see ICON_PATHS lookup). */
  getVariant: () => AppIconVariant
  /** The app's theme appearance setting ('system' | 'light' | 'dark' | named). */
  getThemeAppearance: () => string
  /** Windows whose icon to set on Windows/Linux (no-op target on macOS). */
  getWindows: () => BrowserWindow[]
}

let deps: AppIconManagerDeps | null = null
let listenerBound = false
let lastApplied: { variant: AppIconVariant; dark: boolean } | null = null

/**
 * Resolve whether the DARK icon rendition should be used.
 *   'light'  -> light, 'system' -> follow the OS, otherwise -> dark.
 * Every named theme (midnight, ocean, ...) renders on a dark base today, so the
 * catch-all is dark. Refine HERE (one place) if a light-based named theme lands.
 */
export function resolveEffectiveDark(themeAppearance: string, osDark: boolean): boolean {
  if (themeAppearance === 'light') return false
  if (themeAppearance === 'system') return osDark
  return true
}

function loadIcon(variant: AppIconVariant, dark: boolean): NativeImage {
  const set = ICON_PATHS[variant] ?? ICON_PATHS.monoline
  return nativeImage.createFromPath(dark ? set.dark : set.light)
}

/**
 * Apply the current variant x effective-theme icon to the live Dock (macOS) or
 * window/taskbar (Windows/Linux). On macOS this changes only the RUNNING dock
 * tile — it does not persist across relaunch and never touches the installed
 * Finder/Launchpad icon — so it must be re-applied on launch.
 */
export function applyAppIcon(force = false): void {
  if (!deps) return
  const variant = deps.getVariant()
  const dark = resolveEffectiveDark(deps.getThemeAppearance(), nativeTheme.shouldUseDarkColors)
  if (!force && lastApplied && lastApplied.variant === variant && lastApplied.dark === dark) {
    return // no-op guard: nativeTheme 'updated' fires on focus/Mission Control too
  }
  const image = loadIcon(variant, dark)
  if (image.isEmpty()) return // missing/invalid asset — leave the current icon
  if (process.platform === 'darwin') {
    app.dock?.setIcon(image)
  } else {
    for (const win of deps.getWindows()) {
      if (!win.isDestroyed()) win.setIcon(image)
    }
  }
  lastApplied = { variant, dark }
}

/**
 * Wire deps, bind the single OS-appearance listener (so 'system' theme swaps the
 * dock light/dark rendition automatically), and apply once now. Idempotent.
 */
export function startAppIconManager(next: AppIconManagerDeps): void {
  deps = next
  if (!listenerBound) {
    nativeTheme.on('updated', () => applyAppIcon())
    listenerBound = true
  }
  applyAppIcon(true)
}
