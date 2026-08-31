/**
 * CanvasHostSurface — abstracts WHERE a live Canvas page is hosted.
 *
 * Embedded canvases expose a bare WebContentsView because the app renderer owns
 * their chrome. Floating canvases use a small trusted BrowserWindow shell with
 * the actual page in a child WebContentsView. Keeping the page in the child
 * means browser controls are always available without injecting anything into
 * an arbitrary website (and without letting that website cover the controls).
 */
import { BrowserWindow, WebContentsView, type WebContents } from 'electron'

export type CanvasSurfaceKind = 'web' | 'sketch' | 'emulator'

export interface CanvasSurfaceNavigationInput {
  url?: string
  action?: 'back' | 'forward' | 'reload' | 'stop'
}

export interface CanvasSurfaceNavigationState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface CanvasSurfaceOptions {
  partition: string
  width: number
  height: number
  kind?: CanvasSurfaceKind
}

export interface CanvasHostSurface {
  readonly webContents: WebContents
  getTitle(): string
  /** Resize the page viewport (the floating shell adds its chrome height). */
  setContentSize(width: number, height: number): void
  isDestroyed(): boolean
  destroy(): void
  /** Fires if the surface goes away on its own (window closed). No-op for views. */
  onClosed(callback: () => void): void
  /** Optional floating-window browser rail. Embedded chrome lives in React. */
  onNavigateRequest?(
    callback: (input: CanvasSurfaceNavigationInput) => Promise<CanvasSurfaceNavigationState>
  ): void
  setNavigationState?(state: CanvasSurfaceNavigationState): void
  /** Optional floating-window control for moving the same Canvas into the dock. */
  onDockRequest?(callback: () => void | Promise<void>): void
  /** Optional floating tab-strip control for opening another Browser tab. */
  onNewTabRequest?(callback: () => void | Promise<void>): void
}

const FLOATING_TAB_HEIGHT = 36
const FLOATING_TOOLBAR_HEIGHT = 44
const FLOATING_CHROME_HEIGHT = FLOATING_TAB_HEIGHT + FLOATING_TOOLBAR_HEIGHT
const FLOATING_COMMAND_PROTOCOL = 'taskwraith-canvas:'

export function normalizeFloatingAddress(raw: string): string | null {
  const input = raw.trim()
  if (!input || /\s/.test(input)) return null
  const scheme = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s)
  const hasRealScheme = Boolean(scheme) && !/^\d+([/?#].*)?$/.test(scheme?.[2] ?? '')
  let candidate = input
  if (hasRealScheme) {
    if (!/^https?:\/\//i.test(input)) return null
  } else {
    const authority = input.split(/[/?#]/, 1)[0] ?? ''
    const host = (
      authority.startsWith('[')
        ? authority.slice(1, authority.indexOf(']') > 0 ? authority.indexOf(']') : undefined)
        : (authority.split(':', 1)[0] ?? '')
    ).toLowerCase()
    const ipv4 = host.split('.').map(Number)
    const privateIpv4 =
      ipv4.length === 4 &&
      ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (ipv4[0] === 10 ||
        (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
        (ipv4[0] === 192 && ipv4[1] === 168) ||
        (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127))
    const local =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      /^127(\.\d{1,3}){3}$/.test(host) ||
      /^f[cd][0-9a-f]{2}:/i.test(host) ||
      privateIpv4
    candidate = `${local ? 'http' : 'https'}://${input}`
  }
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function floatingChromeHtml(kind: CanvasSurfaceKind): string {
  const surfaceTitle = kind === 'sketch' ? 'Sketch Canvas' : 'Emulator Canvas'
  const browserControls =
    kind === 'web'
      ? `<button id="back" name="action" value="back" aria-label="Back" title="Back" disabled>‹</button>
         <button id="forward" name="action" value="forward" aria-label="Forward" title="Forward" disabled>›</button>
         <button id="reload" name="action" value="reload" aria-label="Reload" title="Reload">↻</button>
         <div class="address-wrap">
           <span id="security" aria-hidden="true">◎</span>
           <input id="address" name="url" type="text" autocomplete="off" spellcheck="false"
             aria-label="Address" placeholder="Enter a web address" />
           <span id="progress" aria-hidden="true"></span>
         </div>`
      : `<div class="surface-title">${surfaceTitle}</div>`
  const initialTitle = kind === 'web' ? 'New tab' : surfaceTitle
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${FLOATING_COMMAND_PROTOCOL}">
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; height: ${FLOATING_CHROME_HEIGHT}px; overflow: hidden; background: #171719; color: #ececef; }
  form { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 9px; border-bottom: 1px solid rgba(255,255,255,.12); }
  .tabs { height: ${FLOATING_TAB_HEIGHT}px; background: rgba(255,255,255,.025); }
  .toolbar { position: relative; height: ${FLOATING_TOOLBAR_HEIGHT}px; }
  button { height: 30px; min-width: 30px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: 17px/1 system-ui, sans-serif; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.09); }
  button:disabled { opacity: .28; cursor: default; }
  .address-wrap { position: relative; min-width: 0; flex: 1; height: 32px; display: flex; align-items: center; border: 1px solid rgba(255,255,255,.13); border-radius: 8px; background: rgba(255,255,255,.065); }
  .address-wrap:focus-within { border-color: rgba(118,153,255,.76); box-shadow: 0 0 0 2px rgba(80,120,255,.16); }
  #security { flex: 0 0 auto; margin-left: 9px; color: #a8abb3; font-size: 12px; }
  #security.secure { color: #72c98f; }
  #address { min-width: 0; flex: 1; height: 100%; padding: 0 9px 0 7px; border: 0; outline: 0; background: transparent; color: inherit; font: 12px/1.2 system-ui, sans-serif; }
  #address::placeholder { color: rgba(235,235,240,.42); }
  #progress { position: absolute; left: 0; right: 100%; bottom: -1px; height: 2px; border-radius: 2px; background: #6e91ff; opacity: 0; }
  #progress.loading { opacity: 1; animation: load 1.35s ease-in-out infinite; }
  .tab { display: flex; align-items: center; min-width: 92px; max-width: 220px; height: 27px; padding: 0 10px; border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.075); font: 550 11px/1 system-ui, sans-serif; }
  #tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .surface-title { min-width: 0; flex: 1; padding-left: 5px; font: 600 12px/1 system-ui, sans-serif; }
  .spacer { flex: 1; }
  .dock { min-width: 56px; padding: 0 10px; border: 1px solid rgba(255,255,255,.14); font-size: 11px; }
  #status { position: absolute; left: 12px; right: 76px; bottom: 1px; overflow: hidden; color: #ff8e8e; font-size: 9px; white-space: nowrap; text-overflow: ellipsis; pointer-events: none; }
  @keyframes load { 0% { left: 0; right: 80%; } 50% { left: 35%; right: 20%; } 100% { left: 85%; right: 0; } }
  @media (prefers-color-scheme: light) {
    body { background: #f3f3f5; color: #202126; }
    form { border-bottom-color: rgba(0,0,0,.14); }
    .tabs { background: rgba(0,0,0,.025); }
    .tab { border-color: rgba(0,0,0,.13); background: rgba(255,255,255,.78); }
    button:hover { background: rgba(0,0,0,.07); }
    .address-wrap { border-color: rgba(0,0,0,.13); background: rgba(255,255,255,.75); }
    #address::placeholder { color: rgba(32,33,38,.42); }
    .dock { border-color: rgba(0,0,0,.15); }
  }
</style>
</head>
<body>
  <form class="tabs" method="get" action="${FLOATING_COMMAND_PROTOCOL}//command">
    <button class="tab" type="button" aria-current="page"><span id="tab-title">${initialTitle}</span></button>
    <span class="spacer"></span>
    <button class="dock" name="action" value="dock" aria-label="Show canvas in dock" title="Show canvas in dock">Dock</button>
  </form>
  <form class="toolbar" method="get" action="${FLOATING_COMMAND_PROTOCOL}//command">
    <button type="submit" name="action" value="navigate" hidden aria-hidden="true"></button>
    ${browserControls}
    <span id="status" role="status" aria-live="polite"></span>
  </form>
</body>
</html>`
}

/** Standalone Canvas window with trusted chrome and a sandboxed child page. */
export function createBrowserWindowSurface(opts: CanvasSurfaceOptions): CanvasHostSurface {
  const kind = opts.kind ?? 'web'
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height + FLOATING_CHROME_HEIGHT,
    minWidth: 420,
    minHeight: 260,
    title:
      kind === 'web'
        ? 'TaskWraith Browser'
        : kind === 'sketch'
          ? 'TaskWraith Sketch Canvas'
          : 'TaskWraith Emulator Canvas',
    backgroundColor: '#111111',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const page = new WebContentsView({
    webPreferences: {
      partition: opts.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })
  page.setBackgroundColor('#111111')
  win.contentView.addChildView(page)

  let navigateRequest:
    | ((input: CanvasSurfaceNavigationInput) => Promise<CanvasSurfaceNavigationState>)
    | null = null
  let dockRequest: (() => void | Promise<void>) | null = null
  let newTabRequest: (() => void | Promise<void>) | null = null
  let latestState: CanvasSurfaceNavigationState = {
    url: '',
    title: '',
    isLoading: false,
    canGoBack: false,
    canGoForward: false
  }

  const layout = (): void => {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    page.setBounds({
      x: 0,
      y: FLOATING_CHROME_HEIGHT,
      width: Math.max(0, width),
      height: Math.max(0, height - FLOATING_CHROME_HEIGHT)
    })
  }

  const evaluateInChrome = (source: string): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    void win.webContents.executeJavaScript(source, true).catch(() => undefined)
  }

  const renderState = (): void => {
    if (kind !== 'web') return
    const state = latestState
    evaluateInChrome(`(() => {
      const state = ${JSON.stringify(state)};
      const address = document.getElementById('address');
      const back = document.getElementById('back');
      const forward = document.getElementById('forward');
      const reload = document.getElementById('reload');
      const progress = document.getElementById('progress');
      const security = document.getElementById('security');
      const status = document.getElementById('status');
      const tabTitle = document.getElementById('tab-title');
      if (address && document.activeElement !== address) {
        address.value = state.url === 'about:blank' ? '' : state.url;
        address.title = state.url === 'about:blank' ? '' : state.url;
      }
      if (back) back.disabled = !state.canGoBack;
      if (forward) forward.disabled = !state.canGoForward;
      if (reload) { reload.value = state.isLoading ? 'stop' : 'reload'; reload.textContent = state.isLoading ? '×' : '↻'; reload.title = state.isLoading ? 'Stop loading' : 'Reload'; }
      if (progress) progress.classList.toggle('loading', state.isLoading === true);
      if (security) security.classList.toggle('secure', String(state.url || '').startsWith('https:'));
      if (status) status.textContent = '';
      if (tabTitle) tabTitle.textContent = state.title || (state.url && state.url !== 'about:blank' ? state.url : 'New tab');
    })()`)
    if (state.title && !win.isDestroyed()) win.setTitle(`${state.title} — TaskWraith Browser`)
  }

  const renderError = (message: string): void => {
    evaluateInChrome(
      `(() => { const status = document.getElementById('status'); if (status) status.textContent = ${JSON.stringify(message)}; })()`
    )
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    let command: URL
    try {
      command = new URL(target)
    } catch {
      event.preventDefault()
      return
    }
    if (command.protocol !== FLOATING_COMMAND_PROTOCOL) {
      if (!target.startsWith('data:text/html')) event.preventDefault()
      return
    }
    event.preventDefault()
    const action = command.searchParams.get('action')
    if (action === 'dock') {
      if (!dockRequest) {
        renderError('Dock is not ready yet.')
        return
      }
      void Promise.resolve(dockRequest()).catch((error) =>
        renderError(error instanceof Error ? error.message : String(error))
      )
      return
    }
    if (action === 'new-tab') {
      if (!newTabRequest) {
        renderError('New tab is not ready yet.')
        return
      }
      void Promise.resolve(newTabRequest()).catch((error) =>
        renderError(error instanceof Error ? error.message : String(error))
      )
      return
    }
    if (!navigateRequest || kind !== 'web') {
      renderError('Browser controls are not ready yet.')
      return
    }
    const input: CanvasSurfaceNavigationInput = {}
    if (action === 'back' || action === 'forward' || action === 'reload' || action === 'stop') {
      input.action = action
    } else {
      const url = (command.searchParams.get('url') || '').trim()
      if (!url) return
      const normalized = normalizeFloatingAddress(url)
      if (!normalized) {
        renderError('Enter a web address like example.com or localhost:3000.')
        return
      }
      input.url = normalized
    }
    void navigateRequest(input)
      .then((state) => {
        latestState = state
        renderState()
      })
      .catch((error) => renderError(error instanceof Error ? error.message : String(error)))
  })
  win.webContents.on('did-finish-load', renderState)
  void win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(floatingChromeHtml(kind))}`)
    .catch(() => undefined)
  win.on('resize', layout)
  layout()

  return {
    webContents: page.webContents,
    getTitle: () =>
      page.webContents.getTitle() ||
      (kind === 'web' ? 'Browser' : kind === 'sketch' ? 'Sketch Canvas' : 'Emulator Canvas'),
    setContentSize: (width, height) => {
      if (!win.isDestroyed()) win.setContentSize(width, height + FLOATING_CHROME_HEIGHT)
      layout()
    },
    isDestroyed: () => win.isDestroyed() || page.webContents.isDestroyed(),
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    onClosed: (callback) => {
      win.on('closed', callback)
    },
    onNavigateRequest: (callback) => {
      navigateRequest = callback
    },
    setNavigationState: (state) => {
      latestState = state
      renderState()
    },
    onDockRequest: (callback) => {
      dockRequest = callback
    },
    onNewTabRequest: (callback) => {
      newTabRequest = callback
    }
  }
}
