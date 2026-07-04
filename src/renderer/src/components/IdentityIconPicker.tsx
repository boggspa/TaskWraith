import { useEffect, useState, type KeyboardEvent, type JSX } from 'react'
import {
  accentFromHue,
  DEFAULT_POOL_ICON_BRIGHTNESS,
  hueForSeed,
  normalizeHexColor,
  normalizePoolIconBrightness,
  parsePoolColorInput,
  POOL_ICON_NEUTRAL,
  rgbStringFromHexColor
} from '../lib/ensembleAgentPool'
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
  brightness?: number
  slug?: string
  seed?: string
  assetKey?: string
  accent?: string
  hueEnabled?: boolean
}

function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0
  return ((Math.round(hue) % 360) + 360) % 360
}

function PoolAssetSwatch({
  asset,
  size,
  accent
}: {
  asset: PoolIconAsset
  size: number
  accent?: string
}): JSX.Element {
  const swatchAccent = accent ?? asset.accent ?? '#9AA0AA'
  return (
    <span
      className="agent-pool-asset-icon"
      style={{ width: size, height: size, display: 'inline-flex', color: swatchAccent }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: preparePoolIconSvg(asset, size, swatchAccent) }}
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
  const safeHue = normalizeHue(value.hue)
  const tintEnabled = value.hueEnabled !== false
  const fallbackBrightness =
    parsePoolColorInput(value.accent)?.brightness ?? DEFAULT_POOL_ICON_BRIGHTNESS
  const safeBrightness = normalizePoolIconBrightness(value.brightness ?? fallbackBrightness)
  const hasUserBrightness =
    typeof value.brightness === 'number' && Number.isFinite(value.brightness)
  const explicitAccent = hasUserBrightness ? normalizeHexColor(value.accent) : undefined
  const selectedAccent = explicitAccent ?? accentFromHue(safeHue, safeBrightness)
  const previewAccent = tintEnabled ? selectedAccent : POOL_ICON_NEUTRAL
  const selectedRgbText = rgbStringFromHexColor(selectedAccent)
  const [hexDraft, setHexDraft] = useState(selectedAccent)
  const [rgbDraft, setRgbDraft] = useState(selectedRgbText)

  useEffect(() => {
    setHexDraft(selectedAccent)
    setRgbDraft(selectedRgbText)
  }, [selectedAccent, selectedRgbText])

  const apply = (next: Partial<IdentityIconValue>): void => {
    onChange({ ...value, ...next })
  }

  const applyColor = (hue: number, brightness = safeBrightness): void => {
    const nextHue = normalizeHue(hue)
    const nextBrightness = normalizePoolIconBrightness(brightness)
    apply({
      hue: nextHue,
      brightness: nextBrightness,
      accent: accentFromHue(nextHue, nextBrightness)
    })
  }

  const colorPatchForPickedIcon = (
    bakedHue: number | undefined,
    bakedAccent: string | undefined
  ): Pick<IdentityIconValue, 'hue' | 'brightness' | 'accent'> => {
    if (tintEnabled) {
      return { hue: safeHue, brightness: safeBrightness, accent: selectedAccent }
    }
    const fallbackAccent = normalizeHexColor(bakedAccent)
    const fallbackHue = Number.isFinite(bakedHue) ? normalizeHue(bakedHue ?? safeHue) : safeHue
    const fallbackColor = fallbackAccent ?? accentFromHue(fallbackHue)
    const fallbackColorParts = parsePoolColorInput(fallbackColor)
    return {
      hue: fallbackHue,
      brightness: fallbackColorParts?.brightness ?? DEFAULT_POOL_ICON_BRIGHTNESS,
      accent: fallbackColor
    }
  }

  const commitHexDraft = (): void => {
    const next = parsePoolColorInput(hexDraft)
    if (!next) {
      setHexDraft(selectedAccent)
      return
    }
    apply({ hue: next.hue, brightness: next.brightness, accent: next.accent })
  }

  const commitRgbDraft = (): void => {
    const next = parsePoolColorInput(rgbDraft)
    if (!next) {
      setRgbDraft(selectedRgbText)
      return
    }
    apply({ hue: next.hue, brightness: next.brightness, accent: next.accent })
  }

  const blurOnEnter =
    () =>
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      event.currentTarget.blur()
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
              brightness: safeBrightness,
              accent: accentFromHue(hue, safeBrightness)
            })
          }}
        >
          Shuffle
        </button>
        <div className="agent-pool-color-controls">
          <label className="agent-pool-color-slider">
            <span className="agent-pool-hue-label">Hue</span>
            <input
              type="range"
              min={0}
              max={359}
              value={safeHue}
              onChange={(event) => {
                const hue = Number(event.target.value)
                applyColor(hue)
              }}
              aria-label="Icon hue"
            />
          </label>
          <label className="agent-pool-color-slider">
            <span className="agent-pool-hue-label">Brightness</span>
            <input
              type="range"
              min={0}
              max={100}
              value={safeBrightness}
              onChange={(event) => applyColor(safeHue, Number(event.target.value))}
              aria-label="Icon brightness"
            />
          </label>
          <div className="agent-pool-color-fields">
            <span
              className="agent-pool-color-swatch"
              style={{ backgroundColor: selectedAccent }}
              aria-hidden
            />
            <label className="agent-pool-color-field">
              <span>Hex</span>
              <input
                type="text"
                value={hexDraft}
                onChange={(event) => setHexDraft(event.target.value)}
                onBlur={commitHexDraft}
                onKeyDown={blurOnEnter()}
                aria-label="Icon color hex value"
                spellCheck={false}
              />
            </label>
            <label className="agent-pool-color-field agent-pool-color-field--rgb">
              <span>RGB</span>
              <input
                type="text"
                value={rgbDraft}
                onChange={(event) => setRgbDraft(event.target.value)}
                onBlur={commitRgbDraft}
                onKeyDown={blurOnEnter()}
                aria-label="Icon color RGB value"
                spellCheck={false}
              />
            </label>
          </div>
        </div>
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
                          ...colorPatchForPickedIcon(asset.hue, asset.accent)
                        })
                      }
                    >
                      <PoolAssetSwatch
                        asset={asset}
                        size={26}
                        accent={previewAccent}
                      />
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
                        ...colorPatchForPickedIcon(entry.hue, entry.accent)
                      })
                    }
                  >
                    <AgentIdentityIcon
                      name={entry.name}
                      color={previewAccent}
                      size={26}
                    />
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
