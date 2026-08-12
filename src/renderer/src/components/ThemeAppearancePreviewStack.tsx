import type React from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { ThemeAppearance } from '../../../main/store/types'
import './ThemeAppearancePreviewStack.css'

export interface ThemeAppearancePreviewOption {
  value: ThemeAppearance
  label: string
}

/** The same selectable themes exposed by Settings → Appearance. */
export const THEME_APPEARANCE_PREVIEW_OPTIONS: readonly ThemeAppearancePreviewOption[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'rainbow', label: 'Rainbow' },
  { value: 'nebula', label: 'Nebula' },
  { value: 'citrus', label: 'Citrus' },
  { value: 'twilight', label: 'Twilight' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'forest', label: 'Forest' },
  { value: 'cyber', label: 'Cyber' },
  { value: 'candy', label: 'Candy' },
  { value: 'mist', label: 'Mist' },
  { value: 'sage', label: 'Sage' }
]

interface ThemePreviewPalette {
  app: string
  sidebar: string
  surface: string
  border: string
  text: string
  muted: string
  accent: string
  accentSecondary: string
}

function palette(overrides: Partial<ThemePreviewPalette> = {}): ThemePreviewPalette {
  return {
    app: '#141414',
    sidebar: '#191a1f',
    surface: '#26272f',
    border: 'rgba(255, 255, 255, 0.14)',
    text: '#f4f6fb',
    muted: '#969daa',
    accent: '#5a8cff',
    accentSecondary: '#bf7cff',
    ...overrides
  }
}

/**
 * These are intentionally small representative palettes, not a second source
 * of truth for the application theme. The full tokens remain in theme.css;
 * this map only gives every card enough local paint to be recognizable before
 * a person commits to changing the live app theme.
 */
const THEME_PREVIEW_PALETTES: Record<ThemeAppearance, ThemePreviewPalette> = {
  system: palette({
    app: 'linear-gradient(90deg, #f6f8fb 0 50%, #141419 50% 100%)',
    sidebar: 'linear-gradient(90deg, #ffffff 0 50%, #1b1d23 50% 100%)',
    surface: 'linear-gradient(90deg, #ffffff 0 50%, #292b34 50% 100%)',
    border: '#667085',
    accent: '#5a8cff',
    accentSecondary: '#bf7cff'
  }),
  dark: palette(),
  light: palette({
    app: '#f8fafc',
    sidebar: '#ffffff',
    surface: '#eef2f7',
    border: 'rgba(18, 21, 27, 0.16)',
    text: '#181c24',
    muted: '#69717d',
    accent: '#5a8cff',
    accentSecondary: '#85a8ff'
  }),
  midnight: palette({
    app: '#020308',
    sidebar: '#080b14',
    surface: '#141c2e',
    accent: '#6f93ff',
    accentSecondary: '#37a9ff'
  }),
  blue: palette({
    app: '#030b10',
    sidebar: '#071920',
    surface: '#0f2d3a',
    accent: '#41c7e5',
    accentSecondary: '#4fd1c5'
  }),
  purple: palette({
    app: '#090510',
    sidebar: '#1b0d2a',
    surface: '#321848',
    accent: '#d889ff',
    accentSecondary: '#ff5fa2'
  }),
  pink: palette({
    app: '#090510',
    sidebar: '#27112d',
    surface: '#4a1f4c',
    accent: '#ff5fa2',
    accentSecondary: '#bf7cff'
  }),
  red: palette({
    app: '#130609',
    sidebar: '#260e0e',
    surface: '#481e19',
    accent: '#e65b62',
    accentSecondary: '#ff7a59'
  }),
  orange: palette({
    app: '#130609',
    sidebar: '#2a120e',
    surface: '#4c261a',
    accent: '#ff9b54',
    accentSecondary: '#f2c94c'
  }),
  yellow: palette({
    accent: '#d8a900',
    accentSecondary: '#f2c94c'
  }),
  green: palette({
    app: '#030c07',
    sidebar: '#081c10',
    surface: '#163620',
    accent: '#4fd17d',
    accentSecondary: '#8bd450'
  }),
  graphite: palette({
    app: '#111216',
    sidebar: '#2a2c34',
    surface: '#3a3c44',
    accent: '#9da6b8',
    accentSecondary: '#c2c8d4'
  }),
  rainbow: palette({
    app: '#05070d',
    sidebar: '#131726',
    surface: '#1f2438',
    accent: '#ff5fa2',
    accentSecondary: '#62d8ff'
  }),
  nebula: palette({
    app: '#090510',
    sidebar: '#1b0d2a',
    surface: '#321848',
    accent: '#bf7cff',
    accentSecondary: '#62d8ff'
  }),
  citrus: palette({
    app: '#f8fafc',
    sidebar: '#ffffff',
    surface: '#f4f0dc',
    border: 'rgba(79, 62, 16, 0.18)',
    text: '#252014',
    muted: '#736b4c',
    accent: '#d8a900',
    accentSecondary: '#ff9b54'
  }),
  twilight: palette({
    app: '#05070d',
    sidebar: '#131726',
    surface: '#1f2438',
    accent: '#5a8cff',
    accentSecondary: '#bf7cff'
  }),
  ocean: palette({
    app: '#030b10',
    sidebar: '#071920',
    surface: '#0f2d3a',
    accent: '#41c7e5',
    accentSecondary: '#2563eb'
  }),
  sunset: palette({
    app: '#130609',
    sidebar: '#260e18',
    surface: '#4b2132',
    accent: '#ff9b54',
    accentSecondary: '#ff5fa2'
  }),
  forest: palette({
    app: '#030c07',
    sidebar: '#081c10',
    surface: '#163620',
    accent: '#4cc38a',
    accentSecondary: '#84a33b'
  }),
  cyber: palette({
    app: '#05070d',
    sidebar: '#131726',
    surface: '#1f2438',
    accent: '#62d8ff',
    accentSecondary: '#4cc38a'
  }),
  candy: palette({
    app: '#090510',
    sidebar: '#2b1432',
    surface: '#4b244f',
    accent: '#ff5fa2',
    accentSecondary: '#f2c94c'
  }),
  mist: palette({
    app: '#eef4f6',
    sidebar: '#e5eef2',
    surface: '#fbfdfe',
    border: 'rgba(28, 44, 54, 0.16)',
    text: '#122329',
    muted: '#5a7077',
    accent: '#3f8794',
    accentSecondary: '#9bc6cf'
  }),
  sage: palette({
    app: '#f0f5f0',
    sidebar: '#e7f0e5',
    surface: '#fcfefb',
    border: 'rgba(34, 54, 38, 0.16)',
    text: '#162016',
    muted: '#5f6f5f',
    accent: '#5f8f62',
    accentSecondary: '#a4bf7a'
  }),
  obsidian: palette({
    app: '#181818',
    sidebar: '#f0ece7',
    surface: '#221f24',
    accent: '#c8c0d2',
    accentSecondary: '#d8a07a'
  }),
  alabaster: palette({
    app: '#f8f4ea',
    sidebar: '#17171b',
    surface: '#fffdf8',
    border: 'rgba(47, 42, 35, 0.17)',
    text: '#24211e',
    muted: '#746d64',
    accent: '#8d7e6a',
    accentSecondary: '#b0a193'
  })
}

export function getThemeAppearancePreviewPalette(
  themeAppearance: ThemeAppearance
): ThemePreviewPalette {
  return THEME_PREVIEW_PALETTES[themeAppearance]
}

function paletteStyle(paletteValue: ThemePreviewPalette): CSSProperties {
  return {
    '--theme-preview-app': paletteValue.app,
    '--theme-preview-sidebar': paletteValue.sidebar,
    '--theme-preview-surface': paletteValue.surface,
    '--theme-preview-border': paletteValue.border,
    '--theme-preview-text': paletteValue.text,
    '--theme-preview-muted': paletteValue.muted,
    '--theme-preview-accent': paletteValue.accent,
    '--theme-preview-accent-secondary': paletteValue.accentSecondary
  } as CSSProperties
}

function ThemeWindowPreview({
  paletteValue
}: {
  paletteValue: ThemePreviewPalette
}): React.JSX.Element {
  return (
    <span
      className="theme-appearance-preview-window"
      style={paletteStyle(paletteValue)}
      aria-hidden="true"
    >
      <span className="theme-appearance-preview-sidebar">
        <span className="theme-appearance-preview-brand" />
        <span className="theme-appearance-preview-sidebar-row is-active" />
        <span className="theme-appearance-preview-sidebar-row" />
        <span className="theme-appearance-preview-sidebar-row short" />
      </span>
      <span className="theme-appearance-preview-workspace">
        <span className="theme-appearance-preview-toolbar">
          <span />
          <span />
        </span>
        <span className="theme-appearance-preview-window-card is-featured">
          <span className="theme-appearance-preview-card-line strong" />
          <span className="theme-appearance-preview-card-line" />
          <span className="theme-appearance-preview-card-line short" />
        </span>
        <span className="theme-appearance-preview-window-floating-card">
          <span className="theme-appearance-preview-card-line" />
          <span className="theme-appearance-preview-card-line short" />
        </span>
      </span>
    </span>
  )
}

function ThemeDiffCodePreview({
  additionsColor,
  deletionsColor
}: {
  additionsColor: string
  deletionsColor: string
}): React.JSX.Element {
  return (
    <section className="theme-appearance-preview-diff" aria-label="Theme-aware code diff">
      <div className="theme-appearance-preview-diff-header">
        <span>Theme-aware code diff</span>
        <span>your configurable colors</span>
      </div>
      <pre
        className="theme-appearance-preview-code"
        style={
          {
            '--theme-preview-diff-additions': additionsColor,
            '--theme-preview-diff-deletions': deletionsColor
          } as CSSProperties
        }
      >
        <code>
          <span className="theme-appearance-preview-code-line">
            <span className="theme-appearance-preview-line-number">1</span>
            <span>
              <span className="theme-appearance-preview-code-keyword">const</span> themePreview ={' '}
              {'{'}
            </span>
          </span>
          <span className="theme-appearance-preview-code-line is-deletion">
            <span className="theme-appearance-preview-line-number">2</span>
            <span className="theme-appearance-preview-diff-mark">−</span>
            <span>
              <span className="theme-appearance-preview-code-property">surface</span>:{' '}
              <span className="theme-appearance-preview-code-string">&apos;sidebar&apos;</span>,
            </span>
          </span>
          <span className="theme-appearance-preview-code-line is-addition">
            <span className="theme-appearance-preview-line-number">2</span>
            <span className="theme-appearance-preview-diff-mark">+</span>
            <span>
              <span className="theme-appearance-preview-code-property">surface</span>:{' '}
              <span className="theme-appearance-preview-code-string">
                &apos;sidebar-elevated&apos;
              </span>
              ,
            </span>
          </span>
          <span className="theme-appearance-preview-code-line is-deletion">
            <span className="theme-appearance-preview-line-number">3</span>
            <span className="theme-appearance-preview-diff-mark">−</span>
            <span>
              <span className="theme-appearance-preview-code-property">accent</span>:{' '}
              <span className="theme-appearance-preview-code-string">
                &apos;follow-system&apos;
              </span>
            </span>
          </span>
          <span className="theme-appearance-preview-code-line is-addition">
            <span className="theme-appearance-preview-line-number">3</span>
            <span className="theme-appearance-preview-diff-mark">+</span>
            <span>
              <span className="theme-appearance-preview-code-property">accent</span>:{' '}
              <span className="theme-appearance-preview-code-string">
                &apos;show-my-colors&apos;
              </span>
            </span>
          </span>
          <span className="theme-appearance-preview-code-line">
            <span className="theme-appearance-preview-line-number">4</span>
            <span>{'}'}</span>
          </span>
        </code>
      </pre>
    </section>
  )
}

export function ThemeAppearancePreviewStack({
  themeAppearance,
  additionsColor,
  deletionsColor,
  onThemeChange
}: {
  themeAppearance: ThemeAppearance
  additionsColor: string
  deletionsColor: string
  onThemeChange?: (themeAppearance: ThemeAppearance) => void
}): React.JSX.Element {
  const selectedPalette = getThemeAppearancePreviewPalette(themeAppearance)

  const onThemeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    if (!onThemeChange) return

    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!delta) return

    event.preventDefault()
    const nextIndex =
      (currentIndex + delta + THEME_APPEARANCE_PREVIEW_OPTIONS.length) %
      THEME_APPEARANCE_PREVIEW_OPTIONS.length
    const nextTheme = THEME_APPEARANCE_PREVIEW_OPTIONS[nextIndex].value
    onThemeChange(nextTheme)
    const options = event.currentTarget
      .closest<HTMLElement>('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[data-theme-preview]')
    options?.[nextIndex]?.focus()
  }

  return (
    <section className="theme-appearance-preview-stack" style={paletteStyle(selectedPalette)}>
      <div className="theme-appearance-preview-grid" role="radiogroup" aria-label="Theme previews">
        {THEME_APPEARANCE_PREVIEW_OPTIONS.map((option, index) => {
          const isSelected = themeAppearance === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={`Use ${option.label} theme`}
              className={`theme-appearance-preview-card${isSelected ? ' is-selected' : ''}`}
              data-theme-preview={option.value}
              disabled={!onThemeChange}
              onClick={() => onThemeChange?.(option.value)}
              onKeyDown={(event) => onThemeKeyDown(event, index)}
            >
              <ThemeWindowPreview paletteValue={getThemeAppearancePreviewPalette(option.value)} />
              <span className="theme-appearance-preview-card-label">{option.label}</span>
            </button>
          )
        })}
      </div>
      <ThemeDiffCodePreview additionsColor={additionsColor} deletionsColor={deletionsColor} />
    </section>
  )
}
