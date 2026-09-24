import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  StudioTranscriptStatusCard,
  latestStudioTranscriptStatus
} from './StudioTranscriptStatusNotice'

describe('Studio transcript status notice', () => {
  it('renders a non-focus-stealing pending status', () => {
    const markup = renderToStaticMarkup(
      <StudioTranscriptStatusCard
        status={{
          schemaVersion: 1,
          assetId: 'asset-a',
          state: 'pending',
          code: null,
          message: 'Generating an on-device Studio transcript…',
          updatedAt: 10
        }}
      />
    )

    expect(markup).toContain('data-studio-transcript-state="pending"')
    expect(markup).toContain('data-studio-transcript-asset-id="asset-a"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })

  it('renders the typed recognition failure as an assertive operator signal', () => {
    const markup = renderToStaticMarkup(
      <StudioTranscriptStatusCard
        status={{
          schemaVersion: 1,
          assetId: 'asset-a',
          state: 'unavailable',
          code: 'transcribe_failed',
          message: 'Enable Speech Recognition in System Settings.',
          updatedAt: 20
        }}
      />
    )

    expect(markup).toContain('data-studio-transcript-state="unavailable"')
    expect(markup).toContain('data-studio-transcript-code="transcribe_failed"')
    expect(markup).toContain('Studio transcript unavailable')
    expect(markup).toContain('Speech Recognition')
    expect(markup).toContain('aria-live="assertive"')
  })

  it('does not let an older delivery overwrite the active status', () => {
    const current = {
      schemaVersion: 1 as const,
      assetId: 'asset-b',
      state: 'pending' as const,
      code: null,
      message: 'B pending',
      updatedAt: 20
    }
    const stale = {
      schemaVersion: 1 as const,
      assetId: 'asset-a',
      state: 'unavailable' as const,
      code: 'transcribe_failed',
      message: 'late A failure',
      updatedAt: 10
    }
    expect(latestStudioTranscriptStatus(current, stale)).toBe(current)
  })

  it('is wired through the preload and always-mounted Composer surface', () => {
    const composer = readFileSync(path.resolve(__dirname, 'Composer.tsx'), 'utf8')
    const preload = readFileSync(path.resolve(__dirname, '../../../preload/index.ts'), 'utf8')
    expect(composer).toContain('<StudioTranscriptStatusNotice />')
    expect(preload).toContain('ipcRenderer.on(STUDIO_TRANSCRIPT_STATUS_CHANNEL, handler)')
    expect(preload).toContain(
      'ipcRenderer.removeListener(STUDIO_TRANSCRIPT_STATUS_CHANNEL, handler)'
    )
  })
})
