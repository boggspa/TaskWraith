import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(process.cwd(), 'src/renderer/src')

const readRendererFile = (file: string): string => readFileSync(join(rendererRoot, file), 'utf8')

const readThemeCss = (): string => readRendererFile('styles/theme.css')

const readAssetCss = (file: string): string => readRendererFile(`assets/css/${file}`)

function cssBlockStartingAt(source: string, selector: string): string {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

function rendererSourceFiles(directory = rendererRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return rendererSourceFiles(path)
    if (!['.ts', '.tsx'].includes(extname(entry.name))) return []
    if (entry.name.includes('.test.')) return []
    return [path]
  })
}

function rendererRelativePath(path: string): string {
  return relative(rendererRoot, path).split(sep).join('/')
}

describe('popover visual grammar inventory', () => {
  it('keeps every production consumer of the shared picker shell explicit', () => {
    const owners = rendererSourceFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('composer-combined-picker-popover'))
      .map(rendererRelativePath)
      .sort()

    expect(owners).toEqual([
      'App.tsx',
      'components/CanvasComposerButton.tsx',
      'components/CombinedModelPicker.tsx',
      'components/CombinedPermissionsPicker.tsx',
      'components/ComposerBlackboardButton.tsx',
      'components/ComposerBranchWorktreePopover.tsx',
      'components/ComposerEnsembleToggleButton.tsx',
      'components/ComposerPlusPicker.tsx',
      'components/ComposerProviderPicker.tsx',
      'components/ComposerScheduleButton.tsx',
      'components/ComposerTimecodes.tsx',
      'components/ComposerVoiceInput.tsx',
      'components/ContextMeterPopover.tsx',
      'components/CopyTranscriptButton.tsx',
      'components/EnsembleOrchestrationRow.tsx',
      'components/EnsembleParticipantsAboveRow.tsx',
      'components/EnsembleRosterPresetPicker.tsx',
      'components/GitHubSatellitePopover.tsx',
      'components/MainPaneActionPill.tsx',
      'components/MultiviewLayoutPicker.tsx',
      'components/WorkspaceStatsPopover.tsx'
    ])
  })

  it('records the live menu outliers outside the shared material registry', () => {
    const outlierOwners: Array<[string, string]> = [
      ['app/views/MainAppLayout.tsx', 'side-chat-type-picker-menu'],
      ['components/ChatMediaPanel.tsx', 'message-attachment-context-menu'],
      ['components/ComposerTextareaContextMenu.tsx', 'composer-textarea-context-menu'],
      ['components/DiffFileList.tsx', 'file-editor-context-menu'],
      ['components/FileEditorPanel.tsx', 'file-editor-context-menu'],
      ['components/RightDockSurfaceSwitcher.tsx', 'right-dock-surface-menu'],
      ['components/RosterSettingsPanel.tsx', 'settings-roster-pool-picker'],
      ['components/TranscriptMessageContextMenu.tsx', 'transcript-message-context-menu']
    ]

    for (const [file, className] of outlierOwners) {
      expect(readRendererFile(file), `${file} no longer owns .${className}`).toContain(className)
    }
  })

  it('preserves separate label and description hooks in permission rows', () => {
    const picker = readRendererFile('components/CombinedPermissionsPicker.tsx')
    const pickerCss = readAssetCss('08-theme-picker-overrides.css')

    expect(picker).toMatch(
      /className="composer-combined-picker-row-body"[\s\S]*?className="composer-combined-picker-row-label"[\s\S]*?className="composer-combined-picker-row-sub"/
    )
    expect(pickerCss).not.toContain('.composer-combined-picker-popover.has-tool-grants')
    expect(pickerCss).not.toContain('.composer-combined-picker-row-grant')
    expect(pickerCss).not.toContain('.composer-combined-picker-column-note')
  })
})

describe('popover visual grammar tokens', () => {
  it('defines an environment-independent typography hierarchy', () => {
    const theme = readThemeCss()
    const main = readRendererFile('assets/main.css')

    expect(main.trimStart().startsWith("@import url('../styles/theme.css');")).toBe(true)

    for (const declaration of [
      '--tw-popover-type-family: var(--font-sans)',
      '--tw-popover-type-mono-family: var(--font-mono)',
      '--tw-popover-type-title-size: 0.9375rem',
      '--tw-popover-type-title-line-height: 1.25rem',
      '--tw-popover-type-title-weight: 600',
      '--tw-popover-type-label-size: 0.875rem',
      '--tw-popover-type-label-line-height: 1.1875rem',
      '--tw-popover-type-label-weight: 400',
      '--tw-popover-type-label-selected-weight: 500',
      '--tw-popover-type-description-size: 0.8125rem',
      '--tw-popover-type-description-line-height: 1.0625rem',
      '--tw-popover-type-description-weight: 400',
      '--tw-popover-type-meta-size: 0.6875rem',
      '--tw-popover-type-meta-line-height: 0.9375rem',
      '--tw-popover-type-meta-weight: 500',
      '--tw-popover-type-meta-letter-spacing: 0.01em',
      '--tw-popover-type-meta-text-transform: none',
      '--tw-popover-type-mono-size: 0.75rem',
      '--tw-popover-type-mono-line-height: 1rem',
      '--tw-popover-type-mono-weight: 400'
    ]) {
      expect(theme).toContain(declaration)
    }
  })

  it('defines shell and row metrics without taking over feature placement', () => {
    const theme = readThemeCss()

    for (const declaration of [
      '--tw-popover-shell-radius: 14px',
      '--tw-popover-shell-compact-radius: 12px',
      '--tw-popover-shell-padding: 8px',
      '--tw-popover-shell-compact-padding: 6px',
      '--tw-popover-shell-rich-padding: 10px',
      '--tw-popover-anchor-gap: 8px',
      '--tw-popover-list-gap: 2px',
      '--tw-popover-section-gap: 8px',
      '--tw-popover-row-radius: 9px',
      '--tw-popover-row-min-height: 36px',
      '--tw-popover-row-detailed-min-height: 44px',
      '--tw-popover-row-padding-block: 6px',
      '--tw-popover-row-padding-inline: 10px',
      '--tw-popover-row-gap: 10px',
      '--tw-popover-row-leading-size: 18px',
      '--tw-popover-row-trailing-size: 16px',
      '--tw-popover-row-stack-gap: 2px'
    ]) {
      expect(theme).toContain(declaration)
    }

    expect(theme).toContain('--tw-popover-shell-radius: 7px')
    expect(theme).toContain('--tw-popover-shell-compact-radius: 6px')
    expect(theme).toContain('--tw-popover-row-radius: 4px')

    expect(theme).not.toContain('--tw-popover-z-index')
    expect(theme).not.toContain('--tw-popover-position')
    expect(theme).not.toContain('--tw-popover-transform')
  })

  it('keeps state tokens polarity-neutral until each surface consumes them', () => {
    const theme = readThemeCss()

    for (const declaration of [
      '--tw-popover-state-hover-mix: 6%',
      '--tw-popover-state-highlight-mix: 8%',
      '--tw-popover-state-selected-mix: 4%',
      '--tw-popover-state-danger-hover-mix: 12%',
      '--tw-popover-state-focus-ring-width: 1px',
      '--tw-popover-state-focus-ring-mix: 64%',
      '--tw-popover-state-disabled-opacity: 0.46',
      '--tw-popover-state-transition-duration: 100ms'
    ]) {
      expect(theme).toContain(declaration)
    }

    expect(theme).not.toContain('--tw-popover-hover-bg')
    expect(theme).not.toContain('--tw-popover-selected-bg')
    expect(theme).not.toContain('--tw-popover-focus-color')
  })

  it('keeps the grammar paint-free and feature placement-owned', () => {
    const theme = readThemeCss()
    const grammarStart = theme.indexOf('/* Semantic popover grammar.')
    const grammarEnd = theme.indexOf('/* Scrollbar */', grammarStart)

    expect(grammarStart).toBeGreaterThanOrEqual(0)
    expect(grammarEnd).toBeGreaterThan(grammarStart)

    const grammar = theme.slice(grammarStart, grammarEnd)
    expect(grammar).not.toMatch(/color-mix\(|rgba?\(|#[0-9a-f]{3,8}/i)
    expect(grammar).not.toContain('var(--text-')
    expect(grammar).not.toContain('var(--surface-')
    expect(grammar).not.toContain('var(--accent')
    expect(grammar).not.toContain('var(--focus-ring')
    expect(grammar).not.toContain('var(--font-size-')
    for (const featureOwnedToken of [
      '--tw-popover-width:',
      '--tw-popover-min-width:',
      '--tw-popover-max-width:',
      '--tw-popover-shell-width:',
      '--tw-popover-position:',
      '--tw-popover-overflow:',
      '--tw-popover-transform:',
      '--tw-popover-z-index:'
    ]) {
      expect(grammar).not.toContain(featureOwnedToken)
    }
  })
})

describe('first popover typography consumers', () => {
  it('isolates Settings and New from the sidebar type multiplier at their roots', () => {
    const settingsCss = readAssetCss('05-polish-fx-layouts.css')
    const newCss = readAssetCss('09-ensemble-work-session.css')
    const settings = cssBlockStartingAt(settingsCss, '.sidebar-settings-menu {')
    const newMenu = cssBlockStartingAt(newCss, '.sidebar-new-menu {')

    for (const shell of [settings, newMenu]) {
      expect(shell).toContain('--font-size-sm: var(--tw-popover-type-label-size)')
      expect(shell).toContain('--font-size-xs: var(--tw-popover-type-meta-size)')
      expect(shell).toContain('font-family: var(--tw-popover-type-family)')
      expect(shell).toContain('font-size: var(--tw-popover-type-label-size)')
      expect(shell).toContain('font-weight: var(--tw-popover-type-label-weight)')
      expect(shell).toContain('line-height: var(--tw-popover-type-label-line-height)')
    }

    expect(cssBlockStartingAt(settingsCss, '.sidebar-settings-menu-item {')).toContain(
      'font-size: var(--font-size-sm, 13px)'
    )
    expect(cssBlockStartingAt(newCss, '.sidebar-new-menu-item {')).toContain(
      'font-size: var(--font-size-sm, 13px)'
    )
  })

  it('preserves the existing compact footer scale', () => {
    const footer = cssBlockStartingAt(
      readAssetCss('05-polish-fx-layouts.css'),
      '.sidebar-footer-popover {'
    )

    expect(footer).toContain('--font-size-sm: 12.5px')
    expect(footer).toContain('--font-size-xs: 11px')
  })

  it('stacks permission labels and descriptions without changing shared picker rows', () => {
    const pickerCss = readAssetCss('08-theme-picker-overrides.css')
    const body = cssBlockStartingAt(pickerCss, '.composer-combined-picker-row-body {')
    const label = cssBlockStartingAt(
      pickerCss,
      '.composer-combined-picker-row-body > .composer-combined-picker-row-label {'
    )
    const description = cssBlockStartingAt(
      pickerCss,
      '.composer-combined-picker-row-body > .composer-combined-picker-row-sub {'
    )

    expect(body).toContain('display: flex')
    expect(body).toContain('flex: 1 1 auto')
    expect(body).toContain('min-width: 0')
    expect(body).toContain('flex-direction: column')
    expect(body).toContain('align-items: stretch')
    expect(body).toContain('gap: var(--tw-popover-row-stack-gap)')
    expect(label).toContain('flex: 0 1 auto')
    expect(description).toContain('margin-top: 0')
  })
})
