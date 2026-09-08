import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { RunEventRecord } from '../store/types'
import {
  latestKimiRunCapabilityReceipt,
  type KimiRunCapabilityReceipt
} from './KimiRunCapabilities'

export const KIMI_CAPABILITY_HISTORY_BYTES = 2 * 1024 * 1024

export function createKimiRunCapabilityCache(
  options: {
    maxEntries?: number
    maxAgeMs?: number
    now?: () => number
  } = {}
) {
  const entries = new Map<string, { receipt: KimiRunCapabilityReceipt; recordedAt: number }>()
  const now = options.now ?? Date.now
  const maxEntries =
    Number.isInteger(options.maxEntries) && options.maxEntries! > 0
      ? Math.min(512, options.maxEntries!)
      : 128
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs! >= 0 ? options.maxAgeMs! : 30 * 60_000
  const key = (runId: string, chatId: string | null) => `${chatId ?? ''}\0${runId}`
  const prune = () => {
    for (const [id, entry] of entries) {
      if (now() - entry.recordedAt > maxAgeMs) entries.delete(id)
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
  }
  return {
    put(receipt: KimiRunCapabilityReceipt): void {
      const id = key(receipt.runId, receipt.chatId)
      entries.delete(id)
      if (JSON.stringify(receipt).length > 256 * 1024) return
      entries.set(id, { receipt: structuredClone(receipt), recordedAt: now() })
      prune()
    },
    get(runId: string, chatId: string): KimiRunCapabilityReceipt | null {
      prune()
      const value = entries.get(key(runId, chatId))?.receipt
      return value ? structuredClone(value) : null
    }
  }
}

export const kimiRunCapabilityCache = createKimiRunCapabilityCache()

/** A cache miss never performs a synchronous or whole-file ledger read. Old
 * receipts outside the bounded tail remain unavailable rather than guessed. */
export async function readKimiRunCapabilityReceipt(input: {
  userDataPath: string
  runId: string
  chatId: string
}): Promise<KimiRunCapabilityReceipt | null> {
  const cached = kimiRunCapabilityCache.get(input.runId, input.chatId)
  if (cached) return cached
  if (!/^[\w.-]{1,200}$/.test(input.runId)) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const receipt = await Promise.race([
      readKimiCapabilityTail(input),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000)
        timer.unref?.()
      })
    ])
    const current = kimiRunCapabilityCache.get(input.runId, input.chatId)
    if (current) return current
    if (receipt) kimiRunCapabilityCache.put(receipt)
    return receipt
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readKimiCapabilityTail(input: {
  userDataPath: string
  runId: string
  chatId: string
}): Promise<KimiRunCapabilityReceipt | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    const directory = join(input.userDataPath, 'run-events')
    if ((await fs.lstat(directory)).isSymbolicLink()) return null
    const path = join(directory, `${input.runId}.jsonl`)
    if ((await fs.lstat(path)).isSymbolicLink()) return null
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const size = Math.min(stat.size, KIMI_CAPABILITY_HISTORY_BYTES)
    const bytes = Buffer.alloc(size)
    const { bytesRead } = await handle.read(bytes, 0, size, stat.size - size)
    const records: RunEventRecord[] = []
    for (const line of bytes.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.includes('kimi_capability_receipt')) continue
      try {
        records.push(JSON.parse(line) as RunEventRecord)
      } catch {
        // The tail can begin or end inside a record; that is not evidence.
      }
    }
    return latestKimiRunCapabilityReceipt(records, input.runId, input.chatId)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
