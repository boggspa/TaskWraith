import { BrowserWindow, type WebContents } from 'electron'
import type { AudioEngine, AudioRenderMeta, AudioRenderSpec } from './AudioToolExecutors'

/**
 * Electron-backed engine for the audio_render_wav MCP tool.
 *
 * It renders a self-contained page that uses the Web Audio API
 * (OfflineAudioContext) to synthesize a tone, hand-builds a 16-bit PCM WAV in
 * pure JS, measures peak/RMS/dBFS, and paints a waveform onto a full-window
 * <canvas>, which is then captured to PNG. No native dependency (no ffmpeg, no
 * sharp) — every codec here is Chromium-builtin or pure-JS, so it is safe for
 * the universal (x64+arm64) build.
 *
 * Security posture (mirrors OffscreenImageRenderer / CanvasWebDriver, one-shot):
 *  - sandbox + contextIsolation, no node integration, no insecure content;
 *  - hidden window on a fresh EPHEMERAL in-memory partition (no persisted state);
 *  - ALL network egress is cancelled (onBeforeRequest -> cancel); permissions
 *    denied; downloads blocked; window.open denied; WebRTC (UDP, bypasses
 *    webRequest) closed — so even though JavaScript is ENABLED for this surface,
 *    the page cannot phone home, read local files, or reach cloud-metadata;
 *  - content is always a `data:` URL (never file:// or remote);
 *  - the page script is OUR code interpolating ONLY a JSON.stringify of vetted
 *    primitives (clamped numbers + a fixed-enum waveform) — never agent text — so
 *    there is no script-injection vector. This is a parameterized render, not an
 *    eval surface.
 *
 * Why JavaScript is on here when OffscreenImageRenderer turns it OFF: Web Audio
 * synthesis + the WAV build + the canvas draw all require JS. The egress cut +
 * sandbox + ephemeral partition keep the surface contained without the
 * javascript:false structural kill the image renderer relies on.
 */

const DEFAULT_RENDER_TIMEOUT_MS = 20_000
const MAX_CONCURRENT_AUDIO_RENDERS = 2

let renderSeq = 0
let activeRenders = 0
const renderQueue: Array<() => void> = []

async function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_AUDIO_RENDERS) {
    activeRenders += 1
    return
  }
  await new Promise<void>((resolve) => renderQueue.push(resolve))
}

function releaseRenderSlot(): void {
  const next = renderQueue.shift()
  if (next) {
    next()
  } else {
    activeRenders -= 1
  }
}

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

const OK_PREFIX = 'AUDIO_OK:'
const ERR_PREFIX = 'AUDIO_ERR:'

/**
 * The in-page render script. Pure JS, no template-literal interpolation here —
 * it reads its parameters from a `SPEC` global the engine injects via
 * JSON.stringify. Signals completion by flipping document.title to
 * `AUDIO_OK:<meta-json>` or `AUDIO_ERR:<message>` (the title is the one channel
 * that needs no executeJavaScript and survives sandbox/contextIsolation cleanly).
 */
const AUDIO_RENDER_SCRIPT = `(function(){
  try {
    var sr = SPEC.sampleRate, frames = SPEC.frames, freq = SPEC.frequencyHz;
    var type = SPEC.waveform, gain = SPEC.gain, W = SPEC.width, H = SPEC.height;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) { document.title = '${ERR_PREFIX}OfflineAudioContext unavailable'; return; }
    var ctx = new OAC(1, frames, sr);
    var osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g); g.connect(ctx.destination);
    osc.start(0); osc.stop(frames / sr);
    ctx.startRendering().then(function(buf){
      var data = buf.getChannelData(0);
      var peak = 0, sumsq = 0;
      for (var i = 0; i < data.length; i++) {
        var v = data[i]; var a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumsq += v * v;
      }
      var rms = data.length ? Math.sqrt(sumsq / data.length) : 0;
      var peakDbfs = peak > 0 ? 20 * Math.log10(peak) : -120;
      var dataLen = data.length * 2;
      var ab = new ArrayBuffer(44 + dataLen);
      var dv = new DataView(ab);
      function ws(off, s){ for (var j = 0; j < s.length; j++) dv.setUint8(off + j, s.charCodeAt(j)); }
      ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
      ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, 'data'); dv.setUint32(40, dataLen, true);
      var off = 44;
      for (var k = 0; k < data.length; k++) {
        var x = data[k]; x = x < -1 ? -1 : x > 1 ? 1 : x;
        dv.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true); off += 2;
      }
      var head = new Uint8Array(ab, 0, 4);
      var headOk = head[0] === 82 && head[1] === 73 && head[2] === 70 && head[3] === 70;
      var cv = document.getElementById('wf');
      var c = cv.getContext('2d');
      c.clearRect(0, 0, W, H);
      c.fillStyle = 'rgba(120,140,180,0.10)'; c.fillRect(0, 0, W, H);
      var mid = H / 2;
      c.strokeStyle = 'rgba(90,120,200,0.45)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, mid); c.lineTo(W, mid); c.stroke();
      c.fillStyle = 'rgba(70,110,200,0.85)';
      var step = Math.max(1, Math.floor(data.length / W));
      for (var px = 0; px < W; px++) {
        var start = px * step; if (start >= data.length) break;
        var mn = 1, mx = -1;
        for (var s2 = 0; s2 < step; s2++) {
          var idx = start + s2; if (idx >= data.length) break;
          var val = data[idx]; if (val < mn) mn = val; if (val > mx) mx = val;
        }
        var y1 = mid - mx * mid; var y2 = mid - mn * mid;
        c.fillRect(px, y1, 1, Math.max(1, y2 - y1));
      }
      var meta = {
        sampleRate: sr, frames: frames, durationMs: Math.round(frames / sr * 1000),
        channels: 1, waveform: type, frequencyHz: freq, gain: gain,
        peak: Number(peak.toFixed(5)), rms: Number(rms.toFixed(5)),
        peakDbfs: Number(peakDbfs.toFixed(2)), wavByteLength: 44 + dataLen, wavHeaderOk: headOk
      };
      document.title = '${OK_PREFIX}' + JSON.stringify(meta);
    }).catch(function(e){
      document.title = '${ERR_PREFIX}' + String(e && e.message || e).slice(0, 180);
    });
  } catch (e) {
    document.title = '${ERR_PREFIX}' + String(e && e.message || e).slice(0, 180);
  }
})();`

function buildAudioPageHtml(spec: AudioRenderSpec): string {
  // SPEC is a JSON literal of vetted primitives — numbers + a fixed-enum string —
  // so it cannot break out of the <script> or inject markup.
  const specJson = JSON.stringify(spec)
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>AUDIO_PENDING</title>' +
    '<style>html,body{margin:0;padding:0;background:transparent}canvas{display:block}</style>' +
    '</head><body>' +
    `<canvas id="wf" width="${spec.width}" height="${spec.height}"></canvas>` +
    `<script>var SPEC=${specJson};${AUDIO_RENDER_SCRIPT}</script>` +
    '</body></html>'
  )
}

/** Resolve once the page flips its title to an OK/ERR sentinel, or reject on a
 * load failure. Listener is attached BEFORE loadURL and the post-load title is
 * re-checked, so a fast render that finishes before we listen can't be missed. */
function loadAndAwaitSignal(wc: WebContents, dataUrl: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      wc.removeListener('page-title-updated', onTitle)
      wc.removeListener('did-fail-load', onFail)
    }
    const finish = (title: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(title)
    }
    function onTitle(_event: unknown, title: string): void {
      if (title && (title.startsWith(OK_PREFIX) || title.startsWith(ERR_PREFIX))) finish(title)
    }
    function onFail(_event: unknown, code: number, desc: string): void {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`audio render failed (${code}): ${desc || 'load error'}`))
    }
    wc.on('page-title-updated', onTitle)
    wc.once('did-fail-load', onFail)
    wc.loadURL(dataUrl).then(
      () => {
        const current = wc.getTitle()
        if (current && (current.startsWith(OK_PREFIX) || current.startsWith(ERR_PREFIX))) {
          finish(current)
        }
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function parseMeta(title: string): AudioRenderMeta {
  const json = title.slice(OK_PREFIX.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('audio render returned malformed metadata')
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as AudioRenderMeta).sampleRate !== 'number') {
    throw new Error('audio render returned incomplete metadata')
  }
  return parsed as AudioRenderMeta
}

async function renderWaveformPng(
  spec: AudioRenderSpec,
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS
): Promise<{ png: Buffer; meta: AudioRenderMeta }> {
  await acquireRenderSlot()
  // Construction can throw (GPU/compositor init, OOM, mid-teardown); it MUST live
  // inside the try so `finally` always releases the slot — otherwise a throw
  // before release would, after MAX_CONCURRENT, wedge every audio render forever.
  let win: BrowserWindow | null = null
  let wc: WebContents | null = null
  const detachNetwork = (): void => {
    if (!wc) return
    try {
      wc.session.webRequest.onBeforeRequest(null)
    } catch {
      // session may already be torn down
    }
  }
  try {
    renderSeq += 1
    win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        partition: `taskwraith-audio-render-${renderSeq}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        // JavaScript is required (Web Audio + canvas draw). WebGL is not — the
        // waveform is 2D canvas — so leave it off to shrink the surface.
        javascript: true,
        webgl: false,
        plugins: false,
        backgroundThrottling: false
      }
    })
    wc = win.webContents
    // Egress cut: allow ONLY the self-contained schemes (the top-level `data:`
    // page and any `data:`/`blob:` assets it builds in-memory), cancel every real
    // network request (http/https/ws/file/…). This is scheme-aware rather than a
    // blanket cancel because a blanket `cancel:true` also blocks the top-level
    // `data:` navigation itself (ERR_BLOCKED_BY_CLIENT) — verified against this
    // Electron. It does NOT weaken SSRF/file containment: those schemes stay cut.
    wc.session.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url || ''
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        callback({})
      } else {
        callback({ cancel: true })
      }
    })
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    try {
      wc.session.setPermissionCheckHandler(() => false)
    } catch {
      // Best effort — older Electron.
    }
    wc.session.on('will-download', (event) => event.preventDefault())
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    } catch {
      // Best effort — older Electron.
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.setContentSize(spec.width, spec.height)
    const html = buildAudioPageHtml(spec)
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`
    const title = await withTimeout(loadAndAwaitSignal(wc, dataUrl), timeoutMs, 'audio render timed out')
    if (title.startsWith(ERR_PREFIX)) {
      throw new Error(title.slice(ERR_PREFIX.length) || 'audio render failed')
    }
    const meta = parseMeta(title)
    const captured = await wc.capturePage()
    // capturePage returns PHYSICAL pixels (2x on Retina). Normalize to the
    // requested LOGICAL dimensions so size/coords are honest and the downstream
    // byte cap isn't tripped by an unexpected 4x volume.
    const size = captured.getSize()
    const image =
      size.width !== spec.width || size.height !== spec.height
        ? captured.resize({ width: spec.width, height: spec.height })
        : captured
    return { png: image.toPNG(), meta }
  } finally {
    detachNetwork()
    if (win && !win.isDestroyed()) win.destroy()
    releaseRenderSlot()
  }
}

/** Build the real, Electron-backed AudioEngine. */
export function createNativeAudioEngine(): AudioEngine {
  return { renderWaveformPng }
}
