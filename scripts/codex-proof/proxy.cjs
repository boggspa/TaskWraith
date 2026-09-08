[read_file: lines 1-210 of 210]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { frameDecoder, catalogue } = require('./protocol.cjs')
const { fingerprint, collectSecrets, createRedactor } = require('./common.cjs')

function parseProxyArgs(argv) {
  const result = { args: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error('missing proxy argument')
    if (key === '--target-command') result.command = value
    else if (key === '--target-arg') result.args.push(value)
    else if (key === '--argv-tag') result.tag = value
    else throw new Error('unknown proxy argument')
  }
  if (!result.command || !result.tag) throw new Error('proxy target and tag required')
  return result
}

function observedEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        /^TASKWRAITH_(?:MCP_|PROOF_)/.test(key) ||
        [
          'TASKWRAITH_PARENT_PROVIDER',
          'TASKWRAITH_RUN_ID',
          'TASKWRAITH_CHAT_ID',
          'TASKWRAITH_WORKSPACE_PATH'
        ].includes(key)
    )
  )
}

/** Transparent MCP byte relay; metadata only, never raw request/result bodies. */
function runProxy(argv, env = process.env, io = process) {
  const spec = parseProxyArgs(argv)
  const root = fs.realpathSync(env.TASKWRAITH_PROOF_ROOT)
  const eventFile = path.resolve(env.TASKWRAITH_PROOF_EVENT_FILE)
  if (path.dirname(eventFile) !== root || fs.lstatSync(root).isSymbolicLink())
    throw new Error('invalid proof event boundary')
  const eventStat = fs.lstatSync(eventFile)
  if (!eventStat.isFile() || eventStat.isSymbolicLink() || eventStat.nlink !== 1)
    throw new Error('unsafe proof event file')
  const directSecrets = spec.args.flatMap((arg, index) =>
    /token|password|secret/i.test(arg) ? [spec.args[index + 1] || ''] : []
  )
  const redact = createRedactor({
    secrets: [...collectSecrets(env), ...directSecrets],
    paths: [root, env.CODEX_HOME, env.TASKWRAITH_WORKSPACE_PATH, spec.command]
  })
  const child = require('node:child_process').spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })
  const route = { appRunId: env.TASKWRAITH_RUN_ID || '', appChatId: env.TASKWRAITH_CHAT_ID || '' }
  let seq = 0
  let stderrBytes = 0
  let ended = false
  let held = []
  let heldBytes = 0
  const calls = new Map()
  const base = {
    pid: io.pid,
    targetPid: child.pid,
    route,
    seat: env.TASKWRAITH_PROOF_SEAT || '',
    phase: env.TASKWRAITH_PROOF_PHASE || '',
    argvTag: spec.tag
  }
  function log(event) {
    const fd = fs.openSync(
      eventFile,
      fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
    )
    try {
      if (fs.fstatSync(fd).size > 16 * 1024 * 1024) throw new Error('proof_event_limit')
      fs.writeSync(
        fd,
        JSON.stringify(redact({ ...base, seq: ++seq, at: Date.now(), ...event })) + '\n'
      )
    } finally {
      fs.closeSync(fd)
    }
  }
  function holding() {
    const file = env.TASKWRAITH_PROOF_HOLD_FILE
    if (!file || path.dirname(path.resolve(file)) !== root) return false
    try {
      return fs.readFileSync(file, 'utf8') === 'hold'
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  function terminate() {
    if (ended) return
    ended = true
    clearInterval(poll)
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGTERM'), 1000)
    const kill = setTimeout(() => child.kill('SIGKILL'), 2500)
    child.once('close', () => {
      clearTimeout(timer)
      clearTimeout(kill)
    })
    timer.unref()
    kill.unref()
  }
  const incoming = frameDecoder((message, raw) => {
    if (message?.method && message.id !== undefined) {
      calls.set(String(message.id), { method: message.method, tool: message.params?.name })
      if (message.method === 'tools/call')
        log({ kind: 'tool-call', tool: message.params?.name, requestId: String(message.id) })
    }
    child.stdin.write(raw)
  })
  const outgoing = frameDecoder((message, raw) => {
    const request = message?.id !== undefined ? calls.get(String(message.id)) : null
    if (request && !message.method) {
      calls.delete(String(message.id))
      if (request.method === 'tools/list' && Array.isArray(message.result?.tools)) {
        log({ kind: 'catalogue', ...catalogue(message.result.tools) })
      }
      if (request.method === 'tools/call') {
        log({
          kind: 'tool-result',
          tool: request.tool,
          requestId: String(message.id),
          rpcError: message.error?.code || null,
          isError: message.result?.isError === true,
          resultSha256: fingerprint(message.result ?? message.error ?? null)
        })
        if (holding())
          log({ kind: 'response-held', tool: request.tool, requestId: String(message.id) })
      }
    }
    if (held.length || (request?.method === 'tools/call' && holding())) {
      held.push(raw)
      heldBytes += raw.length
      if (heldBytes > 16 * 1024 * 1024) throw new Error('proof_hold_limit')
    } else io.stdout.write(raw)
  })
  const poll = setInterval(() => {
    try {
      if (held.length && !holding()) {
        for (const raw of held) io.stdout.write(raw)
        held = []
        heldBytes = 0
        log({ kind: 'hold-released' })
      }
    } catch {
      terminate()
    }
  }, 20)
  poll.unref()
  log({
    kind: 'spawn',
    envSha256: fingerprint(observedEnvironment(env)),
    targetArgvSha256: fingerprint(spec.args)
  })
  io.stdin.on('data', (chunk) => {
    try {
      incoming(chunk)
    } catch {
      terminate()
    }
  })
  io.stdin.on('end', terminate)
  io.stdin.on('error', terminate)
  io.stdout.on('error', terminate)
  child.stdin.on('error', terminate)
  child.stdout.on('data', (chunk) => {
    try {
      outgoing(chunk)
    } catch {
      terminate()
    }
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
  })
  child.on('error', () => {
    log({ kind: 'target-error' })
    terminate()
  })
  child.on('close', (code, signal) => {
    log({ kind: 'target-closed', code, signal, stderrBytes })
    clearInterval(poll)
    io.stdout.end()
  })
  io.on('SIGTERM', terminate)
  io.on('SIGINT', terminate)
  return { child, terminate }
}

module.exports = { parseProxyArgs, observedEnvironment, runProxy }
if (require.main === module) {
  try {
    runProxy(process.argv.slice(2))
  } catch {
    console.error('proof proxy failed; inspect redacted evidence')
    process.exitCode = 1
  }
}
