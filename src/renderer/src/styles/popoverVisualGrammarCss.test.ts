import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(process.cwd(), 'src/renderer/src')

const readRendererFile = (file: string): string => readFileSync(join(rendererRoot, file), 'utf8')

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
      'components/ComposerPlusPicker.tsx',
      'components/ComposerProviderPicker.tsx',
      'components/ComposerScheduleButton.tsx',
      'components/ComposerTimecodes.tsx',
      'components/ComposerVoiceInput.tsx',
      'components/ContextMeterPopover.tsx',
      'components/CopyTranscriptButton.tsx',
      'components/EnsembleModePicker.tsx',
      'components/EnsembleOrchestrationRow.tsx',
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

  it('preserves separate label and description hooks in both permission columns', () => {
    const picker = readRendererFile('components/CombinedPermissionsPicker.tsx')

    expect(picker).toMatch(
      /className="composer-combined-picker-row-body"[\s\S]*?className="composer-combined-picker-row-label"[\s\S]*?className="composer-combined-picker-row-sub"/
    )
    expect(picker).toMatch(
      /className="composer-combined-picker-row-grant-body"[\s\S]*?className="composer-combined-picker-row-label"[\s\S]*?className="composer-combined-picker-row-sub"/
    )
  })
})
