import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../store/types'
import {
  convergeHostSeatCompaction,
  hostSeatCompactionRequestSucceeded
} from '../HostSeatCompactionConvergence'
import {
  resetAntigravityAgyOptInEnabledProbeForTests,
  setAntigravityAgyOptInEnabledProbe
} from './AntigravityAgyOptInEnabledSignal'
import {
  runAntigravityAgySeatSummary,
  type RunAntigravityAgySeatSummaryInput
} from './AntigravityAgySeatCompactionLifecycle'

const CONSENT_WITHDRAWN =
  'AntiGravity is disabled until the user enables it and records informed risk acceptance in Settings → Providers. This summary step was not started.'

// The live consent read main wires from persisted settings; each case flips it
// to model the user withdrawing consent in Settings.
let consentHeld = true

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}

function dependencies(
  child: ReturnType<typeof fakeChild>,
  removeTempDir = vi.fn(async () => undefined)
): NonNullable<RunAntigravityAgySeatSummaryInput['deps']> {
  return {
    spawn: vi.fn(() => child) as unknown as NonNullable<
      RunAntigravityAgySeatSummaryInput['deps']
    >['spawn'],
    makeTempDir: vi.fn(async () => '/tmp/agy-summary-project'),
    removeTempDir
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  consentHeld = true
  setAntigravityAgyOptInEnabledProbe(() => consentHeld)
})

afterEach(() => {
  vi.useRealTimers()
  resetAntigravityAgyOptInEnabledProbeForTests()
})

describe('runAntigravityAgySeatSummary', () => {
  it('runs an official read-only agy turn in a fresh temporary project', async () => {
    const child = fakeChild()
    const removeTempDir = vi.fn(async () => undefined)
    const deps = dependencies(child, removeTempDir)
    const result = runAntigravityAgySeatSummary({
      binaryPath: '/usr/local/bin/agy',
      prompt: 'Summarize this bounded material.',
      model: 'gemini-3.1-pro-high',
      reasoningEffort: 'high',
      timeoutMs: 10_000,
      inheritedEnv: {
        PATH: '/usr/bin',
        GEMINI_API_KEY: 'must-not-cross',
        SAFE_VALUE: 'kept'
      },
      deps
    })
    await flush()

    expect(deps.spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = vi.mocked(deps.spawn!).mock.calls[0]
    // @portability-ok: verifies an opaque caller-supplied agy executable path
    // is preserved byte-for-byte; the runtime does not invent this path.
    expect(command).toBe('/usr/local/bin/agy')
    expect(args).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--mode',
        'plan',
        '--new-project',
        '--model',
        'gemini-3.1-pro-high',
        '--effort',
        'high',
        '-p',
        'Summarize this bounded material.'
      ])
    )
    expect(options).toMatchObject({
      cwd: '/tmp/agy-summary-project',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin', SAFE_VALUE: 'kept' }
    })

    child.stdout.write('  durable summary  ')
    child.emit('close', 0)
    await expect(result).resolves.toEqual({ ok: true, text: 'durable summary' })
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/agy-summary-project')
  })

  it('joins history-deletion cancellation before returning', async () => {
    const child = fakeChild()
    const cancellation = new AbortController()
    const result = runAntigravityAgySeatSummary({
      binaryPath: '/usr/local/bin/agy',
      prompt: 'Summarize.',
      timeoutMs: 10_000,
      cancellationSignal: cancellation.signal,
      deps: dependencies(child)
    })
    await flush()

    cancellation.abort('history-deletion')
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close', null)
    await expect(result).resolves.toEqual({
      ok: false,
      text: '',
      error: 'Compaction was cancelled for history deletion.'
    })
  })

  it('kills and joins a timed-out summary process', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const result = runAntigravityAgySeatSummary({
      binaryPath: '/usr/local/bin/agy',
      prompt: 'Summarize.',
      timeoutMs: 2_000,
      deps: dependencies(child)
    })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close', null)
    await expect(result).resolves.toEqual({
      ok: false,
      text: '',
      timedOut: true,
      error: 'Summarize turn timed out after 2s.'
    })
  })

  it('returns bounded stderr when the native turn fails', async () => {
    const child = fakeChild()
    const result = runAntigravityAgySeatSummary({
      binaryPath: '/usr/local/bin/agy',
      prompt: 'Summarize.',
      timeoutMs: 10_000,
      deps: dependencies(child)
    })
    await flush()

    child.stderr.write('Authentication required')
    child.emit('close', 2)
    await expect(result).resolves.toEqual({
      ok: false,
      text: '',
      error: 'Authentication required'
    })
  })
})

describe('consent withdrawn during a seat compaction', () => {
  it('reads consent after the temporary project is made: a withdrawal inside that wait starts nothing', async () => {
    const child = fakeChild()
    const removeTempDir = vi.fn(async () => undefined)
    let releaseTempDir!: (path: string) => void
    const deps = {
      ...dependencies(child, removeTempDir),
      makeTempDir: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseTempDir = resolve
          })
      )
    }
    const result = runAntigravityAgySeatSummary({
      binaryPath: '/usr/local/bin/agy',
      prompt: 'Summarize.',
      timeoutMs: 10_000,
      deps
    })
    await flush()
    expect(deps.makeTempDir).toHaveBeenCalledTimes(1)

    consentHeld = false
    releaseTempDir('/tmp/agy-summary-project')
    await flush()

    expect(deps.spawn).not.toHaveBeenCalled()
    await expect(result).resolves.toEqual({ ok: false, text: '', error: CONSENT_WITHDRAWN })
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/agy-summary-project')
  })

  // Block new work, let in-flight work finish (Chris, 2026-09-23): the step
  // already running is never killed for a withdrawal, the next step never
  // starts, and the sequence settles with its saved progress and the reason.
  function twoChunkSnapshot(): ChatMessage[] {
    return (['user', 'assistant', 'user', 'assistant'] as const).map((role, index) => ({
      id: `m${index + 1}`,
      role,
      content: `${role} turn ${index + 1}`,
      timestamp: '2026-09-23T12:00:00.000Z'
    }))
  }

  async function compactTwoChunks(onFirstSpawn: (child: ReturnType<typeof fakeChild>) => void) {
    const children: Array<ReturnType<typeof fakeChild>> = []
    const spawn = vi.fn(() => {
      const child = fakeChild()
      children.push(child)
      if (children.length === 1) onFirstSpawn(child)
      else
        setTimeout(() => {
          child.stdout.write('second summary')
          child.emit('close', 0)
        })
      return child
    })
    const checkpoint = vi.fn(() => ({ ok: true }))
    const result = await convergeHostSeatCompaction({
      provider: 'antigravity',
      snapshotMessages: twoChunkSnapshot(),
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-09-23T12:00:00.000Z',
      summarize: ({ prompt, timeoutMs }) =>
        runAntigravityAgySeatSummary({
          binaryPath: '/usr/local/bin/agy',
          prompt,
          timeoutMs,
          deps: {
            spawn: spawn as unknown as NonNullable<
              RunAntigravityAgySeatSummaryInput['deps']
            >['spawn'],
            makeTempDir: async () => '/tmp/agy-summary-project',
            removeTempDir: async () => undefined
          }
        }),
      checkpoint,
      chunkTurns: 1,
      chunkBudget: { maxTurns: 1, maxCharsPerTurn: 100, maxBlockChars: 1_000 }
    })
    return { result, spawn, children, checkpoint }
  }

  it('lets the running step finish, never starts the next one, and settles with the saved progress', async () => {
    const { result, spawn, children, checkpoint } = await compactTwoChunks((first) => {
      setTimeout(() => {
        // Withdrawn while the first summary is running.
        consentHeld = false
        setTimeout(() => {
          first.stdout.write('first summary')
          first.emit('close', 0)
        })
      })
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      checkpointCount: 1,
      coverageComplete: false,
      stopReason: 'summarizer_failed',
      error: CONSENT_WITHDRAWN,
      finalSummary: { text: 'first summary' }
    })
    // The first step's checkpoint is kept, so the request reports its progress.
    expect(hostSeatCompactionRequestSucceeded(result)).toBe(true)
  })

  it('control: with consent held throughout, both steps run', async () => {
    const { result, spawn } = await compactTwoChunks((first) => {
      setTimeout(() => {
        first.stdout.write('first summary')
        first.emit('close', 0)
      })
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ checkpointCount: 2, stopReason: 'complete' })
  })

  it('settles as a failed request naming the reason when no step had run yet', async () => {
    consentHeld = false
    // A step that did start would finish normally, so a spawn here shows up as
    // a completed compaction rather than a hang.
    const spawn = vi.fn(() => {
      const child = fakeChild()
      setTimeout(() => {
        child.stdout.write('summary')
        child.emit('close', 0)
      })
      return child
    })
    const result = await convergeHostSeatCompaction({
      provider: 'antigravity',
      snapshotMessages: twoChunkSnapshot(),
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-09-23T12:00:00.000Z',
      summarize: ({ prompt, timeoutMs }) =>
        runAntigravityAgySeatSummary({
          binaryPath: '/usr/local/bin/agy',
          prompt,
          timeoutMs,
          deps: {
            spawn: spawn as unknown as NonNullable<
              RunAntigravityAgySeatSummaryInput['deps']
            >['spawn'],
            makeTempDir: async () => '/tmp/agy-summary-project',
            removeTempDir: async () => undefined
          }
        }),
      checkpoint: () => ({ ok: true }),
      chunkTurns: 1,
      chunkBudget: { maxTurns: 1, maxCharsPerTurn: 100, maxBlockChars: 1_000 }
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      checkpointCount: 0,
      stopReason: 'summarizer_failed',
      error: CONSENT_WITHDRAWN
    })
    expect(hostSeatCompactionRequestSucceeded(result)).toBe(false)
  })
})
