import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * Orchestration-row text weight (no jsdom in this repo, so pin the CSS).
 *
 * The row's controls are satellite text buttons, and they have to read as one
 * set: `Turn` / `Continuous` are pinned to --text-primary, but the fan-out
 * isolation toggle sat on --text-muted, so "Shared" looked disabled rather than
 * simply un-toggled. A state the user can act on must not be styled like one
 * they can't.
 */
const css = readFileSync(
  new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
  'utf8'
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('orchestration row control text', () => {
  it('rests the fan-out isolation toggle at full text strength, like its neighbours', () => {
    const toggle = rule('.composer-fanout-isolation-toggle')
    expect(toggle).toMatch(/color:\s*var\(--text-primary\)/)
    expect(toggle).not.toMatch(/color:\s*var\(--text-muted\)/)
  })

  it('keeps the accent on the active state so the toggle still signals on/off', () => {
    // Raising the resting colour must not cost the ON cue — otherwise the two
    // states become indistinguishable.
    const active = rule(".composer-fanout-isolation-toggle[data-active='true']")
    expect(active).toMatch(/color:\s*var\(--accent-color\)/)
  })

  it('shows the admitted round fan-out policy while a round is running, collapsed to On/Off', () => {
    const source = readFileSync(new URL('./EnsembleOrchestrationRow.tsx', import.meta.url), 'utf8')
    expect(source).toContain(
      'const displayedFanoutPolicy = isRoundRunning ? activeFanoutPolicy : fanoutPolicy'
    )
    const selectionStart = source.indexOf('const displayedFanoutPolicy =')
    const selectionEnd = source.indexOf('const fanoutTitle =', selectionStart)
    expect(selectionStart).toBeGreaterThan(-1)
    expect(selectionEnd).toBeGreaterThan(selectionStart)
    const selection = source.slice(selectionStart, selectionEnd)
    // On/Off collapse: any legacy graded level a persisted round still
    // carries must display as On, never resurrect a Read/Write pill.
    expect(selection).toContain("displayedFanoutPolicy === 'off' ? 'off' : 'all'")
    expect(source).not.toContain("'read_only'")
    expect(source).not.toContain('locked_writers_with_boss')
  })

  it('opens the Isolate popover through the shared picker chrome with all three policies', () => {
    // The Isolate control is a trigger + portaled popover like its Fan-Out
    // neighbour — NOT a cycle toggle. The popover must reuse the exact
    // combined-picker chrome classes (opaque themed panel + rim highlight)
    // so it matches every other composer popover identically.
    const source = readFileSync(new URL('./EnsembleOrchestrationRow.tsx', import.meta.url), 'utf8')
    expect(source).toContain('function IsolationPicker')
    const pickerStart = source.indexOf('interface IsolationRow')
    expect(pickerStart).toBeGreaterThan(-1)
    const picker = source.slice(pickerStart)
    expect(picker).toContain('composer-combined-picker-popover composer-plus-picker-popover shell-')
    expect(picker).toContain("label: 'Shared'")
    expect(picker).toContain("label: 'Worktrees'")
    expect(picker).toContain("label: 'Any'")
    // The old cycle-toggle handler must be gone: clicking opens the popover.
    expect(source).not.toMatch(/onFanoutIsolationChange\(fanoutIsolation === 'worktree'/)
  })

  it('references only colour tokens the themes actually define', () => {
    // `--text-color` is defined nowhere; a declaration using it is dropped as
    // invalid, which is exactly how the dead hover rule hid this for so long.
    const defined = (token: string): boolean =>
      new RegExp(`--${token}:`).test(
        readFileSync(
          new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
          'utf8'
        )
      )
    expect(defined('text-primary')).toBe(true)
    expect(defined('text-muted')).toBe(true)
    expect(defined('text-color')).toBe(false)
    // Comments stripped first — the rule that removed the dead declaration
    // NAMES the token to explain itself, and a mention is not a use.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toContain('var(--text-color)')
  })
})
