import { describe, expect, it } from 'vitest'
import { Ansi, hexToRgb, stripAnsi, visibleWidth } from './ansi'
import { TUI_UNPAINTED_THEME, resolveTuiTheme } from './palette'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState, type TaskWraithTuiState } from './state'

/**
 * Built rather than written so no raw control byte can reach the source. The
 * repository bans them outright, and an ESC pasted into a test literal is
 * invisible in every editor and hidden from grep.
 */
const ESC = String.fromCharCode(27)

function backgroundCode(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${ESC}[48;2;${r};${g};${b}m`
}

function foregroundCode(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${ESC}[38;2;${r};${g};${b}m`
}

const WIDTH = 96
const HEIGHT = 20

function frame(
  theme = TUI_UNPAINTED_THEME,
  overlay: TaskWraithTuiState['overlay'] = 'none'
): string[] {
  const state = { ...createTaskWraithTuiDemoState(), overlay }
  return renderTaskWraithTui(state, {
    width: WIDTH,
    height: HEIGHT,
    ansi: new Ansi('truecolor'),
    animationEnabled: false,
    now: 0,
    theme
  }).split('\n')
}

const night = resolveTuiTheme('wraith-night')

describe('TaskWraith TUI region painting', () => {
  it('paints nothing at all by default', () => {
    // The pre-theme surface is the default, so every existing caller and every
    // existing rendering test keeps the frame it already had.
    expect(frame().join('\n')).not.toContain(`${ESC}[48;`)
  })

  it('paints every row of a themed frame', () => {
    const lines = frame(night)
    expect(lines).toHaveLength(HEIGHT)
    for (const [index, line] of lines.entries()) {
      expect(line, `row ${index} was left on the terminal's own ground`).toContain(`${ESC}[48;`)
    }
  })

  it('stacks canvas, panel and composer on three distinct grounds', () => {
    // Depth is the entire reason a theme carries three grounds. One fill for
    // the whole frame is a recolour, not a theme.
    const lines = frame(night)
    const ground = night.ground as { background: string; surface: string; panel: string }
    const canvas = lines.slice(0, HEIGHT - 4)
    for (const line of canvas) expect(line).toContain(backgroundCode(ground.background))
    for (const line of lines.slice(HEIGHT - 4, HEIGHT - 1)) {
      expect(line).toContain(backgroundCode(ground.surface))
    }
    expect(lines[HEIGHT - 1]).toContain(backgroundCode(ground.panel))
  })

  it('raises the canvas to the surface ground while an overlay is open', () => {
    const ground = night.ground as { background: string; surface: string }
    const canvas = frame(night, 'help').slice(0, HEIGHT - 4)
    for (const line of canvas) {
      expect(line).toContain(backgroundCode(ground.surface))
      expect(line).not.toContain(backgroundCode(ground.background))
    }
  })

  it('leaves no stretch of text on the terminal’s own foreground', () => {
    // A bare `39m` means "back to the default foreground", and inside a painted
    // region the default is the theme's ink. Any that survive are a stripe of
    // unthemed text — invisible on a light ground under a light terminal
    // profile, which is the failure this rewrite exists to prevent.
    const painted = frame(night).join('\n')
    expect(painted).not.toContain(`${ESC}[39m`)
    expect(painted).toContain(foregroundCode((night.ink as { primary: string }).primary))
  })

  it('does not change the layout it paints', () => {
    // Painting must be invisible to the width arithmetic. If a fill leaks into
    // `visibleWidth` the composer viewport and every overlay column drift.
    const plain = frame()
    const painted = frame(night)
    expect(painted.map(stripAnsi)).toEqual(plain.map(stripAnsi))
    for (const line of painted) expect(visibleWidth(line)).toBe(WIDTH)
  })

  it('ignores the theme entirely on a terminal without colour', () => {
    const state = createTaskWraithTuiDemoState()
    const output = renderTaskWraithTui(state, {
      width: WIDTH,
      height: HEIGHT,
      ansi: new Ansi('none'),
      animationEnabled: false,
      now: 0,
      theme: night
    })
    expect(output).toBe(stripAnsi(output))
  })
})
