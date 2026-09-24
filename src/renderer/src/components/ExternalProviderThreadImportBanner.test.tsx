import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { externalProviderThreadImportMessageLabel } from '../../../shared/externalProviderThreadImport'
import { ExternalProviderThreadImportBanner } from './ExternalProviderThreadImportBanner'

describe('ExternalProviderThreadImportBanner', () => {
  it('keeps imported provenance and non-resume posture visible without a source path', () => {
    const html = renderToStaticMarkup(
      <ExternalProviderThreadImportBanner
        metadata={{
          schemaVersion: 1,
          provider: 'cursor',
          trust: 'external_untrusted',
          sourceFileName: 'composer.jsonl',
          sourceFingerprintSha256: 'a'.repeat(64),
          sourceMessageCount: 3,
          importedMessageCount: 2,
          omittedRecordCount: 1,
          invalidRecordCount: 0,
          importedAt: '2026-08-20T00:00:00.000Z',
          truncated: true,
          promptBridgeEnabled: false,
          nativeResumeAllowed: false
        }}
      />
    )

    expect(html).toContain('Imported Cursor snapshot')
    expect(html).toContain('External and untrusted')
    expect(html).toContain('native resume disabled')
    expect(html).toContain('source truncated')
    expect(html).not.toContain('/Users/')
  })

  it('labels imported authors without presenting their user row as You', () => {
    expect(externalProviderThreadImportMessageLabel('claude', 'user')).toBe(
      'Imported Claude · User'
    )
    expect(externalProviderThreadImportMessageLabel('claude', 'assistant')).toBe(
      'Imported Claude · Assistant'
    )
    expect(externalProviderThreadImportMessageLabel('claude', 'system')).toBe(
      'Imported Claude · Notice'
    )
  })
})
