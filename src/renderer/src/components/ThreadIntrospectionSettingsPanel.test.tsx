import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadIntrospectionSettingsPanel } from './ThreadIntrospectionSettingsPanel'

describe('ThreadIntrospectionSettingsPanel', () => {
  it('renders run toolbar and review panel shell', () => {
    const html = renderToStaticMarkup(<ThreadIntrospectionSettingsPanel />)
    expect(html).toContain('Daily retrospective')
    expect(html).toContain('Run introspection (24h)')
    expect(html).toContain('Thread introspection')
    expect(html).toContain('IPC is not wired yet')
  })

  it('disables manual run when IPC is unavailable', () => {
    const html = renderToStaticMarkup(<ThreadIntrospectionSettingsPanel workspaceId="ws-1" />)
    expect(html).toContain('disabled')
    expect(html).toContain('Waiting for Main IPC wiring')
  })
})