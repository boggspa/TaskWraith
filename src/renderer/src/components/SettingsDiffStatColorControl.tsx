// The per-tone diff-stat colour editor extracted from SettingsPanel.tsx.
//
// Local-copy note (mirroring SettingsSharedAccentControl, which keeps its own
// copies of both helpers): `rangeFillStyle` is deliberately duplicated here
// because SettingsPanel still needs its original for other sliders, while
// `normalizeHue` moved here with the component. Every dependency is shared/ or
// renderer-local, so this module adds no renderer -> main runtime edge.
import type React from 'react'
import { useEffect, useState } from 'react'
import type { DiffStatColors } from '../../../shared/diffStatColors'
import { normalizeDiffStatColors } from '../../../shared/diffStatColors'
import {
  accentFromHue,
  normalizePoolIconBrightness,
  normalizePoolIconSaturation,
  parsePoolColorInput,
  rgbStringFromHexColor
} from '../lib/ensembleAgentPool'

const rangeFillStyle = (value: number, min: number, max: number): React.CSSProperties => {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return {
    '--ensemble-context-slider-fill': `${Math.max(0, Math.min(100, fill))}%`
  } as React.CSSProperties
}

type DiffStatColorTone = keyof DiffStatColors

function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0
  return ((Math.round(hue) % 360) + 360) % 360
}

export function SettingsDiffStatColorControl({
  tone,
  label,
  value,
  fallback,
  onChange
}: {
  tone: DiffStatColorTone
  label: string
  value: string
  fallback: string
  onChange: (next: string) => void
}): React.JSX.Element {
  const safeColor = normalizeDiffStatColors({ [tone]: value })[tone] || fallback
  const parsed = parsePoolColorInput(safeColor) || parsePoolColorInput(fallback)
  const safeHue = normalizeHue(parsed?.hue ?? 0)
  const safeSaturation = normalizePoolIconSaturation(parsed?.saturation ?? 70)
  const safeBrightness = normalizePoolIconBrightness(parsed?.brightness ?? 45)
  const rgbText = rgbStringFromHexColor(safeColor)
  const [hexDraft, setHexDraft] = useState(safeColor)
  const [rgbDraft, setRgbDraft] = useState(rgbText)

  useEffect(() => {
    setHexDraft(safeColor)
    setRgbDraft(rgbText)
  }, [safeColor, rgbText])

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
    onChange(accentFromHue(nextHue, nextBrightness, nextSaturation))
  }

  const commitHexDraft = (): void => {
    const next = parsePoolColorInput(hexDraft)
    if (!next) {
      setHexDraft(safeColor)
      return
    }
    onChange(next.accent)
  }

  const commitRgbDraft = (): void => {
    const next = parsePoolColorInput(rgbDraft)
    if (!next) {
      setRgbDraft(rgbText)
      return
    }
    onChange(next.accent)
  }

  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.currentTarget.blur()
  }

  return (
    <section
      className={`settings-diff-stat-color-card settings-diff-stat-color-card--${tone}`}
      style={{ ['--settings-diff-stat-color' as string]: safeColor }}
    >
      <header className="settings-diff-stat-color-header">
        <span className="agent-pool-color-swatch" style={{ backgroundColor: safeColor }} />
        <span className="settings-diff-stat-color-name">{label}</span>
        <span className="settings-diff-stat-color-hsl">
          HSL {safeHue} / {safeSaturation}% / {safeBrightness}%
        </span>
        <button
          type="button"
          className="agent-pool-mini-btn settings-diff-stat-color-reset"
          disabled={safeColor === fallback}
          onClick={() => onChange(fallback)}
        >
          Reset
        </button>
      </header>
      <div className="agent-pool-color-controls settings-diff-stat-color-controls">
        <label className="agent-pool-color-slider">
          <span className="agent-pool-hue-label">Hue</span>
          <input
            type="range"
            className="composer-ensemble-context-slider"
            min={0}
            max={359}
            value={safeHue}
            onChange={(event) => applyColor({ hue: Number(event.target.value) })}
            aria-label={`${label} hue`}
            style={rangeFillStyle(safeHue, 0, 359)}
          />
        </label>
        <label className="agent-pool-color-slider">
          <span className="agent-pool-hue-label">Saturation</span>
          <input
            type="range"
            className="composer-ensemble-context-slider"
            min={0}
            max={100}
            value={safeSaturation}
            onChange={(event) => applyColor({ saturation: Number(event.target.value) })}
            aria-label={`${label} saturation`}
            style={rangeFillStyle(safeSaturation, 0, 100)}
          />
        </label>
        <label className="agent-pool-color-slider">
          <span className="agent-pool-hue-label">Luma</span>
          <input
            type="range"
            className="composer-ensemble-context-slider"
            min={0}
            max={100}
            value={safeBrightness}
            onChange={(event) => applyColor({ brightness: Number(event.target.value) })}
            aria-label={`${label} luma`}
            style={rangeFillStyle(safeBrightness, 0, 100)}
          />
        </label>
        <div className="agent-pool-color-fields">
          <span className="agent-pool-color-swatch" style={{ backgroundColor: safeColor }} />
          <label className="agent-pool-color-field">
            <span>Hex</span>
            <input
              type="text"
              value={hexDraft}
              onChange={(event) => setHexDraft(event.target.value)}
              onBlur={commitHexDraft}
              onKeyDown={blurOnEnter}
              aria-label={`${label} hex color`}
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
              onKeyDown={blurOnEnter}
              aria-label={`${label} RGB color`}
              spellCheck={false}
            />
          </label>
        </div>
      </div>
    </section>
  )
}
