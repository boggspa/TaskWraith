import { describe, expect, it } from 'vitest'
import {
  getPoolIconAsset,
  poolIconAssetsByGroup,
  POOL_ICON_ASSETS,
  POOL_ICON_GROUPS,
  preparePoolIconSvg
} from './agentPoolIconAssets'
import { resolveProviderBrandLogoSource } from '../components/icons/providerBrandLogoAssets'

describe('agent pool icon assets', () => {
  it('builds a non-empty catalogue spanning multiple groups', () => {
    expect(POOL_ICON_ASSETS.length).toBeGreaterThan(0)
    const groups = new Set(POOL_ICON_ASSETS.map((a) => a.group))
    // The purpose-built set + official provider marks at minimum.
    expect(groups.has('Agent pool')).toBe(true)
    expect(groups.has('Providers')).toBe(true)
  })

  it('includes the featured agent-pool icons keyed by pool: slug', () => {
    const pool = POOL_ICON_ASSETS.filter((a) => a.group === 'Agent pool')
    expect(pool.length).toBeGreaterThanOrEqual(157)
    for (const asset of pool) {
      expect(asset.key.startsWith('pool:')).toBe(true)
      expect(asset.raw).toContain('<svg')
      if (asset.key !== 'pool:glyph-diff-nice') {
        expect(asset.recolor).toBe(true) // they use currentColor / --agent-accent
      }
    }

    expect(getPoolIconAsset('pool:glyph-file-read')?.label).toBe('File Read')
    expect(getPoolIconAsset('pool:glyph-pull-request')?.accent).toBe('#9B51E0')
    expect(getPoolIconAsset('pool:glyph-memory-vault')?.hue).toBe(262)

    const diffNice = getPoolIconAsset('pool:glyph-diff-nice')
    expect(diffNice?.label).toBe('Diff Nice')
    expect(diffNice?.recolor).toBe(false)
    expect(diffNice?.raw).toContain('+69')
    expect(diffNice?.raw).toContain('-420')
  })

  it('offers every provider identity plus TaskWraith-owned Ensemble artwork', () => {
    const providerIds = [
      'gemini',
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'ollama',
      'antigravity',
      'pi',
      'mistral',
      'muse',
      'devin',
      'ensemble'
    ] as const
    const providerAssets = POOL_ICON_ASSETS.filter((asset) => asset.group === 'Providers')

    expect(providerAssets.map((asset) => asset.key).sort()).toEqual(
      providerIds.map((provider) => `provider:${provider}`).sort()
    )

    for (const provider of providerIds) {
      const asset = getPoolIconAsset(`provider:${provider}`)
      expect(asset).toBeDefined()
      expect(asset?.group).toBe('Providers')
      expect(asset?.accent).toMatch(/^#[0-9A-F]{6}$/)
      if (provider === 'ensemble') {
        expect(asset?.raw).toContain('<svg')
        expect(asset?.providerLogo).toBeUndefined()
      } else if (provider === 'muse' || provider === 'devin') {
        expect(asset?.providerLogo).toBe(provider)
        expect(asset?.raw).toBeUndefined()
        expect(resolveProviderBrandLogoSource(provider)).toBeUndefined()
      } else {
        expect(asset?.providerLogo).toBe(provider)
        expect(asset?.raw).toBeUndefined()
        expect(resolveProviderBrandLogoSource(provider)).toBeDefined()
      }
    }
  })

  it('getPoolIconAsset returns undefined for an unknown key', () => {
    expect(getPoolIconAsset('pool:does-not-exist')).toBeUndefined()
    expect(getPoolIconAsset(undefined)).toBeUndefined()
  })

  it('poolIconAssetsByGroup returns ordered non-empty sections only', () => {
    const sections = poolIconAssetsByGroup()
    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      expect(section.assets.length).toBeGreaterThan(0)
      expect(POOL_ICON_GROUPS).toContain(section.group)
    }
    // First non-empty group is the featured "Agent pool".
    expect(sections[0].group).toBe('Agent pool')
  })

  it('preparePoolIconSvg sizes every icon and tints recolourable ones', () => {
    const recolorable = POOL_ICON_ASSETS.find((a) => a.recolor)!
    const sized = preparePoolIconSvg(recolorable, 26, '#123456', 'recolourable-test')
    expect(sized).toContain('width="26"')
    expect(sized).toContain('height="26"')
    expect(sized.toLowerCase()).toContain('#123456')

    // A fixed-palette icon is sized but not forcibly tinted.
    const fixed = POOL_ICON_ASSETS.find((a) => !a.recolor && a.raw)
    if (fixed) {
      const out = preparePoolIconSvg(fixed, 26, '#123456', 'fixed-test')
      expect(out).toContain('width="26"')
    }
  })

  it('preparePoolIconSvg scopes embedded classes without leaking into the host', () => {
    const pool = getPoolIconAsset('pool:neon-node')!
    const poolOut = preparePoolIconSvg(pool, 24, '#ABCDEF', 'pool-test')
    expect(poolOut).toContain('.agent-pool-icon-pool-neon-node-pool-test-line')
    expect(poolOut).not.toContain('class="line')
  })

  it('preserves the fixed-palette Ensemble artwork and namespaces its paint servers', () => {
    const ensemble = getPoolIconAsset('provider:ensemble')!
    expect(ensemble.recolor).toBe(false)

    const first = preparePoolIconSvg(ensemble, 24, '#123456', 'first')
    const second = preparePoolIconSvg(ensemble, 24, '#123456', 'second')

    expect(first).toContain('agent-pool-icon-provider-ensemble-first-')
    expect(second).toContain('agent-pool-icon-provider-ensemble-second-')
    expect(first).toContain(
      'class="agent-pool-icon-provider-ensemble-first-ensemble-line"'
    )
    expect(second).toContain(
      'class="agent-pool-icon-provider-ensemble-second-ensemble-line"'
    )
    expect(first).not.toContain('agent-pool-icon-provider-ensemble-second-')
    expect(second).not.toContain('agent-pool-icon-provider-ensemble-first-')
    expect(first).toContain('stroke-width: 1.85')
    expect(first).toContain('stroke-width: 2.85')
    expect(first).toContain('#F8FAFF')
    expect(first).not.toContain('#123456')
    expect(first).not.toMatch(/url\(#provider-glyph-ensemble-/)
    expect(first).not.toMatch(/href="#provider-glyph-ensemble-/)
  })

  it('preparePoolIconSvg keeps workflow action icons visible when tinted', () => {
    const action = getPoolIconAsset('action:action-run-now')!
    expect(action.group).toBe('Actions')

    const out = preparePoolIconSvg(action, 24, '#06D6A0', 'action-test')
    expect(out).toContain('stroke="var(--workflow-accent)"')
    expect(out).toContain('--workflow-accent: #06D6A0')
  })
})
