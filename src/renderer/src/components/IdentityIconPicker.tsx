import { useState, type JSX } from 'react'
import { accentFromHue, hueForSeed } from '../lib/ensembleAgentPool'
import { NAMED_AGENT_IDENTICONS } from '../lib/agentIdentityCatalog'
import {
  poolIconAssetsByGroup,
  preparePoolIconSvg,
  type PoolIconAsset
} from '../lib/agentPoolIconAssets'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'

export type IdentityIconKind = 'named' | 'seed' | 'asset'

export type IdentityIconValue = {
  iconKind: IdentityIconKind
  hue: number
  slug?: string
  seed?: string
  assetKey?: string
  accent?: string
}

function PoolAssetSwatch({ asset, size }: { asset: PoolIconAsset; size: number }): JSX.Element {
  const accent = asset.accent ?? '#9AA0AA'
  return (
    <span
      className="agent-pool-asset-icon"
      style={{ width: size, height: size, display: 'inline-flex', color: accent }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: preparePoolIconSvg(asset, size, accent) }}
    />
  )
}

export function IdentityIconPicker({
  value,
  seedBase,
  onChange
}: {
  value: IdentityIconValue
  seedBase?: string
  onChange: (next: IdentityIconValue) => void
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const safeHue = Number.isFinite(value.hue) ? value.hue : 0

  const apply = (next: Partial<IdentityIconValue>): void => {
    onChange({ ...value, ...next })
  }

  return (
    <div>
      <div className="agent-pool-icon-controls">
        <button
          type="button"
          className="agent-pool-mini-btn"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          aria-label="Toggle icon picker"
        >
          Icon…
        </button>
        <button
          type="button"
          className="agent-pool-mini-btn"
          title="Reroll the procedural glyph + colour"
          onClick={() => {
            const seed = `${seedBase || 'identity'}#${Date.now().toString(36)}-${Math.random()
              .toString(36)
              .slice(2, 8)}`
            const hue = hueForSeed(seed)
            apply({
              iconKind: 'seed',
              seed,
              slug: undefined,
              assetKey: undefined,
              hue,
              accent: accentFromHue(hue)
            })
          }}
        >
          Shuffle
        </button>
        {value.iconKind === 'seed' && (
          <label className="agent-pool-hue">
            <span className="agent-pool-hue-label">Hue</span>
            <input
              type="range"
              min={0}
              max={359}
              value={safeHue}
              onChange={(event) => {
                const hue = Number(event.target.value)
                apply({ iconKind: 'seed', hue, accent: accentFromHue(hue) })
              }}
              aria-label="Icon hue"
            />
          </label>
        )}
      </div>

      {isOpen && (
        <div className="agent-pool-icon-picker">
          {poolIconAssetsByGroup().map((section) => (
            <div key={section.group} className="agent-pool-icon-section">
              <div className="agent-pool-icon-section-label">{section.group}</div>
              <div className="agent-pool-icon-grid" role="listbox" aria-label={section.group}>
                {section.assets.map((asset) => {
                  const selected = value.iconKind === 'asset' && value.assetKey === asset.key
                  return (
                    <button
                      key={asset.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`agent-pool-icon-cell${selected ? ' is-selected' : ''}`}
                      title={asset.label}
                      onClick={() =>
                        apply({
                          iconKind: 'asset',
                          seed: undefined,
                          slug: undefined,
                          assetKey: asset.key,
                          hue: asset.hue ?? safeHue,
                          accent: asset.accent ?? value.accent
                        })
                      }
                    >
                      <PoolAssetSwatch asset={asset} size={26} />
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="agent-pool-icon-section">
            <div className="agent-pool-icon-section-label">Characters</div>
            <div className="agent-pool-icon-grid" role="listbox" aria-label="Characters">
              {NAMED_AGENT_IDENTICONS.map((entry) => {
                const selected = value.iconKind === 'named' && value.slug === entry.slug
                return (
                  <button
                    key={entry.slug}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`agent-pool-icon-cell${selected ? ' is-selected' : ''}`}
                    title={entry.name}
                    onClick={() =>
                      apply({
                        iconKind: 'named',
                        seed: undefined,
                        assetKey: undefined,
                        slug: entry.slug,
                        hue: entry.hue,
                        accent: entry.accent
                      })
                    }
                  >
                    <AgentIdentityIcon name={entry.name} color={entry.accent} size={26} />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
