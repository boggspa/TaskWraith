import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { redactSecrets } from '../../shared/secretRedaction'
import {
  createRunEventRecord,
  RUN_EVENT_EMPTY_HASH,
  safeRunEventFileName,
  serializeRunEventRecord
} from '../RunEventStore'
import { readRunEventLedgerHead } from './RunEventLedgerHead'
import { runEventLedgerAppendPrefix } from './RunEventLedgerTail'
import { RunEventLedgerDescriptorCache } from './RunEventLedgerDescriptorCache'
import type { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'
import type { RunEventArtifactRef, RunEventInput, RunEventRecord } from './types'
import { observeResidual, type ResidualObserver } from './MainDurabilityResiduals'

export interface RunEventLedgerWriterOptions {
  residualObserver?: ResidualObserver
  runEventsDir: string
  runArtifactsDir: string
  durabilityFlusher?: MainDurabilityFlusher
  directoryLeases?: MainDurabilityDirectoryLeases
}

export interface RunEventLedgerAppendOptions {
  durability?: 'batched' | 'strict'
  storeRawEvents?: boolean
}

/**
 * The synchronous, single-owner run-event append boundary. AppStore retains
 * settings and history-deletion authorization; this module owns sequence/hash
 * heads, stream artifacts and the existing file durability protocol together.
 * It imports no Electron or AppStore runtime and can be hosted by a worker once
 * callers support bounded enqueueing and awaited durability. It creates no
 * asynchronous queue and does not change the current flush policy.
 */
export class RunEventLedgerWriter {
  private readonly heads = new Map<string, { sequence: number; hash: string }>()
  private readonly descriptors?: RunEventLedgerDescriptorCache

  constructor(private readonly options: RunEventLedgerWriterOptions) {
    if (options.durabilityFlusher)
      this.descriptors = new RunEventLedgerDescriptorCache(
        options.durabilityFlusher,
        128,
        options.directoryLeases
      )
  }

  async retire(runIds?: readonly string[]): Promise<void> {
    await this.descriptors?.retire(runIds)
    if (runIds) for (const runId of runIds) this.heads.delete(runId)
    else this.heads.clear()
  }

  retireSync(runIds?: readonly string[]): void {
    this.descriptors?.retireSync(runIds)
    if (runIds) for (const runId of runIds) this.heads.delete(runId)
    else this.heads.clear()
  }

  drainDurabilitySync(): void {
    this.descriptors?.drainSync()
  }
  awaitDurable(runId: string): Promise<void> {
    return this.descriptors?.awaitDurable(runId) ?? Promise.resolve()
  }

  /** Forget only cached state; the caller owns deletion and its admission fence. */
  forgetHead(runId: string): void {
    this.heads.delete(runId)
  }

  clearHeads(): void {
    this.heads.clear()
  }

  append(input: RunEventInput, options: RunEventLedgerAppendOptions = {}): RunEventRecord {
    const filePath = path.join(this.options.runEventsDir, safeRunEventFileName(input.runId))
    // Seek a cold ledger's head rather than materializing its potentially large
    // history. Advance the cache only after the write and required barriers.
    const cachedHead = this.heads.get(input.runId)
    const head = cachedHead ?? readRunEventLedgerHead(filePath)
    const sequence = (head?.sequence ?? 0) + 1
    const previousHash = head?.hash || RUN_EVENT_EMPTY_HASH
    const artifacts = options.storeRawEvents
      ? this.appendRunStreamArtifact(input, sequence)
      : undefined
    const record = createRunEventRecord(input, sequence, {
      storeRawPayload: options.storeRawEvents,
      previousHash,
      artifacts
    })
    const directoryPath = path.dirname(filePath)
    if (this.descriptors) {
      try {
        this.descriptors.append(
          input.runId,
          filePath,
          serializeRunEventRecord(record),
          options.durability === 'strict' ? 'sync' : input.kind === 'lifecycle' ? 'prompt' : 'soft'
        )
      } catch (error) {
        this.heads.delete(input.runId)
        throw error
      }
      this.heads.set(input.runId, { sequence: record.sequence, hash: record.hash || previousHash })
      return record
    }
    const directoryExisted = fs.existsSync(directoryPath)
    const fileExisted = fs.existsSync(filePath)
    fs.mkdirSync(directoryPath, { recursive: true })
    if (options.durability === 'strict' && !directoryExisted) {
      fsyncDirectory(path.dirname(directoryPath))
    }
    const fd = fs.openSync(filePath, 'a+')
    try {
      if (!cachedHead) {
        const size = fs.fstatSync(fd).size
        const lastByte = Buffer.allocUnsafe(1)
        if (size > 0 && fs.readSync(fd, lastByte, 0, 1, size - 1) !== 1) {
          throw new Error('Unable to inspect run-event ledger EOF')
        }
        const prefix = runEventLedgerAppendPrefix(size > 0 ? lastByte[0] : undefined)
        if (prefix) fs.writeSync(fd, prefix)
      }
      fs.writeFileSync(fd, serializeRunEventRecord(record), 'utf-8')
      if (options.durability === 'strict' || input.kind === 'lifecycle' || sequence % 25 === 0) {
        if (options.durability === 'strict')
          observeResidual(this.options.residualObserver, 'strictRunEventFsyncs')
        fs.fsyncSync(fd)
      }
    } catch (error) {
      // A failed write may have changed EOF; even a complete line missing only
      // LF must be inspected before the next append and its head re-read.
      this.heads.delete(input.runId)
      throw error
    } finally {
      fs.closeSync(fd)
    }
    try {
      if (options.durability === 'strict' && !fileExisted) fsyncDirectory(directoryPath)
    } catch (error) {
      this.heads.delete(input.runId)
      throw error
    }
    this.heads.set(input.runId, { sequence: record.sequence, hash: record.hash || previousHash })
    return record
  }

  private appendRunStreamArtifact(
    input: RunEventInput,
    sequence: number
  ): RunEventArtifactRef[] | undefined {
    const stream = extractRunStreamText(input)
    if (!stream) return undefined
    const runFileName = safeRunEventFileName(input.runId).replace(/\.jsonl$/, '')
    const artifactRelativePath = path.join(runFileName, `${stream.stream}.log`)
    const artifactPath = path.join(this.options.runArtifactsDir, artifactRelativePath)
    const bytes = Buffer.from(redactSecrets(stream.text), 'utf8')
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.appendFileSync(artifactPath, bytes)
    return [
      {
        id: `${runFileName}:${stream.stream}:${sequence}`,
        kind: stream.stream,
        path: artifactRelativePath.split(path.sep).join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        sequence
      }
    ]
  }
}

function extractRunStreamText(
  input: RunEventInput
): { stream: 'stdout' | 'stderr' | 'stdin'; text: string } | null {
  if (input.kind === 'provider_raw') {
    const payload = input.payload as { data?: unknown } | string | undefined
    const text =
      typeof payload === 'string' ? payload : typeof payload?.data === 'string' ? payload.data : ''
    return text ? { stream: 'stdout', text } : null
  }
  if (input.kind === 'provider_error') {
    const payload = input.payload as { error?: unknown } | string | undefined
    const text =
      typeof payload === 'string'
        ? payload
        : typeof payload?.error === 'string'
          ? payload.error
          : ''
    return text ? { stream: 'stderr', text } : null
  }
  return null
}

function fsyncDirectory(directoryPath: string): void {
  // Preserve the existing Windows directory-handle behavior.
  if (process.platform === 'win32') return
  const fd = fs.openSync(directoryPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
