import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8')

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar footer picker opacity CSS', () => {
  it('sets settings and footer picker shells to an 85% solid theme surface', () => {
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

    for (const block of [settingsBlock, footerBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid: var(--surface-2')
    }
    for (const block of [lightSettingsBlock, lightFooterBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid: var(--surface-1')
    }
    for (const block of [settingsBlock, lightSettingsBlock, footerBlock, lightFooterBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid')
      expect(block).toContain('var(--sidebar-picker-bg-solid) 85%')
      expect(block).not.toContain('var(--panel-elevated-bg) 90%')
      expect(block).not.toContain('var(--surface-1) 88%')
    }
  })

  it('sets the masthead new and shared chat create pickers to an 85% solid theme surface', () => {
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

    for (const block of [newBlock, sharedBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid: var(--surface-2')
    }
    for (const block of [lightNewBlock, lightSharedBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid: var(--surface-1')
    }
    for (const block of [newBlock, lightNewBlock, sharedBlock, lightSharedBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid')
      expect(block).toContain('var(--sidebar-picker-bg-solid) 85%')
      expect(block).not.toContain('var(--panel-elevated-bg) 88%')
      expect(block).not.toContain('var(--surface-1) 86%')
    }
  })

  it('keeps ensemble participant popovers solid in light reduce-transparency mode', () => {
    const css = readCss('09-ensemble-work-session.css')
    const lightReduceBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-reduce-transparency="true"]\n  .ensemble-above-overflow {'
    )

    expect(lightReduceBlock).toContain('background: var(--surface-1, #ffffff) !important')
    expect(lightReduceBlock).toContain('color: var(--surface-text)')
  })

  it('keeps sidebar pickers opaque when transparency is reduced', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduceTransparencyBlock = cssBlockStartingAt(
      css,
      ':is(.sidebar-settings-menu, .sidebar-footer-popover, .sidebar-new-menu) {'
    )

    expect(reduceTransparencyBlock).toContain(
      'background: var(--sidebar-picker-bg-solid) !important'
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

    expect(combinedBlock).toContain('var(--surface-2')
    expect(combinedBlock).toContain('85%')
    expect(combinedBlock).toContain('blur(18px) saturate(150%)')
    expect(combinedBlock).not.toContain('var(--panel-elevated-bg) 96%')
    expect(lightCombinedBlock).toContain('var(--surface-1) 85%')
    expect(lightCombinedBlock).not.toContain('var(--surface-1) 78%')
    expect(noBackdropSection).toContain('background: var(--surface-1, #f4f6fb)')
    expect(noBackdropSection).not.toContain('background: var(--tw-glass-solid, var(--surface-1')
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

    expect(copyBlock).toContain('var(--surface-2')
    expect(copyBlock).toContain('85%')
    expect(copyBlock).toContain('blur(18px) saturate(150%)')
    expect(copyBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.34)')

    expect(obsidianBlock).toContain('.composer-plan-popover.shell-obsidian')
    expect(obsidianBlock).toContain('.composer-ensemble-toggle-popover.shell-obsidian')
    expect(obsidianBlock).toContain('background: color-mix(in srgb, var(--surface-2) 85%, transparent)')
    expect(obsidianBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.34)')

    expect(alabasterBlock).toContain('.composer-plan-popover.shell-alabaster')
    expect(alabasterBlock).toContain('.composer-ensemble-toggle-popover.shell-alabaster')
    expect(alabasterBlock).toContain('background: color-mix(in srgb, var(--surface-1) 85%, transparent)')
    expect(alabasterBlock).toContain('0 18px 44px rgba(0, 0, 0, 0.14)')
  })

  it('keeps Grok and Cursor portaled popovers on the shared shell material', () => {
    const css = readCss('10-provider-shell-overrides.css')
    const grokBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-grok,')
    const cursorBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-cursor,')

    for (const block of [grokBlock, cursorBlock]) {
      expect(block).toContain('.composer-ensemble-toggle-popover.shell-')
      expect(block).toContain('85%, transparent')
      expect(block).toContain('blur(18px) saturate(150%) !important')
      expect(block).not.toContain('backdrop-filter: none !important')
    }
  })
})
