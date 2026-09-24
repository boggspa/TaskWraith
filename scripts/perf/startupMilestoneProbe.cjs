'use strict'

/**
 * Startup milestone probe: attaches to a running (or launching) TaskWraith
 * instance over CDP and emits JSON lines for launch milestones:
 *
 *   devtools-up   — DevTools HTTP endpoint answering (Chromium up)
 *   page-target   — main window page target exists (createWindow happened)
 *   first-sample  — renderer answering Runtime.evaluate
 *   boot-ready    — `.app-root` present without `app-root-booting` (render-ready);
 *                   the sample carries performance.timeOrigin, nav timing, paints
 *   mask-gone     — `.app-boot-mask` unmounted (input unblocked: the mask is a
 *                   fixed inset-0 drag region until its 760 ms unmount timer)
 *
 * Wall clocks are epoch ms so callers can diff against their own launch T0.
 * Launch the instance per .claude/skills/verify/SKILL.md (unique
 * TASKWRAITH_INSTANCE_ID, unique --remote-debugging-port, IOS_REMOTE_TRUE=0);
 * scripts/perf/startupRunMatrix.cjs automates repeated runs.
 *
 * Usage: node scripts/perf/startupMilestoneProbe.cjs <debug-port> [timeoutMs]
 */

const http = require('http')
const WebSocket = require('ws')

const port = Number(process.argv[2] || 9377)
const timeoutMs = Number(process.argv[3] || 240000)
const t0 = Date.now()
let devtoolsUpLogged = false

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
      if (!devtoolsUpLogged) {
        devtoolsUpLogged = true
        console.log(
          JSON.stringify({ ev: 'devtools-up', wall: Date.now(), targetCount: targets.length })
        )
      }
      const page = targets.find((t) => t.type === 'page' && !/devtools:\/\//.test(t.url))
      if (page && page.webSocketDebuggerUrl) return page
    } catch {
      // DevTools HTTP not answering yet (e.g. sync first-boot migration).
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
    }, 5000)
  })
}

const probeExpr = `JSON.stringify({
  wall: Date.now(),
  timeOrigin: performance.timeOrigin,
  booting: !!document.querySelector('.app-root.app-root-booting'),
  maskPresent: !!document.querySelector('.app-boot-mask'),
  rootPresent: !!document.querySelector('.app-root'),
  readyState: document.readyState,
  nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, respEnd: n.responseEnd } : null })(),
  paint: performance.getEntriesByType('paint').map((p) => ({ n: p.name, t: p.startTime }))
})`

async function main() {
  console.log(JSON.stringify({ ev: 'probe-start', wall: t0, port }))
  const page = await waitForPage()
  console.log(JSON.stringify({ ev: 'page-target', wall: Date.now(), url: page.url }))
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  await rpc(ws, 'Runtime.enable', {})
  let firstSample = null
  let bootRevealWall = null
  let maskGoneWall = null
  let last = null
  for (;;) {
    if (Date.now() - t0 > timeoutMs) break
    let r
    try {
      r = await rpc(ws, 'Runtime.evaluate', { expression: probeExpr, returnByValue: true })
    } catch {
      await sleep(100)
      continue
    }
    if (!r || !r.result || typeof r.result.value !== 'string') {
      await sleep(100)
      continue
    }
    const s = JSON.parse(r.result.value)
    last = s
    if (!firstSample) {
      firstSample = s
      console.log(JSON.stringify({ ev: 'first-sample', wall: Date.now(), sample: s }))
    }
    if (s.rootPresent && !s.booting && bootRevealWall == null) {
      bootRevealWall = Date.now()
      console.log(JSON.stringify({ ev: 'boot-ready', wall: bootRevealWall, sample: s }))
    }
    if (bootRevealWall != null && !s.maskPresent && maskGoneWall == null) {
      maskGoneWall = Date.now()
      console.log(JSON.stringify({ ev: 'mask-gone', wall: maskGoneWall, sample: s }))
      break
    }
    await sleep(50)
  }
  console.log(JSON.stringify({ ev: 'final', wall: Date.now(), bootRevealWall, maskGoneWall, last }))
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('probe failed:', e.message)
  process.exit(1)
})
