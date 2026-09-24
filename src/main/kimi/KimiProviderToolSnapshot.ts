import { constants, promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface KimiProviderToolSnapshot {
  sessionId: string
  observedAt: number
  currentRun: boolean
  toolNames: string[]
}

export function parseKimiProviderToolSnapshot(
  text: string,
  sessionId: string,
  runStartedAt: number
): KimiProviderToolSnapshot | null {
  let latest: KimiProviderToolSnapshot | null = null
  for (const line of text.split('\n')) {
    if (!/^\{\s*"type"\s*:\s*"llm\.tools_snapshot"/.test(line)) continue
    try {
      const event = JSON.parse(line) as {
        agentId?: unknown
        time?: unknown
        tools?: Array<{ name?: unknown }>
      }
      if (
        event.agentId !== 'main' ||
        typeof event.time !== 'number' ||
        !Number.isFinite(event.time) ||
        event.time < 0 ||
        event.time > 8.64e15 ||
        !Array.isArray(event.tools) ||
        event.tools.length > 1_000
      )
        continue
      const names = event.tools.map((tool) => tool?.name)
      if (names.some((name) => typeof name !== 'string' || !/^[\w.:-]{1,128}$/.test(name))) continue
      if (!latest || event.time >= latest.observedAt) {
        latest = {
          sessionId,
          observedAt: event.time,
          currentRun: event.time >= runStartedAt,
          toolNames: [...new Set(names as string[])].sort()
        }
      }
    } catch {
      // A partial JSONL record provides no catalogue evidence.
    }
  }
  return latest
}

/** Optional bounded observation: returns tool names only, never prompts,
 * arguments or reasoning. Older provider formats remain explicitly unknown. */
export async function readKimiProviderToolSnapshot(input: {
  seatHome: string
  sessionId: string
  runStartedAt: number
}): Promise<KimiProviderToolSnapshot | null> {
  if (!/^session_[\w-]{1,160}$/.test(input.sessionId)) return null
  try {
    const root = await fs.realpath(input.seatHome)
    const sessions = join(root, 'sessions')
    if ((await fs.lstat(sessions)).isSymbolicLink()) return null
    const directories = await fs.readdir(sessions, { withFileTypes: true })
    if (directories.length > 256) return null
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue
      const path = join(sessions, directory.name, input.sessionId, 'agents', 'main', 'wire.jsonl')
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null
      try {
        const resolved = await fs.realpath(path)
        const local = relative(root, resolved)
        if (!local || local === '..' || local.startsWith(`..${sep}`)) continue
        handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile()) continue
        const size = Math.min(stat.size, 2 * 1024 * 1024)
        const bytes = Buffer.alloc(size)
        const { bytesRead } = await handle.read(bytes, 0, size, stat.size - size)
        const snapshot = parseKimiProviderToolSnapshot(
          bytes.toString('utf8', 0, bytesRead),
          input.sessionId,
          input.runStartedAt
        )
        if (snapshot) return snapshot
      } catch {
        // A raced cleanup or absent provider record is unknown, not denial.
      } finally {
        await handle?.close()
      }
    }
  } catch {
    // Observation cannot make a provider unavailable.
  }
  return null
}
