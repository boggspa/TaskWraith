// Live regression for the August 18 Kimi resume recovery, strengthened to
// require initialize and tools/list responses after session configuration.
// A partial connection must recover with a working catalogue; a healthy resume
// retains its native history; a permanently empty catalogue sends no work.
// Native containment is tested separately and is not attested by this suite.
// Run with KIMI_ACP_LIVE_TRACE=1 and an authenticated Kimi Code install.

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
import {
  buildKimiProductionInitializeParams,
  buildKimiContainedProcessEnv,
  prepareKimiPrivateRunCwd,
  type KimiPrivateCwdFs
} from './KimiProductionContainment'
import type { AcpSessionConfigSelection } from '../acp/AcpTurnClient'
import type { KimiRunCapabilityReceipt } from './KimiRunCapabilities'
import { readKimiProviderToolSnapshot } from './KimiProviderToolSnapshot'

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

const privateCwdFsAdapter: KimiPrivateCwdFs = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true, mode: 0o700 })
  },
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  chmod: (p, mode) => fsp.chmod(p, mode),
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  readdir: (p) => fsp.readdir(p),
  rm: (p) => fsp.rm(p, { recursive: true, force: true })
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
async function startEchoBridge(
  label: string,
  emptyCatalogues: number = 0
): Promise<{
  bridge: KimiHttpMcpBridgeHandle
  toolCalls: Array<{ name: string; text: string }>
}> {
  const toolCalls: Array<{ name: string; text: string }> = []
  let lists = 0
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
        lists += 1
        if (lists <= emptyCatalogues) {
          return { jsonrpc: '2.0', id: id ?? null, result: { tools: [] } }
        }
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
        const call = {
          name: String(params?.name ?? ''),
          text: String(params?.arguments?.text ?? '')
        }
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
  receipts: KimiRunCapabilityReceipt[]
}

/** One real `kimi acp` turn through the production client with full capture. */
async function runLiveTurn(options: {
  home: { home: string; env: Record<string, string> }
  cwd: string
  bridge: KimiHttpMcpBridgeHandle
  prompt: string
  resumeSessionId?: string
  resumeFallbackPrompt?: string
  resumeConfigOptions?: readonly AcpSessionConfigSelection[]
}): Promise<LiveTurnCapture> {
  const startedAt = Date.now()
  const capture: LiveTurnCapture = {
    session: null,
    wirePrompts: [],
    warnings: [],
    answer: '',
    receipts: []
  }
  let handle: ReturnType<typeof runKimiAcpTurn> | null = null
  await new Promise<void>((resolveTurn) => {
    let settled = false
    const timers: {
      cancel?: ReturnType<typeof setTimeout>
      close?: ReturnType<typeof setTimeout>
    } = {}
    const done = (): void => {
      if (settled) return
      settled = true
      if (timers.cancel) clearTimeout(timers.cancel)
      if (timers.close) clearTimeout(timers.close)
      resolveTurn()
    }
    handle = runKimiAcpTurn({
      prompt: options.prompt,
      resumeSessionId: options.resumeSessionId,
      cwdLifetime: 'session',
      resumeFallbackPrompt: options.resumeFallbackPrompt,
      resumeConfigOptions: options.resumeConfigOptions,
      recovery: {
        context: {
          runId: `gateway-live-${startedAt}`,
          workspacePath: options.cwd,
          assignedScope: { kind: 'workspace', paths: [] }
        },
        gateway: options.bridge,
        onReceipt: (receipt) => capture.receipts.push(receipt),
        requiredToolGroups: [['probe_echo']],
        readToolSnapshot: (sessionId) =>
          readKimiProviderToolSnapshot({
            seatHome: options.home.home,
            sessionId,
            runStartedAt: startedAt
          }),
        timeoutMs: PRODUCTION_RESUME_CONTACT_GRACE_MS
      },
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
          env: buildKimiContainedProcessEnv(
            {
              ...kimiSubprocessEnv(options.home.env),
              HOME: options.home.home,
              USERPROFILE: options.home.home
            },
            options.cwd
          )
        }) as never,
      onPermissionRequest: (request) =>
        /^(?:mcp__taskwraith__|TaskWraith__)probe_echo$/i.test(request.toolName) ? 'allow' : 'deny',
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
      handle?.cancel()
      timers.close = setTimeout(done, 2000)
    }, 120_000)
  })
  if (handle) await (handle as ReturnType<typeof runKimiAcpTurn>).closed
  return capture
}

describe.skipIf(!ENABLED)(
  'Kimi gateway-on-resume remint — LIVE regression (gate: KIMI_ACP_LIVE_TRACE=1 + authenticated Kimi Code)',
  () => {
    it('A: recovers an initialized resume with an empty catalogue into working broker tools', async () => {
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
        const mintCwd = await prepareKimiPrivateRunCwd({
          isolatedHome: home.home,
          fs: privateCwdFsAdapter,
          lifetime: 'session'
        })
        const minted = await runLiveTurn({
          home,
          cwd: mintCwd.cwd,
          bridge: mint.bridge,
          prompt: 'Reply with exactly: OK'
        })
        await mint.bridge.close()
        await mintCwd.cleanup()
        await home.cleanup()
        expect(minted.session?.sessionId ?? '').toMatch(/^session_/)
        const mintedSessionId = minted.session!.sessionId

        // Authentication and initialize succeed, but the first tool list is
        // empty. Only the recovered session receives the actual probe tool.
        const recovery =
          'RECOVERY SEED. Call the tool mcp__taskwraith__probe_echo with {"text":"recovered"} ' +
          'and reply with its exact output and nothing else. If no such tool is available to ' +
          'you, reply with exactly: NO-PROBE-TOOL'
        const act = await startEchoBridge('A-act', 1)
        home = await prepare()
        const actCwd = await prepareKimiPrivateRunCwd({
          isolatedHome: home.home,
          fs: privateCwdFsAdapter,
          lifetime: 'session',
          resumeSessionId: mintedSessionId
        })
        expect(actCwd.cwd).toBe(mintCwd.cwd)
        const acted = await runLiveTurn({
          home,
          cwd: actCwd.cwd,
          bridge: act.bridge,
          prompt:
            'SLIM RESUME PROMPT. Call the tool mcp__taskwraith__probe_echo with ' +
            '{"text":"resumed"} and reply with its exact output.',
          resumeSessionId: mintedSessionId,
          resumeFallbackPrompt: recovery
        })
        await act.bridge.close()
        await actCwd.cleanup()
        await home.cleanup()

        // Reminted, not resumed: a fresh session id born from session/new.
        expect(acted.session?.resumed).toBe(false)
        expect(acted.session?.fallbackFromResume).toBe(true)
        expect(acted.session?.sessionId).toMatch(/^session_/)
        expect(acted.session?.sessionId).not.toBe(mintedSessionId)
        // The cold-start recovery prompt rode the wire — not the slim prompt.
        expect(acted.wirePrompts[0]).toContain(recovery)
        expect(acted.wirePrompts[0]).not.toContain('SLIM RESUME PROMPT')
        // A human-readable trace of the remint reached run events.
        expect(acted.warnings.some((warning) => /gateway unavailable/.test(warning))).toBe(true)
        // Decisive for the original incident: the reminted session's gateway
        // surface is ALIVE — the tool call executed against this run's bridge.
        expect(act.toolCalls.some((call) => call.name === 'probe_echo')).toBe(true)
        expect(acted.answer).toContain('PROBE-ECHO:A-act:recovered')
        expect(acted.answer).not.toContain('NO-PROBE-TOOL')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 420_000)

    it('B: retains a healthy resumed session after configuration and verified tool discovery', async () => {
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
        const mintCwd = await prepareKimiPrivateRunCwd({
          isolatedHome: home.home,
          fs: privateCwdFsAdapter,
          lifetime: 'session'
        })
        const minted = await runLiveTurn({
          home,
          cwd: mintCwd.cwd,
          bridge: mint.bridge,
          prompt: 'Reply with exactly: OK'
        })
        await mint.bridge.close()
        await mintCwd.cleanup()
        await home.cleanup()
        expect(minted.session?.sessionId ?? '').toMatch(/^session_/)
        const mintedSessionId = minted.session!.sessionId

        // Verify the catalogue after the thinking selection, preserving the
        // healthy native session and its existing context.
        const act = await startEchoBridge('B-act')
        home = await prepare()
        const actCwd = await prepareKimiPrivateRunCwd({
          isolatedHome: home.home,
          fs: privateCwdFsAdapter,
          lifetime: 'session',
          resumeSessionId: mintedSessionId
        })
        expect(actCwd.cwd).toBe(mintCwd.cwd)
        const acted = await runLiveTurn({
          home,
          cwd: actCwd.cwd,
          bridge: act.bridge,
          prompt:
            'Call the tool mcp__taskwraith__probe_echo with {"text":"resumed"} and reply with ' +
            'its exact output and nothing else. If no such tool is available to you, reply ' +
            'with exactly: NO-PROBE-TOOL',
          resumeSessionId: mintedSessionId,
          resumeFallbackPrompt: 'RECOVERY SEED — must not be used on a healthy resume.',
          resumeConfigOptions: [{ configId: 'thinking', value: 'max' }]
        })
        const contacted = act.bridge.contacted()
        await act.bridge.close()
        await actCwd.cleanup()
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
        expect(
          acted.receipts.some(
            (receipt) =>
              receipt.phase === 'catalogue-served' && receipt.gateway.toolsListResponses > 0
          )
        ).toBe(true)
        expect(
          acted.receipts.some(
            (receipt) =>
              receipt.modelToolVisibility === 'broker-call-observed' ||
              receipt.modelToolVisibility === 'provider-tools-snapshot'
          )
        ).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 420_000)

    it('C: settles a permanently empty catalogue before sending a work prompt', async () => {
      const root = join(tmpdir(), `kimi-gateway-resume-c-${randomUUID()}`)
      const prepared = await prepareKimiIsolatedHome({
        runId: 'live-regression-c',
        homeDir: join(root, 'seat-home'),
        boundaryRoot: root,
        sourceHome: SOURCE_HOME,
        preserveSessionState: true,
        strictCleanup: true,
        fs: homeFsAdapter
      })
      if (!prepared.ok) throw new Error(prepared.message)
      const bridge = await startEchoBridge('C-empty', Number.POSITIVE_INFINITY)
      const cwd = await prepareKimiPrivateRunCwd({
        isolatedHome: prepared.home,
        fs: privateCwdFsAdapter,
        lifetime: 'session'
      })
      try {
        const acted = await runLiveTurn({
          home: prepared,
          cwd: cwd.cwd,
          bridge: bridge.bridge,
          prompt: 'Call the required broker tool before any work.'
        })
        expect(acted.wirePrompts).toEqual([])
        expect(bridge.toolCalls).toEqual([])
        expect(acted.terminalStatus).toBe('taskwraith_blocked')
        expect(acted.receipts.at(-1)).toMatchObject({ outcome: 'blocked', lifecycleSettled: true })
        expect(acted.answer).toContain('lane blocked')
      } finally {
        await bridge.bridge.close()
        await cwd.cleanup()
        await prepared.cleanup()
        rmSync(root, { recursive: true, force: true })
      }
    }, 180_000)
  }
)

// Always-on guard so the file is not an empty suite in ordinary CI.
describe('Kimi gateway-on-resume remint — live regression availability', () => {
  it('is gated behind KIMI_ACP_LIVE_TRACE + an authenticated Kimi Code install', () => {
    expect(typeof ENABLED).toBe('boolean')
  })
})
