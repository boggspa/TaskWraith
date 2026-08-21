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

/**
 * Selectors the idle pause must let finish.
 *
 * Each one carries a FINITE entrance animation whose first keyframe is
 * invisible (`opacity: 0`, or `height: 0` for the fan-out lane). A paused
 * animation rests on its 0% keyframe, so pausing these does not dim them —
 * it hides the content outright for as long as the window stays unfocused.
 * `.message-group` is every transcript row, which is why the whole transcript
 * read as "stopped delivering" while the user worked in another window.
 */
const IDLE_REVEAL_EXEMPT_SELECTORS = [
  '.message-group',
  '.transcript-message-block.is-stack-collapsing > *',
  '.transcript-message-block.is-super-lead-entering > *',
  '.seat-change-message.is-fresh .seat-change-row',
  '.ensemble-above-row-entering',
  '.ensemble-fanout-result-card.is-working .ensemble-fanout-result-viewport.is-collapsed > .live-activity-viewport-scroll',
  '.chat-context-application-pill',
  '.transcript-jump-to-latest-pill',
  '.composer-permission-card--overlay'
]

/** Selectors carrying the resumed declaration, with the idle prefix stripped. */
function resumedSelectors(css: string): string[] {
  const resumed: string[] = []
  // Comments first: a rule's leading comment would otherwise be read as part
  // of its selector and silently hide a real exemption from this scan.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /([^{}]+)\{([^}]*)\}/g
  let match = rule.exec(rules)
  while (match !== null) {
    if (/animation-play-state\s*:\s*running/.test(match[2])) {
      for (const selector of match[1].split(',')) {
        const trimmed = selector.trim().replace(/\s+/g, ' ')
        if (trimmed.startsWith(`.${WINDOW_IDLE_CLASS} `)) {
          resumed.push(trimmed.slice(`.${WINDOW_IDLE_CLASS} `.length))
        }
      }
    }
    match = rule.exec(rules)
  }
  return resumed
}

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

  it('finishes the timed approval reveal without resuming its ambient rim', () => {
    const css = readCss('32-window-idle-pause.css')

    expect(css).toMatch(
      new RegExp(
        `\\.${WINDOW_IDLE_CLASS} \\.composer-permission-card--overlay \\{[^}]*` +
          'animation-play-state: running !important;'
      )
    )
    expect(css).toContain(`.${WINDOW_IDLE_CLASS} *::before`)
    expect(css).not.toMatch(
      new RegExp(
        `\\.${WINDOW_IDLE_CLASS} \\.composer-permission-card--overlay::before \\{[^}]*` +
          'animation-play-state: running'
      )
    )
  })

  it('lets one-shot content reveals finish so nothing is held invisible', () => {
    const resumed = resumedSelectors(readCss('32-window-idle-pause.css'))
    for (const selector of IDLE_REVEAL_EXEMPT_SELECTORS) {
      expect(resumed).toContain(selector)
    }
  })

  it('resumes each exempt reveal with !important so the blanket pause loses', () => {
    const css = readCss('32-window-idle-pause.css')
    const declarations = css.match(/animation-play-state\s*:\s*running[^;]*/g) ?? []
    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      expect(declaration).toContain('!important')
    }
  })

  it('leaves ambient decoration paused — the exemption is for content, not FX', () => {
    const resumed = resumedSelectors(readCss('32-window-idle-pause.css')).join('\n')
    // Infinite ambient motion is the whole point of the pause. Sky FX, shimmer
    // and glow must never appear here.
    expect(resumed).not.toMatch(/sky|shimmer|glow|rim-chase|burst/i)
  })
})
