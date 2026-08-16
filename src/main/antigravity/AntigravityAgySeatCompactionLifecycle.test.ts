import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runAntigravityAgySeatSummary,
  type RunAntigravityAgySeatSummaryInput
} from './AntigravityAgySeatCompactionLifecycle'

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

afterEach(() => {
  vi.useRealTimers()
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
