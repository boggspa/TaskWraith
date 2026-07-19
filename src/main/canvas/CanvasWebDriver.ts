/**
 * CanvasWebDriver — the P0 `web` driver.
 *
 * Hosts the app-under-test on a {@link CanvasHostSurface} (a sandboxed standalone
 * BrowserWindow by default; a WebContentsView embedded in the app window when the
 * renderer-pane surface is injected) and drives its `webContents` WITHOUT the CDP
 * `webContents.debugger` (mutually exclusive with an open DevTools window + adds
 * attach/version churn). Instead it uses proven Electron primitives:
 *   - snapshot / inspect → `webContents.executeJavaScript` (fixed inspection
 *     scripts; arbitrary eval is the separate, signed-elevated canvas_eval verb)
 *   - screenshot         → `webContents.capturePage().toPNG()`
 *   - network            → per-partition `session.webRequest` ring buffer
 *   - console            → `webContents.on('console-message')` ring buffer
 *   - resize             → the surface's `setContentSize`
 *
 * The surface is injected (`deps.createSurface`) so WHERE the page lives is not the
 * driver's concern. Each canvas gets its own in-memory session partition so its
 * network buffer and cookies are isolated; the driver blocks popups, hardens the
 * session, and enforces the origin allowlist on every request (server-side SSRF).
 */
import type { WebContents } from 'electron'
import { createHash } from 'crypto'
import {
  createBrowserWindowSurface,
  type CanvasHostSurface,
  type CanvasSurfaceOptions
} from './CanvasHostSurface'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasConsoleLevel,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'
import { CanvasEvalEgressGate } from './CanvasEvalEgressGate'
import {
  CANVAS_EVAL_VALUE_CAP,
  isCanvasRequestBlocked,
  resolveViewport,
  validateCanvasUrl
} from './canvasTypes'
import {
  assertCanvasDnsAllowed,
  isCanvasDnsBlocked,
  type CanvasResolveHost
} from './CanvasDnsGuard'

const NETWORK_BUFFER = 200
const CONSOLE_BUFFER = 200
// How long the egress-cut is held AFTER an eval's synchronous frame resolves, so
// requests the script merely SCHEDULED (setTimeout(0) / microtask / a short async
// chain) are still cancelled before egress is restored. A long-delay timer that
// fires after this window is a documented residual — see evaluate().
const EVAL_EGRESS_HOLD_MS = 300

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const LOAD_TIMEOUT_MS = 20000

const DEFAULT_INSPECT_STYLES = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'padding',
  'margin',
  'border',
  'display',
  'width',
  'height'
]

// Injected DOM-walk that assigns stable refs (e1, e2, …), stashes the elements
// on window.__twCanvas__.refs for canvas_inspect, and returns a compact tree.
// NOTE: this is a template literal — every regex backslash is DOUBLED so it
// survives into the evaluated JS string (`\\s` here → `\s` in the page).
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = 400, TEXT_TRUNCATE = 200;
  const reg = (window.__twCanvas__ = { refs: {}, seq: 0 });
  let count = 0;
  const truncate = (s) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > TEXT_TRUNCATE ? s.slice(0, TEXT_TRUNCATE) + '\\u2026' : s; };
  const isVisible = (el) => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','LABEL','OPTION']);
  const LANDMARK = new Set(['NAV','MAIN','HEADER','FOOTER','SECTION','ARTICLE','ASIDE','FORM','IMG']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','PATH','HEAD','META','LINK']);
  const isHeading = (t) => /^H[1-6]$/.test(t);
  const implicitRole = (el) => {
    const t = el.tagName;
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'INPUT') return (el.getAttribute('type') || 'text');
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (isHeading(t)) return 'heading';
    if (t === 'NAV') return 'navigation';
    if (t === 'MAIN') return 'main';
    if (t === 'IMG') return 'img';
    return t.toLowerCase();
  };
  const accName = (el) => truncate(
    el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || (INTERACTIVE.has(el.tagName) ? el.textContent : '') || ''
  );
  const directText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return truncate(t);
  };
  const meaningful = (el) => INTERACTIVE.has(el.tagName) || el.hasAttribute('role') ||
    isHeading(el.tagName) || LANDMARK.has(el.tagName) || Boolean(directText(el));
  const build = (el) => {
    if (count >= MAX_NODES || SKIP.has(el.tagName) || !isVisible(el)) return null;
    const childNodes = [];
    for (const child of el.children) {
      const c = build(child);
      if (c) childNodes.push(c);
      if (count >= MAX_NODES) break;
    }
    const mine = meaningful(el);
    if (!mine && childNodes.length === 0) return null;
    if (!mine && childNodes.length === 1) return childNodes[0];
    const ref = 'e' + (++reg.seq);
    reg.refs[ref] = el; count++;
    const r = el.getBoundingClientRect();
    const node = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || implicitRole(el),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    const name = accName(el); if (name) node.name = name;
    const text = directText(el); if (text) node.text = text;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const itype = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT' && (itype === 'password' || itype === 'hidden')) {
        node.value = itype === 'password' ? '[redacted]' : '[hidden]';
      } else if (itype === 'checkbox' || itype === 'radio') {
        node.value = el.checked ? 'checked' : 'unchecked';
      } else {
        const v = el.value; if (v) node.value = String(v).slice(0, 200);
      }
    }
    if (childNodes.length) node.children = childNodes;
    return node;
  };
  const root = (document.body && build(document.body)) || { ref: 'e0', tag: 'body', role: 'document' };
  // Freeze the ref map so a malicious page cannot reassign refs[eN] to point a
  // later canvas_click/canvas_inspect at an attacker-chosen element. (The next
  // snapshot replaces window.__twCanvas__ wholesale, so this is per-snapshot.)
  try { Object.freeze(reg.refs); Object.freeze(reg); } catch (e) {}
  return { url: location.href, title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight }, root,
    nodeCount: reg.seq, truncated: count >= MAX_NODES };
})()`

function inspectScript(args: { ref?: string; selector?: string; styles?: string[] }): string {
  const ref = JSON.stringify(args.ref || null)
  const selector = JSON.stringify(args.selector || null)
  const props = JSON.stringify(
    args.styles && args.styles.length ? args.styles : DEFAULT_INSPECT_STYLES
  )
  return `(() => {
    const ref = ${ref}, selector = ${selector}, props = ${props};
    let el = null;
    if (ref && window.__twCanvas__ && window.__twCanvas__.refs) el = window.__twCanvas__.refs[ref] || null;
    if (!el && selector) { try { el = document.querySelector(selector); } catch (e) { el = null; } }
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const styles = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);
    return { found: true, tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], styles };
  })()`
}

// P1 click/fill. Resolves an element by ref (preferred), selector, or x/y, then
// performs a realistic interaction. Fill uses the native value setter +
// input/change events so React's controlled inputs notice the change.
function actScript(action: CanvasActionInput): string {
  const a = JSON.stringify({
    kind: action.kind,
    ref: action.ref ?? null,
    selector: action.selector ?? null,
    x: typeof action.x === 'number' ? action.x : null,
    y: typeof action.y === 'number' ? action.y : null,
    value: typeof action.value === 'string' ? action.value : null
  })
  return `(() => {
    const a = ${a};
    let el = null;
    if (a.ref && window.__twCanvas__ && window.__twCanvas__.refs) el = window.__twCanvas__.refs[a.ref] || null;
    if (!el && a.selector) { try { el = document.querySelector(a.selector); } catch (e) { el = null; } }
    if (!el && a.x != null && a.y != null) el = document.elementFromPoint(a.x, a.y);
    if (!el) return { ok: false, found: false, action: a.kind, message: 'Element not found.' };
    if (typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {} }
    if (a.kind === 'fill') {
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        return { ok: false, found: true, action: 'fill', message: 'Target is not a fillable field.' };
      }
      const itype = (el.getAttribute('type') || '').toLowerCase();
      try { el.focus(); } catch (e) {}
      if (tag === 'INPUT' && (itype === 'checkbox' || itype === 'radio')) {
        const want = a.value === 'true' || a.value === 'checked' || a.value === '1' || a.value === 'on';
        el.checked = want;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, found: true, action: 'fill', message: 'checked=' + want };
      }
      if (tag === 'INPUT' && itype === 'file') {
        return { ok: false, found: true, action: 'fill', message: 'File inputs cannot be set programmatically.' };
      }
      const next = a.value == null ? '' : String(a.value);
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, found: true, action: 'fill' };
    }
    try { el.focus(); } catch (e) {}
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') { try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', opts)); } }
    else el.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true, found: true, action: 'click' };
  })()`
}

// Set-of-Mark overlay: a fixed, pointer-events:none layer of numbered boxes the
// agent draws over elements (by ref or explicit bbox) to flag issues for the
// human. Numbers are the mark order; colour encodes severity.
function annotateScript(marks: CanvasMark[]): string {
  const m = JSON.stringify(marks)
  return `(() => {
    const marks = ${m};
    const SEV = { info: '#3b82f6', warn: '#f59e0b', error: '#ef4444' };
    const existing = document.getElementById('__twCanvasAnnotations');
    if (existing) existing.remove();
    const layer = document.createElement('div');
    layer.id = '__twCanvasAnnotations';
    // position:absolute (document-anchored) + page coords so boxes scroll WITH
    // the content instead of detaching on scroll (position:fixed would float).
    layer.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;';
    let count = 0;
    marks.forEach((mk, i) => {
      let rect = Array.isArray(mk.bbox) ? { x: mk.bbox[0], y: mk.bbox[1], w: mk.bbox[2], h: mk.bbox[3] } : null;
      if (!rect && mk.ref && window.__twCanvas__ && window.__twCanvas__.refs && window.__twCanvas__.refs[mk.ref]) {
        const r = window.__twCanvas__.refs[mk.ref].getBoundingClientRect();
        rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      if (!rect) return;
      const left = rect.x + window.scrollX, top = rect.y + window.scrollY;
      const color = SEV[mk.severity] || SEV.info;
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + rect.w + 'px;height:' + rect.h + 'px;border:2px solid ' + color + ';border-radius:3px;box-sizing:border-box;';
      const tag = document.createElement('div');
      tag.textContent = (i + 1) + (mk.label ? ': ' + mk.label : '');
      tag.style.cssText = 'position:absolute;left:0;top:-18px;background:' + color + ';color:#fff;font:11px/14px sans-serif;padding:1px 4px;border-radius:3px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;';
      box.appendChild(tag);
      layer.appendChild(box);
      count++;
    });
    document.body.appendChild(layer);
    return { count };
  })()`
}

function normalizeConsoleLevel(level: unknown): CanvasConsoleLevel {
  if (typeof level === 'number') {
    return level >= 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'info'
  }
  const s = String(level || '').toLowerCase()
  if (s.includes('err')) return 'error'
  if (s.includes('warn')) return 'warn'
  if (s.includes('debug') || s.includes('verbose')) return 'debug'
  if (s === 'log') return 'log'
  return 'info'
}

export interface CanvasWebDriverDeps {
  /** Inject an alternate host surface (e.g. an embedded WebContentsView). */
  createSurface?: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  /** Injectable DNS seam for SSRF/rebinding tests. Production uses dns.lookup. */
  resolveHost?: CanvasResolveHost
}

export class CanvasWebDriver implements CanvasDriver {
  readonly kind = 'web' as const

  private surface: CanvasHostSurface | null = null
  private readonly partition: string
  private allowlist: string[] = []
  private readonly networkBuffer: CanvasNetworkEntry[] = []
  private readonly networkById = new Map<number, CanvasNetworkEntry>()
  private readonly consoleEntries: CanvasConsoleEntry[] = []
  // While an arbitrary eval is in flight, ALL page requests are cancelled (not
  // just SSRF-class) so the model's script can never use fetch/XHR/ws/<img> as an
  // exfiltration channel during the eval window. Set immediately before, cleared
  // in a finally immediately after, win.webContents.executeJavaScript.
  private readonly evalEgressGate = new CanvasEvalEgressGate()
  private readonly createSurface: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  private readonly resolveHost?: CanvasResolveHost
  private readonly dnsBlockCache = new Map<string, Promise<boolean>>()
  // A Canvas driver is single-use. Once close() has been requested, every
  // pending open continuation must stay cancelled; otherwise a slow DNS or
  // navigation await can create/re-adopt a surface after history was cleared.
  private lifecycleGeneration = 0
  private closeRequested = false

  constructor(sessionId: string, deps: CanvasWebDriverDeps = {}) {
    // In-memory partition (no "persist:" prefix) — isolated, ephemeral session.
    this.partition = `canvas-${sessionId}`
    this.createSurface = deps.createSurface ?? createBrowserWindowSurface
    this.resolveHost = deps.resolveHost
  }

  private requireSurface(): CanvasHostSurface {
    if (!this.surface || this.surface.isDestroyed()) {
      throw new Error('Canvas surface is not open (or was closed).')
    }
    return this.surface
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.closeRequested) {
      throw new Error('Canvas open was cancelled because the driver was closed.')
    }
    const lifecycleGeneration = this.lifecycleGeneration
    const assertOpenStillLive = (): void => {
      if (
        this.closeRequested ||
        lifecycleGeneration !== this.lifecycleGeneration
      ) {
        throw new Error('Canvas open was cancelled because the driver was closed.')
      }
    }
    const rawUrl = (input.url || '').trim()
    this.allowlist = Array.isArray(input.originAllowlist) ? input.originAllowlist : []
    const verdict = validateCanvasUrl(rawUrl, this.allowlist)
    if (!verdict.ok || !verdict.normalizedUrl) {
      throw new Error(verdict.reason || 'Canvas URL was rejected.')
    }
    await assertCanvasDnsAllowed(verdict.normalizedUrl, this.allowlist, this.resolveHost)
    assertOpenStillLive()
    const viewport = resolveViewport({
      width: input.viewport?.width,
      height: input.viewport?.height
    })

    const surface = this.createSurface({
      partition: this.partition,
      width: viewport.width,
      height: viewport.height
    })
    this.surface = surface
    const wc = surface.webContents

    // Block popups / window.open — no new windows escape the canvas.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.hardenSession(wc)
    // The origin allowlist is enforced per-request in attachNetwork via
    // webRequest.onBeforeRequest (covers the main frame, subframes, subresources
    // and websockets — the navigation events only see the main frame).
    wc.on('console-message', (details) => {
      this.pushConsole({
        level: normalizeConsoleLevel((details as { level?: unknown }).level),
        message: String((details as { message?: unknown }).message ?? ''),
        line: (details as { lineNumber?: number }).lineNumber,
        sourceId: (details as { sourceId?: string }).sourceId,
        at: new Date().toISOString()
      })
    })
    this.attachNetwork(wc)
    surface.onClosed(() => {
      if (this.surface === surface) this.surface = null
    })

    await this.loadUrl(wc, verdict.normalizedUrl)
    assertOpenStillLive()
    return {
      url: wc.getURL() || verdict.normalizedUrl,
      title: surface.getTitle(),
      viewport
    }
  }

  private loadUrl(wc: WebContents, url: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onLoad)
        wc.removeListener('did-fail-load', onFail)
        err ? reject(err) : resolvePromise()
      }
      const onLoad = (): void => finish()
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ): void => {
        // -3 ERR_ABORTED fires when a main-frame load is superseded by a client/
        // server redirect that then succeeds; ignore it (mirrors the proven
        // browser path, which only logs did-fail-load) and let did-finish-load
        // or the timeout settle.
        if (isMainFrame && errorCode !== -3) {
          finish(new Error(`Navigation failed (${errorCode}): ${errorDescription} [${validatedURL}]`))
        }
      }
      const timer = setTimeout(() => finish(new Error(`Canvas load timed out after ${LOAD_TIMEOUT_MS}ms.`)), LOAD_TIMEOUT_MS)
      wc.on('did-finish-load', onLoad)
      wc.on('did-fail-load', onFail)
      wc.loadURL(url).catch((err) => finish(err instanceof Error ? err : new Error(String(err))))
    })
  }

  /**
   * Close the egress channels that webRequest.onBeforeRequest (and thus the eval
   * egress-cut) cannot see, on this canvas's isolated partition session:
   *  - WebRTC ICE/STUN/TURN/data-channel is UDP and bypasses webRequest entirely,
   *    so a script could open an RTCPeerConnection to exfiltrate. Force non-proxied
   *    UDP off and deny the media permission. (TURN-over-TCP remains a documented
   *    residual — see the canvas_eval security notes.)
   *  - A preview never needs device/geo/notification/clipboard permissions; deny
   *    them all so neither the page nor an eval'd script can open those sinks.
   *  - Downloads flow outside webRequest once the download manager takes over;
   *    refuse them so eval can't stage a remote <a download> egress/side effect.
   */
  private hardenSession(wc: WebContents): void {
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    } catch {
      // Older Electron / unavailable — best effort.
    }
    const ses = wc.session
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    try {
      ses.setPermissionCheckHandler(() => false)
    } catch {
      // Best effort — older Electron.
    }
    ses.on('will-download', (event) => event.preventDefault())
  }

  private attachNetwork(wc: WebContents): void {
    const wr = wc.session.webRequest
    // SSRF enforcement for EVERY request (any frame / subresource / websocket):
    // cancel requests to link-local/metadata, or to a private host not in the
    // allowlist. This is the real guard the navigation events cannot provide.
    wr.onBeforeRequest((details, callback) => {
      // Egress-cut during eval takes precedence over the per-host SSRF policy:
      // while a script is running, NOTHING leaves the page.
      if (this.evalEgressGate.active || isCanvasRequestBlocked(details.url, this.allowlist)) {
        callback({ cancel: true })
        return
      }
      this.dnsBlocked(details.url)
        .then((cancel) => callback({ cancel }))
        .catch(() => callback({ cancel: true }))
    })
    const push = (entry: CanvasNetworkEntry): void => {
      this.networkById.set(entry.id, entry)
      this.networkBuffer.push(entry)
      while (this.networkBuffer.length > NETWORK_BUFFER) {
        const dropped = this.networkBuffer.shift()
        if (dropped) this.networkById.delete(dropped.id)
      }
    }
    wr.onSendHeaders((details) => {
      push({
        id: details.id,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        startedAt: new Date().toISOString()
      })
    })
    wr.onCompleted((details) => {
      const entry = this.networkById.get(details.id)
      if (entry) {
        entry.status = details.statusCode
        entry.ok = details.statusCode < 400
        entry.completedAt = new Date().toISOString()
      }
    })
    wr.onErrorOccurred((details) => {
      const entry = this.networkById.get(details.id)
      if (entry) {
        entry.errorText = details.error
        entry.ok = false
        entry.completedAt = new Date().toISOString()
      }
    })
  }

  private dnsBlocked(url: string): Promise<boolean> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.resolve(false)
    }
    if (!parsed.hostname) return Promise.resolve(false)
    const key = `${parsed.protocol}//${parsed.hostname}|${this.allowlist.join(',')}`
    let cached = this.dnsBlockCache.get(key)
    if (!cached) {
      cached = isCanvasDnsBlocked(url, this.allowlist, this.resolveHost)
      this.dnsBlockCache.set(key, cached)
      if (this.dnsBlockCache.size > 256) {
        const first = this.dnsBlockCache.keys().next().value
        if (first) this.dnsBlockCache.delete(first)
      }
    }
    return cached
  }

  private pushConsole(entry: CanvasConsoleEntry): void {
    this.consoleEntries.push(entry)
    while (this.consoleEntries.length > CONSOLE_BUFFER) this.consoleEntries.shift()
  }

  async snapshot(): Promise<CanvasElementTree> {
    const wc = this.requireSurface().webContents
    const result = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as Omit<
      CanvasElementTree,
      'capturedAt'
    >
    return { ...result, capturedAt: new Date().toISOString() }
  }

  async screenshot(): Promise<CanvasFrame> {
    const wc = this.requireSurface().webContents
    const image = await wc.capturePage()
    const png = image.toPNG()
    const size = image.getSize()
    return {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width: size.width,
      height: size.height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: new Date().toISOString()
    }
  }

  async inspect(args: {
    ref?: string
    selector?: string
    styles?: string[]
  }): Promise<CanvasElementDetail> {
    const wc = this.requireSurface().webContents
    const detail = (await wc.executeJavaScript(
      inspectScript(args),
      true
    )) as Omit<CanvasElementDetail, 'ref' | 'selector'>
    return { ...detail, ref: args.ref, selector: args.selector }
  }

  async network(args: { filter?: 'all' | 'failed'; requestId?: number }): Promise<CanvasNetworkEntry[]> {
    this.requireSurface()
    let entries = [...this.networkBuffer]
    if (typeof args.requestId === 'number') {
      entries = entries.filter((entry) => entry.id === args.requestId)
    }
    if (args.filter === 'failed') {
      entries = entries.filter((entry) => entry.ok === false || (entry.status ?? 0) >= 400)
    }
    return entries
  }

  async console(args: { level?: 'all' | 'warn' | 'error'; lines?: number }): Promise<CanvasConsoleEntry[]> {
    this.requireSurface()
    let entries = [...this.consoleEntries]
    if (args.level === 'error') entries = entries.filter((entry) => entry.level === 'error')
    else if (args.level === 'warn') entries = entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
    const requested = Math.trunc(Number(args.lines))
    const lines = Math.max(1, Math.min(200, Number.isFinite(requested) ? requested : 50))
    return entries.slice(-lines)
  }

  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    this.requireSurface().setContentSize(viewport.width, viewport.height)
    return viewport
  }

  async act(action: CanvasActionInput): Promise<CanvasActResult> {
    const surface = this.requireSurface()
    const wc = surface.webContents
    const result = (await wc.executeJavaScript(actScript(action), true)) as {
      ok: boolean
      found: boolean
      action: 'click' | 'fill'
      message?: string
    }
    return {
      ...result,
      ref: action.ref,
      selector: action.selector,
      url: wc.getURL(),
      title: surface.getTitle()
    }
  }

  async annotate(marks: CanvasMark[]): Promise<{ count: number }> {
    const wc = this.requireSurface().webContents
    return (await wc.executeJavaScript(annotateScript(marks), true)) as {
      count: number
    }
  }

  async sketchDocument(): Promise<CanvasSketchDocument> {
    throw new Error('canvas_sketch_get is only available for the sketch driver.')
  }

  async sketchUpdate(_update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    throw new Error('canvas_sketch_update is only available for the sketch driver.')
  }

  async evaluate(args: { script: string }): Promise<CanvasEvalResult> {
    const surface = this.requireSurface()
    const wc = surface.webContents
    // Indirect eval `(0, eval)(src)` runs the script in the page's GLOBAL scope and
    // yields its completion value (supports both expressions and statement blocks).
    // The wrapper captures the value/error so a throw (or a page CSP that blocks
    // eval) returns { ok:false } instead of rejecting. JSON.stringify(script) does
    // all the escaping — no manual backslash handling needed.
    const cap = CANVAS_EVAL_VALUE_CAP
    const wrapped =
      '(() => { try { var __r = (0, eval)(' +
      JSON.stringify(args.script) +
      '); var t = typeof __r; var v; try { v = JSON.stringify(__r); } catch (e) { v = String(__r); }' +
      ' if (typeof v === "undefined") v = String(__r); var s = String(v);' +
      ' return { ok: true, valueType: t, value: s.slice(0, ' +
      cap +
      '), truncated: s.length > ' +
      cap +
      ' }; } catch (e) { var es = String((e && e.message) || e); return { ok: false, error: es.slice(0, ' +
      cap +
      '), truncated: es.length > ' +
      cap +
      ' }; } })()'
    // Cut ALL page egress for the script, then restore the per-host SSRF policy in
    // finally — even if the script throws.
    //
    // SCOPE / RESIDUALS (the egress-cut is best-effort defence-in-depth, NOT a hard
    // boundary — the primary control is that a human approved this exact script,
    // which they saw in full):
    //  - executeJavaScript resolves after the script's SYNCHRONOUS frame; a script
    //    can SCHEDULE a deferred request. We hold the cut for EVAL_EGRESS_HOLD_MS
    //    after it resolves to catch setTimeout(0)/microtask/short-async exfil. A
    //    LONG-delay timer (which the approver saw in the script) still escapes.
    //  - The eval RETURN VALUE is itself a read channel (the agent can `return
    //    document.cookie`); the cut does not — and is not meant to — stop that.
    //  - WebRTC/downloads are closed in hardenSession(); TURN-over-TCP is residual.
    const releaseEgressCut = this.evalEgressGate.enter()
    let result: Omit<CanvasEvalResult, 'url' | 'title'>
    try {
      result = (await wc.executeJavaScript(wrapped, true)) as Omit<
        CanvasEvalResult,
        'url' | 'title'
      >
    } finally {
      await delay(EVAL_EGRESS_HOLD_MS)
      releaseEgressCut()
    }
    return { ...result, url: wc.getURL(), title: surface.getTitle() }
  }

  async reload(): Promise<void> {
    this.requireSurface().webContents.reload()
  }

  async close(): Promise<void> {
    this.closeRequested = true
    this.lifecycleGeneration += 1
    const surface = this.surface
    this.surface = null
    if (!surface || surface.isDestroyed()) return
    try {
      const wr = surface.webContents.session.webRequest
      wr.onBeforeRequest(null)
      wr.onSendHeaders(null)
      wr.onCompleted(null)
      wr.onErrorOccurred(null)
    } catch {
      // Session may already be torn down.
    }
    surface.destroy()
  }
}
