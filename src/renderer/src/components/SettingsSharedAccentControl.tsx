import type React from 'react'
import { useEffect, useState } from 'react'
import type { ThemeAppearance, ThemeCornerStyle } from '../../../main/store/types'
import {
  DEFAULT_THEME_ACCENT_COLOR,
  isDefaultThemeAccentColor,
  resolveThemeAccentColorForAppearance
} from '../../../shared/themeAccentColor'
import {
  accentFromHue,
  normalizePoolIconBrightness,
  normalizePoolIconSaturation,
  parsePoolColorInput,
  rgbStringFromHexColor
} from '../lib/ensembleAgentPool'

function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0
  return ((Math.round(hue) % 360) + 360) % 360
}

function rangeFillStyle(value: number, min: number, max: number): React.CSSProperties {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return {
    '--ensemble-context-slider-fill': `${Math.max(0, Math.min(100, fill))}%`
  } as React.CSSProperties
}

/**
 * The user's message-bubble colour editor.
 *
 * Named "shared" because this control once drove BOTH the bubble and the app
 * accent from one value. It no longer does: `--accent` follows the host OS
 * accent, and this picker owns the bubble (and the "You" label) alone. The
 * class names keep the old word so the stylesheet does not have to move.
 */
export function SettingsSharedAccentControl({
  color,
  themeAppearance,
  cornerStyle,
  transcriptFontFamily,
  onColorChange,
  onCornerStyleChange
}: {
  color: string
  themeAppearance?: ThemeAppearance
  cornerStyle: ThemeCornerStyle
  transcriptFontFamily: string
  onColorChange: (next: string) => void
  onCornerStyleChange: (next: ThemeCornerStyle) => void
}): React.JSX.Element {
  const activeThemeAppearance =
    themeAppearance ??
    (typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') || 'system'
      : 'system')
  const systemPrefersLight =
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-color-scheme: light)').matches)
  const defaultSelected = isDefaultThemeAccentColor(color)
  const safeColor = resolveThemeAccentColorForAppearance(
    color,
    activeThemeAppearance,
    systemPrefersLight
  )
  const parsed = parsePoolColorInput(safeColor) || parsePoolColorInput(DEFAULT_THEME_ACCENT_COLOR)
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
    onColorChange(
      accentFromHue(
        normalizeHue(hue),
        normalizePoolIconBrightness(brightness),
        normalizePoolIconSaturation(saturation)
      )
    )
  }

  const commitHexDraft = (): void => {
    const next = parsePoolColorInput(hexDraft)
    if (!next) {
      setHexDraft(safeColor)
      return
    }
    onColorChange(next.accent)
  }

  const commitRgbDraft = (): void => {
    const next = parsePoolColorInput(rgbDraft)
    if (!next) {
      setRgbDraft(rgbText)
      return
    }
    onColorChange(next.accent)
  }

  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.currentTarget.blur()
  }

  return (
    <section
      className="settings-diff-stat-color-card settings-shared-accent-color-card"
      style={{
        ['--settings-diff-stat-color' as string]: safeColor,
        ['--settings-shared-accent-color' as string]: safeColor
      }}
    >
      <header className="settings-diff-stat-color-header">
        <span className="agent-pool-color-swatch" style={{ backgroundColor: safeColor }} />
        <span className="settings-diff-stat-color-name">Bubble color</span>
        <span className="settings-diff-stat-color-hsl">
          HSL {safeHue} / {safeSaturation}% / {safeBrightness}%
        </span>
        <button
          type="button"
          className="agent-pool-mini-btn settings-diff-stat-color-reset"
          disabled={defaultSelected}
          onClick={() => onColorChange(DEFAULT_THEME_ACCENT_COLOR)}
        >
          Default
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
            aria-label="Message bubble hue"
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
            aria-label="Message bubble saturation"
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
            aria-label="Message bubble luma"
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
              aria-label="Message bubble hex color"
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
              aria-label="Message bubble RGB color"
              spellCheck={false}
            />
          </label>
        </div>
      </div>

      <div className="settings-shared-accent-preview" aria-label="Message bubble preview">
        <div className="settings-shared-accent-preview-copy">
          <span className="settings-shared-accent-preview-kicker">Bubble preview</span>
          <div
            className="settings-shared-accent-preview-message"
            style={{ '--transcript-font-family': transcriptFontFamily } as React.CSSProperties}
          >
            <span className="message-meta user-meta settings-shared-accent-preview-bubble-label">
              You
            </span>
            <div
              className={`message-bubble user settings-shared-accent-preview-bubble ${cornerStyle === 'hard' ? 'is-hard' : 'is-rounded'}`}
            >
              Looks good — this color is your message bubble’s alone.
            </div>
          </div>
        </div>
        <div
          className="settings-shared-accent-corners"
          role="group"
          aria-label="Message bubble corners"
        >
          <span className="settings-shared-accent-corners-label">Corners</span>
          <div className="settings-shared-accent-corners-options">
            {(['rounded', 'hard'] as ThemeCornerStyle[]).map((option) => (
              <button
                key={option}
                type="button"
                className={cornerStyle === option ? 'is-active' : ''}
                aria-pressed={cornerStyle === option}
                onClick={() => onCornerStyleChange(option)}
              >
                {option === 'rounded' ? 'Round' : 'Hard'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
