import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, describe, expect, it } from 'vitest'
import { hexToRgb, stripAnsi } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'
import { resolveTuiTheme, type TuiThemeGround } from './palette'

const ESC = String.fromCharCode(27)
const KEY_DOWN = `${ESC}[B`
const KEY_UP = `${ESC}[A`
const KEY_ENTER = '\r'
const KEY_ESCAPE = ESC

class FakeInput extends PassThrough {
  isTTY = true as const
  setRawMode(): this {
    return this
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true as const
  columns = 88
  rows = 20
  readonly frames: string[] = []
  write(chunk: string): boolean {
    this.frames.push(chunk)
    return true
  }
  get lastFrame(): string {
    return this.frames.at(-1) ?? ''
  }
}

function groundCode(themeName: string, depth: keyof TuiThemeGround): string {
  const ground = resolveTuiTheme(themeName).ground as TuiThemeGround
  const [r, g, b] = hexToRgb(ground[depth])
  return `${ESC}[48;2;${r};${g};${b}m`
}

/** The canvas fill of a frame with no overlay open. */
function backgroundCode(themeName: string): string {
  return groundCode(themeName, 'background')
}

/**
 * The canvas fill of a frame WITH an overlay open — the canvas is raised to
 * `surface` while one is up. Asserting on `background` during a preview is
 * vacuous: it is absent whatever theme is painted, so the test passes even with
 * previewing removed entirely. Mutation testing is how that was caught.
 */
function overlayCanvasCode(themeName: string): string {
  return groundCode(themeName, 'surface')
}

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

function startTui(options: { persistTheme?: (name: string) => boolean } = {}) {
  const input = new FakeInput()
  const output = new FakeOutput()
  const tui = new TaskWraithTui({
    clientVersion: '0.1.0-test',
    demo: true,
    colorMode: 'truecolor',
    animationEnabled: false,
    theme: resolveTuiTheme('wraith-night'),
    themeName: 'wraith-night',
    ...options,
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream
  })
  cleanup.push(() => tui.stop())
  void tui.start()
  return { tui, input, output }
}

function type(input: FakeInput, text: string): void {
  input.write(Buffer.from(text, 'utf8'))
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A lone ESC is ambiguous — readline holds it back to see whether a sequence
 * follows — so a test that presses Escape has to outwait that disambiguation
 * or it measures the keystroke never arriving rather than the handler.
 */
const ESCAPE_SETTLE_MS = 700

describe('TaskWraith TUI /theme picker', () => {
  it('opens on /theme and marks the committed theme', async () => {
    const { input, output } = startTui()
    await settle()
    type(input, `/theme${KEY_ENTER}`)
    await settle()
    const frame = stripAnsi(output.lastFrame)
    expect(frame).toContain('Theme')
    expect(frame).toContain('auto')
    expect(frame).toContain('tokyo-night')
    expect(frame).toContain('↑↓ preview')
  })

  it('repaints the whole frame while previewing, and reverts on Esc', async () => {
    // The preview IS the swatch. Moving the cursor has to repaint the ground,
    // and backing out has to put it back — an overlay that closes without
    // reverting would silently apply a theme the user declined.
    const { input, output } = startTui()
    await settle()
    expect(output.lastFrame).toContain(backgroundCode('wraith-night'))

    type(input, `/theme${KEY_ENTER}`)
    await settle()
    type(input, KEY_DOWN)
    await settle()
    const previewed = output.lastFrame
    expect(previewed).toContain(overlayCanvasCode('wraith-day'))
    expect(previewed).not.toContain(overlayCanvasCode('wraith-night'))

    type(input, KEY_ESCAPE)
    await settle(ESCAPE_SETTLE_MS)
    expect(output.lastFrame).toContain(backgroundCode('wraith-night'))
    expect(stripAnsi(output.lastFrame)).not.toContain('↑↓ preview')
  })

  it('keeps the previewed theme on Enter and saves it', async () => {
    const saved: string[] = []
    const { input, output } = startTui({
      persistTheme: (name) => {
        saved.push(name)
        return true
      }
    })
    await settle()
    type(input, `/theme${KEY_ENTER}`)
    await settle()
    // Committed row is wraith-night (index 1 of [auto, wraith-night, ...]);
    // step up to `auto`, back down, then down again to reach wraith-day.
    type(input, KEY_UP)
    await settle()
    type(input, KEY_DOWN)
    await settle()
    type(input, KEY_DOWN)
    await settle()
    type(input, KEY_ENTER)
    await settle()
    expect(saved).toEqual(['wraith-day'])
    expect(output.lastFrame).toContain(backgroundCode('wraith-day'))
    expect(stripAnsi(output.lastFrame)).not.toContain('↑↓ preview')
  })

  it('applies and saves a theme named directly on the command', async () => {
    const saved: string[] = []
    const { input, output } = startTui({
      persistTheme: (name) => {
        saved.push(name)
        return true
      }
    })
    await settle()
    type(input, `/theme tokyo-night${KEY_ENTER}`)
    await settle()
    expect(saved).toEqual(['tokyo-night'])
    expect(output.lastFrame).toContain(backgroundCode('tokyo-night'))
  })

  it('refuses an unknown name out loud instead of silently falling back', async () => {
    // `resolveTuiTheme` falls back quietly so a stale config cannot block
    // startup. A name the user just typed is a different situation: silence
    // there reads as "applied" and leaves them staring at the old colours.
    const saved: string[] = []
    const { input, output } = startTui({
      persistTheme: (name) => {
        saved.push(name)
        return true
      }
    })
    await settle()
    type(input, `/theme mauve-dream${KEY_ENTER}`)
    await settle()
    expect(saved).toEqual([])
    expect(stripAnsi(output.lastFrame)).toContain('Unknown theme')
    expect(output.lastFrame).toContain(backgroundCode('wraith-night'))
  })

  it('says so when the preference could not be saved', async () => {
    // Failing to persist must not end the session, but it must not be silent
    // either — the user would only find out at the next launch.
    const { input, output } = startTui({ persistTheme: () => false })
    await settle()
    type(input, `/theme terminal${KEY_ENTER}`)
    await settle()
    expect(stripAnsi(output.lastFrame)).toContain('could not save')
  })
})
