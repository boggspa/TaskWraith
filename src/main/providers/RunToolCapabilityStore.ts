import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId } from '../store/types'
import {
  RUN_TOOL_CAPABILITY_RECEIPT_TYPE,
  type RunToolCapabilityReceipt
} from './RunToolCapabilityReceipt'

export const RUN_TOOL_CAPABILITY_HISTORY_BYTES = 2 * 1024 * 1024
const MAX_RECEIPT_BYTES = 256 * 1024

function isReceipt(value: unknown): value is RunToolCapabilityReceipt {
  if (!value || typeof value !== 'object') return false
  const r = value as RunToolCapabilityReceipt
  return (
    r.type === RUN_TOOL_CAPABILITY_RECEIPT_TYPE &&
    r.schemaVersion === 1 &&
    typeof r.runId === 'string' &&
    typeof r.provider === 'string' &&
    (typeof r.chatId === 'string' || r.chatId === null) &&
    Number.isSafeInteger(r.generation) &&
    r.generation > 0 &&
    Number.isSafeInteger(r.revision) &&
    r.revision >= 0 &&
    typeof r.lifecycleSettled === 'boolean' &&
    !!r.scope &&
    !!r.native &&
    !!r.managed &&
    Array.isArray(r.refusals) &&
    Array.isArray(r.requiredManagedTools) &&
    Array.isArray(r.missingManagedTools)
  )
}

export function createRunToolCapabilityCache(
  options: {
    maxEntries?: number
    maxAgeMs?: number
    now?: () => number
  } = {}
) {
  const entries = new Map<string, { receipt: RunToolCapabilityReceipt; storedAt: number }>()
  const now = options.now ?? Date.now
  const maxEntries =
    Number.isInteger(options.maxEntries) && options.maxEntries! > 0
      ? Math.min(512, options.maxEntries!)
      : 128
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs! >= 0 ? options.maxAgeMs! : 30 * 60_000
  const key = (runId: string, chatId: string | null, provider: ProviderId) =>
    `${provider}\0${chatId ?? ''}\0${runId}`
  const prune = (): void => {
    for (const [id, entry] of entries) if (now() - entry.storedAt > maxAgeMs) entries.delete(id)
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
  }
  return {
    put(receipt: RunToolCapabilityReceipt): boolean {
      if (!isReceipt(receipt) || Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES)
        return false
      prune()
      const id = key(receipt.runId, receipt.chatId, receipt.provider)
      const current = entries.get(id)?.receipt
      if (
        current &&
        (current.generation > receipt.generation ||
          (current.generation === receipt.generation && current.revision > receipt.revision) ||
          (current.lifecycleSettled && !receipt.lifecycleSettled))
      )
        return false
      entries.delete(id)
      entries.set(id, { receipt: structuredClone(receipt), storedAt: now() })
      prune()
      return true
    },
    get(
      runId: string,
      chatId: string | null,
      provider: ProviderId
    ): RunToolCapabilityReceipt | null {
      prune()
      const receipt = entries.get(key(runId, chatId, provider))?.receipt
      return receipt ? structuredClone(receipt) : null
    }
  }
}

export const runToolCapabilityCache = createRunToolCapabilityCache()

export function latestRunToolCapabilityReceipt(
  lines: readonly string[],
  identity: { runId: string; chatId: string; provider: ProviderId }
): RunToolCapabilityReceipt | null {
  let latest: RunToolCapabilityReceipt | null = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (
      !line.includes(RUN_TOOL_CAPABILITY_RECEIPT_TYPE) ||
      Buffer.byteLength(line) > MAX_RECEIPT_BYTES + 16_384
    )
      continue
    try {
      const event = JSON.parse(line)
      const receipt = event.payload?.toolCapabilityReceipt
      if (
        event.source !== 'main' ||
        event.kind !== 'lifecycle' ||
        event.runId !== identity.runId ||
        event.chatId !== identity.chatId ||
        event.provider !== identity.provider ||
        (!receipt &&
          event.payload?.type !== RUN_TOOL_CAPABILITY_RECEIPT_TYPE &&
          !(
            event.payload?.truncated &&
            String(event.payload.preview).includes(RUN_TOOL_CAPABILITY_RECEIPT_TYPE)
          ))
      )
        continue
      // A malformed newest receipt is unknown, not evidence that an older
      // empty/ready receipt still describes this run.
      if (
        !isReceipt(receipt) ||
        receipt.runId !== identity.runId ||
        receipt.chatId !== identity.chatId ||
        receipt.provider !== identity.provider
      )
        return latest
      if (
        !latest ||
        receipt.generation > latest.generation ||
        (receipt.generation === latest.generation && receipt.revision > latest.revision)
      )
        latest = receipt
    } catch {
      /* A bounded tail may start inside a record. */
    }
  }
  return latest
}

/** Bounded, asynchronous and exact-run. A missing old receipt stays unknown. */
export interface ReadRunToolCapabilityInput {
  userDataPath: string
  runId: string
  chatId: string
  provider: ProviderId
}

export async function readRunToolCapabilityReceipt(
  input: ReadRunToolCapabilityInput,
  deps: {
    cache?: ReturnType<typeof createRunToolCapabilityCache>
    readTail?: () => Promise<RunToolCapabilityReceipt | null>
  } = {}
): Promise<RunToolCapabilityReceipt | null> {
  const cache = deps.cache ?? runToolCapabilityCache
  const cached = cache.get(input.runId, input.chatId, input.provider)
  if (cached) return cached
  if (!/^[\w.-]{1,200}$/.test(input.runId)) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const readTail = async (): Promise<RunToolCapabilityReceipt | null> => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const directory = join(input.userDataPath, 'run-events')
      if ((await fs.lstat(directory)).isSymbolicLink()) return null
      const path = join(directory, `${input.runId}.jsonl`)
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) return null
      const size = Math.min(stat.size, RUN_TOOL_CAPABILITY_HISTORY_BYTES)
      const bytes = Buffer.alloc(size)
      const { bytesRead } = await handle.read(bytes, 0, size, stat.size - size)
      return latestRunToolCapabilityReceipt(bytes.toString('utf8', 0, bytesRead).split('\n'), input)
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  try {
    const receipt = await Promise.race([
      deps.readTail ? deps.readTail() : readTail(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000)
        timer.unref?.()
      })
    ])
    // An old disk read cannot replace a newer live observation made during the await.
    if (
      receipt &&
      receipt.runId === input.runId &&
      receipt.chatId === input.chatId &&
      receipt.provider === input.provider
    )
      cache.put(receipt)
    return cache.get(input.runId, input.chatId, input.provider)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
