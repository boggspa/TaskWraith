import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { createMuseIsolatedHome } from './MuseIsolatedHome'
import { buildMuseTaskWraithMcpSettings } from './MuseMcpConfig'
import {
  buildMuseMspTurnInput,
  museMspApprovalModeFor,
  museMspReasoningEffortFor,
  runMuseMspProvider
} from './MuseMspRun'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-muse-msp-run-'))
afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }))

/** Same injected-spawn seam as the client suite. */
class FakeMspChild implements AcpChildProcess {
  writes: string[] = []
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void
  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    },
    on: (): void => {},
    end: (): void => {}
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = { on: (): void => {} }
  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }
  kill(): void {
    this.closeListener?.(0)
  }
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((cb) => cb(line))
  }
  sent(): Record<string, any>[] {
    return this.writes.map((w) => JSON.parse(w.trim()))
  }
  sentMethod(method: string): Record<string, any> | undefined {
    return this.sent().find((frame) => frame.method === method)
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Play a complete successful turn against whatever the run lane sends. */
async function playTurn(
  child: FakeMspChild,
  options: {
    sessionId?: string
    text?: string
    usage?: Record<string, unknown>
    context?: Record<string, unknown>
    terminal?: string
  } = {}
): Promise<void> {
  const sessionId = options.sessionId ?? 'sess-1'
  await flush()
  child.emit({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'muse', version: '1.0.3' } } })
  await flush()
  child.emit({
    jsonrpc: '2.0',
    id: 2,
    result: { session: { sessionId, turnCount: 0, workspaceRoot: '/ws', modelId: 'm' } }
  })
  await flush()
  child.emit({ jsonrpc: '2.0', id: 3, result: { turnId: 'turn-1', status: 'accepted' } })
  await flush()
  if (options.text) {
    child.emit({
      jsonrpc: '2.0',
      method: 'item/delta',
      params: { sessionId, itemId: 'item-1', delta: options.text }
    })
    await flush()
  }
  if (options.usage) {
    child.emit({ jsonrpc: '2.0', method: 'session/tokenUsage', params: options.usage })
    await flush()
  }
  if (options.context) {
    child.emit({ jsonrpc: '2.0', method: 'session/contextUsage', params: options.context })
    await flush()
  }
  child.emit({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { sessionId, turnId: 'turn-1', status: options.terminal ?? 'completed' }
  })
  await flush()
  child.finish(0)
  await flush()
}

function seat(name: string): { boundaryRoot: string; path: string } {
  const boundaryRoot = join(TEMP_ROOT, `seats-${name}`)
  return { boundaryRoot, path: join(boundaryRoot, `seat-${name}`) }
}

function run(
  child: FakeMspChild,
  overrides: Partial<Parameters<typeof runMuseMspProvider>[0]> = {}
): Promise<Awaited<ReturnType<typeof runMuseMspProvider>>> {
  return runMuseMspProvider({
    binaryPath: '/usr/local/bin/muse',
    workspacePath: TEMP_ROOT,
    prompt: 'hello',
    runId: 'run-1',
    clientVersion: '1',
    spawnMsp: () => child,
    temporaryRoot: TEMP_ROOT,
    ...overrides
  })
}

describe('MSP turn input', () => {
  it('puts the prompt first and maps ACP image fields onto MSP spellings', () => {
    const parts = buildMuseMspTurnInput('describe this', ['/chat/a.png'], () => [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'image', base64Data: 'AAAA', mediaType: 'image/png' }
    ])
  })

  it('sends no image part when the turn has no attachments', () => {
    const load = (): never => {
      throw new Error('image loader must not run for a text-only turn')
    }
    expect(buildMuseMspTurnInput('hi', undefined, load as never)).toEqual([
      { type: 'text', text: 'hi' }
    ])
    expect(buildMuseMspTurnInput('hi', [], load as never)).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('MSP vocabularies', () => {
  it('clamps `max` up to ultra rather than dropping it', () => {
    // `max` is exec-only; sending it would be an invalidParams turn abort.
    expect(museMspReasoningEffortFor('max')).toBe('ultra')
    expect(museMspReasoningEffortFor('high')).toBe('high')
    expect(museMspReasoningEffortFor('minimal')).toBe('minimal')
  })

  it('denies unmatched tools for a read-only seat, whatever the handler', () => {
    expect(museMspApprovalModeFor('plan')).toBe('denyUnmatched')
    expect(museMspApprovalModeFor('')).toBe('denyUnmatched')
    expect(museMspApprovalModeFor(null)).toBe('denyUnmatched')
    expect(museMspApprovalModeFor('plan', true)).toBe('denyUnmatched')
  })

  it('asks per tool only when something can answer', () => {
    // The client denies by default with no handler, so onRequest without one
    // would deny every tool and make a write-capable seat useless.
    expect(museMspApprovalModeFor('default', true)).toBe('onRequest')
    expect(museMspApprovalModeFor('default', false)).toBe('allowAll')
    expect(museMspApprovalModeFor('default')).toBe('allowAll')
  })

  it('selects onRequest from the presence of the handler on the run input', async () => {
    const child = new FakeMspChild()
    const pending = run(child, {
      durableSeat: seat('approvals'),
      approvalMode: 'default',
      onApprovalRequest: () => 'allow'
    })
    await playTurn(child)
    await pending
    expect(child.sentMethod('session/start')?.params.approvalMode).toBe('onRequest')
  })
})

describe('runMuseMspProvider', () => {
  it('reports the provider session id, assistant text and a success terminal', async () => {
    const child = new FakeMspChild()
    const pending = run(child, { durableSeat: seat('outcome') })
    await playTurn(child, { sessionId: 'sess-outcome', text: 'the answer' })
    const outcome = await pending

    expect(outcome.status).toBe('success')
    // Without this the renderer has no id to store, and resume never happens.
    expect(outcome.sessionId).toBe('sess-outcome')
    expect(outcome.assistantText).toContain('the answer')
    expect(outcome.argv[0]).toBe('serve')
  })

  it('folds the shown introduction into the launch prompt like the exec lane', async () => {
    const child = new FakeMspChild()
    const pending = run(child, {
      durableSeat: seat('intro'),
      introductionText: 'I will read the files.'
    })
    await playTurn(child)
    await pending

    const sent = child.sentMethod('turn/start')?.params.input[0].text as string
    // Without this the model repeats the acknowledgment the user already saw,
    // and the two transports answer the same prompt differently.
    expect(sent).toContain('I will read the files.')
    expect(sent).toContain('hello')
  })

  it('sends the prompt byte-for-byte, matching what the exec lane forwards', async () => {
    const child = new FakeMspChild()
    // `runMuseProvider` never trims; a transport that quietly strips
    // surrounding whitespace makes the two lanes send different bytes for the
    // same turn, and a whitespace-only prompt throw where exec would run.
    const pending = run(child, { durableSeat: seat('verbatim'), prompt: '  spaced prompt\n' })
    await playTurn(child)
    await pending

    const sent = child.sentMethod('turn/start')?.params.input[0].text as string
    expect(sent).toContain('  spaced prompt\n')
  })

  it('carries the provider window as the flat totalTokenLimit the meter reads', async () => {
    const child = new FakeMspChild()
    const pending = run(child, { durableSeat: seat('usage') })
    await playTurn(child, {
      usage: { cumulative: { promptTokens: 120, outputTokens: 30, totalTokens: 150 } },
      context: { usedTokens: 150, windowTokens: 987_654 }
    })
    const outcome = await pending

    expect(outcome.providerStats.input_tokens).toBe(120)
    expect(outcome.providerStats.output_tokens).toBe(30)
    expect(outcome.providerStats.totalTokenLimit).toBe(987_654)
    expect(outcome.providerStats._taskwraith_token_count_confidence).toBe('reported')
    // The lane that produced the figures stays visible.
    expect(outcome.providerStats._taskwraith_usage_source).toBe('muse-msp-wire')
  })

  it('marks usage unavailable rather than reporting zeros as measured', async () => {
    const child = new FakeMspChild()
    const pending = run(child, { durableSeat: seat('nousage') })
    await playTurn(child)
    const outcome = await pending

    expect(outcome.providerStats.total_tokens).toBe(0)
    expect(outcome.providerStats._taskwraith_token_count_confidence).toBe('unavailable')
    expect(outcome.providerStats.totalTokenLimit).toBeUndefined()
  })

  it('asks to resume the stored session and keeps the log for the next turn', async () => {
    const target = seat('resume')
    const first = new FakeMspChild()
    const pendingFirst = run(first, { durableSeat: target })
    await playTurn(first, { sessionId: 'sess-keep' })
    const firstOutcome = await pendingFirst
    // Stand in for the log Muse writes during the turn.
    const sessions = join(target.path, 'xdg-data', 'muse', 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'HEAD.json'), '{}')

    const second = new FakeMspChild()
    const pendingSecond = run(second, {
      durableSeat: target,
      resumeSessionId: firstOutcome.sessionId
    })
    await playTurn(second, { sessionId: 'sess-keep' })
    await pendingSecond

    expect(second.sentMethod('session/resume')?.params).toMatchObject({ sessionId: 'sess-keep' })
    expect(second.sentMethod('session/start')).toBeUndefined()
  })

  it('runs the text turn and warns instead of silently dropping an unreadable image', async () => {
    const child = new FakeMspChild()
    const warnings: string[] = []
    const pending = run(child, {
      durableSeat: seat('badimage'),
      imagePaths: ['/nope/missing.png'],
      onWarning: (message) => warnings.push(message),
      loadImages: () => {
        throw new Error('not a readable image')
      }
    })
    await playTurn(child, { text: 'still answered' })
    const outcome = await pending

    expect(outcome.status).toBe('success')
    expect(outcome.assistantText).toContain('still answered')
    expect(warnings.join(' ')).toContain('not a readable image')
    expect(outcome.warnings.join(' ')).toContain('could not attach the images')
    const input = child.sentMethod('turn/start')?.params.input
    expect(input).toHaveLength(1)
    expect(input[0]).toMatchObject({ type: 'text' })
  })

  it('leaves no MCP broker credential in the seat after the turn', async () => {
    const target = seat('broker')
    const child = new FakeMspChild()
    let settingsPath = ''
    const pending = run(child, {
      durableSeat: target,
      createHome: (createInput) => {
        const lease = createMuseIsolatedHome(createInput)
        settingsPath = lease.settingsPath
        return lease
      },
      mcpSettings: buildMuseTaskWraithMcpSettings({
        command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
        args: ['--taskwraith-gemini-mcp-bridge'],
        env: { TASKWRAITH_PARENT_PROVIDER: 'muse', TASKWRAITH_MCP_BROKER_TOKEN: 'run-token' }
      })
    })
    await flush()
    // Pin that the credential was really there before asserting it is gone —
    // otherwise the absence below proves nothing.
    expect(readFileSync(settingsPath, 'utf8')).toContain('run-token')

    await playTurn(child)
    await pending

    expect(existsSync(settingsPath)).toBe(false)
    expect(existsSync(join(target.path, 'xdg-config'))).toBe(false)
  })

  it('projects a BYOK key as auth.json because MSP owns stdin', async () => {
    const target = seat('byok')
    const child = new FakeMspChild()
    let museConfigDir = ''
    const pending = run(child, {
      durableSeat: target,
      apiKey: 'k'.repeat(32),
      createHome: (createInput) => {
        const lease = createMuseIsolatedHome(createInput)
        museConfigDir = lease.museConfigDir
        return lease
      }
    })
    await flush()
    // The exec lane pipes this through `--api-key-stdin`; MSP owns stdin for
    // JSON-RPC, so without the projection a BYOK seat has no credential at all.
    const authPath = join(museConfigDir, 'auth.json')
    expect(JSON.parse(readFileSync(authPath, 'utf8'))).toMatchObject({
      providers: { meta: { api_key: 'k'.repeat(32) } }
    })

    await playTurn(child)
    await pending
    expect(existsSync(authPath)).toBe(false)
  })

  it('reports a cancelled turn as cancelled, not failed', async () => {
    const child = new FakeMspChild()
    let cancel = false
    const pending = run(child, {
      durableSeat: seat('cancel'),
      cancelPollIntervalMs: 1,
      shouldCancel: () => cancel
    })
    await flush()
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await flush()
    child.emit({
      jsonrpc: '2.0',
      id: 2,
      result: { session: { sessionId: 's', turnCount: 0, workspaceRoot: '/ws', modelId: 'm' } }
    })
    await flush()
    cancel = true
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
  })

  it('still runs without a durable seat, against a disposable home', async () => {
    const child = new FakeMspChild()
    const pending = run(child, { createHome: createMuseIsolatedHome })
    await playTurn(child, { text: 'ok' })
    const outcome = await pending
    expect(outcome.status).toBe('success')
    expect(outcome.leasePath).toContain('taskwraith-muse-home-')
  })
})
