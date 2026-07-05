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
})
