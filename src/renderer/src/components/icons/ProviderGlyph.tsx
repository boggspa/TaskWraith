import { useId, type CSSProperties, type ReactElement } from 'react'
import type { ProviderId } from '../../../../main/store/types'

type ProviderGlyphId = ProviderId | string | undefined

interface ProviderGlyphProps {
  provider?: ProviderGlyphId
  accentProvider?: ProviderGlyphId
  className?: string
}

function providerClass(provider?: ProviderGlyphId): string {
  const raw = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  const normalized = raw
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || 'gemini'
}

const ENSEMBLE_SPECTRUM_STOPS = [
  ['0', '#986781', 'ensemble'],
  ['.067', '#705AFF', 'codex-openai'],
  ['.133', '#8C52EF', 'alibaba-qwen'],
  ['.20', '#D72D82', 'liquid'],
  ['.267', '#E22B17', 'openbmb'],
  ['.333', '#B16105', 'claude'],
  ['.40', '#BE5809', 'deep-reinforce-ornith'],
  ['.467', '#8D7312', 'cursor'],
  ['.533', '#538200', 'nvidia'],
  ['.60', '#308713', 'antigravity'],
  ['.667', '#1A8562', 'ollama'],
  ['.733', '#0C8194', 'poolside'],
  ['.80', '#0073E6', 'kimi'],
  ['.867', '#346EEC', 'gemini-google'],
  ['.933', '#3079BC', 'ibm'],
  ['1', '#757575', 'grok']
] as const

function ensembleGlyphBody(instanceId: string): ReactElement {
  const spectrumId = `provider-glyph-ensemble-spectrum-${instanceId}`
  const hubId = `provider-glyph-ensemble-hub-${instanceId}`
  const channelId = `provider-glyph-ensemble-channel-${instanceId}`
  const sparkleId = `provider-glyph-ensemble-sparkle-${instanceId}`
  const channelHref = `#${channelId}`
  const sparkleHref = `#${sparkleId}`

  return (
    <>
      <defs>
        <linearGradient
          id={spectrumId}
          gradientUnits="userSpaceOnUse"
          x1="7.5"
          y1="7.5"
          x2="18.2"
          y2="18.2"
          colorInterpolation="linearRGB"
        >
          {ENSEMBLE_SPECTRUM_STOPS.map(([offset, color, brand]) => (
            <stop key={`${offset}-${brand}`} offset={offset} stopColor={color} data-brand={brand} />
          ))}
        </linearGradient>
        <linearGradient
          id={hubId}
          gradientUnits="userSpaceOnUse"
          x1="9.15"
          y1="12"
          x2="14.85"
          y2="12"
          colorInterpolation="linearRGB"
        >
          <stop offset="0" stopColor="#0C8194" data-brand="poolside" />
          <stop offset=".34" stopColor="#0073E6" data-brand="kimi" />
          <stop offset=".68" stopColor="#346EEC" data-brand="gemini-google" />
          <stop offset="1" stopColor="#3079BC" data-brand="ibm" />
        </linearGradient>
        <path id={channelId} d="M12 3.2c3.35 0 6.1 2.7 6.1 6.05 0 2.2-1.25 3.75-3.25 4.4" />
        <path id={sparkleId} d="m0-1.15.25.9.9.25-.9.25-.25.9-.25-.9-.9-.25.9-.25Z" />
      </defs>
      <g
        className="provider-glyph-contrast-outline provider-glyph-ensemble-outline"
        aria-hidden="true"
      >
        <use
          href={channelHref}
          fill="none"
          stroke="#000000"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use
          href={channelHref}
          transform="rotate(120 12 12)"
          fill="none"
          stroke="#000000"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use
          href={channelHref}
          transform="rotate(240 12 12)"
          fill="none"
          stroke="#000000"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m12 8.7 2.85 1.65v3.3L12 15.3l-2.85-1.65v-3.3Z"
          fill="none"
          stroke="#000000"
          strokeWidth="2.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use href={sparkleHref} transform="translate(19.3 4.6) scale(1.28)" fill="#000000" />
        <use
          href={sparkleHref}
          transform="translate(4.35 7) rotate(45) scale(.94)"
          fill="#000000"
        />
        <use href={sparkleHref} transform="translate(12 20.35) scale(.84)" fill="#000000" />
      </g>
      <g className="provider-glyph-foreground provider-glyph-ensemble-foreground">
        <use
          href={channelHref}
          fill="none"
          stroke={`url(#${spectrumId})`}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use
          href={channelHref}
          transform="rotate(120 12 12)"
          fill="none"
          stroke={`url(#${spectrumId})`}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use
          href={channelHref}
          transform="rotate(240 12 12)"
          fill="none"
          stroke={`url(#${spectrumId})`}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m12 8.7 2.85 1.65v3.3L12 15.3l-2.85-1.65v-3.3Z"
          fill="none"
          stroke={`url(#${hubId})`}
          strokeWidth="1.85"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <use href={sparkleHref} transform="translate(19.3 4.6)" fill="#F8FAFF" />
        <use href={sparkleHref} transform="translate(4.35 7) rotate(45) scale(.7)" fill="#F8FAFF" />
        <use href={sparkleHref} transform="translate(12 20.35) scale(.62)" fill="#F8FAFF" />
      </g>
    </>
  )
}

function glyphBody(provider: string): ReactElement {
  switch (provider) {
    case 'gemini':
      return (
        <>
          <path
            className="provider-glyph-accent"
            d="M12 3.6l1.7 4.6 4.7 1.7-4.7 1.7L12 16.4l-1.7-4.8-4.7-1.7 4.7-1.7Z"
          />
          <path
            className="provider-glyph-line"
            d="M4.4 18.2l1.1 2.6 2.6 1-2.6 1-1.1 2.6-1-2.6-2.7-1 2.7-1Z"
            transform="translate(1 -3)"
          />
          <path className="provider-glyph-line provider-glyph-fine" d="M17.8 4.7h2.8" />
          <path className="provider-glyph-line provider-glyph-fine" d="M19.2 3.3v2.8" />
        </>
      )
    case 'codex':
      return (
        <path
          className="provider-glyph-dot"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M5.2 18.9C2.9 18.9 1.2 17.2 1.2 15c0-2 1.3-3.6 3.2-4.2-.1-.4-.1-.8-.1-1.2 0-2.8 2.3-5 5.1-5 1.4 0 2.6.5 3.5 1.4 1-1.2 2.5-1.9 4.2-1.9 3.1 0 5.5 2.5 5.5 5.6 0 .9-.2 1.7-.6 2.4.8.7 1.3 1.8 1.3 3 0 2.1-1.7 3.8-3.9 3.8H5.2ZM7 10.4l1.1-1.2 3 2.8-3 2.8L7 13.6 8.7 12 7 10.4Zm5.2 3h4.3V15h-4.3v-1.6Z"
        />
      )
    case 'claude':
      return (
        <>
          <circle className="provider-glyph-soft" cx="12" cy="12" r="4.2" />
          <path className="provider-glyph-accent" d="M12 4.2v3" />
          <path className="provider-glyph-accent" d="M12 16.8v3" />
          <path className="provider-glyph-accent" d="M4.2 12h3" />
          <path className="provider-glyph-accent" d="M16.8 12h3" />
          <path className="provider-glyph-line" d="m6.4 6.4 2.2 2.2" />
          <path className="provider-glyph-line" d="m15.4 15.4 2.2 2.2" />
          <path className="provider-glyph-line" d="m17.3 6.7-2.1 2.1" />
          <path className="provider-glyph-line" d="m8.7 15.3-2 2" />
          <circle className="provider-glyph-dot" cx="12" cy="12" r="1.6" />
        </>
      )
    case 'kimi':
      return (
        <>
          <path
            className="provider-glyph-line"
            d="M15.6 4.7a7.9 7.9 0 1 0 0 14.6 6.1 6.1 0 1 1 0-14.6Z"
          />
          <path className="provider-glyph-accent" d="M8 7.4v9.2" />
          <path className="provider-glyph-accent" d="m16 7.4-5.1 4.5 5.1 4.7" />
          <path className="provider-glyph-line provider-glyph-fine" d="M6.6 12h6.2" />
          <circle className="provider-glyph-dot" cx="18.5" cy="5.8" r="1.2" />
        </>
      )
    case 'cursor':
      return (
        <>
          <path className="provider-glyph-line" d="M5.7 3.8 18.8 12l-6.1 1.3-2.7 5.8Z" />
          <path className="provider-glyph-accent" d="m12.7 13.3 4.2 4.1" />
          <path className="provider-glyph-line provider-glyph-fine" d="M19.1 5.8v5.1" />
          <path className="provider-glyph-line provider-glyph-fine" d="M16.6 5.8h5" />
          <circle className="provider-glyph-dot" cx="7.7" cy="6.2" r="1.1" />
        </>
      )
    case 'grok':
      return (
        <>
          <circle className="provider-glyph-line" cx="12" cy="12" r="6.4" />
          <path className="provider-glyph-line provider-glyph-fine" d="M12 3.8v3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M12 17.2v3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M3.8 12h3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M17.2 12h3" />
          <path className="provider-glyph-accent" d="M8.7 15.3 15.3 8.7" />
          <circle className="provider-glyph-dot" cx="8.4" cy="15.6" r="1" />
          <circle className="provider-glyph-dot" cx="15.6" cy="8.4" r="1" />
        </>
      )
    case 'ollama':
      return (
        <>
          <path
            className="provider-glyph-line"
            d="M5.1 18.3v-4.2c0-1.8 1.5-3.3 3.3-3.3h5.1c1.6 0 2.9 1.3 2.9 2.9v4.6"
          />
          <path
            className="provider-glyph-accent"
            d="M15.2 11.5V6.6c0-1.4 1.1-2.5 2.5-2.5h.5c1.1 0 2 .9 2 2v1.7c0 1.1-.9 2-2 2h-3"
          />
          <path className="provider-glyph-line provider-glyph-fine" d="m16.5 4.2-.8-1.8" />
          <path className="provider-glyph-line provider-glyph-fine" d="m18.6 4.2 1-1.7" />
          <path className="provider-glyph-line provider-glyph-fine" d="M5.1 14.3 3.7 13.5" />
          <path className="provider-glyph-line provider-glyph-fine" d="M7.2 18.3v2.3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M13.8 18.3v2.3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M6.6 20.6h1.3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M13.2 20.6h1.3" />
          <path className="provider-glyph-line provider-glyph-fine" d="M18.5 7.6h1.4" />
          <circle className="provider-glyph-dot" cx="17.8" cy="6.2" r=".7" />
        </>
      )
    default:
      return (
        <>
          <path className="provider-glyph-line" d="M4.6 6.2h14.8v11.6H4.6Z" />
          <path className="provider-glyph-accent" d="m8.1 9.3 2.7 2.7-2.7 2.7" />
          <path className="provider-glyph-line provider-glyph-fine" d="M12.2 14.7h4" />
        </>
      )
  }
}

export function ProviderGlyph({ provider, accentProvider, className }: ProviderGlyphProps): ReactElement {
  const providerKey = providerClass(provider)
  const accentProviderKey = providerClass(accentProvider || provider)
  const instanceId = useId().replace(/:/g, '')
  const style = {
    '--provider-accent': `var(--provider-${accentProviderKey}-color, currentColor)`
  } as CSSProperties
  return (
    <svg
      viewBox="0 0 24 24"
      className={['provider-glyph', `provider-glyph-${providerKey}`, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
      aria-hidden="true"
    >
      {providerKey === 'ensemble' ? (
        ensembleGlyphBody(instanceId)
      ) : (
        <>
          <g className="provider-glyph-contrast-outline" aria-hidden="true">
            {glyphBody(providerKey)}
          </g>
          <g className="provider-glyph-foreground">{glyphBody(providerKey)}</g>
        </>
      )}
    </svg>
  )
}
