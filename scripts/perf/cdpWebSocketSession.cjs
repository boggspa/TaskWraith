'use strict'

/**
 * CDP / Node-inspector WebSocket session adapters for T2.
 * Uses dependency-injected WebSocket ctor (defaults to `ws` when available).
 * Does not discover or attach to arbitrary Electron processes.
 */

/**
 * @typedef {object} WsLike
 * @property {(event: string, handler: Function) => void} on
 * @property {(data: string) => void} send
 * @property {() => void} close
 * @property {number} [readyState]
 */

/**
 * @returns {new (url: string, opts?: object) => WsLike}
 */
function defaultWebSocketCtor() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    return require('ws')
  } catch (error) {
    const err = new Error(
      `WebSocket ctor unavailable (require('ws') failed: ${error && error.message ? error.message : error}). Inject WebSocket via options.WebSocket.`
    )
    err.cause = error
    throw err
  }
}

/**
 * Open a JSON-RPC CDP session over WebSocket.
 * @param {object} options
 * @param {string} options.url — webSocketDebuggerUrl
 * @param {new (url: string) => WsLike} [options.WebSocket]
 * @param {number} [options.openTimeoutMs=5000]
 * @returns {Promise<{ send: Function, close: Function, onEvent: Function, url: string }>}
 */
function openCdpWebSocketSession(options) {
  const url = options && options.url
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
    return Promise.reject(new Error('CDP WebSocket url must be ws:// or wss://'))
  }
  const WebSocket = options.WebSocket || defaultWebSocketCtor()
  const openTimeoutMs = options.openTimeoutMs == null ? 5000 : options.openTimeoutMs

  return new Promise((resolve, reject) => {
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    const pending = new Map()
    /** @type {Set<Function>} */
    const eventHandlers = new Set()
    let nextId = 1
    let settled = false
    /** @type {WsLike} */
    const ws = new WebSocket(url)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`CDP WebSocket open timed out after ${openTimeoutMs}ms`))
    }, openTimeoutMs)

    function cleanupTimer() {
      clearTimeout(timer)
    }

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
        return
      }
      if (msg && typeof msg.method === 'string') {
        for (const handler of eventHandlers) {
          try {
            handler(msg)
          } catch {
            // ignore handler errors
          }
        }
      }
    })

    ws.on('error', (err) => {
      if (settled) return
      settled = true
      cleanupTimer()
      reject(err instanceof Error ? err : new Error(String(err)))
    })

    ws.on('open', () => {
      if (settled) return
      settled = true
      cleanupTimer()
      resolve({
        url,
        send(method, params) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            const payload = JSON.stringify({
              id,
              method,
              params: params || {}
            })
            try {
              ws.send(payload)
            } catch (error) {
              pending.delete(id)
              rej(error instanceof Error ? error : new Error(String(error)))
            }
          })
        },
        onEvent(handler) {
          if (typeof handler === 'function') eventHandlers.add(handler)
          return () => eventHandlers.delete(handler)
        },
        close() {
          for (const [, entry] of pending) {
            entry.reject(new Error('CDP session closed'))
          }
          pending.clear()
          eventHandlers.clear()
          try {
            ws.close()
          } catch {
            // ignore
          }
        }
      })
    })
  })
}

/**
 * Fetch CDP target list + version from an exact host/port (the spawned child's port).
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.host='127.0.0.1']
 * @param {{ httpGetJson?: Function }} [options.adapters]
 */
async function fetchCdpTargets(options) {
  const host = options.host || '127.0.0.1'
  const port = options.port
  if (!Number.isInteger(port)) throw new Error('port required')

  const httpGetJson =
    options.adapters && typeof options.adapters.httpGetJson === 'function'
      ? options.adapters.httpGetJson
      : defaultHttpGetJson

  const version = await httpGetJson(`http://${host}:${port}/json/version`)
  const targets = await httpGetJson(`http://${host}:${port}/json/list`).catch(async () =>
    httpGetJson(`http://${host}:${port}/json`)
  )
  return { version, targets: Array.isArray(targets) ? targets : [] }
}

/**
 * Pick the page target for the TaskWraith renderer. Prefer type=page.
 * @param {object[]} targets
 */
function selectRendererTarget(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('No CDP targets available on the exact child port')
  }
  const page =
    targets.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl) ||
    targets.find((t) => t && t.webSocketDebuggerUrl)
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('No CDP target with webSocketDebuggerUrl on the exact child port')
  }
  return page
}

/**
 * Attach renderer CDP session to the exact child's remote-debugging port.
 * @param {object} options
 * @param {number} options.port
 * @param {new (url: string) => WsLike} [options.WebSocket]
 * @param {{ httpGetJson?: Function }} [options.adapters]
 */
async function attachRendererCdpSession(options) {
  const adapters = options.adapters || {}
  const sleep =
    typeof adapters.sleep === 'function'
      ? adapters.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nowMs = typeof adapters.nowMs === 'function' ? adapters.nowMs : Date.now
  const timeoutMs = Number.isFinite(adapters.timeoutMs) ? adapters.timeoutMs : 30_000
  const maxDelayMs = Number.isFinite(adapters.maxDelayMs) ? adapters.maxDelayMs : 1_000
  let delayMs = Number.isFinite(adapters.initialDelayMs) ? adapters.initialDelayMs : 100
  const deadline = nowMs() + Math.max(0, timeoutMs)
  let version = null
  let target = null
  let lastError = null

  while (!target) {
    try {
      const fetched = await fetchCdpTargets(options)
      version = fetched.version
      target = selectRendererTarget(fetched.targets)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (target) break
    if (nowMs() >= deadline) {
      const error = new Error(
        `Renderer CDP on exact child port ${options.port} was not ready within ${timeoutMs}ms: ${lastError.message}`
      )
      error.cause = lastError
      throw error
    }
    await sleep(Math.max(0, delayMs))
    delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2))
  }

  const session = await openCdpWebSocketSession({
    url: target.webSocketDebuggerUrl,
    WebSocket: options.WebSocket,
    openTimeoutMs: options.openTimeoutMs
  })
  return {
    kind: 'renderer_cdp',
    port: options.port,
    targetId: target.id || null,
    title: target.title || null,
    browserVersion: version && version['Browser'] ? version['Browser'] : null,
    session,
    send: session.send,
    onEvent: session.onEvent,
    close: session.close
  }
}

/**
 * Attach main-process Node inspector via ws://127.0.0.1:<inspectPort>/<id>.
 * Requires injected discovery of the inspector URL for the exact child.
 * @param {object} options
 * @param {string} options.webSocketDebuggerUrl — must belong to the spawned child
 * @param {new (url: string) => WsLike} [options.WebSocket]
 */
async function attachMainInspectorSession(options) {
  const url = options.webSocketDebuggerUrl
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
    throw new Error('main inspector webSocketDebuggerUrl required')
  }
  const session = await openCdpWebSocketSession({
    url,
    WebSocket: options.WebSocket,
    openTimeoutMs: options.openTimeoutMs
  })
  // Node inspector uses Session.post semantics; adapt send→post.
  return {
    kind: 'main_inspector',
    url,
    session,
    post(method, params) {
      return session.send(method, params)
    },
    on(event, handler) {
      return session.onEvent((msg) => {
        if (msg.method === event || msg.method === `Node.${event}`) handler(msg.params || msg)
      })
    },
    connect() {},
    disconnect() {
      session.close()
    },
    close: session.close
  }
}

/**
 * Discover Node inspector WS URL on a port (GET /json).
 * @param {object} options
 * @param {number} options.port
 * @param {{ httpGetJson?: Function, sleep?: Function, nowMs?: Function, timeoutMs?: number, initialDelayMs?: number, maxDelayMs?: number }} [options.adapters]
 */
async function discoverMainInspectorUrl(options) {
  const host = options.host || '127.0.0.1'
  const adapters = options.adapters || {}
  const httpGetJson =
    typeof adapters.httpGetJson === 'function' ? adapters.httpGetJson : defaultHttpGetJson
  const sleep =
    typeof adapters.sleep === 'function'
      ? adapters.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nowMs = typeof adapters.nowMs === 'function' ? adapters.nowMs : Date.now
  const timeoutMs = Number.isFinite(adapters.timeoutMs) ? adapters.timeoutMs : 30_000
  const maxDelayMs = Number.isFinite(adapters.maxDelayMs) ? adapters.maxDelayMs : 1_000
  let delayMs = Number.isFinite(adapters.initialDelayMs) ? adapters.initialDelayMs : 100
  const deadline = nowMs() + Math.max(0, timeoutMs)
  let lastError = null

  while (true) {
    try {
      const list = await httpGetJson(`http://${host}:${options.port}/json`)
      const targets = Array.isArray(list) ? list : []
      const target =
        targets.find((t) => t && t.webSocketDebuggerUrl) ||
        (list && list.webSocketDebuggerUrl ? list : null)
      if (target && target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
      lastError = new Error(`No inspector WebSocket on port ${options.port}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (nowMs() >= deadline) {
      const error = new Error(
        `Main inspector on exact child port ${options.port} was not ready within ${timeoutMs}ms: ${lastError.message}`
      )
      error.cause = lastError
      throw error
    }
    await sleep(Math.max(0, delayMs))
    delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2))
  }
}

function defaultHttpGetJson(urlString) {
  const http = require('http')
  const https = require('https')
  const u = new URL(urlString)
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        timeout: 2000
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('http timeout'))
    })
  })
}

module.exports = {
  defaultWebSocketCtor,
  openCdpWebSocketSession,
  fetchCdpTargets,
  selectRendererTarget,
  attachRendererCdpSession,
  attachMainInspectorSession,
  discoverMainInspectorUrl
}
