import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BOOT_MASK_REDUCED_MOTION_FADE_MS,
  BOOT_MASK_UNMOUNT_BUFFER_MS,
  BOOT_MASK_WIPE_MS,
  bootMaskUnmountDelayMs,
  prefersReducedMotion
} from './bootMaskTiming'

const css = readFileSync(join(__dirname, '..', 'assets', 'css', '16-boot-mask.css'), 'utf8')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('boot mask timing', () => {
  it('unmounts after the wipe, not on a flat timer', () => {
    expect(bootMaskUnmountDelayMs(false)).toBe(BOOT_MASK_WIPE_MS + BOOT_MASK_UNMOUNT_BUFFER_MS)
  })

  it('unmounts ~4x sooner under reduced motion, matching the shorter fade', () => {
    expect(bootMaskUnmountDelayMs(true)).toBe(
      BOOT_MASK_REDUCED_MOTION_FADE_MS + BOOT_MASK_UNMOUNT_BUFFER_MS
    )
    // The old behaviour was a flat 760 ms in both modes; that is the regression
    // this exists to prevent.
    expect(bootMaskUnmountDelayMs(true)).toBeLessThan(bootMaskUnmountDelayMs(false))
    expect(bootMaskUnmountDelayMs(true)).toBeLessThan(760)
  })

  it('keeps the JS timers in step with the stylesheet they wait on', () => {
    expect(css).toMatch(new RegExp(`animation:\\s*taskwraith-boot-wipe\\s+${BOOT_MASK_WIPE_MS}ms`))
    expect(css).toMatch(
      new RegExp(`animation:\\s*taskwraith-boot-fade\\s+${BOOT_MASK_REDUCED_MOTION_FADE_MS}ms`)
    )
  })

  it('releases pointer input and the drag region as soon as the mask starts leaving', () => {
    // A `-webkit-app-region: drag` overlay swallows clicks even with
    // pointer-events: none, so both have to be released together.
    const leaving = css.slice(css.indexOf('.app-boot-mask.is-leaving {'))
    const block = leaving.slice(0, leaving.indexOf('}'))
    expect(block).toMatch(/pointer-events:\s*none/)
    expect(block).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('reads the motion preference defensively', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query.includes('reduced-motion') })
    })
    expect(prefersReducedMotion()).toBe(true)

    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('unsupported')
      }
    })
    expect(prefersReducedMotion()).toBe(false)

    vi.stubGlobal('window', {})
    expect(prefersReducedMotion()).toBe(false)
  })
})
