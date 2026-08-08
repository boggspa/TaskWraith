import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderPassthroughSettings } from './ProviderPassthroughSettings'
import { CURSOR_HARNESS_SUPPRESS_DISCLOSURE } from '../../../shared/providerHarnessPosture'

describe('ProviderPassthroughSettings', () => {
  it('renders provider rows with default suppress for Claude', () => {
    const html = renderToStaticMarkup(
      <ProviderPassthroughSettings postureMap={{}} onChange={vi.fn()} />
    )
    expect(html).toContain('Provider passthrough')
    expect(html).toContain('Claude')
    expect(html).toContain('aria-label="Claude skills posture"')
    expect(html).toContain('value="suppress"')
  })

  it('surfaces the Cursor suppress disclosure when suppress is selected', () => {
    const html = renderToStaticMarkup(
      <ProviderPassthroughSettings
        postureMap={{ cursor: { skills: 'suppress', hooks: 'allow-native' } }}
        onChange={vi.fn()}
      />
    )
    expect(html).toContain(CURSOR_HARNESS_SUPPRESS_DISCLOSURE)
  })
})
