// Live regression for the resumed-session gateway remint (c2ae88633 + its
// bridge first-contact groundwork 4984bfdb3), motivated by ChipTown chat
// 75d1d780: a Kimi seat natively resumed onto a compaction-minted session ran
// with ZERO mcp__taskwraith__ tools while every native fs/exec tool is
// deny-walled by design — a Full-WS-Access seat with no usable tools at all.
// Raw-ACP archaeology and probes (KimiMcpResumeProbe.live.test.ts) showed the
// resume mechanics are healthy whenever the bridge answers, so the cure is the
// bridge-contact confirm: a resumed session whose per-run bridge stays dark is
// abandoned and reminted via session/new with the cold-start recovery prompt.
//
// This suite drives the REAL `kimi acp` binary through the REAL runKimiAcpTurn
// client and the REAL startKimiHttpMcpBridge transport, and proves BOTH sides
// of that contract:
//   A. a resume judged gateway-dark is reminted: fresh session, recovery
//      prompt on the wire, a warning a human can read, and — decisive for the
//      original incident — gateway tools that actually work in the turn;
//   B. a healthy resume passes the production 2s first-contact grace and KEEPS
//      its native session (the gate must never cost a healthy seat its
//      history).
//
// GATED exactly like KimiAcpContainment.live.test.ts (real model calls):
//
//   KIMI_ACP_LIVE_TRACE=1 npx vitest run src/main/kimi/KimiGatewayResume.live.test.ts

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { promises as fsp, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareKimiIsolatedHome, hasConfiguredKimiApiKey } from './KimiAcpHome'
import { prepareKimiOAuthCredentialProjection } from './KimiOAuthCredentialProjection'
import { runKimiAcpTurn } from './KimiAcpClient'
import { startKimiHttpMcpBridge, type KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import { buildKimiProductionInitializeParams } from './KimiProductionContainment'

const SOURCE_HOME = resolve(
  process.env.TASKWRAITH_KIMI_CANARY_HOME || join(homedir(), '.kimi-code')
)
const BIN = resolve(process.env.TASKWRAITH_KIMI_CANARY_BIN || join(SOURCE_HOME, 'bin', 'kimi'))
const CRED = join(SOURCE_HOME, 'credentials', 'kimi-code.json')
const HAS_CONFIG_API_KEY = (() => {
  try {
    return hasConfiguredKimiApiKey(readFileSync(join(SOURCE_HOME, 'config.toml'), 'utf8'))
  } catch {
    return false
  }
})()
const ENABLED =
  process.env.KIMI_ACP_LIVE_TRACE === '1' &&
  existsSync(BIN) &&
  (existsSync(CRED) || HAS_CONFIG_API_KEY)

/** Matches the production wiring in index.ts (runKimiAcpProvider). */
const PRODUCTION_RESUME_CONTACT_GRACE_MS = 2_000

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

function kimiSubprocessEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {}
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
    'TERM',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS'
  ]) {
    if (typeof process.env[key] === 'string') selected[key] = process.env[key]
  }
  return { ...selected, ...extra }
}

/** Real HTTP bridge with a stub TaskWraith dispatch exposing one echo tool. */
async function startEchoBridge(label: string): Promise<{
  bridge: KimiHttpMcpBridgeHandle
  toolCalls: Array<{ name: string; text: string }>
}> {
  const toolCalls: Array<{ name: string; text: string }> = []
  const bridge = await startKimiHttpMcpBridge({
    dispatch: async (message) => {
      const id = message.id as number | string | undefined
      if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
        return null
      }
      if (message.method === 'initialize') {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: typeof requested === 'string' ? requested : '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'taskwraith', version: '0.0.0-live-regression' }
          }
        }
      }
      if (message.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            tools: [
              {
                name: 'probe_echo',
                description: 'Echo the provided text back. Wiring probe for TaskWraith.',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text']
                }
              }
            ]
          }
        }
      }
      if (message.method === 'tools/call') {
        const params = message.params as
          | { name?: unknown; arguments?: { text?: unknown } }
          | undefined
        const call = { name: String(params?.name ?? ''), text: String(params?.arguments?.text ?? '') }
        toolCalls.push(call)
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [{ type: 'text', text: `PROBE-ECHO:${label}:${call.text}` }],
            isError: false
          }
        }
      }
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32601, message: `method not found: ${String(message.method)}` }
      }
    }
  })
  return { bridge, toolCalls }
}

interface LiveTurnCapture {
  session: { sessionId: string; resumed: boolean; fallbackFromResume: boolean } | null
  wirePrompts: string[]
  warnings: string[]
  answer: string
  terminalStatus?: string
}

/** One real `kimi acp` turn through the production client with full capture. */
async function runLiveTurn(options: {
  home: { home: string; env: Record<string, string> }
  cwd: string
  bridge: KimiHttpMcpBridgeHandle
  prompt: string
  resumeSessionId?: string
  resumeFallbackPrompt?: string
  confirmResumedSession?: () => Promise<boolean>
}): Promise<LiveTurnCapture> {
  const capture: LiveTurnCapture = { session: null, wirePrompts: [], warnings: [], answer: '' }
  await new Promise<void>((resolveTurn) => {
    let settled = false
    const timers: { cancel?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> } =
      {}
    const done = (): void => {
      if (settled) return
      settled = true
      if (timers.cancel) clearTimeout(timers.cancel)
      if (timers.close) clearTimeout(timers.close)
      resolveTurn()
    }
    const handle = runKimiAcpTurn({
      prompt: options.prompt,
      resumeSessionId: options.resumeSessionId,
      resumeFallbackPrompt: options.resumeFallbackPrompt,
      confirmResumedSession: options.confirmResumedSession,
      cwd: options.cwd,
      initializeParams: buildKimiProductionInitializeParams('0.0.0-live-regression'),
      mcpServers: [
        {
          name: 'taskwraith',
          type: 'http',
          url: options.bridge.url,
          headers: [{ name: options.bridge.headerName, value: options.bridge.headerValue }]
        }
      ],
      spawnProcess: () =>
        spawn(BIN, ['acp'], {
          cwd: options.cwd,
          env: kimiSubprocessEnv(options.home.env)
        }) as never,
      onPermissionRequest: () => 'allow',
      onSessionReady: (session) => {
        capture.session = session
      },
      onWirePrompt: (text) => {
        capture.wirePrompts.push(text)
      },
      onEvent: (event) => {
        if (event.type === 'content' && event.text) capture.answer += event.text
        if (event.type === 'provider_warning' && event.text) capture.warnings.push(event.text)
      },
      onClose: (_code, _turnComplete, terminalStatus) => {
        capture.terminalStatus = terminalStatus
        done()
      }
    })
    timers.cancel = setTimeout(() => {
      handle.cancel()
      timers.close = setTimeout(done, 2000)
    }, 120_000)
  })
  return capture
}

describe.skipIf(!ENABLED)(
  'Kimi gateway-on-resume remint — LIVE regression (gate: KIMI_ACP_LIVE_TRACE=1 + authenticated Kimi Code)',
  () => {
    it('A: remints a resume judged gateway-dark — fresh session, recovery prompt, working gateway tools', async () => {
      const root = join(tmpdir(), `kimi-gateway-resume-a-${randomUUID()}`)
      const homeDir = join(root, 'seat-home')
      const prepare = async () => {
        const prepared = await prepareKimiIsolatedHome({
          runId: 'live-regression-a',
          homeDir,
          boundaryRoot: root,
          sourceHome: SOURCE_HOME,
          preserveSessionState: true,
          strictCleanup: true,
          fs: homeFsAdapter
        })
        if (!prepared.ok) throw new Error(`isolated home build failed: ${prepared.message}`)
        return prepared
      }
      try {
        // Mint a native session with a healthy bridge (no tool use required —
        // the compaction-mint shape from the original incident).
        const mint = await startEchoBridge('A-mint')
        let home = await prepare()
        const mintCwd = join(root, 'cwd-mint')
        await fsp.mkdir(mintCwd, { recursive: true })
        const minted = await runLiveTurn({
          home,
          cwd: mintCwd,
          bridge: mint.bridge,
          prompt: 'Reply with exactly: OK'
        })
        await mint.bridge.close()
        await home.cleanup()
        expect(minted.session?.sessionId ?? '').toMatch(/^session_/)
        const mintedSessionId = minted.session!.sessionId

        // Resume it, with the confirm probe reporting the bridge stayed dark
        // (the judged verdict of waitForContact when Kimi never connects). The
        // fixed client must abandon the resume and remint with the recovery
        // prompt — and the reminted session's gateway tools must WORK.
        const recovery =
          'RECOVERY SEED. Call the tool mcp__taskwraith__probe_echo with {"text":"recovered"} ' +
          'and reply with its exact output and nothing else. If no such tool is available to ' +
          'you, reply with exactly: NO-PROBE-TOOL'
        const act = await startEchoBridge('A-act')
        home = await prepare()
        const actCwd = join(root, 'cwd-act')
        await fsp.mkdir(actCwd, { recursive: true })
        const acted = await runLiveTurn({
          home,
          cwd: actCwd,
          bridge: act.bridge,
          prompt:
            'SLIM RESUME PROMPT. Call the tool mcp__taskwraith__probe_echo with ' +
            '{"text":"resumed"} and reply with its exact output.',
          resumeSessionId: mintedSessionId,
          resumeFallbackPrompt: recovery,
          confirmResumedSession: async () => false
        })
        await act.bridge.close()
        await home.cleanup()

        // Reminted, not resumed: a fresh session id born from session/new.
        expect(acted.session?.resumed).toBe(false)
        expect(acted.session?.fallbackFromResume).toBe(true)
        expect(acted.session?.sessionId).toMatch(/^session_/)
        expect(acted.session?.sessionId).not.toBe(mintedSessionId)
        // The cold-start recovery prompt rode the wire — not the slim prompt.
        expect(acted.wirePrompts[0]).toBe(recovery)
        // A human-readable trace of the remint reached run events.
        expect(
          acted.warnings.some((warning) => /did not confirm its tool surface/.test(warning))
        ).toBe(true)
        // Decisive for the original incident: the reminted session's gateway
        // surface is ALIVE — the tool call executed against this run's bridge.
        expect(act.toolCalls.some((call) => call.name === 'probe_echo')).toBe(true)
        expect(acted.answer).toContain('PROBE-ECHO:A-act:recovered')
        expect(acted.answer).not.toContain('NO-PROBE-TOOL')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 420_000)

    it('B: keeps a healthy resumed session — first bridge contact lands inside the production 2s grace', async () => {
      const root = join(tmpdir(), `kimi-gateway-resume-b-${randomUUID()}`)
      const homeDir = join(root, 'seat-home')
      const prepare = async () => {
        const prepared = await prepareKimiIsolatedHome({
          runId: 'live-regression-b',
          homeDir,
          boundaryRoot: root,
          sourceHome: SOURCE_HOME,
          preserveSessionState: true,
          strictCleanup: true,
          fs: homeFsAdapter
        })
        if (!prepared.ok) throw new Error(`isolated home build failed: ${prepared.message}`)
        return prepared
      }
      try {
        const mint = await startEchoBridge('B-mint')
        let home = await prepare()
        const mintCwd = join(root, 'cwd-mint')
        await fsp.mkdir(mintCwd, { recursive: true })
        const minted = await runLiveTurn({
          home,
          cwd: mintCwd,
          bridge: mint.bridge,
          prompt: 'Reply with exactly: OK'
        })
        await mint.bridge.close()
        await home.cleanup()
        expect(minted.session?.sessionId ?? '').toMatch(/^session_/)
        const mintedSessionId = minted.session!.sessionId

        // Healthy resume wired EXACTLY like production: the confirm probe is
        // the real bridge's waitForContact under the production grace. Kimi
        // registers the advertised server around the resume itself, so the
        // grace must pass without costing the seat its native session.
        const act = await startEchoBridge('B-act')
        home = await prepare()
        const actCwd = join(root, 'cwd-act')
        await fsp.mkdir(actCwd, { recursive: true })
        const acted = await runLiveTurn({
          home,
          cwd: actCwd,
          bridge: act.bridge,
          prompt:
            'Call the tool mcp__taskwraith__probe_echo with {"text":"resumed"} and reply with ' +
            'its exact output and nothing else. If no such tool is available to you, reply ' +
            'with exactly: NO-PROBE-TOOL',
          resumeSessionId: mintedSessionId,
          resumeFallbackPrompt: 'RECOVERY SEED — must not be used on a healthy resume.',
          confirmResumedSession: () =>
            act.bridge.waitForContact(PRODUCTION_RESUME_CONTACT_GRACE_MS)
        })
        const contacted = act.bridge.contacted()
        await act.bridge.close()
        await home.cleanup()

        // The native session survived the gate.
        expect(acted.session?.resumed).toBe(true)
        expect(acted.session?.sessionId).toBe(mintedSessionId)
        expect(acted.session?.fallbackFromResume).toBe(false)
        expect(acted.wirePrompts[0]).not.toContain('RECOVERY SEED')
        expect(
          acted.warnings.some((warning) => /did not confirm its tool surface/.test(warning))
        ).toBe(false)
        // And the resumed session's gateway surface works against THIS run's
        // bridge (fresh port + bearer, honoured on session/resume).
        expect(contacted).toBe(true)
        expect(act.toolCalls.some((call) => call.name === 'probe_echo')).toBe(true)
        expect(acted.answer).toContain('PROBE-ECHO:B-act:resumed')
        expect(acted.answer).not.toContain('NO-PROBE-TOOL')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 420_000)
  }
)

// Always-on guard so the file is not an empty suite in ordinary CI.
describe('Kimi gateway-on-resume remint — live regression availability', () => {
  it('is gated behind KIMI_ACP_LIVE_TRACE + an authenticated Kimi Code install', () => {
    expect(typeof ENABLED).toBe('boolean')
  })
})
