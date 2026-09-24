#!/usr/bin/env node

// Generates the branded macOS DMG installer background from the TaskWraith
// brand kit. Mirrors scripts/export-ghost-assets.cjs: author one SVG,
// rasterise with `sips` (full SVG fidelity on macOS — gradients, opacity,
// text and even embedded base64 <image> all render).
//
// Composition (back to front):
//   * neutral charcoal field + restrained provider-smoke atmosphere
//   * scattered tool-call glyphs (the 16 tool families) as faint "stars"
//   * a ring of 7 agent identicons (the subagent swarm), each its own accent
//   * the monoline ghost + SF Pro wordmark + provider-shimmer tagline still
//   * the install row: app icon → provider-gradient arrow → /Applications
//
// Two source families need two renderers, so the asset is assembled here:
//   - Tool glyphs use stroke="currentColor" → inlined as vector (sips renders).
//   - Identicons use a <style> block + CSS var(--agent-accent) for their accent
//     flourishes. sips honours the <style> classes + currentColor but ignores
//     var(), and qlmanage flattens onto opaque white — so we substitute
//     var(--agent-accent) with each file's literal data-agent-accent hex, then
//     render with sips (transparent, full detail) and embed as base64 data-URIs.
//
// This script is the editable source. Outputs (consumed by
// electron-builder.yml `dmg.background`):
//   build/background.png       960 x 720   (@1x; 660 x 420 artwork + bleed)
//   build/background@2x.png   1920 x 1440  (@2x — dmg-builder auto-combines)
//   build/swarm-field.png       960 x 720   transparent web/design overlay
//   build/swarm-field@2x.png   1920 x 1440  retina overlay
//
// The large dark canvas prevents Finder's white fallback from appearing when
// the user resizes the window. The initial 660 x 544 frame is deliberately
// smaller and is applied by scripts/patch-electron-builder-dmg-window.cjs.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const layout = require('./dmg-layout-contract.cjs')

const repoRoot = path.resolve(__dirname, '..')
const outDir = path.join(repoRoot, 'build')
const assetsDir = path.join(repoRoot, 'design-assets')

// LAYOUT — mirrored by electron-builder.yml dmg.{window,contents}.
const W = layout.background.width
const H = layout.background.height
const ART_W = layout.artwork.width
const ART_H = layout.artwork.height
const ICON_Y = layout.icons.y // vertical centre of both Finder icons

const ICY = '#9fc6de'
const PROVIDER = Object.freeze({
  gemini: '#346eec',
  codex: '#705aff',
  claude: '#b16105',
  kimi: '#0073e6',
  ensemble: '#986781',
  mistral: '#d44404',
  ollama: '#976c52'
})
const GRN = '#4cc38a'

// ---------------------------------------------------------------------------
// Tool-call glyphs — extracted from the 16-icon catalog and scattered small.
// ---------------------------------------------------------------------------
const toolCatalog = fs.readFileSync(
  path.join(assetsDir, 'tool-call-icons', 'tool-call-icons.catalog.svg'),
  'utf8'
)
const toolInner = (id) => {
  const re = new RegExp(
    `<g id="tool-icon-${id}"[^>]*>\\s*<svg[^>]*viewBox="0 0 24 24"[^>]*>([\\s\\S]*?)</svg>`,
    'm'
  )
  const m = toolCatalog.match(re)
  if (!m) throw new Error(`tool icon not found: ${id}`)
  return m[1].trim()
}

// Curated scatter — icon family + centre, display size, opacity, rotation, colour.
const TOOL_STARS = [
  { id: 'search', x: 128, y: 92, d: 22, o: 0.1, r: -10, c: ICY },
  { id: 'shell', x: 470, y: 58, d: 20, o: 0.09, r: 0, c: ICY },
  { id: 'git', x: 528, y: 116, d: 24, o: 0.1, r: 12, c: ICY },
  { id: 'reasoning', x: 92, y: 168, d: 22, o: 0.1, r: -6, c: PROVIDER.ollama },
  { id: 'mcp', x: 580, y: 170, d: 20, o: 0.08, r: 8, c: ICY },
  { id: 'delegate', x: 330, y: 214, d: 22, o: 0.08, r: 0, c: ICY },
  { id: 'subthread', x: 250, y: 286, d: 20, o: 0.08, r: 10, c: ICY },
  { id: 'plan', x: 412, y: 286, d: 20, o: 0.08, r: -8, c: ICY },
  { id: 'browser', x: 150, y: 322, d: 22, o: 0.08, r: 6, c: ICY },
  { id: 'task', x: 512, y: 322, d: 22, o: 0.08, r: -4, c: PROVIDER.ollama },
  { id: 'diagnostic', x: 300, y: 360, d: 20, o: 0.075, r: 6, c: ICY },
  { id: 'handoff', x: 392, y: 358, d: 20, o: 0.075, r: -6, c: ICY },
  { id: 'window-context', x: 626, y: 350, d: 20, o: 0.07, r: 0, c: ICY }
]

const toolStar = (s, opacityScale = 1) => {
  const scale = s.d / 24
  return `<g transform="translate(${s.x} ${s.y}) rotate(${s.r}) scale(${scale}) translate(-12 -12)" fill="none" stroke="${s.c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity="${(s.o * opacityScale).toFixed(3)}">${toolInner(
    s.id
  )}</g>`
}

// ---------------------------------------------------------------------------
// Agent identicons — the subagent swarm, a rainbow spread around the frame.
// Rendered through qlmanage (WebKit) so their CSS-var accent details survive.
// ---------------------------------------------------------------------------
const IDENTICONS = [
  { name: 'jakker', x: 70, y: 74, d: 98, o: 0.15, r: -8 }, // blue   · top-left
  { name: 'deimos', x: 594, y: 70, d: 92, o: 0.14, r: 7 }, // purple · top-right
  { name: 'uno', x: 40, y: 214, d: 80, o: 0.11, r: -5 }, // cyan   · left-mid
  { name: 'marsham', x: 626, y: 198, d: 80, o: 0.11, r: 6 }, // orange · right-mid
  { name: 'volkarr', x: 92, y: 362, d: 92, o: 0.12, r: 10 }, // pink   · left-low
  { name: 'harmonium', x: 574, y: 360, d: 86, o: 0.11, r: -9 }, // green  · right-low
  { name: 'dogsbody', x: 632, y: 300, d: 56, o: 0.08, r: -6 } // yellow · right gap
]

const tmpDir = path.join(os.tmpdir(), 'taskwraith-dmg-identicons')

const renderIdenticonB64 = (name) => {
  const src = path.join(assetsDir, 'agent-identicon', 'named', `${name}.svg`)
  let svg = fs.readFileSync(src, 'utf8')
  const accent = (svg.match(/data-agent-accent="(#[0-9A-Fa-f]+)"/) || [])[1] || 'currentColor'
  svg = svg.replace(/var\(--agent-accent[^)]*\)/g, accent)
  const tmpSvg = path.join(tmpDir, `${name}.svg`)
  const tmpPng = path.join(tmpDir, `${name}.png`)
  fs.writeFileSync(tmpSvg, svg)
  const res = spawnSync(
    'sips',
    ['-s', 'format', 'png', '-z', '256', '256', tmpSvg, '--out', tmpPng],
    { encoding: 'utf8' }
  )
  if (res.status !== 0 || !fs.existsSync(tmpPng)) {
    throw new Error(res.stderr || res.stdout || `sips failed for identicon ${name}`)
  }
  return fs.readFileSync(tmpPng).toString('base64')
}

const identiconImage = (it, opacityScale = 1) => {
  const b64 = renderIdenticonB64(it.name)
  const x = it.x - it.d / 2
  const y = it.y - it.d / 2
  return `<image x="${x}" y="${y}" width="${it.d}" height="${it.d}" opacity="${(it.o * opacityScale).toFixed(3)}" transform="rotate(${it.r} ${it.x} ${it.y})" xlink:href="data:image/png;base64,${b64}"/>`
}

// ---------------------------------------------------------------------------
const dotGrid = () => {
  const dots = []
  for (let y = 18; y < H; y += 24) {
    for (let x = 18; x < W; x += 24) {
      dots.push(`<circle cx="${x}" cy="${y}" r="1" fill="${ICY}" opacity="0.022"/>`)
    }
  }
  return dots.join('')
}

const displayFontStack = `'SF Pro Display','SF Pro Text','SF Pro','Helvetica Neue','Helvetica','Arial',sans-serif`
const textFontStack = `'SF Pro Text','SF Pro','Helvetica Neue','Helvetica','Arial',sans-serif`

const TAGLINE_SPARKLES = [
  { x: 183, y: 176, c: PROVIDER.codex, o: 0.74, s: 1.1 },
  { x: 226, y: 192, c: PROVIDER.kimi, o: 0.52, s: 0.8 },
  { x: 304, y: 169, c: PROVIDER.gemini, o: 0.58, s: 0.85 },
  { x: 364, y: 193, c: PROVIDER.ensemble, o: 0.5, s: 0.75 },
  { x: 431, y: 170, c: PROVIDER.mistral, o: 0.64, s: 0.95 },
  { x: 478, y: 188, c: PROVIDER.ollama, o: 0.58, s: 0.8 }
]

const taglineSparkle = (sparkle) => {
  const arm = 3.8 * sparkle.s
  return `<g opacity="${sparkle.o}">
    <circle cx="${sparkle.x}" cy="${sparkle.y}" r="${1.25 * sparkle.s}" fill="#ffffff"/>
    <path d="M${sparkle.x - arm} ${sparkle.y}H${sparkle.x + arm}M${sparkle.x} ${sparkle.y - arm}V${sparkle.y + arm}" fill="none" stroke="${sparkle.c}" stroke-width="0.8" stroke-linecap="round"/>
  </g>`
}

const swarmLayer = (opacityScale = 1) => `<g>${TOOL_STARS.map((star) =>
  toolStar(star, opacityScale)
).join('\n    ')}</g>
  <g>${IDENTICONS.map((identicon) => identiconImage(identicon, opacityScale)).join('\n    ')}</g>`

const buildSwarmSvg = () => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="TaskWraith agent and tool constellation">
  <g transform="translate(150 12)">${swarmLayer(0.55)}</g>
</svg>
`

const buildSvg = () => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="TaskWraith installer">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="${ART_H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#101116"/>
      <stop offset="0.55" stop-color="#090a0e"/>
      <stop offset="1" stop-color="#050608"/>
    </linearGradient>
    <radialGradient id="vig" cx="330" cy="150" r="440" gradientUnits="userSpaceOnUse">
      <stop offset="0.5" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>
    </radialGradient>
    <radialGradient id="hero-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#d5e8ff" stop-opacity="0.38"/>
      <stop offset="0.42" stop-color="${PROVIDER.codex}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${PROVIDER.kimi}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="arrow-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${PROVIDER.kimi}" stop-opacity="0.26"/>
      <stop offset="0.48" stop-color="${PROVIDER.codex}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${GRN}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="smoke-stream-a" x1="-40" y1="0" x2="700" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PROVIDER.codex}" stop-opacity="0"/>
      <stop offset="0.2" stop-color="${PROVIDER.codex}" stop-opacity="0.08"/>
      <stop offset="0.48" stop-color="${PROVIDER.kimi}" stop-opacity="0.055"/>
      <stop offset="0.76" stop-color="${PROVIDER.ensemble}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${PROVIDER.mistral}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="smoke-stream-b" x1="-40" y1="0" x2="700" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PROVIDER.mistral}" stop-opacity="0"/>
      <stop offset="0.24" stop-color="${PROVIDER.claude}" stop-opacity="0.055"/>
      <stop offset="0.54" stop-color="${PROVIDER.ensemble}" stop-opacity="0.042"/>
      <stop offset="0.78" stop-color="${PROVIDER.ollama}" stop-opacity="0.055"/>
      <stop offset="1" stop-color="${PROVIDER.ollama}" stop-opacity="0"/>
    </linearGradient>
    <filter id="smoke-soft" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="17"/>
    </filter>
    <linearGradient id="provider-shimmer" x1="170" y1="0" x2="490" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PROVIDER.gemini}"/>
      <stop offset="0.18" stop-color="${PROVIDER.codex}"/>
      <stop offset="0.36" stop-color="${PROVIDER.kimi}"/>
      <stop offset="0.5" stop-color="#ffffff"/>
      <stop offset="0.64" stop-color="${PROVIDER.ensemble}"/>
      <stop offset="0.82" stop-color="${PROVIDER.mistral}"/>
      <stop offset="1" stop-color="${PROVIDER.ollama}"/>
    </linearGradient>
    <linearGradient id="install-gradient" x1="272" y1="0" x2="384" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${PROVIDER.codex}"/>
      <stop offset="0.5" stop-color="${PROVIDER.kimi}"/>
      <stop offset="1" stop-color="${GRN}"/>
    </linearGradient>
  </defs>

  <!-- base -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <g fill="none" stroke-linecap="round" filter="url(#smoke-soft)">
    <path d="M-44 112 C 116 54, 286 160, 704 106" stroke="url(#smoke-stream-a)" stroke-width="42"/>
    <path d="M-48 286 C 144 340, 356 218, 708 288" stroke="url(#smoke-stream-b)" stroke-width="38"/>
  </g>
  ${dotGrid()}

  <!-- background swarm: tool-call glyphs (stars) + agent identicons -->
  ${swarmLayer()}

  <rect x="8" y="8" width="${ART_W - 16}" height="${ART_H - 16}" rx="14" fill="none" stroke="${ICY}" stroke-opacity="0.07" stroke-width="1"/>

  <!-- monoline ghost hero -->
  <ellipse cx="330" cy="64" rx="104" ry="92" fill="url(#hero-glow)"/>
  <g transform="translate(245,-17.75) scale(1.25)" fill="none" stroke="#dcefff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M56 30H80L92 36L98 48V84H92L86 90L80 84L74 96L68 84L56 96L50 84H38V48L44 36Z"/>
    <path d="M50 84V104"/>
    <path d="M68 84V104"/>
    <path d="M86 90V104"/>
    <rect x="51" y="54" width="10" height="14"/>
    <rect x="75" y="54" width="10" height="14"/>
  </g>

  <!-- SF Pro wordmark + a still frame of the site's slow provider shimmer. -->
  <text x="330" y="156" text-anchor="middle" font-family="${displayFontStack}" font-size="34" font-weight="600" letter-spacing="-0.6" fill="#eef2f7">TaskWraith</text>
  <g font-family="${displayFontStack}" font-size="15.5" font-weight="600" letter-spacing="0.15" fill="url(#provider-shimmer)">
    <text x="202" y="184">Orchestrate.</text>
    <text x="300" y="184">Collaborate.</text>
    <text x="405" y="184">Deliver.</text>
  </g>
  <g>${TAGLINE_SPARKLES.map(taglineSparkle).join('\n    ')}</g>

  <!-- Provider-gradient install arrow. There are intentionally no icon-sized background
       pedestals: Finder can independently resize and reflow its item layer. -->
  <ellipse cx="330" cy="${ICON_Y - 6}" rx="92" ry="24" fill="url(#arrow-glow)"/>
  <rect x="272" y="${ICON_Y - 10}" width="7" height="8" rx="1.5" fill="${PROVIDER.codex}" opacity="0.38"/>
  <rect x="284" y="${ICON_Y - 10}" width="7" height="8" rx="1.5" fill="${PROVIDER.kimi}" opacity="0.62"/>
  <rect x="296" y="${ICON_Y - 10}" width="60" height="8" rx="4" fill="url(#install-gradient)"/>
  <polygon points="354,${ICON_Y - 18} 384,${ICON_Y - 6} 354,${ICON_Y + 6}" fill="${GRN}"/>

  <!-- footer instruction -->
  <text x="330" y="401" text-anchor="middle" font-family="${textFontStack}" font-size="12" letter-spacing="0.15" fill="#aab1bd" opacity="0.74">Drag TaskWraith into your Applications folder</text>
</svg>
`

const renderPng = (svgPath, pngPath, w, h) => {
  const result = spawnSync(
    'sips',
    ['-s', 'format', 'png', '-z', String(h), String(w), svgPath, '--out', pngPath],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sips failed for ${pngPath}`)
  }
}

const main = () => {
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  // The assembled SVG embeds base64 identicon rasters, so it's a render
  // intermediate (not hand-editable) — keep it out of build/.
  const svgPath = path.join(tmpDir, 'background.svg')
  const swarmSvgPath = path.join(tmpDir, 'swarm-field.svg')
  fs.writeFileSync(svgPath, buildSvg())
  fs.writeFileSync(swarmSvgPath, buildSwarmSvg())
  renderPng(svgPath, path.join(outDir, 'background.png'), W, H)
  renderPng(svgPath, path.join(outDir, 'background@2x.png'), W * 2, H * 2)
  renderPng(swarmSvgPath, path.join(outDir, 'swarm-field.png'), W, H)
  renderPng(swarmSvgPath, path.join(outDir, 'swarm-field@2x.png'), W * 2, H * 2)
  console.log(`Wrote DMG backgrounds and transparent swarm fields at ${W}x${H} / ${W * 2}x${H * 2}`)
}

main()
