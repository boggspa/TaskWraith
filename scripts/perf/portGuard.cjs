'use strict'

/**
 * Occupied-port / instance preflight for T2 isolated launch.
 * Dependency-injected net + process probes — unit tests never bind real ports
 * unless they opt in with a real adapter.
 */

const net = require('net')
const http = require('http')

/**
 * @param {number} port
 * @param {{ createServer?: typeof net.createServer }} [adapters]
 * @returns {Promise<{ port: number, occupied: boolean, error?: string }>}
 */
function probePortOccupied(port, adapters = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return Promise.resolve({
      port,
      occupied: true,
      error: 'port must be an integer 1024–65535'
    })
  }
  const createServer = adapters.createServer || net.createServer
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (err) => {
      resolve({
        port,
        occupied: true,
        error: err && err.code ? String(err.code) : String(err)
      })
    })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve({ port, occupied: false })
      })
    })
  })
}

/**
 * HTTP GET /json/version — occupied CDP endpoint detector.
 * @param {number} port
 * @param {{ httpGet?: Function, timeoutMs?: number }} [adapters]
 */
function probeCdpEndpoint(port, adapters = {}) {
  const timeoutMs = adapters.timeoutMs == null ? 500 : adapters.timeoutMs
  if (typeof adapters.httpGet === 'function') {
    return adapters.httpGet(port)
  }
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/json/version',
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({
            port,
            reachable: true,
            statusCode: res.statusCode,
            body
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ port, reachable: false, error: 'timeout' })
    })
    req.on('error', (err) => {
      resolve({ port, reachable: false, error: String(err && err.code ? err.code : err) })
    })
  })
}

/**
 * Refuse launch when renderer CDP or main inspector ports are occupied,
 * or when an endpoint already answers on the CDP port.
 * @param {object} options
 * @param {number} options.remoteDebuggingPort
 * @param {number} options.mainInspectorPort
 * @param {string} options.instanceId
 * @param {{ probePort?: Function, probeCdp?: Function, listInstancePids?: Function }} [adapters]
 */
async function assertLaunchPortsFree(options, adapters = {}) {
  const remoteDebuggingPort = options.remoteDebuggingPort
  const mainInspectorPort = options.mainInspectorPort
  const instanceId = options.instanceId
  if (remoteDebuggingPort === mainInspectorPort) {
    throw new Error('remoteDebuggingPort and mainInspectorPort must be distinct')
  }

  const probePort = adapters.probePort || probePortOccupied
  const probeCdp = adapters.probeCdp || probeCdpEndpoint
  const errors = []

  const cdpPort = await probePort(remoteDebuggingPort)
  if (cdpPort.occupied) {
    errors.push(`renderer CDP port ${remoteDebuggingPort} occupied (${cdpPort.error || 'busy'})`)
  }
  const inspPort = await probePort(mainInspectorPort)
  if (inspPort.occupied) {
    errors.push(`main inspector port ${mainInspectorPort} occupied (${inspPort.error || 'busy'})`)
  }

  const cdpHttp = await probeCdp(remoteDebuggingPort)
  if (cdpHttp && cdpHttp.reachable) {
    errors.push(
      `CDP already answering on ${remoteDebuggingPort} — refuse attaching to a pre-existing session`
    )
  }

  if (typeof adapters.listInstancePids === 'function') {
    const pids = adapters.listInstancePids(instanceId) || []
    if (pids.length > 0) {
      errors.push(
        `instanceId ${instanceId} already has live pid(s): ${pids.join(',')}. Refuse concurrent reuse.`
      )
    }
  }

  if (errors.length > 0) {
    const err = new Error(`Launch preflight refused:\n- ${errors.join('\n- ')}`)
    err.errors = errors
    throw err
  }

  return {
    ok: true,
    remoteDebuggingPort,
    mainInspectorPort,
    instanceId
  }
}

module.exports = {
  probePortOccupied,
  probeCdpEndpoint,
  assertLaunchPortsFree
}
