#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const glyphDir = path.join(scriptDir, 'glyphs')
const catalogPath = path.join(scriptDir, 'provider-glyphs.catalog.svg')
const manifestPath = path.join(scriptDir, 'provider-glyphs.manifest.json')
const contrastStrokeWidth = 1
const contrastLineWidth = 1.75 + contrastStrokeWidth
const contrastAccentWidth = 1.85 + contrastStrokeWidth
const contrastFineWidth = 1.3 + contrastStrokeWidth

const providers = [
  {
    id: 'gemini',
    label: 'Gemini',
    accent: '#2563EB',
    hint: 'offset constellation sparkle',
    body: `
      <path class="accent" d="M12 3.6l1.7 4.6 4.7 1.7-4.7 1.7L12 16.4l-1.7-4.8-4.7-1.7 4.7-1.7Z" />
      <path class="line" d="M4.4 18.2l1.1 2.6 2.6 1-2.6 1-1.1 2.6-1-2.6-2.7-1 2.7-1Z" transform="translate(1 -3)" />
      <path class="line fine" d="M17.8 4.7h2.8" />
      <path class="line fine" d="M19.2 3.3v2.8" />
    `
  },
  {
    id: 'codex',
    label: 'Codex',
    accent: '#A070F2',
    hint: 'asymmetric command cloud with terminal cutout',
    description: 'Original filled asymmetric command cloud with a terminal cutout for Codex. Not an official logo.',
    body: `
      <path class="dot" fill-rule="evenodd" clip-rule="evenodd" d="M5.2 18.9C2.9 18.9 1.2 17.2 1.2 15c0-2 1.3-3.6 3.2-4.2-.1-.4-.1-.8-.1-1.2 0-2.8 2.3-5 5.1-5 1.4 0 2.6.5 3.5 1.4 1-1.2 2.5-1.9 4.2-1.9 3.1 0 5.5 2.5 5.5 5.6 0 .9-.2 1.7-.6 2.4.8.7 1.3 1.8 1.3 3 0 2.1-1.7 3.8-3.9 3.8H5.2ZM7 10.4l1.1-1.2 3 2.8-3 2.8L7 13.6 8.7 12 7 10.4Zm5.2 3h4.3V15h-4.3v-1.6Z" />
    `
  },
  {
    id: 'claude',
    label: 'Claude',
    accent: '#D97706',
    hint: 'uneven radial burst',
    body: `
      <circle class="soft" cx="12" cy="12" r="4.2" />
      <path class="accent" d="M12 4.2v3" />
      <path class="accent" d="M12 16.8v3" />
      <path class="accent" d="M4.2 12h3" />
      <path class="accent" d="M16.8 12h3" />
      <path class="line" d="m6.4 6.4 2.2 2.2" />
      <path class="line" d="m15.4 15.4 2.2 2.2" />
      <path class="line" d="m17.3 6.7-2.1 2.1" />
      <path class="line" d="m8.7 15.3-2 2" />
      <circle class="dot" cx="12" cy="12" r="1.6" />
    `
  },
  {
    id: 'kimi',
    label: 'Kimi',
    accent: '#1A8CFF',
    hint: 'crescent and angled wordmark slash',
    body: `
      <path class="line" d="M15.6 4.7a7.9 7.9 0 1 0 0 14.6 6.1 6.1 0 1 1 0-14.6Z" />
      <path class="accent" d="M8 7.4v9.2" />
      <path class="accent" d="m16 7.4-5.1 4.5 5.1 4.7" />
      <path class="line fine" d="M6.6 12h6.2" />
      <circle class="dot" cx="18.5" cy="5.8" r="1.2" />
    `
  },
  {
    id: 'cursor',
    label: 'Cursor',
    accent: '#E3B91E',
    hint: 'pointer with insertion caret',
    body: `
      <path class="line" d="M5.7 3.8 18.8 12l-6.1 1.3-2.7 5.8Z" />
      <path class="accent" d="m12.7 13.3 4.2 4.1" />
      <path class="line fine" d="M19.1 5.8v5.1" />
      <path class="line fine" d="M16.6 5.8h5" />
      <circle class="dot" cx="7.7" cy="6.2" r="1.1" />
    `
  },
  {
    id: 'grok',
    label: 'Grok',
    accent: '#D8DEE9',
    hint: 'crosshair diagonal slash',
    body: `
      <circle class="line" cx="12" cy="12" r="6.4" />
      <path class="line fine" d="M12 3.8v3" />
      <path class="line fine" d="M12 17.2v3" />
      <path class="line fine" d="M3.8 12h3" />
      <path class="line fine" d="M17.2 12h3" />
      <path class="accent" d="M8.7 15.3 15.3 8.7" />
      <circle class="dot" cx="8.4" cy="15.6" r="1" />
      <circle class="dot" cx="15.6" cy="8.4" r="1" />
    `
  },
  {
    id: 'ollama',
    label: 'Ollama',
    accent: '#20A77A',
    hint: 'llama profile',
    body: `
      <path class="line" d="M5.1 18.3v-4.2c0-1.8 1.5-3.3 3.3-3.3h5.1c1.6 0 2.9 1.3 2.9 2.9v4.6" />
      <path class="accent" d="M15.2 11.5V6.6c0-1.4 1.1-2.5 2.5-2.5h.5c1.1 0 2 .9 2 2v1.7c0 1.1-.9 2-2 2h-3" />
      <path class="line fine" d="m16.5 4.2-.8-1.8" />
      <path class="line fine" d="m18.6 4.2 1-1.7" />
      <path class="line fine" d="M5.1 14.3 3.7 13.5" />
      <path class="line fine" d="M7.2 18.3v2.3" />
      <path class="line fine" d="M13.8 18.3v2.3" />
      <path class="line fine" d="M6.6 20.6h1.3" />
      <path class="line fine" d="M13.2 20.6h1.3" />
      <path class="line fine" d="M18.5 7.6h1.4" />
      <circle class="dot" cx="17.8" cy="6.2" r=".7" />
    `
  },
  {
    id: 'ensemble',
    label: 'Ensemble',
    accent: '#986781',
    hint: 'Confluence Loom with provider-spectrum lanes and pooled blue hub',
    description:
      'Original multicolour Confluence Loom mnemonic for Ensemble. Not an official logo.',
    customArtwork: 'confluence-loom',
    body: ''
  }
]

const ensembleSpectrumStops = [
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
]

const ensembleArtworkStyle = `
  .ensemble-line,
  .ensemble-accent {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ensemble-line {
    stroke: url(#provider-glyph-ensemble-spectrum);
    stroke-width: 1.7;
  }

  .ensemble-accent {
    stroke: url(#provider-glyph-ensemble-hub-blue-pool);
    stroke-width: 1.85;
  }

  .ensemble-tail-outline,
  .ensemble-center-outline {
    fill: none;
    stroke: #000000;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ensemble-tail-outline {
    stroke-width: 3.1;
  }

  .ensemble-center-outline {
    stroke-width: 2.85;
  }

  .ensemble-sparkle-outline {
    fill: #000000;
  }

  .ensemble-sparkle {
    fill: #F8FAFF;
  }
`

const style = `
  .line {
    fill: none;
    stroke: var(--provider-accent);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .accent {
    fill: none;
    stroke: var(--provider-accent);
    stroke-width: 1.85;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .fine {
    stroke-width: 1.3;
    opacity: 0.76;
  }

  .soft {
    fill: var(--provider-accent);
    opacity: 0.12;
    stroke: none;
  }

  .dot {
    fill: var(--provider-accent);
    stroke: none;
  }

  .contrast-outline {
    pointer-events: none;
  }

  .contrast-outline .line {
    stroke: #000000;
    stroke-width: ${contrastLineWidth};
    opacity: 1;
  }

  .contrast-outline .accent {
    stroke: #000000;
    stroke-width: ${contrastAccentWidth};
    opacity: 1;
  }

  .contrast-outline .fine {
    stroke-width: ${contrastFineWidth};
    opacity: 1;
  }

  .contrast-outline .soft {
    fill: none;
    stroke: #000000;
    stroke-width: ${contrastStrokeWidth};
    opacity: 1;
  }

  .contrast-outline .dot {
    fill: #000000;
    stroke: #000000;
    stroke-width: ${contrastStrokeWidth};
    opacity: 1;
  }
`

function indentBody(body, indent) {
  return body
    .trim()
    .split('\n')
    .map((line) => `${indent}${line.trimStart()}`)
    .join('\n')
}

function buildLayeredBody(body, indent = '  ') {
  const paths = indentBody(body, `${indent}  `)
  return `${indent}<g class="contrast-outline" data-provider-glyph-contrast="true" aria-hidden="true">
${paths}
${indent}</g>
${indent}<g class="foreground">
${paths}
${indent}</g>`
}

function buildEnsembleDefinitions(indent = '  ') {
  const stops = ensembleSpectrumStops
    .map(
      ([offset, color, brand]) =>
        `${indent}    <stop offset="${offset}" stop-color="${color}" data-brand="${brand}"/>`
    )
    .join('\n')
  return `${indent}<defs>
${indent}  <linearGradient id="provider-glyph-ensemble-spectrum" gradientUnits="userSpaceOnUse" x1="7.5" y1="7.5" x2="18.2" y2="18.2" color-interpolation="linearRGB">
${stops}
${indent}  </linearGradient>
${indent}  <linearGradient id="provider-glyph-ensemble-hub-blue-pool" gradientUnits="userSpaceOnUse" x1="9.15" y1="12" x2="14.85" y2="12" color-interpolation="linearRGB">
${indent}    <stop offset="0" stop-color="#0C8194" data-brand="poolside"/>
${indent}    <stop offset=".34" stop-color="#0073E6" data-brand="kimi"/>
${indent}    <stop offset=".68" stop-color="#346EEC" data-brand="gemini-google"/>
${indent}    <stop offset="1" stop-color="#3079BC" data-brand="ibm"/>
${indent}  </linearGradient>
${indent}  <path id="provider-glyph-ensemble-channel" d="M12 3.2c3.35 0 6.1 2.7 6.1 6.05 0 2.2-1.25 3.75-3.25 4.4"/>
${indent}  <path id="provider-glyph-ensemble-sparkle" d="m0-1.15.25.9.9.25-.9.25-.25.9-.25-.9-.9-.25.9-.25Z"/>
${indent}</defs>`
}

function buildEnsembleArtwork(indent = '  ') {
  return `${indent}<g class="ensemble-contrast-outline" data-provider-glyph-contrast="true" aria-hidden="true">
${indent}  <use class="ensemble-tail-outline" href="#provider-glyph-ensemble-channel"/>
${indent}  <use class="ensemble-tail-outline" href="#provider-glyph-ensemble-channel" transform="rotate(120 12 12)"/>
${indent}  <use class="ensemble-tail-outline" href="#provider-glyph-ensemble-channel" transform="rotate(240 12 12)"/>
${indent}  <path class="ensemble-center-outline" d="m12 8.7 2.85 1.65v3.3L12 15.3l-2.85-1.65v-3.3Z"/>
${indent}  <use class="ensemble-sparkle-outline" href="#provider-glyph-ensemble-sparkle" transform="translate(19.3 4.6) scale(1.28)"/>
${indent}  <use class="ensemble-sparkle-outline" href="#provider-glyph-ensemble-sparkle" transform="translate(4.35 7) rotate(45) scale(.94)"/>
${indent}  <use class="ensemble-sparkle-outline" href="#provider-glyph-ensemble-sparkle" transform="translate(12 20.35) scale(.84)"/>
${indent}</g>
${indent}<g class="ensemble-foreground">
${indent}  <use class="ensemble-line" href="#provider-glyph-ensemble-channel"/>
${indent}  <use class="ensemble-line" href="#provider-glyph-ensemble-channel" transform="rotate(120 12 12)"/>
${indent}  <use class="ensemble-line" href="#provider-glyph-ensemble-channel" transform="rotate(240 12 12)"/>
${indent}  <path class="ensemble-accent" d="m12 8.7 2.85 1.65v3.3L12 15.3l-2.85-1.65v-3.3Z"/>
${indent}  <use class="ensemble-sparkle" href="#provider-glyph-ensemble-sparkle" transform="translate(19.3 4.6)"/>
${indent}  <use class="ensemble-sparkle" href="#provider-glyph-ensemble-sparkle" transform="translate(4.35 7) rotate(45) scale(.7)"/>
${indent}  <use class="ensemble-sparkle" href="#provider-glyph-ensemble-sparkle" transform="translate(12 20.35) scale(.62)"/>
${indent}</g>`
}

function buildProviderArtwork(provider, indent = '  ') {
  return provider.customArtwork === 'confluence-loom'
    ? buildEnsembleArtwork(indent)
    : buildLayeredBody(provider.body, indent)
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, '')
}

function buildGlyph(provider) {
  const id = `provider-glyph-${provider.id}`
  const description =
    provider.description ??
    `Original monoline ${provider.hint} mnemonic for ${provider.label}. Not an official logo.`
  const customArtwork = provider.customArtwork === 'confluence-loom'
  const glyphStyle = customArtwork ? ensembleArtworkStyle : style
  const definitions = customArtwork ? `${buildEnsembleDefinitions()}\n` : ''
  return stripTrailingWhitespace(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-labelledby="${id}-title ${id}-desc" data-provider="${provider.id}" data-provider-glyph="true" style="color: ${provider.accent}; --provider-accent: ${provider.accent};">
  <title id="${id}-title">${escapeXml(provider.label)} provider glyph</title>
  <desc id="${id}-desc">${escapeXml(description)}</desc>
  <style>
${glyphStyle}
  </style>
${definitions}${buildProviderArtwork(provider)}
</svg>
`)
}

function buildCatalog() {
  const columns = 3
  const cellWidth = 144
  const cellHeight = 210
  const width = columns * cellWidth
  const height = Math.ceil(providers.length / columns) * cellHeight + 24
  const items = providers
    .map((provider, index) => {
      const x = (index % columns) * cellWidth
      const y = Math.floor(index / columns) * cellHeight
      return `  <g transform="translate(${x} ${y})">
    <g transform="translate(40 24) scale(2.65)" style="color: ${provider.accent}; --provider-accent: ${provider.accent};">
${buildProviderArtwork(provider, '      ')}
    </g>
    <g transform="translate(61 112) scale(0.9)" style="color: ${provider.accent}; --provider-accent: ${provider.accent};">
${buildProviderArtwork(provider, '      ')}
    </g>
    <text class="label" x="72" y="168">${escapeXml(provider.label)}</text>
    <text class="accent-label" x="72" y="188">${provider.accent}</text>
    <text class="hint" x="72" y="207">64px + 16px preview</text>
  </g>`
    })
    .join('\n')

  return stripTrailingWhitespace(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-provider-glyph-catalog="true">
  <title>TaskWraith provider mnemonic glyph catalog</title>
  <desc>Original provider mnemonics. These are deliberately simplified and are not official provider logos.</desc>
  <rect class="catalog-background" width="${width}" height="${height}" rx="18" />
  <style>
${style}
${ensembleArtworkStyle}

    [data-provider-glyph-catalog] {
      --catalog-background: #F8FAFC;
      --catalog-label: #0F172A;
      --catalog-accent-label: #475569;
      --catalog-hint: #64748B;
    }

    @media (prefers-color-scheme: dark) {
      [data-provider-glyph-catalog] {
        --catalog-background: #111820;
        --catalog-label: #F1F5F9;
        --catalog-accent-label: #AAB4C2;
        --catalog-hint: #7E8A9A;
      }
    }

    .catalog-background {
      fill: var(--catalog-background);
    }

    .label {
      fill: var(--catalog-label);
      font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-anchor: middle;
      letter-spacing: 0;
    }

    .accent-label {
      fill: var(--catalog-accent-label);
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-anchor: middle;
      letter-spacing: 0;
    }

    .hint {
      fill: var(--catalog-hint);
      font: 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-anchor: middle;
      letter-spacing: 0;
    }
  </style>
${buildEnsembleDefinitions()}
${items}
</svg>
`)
}

function main() {
  fs.rmSync(glyphDir, { recursive: true, force: true })
  fs.mkdirSync(glyphDir, { recursive: true })
  for (const provider of providers) {
    fs.writeFileSync(path.join(glyphDir, `${provider.id}.svg`), buildGlyph(provider), 'utf8')
  }
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      providers.map(({ body: _body, customArtwork: _customArtwork, ...provider }) => provider),
      null,
      2
    )}\n`,
    'utf8'
  )
  fs.writeFileSync(catalogPath, buildCatalog(), 'utf8')
  console.log(`Generated ${providers.length} provider glyphs in ${glyphDir}`)
}

main()
