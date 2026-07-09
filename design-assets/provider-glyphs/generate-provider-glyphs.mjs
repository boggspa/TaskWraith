#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const glyphDir = path.join(scriptDir, 'glyphs')
const catalogPath = path.join(scriptDir, 'provider-glyphs.catalog.svg')
const manifestPath = path.join(scriptDir, 'provider-glyphs.manifest.json')

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
    hint: 'prompt box and bracket cursor',
    body: `
      <path class="line" d="M4.6 6.2h14.8v11.6H4.6Z" />
      <path class="accent" d="m8.1 9.3 2.7 2.7-2.7 2.7" />
      <path class="line fine" d="M12.2 14.7h4" />
      <path class="line fine" d="M6.7 4.4 4.6 6.2" />
      <path class="line fine" d="M17.3 19.6l2.1-1.8" />
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
    accent: '#E8DDE3',
    hint: 'staggered three-agent roster with identicon visor',
    body: `
      <circle class="line fine" cx="6.7" cy="7.3" r="2.35" />
      <circle class="line fine" cx="17.3" cy="7.3" r="2.35" />
      <circle class="accent" cx="12" cy="6.5" r="2.7" />
      <path class="line fine" d="M2.8 18.4c.35-2.9 2.65-4.7 5.45-4.7 1.15 0 2.25.3 3.15.85" />
      <path class="line fine" d="M21.2 18.4c-.35-2.9-2.65-4.7-5.45-4.7-1.15 0-2.25.3-3.15.85" />
      <path class="accent" d="M6.6 19.8c.25-3.45 2.55-5.65 5.4-5.65s5.15 2.2 5.4 5.65" />
      <path class="line fine" d="M5.55 7.35h2.3" />
      <path class="line fine" d="M16.15 7.35h2.3" />
      <path class="line" d="M9.8 6.55h4.4" />
      <path class="line fine" d="m9.7 12.25 2.3 1.9 2.3-1.9" />
    `
  }
]

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
`

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
  return stripTrailingWhitespace(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-labelledby="${id}-title ${id}-desc" data-provider="${provider.id}" style="color: ${provider.accent}; --provider-accent: ${provider.accent};">
  <title id="${id}-title">${escapeXml(provider.label)} provider glyph</title>
  <desc id="${id}-desc">Original monoline ${escapeXml(provider.hint)} mnemonic for ${escapeXml(provider.label)}. Not an official logo.</desc>
  <style>
${style}
  </style>
${provider.body.trimEnd()}
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
${provider.body}
    </g>
    <g transform="translate(61 112) scale(0.9)" style="color: ${provider.accent}; --provider-accent: ${provider.accent};">
${provider.body}
    </g>
    <text class="label" x="72" y="168">${escapeXml(provider.label)}</text>
    <text class="accent-label" x="72" y="188">${provider.accent}</text>
    <text class="hint" x="72" y="207">64px + 16px preview</text>
  </g>`
    })
    .join('\n')

  return stripTrailingWhitespace(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>TaskWraith provider mnemonic glyph catalog</title>
  <desc>Original monoline provider mnemonics. These are deliberately simplified and are not official provider logos.</desc>
  <rect width="${width}" height="${height}" rx="18" fill="#111820" />
  <style>
${style}

    .label {
      fill: #F1F5F9;
      font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-anchor: middle;
      letter-spacing: 0;
    }

    .accent-label {
      fill: #AAB4C2;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
      text-anchor: middle;
      letter-spacing: 0;
    }

    .hint {
      fill: #7E8A9A;
      font: 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-anchor: middle;
      letter-spacing: 0;
    }
  </style>
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
      providers.map(({ body: _body, ...provider }) => provider),
      null,
      2
    )}\n`,
    'utf8'
  )
  fs.writeFileSync(catalogPath, buildCatalog(), 'utf8')
  console.log(`Generated ${providers.length} provider glyphs in ${glyphDir}`)
}

main()
