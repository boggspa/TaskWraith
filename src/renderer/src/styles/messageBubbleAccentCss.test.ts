import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const themeCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')
const appearanceSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/hooks/useAppearance.ts'),
  'utf8'
)

/** Body of the first top-level `selector { ... }` rule, without nesting. */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`missing rule: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return css.slice(open + 1, close)
}

describe('message bubble accent token', () => {
  it('feeds the user bubble from its own token, not the app accent', () => {
    // The user's bubble colour and the interface accent were a single token.
    // Splitting them is the whole feature: aliasing --accent here would drag
    // the bubble straight back onto the desktop's accent, and every test in
    // this file would still pass on the strength of the fallback alone.
    const shared = ruleBlock(themeCss, '[data-user-bubble-color="shared"]')

    expect(shared).toContain('--user-bubble-base: var(--message-bubble-accent')
    expect(shared).not.toMatch(/--user-bubble-base:\s*var\(--accent\)/)
  })

  it('is written by the appearance hook, so the fallback never has to fire', () => {
    expect(appearanceSource).toContain("root.style.setProperty('--message-bubble-accent'")
  })

  it('leaves --accent unset when the OS reports no accent', () => {
    // An inline property on documentElement outranks every [data-theme] block,
    // so writing a stand-in colour would freeze the accent for all themes on a
    // host that simply has none to report.
    expect(appearanceSource).toContain("root.style.removeProperty('--accent')")
    expect(appearanceSource).toContain("root.style.removeProperty('--accent-hover')")
  })

  it('lets the settings load carry host state forward', () => {
    // The settings-load setState replaces the WHOLE appearance object, and the
    // OS accent read usually wins the race against reading settings from disk.
    // Without the spread the accent was thrown away on exactly those launches
    // — silently, because the app still painted, just with the theme accent.
    const load = appearanceSource.slice(
      appearanceSource.indexOf('setState((prev) => ({'),
      appearanceSource.indexOf('mode: settings.appearanceMode')
    )
    expect(load).toContain('...prev,')
  })

  it('keeps a per-theme --accent for the hook to fall back to', () => {
    // Removing the inline property is only correct while the stylesheet still
    // defines one. Guards the pair, not either half.
    expect(themeCss).toMatch(/^\s*--accent:\s*#[0-9a-f]{6};/m)
    expect(themeCss).toMatch(/\[data-theme="[a-z]+"\][\s\S]{0,4000}?--accent:\s*#[0-9a-f]{6};/)
  })
})
