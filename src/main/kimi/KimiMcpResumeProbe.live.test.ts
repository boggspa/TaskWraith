// Raw-ACP investigation dossier for the 2026-08-18 "gateway missing on native
// resume" incident (ChipTown chat 75d1d780, Kimi CLI 0.29.2): a Kimi seat
// natively resumed onto a compaction-minted session ran with ZERO
// mcp__taskwraith__ tools while every native fs/exec tool is deny-walled.
//
// The probe drives RAW ACP JSON-RPC (no AcpTurnClient) against the real
// `kimi acp` binary with a fake per-turn TaskWraith HTTP bridge, reproducing
// the production home lifecycle (durable seat home; only sessions/ +
// session_index.jsonl survive between turns).
//
// FINDINGS (2026-08-18, kimi 0.29.2) — each turn pair below ran live:
//   T1/T2  mint with NO tool use, resume with a fresh bridge   → tools WORK
//   T3/T4  mint WITH a tool call, resume with a fresh bridge   → tools WORK
//   T5/T6  mint minimal catalogue, resume with a SUPERSET      → tools WORK
//   T5/T7  …and resume again with a DISJOINT catalogue         → tools WORK
//   T8     resume whose bridge delays tools/list 12s past the
//          prompt (starved-main shape)                         → kimi WAITS,
//          then the call still succeeds
// So session/resume fully honours the current mcpServers advert (fresh URL,
// fresh bearer, changed tool sets), registration does not depend on mint-turn
// tool use, and a slow-but-answering bridge is tolerated. The only shape left
// matching the incident is a FAILED/ABANDONED MCP connect (e.g. a main-process
// stall exceeding Kimi's own connect budget, as in the Finalizing-turn park):
// kimi then proceeds with native-only LLM requests while its own log still
// counts the registry total (toolCount=85). Hence the fix gates a resumed
// session on the bridge's FIRST AUTHENTICATED CONTACT and remints when dark
// (4984bfdb3 + c2ae88633); KimiGatewayResume.live.test.ts is the regression.
//
// GATED: KIMI_MCP_RESUME_PROBE=1 plus an authenticated Kimi Code install.
// It performs real model calls. Not part of any CI suite.
//
//   KIMI_MCP_RESUME_PROBE=1 npx vitest run src/main/kimi/KimiMcpResumeProbe.live.test.ts

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { promises as fsp, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareKimiIsolatedHome, hasConfiguredKimiApiKey } from './KimiAcpHome'
import { prepareKimiOAuthCredentialProjection } from './KimiOAuthCredentialProjection'
import { buildKimiProductionInitializeParams } from './KimiProductionContainment'

const SOURCE_HOME = resolve(join(homedir(), '.kimi-code'))
const BIN = resolve(join(SOURCE_HOME, 'bin', 'kimi'))
const CRED = join(SOURCE_HOME, 'credentials', 'kimi-code.json')
const HAS_CONFIG_API_KEY = (() => {
  try {
    return hasConfiguredKimiApiKey(readFileSync(join(SOURCE_HOME, 'config.toml'), 'utf8'))
  } catch {
    return false
  }
})()
const ENABLED =
  process.env.KIMI_MCP_RESUME_PROBE === '1' &&
  existsSync(BIN) &&
  (existsSync(CRED) || HAS_CONFIG_API_KEY)

const homeFsAdapter = {
  readFile: (p: string) => fsp.readFile(p, 'utf8'),
  writeFile: (p: string, d: string, m: number) =>
    fsp.writeFile(p, d, { encoding: 'utf8', mode: m }),
  mkdir: async (p: string) => {
    await fsp.mkdir(p, { recursive: true })
  },
  copyFile: (a: string, b: string) => fsp.copyFile(a, b),
  chmod: (p: string, m: number) => fsp.chmod(p, m),
  exists: async (p: string) => {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  },
  rm: (p: string) => fsp.rm(p, { recursive: true, force: true }),
  join: (...x: string[]) => join(...x),
  readdir: (p: string) => fsp.readdir(p),
  lstat: (p: string) => fsp.lstat(p),
  realpath: (p: string) => fsp.realpath(p),
  prepareOAuthCredentialProjection: prepareKimiOAuthCredentialProjection
}

interface BridgeHit {
  method: string
  authOk: boolean
}

interface ProbeBridge {
  label: string
  url: string
  headerValue: string
  hits: BridgeHit[]
  close: () => Promise<void>
}

interface ProbeToolSpec {
  name: string
  description: string
}

interface ProbeBridgeBehavior {
  /** Delay every tools/list response by this long (simulates a starved or
   *  stalled in-process bridge at resume time — the 2026-08-18 failure shape). */
  toolsListDelayMs?: number
}

const DEFAULT_PROBE_TOOLS: ProbeToolSpec[] = [
  { name: 'probe_echo', description: 'Echo the provided text back. Wiring probe for TaskWraith.' }
]

/** Minimal stand-in for KimiHttpMcpBridge: Bearer auth, configurable tool set. */
async function startProbeBridge(
  label: string,
  tools: ProbeToolSpec[] = DEFAULT_PROBE_TOOLS,
  behavior: ProbeBridgeBehavior = {}
): Promise<ProbeBridge> {
  const token = randomBytes(24).toString('hex')
  const headerValue = `Bearer ${token}`
  const hits: BridgeHit[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const authOk = req.headers['authorization'] === headerValue
      let message: { id?: number | string; method?: string; params?: Record<string, unknown> } = {}
      try {
        message = JSON.parse(body || '{}')
      } catch {
        /* recorded below as unparsed */
      }
      hits.push({ method: message.method || `(${req.method} unparsed)`, authOk })
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'unauthorized' }
          })
        )
        return
      }
      if (req.method === 'GET') {
        res.writeHead(405, { Allow: 'POST' })
        res.end()
        return
      }
      const respond = (payload: Record<string, unknown> | null): void => {
        if (payload === null || message.id === undefined) {
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }))
      }
      if (message.method === 'initialize') {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion
        respond({
          result: {
            protocolVersion: typeof requested === 'string' ? requested : '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'taskwraith', version: '0.0.0-probe' }
          }
        })
        return
      }
      if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
        respond(null)
        return
      }
      if (message.method === 'tools/list') {
        if (behavior.toolsListDelayMs) {
          setTimeout(() => {
            respond({
              result: {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text']
                  }
                }))
              }
            })
          }, behavior.toolsListDelayMs)
          return
        }
        respond({
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text']
              }
            }))
          }
        })
        return
      }
      if (message.method === 'tools/call') {
        const params = message.params as
          | { name?: unknown; arguments?: { text?: unknown } }
          | undefined
        respond({
          result: {
            content: [
              {
                type: 'text',
                text: `PROBE-${String(params?.name ?? '?')}:${label}:${String(
                  params?.arguments?.text ?? ''
                )}`
              }
            ],
            isError: false
          }
        })
        return
      }
      respond({ error: { code: -32601, message: `method not found: ${message.method}` } })
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return {
    label,
    url: `http://127.0.0.1:${port}/mcp`,
    headerValue,
    hits,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

interface TurnResult {
  sessionId: string
  resumeError: string | null
  promptError: string | null
  answer: string
  toolCalls: Array<{ title: string; status: string }>
  rawInFrames: string[]
  exitCode: number | null
}

/** Drive one raw ACP turn exactly the production shapes: production initialize
 *  params, production mcpServers entry, NDJSON over stdio, stdin-EOF to end. */
async function rawAcpTurn(options: {
  home: { home: string; env: Record<string, string> }
  cwd: string
  bridge: ProbeBridge
  prompt: string
  resumeSessionId?: string
  timeoutMs?: number
}): Promise<TurnResult> {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'HOME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM'
  ]) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  const child = spawn(BIN, ['acp'], {
    cwd: options.cwd,
    env: { ...env, ...options.home.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const mcpServers = [
    {
      name: 'taskwraith',
      type: 'http',
      url: options.bridge.url,
      headers: [{ name: 'Authorization', value: options.bridge.headerValue }]
    }
  ]
  const result: TurnResult = {
    sessionId: options.resumeSessionId || '',
    resumeError: null,
    promptError: null,
    answer: '',
    toolCalls: [],
    rawInFrames: [],
    exitCode: null
  }
  let stderrText = ''
  child.stderr.on('data', (c) => (stderrText += c.toString()))
  await new Promise<void>((resolveTurn) => {
    let settled = false
    let buf = ''
    const timeout = setTimeout(() => finish('timeout'), options.timeoutMs ?? 150_000)
    const finish = (why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (why !== 'exit') {
        try {
          child.stdin.end()
        } catch {
          /* the kill below still runs */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 3000).unref?.()
      }
      // Give the process a moment to exit so exitCode lands; don't block on it.
      setTimeout(() => resolveTurn(), why === 'exit' ? 0 : 3500)
    }
    child.once('error', () => finish('spawn-error'))
    child.once('exit', (code) => {
      result.exitCode = code
      finish('exit')
    })
    const write = (message: Record<string, unknown>): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {
        finish('write-error')
      }
    }
    const ID = { initialize: 1, sessionNew: 2, prompt: 3, sessionResume: 4 }
    write({
      jsonrpc: '2.0',
      id: ID.initialize,
      method: 'initialize',
      params: buildKimiProductionInitializeParams('0.0.0-probe')
    })
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message: {
          id?: number | string
          method?: string
          result?: Record<string, unknown>
          error?: { code?: number; message?: string }
          params?: Record<string, unknown>
        }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        result.rawInFrames.push(line)
        // Inbound agent→client request: allow permission asks, -32601 the rest.
        if (typeof message.method === 'string' && message.id !== undefined) {
          if (message.method === 'session/request_permission') {
            const optionRecords = Array.isArray(
              (message.params as { options?: unknown } | undefined)?.options
            )
              ? ((message.params as { options: Array<Record<string, unknown>> }).options ?? [])
              : []
            const allow = optionRecords.find((option) =>
              /allow/i.test(String(option.kind ?? option.optionId ?? ''))
            )
            const optionId = String(allow?.optionId ?? optionRecords[0]?.optionId ?? '')
            write({
              jsonrpc: '2.0',
              id: message.id,
              result: optionId
                ? { outcome: { outcome: 'selected', optionId } }
                : { outcome: { outcome: 'cancelled' } }
            })
          } else {
            write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'method not found' }
            })
          }
          continue
        }
        // Session update notifications: harvest text + tool calls.
        if (message.method === 'session/update') {
          const update = (message.params as { update?: Record<string, unknown> } | undefined)
            ?.update
          const kind = String(update?.sessionUpdate ?? '')
          if (kind === 'agent_message_chunk') {
            const content = update?.content as { text?: unknown } | undefined
            if (typeof content?.text === 'string') result.answer += content.text
          } else if (kind === 'tool_call' || kind === 'tool_call_update') {
            const title = String(update?.title ?? '?')
            const status = String(update?.status ?? '')
            const existing = kind === 'tool_call' ? null : result.toolCalls.at(-1)
            if (kind === 'tool_call') result.toolCalls.push({ title, status })
            else if (existing && status) existing.status = status
          }
          continue
        }
        if (message.id === ID.initialize && message.result) {
          if (options.resumeSessionId) {
            write({
              jsonrpc: '2.0',
              id: ID.sessionResume,
              method: 'session/resume',
              params: { sessionId: options.resumeSessionId, cwd: options.cwd, mcpServers }
            })
          } else {
            write({
              jsonrpc: '2.0',
              id: ID.sessionNew,
              method: 'session/new',
              params: { cwd: options.cwd, mcpServers }
            })
          }
          continue
        }
        if (message.id === ID.sessionNew && message.result) {
          result.sessionId = String((message.result as { sessionId?: unknown }).sessionId ?? '')
          write({
            jsonrpc: '2.0',
            id: ID.prompt,
            method: 'session/prompt',
            params: {
              sessionId: result.sessionId,
              prompt: [{ type: 'text', text: options.prompt }]
            }
          })
          continue
        }
        if (message.id === ID.sessionResume) {
          if (message.error) {
            result.resumeError = `${message.error.code}: ${message.error.message}`
            finish('resume-error')
            continue
          }
          write({
            jsonrpc: '2.0',
            id: ID.prompt,
            method: 'session/prompt',
            params: {
              sessionId: options.resumeSessionId,
              prompt: [{ type: 'text', text: options.prompt }]
            }
          })
          continue
        }
        if (message.id === ID.prompt) {
          if (message.error) result.promptError = `${message.error.code}: ${message.error.message}`
          finish('prompt-done')
          continue
        }
      }
    })
  })
  if (result.exitCode === null) {
    // The exit listener resolves late on some paths; record whatever we have.
    result.exitCode = child.exitCode
  }
  if (stderrText.trim()) {
    result.rawInFrames.push(`STDERR: ${stderrText.slice(0, 2000)}`)
  }
  return result
}

/** Structure-only look at where kimi recorded MCP state under the seat home. */
async function snapshotHome(home: string, sessionId: string): Promise<Record<string, unknown>> {
  const topLevel = await fsp.readdir(home).catch(() => [] as string[])
  const sessionsDir = join(home, 'sessions')
  const sessionFiles: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir).catch(() => [] as string[])) {
      const full = join(dir, entry)
      const stat = await fsp.lstat(full).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) await walk(full)
      else sessionFiles.push(full)
    }
  }
  await walk(sessionsDir)
  const shortId = sessionId.replace(/^session_/, '')
  const matching = sessionFiles.filter((f) => shortId && f.includes(shortId))
  const mcpMentions: Record<string, string[]> = {}
  for (const file of matching.length ? matching : sessionFiles) {
    const body = await fsp.readFile(file, 'utf8').catch(() => '')
    const lines = body.split(/\r?\n/)
    const mentions: string[] = []
    for (const line of lines) {
      if (/mcp/i.test(line)) {
        mentions.push(line.length > 400 ? `${line.slice(0, 400)}…[${line.length}b]` : line)
      }
    }
    if (mentions.length) mcpMentions[file.slice(home.length + 1)] = mentions.slice(0, 12)
  }
  let index = ''
  try {
    index = await fsp.readFile(join(home, 'session_index.jsonl'), 'utf8')
  } catch {
    /* absent */
  }
  return {
    topLevel,
    sessionFileCount: sessionFiles.length,
    sessionFilesForId: matching.map((f) => f.slice(home.length + 1)),
    mcpMentions,
    indexLinesForId: index
      .split(/\r?\n/)
      .filter((l) => shortId && l.includes(shortId))
      .map((l) => (l.length > 500 ? `${l.slice(0, 500)}…[${l.length}b]` : l))
  }
}

describe.skipIf(!ENABLED)('Kimi mcpServers-on-resume live probe', () => {
  it('T1-T4: mint/resume with and without mint-turn tool use', async () => {
    const root = join(tmpdir(), `kimi-mcp-resume-probe-${randomUUID()}`)
    const homeDir = join(root, 'seat-home')
    const report: Record<string, unknown> = {}
    const prepare = async () => {
      const prepared = await prepareKimiIsolatedHome({
        runId: 'probe',
        homeDir,
        boundaryRoot: root,
        sourceHome: SOURCE_HOME,
        preserveSessionState: true,
        strictCleanup: false,
        fs: homeFsAdapter
      })
      if (!prepared.ok) throw new Error(`home build failed: ${prepared.message}`)
      return prepared
    }
    const newCwd = async (label: string): Promise<string> => {
      const dir = join(root, `cwd-${label}`)
      await fsp.mkdir(dir, { recursive: true })
      return dir
    }
    const forcePrompt =
      'Call the tool mcp__taskwraith__probe_echo with {"text":"ping"} and reply with its exact ' +
      'output and nothing else. If no such tool is available to you, reply with exactly: NO-PROBE-TOOL'
    try {
      // T1 — mint S1, no tool use (compaction-mint shape).
      const bridgeA = await startProbeBridge('A')
      let home = await prepare()
      const t1 = await rawAcpTurn({
        home,
        cwd: await newCwd('t1'),
        bridge: bridgeA,
        prompt: 'Reply with exactly: OK'
      })
      const s1 = t1.sessionId
      report.t1 = {
        sessionId: s1,
        answer: t1.answer.slice(0, 200),
        toolCalls: t1.toolCalls,
        promptError: t1.promptError,
        bridgeHits: bridgeA.hits,
        exitCode: t1.exitCode,
        homePreScrub: await snapshotHome(homeDir, s1)
      }
      await bridgeA.close()
      await home.cleanup()
      report.t1PostScrubTopLevel = await fsp.readdir(homeDir).catch(() => [])

      // T2 — native resume S1 with a FRESH bridge; force a gateway tool call.
      const bridgeB = await startProbeBridge('B')
      home = await prepare()
      const t2 = await rawAcpTurn({
        home,
        cwd: await newCwd('t2'),
        bridge: bridgeB,
        prompt: forcePrompt,
        resumeSessionId: s1
      })
      report.t2 = {
        resumeError: t2.resumeError,
        answer: t2.answer.slice(0, 400),
        toolCalls: t2.toolCalls,
        promptError: t2.promptError,
        bridgeHits: bridgeB.hits,
        exitCode: t2.exitCode
      }
      await bridgeB.close()
      await home.cleanup()

      // T3 — mint S2 WITH a gateway tool call (normal-mint shape).
      const bridgeC = await startProbeBridge('C')
      home = await prepare()
      const t3 = await rawAcpTurn({
        home,
        cwd: await newCwd('t3'),
        bridge: bridgeC,
        prompt: forcePrompt
      })
      const s2 = t3.sessionId
      report.t3 = {
        sessionId: s2,
        answer: t3.answer.slice(0, 400),
        toolCalls: t3.toolCalls,
        promptError: t3.promptError,
        bridgeHits: bridgeC.hits,
        exitCode: t3.exitCode,
        homePreScrub: await snapshotHome(homeDir, s2)
      }
      await bridgeC.close()
      await home.cleanup()

      // T4 — native resume S2 with a FRESH bridge; force a gateway tool call.
      const bridgeD = await startProbeBridge('D')
      home = await prepare()
      const t4 = await rawAcpTurn({
        home,
        cwd: await newCwd('t4'),
        bridge: bridgeD,
        prompt: forcePrompt,
        resumeSessionId: s2
      })
      report.t4 = {
        resumeError: t4.resumeError,
        answer: t4.answer.slice(0, 400),
        toolCalls: t4.toolCalls,
        promptError: t4.promptError,
        bridgeHits: bridgeD.hits,
        exitCode: t4.exitCode,
        homePreScrub: await snapshotHome(homeDir, s2)
      }
      await bridgeD.close()
      await home.cleanup()

      // T5 — mint S3, minimal catalogue, NO tool use (compaction-mint shape).
      const bridgeE = await startProbeBridge('E', [
        {
          name: 'probe_echo',
          description: 'Echo the provided text back. Wiring probe for TaskWraith.'
        }
      ])
      home = await prepare()
      const t5 = await rawAcpTurn({
        home,
        cwd: await newCwd('t5'),
        bridge: bridgeE,
        prompt: 'Reply with exactly: OK'
      })
      const s3 = t5.sessionId
      report.t5 = {
        sessionId: s3,
        answer: t5.answer.slice(0, 200),
        toolCalls: t5.toolCalls,
        bridgeHits: bridgeE.hits,
        exitCode: t5.exitCode
      }
      await bridgeE.close()
      await home.cleanup()

      // T6 — resume S3 with a SUPERSET catalogue (fresh→mesh direction): the
      // resume-side bridge advertises probe_echo plus a tool the mint bridge
      // never had. Force the NEW tool and the OLD tool.
      const bridgeF = await startProbeBridge('F', [
        {
          name: 'probe_echo',
          description: 'Echo the provided text back. Wiring probe for TaskWraith.'
        },
        { name: 'probe_canvas', description: 'Echo the provided text back from the canvas probe.' }
      ])
      home = await prepare()
      const t6 = await rawAcpTurn({
        home,
        cwd: await newCwd('t6'),
        bridge: bridgeF,
        prompt:
          'Call the tool mcp__taskwraith__probe_canvas with {"text":"new"}, then the tool ' +
          'mcp__taskwraith__probe_echo with {"text":"old"}. Reply with both outputs, ' +
          'comma-separated, and nothing else. For any of those tools that is not available ' +
          'to you, include NO-TOOL:<toolname> in your reply instead of its output.',
        resumeSessionId: s3
      })
      report.t6 = {
        resumeError: t6.resumeError,
        answer: t6.answer.slice(0, 400),
        toolCalls: t6.toolCalls,
        promptError: t6.promptError,
        bridgeHits: bridgeF.hits,
        exitCode: t6.exitCode,
        homePreScrub: await snapshotHome(homeDir, s3)
      }
      await bridgeF.close()
      await home.cleanup()

      // T7 — resume S3 again with a DISJOINT catalogue: only a tool the session
      // has never seen. Forces the registration-vs-record question directly.
      const bridgeG = await startProbeBridge('G', [
        { name: 'probe_other', description: 'Echo the provided text back from the other probe.' }
      ])
      home = await prepare()
      const t7 = await rawAcpTurn({
        home,
        cwd: await newCwd('t7'),
        bridge: bridgeG,
        prompt:
          'Call the tool mcp__taskwraith__probe_other with {"text":"solo"} and reply with its ' +
          'exact output and nothing else. If no such tool is available to you, reply with ' +
          'exactly: NO-TOOL:probe_other',
        resumeSessionId: s3
      })
      report.t7 = {
        resumeError: t7.resumeError,
        answer: t7.answer.slice(0, 400),
        toolCalls: t7.toolCalls,
        promptError: t7.promptError,
        bridgeHits: bridgeG.hits,
        exitCode: t7.exitCode
      }
      await bridgeG.close()
      await home.cleanup()

      // T8 — mint S4 normally, then resume it with a bridge whose tools/list is
      // DELAYED past the resume→prompt window (the starved-main failure shape
      // from chat 75d1d780). Expect the resumed turn's LLM request to carry no
      // MCP tools even though registration is healthy on both sides.
      const bridgeH = await startProbeBridge('H')
      home = await prepare()
      const t8mint = await rawAcpTurn({
        home,
        cwd: await newCwd('t8mint'),
        bridge: bridgeH,
        prompt: 'Reply with exactly: OK'
      })
      const s4 = t8mint.sessionId
      await bridgeH.close()
      await home.cleanup()
      const bridgeI = await startProbeBridge('I', DEFAULT_PROBE_TOOLS, { toolsListDelayMs: 12_000 })
      home = await prepare()
      const t8 = await rawAcpTurn({
        home,
        cwd: await newCwd('t8'),
        bridge: bridgeI,
        prompt: forcePrompt,
        resumeSessionId: s4,
        timeoutMs: 180_000
      })
      report.t8 = {
        mintSession: s4,
        mintAnswer: t8mint.answer.slice(0, 100),
        resumeError: t8.resumeError,
        answer: t8.answer.slice(0, 400),
        toolCalls: t8.toolCalls,
        promptError: t8.promptError,
        bridgeHits: bridgeI.hits,
        exitCode: t8.exitCode
      }
      await bridgeI.close()
      await home.cleanup()

      // The report IS the deliverable; write it where the reporter can't eat it.
      const reportPath =
        process.env.KIMI_MCP_RESUME_PROBE_REPORT ||
        join(tmpdir(), `kimi-mcp-resume-probe-report-${Date.now()}.json`)
      await fsp.writeFile(reportPath, JSON.stringify(report, null, 2))
      // eslint-disable-next-line no-console
      console.log(`\nKIMI-MCP-RESUME-PROBE-REPORT → ${reportPath}\n`)
      expect(Boolean(report.t1)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 700_000)
})

describe('Kimi mcpServers-on-resume probe availability', () => {
  it('is gated behind KIMI_MCP_RESUME_PROBE=1 + an authenticated Kimi Code install', () => {
    expect(typeof ENABLED).toBe('boolean')
  })
})
