import { useEffect, useId, useState, type KeyboardEvent, type JSX } from 'react'
import {
  accentFromHue,
  DEFAULT_POOL_ICON_BRIGHTNESS,
  DEFAULT_POOL_ICON_SATURATION,
  hueForSeed,
  normalizeHexColor,
  normalizePoolIconBrightness,
  normalizePoolIconSaturation,
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

function shuffleIdentitySeed(seedBase: string | undefined): string {
  return `${seedBase || 'identity'}#${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

export type IdentityIconKind = 'named' | 'seed' | 'asset'

export type IdentityIconValue = {
  iconKind: IdentityIconKind
  hue: number
  saturation?: number
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
  const instanceId = useId().replace(/:/g, '')
  const swatchAccent = accent ?? asset.accent ?? '#9AA0AA'
  return (
    <span
      className="agent-pool-asset-icon"
      style={{ width: size, height: size, display: 'inline-flex', color: swatchAccent }}
      aria-hidden
      dangerouslySetInnerHTML={{
        __html: preparePoolIconSvg(asset, size, swatchAccent, instanceId)
      }}
    />
  )
}

export function IdentityIconPicker({
  value,
  seedBase,
  hideActions = false,
  isOpen: controlledIsOpen,
  onOpenChange,
  onChange
}: {
  value: IdentityIconValue
  seedBase?: string
  hideActions?: boolean
  isOpen?: boolean
  onOpenChange?: (isOpen: boolean) => void
  onChange: (next: IdentityIconValue) => void
}): JSX.Element {
  const [uncontrolledIsOpen, setUncontrolledIsOpen] = useState(false)
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen
  const setIsOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const resolved = typeof next === 'function' ? next(isOpen) : next
    if (controlledIsOpen === undefined) setUncontrolledIsOpen(resolved)
    onOpenChange?.(resolved)
  }
  const safeHue = normalizeHue(value.hue)
  const tintEnabled = value.hueEnabled !== false
  const fallbackColorParts = parsePoolColorInput(value.accent)
  const fallbackSaturation = fallbackColorParts?.saturation ?? DEFAULT_POOL_ICON_SATURATION
  const fallbackBrightness = fallbackColorParts?.brightness ?? DEFAULT_POOL_ICON_BRIGHTNESS
  const safeSaturation = normalizePoolIconSaturation(value.saturation ?? fallbackSaturation)
  const safeBrightness = normalizePoolIconBrightness(value.brightness ?? fallbackBrightness)
  const hasUserTone =
    (typeof value.saturation === 'number' && Number.isFinite(value.saturation)) ||
    (typeof value.brightness === 'number' && Number.isFinite(value.brightness))
  const explicitAccent = hasUserTone ? normalizeHexColor(value.accent) : undefined
  const selectedAccent = explicitAccent ?? accentFromHue(safeHue, safeBrightness, safeSaturation)
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

  const applyColor = ({
    hue = safeHue,
    saturation = safeSaturation,
    brightness = safeBrightness
  }: {
    hue?: number
    saturation?: number
    brightness?: number
  }): void => {
    const nextHue = normalizeHue(hue)
    const nextSaturation = normalizePoolIconSaturation(saturation)
    const nextBrightness = normalizePoolIconBrightness(brightness)
    apply({
      hue: nextHue,
      saturation: nextSaturation,
      brightness: nextBrightness,
      accent: accentFromHue(nextHue, nextBrightness, nextSaturation)
    })
  }

  const colorPatchForPickedIcon = (
    bakedHue: number | undefined,
    bakedAccent: string | undefined
  ): Pick<IdentityIconValue, 'hue' | 'saturation' | 'brightness' | 'accent'> => {
    if (tintEnabled) {
      return {
        hue: safeHue,
        saturation: safeSaturation,
        brightness: safeBrightness,
        accent: selectedAccent
      }
    }
    const fallbackAccent = normalizeHexColor(bakedAccent)
    const fallbackHue = Number.isFinite(bakedHue) ? normalizeHue(bakedHue ?? safeHue) : safeHue
    const fallbackColor = fallbackAccent ?? accentFromHue(fallbackHue)
    const fallbackColorParts = parsePoolColorInput(fallbackColor)
    return {
      hue: fallbackHue,
      saturation: fallbackColorParts?.saturation ?? DEFAULT_POOL_ICON_SATURATION,
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
    apply({
      hue: next.hue,
      saturation: next.saturation,
      brightness: next.brightness,
      accent: next.accent
    })
  }

  const commitRgbDraft = (): void => {
    const next = parsePoolColorInput(rgbDraft)
    if (!next) {
      setRgbDraft(selectedRgbText)
      return
    }
    apply({
      hue: next.hue,
      saturation: next.saturation,
      brightness: next.brightness,
      accent: next.accent
    })
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
        {!hideActions && (
          <span className="agent-pool-icon-actions">
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
                const seed = shuffleIdentitySeed(seedBase)
                const hue = hueForSeed(seed)
                apply({
                  iconKind: 'seed',
                  seed,
                  slug: undefined,
                  assetKey: undefined,
                  hue,
                  saturation: safeSaturation,
                  brightness: safeBrightness,
                  accent: accentFromHue(hue, safeBrightness, safeSaturation)
                })
              }}
            >
              Shuffle
            </button>
          </span>
        )}
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
                applyColor({ hue })
              }}
              aria-label="Icon hue"
            />
          </label>
          <label className="agent-pool-color-slider">
            <span className="agent-pool-hue-label">Saturation</span>
            <input
              type="range"
              min={0}
              max={100}
              value={safeSaturation}
              onChange={(event) => applyColor({ saturation: Number(event.target.value) })}
              aria-label="Icon saturation"
            />
          </label>
          <label className="agent-pool-color-slider">
            <span className="agent-pool-hue-label">Luma</span>
            <input
              type="range"
              min={0}
              max={100}
              value={safeBrightness}
              onChange={(event) => applyColor({ brightness: Number(event.target.value) })}
              aria-label="Icon luma"
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
