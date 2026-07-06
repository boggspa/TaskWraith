import { describe, expect, it } from 'vitest'
import {
  getPoolIconAsset,
  poolIconAssetsByGroup,
  POOL_ICON_ASSETS,
  POOL_ICON_GROUPS,
  preparePoolIconSvg
} from './agentPoolIconAssets'

describe('agent pool icon assets', () => {
  it('builds a non-empty catalogue spanning multiple groups', () => {
    expect(POOL_ICON_ASSETS.length).toBeGreaterThan(0)
    const groups = new Set(POOL_ICON_ASSETS.map((a) => a.group))
    // The purpose-built set + the provider glyphs at minimum.
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

  it('provider glyphs are namespaced and carry brand accents', () => {
    const claude = getPoolIconAsset('provider:claude')
    expect(claude).toBeDefined()
    expect(claude?.group).toBe('Providers')
    expect(claude?.accent).toMatch(/^#[0-9A-F]{6}$/)
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
    const sized = preparePoolIconSvg(recolorable, 26, '#123456')
    expect(sized).toContain('width="26"')
    expect(sized).toContain('height="26"')
    expect(sized.toLowerCase()).toContain('#123456')

    // A fixed-palette icon is sized but not forcibly tinted.
    const fixed = POOL_ICON_ASSETS.find((a) => !a.recolor)
    if (fixed) {
      const out = preparePoolIconSvg(fixed, 26, '#123456')
      expect(out).toContain('width="26"')
    }
  })

  it('preparePoolIconSvg scopes embedded classes and slims provider strokes', () => {
    const pool = getPoolIconAsset('pool:neon-node')!
    const poolOut = preparePoolIconSvg(pool, 24, '#ABCDEF')
    expect(poolOut).toContain('.agent-pool-icon-pool-neon-node-line')
    expect(poolOut).not.toContain('class="line')

    const provider = getPoolIconAsset('provider:codex')!
    const providerOut = preparePoolIconSvg(provider, 24)
    expect(providerOut).toContain('.agent-pool-icon-provider-codex-line')
    expect(providerOut).toContain('stroke-width: 1.05')
    expect(providerOut).not.toContain('stroke-width: 1.75')
  })

  it('preparePoolIconSvg keeps workflow action icons visible when tinted', () => {
    const action = getPoolIconAsset('action:action-run-now')!
    expect(action.group).toBe('Actions')

    const out = preparePoolIconSvg(action, 24, '#06D6A0')
    expect(out).toContain('stroke="var(--workflow-accent)"')
    expect(out).toContain('--workflow-accent: #06D6A0')
  })
})
