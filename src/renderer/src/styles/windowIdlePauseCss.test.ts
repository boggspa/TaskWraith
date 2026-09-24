import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOW_IDLE_CLASS } from '../hooks/useWindowActive'

const CSS_DIR = join(process.cwd(), 'src/renderer/src/assets/css')

const readCss = (file: string): string =>
  readFileSync(join(CSS_DIR, file), 'utf8').replace(/\r\n/g, '\n')

const readMainCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

/** Comments carry braces-free prose that would otherwise read as a selector. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Innermost declaration blocks only — `[^{}]*` skips @media/@supports wrappers. */
const DECLARATION_BLOCK = /([^{}]+)\{([^{}]*)\}/g

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')

/** Selectors carrying the resumed declaration, with the idle prefix stripped. */
function resumedSelectors(css: string): string[] {
  const resumed: string[] = []
  const rules = withoutComments(css)
  const rule = new RegExp(DECLARATION_BLOCK.source, 'g')
  let match = rule.exec(rules)
  while (match !== null) {
    if (/animation-play-state\s*:\s*running/.test(match[2])) {
      for (const selector of match[1].split(',')) {
        const trimmed = normalize(selector)
        if (trimmed.startsWith(`.${WINDOW_IDLE_CLASS} `)) {
          resumed.push(trimmed.slice(`.${WINDOW_IDLE_CLASS} `.length))
        }
      }
    }
    match = rule.exec(rules)
  }
  return resumed
}

function keyframeBodies(): Map<string, string> {
  const bodies = new Map<string, string>()
  for (const file of readdirSync(CSS_DIR).filter((name) => name.endsWith('.css'))) {
    const css = withoutComments(readCss(file))
    const header = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g
    let match = header.exec(css)
    while (match !== null) {
      let index = match.index + match[0].length
      let depth = 1
      while (index < css.length && depth > 0) {
        if (css[index] === '{') depth += 1
        else if (css[index] === '}') depth -= 1
        index += 1
      }
      bodies.set(match[1], css.slice(match.index + match[0].length, index - 1))
      match = header.exec(css)
    }
  }
  return bodies
}

const frameAt = (body: string, edge: 'first' | 'last'): string | null => {
  const pattern =
    edge === 'first'
      ? /(?:^|\})\s*(?:from|0%)\s*\{([^}]*)\}/
      : /(?:^|\})\s*(?:to|100%)\s*\{([^}]*)\}/
  const match = pattern.exec(body)
  return match ? normalize(match[1]) : null
}

const opacityOf = (frame: string | null): number | null => {
  if (frame === null) return null
  const match = /opacity\s*:\s*([0-9.]+)/.exec(frame)
  return match ? Number(match[1]) : null
}

/**
 * Why pausing this animation at its first frame would strand the UI, or null
 * when the pause is harmless.
 *
 * A paused animation rests on its 0% keyframe, so the question is never "does
 * this look nice frozen" but "does frame 0 show what the animation exists to
 * put on screen". Two shapes fail:
 *
 *  - a REVEAL opens invisible and ends visible — frozen, the content is gone;
 *  - a DISMISS opens opaque and ends transparent — frozen, the overlay it
 *    exists to remove stays up (the boot mask covers the whole app).
 *
 * Ambient decoration — infinite loops, and one-shot bursts that open AND close
 * invisible — is deliberately excluded: freezing those costs a flourish and
 * nothing else, which is the entire point of the pause.
 */
function strandedShape(body: string): string | null {
  const first = frameAt(body, 'first')
  if (first === null) return null
  if (/scale[XYZ3d]*\(\s*0(\.0*)?\s*[,)]/.test(first)) return 'opens at scale(0)'
  if (/(max-)?height\s*:\s*0(px|%)?\s*(;|$)/.test(first)) return 'opens at height 0'
  const from = opacityOf(first)
  if (from === null) return null
  const to = opacityOf(frameAt(body, 'last')) ?? 1
  if (from <= 0.15 && to > from) return `reveal ${from} to ${to}`
  if (from > to && from >= 0.85) return `dismiss ${from} to ${to}`
  return null
}

interface StrandingUsage {
  selector: string
  animation: string
  shape: string
}

/** Every finite use of an animation the idle pause would strand. */
function strandingUsages(): StrandingUsage[] {
  const shapes = new Map<string, string>()
  for (const [name, body] of keyframeBodies()) {
    const shape = strandedShape(body)
    if (shape !== null) shapes.set(name, shape)
  }

  const usages = new Map<string, StrandingUsage>()
  for (const file of readdirSync(CSS_DIR).filter((name) => name.endsWith('.css'))) {
    const css = withoutComments(readCss(file))
    const rule = new RegExp(DECLARATION_BLOCK.source, 'g')
    let match = rule.exec(css)
    while (match !== null) {
      const selectors = match[1].split(',').map(normalize)
      const isKeyframeStep = selectors.every((selector) => /^(from|to|[\d.]+%)$/.test(selector))
      if (!selectors[0].startsWith('@') && !isKeyframeStep) {
        const shorthand = /animation(?:-name)?\s*:\s*([^;]+)/g
        let declaration = shorthand.exec(match[2])
        while (declaration !== null) {
          const value = normalize(declaration[1])
          if (!/(?<![\w-])infinite(?![\w-])/.test(value)) {
            for (const [name, shape] of shapes) {
              if (!new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(value)) continue
              for (const selector of selectors) {
                usages.set(`${selector}::${name}`, { selector, animation: name, shape })
              }
            }
          }
          declaration = shorthand.exec(match[2])
        }
      }
      match = rule.exec(css)
    }
  }
  return [...usages.values()].sort((a, b) => a.selector.localeCompare(b.selector))
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

  // Guard the guard: a scan that silently stopped matching would let every
  // assertion below pass on an empty set.
  it('finds the reveals it is meant to police', () => {
    const usages = strandingUsages()
    expect(usages.length).toBeGreaterThan(10)
    expect(usages).toContainEqual({
      selector: '.message-group',
      animation: 'fadeIn',
      shape: 'reveal 0 to 1'
    })
    expect(usages).toContainEqual({
      selector: '.app-boot-mask.is-leaving',
      animation: 'taskwraith-boot-wipe',
      shape: 'dismiss 1 to 0'
    })
  })

  it('resumes every finite reveal so the pause can never strand one', () => {
    const resumed = new Set(resumedSelectors(readCss('32-window-idle-pause.css')))
    const stranded = strandingUsages()
      .filter((usage) => !resumed.has(usage.selector))
      .map((usage) => `${usage.selector} — ${usage.animation} (${usage.shape})`)
    // Add the selector to 32-window-idle-pause.css rather than deleting it
    // here: a one-shot reveal runs once and stops, so resuming it costs a
    // single short animation, while pausing it hides real UI until refocus.
    expect(stranded).toEqual([])
  })

  it('resumes each reveal with !important so the blanket pause loses', () => {
    const css = readCss('32-window-idle-pause.css')
    const declarations = css.match(/animation-play-state\s*:\s*running[^;]*/g) ?? []
    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      expect(declaration).toContain('!important')
    }
  })

  it('leaves ambient decoration paused — the exemption is for content, not FX', () => {
    // Behaviour, not naming: `.composer-combined-picker-ladder-shimmer` is a
    // legitimate exemption because the animation it carries is a one-shot
    // reveal. What must never be resumed is an INFINITE animation — that is
    // the perpetual compositing the pause exists to stop.
    const resumed = new Set(resumedSelectors(readCss('32-window-idle-pause.css')))
    const looping: string[] = []
    for (const file of readdirSync(CSS_DIR).filter((name) => name.endsWith('.css'))) {
      const css = withoutComments(readCss(file))
      const rule = new RegExp(DECLARATION_BLOCK.source, 'g')
      let match = rule.exec(css)
      while (match !== null) {
        const selectors = match[1].split(',').map(normalize)
        const shorthand = /animation(?:-name)?\s*:\s*([^;]+)/g
        let declaration = shorthand.exec(match[2])
        while (declaration !== null) {
          const value = normalize(declaration[1])
          if (/(?<![\w-])infinite(?![\w-])/.test(value)) {
            for (const selector of selectors) {
              if (resumed.has(selector)) looping.push(`${selector} — ${value}`)
            }
          }
          declaration = shorthand.exec(match[2])
        }
        match = rule.exec(css)
      }
    }
    expect(looping).toEqual([])
  })
})
