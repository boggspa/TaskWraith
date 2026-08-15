import type { BrowserWindow, Event, RenderProcessGoneDetails, WebContents } from 'electron'

const RECOVERY_DATA_URL_PREFIX = 'data:text/html;charset=utf-8,'
const RECOVERY_ACTION_PROTOCOL = 'taskwraith-recovery:'
const RELOAD_ACTION_URL = `${RECOVERY_ACTION_PROTOCOL}//reload`
const CLOSE_ACTION_URL = `${RECOVERY_ACTION_PROTOCOL}//close`

export interface RendererCrashRecoveryDetails {
  reason: RenderProcessGoneDetails['reason']
  exitCode: number
  activeRunCount: number
}

export interface RendererCrashRecoveryOptions {
  onLoadError?: (error: unknown) => void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function normalizedRunCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function activeRunCopy(activeRunCount: number): string {
  if (activeRunCount === 1) {
    return 'Your active run is still continuing in the background.'
  }
  if (activeRunCount > 1) {
    return `Your ${activeRunCount} active runs are still continuing in the background.`
  }
  return 'TaskWraith\u2019s background runtime remains available. No run was stopped by this renderer failure.'
}

function isApplicationUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'file:' || protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

type RendererCrashRecoveryAction = 'reload' | 'close'

function recoveryActionFromUrl(url: string): RendererCrashRecoveryAction | null {
  try {
    const target = new URL(url)
    if (
      target.protocol !== RECOVERY_ACTION_PROTOCOL ||
      target.username ||
      target.password ||
      target.port ||
      (target.pathname !== '' && target.pathname !== '/') ||
      target.search ||
      target.hash
    ) {
      return null
    }
    if (target.hostname === 'reload' || target.hostname === 'close') return target.hostname
  } catch {
    // Ignore malformed and unrelated navigation targets.
  }
  return null
}

export function buildRendererCrashRecoveryHtml(details: RendererCrashRecoveryDetails): string {
  const activeRunCount = normalizedRunCount(details.activeRunCount)
  const reason = escapeHtml(details.reason || 'unknown')
  const exitCode = Number.isFinite(details.exitCode) ? Math.trunc(details.exitCode) : 0
  const runCopy = escapeHtml(activeRunCopy(activeRunCount))

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TaskWraith renderer recovery</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f4f1f8; background: #25242a; }
      main { width: min(580px, calc(100vw - 48px)); padding: 36px; border: 1px solid #57535f; border-radius: 18px; background: #302e36; box-shadow: 0 24px 70px rgba(0, 0, 0, .35); }
      .eyebrow { margin: 0 0 12px; color: #b8a8ce; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.16; }
      p { margin: 0 0 16px; color: #d2ced8; font-size: 15px; line-height: 1.55; }
      .continuity { padding: 14px 16px; border: 1px solid #625772; border-radius: 12px; color: #ece4f7; background: #3a3344; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
      a { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; padding: 0 16px; border-radius: 9px; color: #f8f5fb; font-size: 14px; font-weight: 650; text-decoration: none; }
      .primary { background: #7759a4; }
      .secondary { border: 1px solid #625e69; background: #39373e; }
      .detail { margin-top: 20px; color: #938e99; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Renderer recovery</p>
      <h1>The TaskWraith interface stopped unexpectedly</h1>
      <p>The desktop runtime is still running. Reloading rebuilds this window and does not cancel provider work.</p>
      <p class="continuity">${runCopy}</p>
      <div class="actions">
        <a class="primary" href="${RELOAD_ACTION_URL}">Reload TaskWraith</a>
        <a class="secondary" href="${CLOSE_ACTION_URL}">Close window</a>
      </div>
      <p class="detail">Renderer exit: ${reason} (${exitCode}). A local diagnostic entry was recorded.</p>
    </main>
  </body>
</html>`
}

export function buildRendererCrashRecoveryUrl(details: RendererCrashRecoveryDetails): string {
  return `${RECOVERY_DATA_URL_PREFIX}${encodeURIComponent(buildRendererCrashRecoveryHtml(details))}`
}

/**
 * Owns the renderer-independent fallback for one BrowserWindow. The recovery
 * document is loaded by main after Chromium reports the old renderer gone, so
 * it does not depend on React, the preload, or any state held by that process.
 */
export class RendererCrashRecovery {
  private applicationUrl = ''
  private showingRecovery = false
  private disposed = false
  private readonly webContents: WebContents

  private readonly handleDidNavigate = (_event: Event, url: string): void => {
    if (isApplicationUrl(url)) {
      this.applicationUrl = url
      this.showingRecovery = false
    }
  }

  private readonly handleWillNavigate = (event: Event, url: string): void => {
    if (!this.showingRecovery || this.disposed) return
    const action = recoveryActionFromUrl(url)
    if (!action) return

    // Chromium refuses fragment navigation on a data: document, so hash links
    // never reach did-navigate-in-page. A dedicated, non-fetchable scheme gives
    // the buttons a real navigation attempt that main can intercept here.
    event.preventDefault()
    if (action === 'close') {
      this.showingRecovery = false
      if (!this.window.isDestroyed()) this.window.close()
      return
    }

    if (!isApplicationUrl(this.applicationUrl)) return
    this.showingRecovery = false
    void this.window.loadURL(this.applicationUrl).catch((error) => {
      this.showingRecovery = true
      this.options.onLoadError?.(error)
    })
  }

  constructor(
    private readonly window: BrowserWindow,
    private readonly options: RendererCrashRecoveryOptions = {}
  ) {
    this.webContents = window.webContents
    this.rememberCurrentApplicationUrl()
    this.webContents.on('did-navigate', this.handleDidNavigate)
    this.webContents.on('will-navigate', this.handleWillNavigate)
  }

  show(details: RendererCrashRecoveryDetails): boolean {
    if (this.disposed || this.window.isDestroyed() || this.webContents.isDestroyed()) {
      return false
    }
    this.rememberCurrentApplicationUrl()
    if (!isApplicationUrl(this.applicationUrl)) return false

    this.showingRecovery = true
    void this.window.loadURL(buildRendererCrashRecoveryUrl(details)).catch((error) => {
      this.showingRecovery = false
      this.options.onLoadError?.(error)
    })
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.showingRecovery = false
    if (this.webContents.isDestroyed()) return
    this.webContents.removeListener('did-navigate', this.handleDidNavigate)
    this.webContents.removeListener('will-navigate', this.handleWillNavigate)
  }

  private rememberCurrentApplicationUrl(): void {
    if (this.webContents.isDestroyed()) return
    const url = this.webContents.getURL()
    if (isApplicationUrl(url)) this.applicationUrl = url
  }
}
