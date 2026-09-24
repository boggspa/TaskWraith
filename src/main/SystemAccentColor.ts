import { systemPreferences } from 'electron'
import { normalizeSystemAccentColor } from '../shared/systemAccentColor'

/**
 * Reads and watches the host OS accent colour on main's behalf.
 *
 * `systemPreferences` is a main-only module, so the renderer cannot ask the OS
 * itself — everything the app knows about the desktop's accent comes through
 * here. Two platform seams are folded in:
 *
 *  - `getAccentColor()` THROWS rather than returning a falsy value on hosts
 *    that cannot answer, so every read is guarded. A throw is reported as
 *    `null`, meaning "the theme's own accent stands".
 *  - change notification is platform-split. Windows and Linux emit
 *    `accent-color-changed`; macOS has no such event and instead posts the
 *    distributed `AppleColorPreferencesChangedNotification`.
 *
 * The dependencies are injected so both seams are exercisable without an
 * Electron host; `systemAccentColorSource` is the real binding.
 */
export interface SystemAccentColorDeps {
  readonly platform: NodeJS.Platform
  readonly getAccentColor: () => string
  readonly subscribeNotification: (event: string, callback: () => void) => number
  readonly unsubscribeNotification: (id: number) => void
  readonly onAccentColorChanged: (callback: () => void) => void
  readonly offAccentColorChanged: (callback: () => void) => void
}

export interface SystemAccentColorSource {
  /** The accent in force right now, or null when the host cannot report one. */
  read: () => string | null
  /**
   * Calls back only when the resolved colour actually CHANGES, and returns an
   * unsubscribe. The de-duplication is load-bearing rather than tidy: macOS
   * posts `AppleColorPreferencesChangedNotification` for highlight-colour and
   * appearance changes too, and the renderer's apply path rewrites ~20 root
   * attributes per call — enough to restart every infinite CSS animation
   * gated on one. A repeat notification must not reach it.
   */
  watch: (onChange: (color: string | null) => void) => () => void
}

export function createSystemAccentColorSource(
  deps: SystemAccentColorDeps
): SystemAccentColorSource {
  const read = (): string | null => {
    try {
      return normalizeSystemAccentColor(deps.getAccentColor())
    } catch {
      return null
    }
  }

  return {
    read,
    watch: (onChange) => {
      let last = read()
      const emitWhenChanged = (): void => {
        const next = read()
        if (next === last) return
        last = next
        onChange(next)
      }

      try {
        if (deps.platform === 'darwin') {
          const id = deps.subscribeNotification(
            'AppleColorPreferencesChangedNotification',
            emitWhenChanged
          )
          return () => {
            try {
              deps.unsubscribeNotification(id)
            } catch {
              // Teardown races app quit; a failed unsubscribe is not worth a crash.
            }
          }
        }
        deps.onAccentColorChanged(emitWhenChanged)
        return () => {
          try {
            deps.offAccentColorChanged(emitWhenChanged)
          } catch {
            // Same as above.
          }
        }
      } catch {
        // A host that cannot subscribe still reports its accent once at mount;
        // losing live updates is a smaller failure than losing the colour.
        return () => {}
      }
    }
  }
}

export const systemAccentColorSource: SystemAccentColorSource = createSystemAccentColorSource({
  platform: process.platform,
  getAccentColor: () => systemPreferences.getAccentColor(),
  subscribeNotification: (event, callback) =>
    systemPreferences.subscribeNotification(event, callback),
  unsubscribeNotification: (id) => systemPreferences.unsubscribeNotification(id),
  onAccentColorChanged: (callback) => {
    systemPreferences.on('accent-color-changed', callback)
  },
  offAccentColorChanged: (callback) => {
    systemPreferences.off('accent-color-changed', callback)
  }
})
