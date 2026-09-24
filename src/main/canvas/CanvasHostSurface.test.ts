import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, WebContentsView: class {} }))

import { floatingChromeHtml, normalizeFloatingAddress } from './CanvasHostSurface'

describe('floating Canvas chrome', () => {
  it('gives every window the shared tab strip and inverse dock action', () => {
    for (const kind of ['web', 'sketch', 'emulator'] as const) {
      const html = floatingChromeHtml(kind)
      expect(html).toContain('class="tabs"')
      expect(html).toContain('id="tab-title"')
      expect(html).toContain('aria-label="Show canvas in dock"')
    }
  })

  it('adds full navigation and address chrome only to Browser windows', () => {
    const browser = floatingChromeHtml('web')
    expect(browser).toContain('aria-label="Back"')
    expect(browser).toContain('aria-label="Forward"')
    expect(browser).toContain('aria-label="Reload"')
    expect(browser).toContain('aria-label="Address"')

    const sketch = floatingChromeHtml('sketch')
    expect(sketch).toContain('Sketch Canvas')
    expect(sketch).not.toContain('aria-label="Address"')

    const emulator = floatingChromeHtml('emulator')
    expect(emulator).toContain('Emulator Canvas')
    expect(emulator).not.toContain('Sketch Canvas')
    expect(emulator).not.toContain('aria-label="Address"')
  })

  it('normalizes public and local addresses while refusing non-web schemes', () => {
    expect(normalizeFloatingAddress('example.test')).toBe('https://example.test/')
    expect(normalizeFloatingAddress('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeFloatingAddress('file:///tmp/secret')).toBeNull()
  })
})
