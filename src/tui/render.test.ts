import { describe, expect, it } from 'vitest'
import { Ansi, stripAnsi, visibleWidth } from './ansi'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState } from './state'

function renderedLines(
  width: number,
  height: number,
  overlay: 'none' | 'context' | 'threads' | 'help' = 'none'
): string[] {
  const now = Date.UTC(2026, 6, 27, 4, 55, 37)
  const state = createTaskWraithTuiDemoState(now)
  state.overlay = overlay
  return renderTaskWraithTui(state, {
    width,
    height,
    ansi: new Ansi('none'),
    now,
    animationEnabled: false
  }).split('\n')
}

describe('TaskWraith TUI renderer', () => {
  it('uses exactly 80x24 with a transcript canvas and three-row ensemble footer', () => {
    const lines = renderedLines(80, 24)
    expect(lines).toHaveLength(24)
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true)
    expect(lines.join('\n')).toContain('Claude · Lead · Opus 4.8 1M · Ultracode')
    expect(lines.join('\n')).toContain('ᜊ Working…  2s · ≈386 tokens')
    expect(lines.at(-3)?.trimStart()).toMatch(/^ENS Build \+ Review/)
    expect(lines.at(-2)).toContain('AGBench W+1')
    expect(lines.at(-1)?.trimStart()).toMatch(/^› ▏ Ask TaskWraith…/)
  })

  it('keeps the same semantic checksum inside a tall, narrow terminal', () => {
    const lines = renderedLines(64, 30)
    expect(lines).toHaveLength(30)
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true)
    expect(lines.at(-3)).toContain('ENS')
    expect(lines.at(-2)).toContain('AGBench')
    expect(lines.at(-1)).toContain('↵ send')
  })

  it('moves full workspace and roster detail into one context lens', () => {
    const output = renderedLines(80, 24, 'context').join('\n')
    expect(output).toContain('Context lens')
    expect(output).toContain('PRIMARY  AGBench  [write]')
    expect(output).toContain('SECONDARY  design-system  [write]')
    expect(output).toContain('Build + Review · Continuous · fan-out Off · 0/32')
    expect(output).toContain('Claude · Lead · Opus 4.8 1M')
    expect(output).toContain('Kimi · Review · K3 · BG')
    expect(output).toContain('Esc close · Ctrl+O toggle')
  })

  it('keeps the insertion point visible when a one-line prompt exceeds its viewport', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.input = 'the beginning is deliberately far away from the live insertion point'
    state.inputCursor = Array.from(state.input).length
    const line = stripAnsi(
      renderTaskWraithTui(state, {
        width: 48,
        height: 24,
        ansi: new Ansi('truecolor'),
        now
      })
        .split('\n')
        .at(-1) ?? ''
    )
    expect(line).toContain('live insertion point▏')
    expect(line).not.toContain('the beginning')
  })

  it('shows preserved bracketed-paste line breaks inside the one-row composer', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.input = 'first line\nsecond line'
    state.inputCursor = Array.from(state.input).length
    const line = stripAnsi(
      renderTaskWraithTui(state, {
        width: 64,
        height: 24,
        ansi: new Ansi('truecolor'),
        now
      })
        .split('\n')
        .at(-1) ?? ''
    )
    expect(line).toContain('first line↵second line▏')
    expect(line).not.toContain('\n')
  })

  it('animates only the provider-accented working mark and has a static fallback', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    const frame = (animationFrame: number, animationEnabled: boolean) => {
      state.animationFrame = animationFrame
      return renderTaskWraithTui(state, {
        width: 80,
        height: 24,
        ansi: new Ansi('truecolor'),
        now,
        animationEnabled
      })
    }
    const movingA = frame(0, true)
    const movingB = frame(1, true)
    expect(movingA).not.toBe(movingB)
    expect(stripAnsi(movingA)).toBe(stripAnsi(movingB))
    expect(frame(0, false)).toBe(frame(8, false))
    if (state.thread) state.thread.thread.status = 'complete'
    expect(frame(0, true)).toBe(frame(8, true))
  })

  it('does not transplant desktop-only surface effects into terminal output', () => {
    const output = renderedLines(80, 24).join('\n').toLowerCase()
    for (const forbidden of [
      'glass',
      'blur',
      'refraction',
      'hover',
      'drag-and-drop',
      'modal stack',
      'canvas'
    ]) {
      expect(output).not.toContain(forbidden)
    }
  })

  it('renders an empty-thread identity instead of the no-selection home state when a thread is selected but has no rows', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    if (!state.thread) throw new Error('Demo state is incomplete')
    state.thread.rows = []
    state.thread.thread.status = 'idle'
    state.thread.thread.messageCount = 0
    state.thread.thread.title = 'Empty Idle Thread'

    const output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 80,
        height: 24,
        ansi: new Ansi('none'),
        now,
        animationEnabled: false
      })
    )

    expect(output).not.toContain('No thread selected')
    expect(output).toContain('Empty Idle Thread')
    expect(output).toContain('No messages yet')
  })

  it('strips terminal control bytes from every dynamic presentation label', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    if (!state.thread || !state.snapshot) throw new Error('Demo state is incomplete')
    state.thread.rows[0].speaker = 'You\u001b[2J'
    state.thread.rows[2].tools![0].name = 'Read\u009b2J'
    state.snapshot.workspaces[0].name = 'AGBench\u001b[?25h'
    state.notice = { text: 'Saved\u001b[H', tone: 'good' }

    const output = renderTaskWraithTui(state, {
      width: 80,
      height: 24,
      ansi: new Ansi('truecolor'),
      now,
      animationEnabled: false
    })

    expect(output).not.toContain('\u001b[2J')
    expect(output).not.toContain('\u001b[?25h')
    expect(output).not.toContain('\u001b[H')
    expect(output).not.toContain('\u009b')
    expect(stripAnsi(output)).toContain('You[2J')
    expect(stripAnsi(output)).toContain('Read2J')
  })
})
