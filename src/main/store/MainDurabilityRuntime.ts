import fs from 'node:fs'
import path from 'node:path'
import { MainDurabilityFsyncAdapter } from './MainDurabilityFsyncAdapter'
import { MainDurabilityFlusher, type DurabilityFlusherPorts } from './MainDurabilityFlusher'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import type { RunEventInput, RunEventRecord } from './types'
import type { RunEventLedgerAppendOptions } from './RunEventLedgerWriter'

export interface MainDurabilityRuntimeOptions {
  runEventsDir: string
  runArtifactsDir: string
  /** Exact emitted worker path supplied by composition, never source discovery. */
  workerEntryPath?: string
  env?: Readonly<Record<string, string | undefined>>
  warn?: (message: string) => void
  /** Test seam; production always constructs the Node worker adapter. */
  createAdapter?: (entryPath: string) => DurabilityFlusherPorts & { dispose(): Promise<void> }
}

export interface MainDurabilityRuntime {
  readonly writer: RunEventLedgerWriter
  snapshot(): {
    requested: boolean
    mode: 'legacy' | 'worker' | 'degraded'
    fenced: boolean
    closed: boolean
    failure: string | null
    flusher: ReturnType<MainDurabilityFlusher['snapshot']> | null
    counters: MainDurabilityFlusher['counters'] | null
  }
  /** Call only after final producers have drained. Fences immediately. */
  shutdown(): Promise<void>
}

export function createMainDurabilityRuntime(
  options: MainDurabilityRuntimeOptions
): MainDurabilityRuntime {
  const requested = (options.env ?? process.env).TASKWRAITH_RUN_EVENT_FLUSHER === '1'
  let mode: 'legacy' | 'worker' | 'degraded' = 'legacy'
  let adapter: (DurabilityFlusherPorts & { dispose(): Promise<void> }) | undefined
  let flusher: MainDurabilityFlusher | undefined
  let failure: string | null = null
  if (requested) {
    try {
      const entry = options.workerEntryPath
      if (
        !entry ||
        !path.isAbsolute(entry) ||
        !/\.(?:cjs|mjs|js)$/.test(entry) ||
        !fs.statSync(entry).isFile()
      ) {
        throw new Error('emitted_worker_unavailable')
      }
      adapter = options.createAdapter
        ? options.createAdapter(entry)
        : new MainDurabilityFsyncAdapter({ entryPath: entry })
      flusher = new MainDurabilityFlusher(adapter)
      mode = 'worker'
    } catch {
      mode = 'degraded'
      failure = 'worker_initialization_failed'
      const message =
        'Run-event durability worker unavailable; using legacy synchronous durability.'
      try {
        ;(options.warn ?? console.warn)(message)
      } catch {
        console.warn(message)
      }
    }
  }
  let fenced = false
  let closed = false
  class FencedWriter extends RunEventLedgerWriter {
    override append(
      input: RunEventInput,
      appendOptions?: RunEventLedgerAppendOptions
    ): RunEventRecord {
      if (fenced) throw new Error('Run-event durability runtime is shutting down')
      return super.append(input, appendOptions)
    }
  }
  const writer = new FencedWriter({
    runEventsDir: options.runEventsDir,
    runArtifactsDir: options.runArtifactsDir,
    ...(flusher ? { durabilityFlusher: flusher } : {})
  })
  let shutdown: Promise<void> | undefined
  return {
    writer,
    snapshot: () => ({
      requested,
      mode,
      fenced,
      closed,
      failure,
      flusher: flusher?.snapshot() ?? null,
      counters: flusher ? { ...flusher.counters } : null
    }),
    shutdown: () => {
      fenced = true
      shutdown ??= (async () => {
        try {
          writer.drainDurabilitySync()
          await writer.retire()
          // Retirement closes every ledger and directory fd before worker exit.
          await adapter?.dispose()
          closed = true
          if (failure === 'shutdown_failed') failure = null
        } catch (error) {
          failure = 'shutdown_failed'
          throw error
        }
      })().catch((error) => {
        shutdown = undefined
        throw error
      })
      return shutdown
    }
  }
}
