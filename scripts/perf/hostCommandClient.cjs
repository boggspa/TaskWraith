'use strict'

/**
 * M1 S8: the harness's own Host command client (Independent Threads
 * Programme; M1 live-driver design record, S8).
 *
 * Host-native cells need commands on the harness's schedule: `composer.send`
 * to start Host-native rounds, and `run.cancel` to time the Host-native
 * control response, which A1.2 defines as client send to decoded
 * authoritative reply. This client speaks the local transport
 * (newline-delimited JSON over the Host's 0600 socket) as a `test` client.
 *
 * It never binds as the Desktop actor. Every main-process consumer shares
 * TASKWRAITH_DESKTOP_HOST_ACTOR's one Host session, and a bind that asks for
 * fewer capabilities narrows that session for the whole app until the Host
 * restarts. Asking for any client class but `test` is refused before any I/O.
 * The Host derives the actor from the verified hello (actorId = clientId), so
 * every command carries exactly that actor.
 *
 * TOKEN CONTAINMENT (as hostWelcomeProbe.cjs): the token is read into a local
 * to authenticate the hello frame. It is never returned, logged, or embedded
 * in a result, reason or error. Reasons are bounded codes; frame and file
 * contents are never echoed.
 *
 * Results carry only what timing needs: the command id this client minted,
 * the receipt's status and authority decision, and the elapsed time on a
 * monotonic clock from writing the request to decoding its response. A
 * request that times out may still take effect on the Host, and says so.
 */

const net = require('node:net')
const nodeFs = require('node:fs')
const { randomBytes } = require('node:crypto')

const HOST_COMMAND_CLIENT_CLASS = 'test'
const HOST_COMMAND_CLIENT_CAPABILITIES = Object.freeze(['bootstrap', 'commands', 'receipts'])
/** The commands the harness schedules; anything else is refused locally. */
const HOST_COMMAND_CLIENT_COMMANDS = Object.freeze(['composer.send', 'run.cancel'])
const HOST_RECEIPT_STATUSES = Object.freeze([
  'pending',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'indeterminate',
  'conflict'
])
const HOST_TRANSPORT_ERROR_CODES = Object.freeze([
  'unsupported_transport_version',
  'unknown_frame_kind',
  'unknown_request_kind',
  'invalid_frame',
  'missing_id',
  'oversize_id',
  'invalid_token',
  'invalid_payload',
  'unauthorized',
  'host_unavailable',
  'shutting_down'
])
const DEFAULT_OPEN_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function monotonicNow() {
  return require('node:perf_hooks').performance.now()
}

/** A bounded, content-free reason for a Host error frame. */
function transportErrorReason(frame) {
  const code = isPlainObject(frame.error) ? frame.error.code : undefined
  return HOST_TRANSPORT_ERROR_CODES.includes(code)
    ? `host_request_refused: ${code}`
    : 'host_request_refused: unknown'
}

/** The receipt reduced to what timing needs, or null when it is not a receipt. */
function boundedReceipt(receipt, commandId) {
  if (!isPlainObject(receipt) || receipt.type !== 'host.receipt') return null
  if (receipt.commandId !== commandId) return null
  if (!HOST_RECEIPT_STATUSES.includes(receipt.status)) return null
  const decision = isPlainObject(receipt.authority) ? receipt.authority.decision : undefined
  return {
    commandId,
    status: receipt.status,
    authority: decision === 'allow' || decision === 'deny' || decision === 'ask' ? decision : null
  }
}

/**
 * Open one authenticated `test` connection. Resolves `{ ok: true, client }`
 * or `{ ok: false, reason }`; never rejects.
 *
 * @param {object} options
 * @param {{ socketPath: string, tokenPath: string }} options.discovery a
 *   decoded discovery record (hostWelcomeProbe.cjs waitForHostDiscovery)
 * @param {string} [options.clientClass] must be `test` when given
 * @param {string} [options.clientId] defaults to a fresh random id
 * @param {object} [options.fs] / [options.connect] / [options.nowMs] seams
 * @param {number} [options.timeoutMs] bound on connect + hello + welcome
 * @param {number} [options.requestTimeoutMs] default bound per request
 */
function openHostCommandClient(options = {}) {
  if (options.clientClass !== undefined && options.clientClass !== HOST_COMMAND_CLIENT_CLASS) {
    return Promise.resolve({ ok: false, reason: 'host_client_class_refused' })
  }
  const discovery = options.discovery
  if (
    !isPlainObject(discovery) ||
    typeof discovery.socketPath !== 'string' ||
    discovery.socketPath.length === 0 ||
    typeof discovery.tokenPath !== 'string' ||
    discovery.tokenPath.length === 0
  ) {
    return Promise.resolve({ ok: false, reason: 'host_client_invalid_input' })
  }
  const clientId =
    options.clientId === undefined
      ? `taskwraith-perf-command-client-${randomBytes(6).toString('hex')}`
      : options.clientId
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    return Promise.resolve({ ok: false, reason: 'host_client_invalid_input' })
  }
  const fs = options.fs === undefined ? nodeFs : options.fs
  const connect =
    typeof options.connect === 'function'
      ? options.connect
      : (socketPath) => net.createConnection(socketPath)
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : monotonicNow
  const openTimeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_OPEN_TIMEOUT_MS
  const defaultRequestTimeoutMs =
    Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS

  let token
  try {
    token = String(fs.readFileSync(discovery.tokenPath, 'utf8')).trim()
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'io_error'
    return Promise.resolve({ ok: false, reason: `host_token_unreadable: ${code}` })
  }
  if (!token) return Promise.resolve({ ok: false, reason: 'host_token_empty' })

  return new Promise((resolveOpen) => {
    /** @type {any} */
    let socket = null
    let buffer = ''
    let opened = false
    let closedReason = null
    let requestCounter = 0
    /** request id → { resolve, timer, startedAtMs, kind, commandId?, mutates } */
    const pending = new Map()

    const failOpen = (reason) => {
      if (opened || closedReason !== null) return
      closedReason = reason
      clearTimeout(openTimer)
      destroy()
      resolveOpen({ ok: false, reason })
    }
    const destroy = () => {
      try {
        if (socket && typeof socket.destroy === 'function') socket.destroy()
      } catch {
        /* teardown never replaces an outcome */
      }
    }
    const settleAll = (reason) => {
      for (const [id, entry] of pending) {
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.resolve({
          ok: false,
          reason,
          elapsedMs: Math.max(0, nowMs() - entry.startedAtMs),
          ...(entry.mutates ? { commandId: entry.commandId, effectMayLand: true } : {})
        })
      }
    }
    const closeWith = (reason) => {
      if (!opened) {
        failOpen(reason)
        return
      }
      if (closedReason !== null) return
      closedReason = reason
      destroy()
      settleAll(reason)
    }

    const openTimer = setTimeout(() => failOpen('host_welcome_timeout'), openTimeoutMs)
    try {
      socket = connect(discovery.socketPath)
    } catch {
      failOpen('host_socket_connect_failed')
      return
    }
    if (
      !socket ||
      typeof socket.on !== 'function' ||
      typeof socket.write !== 'function' ||
      typeof socket.destroy !== 'function'
    ) {
      failOpen('host_socket_unavailable')
      return
    }

    const write = (frame) => {
      socket.write(`${JSON.stringify(frame)}\n`)
    }

    function request(kind, params, extra = {}) {
      if (closedReason !== null) {
        return Promise.resolve({ ok: false, reason: closedReason, elapsedMs: 0 })
      }
      requestCounter += 1
      const id = `r${requestCounter}`
      const timeoutMs =
        Number.isFinite(extra.timeoutMs) && extra.timeoutMs > 0
          ? extra.timeoutMs
          : defaultRequestTimeoutMs
      return new Promise((resolve) => {
        const startedAtMs = nowMs()
        const mutates = extra.mutates === true
        const entry = {
          resolve,
          startedAtMs,
          commandId: extra.commandId,
          kind,
          mutates,
          timer: setTimeout(() => {
            if (!pending.delete(id)) return
            resolve({
              ok: false,
              reason: 'host_request_timeout',
              elapsedMs: Math.max(0, nowMs() - startedAtMs),
              // The Host may still admit and run a submitted command.
              ...(mutates ? { commandId: extra.commandId, effectMayLand: true } : {})
            })
          }, timeoutMs)
        }
        pending.set(id, entry)
        try {
          write({ type: 'request', transportVersion: 1, id, kind, params })
        } catch {
          pending.delete(id)
          clearTimeout(entry.timer)
          resolve({ ok: false, reason: 'host_request_write_failed', elapsedMs: 0 })
        }
      })
    }

    function onResponse(frame) {
      if (typeof frame.id !== 'string') return
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      const elapsedMs = Math.max(0, nowMs() - entry.startedAtMs)
      if (frame.ok !== true) {
        entry.resolve({
          ok: false,
          reason: transportErrorReason(frame),
          elapsedMs,
          ...(entry.commandId ? { commandId: entry.commandId } : {})
        })
        return
      }
      const result = isPlainObject(frame.result) ? frame.result : {}
      const receipt =
        result.kind === entry.kind ? boundedReceipt(result.receipt, entry.commandId) : null
      entry.resolve(
        receipt
          ? { ok: true, ...receipt, elapsedMs }
          : { ok: false, reason: 'host_response_invalid', elapsedMs }
      )
    }

    socket.on('error', () => closeWith('host_socket_error'))
    socket.on('close', () => closeWith('host_socket_closed'))
    socket.on('connect', () => {
      try {
        write({
          type: 'hello',
          transportVersion: 1,
          token,
          hello: {
            type: 'host.hello',
            protocolVersion: 2,
            projectionVersion: 2,
            client: {
              clientId,
              clientClass: HOST_COMMAND_CLIENT_CLASS,
              clientVersion: '1.0.0'
            },
            capabilities: [...HOST_COMMAND_CLIENT_CAPABILITIES]
          }
        })
      } catch {
        failOpen('host_hello_write_failed')
      }
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > MAX_FRAME_BUFFER_BYTES) {
        closeWith('host_frame_oversized')
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0 && closedReason === null) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          closeWith('host_frame_malformed')
          return
        }
        if (!isPlainObject(frame)) {
          closeWith('host_frame_malformed')
          return
        }
        if (!opened) {
          if (frame.type === 'welcome') {
            const welcome = isPlainObject(frame.welcome) ? frame.welcome : {}
            const granted = Array.isArray(welcome.capabilities) ? welcome.capabilities : []
            if (!granted.includes('commands') || !granted.includes('receipts')) {
              failOpen('host_commands_not_granted')
              return
            }
            opened = true
            clearTimeout(openTimer)
            resolveOpen({ ok: true, client })
          } else if (frame.type === 'response' && frame.ok === false) {
            failOpen('host_hello_refused')
            return
          }
          continue
        }
        if (frame.type === 'response') onResponse(frame)
        // Events (deltas, health, host.closing) are not this client's concern.
      }
    })

    const client = {
      clientId,
      /**
       * Submit one command and time it to its decoded receipt. `name` must be
       * one the harness schedules; target and arguments go to the Host as
       * given and are validated there.
       */
      submit(spec, submitOptions = {}) {
        if (!isPlainObject(spec) || !HOST_COMMAND_CLIENT_COMMANDS.includes(spec.name)) {
          return Promise.resolve({ ok: false, reason: 'host_command_refused', elapsedMs: 0 })
        }
        if (!isPlainObject(spec.target) || !isPlainObject(spec.arguments ?? {})) {
          return Promise.resolve({ ok: false, reason: 'host_command_refused', elapsedMs: 0 })
        }
        const commandId = `${clientId}-${requestCounter + 1}-${randomBytes(4).toString('hex')}`
        const command = {
          type: 'host.command',
          protocolVersion: 2,
          commandId,
          idempotencyKey: commandId,
          actor: { actorId: clientId, clientId, clientClass: HOST_COMMAND_CLIENT_CLASS },
          name: spec.name,
          target: { ...spec.target },
          arguments: { ...(spec.arguments ?? {}) },
          issuedAt: new Date().toISOString()
        }
        return request('command.submit', command, {
          commandId,
          mutates: true,
          timeoutMs: submitOptions.timeoutMs
        })
      },
      /** Look up a receipt this client submitted, by its command id. */
      lookup(commandId, lookupOptions = {}) {
        if (typeof commandId !== 'string' || !commandId.startsWith(`${clientId}-`)) {
          return Promise.resolve({ ok: false, reason: 'host_lookup_refused', elapsedMs: 0 })
        }
        return request(
          'receipt.lookup',
          { commandId },
          {
            commandId,
            timeoutMs: lookupOptions.timeoutMs
          }
        )
      },
      close() {
        closeWith('host_client_closed')
      }
    }
  })
}

/**
 * The controlActionReplay adapter over an open client: a scheduled `cancel`
 * becomes `run.cancel` on the chat's thread. The profile store keys each
 * Host thread by its app chat id, so the target chat id is the thread id.
 * The replay driver times each action itself; this reports whether the Host
 * accepted it. Actions the client does not send read as unsupported.
 *
 * Not bound here: hostNativeSaturation. Its adapter needs the Host's run
 * admission counts (in flight, queued), and no frame on the local transport
 * carries them, so a live binding waits on a protocol change.
 */
function hostControlActionAdapter(client) {
  return {
    async issueControlAction({ action, target, args }) {
      if (action !== 'cancel') return { unsupported: 'host_command_client_action_unsupported' }
      const expectedWorkId = isPlainObject(args) ? args.expectedWorkId : undefined
      const result = await client.submit({
        name: 'run.cancel',
        target: { threadId: target.chatId },
        arguments: typeof expectedWorkId === 'string' ? { expectedWorkId } : {}
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      return result.status === 'succeeded'
        ? { ok: true }
        : { ok: false, reason: `host_receipt_${result.status}` }
    }
  }
}

module.exports = {
  HOST_COMMAND_CLIENT_CLASS,
  HOST_COMMAND_CLIENT_CAPABILITIES,
  HOST_COMMAND_CLIENT_COMMANDS,
  openHostCommandClient,
  hostControlActionAdapter
}
