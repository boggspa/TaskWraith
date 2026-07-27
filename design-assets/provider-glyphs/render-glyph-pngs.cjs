/*
 * Bake TaskWraith's full-colour Ensemble glyph into transparent PNGs for
 * platforms that cannot consume the SVG directly. Its provider spectrum,
 * pooled blue hub, black contrast, and pearl sparkles are preserved exactly.
 *
 * Chromium does the rasterizing — the glyphs lean on `<style>` blocks and
 * `var(--provider-accent)`, which macOS-native rasterizers (qlmanage, NSImage)
 * either flatten onto a white card or skip entirely. Drawing into a <canvas>
 * and reading toDataURL keeps the alpha channel end-to-end.
 *
 *   npx electron design-assets/provider-glyphs/render-glyph-pngs.cjs
 *
 * Outputs:
 *   design-assets/provider-glyphs/png/provider-glyph-ensemble.png    (full colour)
 *   ios/TaskWraithKit/Sources/TaskWraithUI/Resources/provider-glyph-ensemble.png
 *   ios/TaskWraithApp/Assets.xcassets/provider-glyph-ensemble.imageset/
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

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
// 512px masters: home rows render at ~16-20pt, so this stays crisp at @3x
// even if a future surface shows the glyph at 10x the row size.
const SIZE = 512

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
  const source = readFileSync(join(GLYPH_DIR, 'ensemble.svg'), 'utf8')
  const png = await renderGlyph(win, source)
  writeFileSync(join(MASTER_DIR, 'provider-glyph-ensemble.png'), png)
  writeFileSync(join(IOS_RESOURCES, 'provider-glyph-ensemble.png'), png)
  writeFileSync(IOS_ENSEMBLE_ASSET, png)
  console.log(`rendered ensemble (${png.length} bytes, full colour)`)
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
