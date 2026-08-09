import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8')

const readRendererCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src', file), 'utf8')

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
  it('defines the canonical Model Usage material and theme-aware popover aliases', () => {
    const theme = readThemeCss()

    expect(theme).toContain('--tw-neutral-material-bg-dark: rgba(22, 22, 22, 0.65)')
    expect(theme).toContain('--tw-neutral-material-bg-light: rgba(255, 255, 255, 0.65)')
    expect(theme).toContain('--tw-neutral-material-solid-dark: rgb(22, 22, 22)')
    expect(theme).toContain('--tw-neutral-material-solid-light: rgb(255, 255, 255)')
    expect(theme).toContain(
      '--tw-neutral-material-backdrop: blur(22px) saturate(0%) brightness(0.96)'
    )
    expect(theme).toContain(
      '--tw-neutral-material-backdrop-soft: blur(16px) saturate(0%) brightness(0.96)'
    )
    expect(theme).toContain('--tw-popover-glass-bg: var(--tw-neutral-material-bg-dark)')
    expect(theme).toContain('--tw-popover-glass-bg: var(--tw-neutral-material-bg-light)')
    expect(theme).toContain('--tw-glass-solid: var(--tw-neutral-material-solid-dark)')
    expect(theme).toContain('--tw-glass-solid: var(--tw-neutral-material-solid-light)')
  })

  it('keeps system material readable and follows inverse-sidebar polarity', () => {
    const theme = readThemeCss()
    const controls = readCss('04-settings-controls.css')
    const alabasterSidebar = cssBlockStartingAt(
      theme,
      '[data-theme="alabaster"][data-theme="alabaster"] .app-sidebar {'
    )
    const portaledOverflow = cssBlockStartingAt(
      controls,
      '[data-theme="alabaster"]\n  .sidebar-overflow-menu-popover:not(.media-action-menu-popover) {'
    )
    const obsidianSidebar = cssBlockStartingAt(
      theme,
      '[data-theme="obsidian"][data-theme="obsidian"] .app-sidebar {'
    )
    const obsidianOverflow = cssBlockStartingAt(
      controls,
      '[data-theme="obsidian"]\n  .sidebar-overflow-menu-popover:not(.media-action-menu-popover) {'
    )

    expect(theme).not.toMatch(
      /@media \(prefers-color-scheme: light\) \{\s*\[data-theme="system"\][^}]*--tw-popover-glass-bg/s
    )
    expect(alabasterSidebar).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-dark)'
    )
    expect(portaledOverflow).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-dark)'
    )
    expect(portaledOverflow).toContain('--text-primary: rgba(255, 255, 255, 0.92)')
    expect(obsidianSidebar).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-light)'
    )
    expect(obsidianOverflow).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-light)'
    )
    expect(obsidianOverflow).toContain('--text-primary: rgba(18, 21, 27, 0.92)')
  })

  it('routes all 16 live popover shells through the complete shared material', () => {
    const popoverFamilies: Array<[string, string]> = [
      ['assets/css/03-composer-welcome-activity.css', '.welcome-workspace-popover {'],
      ['assets/css/03-composer-welcome-activity.css', '.composer-human-invite-popover {'],
      [
        'assets/css/03-composer-welcome-activity.css',
        '.composer-copy-transcript-popover,\n.composer-combined-picker-popover.composer-copy-transcript-popover {'
      ],
      ['assets/css/03-composer-welcome-activity.css', '.composer-goal-popover {'],
      ['assets/css/03-composer-welcome-activity.css', '.composer-ensemble-toggle-popover {'],
      ['assets/css/03-composer-welcome-activity.css', '.composer-plan-popover {'],
      ['assets/css/04-settings-controls.css', '.sidebar-overflow-menu-popover {'],
      ['assets/css/05-polish-fx-layouts.css', '.sidebar-settings-menu {'],
      ['assets/css/05-polish-fx-layouts.css', '.sidebar-footer-popover {'],
      ['assets/css/07-composer-shells.css', '.composer-diff-action-menu {'],
      ['assets/css/08-theme-picker-overrides.css', '.agent-mention-menu {'],
      ['assets/css/08-theme-picker-overrides.css', '.composer-slash-menu {'],
      ['assets/css/08-theme-picker-overrides.css', '.composer-combined-picker-popover {'],
      ['assets/css/09-ensemble-work-session.css', '.sidebar-new-menu {'],
      ['assets/css/09-ensemble-work-session.css', '.ensemble-above-overflow {'],
      ['components/WorkspaceLockPill.css', '.workspace-lock-popover {']
    ]

    for (const [file, selector] of popoverFamilies) {
      const block = cssBlockStartingAt(readRendererCss(file), selector)
      expect(block).toContain('background: var(--tw-popover-glass-bg)')
      expect(block).toContain('box-shadow: var(--tw-popover-material-shadow)')
      expect(block).toContain('backdrop-filter: var(--tw-popover-material-backdrop)')
      expect(block).toContain('-webkit-backdrop-filter: var(--tw-popover-material-backdrop)')
      expect(block).toContain('isolation: isolate')
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

  it('puts every live popover in the shared sheen and optional-refraction groups', () => {
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
      '.composer-goal-popover',
      '.composer-plan-popover',
      '.composer-ensemble-toggle-popover',
      '.composer-human-invite-popover',
      '.sidebar-settings-menu',
      '.sidebar-footer-popover',
      '.sidebar-new-menu',
      '.sidebar-overflow-menu-popover',
      '.workspace-lock-popover',
      '.ensemble-above-overflow'
    ]) {
      expect(rimBlock).toContain(`${selector}::after`)
      expect(refractionBlock).toContain(`${selector}::before`)
    }
    expect(rimBlock).toContain('background: var(--tw-neutral-material-sheen)')
    expect(rimBlock).not.toContain('--tw-glass-rim-light')
    expect(refractionBlock).toContain('background: var(--tw-neutral-material-sheen)')
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
      '.composer-goal-popover > *',
      '.composer-plan-popover > *',
      '.composer-ensemble-toggle-popover > *',
      '.composer-human-invite-popover > *',
      '.sidebar-settings-menu > *',
      '.sidebar-footer-popover > *',
      '.sidebar-new-menu > *',
      '.sidebar-overflow-menu-popover > *',
      '.workspace-lock-popover > *',
      '.ensemble-above-overflow > *'
    ]) {
      expect(contentLiftBlock).toContain(selector)
    }
    expect(contentLiftBlock).toContain('z-index: 2')
  })

  it('forces solid and reduced-transparency states above provider-important chrome', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const fallbackBlock = cssBlockStartingAt(
      css,
      ':is(:root[data-appearance="solid"], :root[data-reduce-transparency="true"])'
    )

    for (const selector of [
      '.composer-combined-picker-popover',
      '.composer-diff-action-menu',
      '.composer-human-invite-popover',
      '.sidebar-overflow-menu-popover',
      '.workspace-lock-popover',
      '.ensemble-above-overflow'
    ]) {
      expect(fallbackBlock).toContain(selector)
    }
    expect(fallbackBlock).toContain('background: var(--tw-glass-solid) !important')
    expect(fallbackBlock).toContain('backdrop-filter: none !important')
    expect(fallbackBlock).toContain('-webkit-backdrop-filter: none !important')

    const noBackdropStart = css.indexOf(
      '@supports not ((backdrop-filter: blur(1px))',
      css.indexOf('.composer-combined-picker-popover::after,')
    )
    const noBackdropSection = css.slice(
      noBackdropStart,
      css.indexOf('.composer-combined-picker-column {', noBackdropStart)
    )
    expect(noBackdropSection).toContain(':root body :is(')
    expect(noBackdropSection).toContain('.composer-diff-action-menu')
    expect(noBackdropSection).toContain('background: var(--tw-glass-solid) !important')
    expect(noBackdropSection).toContain('backdrop-filter: none !important')

    const providerCss = readCss('10-provider-shell-overrides.css')
    for (const selector of [
      '[data-composer-style="grok"] .composer-diff-action-menu {',
      ':is([data-composer-style="cursor"], [data-composer-style="chatgpt"]) .composer-diff-action-menu {'
    ]) {
      const providerBlock = cssBlockStartingAt(providerCss, selector)
      expect(providerBlock).toContain('background: var(--tw-popover-glass-bg) !important')
      expect(providerBlock).toContain(
        'backdrop-filter: var(--tw-popover-material-backdrop) !important'
      )
    }
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
    expect(combinedBlock).toContain(
      'backdrop-filter: var(--tw-popover-material-backdrop)'
    )
    expect(combinedBlock).toContain('box-shadow: var(--tw-popover-material-shadow)')
    expect(combinedBlock).not.toContain('85%')
    expect(lightCombinedBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(lightCombinedBlock).not.toContain('85%')
    expect(noBackdropSection).toContain('background: var(--tw-glass-solid) !important')
    expect(noBackdropSection).toContain('backdrop-filter: none !important')
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
    expect(copyBlock).toContain('backdrop-filter: var(--tw-popover-material-backdrop)')
    expect(copyBlock).toContain('box-shadow: var(--tw-popover-material-shadow)')

    expect(obsidianBlock).toContain('.composer-plan-popover.shell-obsidian')
    expect(obsidianBlock).toContain('.composer-ensemble-toggle-popover.shell-obsidian')
    expect(obsidianBlock).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-dark)'
    )
    expect(obsidianBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(obsidianBlock).toContain('box-shadow: var(--tw-popover-material-shadow)')

    expect(alabasterBlock).toContain('.composer-plan-popover.shell-alabaster')
    expect(alabasterBlock).toContain('.composer-ensemble-toggle-popover.shell-alabaster')
    expect(alabasterBlock).toContain(
      '--tw-popover-glass-bg: var(--tw-neutral-material-bg-light)'
    )
    expect(alabasterBlock).toContain('background: var(--tw-popover-glass-bg)')
    expect(alabasterBlock).toContain('box-shadow: var(--tw-popover-material-shadow)')

    const alabasterThemeBlock = cssBlockStartingAt(
      themeCss,
      '[data-theme="alabaster"]:is('
    )
    const obsidianThemeBlock = cssBlockStartingAt(
      themeCss,
      '[data-theme="obsidian"]:is('
    )
    for (const block of [alabasterThemeBlock, obsidianThemeBlock]) {
      expect(block).toContain('.composer-plan-popover')
      expect(block).toContain('.composer-ensemble-toggle-popover')
    }
  })

  it('keeps Grok and Cursor portaled popovers on the shared shell material', () => {
    const css = readCss('10-provider-shell-overrides.css')
    const grokBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-grok,')
    const cursorBlock = cssBlockStartingAt(css, '.composer-combined-picker-popover.shell-cursor,')

    for (const block of [grokBlock, cursorBlock]) {
      expect(block).toContain('.composer-ensemble-toggle-popover.shell-')
      expect(block).toContain('background: var(--tw-popover-glass-bg) !important')
      expect(block).toContain(
        'backdrop-filter: var(--tw-popover-material-backdrop) !important'
      )
      expect(block).toContain('box-shadow: var(--tw-popover-material-shadow) !important')
      expect(block).not.toContain('blur(18px) saturate(150%)')
    }
  })
})
