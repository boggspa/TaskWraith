import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOW_IDLE_CLASS } from '../hooks/useWindowActive'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const readMainCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

describe('window idle ambient pause CSS', () => {
  it('registers the idle stylesheet from the main.css barrel', () => {
    expect(readMainCss()).toContain("@import url('./css/32-window-idle-pause.css')")
  })

  it('pauses animations under the idle class without killing transitions', () => {
    const css = readCss('32-window-idle-pause.css')
    const ruleStart = css.indexOf(`.${WINDOW_IDLE_CLASS}`)
    expect(ruleStart).toBeGreaterThanOrEqual(0)
    const ruleBody = css.slice(ruleStart)
    expect(ruleBody).toContain('animation-play-state: paused')
    // A property kill would break useRailFrameRemeasure's transitionend pin.
    expect(ruleBody).not.toMatch(/^\s*transition\s*:/m)
  })
})
