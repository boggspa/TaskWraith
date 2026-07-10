import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { loadCursorIdeUsageEvents } from './CursorExternalActivity'
import { readCursorExternalActivityDiskCache } from './CursorExternalActivityCache'

describe('loadCursorIdeUsageEvents incremental cache', () => {
  it('reuses cached transcript entries without re-reading unchanged files', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-cursor-cache-'))
    const cachePath = join(homeDir, 'cursor-cache.json')
    const transcriptDir = join(
      homeDir,
      '.cursor',
      'projects',
      'Users-me-sample',
      'agent-transcripts',
      'composer-abc'
    )
    const transcriptPath = join(transcriptDir, 'composer-abc.jsonl')
    const sinceMs = Date.parse('2026-06-01T00:00:00.000Z')
    const transcript = [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'a'.repeat(400) }] }
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'b'.repeat(200) }] }
      })
    ].join('\n')

    let readCount = 0
    try {
      await mkdir(transcriptDir, { recursive: true })
      await writeFile(transcriptPath, transcript, 'utf8')

      const first = await loadCursorIdeUsageEvents({
        homeDir,
        sinceMs,
        cachePath,
        transcriptParseBudget: 10,
        readTextFile: async (path) => {
          readCount += 1
          if (path !== transcriptPath) throw new Error(`unexpected read: ${path}`)
          return transcript
        },
        statFile: async () => ({ mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'), size: transcript.length }),
        listTranscriptFileStats: async () => [
          {
            path: transcriptPath,
            mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'),
            size: transcript.length
          }
        ],
        querySqlite: async () => [],
        now: Date.parse('2026-06-13T12:00:00.000Z')
      })
      expect(first).toHaveLength(1)
      expect(readCount).toBe(1)

      // Production sinceMs is a rolling now-90d recomputed per scan — it
      // DRIFTS FORWARD between calls. The cache must survive that drift
      // (exact-sinceMs keying silently defeated it for months).
      const second = await loadCursorIdeUsageEvents({
        homeDir,
        sinceMs: sinceMs + 5 * 60 * 1000,
        cachePath,
        transcriptParseBudget: 10,
        readTextFile: async () => {
          readCount += 1
          return transcript
        },
        statFile: async () => ({ mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'), size: transcript.length }),
        listTranscriptFileStats: async () => [
          {
            path: transcriptPath,
            mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'),
            size: transcript.length
          }
        ],
        querySqlite: async () => [],
        now: Date.parse('2026-06-13T12:05:00.000Z')
      })
      expect(second).toHaveLength(1)
      expect(readCount).toBe(1)

      const disk = await readCursorExternalActivityDiskCache(cachePath)
      expect(disk?.transcriptEntries[transcriptPath]?.event.totalTokens).toBe(150)

      // A WIDENED window (requested sinceMs earlier than coverage) is the one
      // case that must rebuild from empty and re-parse.
      const widened = await loadCursorIdeUsageEvents({
        homeDir,
        sinceMs: sinceMs - 1000,
        cachePath,
        transcriptParseBudget: 10,
        readTextFile: async () => {
          readCount += 1
          return transcript
        },
        statFile: async () => ({ mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'), size: transcript.length }),
        listTranscriptFileStats: async () => [
          {
            path: transcriptPath,
            mtimeMs: Date.parse('2026-06-13T10:00:00.000Z'),
            size: transcript.length
          }
        ],
        querySqlite: async () => [],
        now: Date.parse('2026-06-13T12:10:00.000Z')
      })
      expect(widened).toHaveLength(1)
      expect(readCount).toBe(2)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
