import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageWebSessionControlView } from './UsageWebSessionControls'

describe('UsageWebSessionControlView', () => {
  it('offers an isolated import without rendering a credential input', () => {
    const html = renderToStaticMarkup(
      <UsageWebSessionControlView
        provider="qwen"
        status={{ configured: false, encryptionAvailable: true }}
        busy={false}
        error={null}
        onImport={() => {}}
        onClear={() => {}}
      />
    )
    expect(html).toContain('modelstudio.console.alibabacloud.com')
    expect(html).toContain('Import web session…')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('cookie')
  })

  it('shows imported state and a clear action', () => {
    const html = renderToStaticMarkup(
      <UsageWebSessionControlView
        provider="mimo"
        status={{
          configured: true,
          encryptionAvailable: true,
          updatedAt: '2026-08-25T20:00:00.000Z'
        }}
        busy={false}
        error={null}
        onImport={() => {}}
        onClear={() => {}}
      />
    )
    expect(html).toContain('Re-import web session…')
    expect(html).toContain('Xiaomi MiMo Token Plan session imported')
    expect(html).toContain('Clear session')
  })
})
