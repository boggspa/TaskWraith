import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  API_USAGE_KEY_COPY,
  ApiUsageKeyFieldView,
  describeMutationError,
  type ApiUsageKeyFieldViewProps
} from './ApiUsageKeyField'

function render(overrides: Partial<ApiUsageKeyFieldViewProps> = {}): string {
  return renderToStaticMarkup(
    <ApiUsageKeyFieldView
      provider="anthropic"
      configured={false}
      encryptionAvailable
      draft=""
      busy={false}
      error={null}
      onDraftChange={() => {}}
      onSave={() => {}}
      onClear={() => {}}
      {...overrides}
    />
  )
}

describe('ApiUsageKeyFieldView', () => {
  it('labels the Anthropic Admin API key as usage reporting and never echoes a key', () => {
    const html = render()
    expect(html).toContain('data-provider="anthropic"')
    expect(html).toContain(API_USAGE_KEY_COPY.anthropic.label)
    expect(html).toContain('type="password"')
    expect(html).toContain('placeholder="sk-ant-admin01-…"')
    expect(html).toContain('Claude · Console API')
    expect(html).toContain('never sent to a run')
    // No project id control on the Anthropic card; no Clear until configured.
    expect(html).not.toContain('OpenAI project ID')
    expect(html).not.toContain('>Clear<')
  })

  it('shows the saved state with a Clear button and the save timestamp', () => {
    const html = render({ configured: true, updatedAt: '2026-10-08T01:00:00.000Z' })
    expect(html).toContain('(saved)')
    expect(html).toContain('>Clear<')
    expect(html).toContain('Saved ')
  })

  it('offers the optional project id only on the OpenAI card when a commit handler exists', () => {
    const withProject = render({
      provider: 'openai',
      projectId: 'proj_codex',
      onProjectIdCommit: () => {}
    })
    expect(withProject).toContain('data-provider="openai"')
    expect(withProject).toContain(API_USAGE_KEY_COPY.openai.label)
    expect(withProject).toContain('OpenAI project ID (optional)')
    expect(withProject).toContain('value="proj_codex"')
    expect(withProject).toContain('Codex · OpenAI API')
    const withoutHandler = render({ provider: 'openai' })
    expect(withoutHandler).not.toContain('OpenAI project ID')
  })

  it('disables entry and explains when secure storage is unavailable, and surfaces errors', () => {
    const html = render({ encryptionAvailable: false, error: 'Anthropic rejected this key.' })
    expect(html).toContain('Secure storage is unavailable')
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""/)
    expect(html).toContain('settings-provider-auth-error')
    expect(html).toContain('Anthropic rejected this key.')
  })

  it('maps store mutation errors to user-facing copy', () => {
    expect(describeMutationError('invalidApiKey')).toContain('Enter a key')
    expect(describeMutationError('encryptionUnavailable')).toContain('Secure storage')
    expect(describeMutationError('existingRecordUnreadable')).toContain('Clear it')
    expect(describeMutationError('unavailable')).toContain('not ready')
    expect(describeMutationError(undefined)).toBe('The key could not be saved.')
  })
})
