import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8')

const readThemeCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar footer picker opacity CSS', () => {
  it('defines black/white 80% glass with opaque accessibility fallbacks', () => {
    const theme = readThemeCss()

    expect(theme).toContain('--tw-popover-glass-bg: rgba(0, 0, 0, 0.8)')
    expect(theme).toContain('--tw-glass-solid: #000')
    expect(theme).toContain('--tw-popover-glass-bg: rgba(255, 255, 255, 0.8)')
    expect(theme).toContain('--tw-glass-solid: #fff')
  })

  it('routes every migrated popover family through the shared glass bed', () => {
    const popoverFamilies: Array<[string, string]> = [
      ['03-composer-welcome-activity.css', '.welcome-workspace-popover {'],
      ['03-composer-welcome-activity.css', '.composer-goal-popover {'],
      ['03-composer-welcome-activity.css', '.composer-ensemble-toggle-popover {'],
      ['03-composer-welcome-activity.css', '.composer-plan-popover {'],
      ['07-composer-shells.css', '.composer-diff-action-menu {'],
      ['08-theme-picker-overrides.css', '.agent-mention-menu {'],
      ['08-theme-picker-overrides.css', '.composer-slash-menu {'],
      ['08-theme-picker-overrides.css', '.composer-combined-picker-popover {'],
      ['09-ensemble-work-session.css', '.queued-steer-menu {'],
      ['09-ensemble-work-session.css', '.ensemble-above-overflow {']
    ]

    for (const [file, selector] of popoverFamilies) {
      expect(cssBlockStartingAt(readCss(file), selector)).toContain(
        'background: var(--tw-popover-glass-bg)'
      )
    }
  })

  it('routes settings and footer picker shells through the shared glass bed', () => {
    const css = readCss('05-polish-fx-layouts.css')

    const settingsBlock = cssBlockStartingAt(css, '.sidebar-settings-menu {')
    const lightSettingsBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .sidebar-settings-menu {'
    )
    const footerBlock = cssBlockStartingAt(css, '.sidebar-footer-popover {')
    const lightFooterBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .sidebar-footer-popover {'
    )

    for (const block of [settingsBlock, lightSettingsBlock, footerBlock, lightFooterBlock]) {
      expect(block).toContain('background: var(--tw-popover-glass-bg)')
      expect(block).not.toContain('--sidebar-picker-bg-solid')
      expect(block).not.toContain('85%')
    }
  })

  it('routes masthead new and shared-chat create pickers through the shared glass bed', () => {
    const css = readCss('09-ensemble-work-session.css')

    const newBlock = cssBlockStartingAt(css, '.sidebar-new-menu {')
    const lightNewBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .sidebar-new-menu {'
    )
    const sharedBlock = cssBlockStartingAt(css, '.sidebar-new-menu.sidebar-shared-create-menu {')
    const lightSharedBlock = cssBlockStartingAt(
      css,
      '.sidebar-new-menu.sidebar-shared-create-menu {',
      css.indexOf('.sidebar-new-menu.sidebar-shared-create-menu {') + 1
    )

    for (const block of [newBlock, lightNewBlock, sharedBlock, lightSharedBlock]) {
      expect(block).toContain('background: var(--tw-popover-glass-bg)')
      expect(block).not.toContain('--sidebar-picker-bg-solid')
      expect(block).not.toContain('85%')
    }
  })

  it('keeps ensemble participant popovers solid in light reduce-transparency mode', () => {
    const css = readCss('09-ensemble-work-session.css')
    const lightReduceBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-reduce-transparency="true"]\n  .ensemble-above-overflow {'
    )

    expect(lightReduceBlock).toContain('background: var(--tw-glass-solid) !important')
    expect(lightReduceBlock).toContain('color: var(--surface-text)')
  })

  it('keeps sidebar pickers opaque when transparency is reduced', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduceTransparencyBlock = cssBlockStartingAt(
      css,
      ':is(.sidebar-settings-menu, .sidebar-footer-popover, .sidebar-new-menu) {'
    )

    expect(reduceTransparencyBlock).toContain(
      'background: var(--tw-glass-solid) !important'
    )
    expect(reduceTransparencyBlock).toContain('backdrop-filter: none')
  })

  it('puts sidebar and ensemble participant popovers in the shared glass-rim group', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const rimBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover::after,')
    const refractionBlock = cssBlockStartingAt(
      css,
      ':root[data-advanced-fx-refraction="true"] .composer-combined-picker-popover::before,'
    )

    for (const selector of [
      '.agent-mention-menu',
      '.composer-slash-menu',
      '.welcome-workspace-popover',
      '.composer-workspace-popover',
      '.continuous-hops-popover',
      '.composer-copy-transcript-popover',
      '.composer-diff-action-menu',
      '.composer-ensemble-toggle-popover',
      '.sidebar-settings-menu',
      '.sidebar-footer-popover',
      '.sidebar-new-menu',
      '.ensemble-above-overflow'
    ]) {
      expect(rimBlock).toContain(`${selector}::after`)
      expect(refractionBlock).toContain(`${selector}::before`)
    }
  })

  it('keeps shared popover content above rim and sheen layers', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const contentLiftBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover > *,')

    for (const selector of [
      '.agent-mention-menu > *',
      '.composer-slash-menu > *',
      '.welcome-workspace-popover > *',
      '.composer-workspace-popover > *',
      '.continuous-hops-popover > *',
      '.composer-copy-transcript-popover > *',
      '.composer-diff-action-menu > *',
      '.composer-ensemble-toggle-popover > *',
      '.sidebar-settings-menu > *',
      '.sidebar-footer-popover > *',
      '.sidebar-new-menu > *',
      '.ensemble-above-overflow > *'
    ]) {
      expect(contentLiftBlock).toContain(selector)
    }
    expect(contentLiftBlock).toContain('z-index: 2')
  })

  it('normalises the reference picker material and light solid fallback', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const combinedBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover {')
    const lightCombinedBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .composer-combined-picker-popover {'
    )
    const sharedPopoverStart = css.indexOf('.composer-combined-picker-popover::after,')
    const noBackdropStart = css.indexOf(
      '@supports not ((backdrop-filter: blur(1px))',
      sharedPopoverStart
    )
    expect(noBackdropStart).toBeGreaterThanOrEqual(0)
    const noBackdropSection = css.slice(
      noBackdropStart,
      css.indexOf('.composer-combined-picker-column {', noBackdropStart)
    )

    expect(combinedBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(combinedBlock).toContain('blur(18px) saturate(150%)')
    expect(combinedBlock).not.toContain('85%')
    expect(lightCombinedBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(lightCombinedBlock).not.toContain('85%')
    expect(noBackdropSection).toContain('background: var(--tw-glass-solid)')
    expect(noBackdropSection).not.toContain('background: var(--tw-glass-solid,')
  })

  it('keeps copy transcript and extreme-shell popovers on the shared material recipe', () => {
    const composerCss = readCss('03-composer-welcome-activity.css')
    const themeCss = readCss('08-theme-picker-overrides.css')

    const copyBlock = cssBlockStartingAt(
      composerCss,
      '.composer-copy-transcript-popover,\n.composer-combined-picker-popover.composer-copy-transcript-popover {'
    )
    const obsidianBlock = cssBlockStartingAt(
      themeCss,
      '.composer-combined-picker-popover.shell-obsidian,'
    )
    const alabasterBlock = cssBlockStartingAt(
      themeCss,
      '.composer-combined-picker-popover.shell-alabaster,'
    )

    expect(copyBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(copyBlock).toContain('blur(18px) saturate(150%)')
    expect(copyBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.34)')

    expect(obsidianBlock).toContain('.composer-plan-popover.shell-obsidian')
    expect(obsidianBlock).toContain('.composer-ensemble-toggle-popover.shell-obsidian')
    expect(obsidianBlock).toContain('--tw-popover-glass-bg: rgba(0, 0, 0, 0.8)')
    expect(obsidianBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(obsidianBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.34)')

    expect(alabasterBlock).toContain('.composer-plan-popover.shell-alabaster')
    expect(alabasterBlock).toContain('.composer-ensemble-toggle-popover.shell-alabaster')
    expect(alabasterBlock).toContain('--tw-popover-glass-bg: rgba(255, 255, 255, 0.8)')
    expect(alabasterBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(alabasterBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.14)')
  })

  it('keeps Grok and Cursor portaled popovers on the shared shell material', () => {
    const css = readCss('10-provider-shell-overrides.css')
    const grokBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-grok,')
    const cursorBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-cursor,')

    for (const block of [grokBlock, cursorBlock]) {
      expect(block).toContain('.composer-ensemble-toggle-popover.shell-')
      expect(block).toContain('background: var(--tw-popover-glass-bg) !important')
      expect(block).toContain('blur(18px) saturate(150%) !important')
      expect(block).not.toContain('backdrop-filter: none !important')
    }
  })
})
