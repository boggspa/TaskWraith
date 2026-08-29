'use strict'

/**
 * CDP probe for the two user-visible startup surfaces this repo changed:
 *
 *   1. The boot mask. It is a full-window `position: fixed` overlay with
 *      `-webkit-app-region: drag`, so while it is armed it swallows every
 *      click. The probe samples, at the exact instant boot-ready flips, whether
 *      input is actually released — computed `pointer-events`, computed
 *      `-webkit-app-region`, and what `elementFromPoint` at the window centre
 *      returns. `mask-gone` (unmount) is deliberately reported separately,
 *      because unmount and input-release are now different moments.
 *
 *   2. The startup-authority banner, which is the only user-visible signal that
 *      workspace mutation, provider admission, run recovery and scheduling are
 *      fail-closed.
 *
 * Pass --reduced-motion to emulate `prefers-reduced-motion: reduce` before the
 * renderer reads it, which is what selects the short unmount delay.
 *
 * Launch the instance per .claude/skills/verify/SKILL.md (unique
 * TASKWRAITH_INSTANCE_ID, unique --remote-debugging-port, IOS_REMOTE_TRUE=0).
 *
 * Usage: node scripts/perf/bootSurfaceProbe.cjs <debug-port> [timeoutMs] [--reduced-motion]
 */

const http = require('http')
const WebSocket = require('ws')

const port = Number(process.argv[2] || 9377)
const timeoutMs = Number(process.argv[3] || 120000)
const reducedMotion = process.argv.includes('--reduced-motion')
const t0 = Date.now()

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPage() {
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for page target')
    try {
      const targets = JSON.parse(await get('/json/list'))
      const page = targets.find((t) => t.type === 'page' && !/devtools:\/\//.test(t.url))
      if (page && page.webSocketDebuggerUrl) return page
    } catch {
      // DevTools HTTP not answering yet.
    }
    await sleep(100)
  }
}

let msgId = 0
function rpc(ws, method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      const m = JSON.parse(data)
      if (m.id === id) {
        ws.off('message', onMsg)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error('rpc timeout'))
    }, 8000)
  })
}

const sampleExpr = `(() => {
  const root = document.querySelector('.app-root')
  const mask = document.querySelector('.app-boot-mask')
  const style = mask ? getComputedStyle(mask) : null
  const cx = Math.round(window.innerWidth / 2)
  const cy = Math.round(window.innerHeight / 2)
  const hit = document.elementFromPoint(cx, cy)
  const banner = document.querySelector('.startup-authority-banner')
  return JSON.stringify({
    wall: Date.now(),
    rootPresent: !!root,
    booting: !!document.querySelector('.app-root.app-root-booting'),
    maskPresent: !!mask,
    maskLeaving: !!(mask && mask.classList.contains('is-leaving')),
    maskPointerEvents: style ? style.pointerEvents : null,
    maskAppRegion: style ? (style.webkitAppRegion || style.getPropertyValue('-webkit-app-region') || null) : null,
    maskOpacity: style ? style.opacity : null,
    hitClass: hit ? (hit.className && hit.className.baseVal !== undefined ? hit.className.baseVal : String(hit.className || '')) : null,
    hitIsMask: !!(hit && hit.closest && hit.closest('.app-boot-mask')),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    banner: banner
      ? {
          role: banner.getAttribute('role'),
          tone: banner.getAttribute('data-tone'),
          headline: (banner.querySelector('.startup-authority-banner__headline') || {}).textContent || null,
          detail: (banner.querySelector('.startup-authority-banner__detail') || {}).textContent || null,
          retryLabel: (banner.querySelector('.startup-authority-banner__retry') || {}).textContent || null
        }
      : null
  })
})()`

async function sample(ws) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: sampleExpr, returnByValue: true })
  if (!r || !r.result || typeof r.result.value !== 'string') return null
  return JSON.parse(r.result.value)
}

async function main() {
  console.log(JSON.stringify({ ev: 'probe-start', wall: t0, port, reducedMotion }))
  const page = await waitForPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  await rpc(ws, 'Runtime.enable', {})
  if (reducedMotion) {
    // Must land before the renderer reads matchMedia at boot-ready.
    await rpc(ws, 'Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
  }

  let bootReady = null
  let maskGone = null
  let last = null
  for (;;) {
    if (Date.now() - t0 > timeoutMs) break
    let s
    try {
      s = await sample(ws)
    } catch {
      await sleep(50)
      continue
    }
    if (!s) {
      await sleep(50)
      continue
    }
    last = s
    if (s.rootPresent && !s.booting && !bootReady) {
      bootReady = s
      console.log(JSON.stringify({ ev: 'boot-ready', wall: s.wall, sample: s }))
    }
    if (bootReady && !s.maskPresent && !maskGone) {
      maskGone = s
      console.log(
        JSON.stringify({
          ev: 'mask-gone',
          wall: s.wall,
          msAfterBootReady: s.wall - bootReady.wall,
          sample: s
        })
      )
      break
    }
    await sleep(25)
  }

  const verdict = {
    ev: 'verdict',
    reducedMotionEmulated: reducedMotion,
    reducedMotionObserved: bootReady ? bootReady.reducedMotion : null,
    // The load-bearing assertion: at boot-ready the mask may still be painted,
    // but it must not be able to intercept a click.
    inputReleasedAtBootReady: bootReady
      ? !bootReady.maskPresent ||
        (bootReady.maskPointerEvents === 'none' && bootReady.hitIsMask === false)
      : null,
    maskStillPaintedAtBootReady: bootReady ? bootReady.maskPresent : null,
    maskPointerEventsAtBootReady: bootReady ? bootReady.maskPointerEvents : null,
    hitTargetAtBootReady: bootReady ? bootReady.hitClass : null,
    maskUnmountMsAfterBootReady: maskGone ? maskGone.wall - bootReady.wall : null,
    banner: bootReady ? bootReady.banner : null
  }
  console.log(JSON.stringify(verdict))
  console.log(JSON.stringify({ ev: 'final', last }))
  ws.close()
  process.exit(verdict.inputReleasedAtBootReady === true ? 0 : 2)
}

main().catch((e) => {
  console.error('probe failed:', e.message)
  process.exit(1)
})
