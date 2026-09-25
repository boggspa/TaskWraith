'use strict'

/**
 * Scripted Ollama daemon for M1 live rounds (Independent Threads).
 *
 * A loopback HTTP server answering the subset of the Ollama API that the
 * TaskWraith Ollama adapters call. A harness-materialised profile points
 * `ollamaBaseUrl` at it, so a real Ensemble round runs through the production
 * adapter, orchestrator, flush scheduler and journal with only the model
 * simulated. No credentials are involved: `/api/me` answers signed out and
 * `/api/status` reports Cloud disabled.
 *
 * - Binds 127.0.0.1 only, on an ephemeral port unless told otherwise.
 * - Deterministic for a seed: each model tag keeps a turn counter, and turn N
 *   of a tag always streams the same prose, in fixed-size chunks at a fixed
 *   pace, followed by the terminal `done` chunk.
 * - Records every streamed turn (tag, index, chunk count, bytes, SHA-256 of
 *   the streamed content, outcome) so a report can name exactly what the app
 *   received. Request bodies are never retained. `GET /_scripted/state` gives
 *   the harness live counts, and `GET /_scripted/activity` one tag's turns
 *   over a time range; neither is an Ollama route and neither is counted.
 *
 * Run as a child process with `--config=<json> --ready-file=<json>`; it
 * writes `{ pid, port, baseUrl }` to the ready file once listening, and on
 * SIGTERM/SIGINT closes, ends any open stream as aborted, and writes its turn
 * record to `--summary-file`. With `--exit-on-stdin-close` it does the same
 * when its stdin closes, so a runner that dies cannot leave it behind.
 */

const { createHash } = require('node:crypto')
const { renameSync, writeFileSync, readFileSync } = require('node:fs')
const http = require('node:http')

const { createPrng } = require('./fixtureGenerator.cjs')

const LOOPBACK_HOST = '127.0.0.1'
const SCRIPTED_OLLAMA_VERSION = '0.0.0-taskwraith-scripted'
const SCRIPTED_DIGEST_PREFIX = 'scripted'

const DEFAULT_SHAPE = Object.freeze({ chunksPerTurn: 64, chunkBytes: 32, chunkIntervalMs: 25 })

// Main's Ollama adapter re-prompts a turn it reads as a stub: 400 characters
// or fewer, once trimmed, naming a tool with an action cue
// (`looksLikeOllamaToolIntent`), or at most one output token
// (`isDegenerateOllamaTurn`). A scripted turn can end in one space, so it is
// at least 402 characters and each seat's turn stays one request.
const MIN_TURN_CHARS = 402

const DEFAULT_MODEL = Object.freeze({
  name: 'scripted-llama:latest',
  family: 'llama',
  parameterSize: '8B',
  contextLength: 32768,
  sizeBytes: 4_920_000_000,
  capabilities: Object.freeze(['completion', 'tools'])
})

const FAULTS = new Set(['omit-done'])

const WORDS = Object.freeze(
  (
    'the a an and of to in for with on at by from about into over under after before ' +
    'window round lane seat index journal cursor record thread run chunk batch flush ' +
    'measure sample budget latency queue host main renderer worker persist replay trace ' +
    'steady quiet brief clear exact small large first second third next last same other'
  ).split(' ')
)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function resolveShape(shape) {
  const merged = { ...DEFAULT_SHAPE, ...(shape === undefined ? {} : shape) }
  if (!isPlainObject(merged)) throw new Error('shape must be an object')
  positiveInteger(merged.chunksPerTurn, 'shape.chunksPerTurn')
  positiveInteger(merged.chunkBytes, 'shape.chunkBytes')
  nonNegativeInteger(merged.chunkIntervalMs, 'shape.chunkIntervalMs')
  if (merged.chunksPerTurn * merged.chunkBytes < MIN_TURN_CHARS) {
    throw new Error(
      `a scripted turn (chunksPerTurn x chunkBytes) must be at least ${MIN_TURN_CHARS} characters`
    )
  }
  return Object.freeze({
    chunksPerTurn: merged.chunksPerTurn,
    chunkBytes: merged.chunkBytes,
    chunkIntervalMs: merged.chunkIntervalMs
  })
}

/**
 * One model's turns over [fromMs, toMs): how many started in it, how many of
 * those completed, how long at least one was streaming, and the longest
 * stretch in which none was. A turn still streaming runs until `nowMs`.
 */
function scriptedActivity(turns, model, fromMs, toMs, nowMs) {
  const covered = []
  let started = 0
  let done = 0
  for (const turn of turns) {
    if (turn.model !== model) continue
    if (turn.startedAtMs >= fromMs && turn.startedAtMs < toMs) {
      started += 1
      if (turn.outcome === 'done') done += 1
    }
    const endMs = turn.endedAtMs === null ? nowMs : turn.endedAtMs
    if (turn.startedAtMs < toMs && endMs >= fromMs) {
      covered.push([Math.max(fromMs, turn.startedAtMs), Math.min(toMs, endMs)])
    }
  }
  covered.sort((a, b) => a[0] - b[0])
  let cursor = fromMs
  let busyMs = 0
  let maxQuietMs = 0
  for (const [from, to] of covered) {
    if (from > cursor) maxQuietMs = Math.max(maxQuietMs, from - cursor)
    if (to > cursor) {
      busyMs += to - Math.max(from, cursor)
      cursor = to
    }
  }
  maxQuietMs = Math.max(maxQuietMs, toMs - cursor)
  return { model, fromMs, toMs, started, done, busyMs, maxQuietMs }
}

/** A millisecond query parameter: digits only, or null. */
function msParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null
  return Number(raw)
}

function resolveModels(models) {
  const list = models === undefined ? [DEFAULT_MODEL] : models
  if (!Array.isArray(list) || list.length === 0) throw new Error('models must be a non-empty array')
  const byName = new Map()
  for (const entry of list) {
    const model = { ...DEFAULT_MODEL, ...(isPlainObject(entry) ? entry : {}) }
    if (typeof model.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*:[a-z0-9._-]+$/.test(model.name)) {
      throw new Error(`model name must be a lowercase name:tag, got ${JSON.stringify(entry?.name)}`)
    }
    if (byName.has(model.name)) throw new Error(`model ${model.name} is listed twice`)
    positiveInteger(model.contextLength, `${model.name}.contextLength`)
    positiveInteger(model.sizeBytes, `${model.name}.sizeBytes`)
    if (!Array.isArray(model.capabilities))
      throw new Error(`${model.name}.capabilities must be an array`)
    byName.set(
      model.name,
      Object.freeze({
        ...model,
        capabilities: Object.freeze([...model.capabilities]),
        digest: `${SCRIPTED_DIGEST_PREFIX}-${fnv1a32(model.name).toString(16).padStart(8, '0')}`
      })
    )
  }
  return byName
}

/** Deterministic prose: words from a fixed vocabulary, cut to exact chunk sizes. */
function scriptedTurnChunks({ seed, model, turnIndex, shape }) {
  const rand = createPrng(fnv1a32(`${seed}/${model}/${turnIndex}`))
  const total = shape.chunksPerTurn * shape.chunkBytes
  let text = ''
  let sentenceWords = 0
  while (text.length < total) {
    const word = WORDS[Math.floor(rand() * WORDS.length)]
    sentenceWords += 1
    const endSentence = sentenceWords >= 6 && rand() < 0.2
    text += `${word}${endSentence ? '. ' : ' '}`
    if (endSentence) sentenceWords = 0
  }
  text = text.slice(0, total)
  const chunks = []
  for (let index = 0; index < shape.chunksPerTurn; index += 1) {
    chunks.push(text.slice(index * shape.chunkBytes, (index + 1) * shape.chunkBytes))
  }
  return chunks
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function modelDetails(model) {
  return {
    parent_model: '',
    format: 'gguf',
    family: model.family,
    families: [model.family],
    parameter_size: model.parameterSize,
    quantization_level: 'Q4_K_M'
  }
}

function tagsEntry(model) {
  return {
    name: model.name,
    model: model.name,
    modified_at: '2026-01-01T00:00:00Z',
    size: model.sizeBytes,
    digest: model.digest,
    details: modelDetails(model),
    capabilities: [...model.capabilities]
  }
}

function showBody(model) {
  return {
    license: '',
    modelfile: '',
    parameters: '',
    template: '{{ .Prompt }}',
    details: modelDetails(model),
    model_info: {
      'general.architecture': model.family,
      [`${model.family}.context_length`]: model.contextLength
    },
    capabilities: [...model.capabilities],
    modified_at: '2026-01-01T00:00:00Z'
  }
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length)
  })
  response.end(bytes)
}

function readJsonBody(request, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = []
    let length = 0
    request.on('data', (part) => {
      length += part.length
      if (length > limitBytes) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      parts.push(part)
    })
    request.on('end', () => {
      if (length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    // A connection cut mid-body emits 'error' (ECONNRESET), so close() never
    // waits on a body that will not arrive.
    request.on('error', reject)
  })
}

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * @param {{
 *   seed: number,
 *   models?: object[],
 *   shape?: { chunksPerTurn?: number, chunkBytes?: number, chunkIntervalMs?: number },
 *   host?: string,
 *   fault?: 'omit-done',
 *   now?: () => number
 * }} options
 */
function createScriptedOllamaDaemon(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer')
  const host = options.host === undefined ? LOOPBACK_HOST : options.host
  if (host !== LOOPBACK_HOST) throw new Error(`the scripted daemon binds ${LOOPBACK_HOST} only`)
  if (options.fault !== undefined && !FAULTS.has(options.fault)) {
    throw new Error(`unknown fault ${JSON.stringify(options.fault)}`)
  }
  const seed = options.seed
  const shape = resolveShape(options.shape)
  const models = resolveModels(options.models)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const turnCounters = new Map()
  const loaded = new Set()
  const turns = []
  const requestCounts = {}
  const sockets = new Set()
  const handling = new Set()
  let server = null
  let address = null

  function count(key) {
    requestCounts[key] = (requestCounts[key] || 0) + 1
  }

  function unknownModel(response, name) {
    sendJson(response, 404, { error: `model "${String(name)}" not found, try pulling it first` })
  }

  async function streamChat(request, response, body) {
    const model = models.get(body.model)
    if (!model) return unknownModel(response, body.model)
    const turnIndex = turnCounters.get(model.name) || 0
    turnCounters.set(model.name, turnIndex + 1)
    loaded.add(model.name)
    const chunks = scriptedTurnChunks({ seed, model: model.name, turnIndex, shape })
    const record = {
      model: model.name,
      turnIndex,
      chunks: 0,
      contentBytes: 0,
      sha256: null,
      startedAtMs: now(),
      endedAtMs: null,
      outcome: 'streaming'
    }
    turns.push(record)
    let aborted = false
    response.on('close', () => {
      if (!response.writableFinished) aborted = true
    })
    const createdAt = new Date(record.startedAtMs).toISOString()
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    let streamed = ''
    for (const content of chunks) {
      if (aborted) break
      response.write(
        `${JSON.stringify({
          model: model.name,
          created_at: createdAt,
          message: { role: 'assistant', content },
          done: false
        })}\n`
      )
      streamed += content
      record.chunks += 1
      record.contentBytes += Buffer.byteLength(content, 'utf8')
      await wait(shape.chunkIntervalMs)
    }
    record.sha256 = sha256(streamed)
    record.endedAtMs = now()
    if (aborted) {
      record.outcome = 'aborted'
      return
    }
    if (options.fault === 'omit-done') {
      record.outcome = 'fault-omit-done'
      response.end()
      return
    }
    const elapsedNs = Math.max(1, record.endedAtMs - record.startedAtMs) * 1_000_000
    response.end(
      `${JSON.stringify({
        model: model.name,
        created_at: createdAt,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        total_duration: elapsedNs,
        load_duration: 0,
        prompt_eval_count: Math.max(
          1,
          Math.ceil(Number(request.headers['content-length'] || 0) / 4)
        ),
        prompt_eval_duration: 1_000_000,
        eval_count: Math.max(1, Math.ceil(record.contentBytes / 4)),
        eval_duration: elapsedNs
      })}\n`
    )
    record.outcome = 'done'
  }

  function state() {
    let inFlight = 0
    let turnsDone = 0
    for (const turn of turns) {
      if (turn.outcome === 'streaming') inFlight += 1
      else if (turn.outcome === 'done') turnsDone += 1
    }
    return { inFlight, turnsDone, turnsStarted: turns.length }
  }

  async function handle(request, response) {
    const url = new URL(request.url || '/', `http://${LOOPBACK_HOST}`)
    const route = `${request.method} ${url.pathname}`
    if (route === 'GET /_scripted/state') return sendJson(response, 200, state())
    if (route === 'GET /_scripted/activity') {
      const model = url.searchParams.get('model')
      const fromMs = msParam(url, 'from')
      const toMs = msParam(url, 'to')
      if (!models.has(model)) return unknownModel(response, model)
      if (fromMs === null || toMs === null || toMs <= fromMs) {
        return sendJson(response, 400, { error: 'from and to must be milliseconds, from < to' })
      }
      // A range still open would count the time not yet elapsed as quiet.
      const nowMs = now()
      if (toMs > nowMs) return sendJson(response, 400, { error: 'to must not be in the future' })
      return sendJson(response, 200, scriptedActivity(turns, model, fromMs, toMs, nowMs))
    }
    count(route)
    switch (route) {
      case 'GET /api/version':
        return sendJson(response, 200, { version: SCRIPTED_OLLAMA_VERSION })
      case 'GET /api/tags':
        return sendJson(response, 200, { models: [...models.values()].map(tagsEntry) })
      case 'GET /api/ps':
        return sendJson(response, 200, {
          models: [...loaded].map((name) => {
            const model = models.get(name)
            return {
              ...tagsEntry(model),
              expires_at: '2099-01-01T00:00:00Z',
              size_vram: model.sizeBytes
            }
          })
        })
      case 'GET /api/status':
        return sendJson(response, 200, { cloud: { disabled: true, source: 'config' } })
      case 'POST /api/me':
        return sendJson(response, 401, { error: 'unauthorized' })
      case 'POST /api/show': {
        const body = await readJsonBody(request)
        const model = models.get(body.model || body.name)
        return model ? sendJson(response, 200, showBody(model)) : unknownModel(response, body.model)
      }
      case 'POST /api/chat': {
        const body = await readJsonBody(request)
        if (body.stream === false) {
          return sendJson(response, 400, { error: 'the scripted daemon streams chat only' })
        }
        return streamChat(request, response, body)
      }
      case 'POST /api/generate': {
        const body = await readJsonBody(request)
        const model = models.get(body.model)
        if (!model) return unknownModel(response, body.model)
        if (body.keep_alive === 0 || body.keep_alive === '0') loaded.delete(model.name)
        return sendJson(response, 200, {
          model: model.name,
          created_at: new Date(now()).toISOString(),
          response: '',
          done: true,
          done_reason: 'unload'
        })
      }
      default:
        return sendJson(response, 404, { error: `no route ${route}` })
    }
  }

  return {
    async listen(port = 0) {
      if (server) throw new Error('already listening')
      nonNegativeInteger(port, 'port')
      server = http.createServer((request, response) => {
        const handled = handle(request, response).catch((error) => {
          if (!response.headersSent)
            sendJson(response, 500, { error: String(error?.message || error) })
          else response.destroy()
        })
        handling.add(handled)
        void handled.finally(() => handling.delete(handled))
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, LOOPBACK_HOST, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const bound = server.address()
      address = { port: bound.port, baseUrl: `http://${LOOPBACK_HOST}:${bound.port}` }
      return { ...address }
    },
    /**
     * Stop listening and cut every connection. An open stream sees its socket
     * close within one chunk interval and records its turn as aborted, with
     * the hash of what it sent, before this resolves.
     */
    async close() {
      if (!server) return
      const closing = new Promise((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closing
      await Promise.allSettled([...handling])
      server = null
    },
    state,
    address() {
      return address ? { ...address } : null
    },
    turns() {
      return turns.map((turn) => ({ ...turn }))
    },
    requestCounts() {
      return { ...requestCounts }
    },
    models() {
      return [...models.values()].map((model) => ({ name: model.name, digest: model.digest }))
    }
  }
}

function summary(daemon) {
  return {
    schemaVersion: 1,
    version: SCRIPTED_OLLAMA_VERSION,
    models: daemon.models(),
    requestCounts: daemon.requestCounts(),
    turns: daemon.turns()
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function parseCliArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (arg === '--exit-on-stdin-close') {
      out.exitOnStdinClose = true
      continue
    }
    const match = /^--(config|ready-file|summary-file)=(.+)$/.exec(arg)
    if (!match) throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    out[match[1]] = match[2]
  }
  if (!out.config || !out['ready-file']) throw new Error('--config and --ready-file are required')
  return out
}

async function main(argv) {
  const args = parseCliArgs(argv)
  const config = JSON.parse(readFileSync(args.config, 'utf8'))
  const daemon = createScriptedOllamaDaemon(config)
  const bound = await daemon.listen(config.port === undefined ? 0 : config.port)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await daemon.close()
    if (args['summary-file']) writeJsonAtomic(args['summary-file'], summary(daemon))
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  if (args.exitOnStdinClose) {
    process.stdin.on('end', stop)
    process.stdin.on('close', stop)
    process.stdin.resume()
  }
  writeJsonAtomic(args['ready-file'], { pid: process.pid, ...bound })
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`scripted-ollama-daemon: ${error?.message || error}\n`)
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_SHAPE,
  LOOPBACK_HOST,
  MIN_TURN_CHARS,
  SCRIPTED_OLLAMA_VERSION,
  createScriptedOllamaDaemon,
  scriptedActivity,
  scriptedTurnChunks,
  summary
}
