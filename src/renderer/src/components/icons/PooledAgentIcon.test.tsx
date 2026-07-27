import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PooledAgentIdentitySnapshot } from '../../../../main/store/types'
import { PooledAgentIcon } from './PooledAgentIcon'

function assetIdentity(assetKey: string): PooledAgentIdentitySnapshot {
  return {
    schemaVersion: 1,
    agentId: 'pool-agent',
    nickname: 'Pool Agent',
    iconKind: 'asset',
    assetKey,
    hue: 210
  }
}

describe('PooledAgentIcon provider assets', () => {
  it('renders persisted external provider keys with official artwork', () => {
    const html = renderToStaticMarkup(
      <PooledAgentIcon identity={assetIdentity('provider:codex')} size={26} />
    )

    expect(html).toContain('data-asset-key="provider:codex"')
    expect(html).toContain('provider-logo-codex-cloud.png')
    expect(html).not.toContain('provider-glyph-codex')
    expect(html).not.toContain('<svg')
  })

  it('keeps TaskWraith-owned Ensemble artwork in the SVG pool', () => {
    const html = renderToStaticMarkup(
      <PooledAgentIcon identity={assetIdentity('provider:ensemble')} size={26} />
    )

    expect(html).toContain('data-asset-key="provider:ensemble"')
    expect(html).toContain('data-provider="ensemble"')
    expect(html).toContain('data-provider-glyph="true"')
  })
})
