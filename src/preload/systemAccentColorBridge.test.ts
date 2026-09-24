import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SYSTEM_ACCENT_COLOR_CHANGED_CHANNEL,
  SYSTEM_ACCENT_COLOR_CHANNEL
} from '../shared/systemAccentColor'

const preloadSource = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

describe('system accent colour preload bridge', () => {
  it('exposes the read the renderer applies to --accent', () => {
    // `systemPreferences` is main-only, so this bridge is the renderer's ONLY
    // route to the desktop accent. Drop it and useAppearance silently falls
    // back to the theme accent forever — the app still paints, just wrong.
    expect(preloadSource).toContain('getSystemAccentColor: (): Promise<string | null> =>')
    expect(preloadSource).toContain('ipcRenderer.invoke(SYSTEM_ACCENT_COLOR_CHANNEL)')
  })

  it('subscribes to OS accent changes so no reload is needed', () => {
    expect(preloadSource).toContain(
      'onSystemAccentColorChanged: (callback: (color: string | null) => void) =>'
    )
    expect(preloadSource).toContain('ipcRenderer.on(SYSTEM_ACCENT_COLOR_CHANGED_CHANNEL, wrapped)')
    expect(preloadSource).toContain(
      'ipcRenderer.removeListener(SYSTEM_ACCENT_COLOR_CHANGED_CHANNEL, wrapped)'
    )
  })

  it('names the same channels main registers', () => {
    expect(SYSTEM_ACCENT_COLOR_CHANNEL).toBe('appearance:get-system-accent-color')
    expect(SYSTEM_ACCENT_COLOR_CHANGED_CHANNEL).toBe('system-accent-color-changed')
    expect(preloadSource).toContain("} from '../shared/systemAccentColor'")
  })
})
