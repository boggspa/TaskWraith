import fs from 'node:fs'
import path from 'node:path'
import { MainDurabilityFsyncAdapter } from './MainDurabilityFsyncAdapter'
import { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'
import { MainDurabilityFlusher, type DurabilityFlusherPorts } from './MainDurabilityFlusher'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import type { RunEventInput, RunEventRecord } from './types'
import type { RunEventLedgerAppendOptions } from './RunEventLedgerWriter'

export type JournalDurabilityFlusher = Pick<
  MainDurabilityFlusher,
  | 'open'
  | 'noteWrite'
  | 'awaitDurable'
  | 'forget'
  | 'forgetSync'
  | 'drainSync'
  | 'transferDependencies'
>

export interface DurabilityParticipant {
  fence(): void
  drainSync(): void
  retire(): Promise<void>
}

export interface DurabilityAttachmentPorts {
  flusher: JournalDurabilityFlusher
  directoryLeases: Pick<MainDurabilityDirectoryLeases, 'acquire'>
}

export interface DurabilityConsumerSnapshot {
  requested: boolean
  mode: 'legacy' | 'worker' | 'degraded'
}

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
  attachJournal(create: (ports: DurabilityAttachmentPorts) => DurabilityParticipant): boolean
  attachCatalogue(create: (ports: DurabilityAttachmentPorts) => DurabilityParticipant): boolean
  snapshot(): {
    requested: boolean
    mode: 'legacy' | 'worker' | 'degraded'
    runEvents: DurabilityConsumerSnapshot
    journal: DurabilityConsumerSnapshot & { attached: boolean }
    catalogue: DurabilityConsumerSnapshot & { attached: boolean }
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
  const env = options.env ?? process.env
  const requested = env.TASKWRAITH_RUN_EVENT_FLUSHER === '1'
  const journalRequested = env.TASKWRAITH_JOURNAL_FLUSHER === '1'
  const catalogueRequested = env.TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY === '1'
  let mode: 'legacy' | 'worker' | 'degraded' = 'legacy'
  let adapter: (DurabilityFlusherPorts & { dispose(): Promise<void> }) | undefined
  let flusher: MainDurabilityFlusher | undefined
  let directoryLeases: MainDurabilityDirectoryLeases | undefined
  let failure: string | null = null
  if (requested || journalRequested || catalogueRequested) {
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
      directoryLeases = new MainDurabilityDirectoryLeases(flusher)
      mode = 'worker'
    } catch {
      mode = 'degraded'
      failure = 'worker_initialization_failed'
      const message =
        'Main durability worker unavailable; requested consumers use legacy synchronous durability.'
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
    ...(requested && flusher ? { durabilityFlusher: flusher, directoryLeases } : {})
  })
  let journal: DurabilityParticipant | undefined
  let catalogue: DurabilityParticipant | undefined
  let constructing = false
  const consumer = (enabled: boolean): DurabilityConsumerSnapshot => ({
    requested: enabled,
    mode: enabled ? mode : 'legacy'
  })
  let shutdown: Promise<void> | undefined
  const attach = (
    kind: 'journal' | 'catalogue',
    create: (ports: DurabilityAttachmentPorts) => DurabilityParticipant
  ): boolean => {
    if (fenced) throw new Error('Main durability runtime is shutting down')
    if (
      !(kind === 'journal' ? journalRequested : catalogueRequested) ||
      !flusher ||
      !directoryLeases
    )
      return false
    if (constructing) throw new Error('Durability participant construction is already active')
    if (kind === 'journal' ? journal : catalogue)
      throw new Error('Durability participant already attached')
    let enabled = false
    const guarded = <T extends object>(target: T): T =>
      new Proxy(target, {
        get: (owner, key) => {
          const member = Reflect.get(owner, key)
          if (typeof member !== 'function') return member
          return (...args: unknown[]) => {
            if (!enabled) throw new Error('Journal construction must be resource-free')
            return Reflect.apply(member, owner, args)
          }
        }
      })
    constructing = true
    let participant: DurabilityParticipant
    try {
      participant = create({
        flusher: guarded(flusher),
        directoryLeases: guarded(directoryLeases)
      })
      if (
        !participant ||
        typeof participant.fence !== 'function' ||
        typeof participant.drainSync !== 'function' ||
        typeof participant.retire !== 'function'
      )
        throw new Error('Invalid journal durability participant')
      if (fenced) throw new Error('Main durability runtime is shutting down')
    } finally {
      constructing = false
    }
    if (kind === 'journal') journal = participant
    else catalogue = participant
    enabled = true
    return true
  }
  return {
    writer,
    attachJournal: (create) => attach('journal', create),
    attachCatalogue: (create) => attach('catalogue', create),
    snapshot: () => ({
      requested,
      mode: consumer(requested).mode,
      runEvents: consumer(requested),
      journal: { ...consumer(journalRequested), attached: journal !== undefined },
      catalogue: { ...consumer(catalogueRequested), attached: catalogue !== undefined },
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
          journal?.fence()
          catalogue?.fence()
          writer.drainDurabilitySync()
          journal?.drainSync()
          catalogue?.drainSync()
          await writer.retire()
          await journal?.retire()
          await catalogue?.retire()
          await directoryLeases?.retire()
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
