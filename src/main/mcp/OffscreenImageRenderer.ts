import { BrowserWindow, nativeImage, type WebContents } from 'electron'
import type { ImageEngine } from './ImageToolExecutors'

/**
 * Electron-backed image engine for the image_edit / svg_rasterize MCP tools.
 *
 * Two execution paths:
 *  - crop / resize / getSize: pure `nativeImage` (no renderer needed).
 *  - blur / redact / SVG rasterize: an OFFSCREEN, network-cut, sandboxed
 *    BrowserWindow that renders self-contained HTML and is captured to PNG.
 *
 * Security posture for the offscreen render (mirrors CanvasWebDriver, tightened
 * for one-shot use):
 *  - sandbox + contextIsolation, no node integration, no insecure content;
 *  - hidden window on a fresh EPHEMERAL in-memory partition (no persisted state);
 *  - ALL network requests are cancelled (onBeforeRequest -> cancel) so a hostile
 *    SVG (<image href>, <use href>, external CSS, XML external entities) cannot
 *    phone home, read local files, or reach cloud-metadata — this is the
 *    XXE/SSRF containment;
 *  - permissions denied, downloads blocked, window.open denied;
 *  - content is always a `data:` URL (never file:// or remote);
 *  - the SVG is rasterized inside an <img> (img-context SVG cannot run scripts),
 *    never inlined into the DOM.
 */

const DEFAULT_RENDER_TIMEOUT_MS = 15_000
/** Hard ceiling on any rendered/processed dimension — guards against a
 * decompression/canvas memory bomb (e.g. an SVG declaring width=999999). */
export const MAX_IMAGE_DIMENSION = 8192
let renderSeq = 0

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function loadAndSettle(wc: WebContents, dataUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    wc.once('did-finish-load', () => {
      // One extra frame so the CSS blur / SVG paint commits before capture.
      setTimeout(resolve, 48)
    })
    wc.once('did-fail-load', (_event, code, desc) => {
      reject(new Error(`offscreen render failed (${code}): ${desc || 'load error'}`))
    })
    wc.loadURL(dataUrl).catch(reject)
  })
}

async function renderHtmlToPng(
  html: string,
  width: number,
  height: number,
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS
): Promise<Buffer> {
  const w = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.floor(width)))
  const h = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.floor(height)))
  renderSeq += 1
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      // Fresh, NON-persisted partition per render — fully isolated session.
      partition: `taskwraith-image-render-${renderSeq}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })
  const wc = win.webContents
  try {
    // Cut ALL egress for this render: nothing the page references may load.
    wc.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    try {
      wc.session.setPermissionCheckHandler(() => false)
    } catch {
      // Best effort — older Electron.
    }
    wc.session.on('will-download', (event) => event.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.setContentSize(w, h)
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`
    await withTimeout(loadAndSettle(wc, dataUrl), timeoutMs, 'offscreen render timed out')
    const image = await wc.capturePage()
    return image.toPNG()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Build the real, Electron-backed ImageEngine. */
export function createNativeImageEngine(): ImageEngine {
  return {
    getSize(buffer: Buffer) {
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) throw new Error('input is not a decodable raster image')
      return image.getSize()
    },
    crop(buffer: Buffer, rect) {
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) throw new Error('input is not a decodable raster image')
      return image.crop(rect).toPNG()
    },
    resize(buffer: Buffer, size) {
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) throw new Error('input is not a decodable raster image')
      return image.resize({ width: size.width, height: size.height, quality: 'best' }).toPNG()
    },
    renderHtmlToPng
  }
}
