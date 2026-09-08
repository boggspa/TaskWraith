[read_file: lines 1-261 of 261]
'use strict'

const { EventEmitter } = require('node:events')
const { StringDecoder } = require('node:string_decoder')
const fs = require('node:fs')
const path = require('node:path')
const { fingerprint } = require('./common.cjs')

/** Newline JSON-RPC client for Codex app-server. Never imports Electron. */
function openAppServer(
  launch,
  { spawn = require('node:child_process').spawn, timeoutMs = 60000 } = {}
) {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })
  const events = new EventEmitter()
  const pending = new Map()
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let nextId = 0
  let dead = false
  let stderrBytes = 0
  let resolveClosed
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })
  const failAll = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
      failAll(new Error('native_frame_limit'))
      child.kill('SIGTERM')
      return
    }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        failAll(new Error('invalid_native_json'))
        continue
      }
      if (message.method) {
        events.emit('notification', message)
        // No native approval/auth request is silently accepted by this client.
        if (message.id !== undefined)
          send({
            id: message.id,
            error: { code: -32601, message: 'proof client does not grant native approval requests' }
          })
      } else if (pending.has(message.id)) {
        const item = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(item.timer)
        if (message.error) {
          const error = new Error(
            'native_rpc_error:' + message.error.code + ':' + String(message.error.message || '')
          )
          error.rpcCode = message.error.code
          item.reject(error)
        } else item.resolve(message.result)
      }
    }
  })
  child.stdin.on('error', failAll)
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
  })
  child.on('error', (error) => {
    failAll(error)
  })
  child.once('close', (code, signal) => {
    dead = true
    failAll(new Error('native_closed'))
    resolveClosed({ code, signal })
    events.emit('closed', { code, signal })
  })
  function request(method, params = {}) {
    if (dead) return Promise.reject(new Error('native_closed'))
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('native_timeout:' + method))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }
  async function stop() {
    if (!dead) child.stdin.end()
    const wait = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        closed.then(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
    if (!dead && !(await wait(1500))) child.kill('SIGTERM')
    if (!dead && !(await wait(1500))) child.kill('SIGKILL')
    if (!dead && !(await wait(1500))) throw new Error('native_death_unproven')
    return closed
  }
  return {
    child,
    events,
    request,
    notify: send,
    stop,
    closed,
    diagnostics: () => ({ pid: child.pid, stderrBytes, dead })
  }
}

/** Parse both MCP newline frames and legacy Content-Length frames unchanged. */
function frameDecoder(onFrame, maxBytes = 16 * 1024 * 1024) {
  let buffered = Buffer.alloc(0)
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > maxBytes) throw new Error('mcp_frame_limit')
    while (buffered.length) {
      let size
      let body
      if (/^Content-Length:/i.test(buffered.subarray(0, 15).toString())) {
        const headerEnd = buffered.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const match = /Content-Length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString())
        const length = Number(match?.[1])
        if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
          throw new Error('invalid_mcp_frame_length')
        size = headerEnd + 4 + length
        if (buffered.length < size) return
        body = buffered.subarray(headerEnd + 4, size)
      } else {
        const newline = buffered.indexOf('\n')
        if (newline === -1) return
        size = newline + 1
        body = buffered.subarray(0, newline)
      }
      const raw = buffered.subarray(0, size)
      buffered = buffered.subarray(size)
      if (!body.toString().trim()) {
        onFrame(null, raw)
        continue
      }
      onFrame(JSON.parse(body.toString('utf8')), raw)
    }
  }
}

function catalogue(tools) {
  const list = Array.isArray(tools) ? tools : Object.values(tools || {})
  return {
    toolsSha256: fingerprint(list.map((tool) => tool.name).sort()),
    schemaSha256: fingerprint(
      list
        .map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema || tool.input_schema || {}
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    ),
    tools: list.map((tool) => ({
      name: tool.name,
      schemaSha256: fingerprint(tool.inputSchema || tool.input_schema || {}),
      readOnly: tool.annotations?.readOnlyHint === true
    }))
  }
}

function readSchemaIndex(root) {
  const schemas = new Map()
  let count = 0
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.json')) {
        if (++count > 10000 || fs.statSync(file).size > 32 * 1024 * 1024)
          throw new Error('schema_limit')
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
        schemas.set(path.basename(file, '.json'), schema)
        for (const [name, value] of Object.entries(schema.definitions || schema.$defs || {}))
          schemas.set(name, value)
      }
    }
  }
  walk(root)
  return schemas
}

function schemaProperties(index, name) {
  let schema = index.get(name)
  const visited = new Set()
  while (schema?.$ref) {
    const ref = schema.$ref.split('/').pop()
    if (visited.has(ref)) return null
    visited.add(ref)
    schema = index.get(ref)
  }
  return schema?.properties || null
}

function methodProperties(index, method, fallbackName) {
  const resolve = (schema) => (schema?.$ref ? index.get(schema.$ref.split('/').pop()) : schema)
  for (const schema of index.values()) {
    for (const variant of [schema, ...(schema.oneOf || schema.anyOf || [])]) {
      const properties = resolve(variant)?.properties
      const name = properties?.method
      if (name?.const === method || name?.enum?.includes(method)) {
        return resolve(properties.params)?.properties || null
      }
    }
  }
  return schemaProperties(index, fallbackName)
}

/** Bind field names to the installed native schema instead of guessing a version. */
function toolCallParams(index, threadId, call) {
  const properties = methodProperties(index, 'mcpServer/tool/call', 'McpServerToolCallParams')
  if (!properties?.threadId) throw new Error('unsupported_native_thread_scoped_tool_call')
  const server = properties.serverName ? 'serverName' : properties.server ? 'server' : null
  const tool = properties.toolName ? 'toolName' : properties.name ? 'name' : null
  const args = properties.arguments ? 'arguments' : properties.args ? 'args' : null
  if (!server || !tool || !args) throw new Error('unsupported_native_tool_call_shape')
  return { threadId, [server]: 'TaskWraith', [tool]: call.name, [args]: call.arguments || {} }
}

module.exports = {
  openAppServer,
  frameDecoder,
  catalogue,
  readSchemaIndex,
  schemaProperties,
  methodProperties,
  toolCallParams
}
