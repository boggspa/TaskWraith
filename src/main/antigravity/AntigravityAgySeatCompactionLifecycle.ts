/**
 * Sender-free summary turn for an official agy seat.
 *
 * Each chunk runs in a fresh temporary agy project in read-only plan mode. It
 * never resumes or mutates the live seat conversation, never receives API-key
 * credentials, and joins cancellation/timeout before returning to the durable
 * compaction controller.
 */

import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import { join } from 'path'
import { buildAgyReadOnlyPrintArgs, createAgyCliEnv } from './AntigravityCli'

const STDOUT_MAX_CHARS = 64_000
const STDERR_MAX_CHARS = 8_000
const FORCE_KILL_AFTER_MS = 5_000
const CANCELLED_ERROR = 'Compaction was cancelled for history deletion.'
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g')

export interface AntigravityAgySeatSummaryResult {
  ok: boolean
  text: string
  error?: string
  timedOut?: true
}

export interface RunAntigravityAgySeatSummaryInput {
  binaryPath: string
  prompt: string
  model?: string | null
  reasoningEffort?: string | null
  timeoutMs: number
  cancellationSignal?: AbortSignal
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  deps?: {
    spawn?: typeof spawn
    makeTempDir?: () => Promise<string>
    removeTempDir?: (path: string) => Promise<void>
  }
}

function appendBounded(current: string, chunk: unknown, maximum: number): string {
  if (current.length >= maximum) return current
  return `${current}${String(chunk ?? '')}`.slice(0, maximum)
}

function cleanProviderText(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, '').replace(/\r/g, '').trim()
}

function killChild(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The close/error event remains the terminal evidence.
  }
}

export async function runAntigravityAgySeatSummary(
  input: RunAntigravityAgySeatSummaryInput
): Promise<AntigravityAgySeatSummaryResult> {
  const makeTempDir =
    input.deps?.makeTempDir || (() => fs.mkdtemp(join(os.tmpdir(), 'taskwraith-agy-compaction-')))
  const removeTempDir =
    input.deps?.removeTempDir || ((path: string) => fs.rm(path, { recursive: true, force: true }))
  const spawnChild = input.deps?.spawn || spawn
  const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs))
  const tempDir = await makeTempDir()

  try {
    if (input.cancellationSignal?.aborted) {
      return { ok: false, text: '', error: CANCELLED_ERROR }
    }
    const args = buildAgyReadOnlyPrintArgs({
      prompt: input.prompt,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      newProject: true
    })

    let child: ChildProcess
    try {
      child = spawnChild(input.binaryPath, args, {
        cwd: tempDir,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: createAgyCliEnv(input.inheritedEnv)
      })
    } catch (error) {
      return {
        ok: false,
        text: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }

    let stdout = ''
    let stderr = ''
    let spawnError: string | undefined
    let stopKind: 'cancelled' | 'timeout' | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk, STDOUT_MAX_CHARS)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk, STDERR_MAX_CHARS)
    })

    const requestStop = (kind: 'cancelled' | 'timeout'): void => {
      if (stopKind) return
      stopKind = kind
      killChild(child)
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => killChild(child, 'SIGKILL'), FORCE_KILL_AFTER_MS)
        forceKillTimer.unref?.()
      }
    }
    const cancelFromParent = (): void => requestStop('cancelled')
    input.cancellationSignal?.addEventListener('abort', cancelFromParent, { once: true })
    if (input.cancellationSignal?.aborted) cancelFromParent()
    const timeout = setTimeout(() => requestStop('timeout'), timeoutMs)
    timeout.unref?.()

    const code = await new Promise<number | null>((resolve) => {
      let settled = false
      const settle = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        resolve(exitCode)
      }
      child.once('error', (error) => {
        spawnError = error instanceof Error ? error.message : String(error)
        settle(null)
      })
      child.once('close', (exitCode) => settle(exitCode))
    })

    clearTimeout(timeout)
    if (forceKillTimer) clearTimeout(forceKillTimer)
    input.cancellationSignal?.removeEventListener('abort', cancelFromParent)

    if (stopKind === 'cancelled') return { ok: false, text: '', error: CANCELLED_ERROR }
    if (stopKind === 'timeout') {
      return {
        ok: false,
        text: '',
        timedOut: true,
        error: `Summarize turn timed out after ${Math.round(timeoutMs / 1000)}s.`
      }
    }
    const text = cleanProviderText(stdout)
    if (code === 0 && text) return { ok: true, text }
    const diagnostic = cleanProviderText(stderr)
    return {
      ok: false,
      text: '',
      error:
        spawnError ||
        diagnostic ||
        (code === 0
          ? 'Summarize turn returned no text.'
          : `Seat summarize turn failed (exit ${code}).`)
    }
  } finally {
    try {
      await removeTempDir(tempDir)
    } catch {
      // The directory contains only the isolated summary project. Cleanup
      // failure cannot falsify the provider's already-terminal summary result.
    }
  }
}
