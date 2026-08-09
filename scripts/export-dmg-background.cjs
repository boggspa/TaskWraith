#!/usr/bin/env node

// Generates the branded macOS DMG installer background from the TaskWraith
// brand kit. Mirrors scripts/export-ghost-assets.cjs: author one SVG,
// rasterise with `sips` (full SVG fidelity on macOS — gradients, opacity,
// text and even embedded base64 <image> all render).
//
// Composition (back to front):
//   * deep navy→black gradient + vignette + faint pixel dot-grid
//   * scattered tool-call glyphs (the 16 tool families) as faint "stars"
//   * a ring of 7 agent identicons (the subagent swarm), each its own accent
//   * the monoline ghost mark hero + "TaskWraith" wordmark + green tagline
//   * the install row: app icon → green arrow → /Applications
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
const APP_X = layout.icons.appX // centre of the app icon (left)
const APPS_X = layout.icons.applicationsX // centre of the /Applications drop (right)

const ICY = '#9fc6de'
const GRN = '#00ff88'

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
  { id: 'search', x: 128, y: 92, d: 22, o: 0.2, r: -10, c: ICY },
  { id: 'shell', x: 470, y: 58, d: 20, o: 0.18, r: 0, c: ICY },
  { id: 'git', x: 528, y: 116, d: 24, o: 0.2, r: 12, c: ICY },
  { id: 'reasoning', x: 92, y: 168, d: 22, o: 0.18, r: -6, c: GRN },
  { id: 'mcp', x: 580, y: 170, d: 20, o: 0.16, r: 8, c: ICY },
  { id: 'delegate', x: 330, y: 214, d: 22, o: 0.16, r: 0, c: ICY },
  { id: 'subthread', x: 250, y: 286, d: 20, o: 0.16, r: 10, c: ICY },
  { id: 'plan', x: 412, y: 286, d: 20, o: 0.16, r: -8, c: ICY },
  { id: 'browser', x: 150, y: 322, d: 22, o: 0.16, r: 6, c: ICY },
  { id: 'task', x: 512, y: 322, d: 22, o: 0.16, r: -4, c: GRN },
  { id: 'diagnostic', x: 300, y: 360, d: 20, o: 0.15, r: 6, c: ICY },
  { id: 'handoff', x: 392, y: 358, d: 20, o: 0.15, r: -6, c: ICY },
  { id: 'window-context', x: 626, y: 350, d: 20, o: 0.14, r: 0, c: ICY }
]

const toolStar = (s) => {
  const scale = s.d / 24
  return `<g transform="translate(${s.x} ${s.y}) rotate(${s.r}) scale(${scale}) translate(-12 -12)" fill="none" stroke="${s.c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity="${s.o}">${toolInner(
    s.id
  )}</g>`
}

// ---------------------------------------------------------------------------
// Agent identicons — the subagent swarm, a rainbow spread around the frame.
// Rendered through qlmanage (WebKit) so their CSS-var accent details survive.
// ---------------------------------------------------------------------------
const IDENTICONS = [
  { name: 'jakker', x: 70, y: 74, d: 98, o: 0.26, r: -8 }, // blue   · top-left
  { name: 'deimos', x: 594, y: 70, d: 92, o: 0.24, r: 7 }, // purple · top-right
  { name: 'uno', x: 40, y: 214, d: 80, o: 0.18, r: -5 }, // cyan   · left-mid
  { name: 'marsham', x: 626, y: 198, d: 80, o: 0.18, r: 6 }, // orange · right-mid
  { name: 'volkarr', x: 92, y: 362, d: 92, o: 0.2, r: 10 }, // pink   · left-low
  { name: 'harmonium', x: 574, y: 360, d: 86, o: 0.18, r: -9 }, // green  · right-low
  { name: 'dogsbody', x: 632, y: 300, d: 56, o: 0.13, r: -6 } // yellow · right gap
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

const identiconImage = (it) => {
  const b64 = renderIdenticonB64(it.name)
  const x = it.x - it.d / 2
  const y = it.y - it.d / 2
  return `<image x="${x}" y="${y}" width="${it.d}" height="${it.d}" opacity="${it.o}" transform="rotate(${it.r} ${it.x} ${it.y})" xlink:href="data:image/png;base64,${b64}"/>`
}

// ---------------------------------------------------------------------------
const dotGrid = () => {
  const dots = []
  for (let y = 18; y < H; y += 24) {
    for (let x = 18; x < W; x += 24) {
      dots.push(`<circle cx="${x}" cy="${y}" r="1" fill="${ICY}" opacity="0.035"/>`)
    }
  }
  return dots.join('')
}

const fontStack = `'Helvetica Neue','Helvetica','Arial',sans-serif`

const buildSvg = () => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="TaskWraith installer">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="${ART_H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0c111d"/>
      <stop offset="0.55" stop-color="#080b13"/>
      <stop offset="1" stop-color="#05070b"/>
    </linearGradient>
    <radialGradient id="vig" cx="330" cy="150" r="440" gradientUnits="userSpaceOnUse">
      <stop offset="0.5" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>
    </radialGradient>
    <radialGradient id="hero-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#a8dcff" stop-opacity="0.4"/>
      <stop offset="0.45" stop-color="#638aff" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#638aff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="arrow-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${GRN}" stop-opacity="0.32"/>
      <stop offset="1" stop-color="${GRN}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- base -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  ${dotGrid()}

  <!-- background swarm: tool-call glyphs (stars) + agent identicons -->
  <g>${TOOL_STARS.map(toolStar).join('\n    ')}</g>
  <g>${IDENTICONS.map(identiconImage).join('\n    ')}</g>

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

  <!-- wordmark + tagline -->
  <text x="330" y="158" text-anchor="middle" font-family="${fontStack}" font-size="40" font-weight="700" letter-spacing="0.5" fill="#eef6ff">TaskWraith</text>
  <text x="330" y="186" text-anchor="middle" font-family="${fontStack}" font-size="12.5" font-weight="600" letter-spacing="5" fill="${GRN}">OWN YOUR AGENT</text>

  <!-- Green install arrow. There are intentionally no icon-sized background
       pedestals: Finder can independently resize and reflow its item layer. -->
  <ellipse cx="330" cy="${ICON_Y - 6}" rx="92" ry="24" fill="url(#arrow-glow)"/>
  <rect x="272" y="${ICON_Y - 10}" width="7" height="8" rx="1.5" fill="${GRN}" opacity="0.35"/>
  <rect x="284" y="${ICON_Y - 10}" width="7" height="8" rx="1.5" fill="${GRN}" opacity="0.6"/>
  <rect x="296" y="${ICON_Y - 10}" width="60" height="8" rx="4" fill="${GRN}"/>
  <polygon points="354,${ICON_Y - 18} 384,${ICON_Y - 6} 354,${ICON_Y + 6}" fill="${GRN}"/>

  <!-- footer instruction -->
  <text x="330" y="401" text-anchor="middle" font-family="${fontStack}" font-size="12" letter-spacing="0.4" fill="#9fb2c9" opacity="0.72">Drag TaskWraith into your Applications folder</text>
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
  fs.writeFileSync(svgPath, buildSvg())
  renderPng(svgPath, path.join(outDir, 'background.png'), W, H)
  renderPng(svgPath, path.join(outDir, 'background@2x.png'), W * 2, H * 2)
  console.log(`Wrote build/background.png (${W}x${H}), build/background@2x.png (${W * 2}x${H * 2})`)
}

main()
