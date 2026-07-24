/*
 * Bake provider glyphs into transparent PNGs for platforms that cannot consume
 * the SVGs directly. Ordinary providers remain white template masks that iOS
 * tints at runtime. Ensemble is the deliberate full-colour exception: its
 * provider spectrum, pooled blue hub, black contrast, and pearl sparkles are
 * preserved exactly and iOS renders that PNG as original artwork.
 *
 * Chromium does the rasterizing — the glyphs lean on `<style>` blocks and
 * `var(--provider-accent)`, which macOS-native rasterizers (qlmanage, NSImage)
 * either flatten onto a white card or skip entirely. Drawing into a <canvas>
 * and reading toDataURL keeps the alpha channel end-to-end.
 *
 *   npx electron design-assets/provider-glyphs/render-glyph-pngs.cjs
 *
 * Outputs:
 *   design-assets/provider-glyphs/png/provider-glyph-<id>-white.png  (templates)
 *   design-assets/provider-glyphs/png/provider-glyph-ensemble.png    (full colour)
 *   ios/TaskWraithKit/Sources/TaskWraithUI/Resources/provider-glyph-<id>.png
 *   ios/TaskWraithApp/Assets.xcassets/provider-glyph-ensemble.imageset/
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } = require('fs')
const { join, basename } = require('path')

const GLYPH_DIR = join(__dirname, 'glyphs')
const MASTER_DIR = join(__dirname, 'png')
const IOS_RESOURCES = join(
  __dirname,
  '..',
  '..',
  'ios',
  'TaskWraithKit',
  'Sources',
  'TaskWraithUI',
  'Resources'
)
const IOS_ENSEMBLE_ASSET = join(
  __dirname,
  '..',
  '..',
  'ios',
  'TaskWraithApp',
  'Assets.xcassets',
  'provider-glyph-ensemble.imageset',
  'provider-glyph-ensemble.png'
)
const FULL_COLOUR_GLYPHS = new Set(['ensemble'])
const requestedProviders = new Set(
  process.argv
    .filter((arg) => arg.startsWith('--provider='))
    .flatMap((arg) => arg.slice('--provider='.length).split(','))
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
)
// 512px masters: home rows render at ~16-20pt, so this stays crisp at @3x
// even if a future surface shows the glyph at 10x the row size.
const SIZE = 512

/**
 * Remove the black contrast pass and force the foreground accent to white so
 * the PNG remains a pure template mask. iOS paints the black silhouette
 * separately at runtime.
 */
const whitened = (svg) =>
  svg
    .replace(
      /\s*<g\b[^>]*data-provider-glyph-contrast="true"[^>]*>[\s\S]*?<\/g>/,
      ''
    )
    .replace(
      /style="color: #[0-9A-Fa-f]+; --provider-accent: #[0-9A-Fa-f]+;"/,
      'style="color: #FFFFFF; --provider-accent: #FFFFFF;"'
    )

async function renderGlyph(win, svgText) {
  const svgB64 = Buffer.from(svgText, 'utf8').toString('base64')
  const pngB64 = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = ${SIZE}
          canvas.height = ${SIZE}
          const ctx = canvas.getContext('2d')
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/png').split(',')[1])
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      img.onerror = () => reject(new Error('SVG failed to decode'))
      img.src = 'data:image/svg+xml;base64,${svgB64}'
    })
  `)
  return Buffer.from(pngB64, 'base64')
}

async function main() {
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    webPreferences: { offscreen: true, sandbox: false }
  })
  await win.loadURL('data:text/html,<body></body>')

  mkdirSync(MASTER_DIR, { recursive: true })
  const glyphs = readdirSync(GLYPH_DIR).filter((file) => {
    if (!file.endsWith('.svg')) return false
    return requestedProviders.size === 0 || requestedProviders.has(basename(file, '.svg'))
  })
  if (glyphs.length === 0) {
    throw new Error(
      `No provider glyphs matched: ${Array.from(requestedProviders).join(', ') || '(all)'}`
    )
  }
  for (const file of glyphs.sort()) {
    const id = basename(file, '.svg')
    const source = readFileSync(join(GLYPH_DIR, file), 'utf8')
    const isFullColour = FULL_COLOUR_GLYPHS.has(id)
    const svg = isFullColour ? source : whitened(source)
    const png = await renderGlyph(win, svg)
    const masterName = isFullColour ? `provider-glyph-${id}.png` : `provider-glyph-${id}-white.png`
    writeFileSync(join(MASTER_DIR, masterName), png)
    writeFileSync(join(IOS_RESOURCES, `provider-glyph-${id}.png`), png)
    if (id === 'ensemble') {
      rmSync(join(MASTER_DIR, 'provider-glyph-ensemble-white.png'), { force: true })
      writeFileSync(IOS_ENSEMBLE_ASSET, png)
    }
    console.log(
      `rendered ${id} (${png.length} bytes, ${isFullColour ? 'full colour' : 'template'})`
    )
  }
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
