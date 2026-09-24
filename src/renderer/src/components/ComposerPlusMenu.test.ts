import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
const pickerSource = readFileSync(new URL('./ComposerPlusPicker.tsx', import.meta.url), 'utf8')

function plusMenuSource(): string {
  const start = composerSource.indexOf('const plusSections: ComposerPlusPickerSection[]')
  const end = composerSource.indexOf('triggerIcon={<PlusSymbolIcon />}', start)
  if (start < 0 || end < 0) throw new Error('Composer plus menu source region is missing')
  return composerSource.slice(start, end)
}

describe('Composer plus menu', () => {
  it('presents one flat list in the intended order', () => {
    const source = plusMenuSource()
    const labels = [
      "label: 'Attachments'",
      "label: 'Folder'",
      "label: attachedWindow ? 'Detach app' : 'Attach app'",
      "label: 'Discord context'",
      "label: 'Stats'",
      "label: 'Diff Studio'",
      "label: 'Open Compact Chat'",
      "label: 'Slash commands'"
    ]

    let previous = -1
    for (const label of labels) {
      const index = source.indexOf(label)
      expect(index, `${label} should be present after the previous row`).toBeGreaterThan(previous)
      previous = index
    }

    expect(source).toContain("id: 'actions'")
    expect(source).not.toContain("title: 'Add'")
    expect(source).not.toContain("title: 'Workspace'")
    expect(source).not.toContain("title: 'Commands'")
    expect(pickerSource).toContain('title?: string')
    expect(pickerSource).toContain('{section.title && (')
  })

  it('uses neutral copy and the existing Stats and Compact Chat launch seams', () => {
    const source = plusMenuSource()

    expect(source).toContain("description: 'View workspace activity and active work'")
    expect(source).toContain("description: 'Review current workspace changes'")
    expect(source).toContain("description: 'Open this chat in a compact window'")
    expect(source).toContain("description: 'Browse available slash commands'")
    expect(source).toContain("typeof onOpenWorkspaceStats !== 'function'")
    expect(source).toContain('onSelect: () => onOpenWorkspaceStats?.()')
    expect(source).toContain("typeof onOpenCompactChat !== 'function'")
    expect(source).toContain('onSelect: () => onOpenCompactChat?.()')
    expect(source).toContain("onSelect: () => openInspectorTab('diff')")

    expect(source).not.toContain("label: 'Status'")
    expect(source).not.toContain("label: 'Models'")
    expect(source).not.toContain("label: 'Review diff'")
    expect(source).not.toContain("openInspectorTab('safety')")
    expect(source).not.toContain("openInspectorTab('capabilities')")
    expect(source).not.toContain('handleReviewCurrentDiff')
    expect(source).not.toContain('AntiGravity')
  })
})
