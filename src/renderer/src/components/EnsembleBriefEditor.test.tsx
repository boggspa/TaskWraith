import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import { EnsembleBriefEditor } from './EnsembleBriefEditor'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'captain',
    provider: 'codex',
    enabled: true,
    role: 'Captain',
    instructions: '',
    order: 1,
    model: 'gpt-5.5',
    permissionPresetId: 'workspace_write',
    ...overrides
  }
}

describe('EnsembleBriefEditor', () => {
  it('mounts the textarea before the mention overlay so ref-backed sync can attach', () => {
    const html = renderToStaticMarkup(
      <EnsembleBriefEditor
        label="Brief / goal"
        value="Coordinate with @Captain on the next step."
        participants={[participant()]}
        rows={4}
        textareaClassName="settings-roster-textarea"
        onChange={vi.fn()}
      />
    )

    const textareaIndex = html.indexOf('<textarea')
    const overlayIndex = html.indexOf('composer-textarea-highlight')

    expect(textareaIndex).toBeGreaterThanOrEqual(0)
    expect(overlayIndex).toBeGreaterThanOrEqual(0)
    expect(textareaIndex).toBeLessThan(overlayIndex)
  })

  it('renders an explicit commit action when the host provides one', () => {
    const html = renderToStaticMarkup(
      <EnsembleBriefEditor
        label="Goal / brief"
        value="Review the implementation."
        participants={[participant()]}
        rows={4}
        textareaClassName="settings-roster-textarea"
        commitLabel="Save changes"
        commitTitle="Save this participant"
        onCommit={vi.fn()}
        onChange={vi.fn()}
      />
    )

    expect(html).toContain('ensemble-brief-commit-action')
    expect(html).toContain('Save changes')
    expect(html).toContain('Save this participant')
  })

  it('keeps mention highlighting while omitting preset controls in compact hosts', () => {
    const html = renderToStaticMarkup(
      <EnsembleBriefEditor
        label="Goal / brief"
        value="Coordinate with @Captain on the next step."
        participants={[participant()]}
        rows={4}
        textareaClassName="compact-roster-brief"
        textareaAriaLabel="Goal / brief for Captain"
        showPresetControls={false}
        onChange={vi.fn()}
      />
    )

    expect(html).toContain('aria-label="Goal / brief for Captain"')
    expect(html).toContain('has-mention-overlay')
    expect(html).toContain('composer-textarea-highlight')
    expect(html).toContain('composer-mention-token')
    expect(html).toContain('var(--provider-codex-color, var(--accent))')
    expect(html).not.toContain('ensemble-brief-preset-controls')
    expect(html).not.toContain('Brief preset…')
  })
})
