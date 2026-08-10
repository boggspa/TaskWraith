import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'

/**
 * Dock tiles are applied via `app.dock.setIcon` as-is (see AppIconManager).
 * macOS optical grid puts the squircle body at ~80.5% of the canvas
 * (824/1024 → 412/512) with a transparent margin. Full-bleed iOS exports
 * read ~24% larger next to native Dock icons — regression locked here after
 * Light Monoline landed without that pad (see fix 837d88cae).
 */
const DOCK_ICON_DIR = join(process.cwd(), 'resources/app-icon')
const CANVAS = 512
const EXPECTED_PAD = 50
const ALPHA_THRESHOLD = 8

function opaqueBounds(png: PNG): { left: number; top: number; right: number; bottom: number } {
  let left = png.width
  let top = png.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const alpha = png.data[(png.width * y + x) * 4 + 3]!
      if (alpha <= ALPHA_THRESHOLD) continue
      if (x < left) left = x
      if (y < top) top = y
      if (x > right) right = x
      if (y > bottom) bottom = y
    }
  }
  expect(right).toBeGreaterThanOrEqual(0)
  return { left, top, right, bottom }
}

describe('AppIconManager dock PNG optical grid', () => {
  it('pads every resources/app-icon tile to the 412/512 macOS icon grid', () => {
    const files = readdirSync(DOCK_ICON_DIR)
      .filter((name) => name.startsWith('icon-') && name.endsWith('.png'))
      .sort()
    expect(files.length).toBeGreaterThanOrEqual(8)
    expect(files).toContain('icon-light-monoline-light.png')
    expect(files).toContain('icon-light-monoline-dark.png')

    for (const name of files) {
      const png = PNG.sync.read(readFileSync(join(DOCK_ICON_DIR, name)))
      expect(png.width, name).toBe(CANVAS)
      expect(png.height, name).toBe(CANVAS)
      const { left, top, right, bottom } = opaqueBounds(png)
      expect(left, `${name} left pad`).toBe(EXPECTED_PAD)
      expect(top, `${name} top pad`).toBe(EXPECTED_PAD)
      expect(CANVAS - 1 - right, `${name} right pad`).toBe(EXPECTED_PAD)
      expect(CANVAS - 1 - bottom, `${name} bottom pad`).toBe(EXPECTED_PAD)
    }
  })
})
