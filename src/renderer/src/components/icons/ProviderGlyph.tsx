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
  return normalized || 'unknown'
}

const ENSEMBLE_SPECTRUM_STOPS = [
  ['0', '#986781', 'ensemble'],
  ['.067', '#705AFF', 'codex-openai'],
  ['.133', '#8C52EF', 'alibaba-qwen'],
  ['.20', '#D72D82', 'liquid'],
  ['.267', '#E22B17', 'openbmb'],
  ['.333', '#B16105', 'claude'],
  ['.40', '#BE5809', 'deep-reinforce-ornith'],
  ['.467', '#8C7508', 'cursor'],
  ['.533', '#538200', 'nvidia'],
  ['.60', '#308713', 'antigravity'],
  ['.667', '#1A8562', 'ollama'],
  ['.733', '#0C8194', 'poolside'],
  ['.80', '#0073E6', 'kimi'],
  ['.867', '#346EEC', 'gemini'],
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
          <stop offset=".68" stopColor="#346EEC" data-brand="gemini" />
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

function unknownGlyphBody(): ReactElement {
  return (
    <>
      <path className="provider-glyph-line" d="M4.6 6.2h14.8v11.6H4.6Z" />
      <path className="provider-glyph-accent" d="m8.1 9.3 2.7 2.7-2.7 2.7" />
      <path className="provider-glyph-line provider-glyph-fine" d="M12.2 14.7h4" />
    </>
  )
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
            {unknownGlyphBody()}
          </g>
          <g className="provider-glyph-foreground">{unknownGlyphBody()}</g>
        </>
      )}
    </svg>
  )
}
